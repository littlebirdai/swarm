export type ReadingAnchorClaim = { id: string; order: number };

const active = new Set<string>();
let lastOrder = 0;

export function startReadingAnchorClaim() {
  const order = Math.max(
    performance.timeOrigin + performance.now(),
    lastOrder + 0.001,
  );
  const id = crypto.randomUUID();
  lastOrder = order;
  active.add(id);
  return { claim: { id, order }, end: () => active.delete(id) };
}

export function isReadingAnchorClaimActive(
  claim: ReadingAnchorClaim | undefined,
) {
  return !!claim && active.has(claim.id);
}
