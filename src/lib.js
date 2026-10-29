export const API_VERSION = "0.3.2";
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

export async function fetchText(url, init = {}, timeoutMs = 7000) {
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

export async function fetchJson(url, init = {}, timeoutMs = 7000) {
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
  const artistSource = track.artists ?? track.contributors?.edges?.map(edge => edge.node) ??
    (track.artist ? [track.artist] : track.user ? [track.user] : []);
  const artists = (Array.isArray(artistSource) ? artistSource : [artistSource]).map(artist => ({
    id: artist?.id != null ? `${provider}:artist:${artist.id}` : null,
    name: artist?.name ?? artist?.username ?? "Unknown artist"
  }));
  const albumRaw = track.album;
  const albumCover = albumRaw?.coverUrl ?? albumRaw?.image ?? albumRaw?.artworkUrl ??
    firstUrl(albumRaw?.cover?.urls) ?? (typeof albumRaw?.cover === "string" ? albumRaw.cover : null) ?? null;
  const albumArtwork = typeof albumCover === "string" && provider === "tidal" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(albumCover)
    ? `https://resources.tidal.com/images/${albumCover.replace(/-/g, "/")}/750x750.jpg`
    : albumCover;
  const album = albumRaw ? {
    id: albumRaw.id != null ? `${provider}:album:${albumRaw.id}` : null,
    title: albumRaw.title ?? albumRaw.displayTitle ?? albumRaw.name ?? null,
    artworkUrl: albumArtwork
  } : null;
  const durationRaw = track.durationMs ?? track.duration ?? null;
  // Tidal/Deezer/Qobuz durations are seconds; SoundCloud's track object uses ms.
  const durationMs = durationRaw == null ? null : (track.durationMs != null || provider === "soundcloud" ? durationRaw : durationRaw * 1000);
  const rawArtwork = track.artworkUrl ?? track.artwork_url ?? track.image ?? firstUrl(albumRaw?.cover?.urls) ??
    (typeof albumRaw?.cover === "string" ? albumRaw.cover : null) ?? null;
  const artworkUrl = typeof rawArtwork === "string" && provider === "tidal" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawArtwork)
    ? `https://resources.tidal.com/images/${rawArtwork.replace(/-/g, "/")}/750x750.jpg`
    : rawArtwork;
  return {
    id: `${provider}:track:${rawId}`,
    type: "track",
    title: track.title ?? track.displayTitle ?? track.name ?? "Unknown title",
    artists,
    album,
    durationMs,
    isrc: track.isrc ?? track.ISRC ?? track.publisher_metadata?.isrc ?? track.publisher_metadata?.ISRC ?? null,
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


// All provider stream resolvers return this same contract. `url` is always
// the client-facing URL (a media URL, manifest URL, or signed Worker relay URL).
export function normalizeStreamResult(provider, id, input = {}) {
  let data = input && typeof input === "object" ? { ...input } : {};
  if (provider === "tidal" && typeof data.manifest === "string") {
    const decoded = decodeBase64Json(data.manifest);
    const decodedUrl = decoded?.urls?.find(value => typeof value === "string" && /^https?:\/\//i.test(value));
    if (decodedUrl) {
      data.url = data.url ?? decodedUrl;
      data.mimeType = data.mimeType ?? decoded.mimeType ?? decoded.mime_type ?? null;
      data.decodedManifest = true;
      delete data.manifest;
    }
  }

  const rawFormats = Array.isArray(data.formats) ? data.formats : [];
  const formats = rawFormats.map(format => ({
    name: format?.name ?? format?.format ?? null,
    url: format?.url ?? null,
    mimeType: format?.mimeType ?? format?.mime_type ?? null,
    codec: format?.codec ?? null,
    bitrate: format?.bitrate ?? null,
    quality: format?.quality ?? format?.audioQuality ?? null,
    manifestType: format?.manifestType ?? null,
    encrypted: Boolean(format?.encrypted || /(?:cbc|ctr)-encrypted-hls|widevine/i.test(format?.protocol ?? "")),
    protocol: format?.protocol ?? null
  }));
  const bestFormat = formats.find(format => format.url) ?? {};
  const url = data.url ?? data.streamUrl ?? data.manifestUrl ?? data.previewUrl ?? bestFormat.url ?? null;
  const protocol = data.protocol ?? data.format?.protocol ?? bestFormat.protocol ?? null;
  const mimeType = data.mimeType ?? data.mime_type ?? data.manifestMimeType ?? data.format?.mime_type ?? bestFormat.mimeType ?? null;
  const protocolLower = String(protocol ?? "").toLowerCase();
  const urlLower = String(url ?? "").toLowerCase();
  let manifestType = data.manifestType ?? null;
  if (!manifestType && (protocolLower.includes("hls") || urlLower.includes(".m3u8"))) manifestType = "HLS";
  if (!manifestType && (urlLower.includes(".mpd") || mimeType === "application/dash+xml")) manifestType = "MPEG_DASH";
  const encrypted = Boolean(data.encrypted || /(?:cbc|ctr)-encrypted-hls|widevine|drm-protected/i.test(protocolLower));
  const audioMode = data.audioMode ?? (data.isAtmos || /eac3_joc|dolby[ _-]?atmos/i.test(String(data.quality ?? "")) ? "DOLBY_ATMOS" : null);
  return {
    schema: "unified.stream.v1",
    provider,
    trackId: `${provider}:track:${id}`,
    url,
    streamType: data.streamType ?? (data.relayed ? "relay" : manifestType ? "manifest" : "direct"),
    manifestType,
    mimeType,
    codec: data.codec ?? bestFormat.codec ?? null,
    quality: data.quality ?? data.audioQuality ?? bestFormat.quality ?? null,
    bitDepth: data.bitDepth ?? null,
    sampleRate: data.sampleRate ?? null,
    bitrate: data.bitrate ?? bestFormat.bitrate ?? null,
    audioMode,
    isAtmos: Boolean(data.isAtmos || audioMode === "DOLBY_ATMOS"),
    encrypted,
    protection: data.protection ?? (encrypted ? "provider-managed" : null),
    available: Boolean(url),
    playable: data.playable ?? (Boolean(url) && !encrypted),
    previewOnly: Boolean(data.previewOnly),
    expiresAt: data.expiresAt ?? null,
    formats,
    ...(data.note ? { note: data.note } : {}),
    ...(data.decodedManifest ? { decodedManifest: true } : {}),
    ...(data.relayed ? { relayed: true } : {})
  };
}

function decodeBase64Json(value) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

function relaySecret(env) {
  return env.UNIFIED_RELAY_SECRET || env.UNIFIED_API_KEY || env["d-arl"] || null;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const result = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...result].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createRelaySignature(env, provider, id, expires) {
  const secret = relaySecret(env);
  if (!secret) throw new ApiError(503, "relay_not_configured", "Configure UNIFIED_RELAY_SECRET to enable signed media relay URLs.");
  return hmacHex(secret, `${provider}:${id}:${expires}`);
}

export async function verifyRelaySignature(env, provider, id, expires, signature) {
  if (!/^\d{10}$/.test(String(expires)) || !/^[a-f0-9]{64}$/i.test(String(signature))) return false;
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(expires);
  if (exp < now || exp > now + 600) return false;
  const secret = relaySecret(env);
  if (!secret) return false;
  const expected = await hmacHex(secret, `${provider}:${id}:${expires}`);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.toLowerCase().charCodeAt(i);
  return diff === 0;
}
