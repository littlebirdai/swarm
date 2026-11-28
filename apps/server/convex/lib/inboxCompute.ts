import {
  canProbeCliWatchTranscript,
  orderCliWatchCandidates,
  readCliAskingSessions,
} from "./cli-inbox-reads.rules";
import { isHotRow, splitRows } from "@codecast/inbox/inboxSplit";
import {
  inboxEpoch,
  rideLeadPlacements,
  type InboxBucket,
  type InboxTruncation,
} from "@codecast/inbox/inboxProjection";
import { isClosedSession } from "@codecast/inbox/closedSession";
import { Doc, Id } from "../_generated/dataModel";
import { shouldShowInInbox } from "../inboxFilters";
import {
  buildSubagentChildRow,
  enrichInboxSessionRow,
  sortInboxRows,
} from "./inboxEnrich";
import {
  buildAskingParents,
  groupPoolChildren,
  hasLiveNestedChild,
  loadPendingDecisionConvIds,
  ownAsk,
  placeConversationRow,
} from "./inboxLivenessPlacement";
import {
  type InboxEnrichSkip,
  USER_DAEMON_ALIVE_MS,
  belowFoldFor,
  makeMemoGet,
  stampInboxViewerFields,
  stripInboxLiveness,
  truncatedList,
} from "./inboxMaps";
import { scanInboxConversations } from "./inboxScan";

export async function computeInboxSessions(
  ctx: any,
  userId: Id<"users">,
  opts: {
    show_all?: boolean;
    watchedWindow?: boolean;
    includeLiveness?: boolean;
    fastFieldsInOverlay?: boolean;
    // Explicitly-requested conversations (a label's filed set) hydrated into the
    // candidate pool regardless of the recency window — labels exist to park old
    // sessions. Deliberately filed, so also exempt from cluster-hiding.
    extraConvIds?: string[];
    // Inbox "team mode": also fold in every teammate's team-visible session from
    // this team (superset of the personal inbox). See scanInboxConversations.
    teamScope?: Id<"teams">;
    // Stamp every top-level row with the inbox projection (bucket, work_state,
    // asking, below_fold) through the shared placement function. Only the CLI
    // inbox opts in: the web base list must never carry a bucket (the overlay
    // owns it — sync-convergence C1). Requires includeLiveness.
    projection?: boolean;
    // Only the named extraConvIds, read per conversation (scan's namedOnly).
    namedOnly?: boolean;
    // With namedOnly: list a named row even when it is killed. A flow run reads the session its change came from
    // this way (flows.md FL4): a killed subject still owns the change, and the run needs its row to revive it.
    includeKilled?: boolean;
    // Debug-only (timing harness) — see InboxEnrichSkip.
    _skip?: InboxEnrichSkip;
    // The split wire form's hot set (packages/inbox/src/inboxSplit.ts), read off
    // each row before its stamps are stripped. Only splitInboxList asks.
    splitHot?: boolean;
  },
): Promise<{
  sessions: any[];
  hidden_count: number;
  truncated: InboxTruncation[];
  hot_ids?: Set<string>;
  watchSources?: ReadonlyMap<string, Doc<"conversations">>;
}> {
  // The CLI uses liveness to classify work-state. The web base subscription
  // opts out and gets those facts through the sessionsLiveness overlay.
  const includeLiveness = opts.includeLiveness !== false;
  const enrichSkip = opts.watchedWindow
    ? { ...opts._skip, refs: true }
    : includeLiveness
      ? opts._skip
      : { ...opts._skip, auq: true };
  const now = inboxEpoch(Date.now());
  const fastFieldsInOverlay =
    !includeLiveness && opts.fastFieldsInOverlay === true;
  const scan = await scanInboxConversations(ctx, userId, now, {
    includeLiveness,
    extraConvIds: opts.extraConvIds,
    teamScope: opts.teamScope,
    subagentWindow: fastFieldsInOverlay || !!opts.watchedWindow,
    heartbeatSince: opts.projection ? now - USER_DAEMON_ALIVE_MS : undefined,
    namedOnly: opts.namedOnly,
    watchedWindow: opts.watchedWindow ? { showAll: opts.show_all } : undefined,
  });
  const { conversations, maps, truncated, pinnedOverflowIds } = scan;
  const overlayOwnedChildIds = new Set<string>(
    scan.recentSubagents.map((c: any) => c._id.toString()),
  );

  let hiddenCount = 0;
  const results: any[] = [];
  const childRowIds = new Set<string>();
  const implHandoffByParent = new Map<string, any>();
  for (const c of conversations) {
    if (
      c.parent_conversation_id &&
      c.parent_message_uuid === "plan-handoff" &&
      !c.is_subagent
    ) {
      const pid = c.parent_conversation_id.toString();
      const prev = implHandoffByParent.get(pid);
      if (!prev || (c.started_at ?? 0) > (prev.started_at ?? 0))
        implHandoffByParent.set(pid, c);
    }
  }
  const getDoc = makeMemoGet(ctx);
  const includeKilled = !!opts.includeKilled && !!opts.namedOnly;
  const shownConvs = conversations.filter(
    (conv) =>
      shouldShowInInbox(conv) ||
      (includeKilled &&
        shouldShowInInbox({ ...conv, inbox_killed_at: undefined })),
  );
  const watchedIds =
    scan.watched && new Set(scan.watched.map((row) => String(row._id)));
  const watchProbeOrder =
    scan.watched &&
    orderCliWatchCandidates(
      scan.watched.filter((row) => canProbeCliWatchTranscript(row, now)),
      (row) =>
        Number(
          !!row.has_pending_messages ||
            maps.agentStatusMap.get(row._id) === "permission_blocked",
        ),
    );
  const watchProbeIds =
    watchProbeOrder &&
    new Set(watchProbeOrder.slice(0, 192).map((row) => row._id));
  const enrichedRows = await Promise.all(
    shownConvs.map(async (conv) => {
      const rowSkip = watchProbeIds
        ? {
            ...enrichSkip,
            transcript: !watchProbeIds.has(conv._id),
            children: !scan.scopedChildren?.has(conv._id),
          }
        : !opts.show_all && pinnedOverflowIds.has(conv._id.toString())
          ? { ...enrichSkip, children: true }
          : enrichSkip;
      const { row, subagentChildren, dismissed, stashed, hidden } =
        await enrichInboxSessionRow(
          ctx,
          conv,
          maps,
          now,
          belowFoldFor(scan, conv),
          rowSkip,
          getDoc,
          scan.scopedChildren?.get(conv._id.toString()),
        );
      if ((dismissed || stashed) && !row.implementation_session) {
        const impl = implHandoffByParent.get(conv._id.toString());
        if (impl)
          row.implementation_session = {
            _id: impl._id.toString(),
            title: impl.title,
          };
      }
      if (opts.watchedWindow)
        row.owned_by_me = scan.ownedByMeIds.has(String(conv._id));
      else
        await stampInboxViewerFields(
          row,
          conv,
          userId,
          await scan.ownerRowFor(conv),
          getDoc,
        );
      return { conv, row, subagentChildren, dismissed, stashed, hidden };
    }),
  );
  let stampChildRow: ((child: any, row: any) => void) | null = null;
  if (opts.projection && includeLiveness) {
    const childrenByParent = groupPoolChildren([
      ...conversations,
      ...scan.poolChildren,
    ]);
    for (const r of enrichedRows) {
      if (r.subagentChildren.length === 0) continue;
      const pid = r.conv._id.toString();
      const seen = new Set(
        (childrenByParent.get(pid) ?? []).map((c: any) => c._id.toString()),
      );
      const merged = [...(childrenByParent.get(pid) ?? [])];
      for (const c of r.subagentChildren)
        if (!seen.has(c._id.toString())) merged.push(c);
      childrenByParent.set(pid, merged);
    }
    if (watchedIds)
      for (const id of childrenByParent.keys())
        if (!watchedIds.has(id)) childrenByParent.delete(id);
    const pendingDecisionIds =
      scan.watched || opts.namedOnly
        ? await readCliAskingSessions(ctx.db, userId, [
            ...(scan.watched ?? conversations),
            ...[...childrenByParent.values()]
              .flat()
              .filter(
                (child) => !child.inbox_killed_at && !isClosedSession(child),
              ),
          ])
        : await loadPendingDecisionConvIds(ctx, userId);
    const { asking: askingParents } = await buildAskingParents(
      ctx,
      watchProbeOrder
        ? new Map(
            watchProbeOrder.map(({ _id }) => [
              _id,
              childrenByParent.get(_id) ?? [],
            ]),
          )
        : childrenByParent,
      maps,
      now,
      pendingDecisionIds,
      undefined,
      opts.watchedWindow ? 128 : undefined,
    );
    for (const r of enrichedRows) {
      const cid = r.conv._id.toString();
      const asking =
        ownAsk(r.row, r.conv) ||
        pendingDecisionIds.has(cid) ||
        askingParents.has(cid);
      const placement = placeConversationRow(
        r.conv,
        r.row,
        asking,
        r.row.last_user_message,
        now,
      );
      r.row.bucket = placement.bucket;
      r.row.work_state = placement.work_state;
      r.row.asking = asking;
      r.row.below_fold = r.hidden;
    }
    const byId = new Map(enrichedRows.map((r) => [r.conv._id.toString(), r]));
    const childLive = new Set(
      [...childrenByParent]
        .filter(([, children]) => hasLiveNestedChild(children, maps, now))
        .map(([pid]) => pid),
    );
    const rideRowOf = (id: string) =>
      childLive.has(id)
        ? { ...byId.get(id)?.conv, child_live: true }
        : byId.get(id)?.conv;
    rideLeadPlacements(
      new Map(
        enrichedRows.map((r) => [
          r.conv._id.toString(),
          r.row as { bucket: InboxBucket },
        ]),
      ),
      rideRowOf,
    );
    stampChildRow = (child, row) => {
      const cid = child._id.toString();
      const asking =
        ownAsk(row, child) ||
        pendingDecisionIds.has(cid) ||
        askingParents.has(cid);
      const placement = placeConversationRow(
        child,
        row,
        asking,
        row.last_user_message,
        now,
      );
      row.bucket = placement.bucket;
      row.work_state = placement.work_state;
      row.asking = asking;
      // A child is emitted only under a shown parent, so it is never below the
      // fold on its own account.
      row.below_fold = false;
    };
  }
  // An adopted child is a top-level row of its own (shared isAdoptedChild),
  // never emitted a second time as a child row.
  const topLevelIds = new Set(enrichedRows.map((r) => r.conv._id.toString()));
  for (const r of enrichedRows) {
    if (r.hidden) {
      hiddenCount++;
      if (!opts.show_all) continue;
    }
    results.push(r.row);
    // Don't surface subagents under a dismissed/stashed parent — they used to be
    // invisible (parent was excluded from the idle query entirely) and
    // exposing them now would make active buckets pick them up as orphans.
    if (opts.watchedWindow || r.dismissed || r.stashed) continue;
    for (const child of r.subagentChildren) {
      if (topLevelIds.has(child._id.toString())) continue;
      const childRow = await buildSubagentChildRow(
        child,
        maps,
        now,
        r.conv._id,
        (id) => ctx.db.get(id),
      );
      await stampInboxViewerFields(
        childRow,
        child,
        userId,
        await scan.ownerRowFor(child),
        getDoc,
      );
      stampChildRow?.(child, childRow);
      childRowIds.add(childRow._id.toString());
      results.push(childRow);
    }
  }
  // A worker the caller named whose parent is not a row here (the line's
  // runner names each station's hand alone) has no parent to be listed under,
  // so it is emitted on its own, through the same child row and stamp.
  const namedIds = new Set(opts.extraConvIds ?? []);
  for (const child of conversations) {
    const id = child._id.toString();
    if (
      !namedIds.has(id) ||
      childRowIds.has(id) ||
      topLevelIds.has(id) ||
      !child.parent_conversation_id
    )
      continue;
    if (!(child.is_subagent || !child.parent_message_uuid)) continue;
    const childRow = await buildSubagentChildRow(
      child,
      maps,
      now,
      child.parent_conversation_id,
      (docId) => ctx.db.get(docId),
    );
    await stampInboxViewerFields(
      childRow,
      child,
      userId,
      await scan.ownerRowFor(child),
      getDoc,
    );
    stampChildRow?.(child, childRow);
    childRowIds.add(id);
    results.push(childRow);
  }

  sortInboxRows(results);
  // A live row's stamps (updated_at, last_heartbeat) ride the overlay, so the
  // stripped row looks cold to the split however busy the session is, and every
  // change to it (status, pending, a summary) forced every client to refetch the
  // whole list. Hotness is judged here, on the row as it was.
  const hotIds = opts.splitHot ? new Set<string>() : undefined;
  if (!includeLiveness) {
    for (const row of results) {
      const id = row._id.toString();
      if (hotIds && isHotRow(row, now)) hotIds.add(id);
      stripInboxLiveness(
        row,
        fastFieldsInOverlay &&
          (!childRowIds.has(id) || overlayOwnedChildIds.has(id)),
      );
    }
  }
  return {
    sessions: results,
    hidden_count: hiddenCount,
    truncated: truncatedList(truncated),
    ...(hotIds ? { hot_ids: hotIds } : {}),
    ...(opts.watchedWindow
      ? {
          watchSources: new Map(
            shownConvs.map((conv) => [String(conv._id), conv]),
          ),
        }
      : {}),
  };
}

// The split forms. `now` is the projection epoch, as every inbox clock is, so
// two executions inside one minute stay byte identical (sync-convergence C2).
export function splitInboxList(result: {
  sessions: any[];
  hidden_count: number;
  truncated: InboxTruncation[];
  hot_ids?: Set<string>;
}) {
  const { ids, hot, cold_hash } = splitRows(
    result.sessions.map((r) => [r._id.toString(), r]),
    inboxEpoch(Date.now()),
    undefined,
    result.hot_ids,
  );
  return {
    split: true as const,
    ids,
    hot: hot.map(([, r]) => r),
    cold_hash,
    hidden_count: result.hidden_count,
    truncated: result.truncated,
  };
}

export function splitInboxLiveness(result: {
  liveness: Record<string, any>;
  projection?: any;
}) {
  const { ids, hot, cold_hash } = splitRows(
    Object.entries(result.liveness),
    inboxEpoch(Date.now()),
  );
  return {
    split: true as const,
    ids,
    hot: Object.fromEntries(hot),
    cold_hash,
    projection: result.projection,
  };
}
