export function socketQueryReport(byQuery, readSets, limit) {
  return [...byQuery]
    .sort(
      ([left, a], [right, b]) => b.bytes - a.bytes || (left < right ? -1 : 1),
    )
    .slice(0, limit)
    .map(([query, { bytes, frames }]) => ({
      query,
      bytes,
      updates: frames,
      readSet: Object.hasOwn(readSets, query)
        ? [...new Set(readSets[query])].sort()
        : null,
    }));
}
