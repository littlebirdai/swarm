import { verifyDeviceApiToken } from "@platform/auth/convex";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  executionBinding,
  executionHead,
  insertRequestedBinding,
} from "../execution-binding.state";
import {
  capabilitiesEqual,
  wireIsolation,
} from "../execution-binding.validators";
import { handRoleTriggersToRunner } from "../agentTaskRows";
import { DEVICE_MOVE_FENCE, expireMoveSettlement } from "./device-move.state";
import { activateEventRun, clearEventTurn } from "./runEvents";

type DbCtx = Pick<MutationCtx, "db">;
type MoveAddress = {
  conversation_id: Id<"conversations">;
  move_id: string;
  bearer: string;
};
type Head = Doc<"conversation_execution_heads">;
type Binding = Doc<"execution_bindings">;
export type MoveBindingCredential = { moveId?: string; moveBearer?: string };

async function moveContext(ctx: DbCtx, address: MoveAddress) {
  const head: Head | null = await executionHead(ctx, address.conversation_id);
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
  const [conversation, source, auth] = await Promise.all([
    ctx.db.get(address.conversation_id),
    executionBinding(
      ctx,
      address.conversation_id,
      move.source_epoch,
    ) as Promise<Binding | null>,
    verifyDeviceApiToken(ctx, address.bearer),
  ]);
  if (
    !conversation ||
    !source ||
    !auth ||
    conversation.execution_protocol_state !== "fenced" ||
    conversation.user_id !== head.owner_user_id ||
    source.owner_user_id !== head.owner_user_id ||
    source.owner_device_id !== conversation.owner_device_id
  )
    throw new ConvexError("The move source or device credentials changed");
  return { conversation, head, move, source, auth };
}

type MoveContext = Awaited<ReturnType<typeof moveContext>>;

function assertDestination({ move, auth }: MoveContext) {
  if (
    auth.userId !== move.destination_runner_id ||
    auth.deviceId !== move.destination_device_id
  )
    throw new ConvexError(
      "The destination device and runner must authorize the move",
    );
}

async function registeredBoot(ctx: DbCtx, runner: Id<"users">, device: string) {
  return await ctx.db
    .query("execution_daemon_boots")
    .withIndex("by_user_device", (q) =>
      q.eq("user_id", runner).eq("owner_device_id", device),
    )
    .unique();
}

async function assertSourceEnded(ctx: DbCtx, { move, source }: MoveContext) {
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

async function destinationBinding(ctx: DbCtx, { head, move }: MoveContext) {
  const binding: Binding | null = await executionBinding(
    ctx,
    head.conversation_id,
    move.next_epoch,
  );
  if (
    !binding ||
    head.pending_epoch !== move.next_epoch ||
    binding.move_id !== move.move_id ||
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
  if (!args.moveId || !args.moveBearer)
    throw new ConvexError({
      code: DEVICE_MOVE_FENCE,
      message: "Execution is fenced by a device move",
    });
  const state = await moveContext(ctx, {
    conversation_id: args.conversationId,
    move_id: args.moveId,
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
  if (starting) await assertSourceEnded(ctx, state);
  return { binding, conversation: state.conversation };
}

export async function prepareDeviceMove(
  ctx: DbCtx,
  args: MoveAddress & { daemon_boot_id: string },
  now: number,
) {
  const state = await moveContext(ctx, args);
  assertDestination(state);
  const { conversation, head, move, source } = state;
  const boot = await registeredBoot(
    ctx,
    move.destination_runner_id,
    move.destination_device_id,
  );
  if (boot?.daemon_boot_id !== args.daemon_boot_id)
    throw new ConvexError("The destination boot is not registered");
  if (move.phase === "preparing") {
    const existing = await destinationBinding(ctx, state);
    if (existing.daemon_boot_id !== args.daemon_boot_id)
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
      daemonBootId: args.daemon_boot_id,
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
    device_move: { ...move, source_stopped_at: now },
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
    device_move: { ...move, source_replacement_boot_id: args.daemon_boot_id },
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
  const { move, head, source } = state;
  const aborting = move.phase === "aborting";
  if (aborting) {
    if (
      state.auth.userId !== source.owner_user_id ||
      state.auth.deviceId !== source.owner_device_id
    )
      throw new ConvexError("Only the source device can restore a move");
  } else {
    assertDestination(state);
    if (move.phase !== "preparing")
      throw new ConvexError("The move is not prepared");
  }
  const binding = await destinationBinding(ctx, state);
  const [from, to] = aborting ? [binding, source] : [source, binding];
  const { page, isDone } = await epochRows(
    ctx,
    args.conversation_id,
    from.epoch,
    aborting ? undefined : "pending",
  ).paginate({ cursor: null, numItems: 100, maximumBytesRead: 512 * 1024 });
  for (const row of page)
    await ctx.db.patch(row._id, {
      execution_epoch: to.epoch,
      owner_user_id: to.owner_user_id,
    });
  if (aborting && isDone) {
    await ctx.db.delete(binding._id);
    await ctx.db.patch(head._id, {
      device_move: undefined,
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
  const { head, move, conversation, source } = state;
  assertDestination(state);
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
  if (
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
    state: move.source_stopped_at === undefined ? "quarantined" : "stopped",
    stopped_reason:
      move.source_stopped_at === undefined
        ? "source daemon boot replaced"
        : "source stop confirmed",
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
  await handRoleTriggersToRunner(ctx, conversation._id);
  await ctx.db.patch(head._id, {
    owner_user_id: binding.owner_user_id,
    current_epoch: binding.epoch,
    admission_epoch: binding.epoch,
    pending_epoch: undefined,
    device_move: undefined,
    updated_at: now,
  });
  return { epoch: binding.epoch };
}
