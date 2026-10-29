import { ApiError, fetchJson, fetchText, providerStatus, normalizeTrack } from "../lib.js";

const HOME = "https://music.youtube.com/";
const API = "https://music.youtube.com/youtubei/v1/";
let runtimeCache = { at: 0, apiKey: null, clientVersion: null, visitorData: null };

async function discover(env) {
  if (env["ytm-api-key"]) return {
    apiKey: env["ytm-api-key"],
    clientVersion: env["ytm-client-version"] || "1.20261028.03.00",
    visitorData: env["ytm-visitor-data"] || null
  };
  if (runtimeCache.apiKey && runtimeCache.at > Date.now() - 6 * 60 * 60 * 1000) return runtimeCache;
  const { text } = await fetchText(HOME, { headers: { "user-agent": "Mozilla/5.0", accept: "text/html" } });
  const apiKey = /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(text)?.[1]
    ?? /"innertubeApiKey"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const clientVersion = /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/.exec(text)?.[1]
    ?? env["ytm-client-version"] ?? "1.20261028.03.00";
  const visitorData = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? env["ytm-visitor-data"] ?? null;
  if (!apiKey) throw new ApiError(503, "ytm_key_discovery_failed", "YouTube Music API-key discovery failed; configure ytm-api-key.");
  runtimeCache = { at: Date.now(), apiKey, clientVersion, visitorData };
  return runtimeCache;
}

function context(env, config) {
  return {
    client: {
      clientName: "WEB_REMIX",
      clientVersion: env["ytm-client-version"] || config.clientVersion,
      hl: "en",
      gl: env["ytm-country"] || env.DEFAULT_COUNTRY || "US",
      ...(env["ytm-visitor-data"] || config.visitorData ? { visitorData: env["ytm-visitor-data"] || config.visitorData } : {})
    }
  };
}

async function call(env, method, body) {
  const config = await discover(env);
  const url = new URL(method, API);
  url.searchParams.set("key", config.apiKey);
  url.searchParams.set("prettyPrint", "false");
  const headers = { "content-type": "application/json", "user-agent": "Mozilla/5.0", origin: "https://music.youtube.com" };
  if (env["ytm-cookie"]) headers.cookie = env["ytm-cookie"];
  return fetchJson(url, { method: "POST", headers, body: JSON.stringify({ context: context(env, config), ...body }) });
}

function walk(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  if (Array.isArray(node)) for (const child of node) walk(child, predicate, out);
  else for (const child of Object.values(node)) if (child && typeof child === "object") walk(child, predicate, out);
  return out;
}
function runsText(node) {
  const runs = node?.runs;
  if (Array.isArray(runs)) return runs.map(item => item.text ?? "").join("");
  return node?.simpleText ?? "";
}
function parseSearch(result) {
  const renderers = walk(result, node => node.musicResponsiveListItemRenderer || node.musicTwoRowItemRenderer);
  const found = new Map();
  for (const wrapper of renderers) {
    const renderer = wrapper.musicResponsiveListItemRenderer ?? wrapper.musicTwoRowItemRenderer;
    const columns = renderer.flexColumns ?? [];
    const title = runsText(columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text) || runsText(renderer.title);
    const videoId = renderer.playlistItemData?.videoId ?? renderer.navigationEndpoint?.watchEndpoint?.videoId;
    const artists = [];
    const subtitle = columns.slice(1).map(column => runsText(column.musicResponsiveListItemFlexColumnRenderer?.text)).filter(Boolean).join(" • ");
    const durationText = columns.map(column => runsText(column.musicResponsiveListItemFlexColumnRenderer?.text)).find(text => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) ?? null;
    if (!title || !videoId || found.has(videoId)) continue;
    artists.push({ name: subtitle || "Unknown artist" });
    found.set(videoId, normalizeTrack("youtube-music", {
      id: videoId, title, artists, duration: durationText ? parseDuration(durationText) : null,
      url: `https://music.youtube.com/watch?v=${videoId}`,
      artworkUrl: renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url ?? null
    }));
  }
  // Fallback for videoRenderer responses.
  for (const wrapper of walk(result, node => Boolean(node.videoRenderer))) {
    const renderer = wrapper.videoRenderer;
    if (!renderer.videoId || found.has(renderer.videoId)) continue;
    const artistText = runsText(renderer.ownerText) || runsText(renderer.shortBylineText);
    found.set(renderer.videoId, normalizeTrack("youtube-music", {
      id: renderer.videoId, title: runsText(renderer.title), artists: [{ name: artistText || "Unknown artist" }],
      duration: parseDuration(runsText(renderer.lengthText)), url: `https://music.youtube.com/watch?v=${renderer.videoId}`
    }));
  }
  return [...found.values()].filter(Boolean);
}
function parseDuration(text) {
  if (!text) return null;
  const parts = text.split(":").map(Number);
  if (parts.some(x => !Number.isFinite(x))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function status(env) {
  const configured = Boolean(env["ytm-api-key"] || String(env.YTM_KEY_DISCOVERY ?? "true").toLowerCase() === "true");
  return providerStatus(env, "youtube-music", [], {
    search: true, songMetadata: true, albumMetadata: true, artistMetadata: true, playlistMetadata: true,
    streamInfo: true
  }, { configured: Boolean(env["ytm-api-key"]), available: configured, availableWithoutRequired: configured, capabilities: { autoDiscoverApiKey: !env["ytm-api-key"], cookieAuthentication: Boolean(env["ytm-cookie"]) } });
}

export async function search(env, query, type = "track", limit = 25, offset = 0) {
  const params = ({ track: "EgWKAQIIAWoKEAkQBRAKEAMQBA==", video: "EgIQAQ==", album: "EgWKAQIYAWoKEAkQChAFEAMQBA==", artist: "EgWKAQIgAWoKEAkQChAFEAMQBA==", playlist: "EgWKAQIoAWoKEAkQChAFEAMQBA==" })[type];
  if (!params) throw new ApiError(400, "unsupported_search_type", "YouTube Music supports track, video, album, artist, and playlist search.");
  const result = await call(env, "search", { query, params });
  const items = parseSearch(result).slice(offset, offset + limit);
  return { provider: "youtube-music", type, total: items.length, items };
}

export async function info(env, id) {
  return call(env, "player", { videoId: id });
}
export async function album(env, id) { return call(env, "browse", { browseId: id }); }
export async function artist(env, id) { return call(env, "browse", { browseId: id }); }
export async function playlist(env, id) { return call(env, "browse", { browseId: id }); }
export async function lyrics(env, id) {
  const player = await info(env, id);
  const caption = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0];
  if (!caption?.baseUrl) throw new ApiError(404, "lyrics_not_found", "YouTube Music did not expose lyrics for this track.");
  const response = await fetchText(caption.baseUrl, { headers: { "user-agent": "Mozilla/5.0" } });
  return { trackId: id, format: caption.kind || "captions", data: response.text };
}
export async function stream(env, id) {
  const result = await info(env, id);
  const formats = result?.streamingData?.adaptiveFormats ?? result?.streamingData?.formats ?? [];
  const direct = formats.filter(format => format.url).map(format => ({
    url: format.url, mimeType: format.mimeType ?? null, bitrate: format.bitrate ?? null,
    audioQuality: format.audioQuality ?? null, contentLength: format.contentLength ?? null
  }));
  return {
    provider: "youtube-music", trackId: id, playable: direct.length > 0,
    formats: direct,
    encryptedOrSignedFormatsAvailable: formats.some(format => Boolean(format.signatureCipher || format.cipher)),
    note: direct.length ? null : "No direct URL was exposed. This adapter does not decipher protected signatureCipher URLs."
  };
}
