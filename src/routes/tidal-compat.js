import { Hono } from "hono";
import { ApiError } from "../lib.js";
import * as tidal from "../providers/tidal.js";

// These legacy-shaped routes exist only as a compatibility surface for the
// Tidal adapter. Unified's primary, provider-neutral contract is /v1/*.
export const tidalCompatRoutes = new Hono({ strict: false });

const ROUTES = [
  "/info", "/track", "/trackManifests", "/widevine", "/recommendations", "/search", "/album", "/mix", "/playlist",
  "/artist/similar", "/album/similar", "/artist", "/cover", "/lyrics", "/topvideos", "/video"
];

async function execute(c, path) {
  if (path === "/widevine") {
    throw new ApiError(501, "drm_license_proxy_disabled", "Unified does not proxy DRM license requests.");
  }
  return c.json(await tidal.compatible(c.env, `${path}/`, new URL(c.req.url)));
}

for (const path of ROUTES) {
  if (path === "/widevine") {
    tidalCompatRoutes.all(path, c => execute(c, path));
  } else {
    tidalCompatRoutes.get(path, c => execute(c, path));
  }
}
