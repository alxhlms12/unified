export const API_VERSION = "0.2.0";
export const TIDAL_COMPAT_VERSION = "2.10";

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

export function requireParam(url, key) {
  const value = url.searchParams.get(key);
  if (value == null || value.trim() === "") {
    throw new ApiError(400, "missing_parameter", `Missing required query parameter: ${key}`);
  }
  return value;
}

export function numberParam(url, key, fallback, min = 0, max = 500) {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, "invalid_parameter", `${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function boolParam(url, key, fallback = false) {
  const raw = url.searchParams.get(key);
  if (raw == null) return fallback;
  if (["true", "1", "yes"].includes(raw.toLowerCase())) return true;
  if (["false", "0", "no"].includes(raw.toLowerCase())) return false;
  throw new ApiError(400, "invalid_parameter", `${key} must be true or false`);
}

export function providerResourceId(raw) {
  const match = /^([a-z-]+):(track|album|artist|playlist|video):(.+)$/.exec(raw);
  if (!match) throw new ApiError(400, "invalid_resource_id", "Use provider:type:id, e.g. tidal:track:123");
  return { provider: match[1], type: match[2], id: match[3] };
}

export function isConfigured(env, keys) {
  return keys.every(key => env[key] != null && String(env[key]).trim() !== "");
}

export function providerStatus(env, name, required, capabilities, optional = {}) {
  const missing = required.filter(k => env[k] == null || String(env[k]).trim() === "");
  const configured = optional.configured ?? missing.length === 0;
  const available = optional.available ?? (configured || Boolean(optional.availableWithoutRequired));
  return {
    provider: name,
    configured,
    available,
    missing,
    capabilities: { ...capabilities, ...(optional.capabilities || {}) }
  };
}

export async function fetchText(url, init = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("upstream timeout"), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(response.status === 401 || response.status === 403 ? 503 : 502,
        "upstream_error", `Provider returned HTTP ${response.status}`, { upstreamStatus: response.status });
    }
    return { response, text };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "upstream_unreachable", "Could not reach the upstream provider.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJson(url, init = {}, timeoutMs = 12000) {
  const { text } = await fetchText(url, init, timeoutMs);
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new ApiError(502, "invalid_upstream_json", "Provider returned a non-JSON response."); }
}

export function makeUrl(base, path, params = {}) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export function parseJwtExpiry(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch { return 0; }
}

export function normalizeTrack(provider, track) {
  if (!track || typeof track !== "object") return null;
  if (typeof track.id === "string" && track.id.startsWith(`${provider}:track:`) && track.type === "track") return track;
  const rawId = track.id ?? track.trackId ?? track.videoId ?? track.urn;
  if (rawId == null) return null;
  const artistSource = track.artists ?? track.contributors?.edges?.map(edge => edge.node) ?? (track.artist ? [track.artist] : []);
  const artists = (Array.isArray(artistSource) ? artistSource : [artistSource]).map(artist => ({
    id: artist?.id != null ? `${provider}:artist:${artist.id}` : null,
    name: artist?.name ?? artist?.username ?? "Unknown artist"
  }));
  const albumRaw = track.album;
  const album = albumRaw ? {
    id: albumRaw.id != null ? `${provider}:album:${albumRaw.id}` : null,
    title: albumRaw.title ?? albumRaw.displayTitle ?? albumRaw.name ?? null,
    artworkUrl: albumRaw.coverUrl ?? albumRaw.image ?? albumRaw.artworkUrl ?? firstUrl(albumRaw.cover?.urls) ?? null
  } : null;
  const durationRaw = track.durationMs ?? track.duration ?? null;
  const durationMs = durationRaw == null ? null : (track.durationMs != null ? durationRaw : durationRaw * 1000);
  const artworkUrl = track.artworkUrl ?? track.artwork_url ?? track.image ?? firstUrl(albumRaw?.cover?.urls) ?? null;
  return {
    id: `${provider}:track:${rawId}`,
    type: "track",
    title: track.title ?? track.displayTitle ?? track.name ?? "Unknown title",
    artists,
    album,
    durationMs,
    isrc: track.isrc ?? track.ISRC ?? null,
    explicit: track.explicit ?? track.isExplicit ?? null,
    artworkUrl,
    url: track.url ?? track.permalink_url ?? null,
    provider,
    audio: {
      codec: track.codec ?? null,
      bitDepth: track.bitDepth ?? null,
      sampleRate: track.sampleRate ?? null,
      bitrate: track.bitrate ?? null,
      quality: track.audioQuality ?? track.quality ?? null
    },
    capabilities: { metadata: true, stream: null, lyrics: null }
  };
}

function firstUrl(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0]?.url ?? value[0] ?? null;
  if (typeof value === "object") return value.url ?? value["500"] ?? value["750"] ?? value["640"] ?? null;
  return null;
}

export function safeError(error) {
  if (error instanceof ApiError) {
    return { status: error.status, body: { error: {
      code: error.code, message: error.message,
      ...(error.details ? { details: error.details } : {})
    } } };
  }
  return { status: 500, body: { error: { code: "internal_error", message: "An unexpected error occurred." } } };
}

export function extractEdges(connection) {
  if (Array.isArray(connection)) return connection;
  return connection?.edges?.map(edge => edge.node) ?? connection?.items ?? [];
}
