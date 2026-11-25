import type { EdgeTransport } from "./types";

export function createHttpEdgeTransport(
  baseUrl: string | URL,
  headers?: HeadersInit,
): EdgeTransport {
  const base = new URL(baseUrl);
  base.pathname = base.pathname.replace(/\/?$/, "/");
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("accept", "application/json");
  return async (operation, request, signal) => {
    const response = await fetch(new URL(operation, base), {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(request),
      redirect: "error",
      signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { status: response.status, body };
  };
}
