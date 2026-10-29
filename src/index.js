import { Hono } from "hono";
import { cors } from "hono/cors";
import { API_VERSION, ApiError, safeError } from "./lib.js";
import { openapiDocument, v1Routes } from "./routes/v1.js";
import { tidalCompatRoutes } from "./routes/tidal-compat.js";

const app = new Hono({ strict: false });
const API_INFO = {
  name: "Unified Music API",
  version: API_VERSION,
  description: "A provider-agnostic REST API for music catalog metadata and provider-supported playback resolution.",
  docs: "/openapi.json",
  health: "/v1/health"
};

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "HEAD", "OPTIONS"],
  allowHeaders: ["content-type", "authorization", "x-api-key"],
  maxAge: 86400
}));

app.use("*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !(method === "POST" && /^\/widevine\/?$/.test(c.req.path))) {
    throw new ApiError(405, "method_not_allowed", "Unified currently accepts GET requests only, except disabled Tidal compatibility endpoints.");
  }
  if (method === "OPTIONS") return c.body(null, 204);

  const path = c.req.path;
  const publicPaths = new Set(["/", "/openapi.json", "/v1/health"]);
  const configuredKey = c.env.UNIFIED_API_KEY;
  if (configuredKey && !publicPaths.has(path)) {
    const supplied = c.req.header("x-api-key") || c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (supplied !== configuredKey) throw new ApiError(401, "unauthorized", "Provide a valid Unified API key.");
  }
  await next();
});

app.get("/", c => c.json(API_INFO));
app.get("/openapi.json", c => c.json(openapiDocument()));
app.route("/v1", v1Routes);
app.route("/", tidalCompatRoutes);

app.notFound(c => c.json({ error: { code: "not_found", message: `No route matches ${c.req.path}` } }, 404));
app.onError((error, c) => {
  const result = safeError(error);
  return c.json(result.body, result.status);
});

export { app };
export default app;
