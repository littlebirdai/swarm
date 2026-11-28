import { type QueryCtx } from "../functions";
import { type Doc } from "../_generated/dataModel";
import {
  contentMatchesAnyTerm,
  parseSearchTerms,
  partialCoverage,
  searchFieldsOf,
  type ParsedTerms,
} from "../searchCore";
import { addEvidence, emptyEvidence } from "@codecast/search/terms";
import {
  messageSearchTier,
  type SearchCandidate,
  type SearchPoolMessage,
} from "./sessionSearchPool";
import {
  type ReadScope,
  searchableAs,
  titleFieldRows,
} from "./sessionSearchScope";

const WORD_HOLDER_CHECKS = 25;
const TITLE_LOOKUPS = 3;
const SATURATED_GAP_LOOKUPS = 30;
const GAP_PROBE_TAKE = 5;

async function findWordsNoVisibleSessionHolds(
  ctx: QueryCtx,
  words: string[],
  terms: ParsedTerms,
  messageGroups: Map<string, SearchPoolMessage[]>,
  scope: ReadScope,
  isEligibleConv: (conv: any) => boolean,
  inSelfFamily: ((conv: Doc<"conversations">) => Promise<boolean>) | null,
): Promise<string[]> {
  const index = new Map(terms.words.map((w, i) => [w, i]));
  const holders = new Map<string, string[]>(words.map((w) => [w, []]));
  for (const [convId, messages] of messageGroups) {
    const evidence = emptyEvidence(terms);
    for (const m of messages) addEvidence(evidence, m.content, terms);
    for (const w of words)
      if (evidence.best[index.get(w)!] > 0) holders.get(w)!.push(convId);
  }
  const visible = new Map<string, boolean>();
  const isVisibleHolder = async (convId: string, needsContent: boolean) => {
    const key = `${convId}:${needsContent}`;
    if (!visible.has(key)) {
      const id = ctx.db.normalizeId("conversations", convId);
      const conv = id ? await ctx.db.get(id) : null;
      visible.set(
        key,
        !!conv &&
          isEligibleConv(conv) &&
          (!needsContent || scope.contentVisible(conv)) &&
          !(inSelfFamily && (await inSelfFamily(conv))),
      );
    }
    return visible.get(key)!;
  };
  const missing: string[] = [];
  let titleLookups = 0;
  for (const w of words) {
    const ids = holders.get(w)!;
    if (ids.length > WORD_HOLDER_CHECKS) continue;
    let held = false;
    for (const id of ids) if ((held = await isVisibleHolder(id, true))) break;
    if (held) continue;
    if (titleLookups++ >= TITLE_LOOKUPS) continue;
    const wordTerms = parseSearchTerms(w);
    const { rows, saturated } = await titleFieldRows(ctx, wordTerms.lookup);
    for (const conv of rows) {
      const fields = emptyEvidence(wordTerms);
      for (const field of searchFieldsOf(searchableAs(scope, conv)))
        addEvidence(fields, field, wordTerms);
      if (
        fields.best[0] > 0 &&
        (held = await isVisibleHolder(conv._id.toString(), false))
      )
        break;
    }
    if (!held && !saturated) missing.push(w);
  }
  return missing;
}

export async function resolveCliSearchPartial(args: {
  ctx: QueryCtx;
  terms: ParsedTerms;
  eligible: SearchCandidate[];
  page: SearchCandidate[];
  windowTitleMissing: Map<string, string[]>;
  messageGroups: Map<string, SearchPoolMessage[]>;
  scope: ReadScope;
  poolSaturated: boolean;
  hasOperatorHits: boolean;
  userOnly: boolean;
  isEligibleConv: (conv: any) => boolean;
  inSelfFamily: ((conv: Doc<"conversations">) => Promise<boolean>) | null;
}) {
  const {
    ctx,
    terms,
    eligible,
    page,
    windowTitleMissing,
    messageGroups,
    scope,
    poolSaturated,
    hasOperatorHits,
    userOnly,
    isEligibleConv,
    inSelfFamily,
  } = args;
  const missingById = new Map<string, string[]>([
    ...eligible.map(
      (c) => [c.conv._id.toString(), c.missing] as [string, string[]],
    ),
    ...windowTitleMissing,
  ]);
  let gapRows = [...missingById.values()];
  const gapsUnproven = poolSaturated || hasOperatorHits;
  if (
    gapsUnproven &&
    partialCoverage(
      gapRows.map((missing) => ({ missing })),
      terms,
    )
  ) {
    gapRows = [...windowTitleMissing.values()];
    const tier = await messageSearchTier(ctx);
    let lookups = 0;
    let unknown = false;
    for (const candidate of page) {
      const id = candidate.conv._id.toString();
      const gaps = missingById.get(id) ?? [];
      if (!scope.contentVisible(candidate.conv)) {
        gapRows.push(gaps);
        continue;
      }
      if (candidate.workers && gaps.length) {
        unknown = true;
        break;
      }
      const remaining: string[] = [];
      for (const w of gaps) {
        if (lookups++ >= SATURATED_GAP_LOOKUPS) {
          unknown = true;
          break;
        }
        const wordTerms = parseSearchTerms(w);
        const found = await tier.search(
          wordTerms.lookup,
          { conversation_id: candidate.conv._id },
          GAP_PROBE_TAKE,
        );
        const counted = userOnly
          ? found.filter((m) => m.role === "user")
          : found;
        if (
          counted.some((m) => contentMatchesAnyTerm(m.content || "", wordTerms))
        )
          continue;
        if (found.length >= GAP_PROBE_TAKE) {
          unknown = true;
          break;
        }
        remaining.push(w);
      }
      if (unknown) break;
      missingById.set(id, remaining);
      gapRows.push(remaining);
    }
    if (unknown) gapRows = [[]];
  }
  const partial = partialCoverage(
    gapRows.map((missing) => ({ missing })),
    terms,
  );
  if (partial && partial.missing_everywhere.length > 0) {
    partial.missing_everywhere = gapsUnproven
      ? []
      : await findWordsNoVisibleSessionHolds(
          ctx,
          partial.missing_everywhere,
          terms,
          messageGroups,
          scope,
          isEligibleConv,
          inSelfFamily,
        );
  }
  return { partial, missingById };
}
