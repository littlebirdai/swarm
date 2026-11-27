import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { verifyDeviceApiToken } from "@platform/auth/convex";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { insertRequestedBinding } from "../execution-binding.state";
import {
  capabilitiesEqual,
  wireIsolation,
} from "../execution-binding.validators";
import {
  handRoleTriggersToRunner,
  roleTriggerRunnerOf,
} from "../agentTaskRows";
import {
  activeMoveAttempt,
  DEVICE_MOVE_FENCE,
  expireMoveSettlement,
  forcedDeviceMoveEnabled,
  registeredBoot,
  requireForcedDeviceMoveEnabled,
} from "./device-move.state";
import { activateEventRun, clearEventTurn } from "./runEvents";

type DbCtx = Pick<MutationCtx, "db">;
export type RecordedMoveAddress = {
  conversation_id: Id<"conversations">;
  move_id: string;
};
type MoveAddress = RecordedMoveAddress & { bearer: string };
type Head = Doc<"conversation_execution_heads">;
export type MoveBindingCredential = { moveId?: string; moveBearer?: string };

export async function loadRecordedDeviceMove(
  ctx: DbCtx,
  address: RecordedMoveAddress,
) {
  const head = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_conversation", (q) =>
      q.eq("conversation_id", address.conversation_id),
    )
    .unique();
  const move = head?.device_move;
  if (
    !head ||
    !move ||
    !move.move_id ||
    move.move_id !== address.move_id ||
    head.protocol_state !== "fenced" ||
    head.current_epoch !== move.source_epoch
  )
    throw new ConvexError("The move record is missing or has changed");
  const [conversation, source] = await Promise.all([
    ctx.db.get(address.conversation_id),
    moveBinding(ctx, address.conversation_id, move.source_epoch),
  ]);
  if (
    !conversation ||
    !source ||
    conversation.execution_protocol_state !== "fenced" ||
    conversation.user_id !== head.owner_user_id ||
    source.owner_user_id !== head.owner_user_id ||
    source.owner_device_id !== conversation.owner_device_id
  )
    throw new ConvexError("The move source or device credentials changed");
  return { conversation, head, move, source };
}

type RecordedMove = Awaited<ReturnType<typeof loadRecordedDeviceMove>>;

async function moveContext(ctx: DbCtx, address: MoveAddress) {
  const [state, auth] = await Promise.all([
    loadRecordedDeviceMove(ctx, address),
    verifyDeviceApiToken(ctx, address.bearer),
  ]);
  if (!auth)
    throw new ConvexError("The move source or device credentials changed");
  return { ...state, auth };
}

type MoveContext = Awaited<ReturnType<typeof moveContext>>;

function moveBinding(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
  epoch: number,
) {
  return ctx.db
    .query("execution_bindings")
    .withIndex("by_conversation_epoch", (q) =>
      q.eq("conversation_id", conversationId).eq("epoch", epoch),
    )
    .unique();
}

function assertDestination({ move, auth }: MoveContext) {
  if (
    auth.userId !== move.destination_runner_id ||
    auth.deviceId !== move.destination_device_id
  )
    throw new ConvexError(
      "The destination device and runner must authorize the move",
    );
}

export async function assertSourceEnded(
  ctx: DbCtx,
  { move, source }: RecordedMove,
) {
  if (move.forced) {
    requireForcedDeviceMoveEnabled();
    return;
  }
  if (move.source_stopped_at !== undefined) return;
  const registered = await registeredBoot(
    ctx,
    source.owner_user_id,
    source.owner_device_id,
  );
  if (
    !registered ||
    registered.daemon_boot_id !== move.source_replacement_boot_id ||
    registered.daemon_boot_id === source.daemon_boot_id ||
    registered.registered_at < (move.recorded_at ?? Infinity)
  )
    throw new ConvexError(
      "The source runtime has not been stopped or fenced by a new boot",
    );
}

export async function destinationBinding(
  ctx: DbCtx,
  { head, move }: RecordedMove,
) {
  const binding = await moveBinding(ctx, head.conversation_id, move.next_epoch);
  if (
    !binding ||
    head.pending_epoch !== move.next_epoch ||
    binding.move_id !== (move.replacement?.abandoned_move_id ?? move.move_id) ||
    binding.owner_user_id !== move.destination_runner_id ||
    binding.owner_device_id !== move.destination_device_id
  )
    throw new ConvexError("The destination binding does not match the move");
  return binding;
}

export async function authorizeMoveBinding(
  ctx: DbCtx,
  head: Head,
  runner: Id<"users">,
  args: MoveBindingCredential & {
    conversationId: Id<"conversations">;
    epoch: number;
    ownerDeviceId: string;
    daemonBootId: string;
  },
  starting: boolean,
) {
  if (!head.device_move) {
    if (args.moveId) throw new ConvexError("The move is no longer active");
    return null;
  }
  const moveId =
    args.moveId ??
    (head.device_move.driver && head.device_move.next_epoch === args.epoch
      ? head.device_move.move_id
      : undefined);
  if (!moveId || !args.moveBearer)
    throw new ConvexError({
      code: DEVICE_MOVE_FENCE,
      message: "Execution is fenced by a device move",
    });
  const state = await moveContext(ctx, {
    conversation_id: args.conversationId,
    move_id: moveId,
    bearer: args.moveBearer,
  });
  assertDestination(state);
  const binding = await destinationBinding(ctx, state);
  const boot = await registeredBoot(
    ctx,
    binding.owner_user_id,
    binding.owner_device_id,
  );
  if (
    state.move.phase !== "preparing" ||
    args.epoch !== binding.epoch ||
    runner !== binding.owner_user_id ||
    args.ownerDeviceId !== binding.owner_device_id ||
    args.daemonBootId !== binding.daemon_boot_id ||
    args.daemonBootId !== boot?.daemon_boot_id
  )
    throw new ConvexError(
      "The destination cannot act outside its exact move binding and boot",
    );
  if (starting) {
    if (state.move.driver?.step === "failed")
      throw new ConvexError("The device move stopped before activation");
    await assertSourceEnded(ctx, state);
  }
  return { binding, conversation: state.conversation };
}

export async function prepareDeviceMove(
  ctx: DbCtx,
  args: MoveAddress & { daemon_boot_id: string },
  now: number,
) {
  const state = await moveContext(ctx, args);
  assertDestination(state);
  if (state.move.driver?.step === "failed")
    throw new ConvexError(
      "The session owner must choose where the failed move resumes",
    );
  return prepareRecordedDeviceMove(ctx, state, args.daemon_boot_id, now);
}

export async function prepareRecordedDeviceMove(
  ctx: DbCtx,
  state: RecordedMove,
  daemonBootId: string,
  now: number,
) {
  const { conversation, head, move, source } = state;
  const boot = await registeredBoot(
    ctx,
    move.destination_runner_id,
    move.destination_device_id,
  );
  if (boot?.daemon_boot_id !== daemonBootId)
    throw new ConvexError("The destination boot is not registered");
  if (
    source.required_capabilities.includes(STEER_BATON_CAPABILITY) &&
    !boot.owned_codex_new_sessions
  )
    throw new ConvexError(
      "The destination daemon boot did not offer owned Codex sessions",
    );
  if (move.phase === "preparing") {
    const existing = await destinationBinding(ctx, state);
    if (existing.daemon_boot_id !== daemonBootId)
      throw new ConvexError("The destination boot changed after preparation");
    return { epoch: move.next_epoch };
  }
  if (move.phase || head.pending_epoch !== undefined)
    throw new ConvexError("The move is no longer available to prepare");
  const bindingId = await insertRequestedBinding(
    ctx,
    { ...conversation, user_id: move.destination_runner_id },
    move.next_epoch,
    {
      ownerDeviceId: move.destination_device_id,
      daemonBootId: daemonBootId,
      requestedAgent: source.requested_agent,
      transport: source.transport,
      projectPath: source.project_path,
      isolation: wireIsolation(source.isolation),
      configurationRevision: source.configuration_revision + 1,
      model: source.model,
      effort: source.effort,
      protocolVersion: source.protocol_version,
      requiredCapabilities: source.required_capabilities,
    },
    now,
  );
  await ctx.db.patch(bindingId, {
    move_id: move.move_id,
    requires_run_lease: true,
  });
  await ctx.db.patch(head._id, {
    device_move: { ...move, phase: "preparing" },
    pending_epoch: move.next_epoch,
    admission_epoch: move.next_epoch,
    updated_at: now,
  });
  return { epoch: move.next_epoch };
}

export async function confirmMoveSourceStopped(
  ctx: DbCtx,
  args: MoveAddress & {
    fencing_token: string;
    daemon_boot_id: string;
    runtime_id: string;
  },
  now: number,
) {
  const { head, source, move, auth } = await moveContext(ctx, args);
  const lease =
    move.source_lease_id && (await ctx.db.get(move.source_lease_id));
  if (
    auth.userId !== source.owner_user_id ||
    auth.deviceId !== source.owner_device_id ||
    move.phase === "aborting" ||
    source.state !== "ready" ||
    source.daemon_boot_id !== args.daemon_boot_id ||
    source.runtime_id !== args.runtime_id ||
    !lease ||
    lease.binding_id !== source._id ||
    lease.boot !== source.daemon_boot_id ||
    lease.fencing_token !== args.fencing_token
  )
    throw new ConvexError(
      "Stopping proof must name the source device, runtime, boot and recorded lease",
    );
  if (move.source_stopped_at !== undefined) return;
  if (lease.released_at !== undefined || lease.expires_at <= now)
    throw new ConvexError(
      "A released or expired lease cannot prove a source stop",
    );
  await ctx.db.patch(lease._id, { released_at: now });
  await clearEventTurn(ctx, source, now, true);
  await ctx.db.patch(head._id, {
    device_move: {
      ...move,
      source_stopped_at: now,
      ...(forcedDeviceMoveEnabled() && {
        settlement_deadline: Math.min(move.settlement_deadline, now),
      }),
    },
    updated_at: now,
  });
  await expireMoveSettlement(ctx, head._id, source.epoch, now);
}

export async function confirmMoveSourceBoot(
  ctx: DbCtx,
  args: MoveAddress & { daemon_boot_id: string },
  now: number,
) {
  const { head, source, move, auth } = await moveContext(ctx, args);
  const registered = await registeredBoot(
    ctx,
    source.owner_user_id,
    source.owner_device_id,
  );
  if (
    auth.userId !== source.owner_user_id ||
    auth.deviceId !== source.owner_device_id ||
    move.phase === "aborting" ||
    args.daemon_boot_id === source.daemon_boot_id ||
    registered?.daemon_boot_id !== args.daemon_boot_id ||
    registered.registered_at < (move.recorded_at ?? Infinity)
  )
    throw new ConvexError(
      "Source boot proof must name a newly registered boot on the source device",
    );
  const lease =
    move.source_lease_id && (await ctx.db.get(move.source_lease_id));
  if (lease && lease.released_at === undefined)
    await ctx.db.patch(lease._id, { released_at: now });
  await ctx.db.patch(head._id, {
    device_move: {
      ...move,
      source_replacement_boot_id: args.daemon_boot_id,
      ...(forcedDeviceMoveEnabled() && {
        settlement_deadline: Math.min(move.settlement_deadline, now),
      }),
    },
    updated_at: now,
  });
  await expireMoveSettlement(ctx, head._id, source.epoch, now);
}

function epochRows(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
  epoch: number,
  status?: "pending" | "claimed" | "delivery-started" | "ambiguous",
) {
  return ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_epoch_delivery", (q) => {
      const range = q
        .eq("conversation_id", conversationId)
        .eq("execution_epoch", epoch);
      return status === undefined ? range : range.eq("delivery_status", status);
    });
}

export async function retargetDeviceMove(
  ctx: DbCtx,
  args: MoveAddress,
  now: number,
) {
  const state = await moveContext(ctx, args);
  const { move, source } = state;
  if (move.driver?.step === "failed" && move.phase !== "aborting")
    throw new ConvexError(
      "The session owner must choose where the failed move resumes",
    );
  if (move.replacement)
    throw new ConvexError(
      "The move driver is restoring the abandoned destination",
    );
  const aborting = move.phase === "aborting";
  if (aborting) {
    if (
      state.auth.userId !== source.owner_user_id ||
      state.auth.deviceId !== source.owner_device_id
    )
      throw new ConvexError("Only the source device can restore a move");
  } else {
    assertDestination(state);
  }
  return retargetRecordedDeviceMove(ctx, state, now);
}

export async function retargetRecordedDeviceMove(
  ctx: DbCtx,
  state: RecordedMove,
  now: number,
) {
  const { move, head, source } = state;
  const aborting = move.phase === "aborting";
  if (!aborting && move.phase !== "preparing")
    throw new ConvexError("The move is not prepared");
  const binding = await destinationBinding(ctx, state);
  const [from, to] = aborting ? [binding, source] : [source, binding];
  const { page, isDone } = await epochRows(
    ctx,
    head.conversation_id,
    from.epoch,
    aborting ? undefined : "pending",
  ).paginate({ cursor: null, numItems: 100, maximumBytesRead: 512 * 1024 });
  for (const row of page)
    await ctx.db.patch(row._id, {
      execution_epoch: to.epoch,
      owner_user_id: to.owner_user_id,
    });
  if (aborting && isDone) {
    if (!move.replacement) await ctx.db.delete(binding._id);
    await ctx.db.patch(head._id, {
      device_move: move.replacement
        ? {
            ...move,
            destination_device_id: move.replacement.destination_device_id,
            destination_runner_id: move.replacement.destination_runner_id,
            phase: undefined,
            replacement: undefined,
            next_epoch: binding.epoch + 1,
          }
        : undefined,
      pending_epoch: undefined,
      admission_epoch: source.epoch,
      updated_at: now,
    });
  }
  return { moved: page.length, done: isDone };
}

export async function abortDeviceMove(
  ctx: DbCtx,
  args: MoveAddress,
  now: number,
) {
  const state = await moveContext(ctx, args);
  const { head, move, source, auth } = state;
  if (
    auth.userId !== source.owner_user_id ||
    auth.deviceId !== source.owner_device_id
  )
    throw new ConvexError("Only the source device can abort a move");
  if (
    move.forced &&
    (move.driver?.step === "failed" || move.driver?.owner_retried)
  )
    throw new ConvexError(
      "Only the session owner can choose where the failed move resumes",
    );
  if (move.phase === "aborting") return { done: false };
  if (move.source_stopped_at !== undefined || source.state !== "ready")
    throw new ConvexError("A stopped source cannot resume this binding");
  if (move.phase === "preparing") {
    const binding = await destinationBinding(ctx, state);
    if (
      binding.state !== "requested" &&
      binding.state !== "start-failed-before-effect" &&
      binding.state !== "stopped" &&
      binding.state !== "quarantined"
    )
      throw new ConvexError(
        "The destination runtime must be disposed before abort",
      );
  }
  const lease =
    move.source_lease_id && (await ctx.db.get(move.source_lease_id));
  if (lease && lease.released_at === undefined)
    await ctx.db.patch(lease._id, { released_at: now });
  await ctx.db.patch(source._id, { requires_run_lease: true });
  await clearEventTurn(ctx, source, now, true);
  await expireMoveSettlement(ctx, head._id, source.epoch, now);
  const done = move.phase === undefined;
  await ctx.db.patch(head._id, {
    device_move: done ? undefined : { ...move, phase: "aborting" },
    admission_epoch: done ? source.epoch : head.admission_epoch,
    updated_at: now,
  });
  return { done };
}

export async function activateDeviceMove(
  ctx: DbCtx,
  args: MoveAddress & {
    daemon_boot_id: string;
    runtime_id: string;
    operation_id: string;
  },
  now: number,
) {
  const state = await moveContext(ctx, args);
  assertDestination(state);
  if (state.move.driver?.step === "failed")
    throw new ConvexError(
      "The session owner must choose where the failed move resumes",
    );
  return activateRecordedDeviceMove(ctx, state, args, now);
}

export async function activateRecordedDeviceMove(
  ctx: DbCtx,
  state: RecordedMove,
  args: { daemon_boot_id: string; runtime_id: string; operation_id: string },
  now: number,
) {
  const { head, move, conversation, source } = state;
  if (move.phase !== "preparing")
    throw new ConvexError("The move cannot activate in this phase");
  const binding = await destinationBinding(ctx, state);
  const boot = await registeredBoot(
    ctx,
    binding.owner_user_id,
    binding.owner_device_id,
  );
  if (
    binding.state !== "ready" ||
    binding.daemon_boot_id !== args.daemon_boot_id ||
    boot?.daemon_boot_id !== args.daemon_boot_id ||
    binding.runtime_id !== args.runtime_id ||
    binding.operation_id !== args.operation_id ||
    !binding.handle ||
    binding.requested_agent !== binding.actual_agent ||
    binding.applied_configuration_revision !== binding.configuration_revision ||
    !capabilitiesEqual(
      binding.required_capabilities,
      binding.capabilities ?? [],
    )
  )
    throw new ConvexError("The exact destination binding must be ready");
  await assertSourceEnded(ctx, state);
  const attempt = move.attempt_id && (await ctx.db.get(move.attempt_id));
  if (move.forced && head.active_delivery_state === "ambiguous") {
    if (
      !binding.runtime_id ||
      head.active_delivery_attempt_id !== move.attempt_id
    )
      throw new ConvexError("The uncertain delivery does not match the move");
    const { attempt, message } = await activeMoveAttempt(ctx, head, move);
    await ctx.db.patch(attempt._id, {
      forced_move_source_epoch:
        attempt.forced_move_source_epoch ?? source.epoch,
      execution_epoch: binding.epoch,
      configuration_revision: binding.configuration_revision,
      owner_user_id: binding.owner_user_id,
      owner_device_id: binding.owner_device_id,
      daemon_boot_id: binding.daemon_boot_id,
      runtime_id: binding.runtime_id,
    });
    await ctx.db.patch(message._id, {
      execution_epoch: binding.epoch,
      owner_user_id: binding.owner_user_id,
    });
  } else if (
    head.active_delivery_attempt_id ||
    head.active_delivery_state ||
    (move.attempt_id &&
      (!attempt ||
        attempt.conversation_id !== conversation._id ||
        attempt.execution_epoch !== source.epoch ||
        attempt.completed_at === undefined ||
        attempt.state === "claimed" ||
        attempt.state === "delivery-started" ||
        attempt.state === "ambiguous"))
  )
    throw new ConvexError("The source delivery attempt is not terminal");
  for (const status of [
    "pending",
    "claimed",
    "delivery-started",
    "ambiguous",
  ] as const) {
    if (await epochRows(ctx, conversation._id, source.epoch, status).first())
      throw new ConvexError("The source queue still needs retargeting");
  }
  const lease =
    move.source_lease_id && (await ctx.db.get(move.source_lease_id));
  if (lease && lease.released_at === undefined)
    await ctx.db.patch(lease._id, { released_at: now });
  await clearEventTurn(ctx, source, now, true);
  await ctx.db.patch(source._id, {
    ...(move.forced
      ? {
          state: "quarantined" as const,
          stopped_reason: "session owner forced the device move",
          forced_device_move: {
            ...move.forced,
            move_id: move.move_id!,
            destination_epoch: binding.epoch,
          },
        }
      : move.source_stopped_at === undefined
        ? {
            state: "quarantined" as const,
            stopped_reason: "source daemon boot replaced",
          }
        : {
            state: "stopped" as const,
            stopped_reason: "source stop confirmed",
          }),
    updated_at: now,
  });
  const [cursor, turn] = await Promise.all([
    ctx.db
      .query("run_event_cursors")
      .withIndex("by_conversation_run", (q) =>
        q.eq("conversation_id", conversation._id).eq("run", binding.epoch),
      )
      .first(),
    ctx.db
      .query("run_turn_projections")
      .withIndex("by_conversation_run", (q) =>
        q.eq("conversation_id", conversation._id).eq("run", binding.epoch),
      )
      .first(),
  ]);
  if (cursor || turn)
    throw new ConvexError("The destination event run already exists");
  await activateEventRun(ctx, binding, now);
  await ctx.db.patch(conversation._id, {
    user_id: binding.owner_user_id,
    author_user_id: conversation.author_user_id ?? conversation.user_id,
    owner_device_id: binding.owner_device_id,
  });
  if (move.driver) {
    const { page, isDone } = await ctx.db
      .query("agent_tasks")
      .withIndex("by_originating_conversation", (q) =>
        q.eq("originating_conversation_id", conversation._id),
      )
      .paginate({ cursor: null, numItems: 100, maximumBytesRead: 512 * 1024 });
    if (!isDone)
      throw new ConvexError(
        "The session has too many triggers for atomic activation",
      );
    for (const task of page) {
      const runner = await roleTriggerRunnerOf(ctx, task);
      if (runner) await ctx.db.patch(task._id, { user_id: runner });
    }
  } else await handRoleTriggersToRunner(ctx, conversation._id);
  await ctx.db.patch(head._id, {
    owner_user_id: binding.owner_user_id,
    current_epoch: binding.epoch,
    admission_epoch: binding.epoch,
    pending_epoch: undefined,
    device_move: undefined,
    ...(move.driver && {
      last_device_move: {
        move_id: move.move_id!,
        source_runner_id: source.owner_user_id,
        forced: move.forced !== undefined,
        destination_device_id: binding.owner_device_id,
        destination_runner_id: binding.owner_user_id,
        epoch: binding.epoch,
        prepared_at: move.driver.prepared_at,
        retargeted_at: move.driver.retargeted_at,
        moved: move.driver.moved,
        activated_at: now,
      },
    }),
    updated_at: now,
  });
  return { epoch: binding.epoch };
}
