export type ReadingAnchorClaim = { session: string; order: number };

const active = new Set<number>();
let session: string | undefined;
let lastOrder = 0;

export function startReadingAnchorClaim() {
  const order = ++lastOrder;
  const claim = { session: (session ??= crypto.randomUUID()), order };
  active.add(order);
  return { claim, end: () => active.delete(order) };
}

export function isReadingAnchorClaimActive(
  claim: ReadingAnchorClaim | undefined,
) {
  return !!claim && claim.session === session && active.has(claim.order);
}
