import { EdgeTransportError, type EdgeTransport } from "./types";

export function createHttpEdgeTransport(
  baseUrl: string | URL,
  headers?: HeadersInit,
): EdgeTransport {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new TypeError("Edge transport requires an HTTP(S) URL");
  }
  base.pathname = base.pathname.replace(/\/?$/, "/");
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("accept", "application/json");
  return async (operation, request, signal) => {
    const body = JSON.stringify(request);
    let response: Response;
    let text: string;
    try {
      response = await fetch(new URL(operation, base), {
        method: "POST",
        headers: requestHeaders,
        body,
        redirect: "error",
        signal,
      });
      text = await response.text();
    } catch (error) {
      if (!(error instanceof TypeError) && !signal.aborted) throw error;
      throw new EdgeTransportError(error);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return {
      status: response.status,
      body: decoded,
      retryAfterHeader: response.headers.get("retry-after"),
    };
  };
}
