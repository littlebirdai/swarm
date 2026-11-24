import { sanitizeCanvasCss } from "../../../../packages/shared/render/canvasCss";
(
  globalThis as unknown as { sanitizeCanvasCss: typeof sanitizeCanvasCss }
).sanitizeCanvasCss = sanitizeCanvasCss;
