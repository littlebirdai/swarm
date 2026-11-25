export function relayPresenceUrl(
  flag: string | undefined,
  address: string | undefined,
): URL | null {
  if (flag !== "1" || !address) return null;
  try {
    const url = new URL(address);
    if (url.username || url.password) return null;
    if (url.href.includes("#") || url.href.includes("?")) return null;
    if (url.protocol === "wss:") return url;
    if (
      url.protocol === "ws:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      return url;
  } catch {
    return null;
  }
  return null;
}
