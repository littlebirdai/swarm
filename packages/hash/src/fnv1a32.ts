export const FNV1A32_OFFSET = 0x811c9dc5;

export function fnv1a32Update(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function fnv1a32(s: string): number {
  return fnv1a32Update(FNV1A32_OFFSET, s);
}
