// Vercel serverless entry point.
// Re-exports the Express app (which reads config from environment variables).
// All /api/* requests are routed here by vercel.json.
export { default } from "../server/index.mjs";
