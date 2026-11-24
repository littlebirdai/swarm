import { sanitizeCanvasCss } from "@codecast/render/canvasCss";
(
  globalThis as unknown as { sanitizeCanvasCss: typeof sanitizeCanvasCss }
).sanitizeCanvasCss = sanitizeCanvasCss;
