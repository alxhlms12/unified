import { ApiError, fetchJson, fetchText, makeUrl, parseJwtExpiry, providerStatus, normalizeStreamResult } from "../lib.js";

const REQUIRED = ["t-cid", "t-cs", "t-rt", "t-cc"];
const V1 = "https://api.tidal.com/v1/";
const V2 = "https://openapi.tidal.com/v2/";
const tokenCache = new Map();
const tokenFlights = new Map();

function assertConfigured(env) {
  const missing = REQUIRED.filter(key => !env[key] || !String(env[key]).trim());
  if (missing.length) throw new ApiError(503, "provider_not_configured", "Tidal is not configured on this Unified instance.", { missing });
}

async function getToken(env, force = false) {
  assertConfigured(env);
  const cacheKey = `${env["t-cid"]}:${env["t-rt"]}`;
  const current = tokenCache.get(cacheKey);
  if (!force && current?.token && current.expiresAt > Date.now() + 30000) return current.token;
  if (tokenFlights.has(cacheKey)) return tokenFlights.get(cacheKey);
  const flight = (async () => {
    const basic = btoa(`${env["t-cid"]}:${env["t-cs"]}`);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env["t-rt"],
      scope: "r_usr+w_usr+w_sub"
    });
    const data = await fetchJson("https://auth.tidal.com/v1/oauth2/token", {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body
    });
    if (!data.access_token) throw new ApiError(503, "tidal_auth_failed", "Tidal did not return an access token.");
    const expiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : parseJwtExpiry(data.access_token);
    tokenCache.set(cacheKey, { token: data.access_token, expiresAt: expiresAt || Date.now() + 240000 });
    return data.access_token;
  })();
  tokenFlights.set(cacheKey, flight);
  try { return await flight; }
  finally { if (tokenFlights.get(cacheKey) === flight) tokenFlights.delete(cacheKey); }
}
async function api(env, path, params = {}, options = {}) {
  const base = options.v2 ? V2 : V1;
  const url = makeUrl(base, path, { countryCode: env["t-cc"] || env.DEFAULT_COUNTRY || "US", ...params });
  let token = await getToken(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchText(url, {
        method: options.method || "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(options.headers || {}) },
        ...(options.body != null ? { body: options.body } : {})
      });
      try { return response.text ? JSON.parse(response.text) : {}; }
      catch { throw new ApiError(502, "invalid_upstream_json", "Tidal returned a non-JSON response."); }
    } catch (error) {
      if (attempt === 0 && error?.details?.upstreamStatus === 401) {
        token = await getToken(env, true);
        continue;
      }
      throw error;
    }
  }
  throw new ApiError(502, "tidal_request_failed", "Tidal request failed after a token refresh.");
}

function validateSingleSearch(url) {
  const keys = ["s", "a", "al", "v", "p", "i"].filter(key => url.searchParams.has(key) && url.searchParams.get(key) !== "");
  if (keys.length !== 1) throw new ApiError(400, "invalid_search", "Specify exactly one of s, a, al, v, p, or i.");
  return keys[0];
}

export function status(env) {
  const s = providerStatus(env, "tidal", REQUIRED, {
    search: true, trackInfo: true, trackPlaybackInfo: true, trackManifests: true,
    dolbyAtmos: true, configurableManifestType: true, manifestTypes: ["HLS", "MPEG_DASH"],
    album: true, playlist: true, artist: true, mix: true, recommendations: true,
    lyrics: true, artwork: true, similarArtists: true, similarAlbums: true, topVideos: true, videoInfo: true,
    widevineProxy: false
  });
  return s;
}

export async function search(env, q, type = "track", limit = 25, offset = 0) {
  let data;
  if (type === "track") data = await api(env, "search/tracks", { query: q, limit, offset });
  else {
    const types = ({ album: "ALBUMS", artist: "ARTISTS", playlist: "PLAYLISTS", video: "VIDEOS" })[type];
    if (!types) throw new ApiError(400, "unsupported_search_type", "type must be track, album, artist, playlist, or video");
    data = await api(env, "search/top-hits", { query: q, limit, offset, types });
  }
  return data;
}

// Tidal exposes a native ISRC filter on GET /v1/tracks. Use it instead of
// submitting the ISRC as ordinary search text (which does not reliably match).
export async function findByIsrc(env, isrc, limit = 25, offset = 0) {
  const result = await api(env, "tracks", { isrc, limit, offset, countryCode: env["t-cc"] || "US" });
  const items = Array.isArray(result?.items) ? result.items : Array.isArray(result?.data?.items) ? result.data.items : [];
  return { items, strategy: "native_isrc_filter", total: result?.totalNumberOfItems ?? result?.total ?? items.length };
}

export async function compatible(env, path, url) {
  const q = url.searchParams;
  const id = q.get("id");
  const countryCode = q.get("countryCode") || env["t-cc"] || "US";
  const limit = intQuery(q.get("limit"), 25, 1, 500);
  const offset = intQuery(q.get("offset"), 0, 0, 1000000);
  const params = { countryCode };

  switch (path) {
    case "/":
      return { version: TIDAL_VERSION, Repo: "https://github.com/binimum/hifi-api", unified: true };
    case "/info/":
      return { version: TIDAL_VERSION, data: await api(env, `tracks/${requireId(id)}/`, params) };
    case "/track/": {
      const quality = (q.get("quality") || "HI_RES_LOSSLESS").toUpperCase();
      if (!["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW", "ATMOS", "DOLBY_ATMOS"].includes(quality)) {
        throw new ApiError(400, "invalid_quality", "quality must be HI_RES_LOSSLESS, LOSSLESS, HIGH, LOW, or ATMOS");
      }
      const wantsAtmos = q.get("atmos") === "true" || q.get("immersiveaudio") === "true" ||
        ["ATMOS", "DOLBY_ATMOS"].includes(quality) || ["ATMOS", "DOLBY_ATMOS"].includes((q.get("audioMode") || "").toUpperCase()) ||
        q.getAll("formats").some(format => format.toUpperCase() === "EAC3_JOC");
      // Use trackManifests for both default stereo and Atmos playback. Unlike
      // playback-info's base64 manifest payload, this endpoint provides a URL
      // that clients can request directly, and supports HLS/DASH selection.
      const data = await getManifestStream(env, requireId(id), {
        quality,
        manifestType: q.get("manifestType") || "MPEG_DASH",
        audioMode: q.get("audioMode") || (wantsAtmos ? "DOLBY_ATMOS" : "STEREO"),
        atmos: wantsAtmos,
        formats: q.getAll("formats"),
        adaptive: q.get("adaptive") || "true",
        usage: q.get("usage") || "PLAYBACK",
        uriScheme: "HTTPS"
      });
      return { version: TIDAL_VERSION, data };
    }
    case "/trackManifests/": {
      const formats = q.getAll("formats");
      const data = await getManifestStream(env, requireId(id), {
        quality: q.get("quality") || "HI_RES_LOSSLESS",
        manifestType: q.get("manifestType") || "MPEG_DASH",
        audioMode: q.get("audioMode") || ((q.get("atmos") === "true" || q.get("immersiveaudio") === "true") ? "DOLBY_ATMOS" : "STEREO"),
        formats,
        adaptive: q.get("adaptive") || "true",
        usage: q.get("usage") || "PLAYBACK",
        uriScheme: q.get("uriScheme") || "HTTPS"
      });
      return { version: TIDAL_VERSION, data };
    }
    case "/widevine":
      throw new ApiError(501, "drm_license_proxy_disabled", "Unified does not proxy DRM licenses.");
    case "/recommendations/":
      return { version: TIDAL_VERSION, data: await api(env, `tracks/${requireId(id)}/recommendations`, { ...params, limit: 20 }) };
    case "/search/": {
      const key = validateSingleSearch(url);
      if (key === "i") return { version: TIDAL_VERSION, data: await api(env, "tracks", { ...params, isrc: q.get("i"), limit, offset }) };
      const value = q.get(key);
      if (key === "s") return { version: TIDAL_VERSION, data: await api(env, "search/tracks", { ...params, query: value, limit, offset }) };
      const types = ({ a: "ARTISTS,TRACKS", al: "ALBUMS", v: "VIDEOS", p: "PLAYLISTS" })[key];
      return { version: TIDAL_VERSION, data: await api(env, "search/top-hits", { ...params, query: value, limit, offset, types }) };
    }
    case "/album/": {
      const albumId = requireId(id);
      const [album, items] = await Promise.all([
        api(env, `albums/${albumId}`, params),
        api(env, `albums/${albumId}/items`, { ...params, limit, offset })
      ]);
      return { version: TIDAL_VERSION, data: { ...album, items: items?.items ?? items } };
    }
    case "/mix/": {
      const data = await api(env, "pages/mix", { ...params, mixId: requireId(id), deviceType: "BROWSER" });
      let mix = {}, items = [];
      for (const row of data?.rows ?? []) for (const module of row?.modules ?? []) {
        if (module.type === "MIX_HEADER") mix = module.mix ?? {};
        if (module.type === "TRACK_LIST") items = module.pagedList?.items ?? [];
      }
      return { version: TIDAL_VERSION, mix, items: items.map(item => item?.item ?? item) };
    }
    case "/playlist/": {
      const playlistId = requireId(id);
      const [playlist, items] = await Promise.all([
        api(env, `playlists/${encodeURIComponent(playlistId)}`, params),
        api(env, `playlists/${encodeURIComponent(playlistId)}/items`, { ...params, limit: intQuery(q.get("limit"), 100, 1, 500), offset })
      ]);
      return { version: TIDAL_VERSION, playlist, items: items?.items ?? items };
    }
    case "/artist/similar/": {
      const data = await api(env, `artists/${requireId(id)}/relationships/similarArtists`, { ...params, "page[cursor]": q.get("cursor"), include: "similarArtists,similarArtists.profileArt" }, { v2: true });
      return { version: TIDAL_VERSION, artists: data?.data ?? [] };
    }
    case "/album/similar/": {
      const data = await api(env, `albums/${requireId(id)}/relationships/similarAlbums`, { ...params, "page[cursor]": q.get("cursor"), include: "similarAlbums,similarAlbums.coverArt,similarAlbums.artists" }, { v2: true });
      return { version: TIDAL_VERSION, albums: data?.data ?? [] };
    }
    case "/artist/": {
      const artistId = q.get("id");
      const releaseId = q.get("f");
      if (!artistId && !releaseId) throw new ApiError(400, "missing_parameter", "Provide id or f query parameter");
      if (artistId) {
        const artist = await api(env, `artists/${requireId(artistId)}`, params);
        const picture = artist?.picture;
        const cover = picture ? { id: artist.id, name: artist.name, "750": `https://resources.tidal.com/images/${picture.replace(/-/g, "/")}/750x750.jpg` } : null;
        return { version: TIDAL_VERSION, artist, cover };
      }
      const artist = await api(env, `artists/${requireId(releaseId)}`, params);
      const [albums, eps] = await Promise.all([
        api(env, `artists/${releaseId}/albums`, { ...params, limit: 100 }),
        api(env, `artists/${releaseId}/albums`, { ...params, limit: 100, filter: "EPSANDSINGLES" })
      ]);
      const releases = [...(albums?.items ?? []), ...(eps?.items ?? [])];
      const unique = [...new Map(releases.map(item => [String(item.id), item])).values()];
      let tracks = [];
      let trackAggregationTruncated = false;
      if (q.get("skip_tracks") === "true") {
        const topTracks = await api(env, `artists/${releaseId}/toptracks`, { ...params, limit: 15 });
        tracks = topTracks?.items ?? [];
      } else {
        // Cloudflare Workers have finite subrequest budgets. Aggregate the first
        // 30 releases by default to avoid exhausting the free-plan request cap.
        // Clients needing the full discography can request a different cap.
        const maxAlbums = intQuery(q.get("trackAlbumLimit"), 30, 1, 40);
        const chosen = unique.slice(0, maxAlbums);
        trackAggregationTruncated = unique.length > chosen.length;
        for (const release of chosen) {
          if (!release?.id) continue;
          const page = await api(env, `albums/${encodeURIComponent(String(release.id))}/items`, { ...params, limit: 100, offset: 0 });
          for (const entry of page?.items ?? []) {
            const track = entry?.item ?? entry?.track ?? entry;
            if (track?.id != null) tracks.push(track);
          }
        }
      }
      return { version: TIDAL_VERSION, artist, albums: unique, tracks, trackAggregationTruncated };
    }
    case "/cover/": {
      const trackId = q.get("id");
      const query = q.get("q");
      const makeCover = (coverSlug, name, coverId) => ({
        id: coverId, name,
        "1280": `https://resources.tidal.com/images/${coverSlug.replace(/-/g, "/")}/1280x1280.jpg`,
        "640": `https://resources.tidal.com/images/${coverSlug.replace(/-/g, "/")}/640x640.jpg`,
        "80": `https://resources.tidal.com/images/${coverSlug.replace(/-/g, "/")}/80x80.jpg`
      });
      if (trackId) {
        const data = await api(env, `tracks/${requireId(trackId)}`, params);
        const album = data?.album ?? {};
        if (!album.cover) throw new ApiError(404, "cover_not_found", "Cover not found");
        return { version: TIDAL_VERSION, covers: [makeCover(album.cover, album.title || data.title, album.id || trackId)] };
      }
      if (!query) throw new ApiError(400, "missing_parameter", "Provide id or q query parameter");
      const search = await api(env, "search/tracks", { ...params, query, limit: 10 });
      const covers = (search?.items ?? []).map(item => item.album?.cover ? makeCover(item.album.cover, item.album.title || item.title, item.album.id || item.id) : null).filter(Boolean);
      if (!covers.length) throw new ApiError(404, "cover_not_found", "Cover not found");
      return { version: TIDAL_VERSION, covers };
    }
    case "/lyrics/": {
      const data = await api(env, `tracks/${requireId(id)}/lyrics`, { ...params, locale: q.get("locale") || "en_US", deviceType: q.get("deviceType") || "BROWSER" });
      if (!data || (typeof data === "object" && Object.keys(data).length === 0)) throw new ApiError(404, "lyrics_not_found", "Lyrics not found");
      return { version: TIDAL_VERSION, lyrics: data };
    }
    case "/topvideos/": {
      const data = await api(env, "pages/mymusic_recommended_videos", {
        countryCode, locale: q.get("locale") || "en_US", deviceType: q.get("deviceType") || "BROWSER"
      });
      const videos = [];
      for (const row of data?.rows ?? []) for (const module of row?.modules ?? []) {
        if (["VIDEO_PLAYLIST", "VIDEO_ROW", "PAGED_LIST"].includes(module.type) || module.type?.toLowerCase().includes("video")) {
          const candidates = module.pagedList?.items ?? (module.item ? [module.item] : []);
          for (const candidate of candidates) videos.push(candidate?.item ?? candidate);
        }
      }
      return { version: TIDAL_VERSION, videos: videos.slice(offset, offset + limit), total: videos.length };
    }
    case "/video/": {
      const data = await api(env, `videos/${requireId(id)}/playbackinfo`, {
        ...params, videoquality: q.get("quality") || "HIGH", playbackmode: q.get("mode") || "STREAM",
        assetpresentation: q.get("presentation") || "FULL"
      });
      return { version: TIDAL_VERSION, video: data };
    }
    default:
      throw new ApiError(404, "not_found", `Unknown Tidal compatibility route: ${path}`);
  }
}

const TIDAL_VERSION = "2.10";
function requireId(id) {
  if (id == null || String(id).trim() === "") throw new ApiError(400, "missing_parameter", "Missing required query parameter: id");
  return String(id);
}
function intQuery(raw, fallback, min, max) {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, "invalid_parameter", `Expected integer in range ${min}-${max}`);
  return n;
}

export async function unifiedSearch(env, query, type, limit, offset) {
  return search(env, query, type, limit, offset);
}
export async function info(env, id) { return api(env, `tracks/${encodeURIComponent(id)}`, {}); }
export async function getAlbum(env, id) { return api(env, `albums/${encodeURIComponent(id)}`, {}); }
export async function getArtist(env, id) { return api(env, `artists/${encodeURIComponent(id)}`, {}); }
export async function getPlaylist(env, id) { return api(env, `playlists/${encodeURIComponent(id)}`, {}); }
export async function getLyrics(env, id) { return api(env, `tracks/${encodeURIComponent(id)}/lyrics`, { locale: "en_US", deviceType: "BROWSER" }); }
export async function getStream(env, id, quality = "HI_RES_LOSSLESS") { return api(env, `tracks/${encodeURIComponent(id)}/playbackinfo`, { audioquality: quality, playbackmode: "STREAM", assetpresentation: "FULL" }); }

// Common adapter interface consumed by the generic /v1 REST router. Keep the
// hifi-api-compatible route implementation above separate from these aliases.
async function getItems(env, collection, id) {
  const result = await api(env, `${collection}/${encodeURIComponent(id)}/items`, { limit: 100, offset: 0 });
  const items = Array.isArray(result?.items) ? result.items : Array.isArray(result?.data?.items) ? result.data.items : [];
  return items.map(entry => entry?.item ?? entry);
}

export async function album(env, id) {
  const metadata = await getAlbum(env, id);
  try {
    const items = await getItems(env, "albums", id);
    return { ...metadata, items };
  } catch (error) {
    return { ...metadata, items: null, itemsError: { code: error?.code || "track_listing_failed", message: error?.message || "Album tracks could not be loaded." } };
  }
}
export async function artist(env, id) { return getArtist(env, id); }
export async function playlist(env, id) {
  const metadata = await getPlaylist(env, id);
  try {
    const items = await getItems(env, "playlists", id);
    return { ...metadata, items };
  } catch (error) {
    return { ...metadata, items: null, itemsError: { code: error?.code || "track_listing_failed", message: error?.message || "Playlist tracks could not be loaded." } };
  }
}
export async function lyrics(env, id) { return getLyrics(env, id); }
const TIDAL_FORMATS = new Set(["HEAACV1", "AACLC", "FLAC", "FLAC_HIRES", "EAC3_JOC"]);

function readQualityFormats(quality, isAtmos) {
  if (isAtmos) return ["EAC3_JOC"];
  return ({
    LOW: ["HEAACV1"],
    HIGH: ["AACLC"],
    LOSSLESS: ["FLAC"],
    HI_RES_LOSSLESS: ["FLAC_HIRES", "FLAC"],
    FLAC: ["FLAC"],
    FLAC_HIRES: ["FLAC_HIRES", "FLAC"]
  })[String(quality || "HI_RES_LOSSLESS").toUpperCase()] ?? ["FLAC_HIRES", "FLAC", "AACLC", "HEAACV1"];
}

function parseManifestExpiry(url) {
  try {
    const token = new URL(url).searchParams.get("token");
    const expiry = Number(token?.split("~", 1)[0]);
    return Number.isFinite(expiry) && expiry > 0 ? new Date(expiry * 1000).toISOString() : null;
  } catch { return null; }
}

export async function getManifestStream(env, id, options = {}) {
  if (typeof options === "string") options = { quality: options };
  const quality = String(options.quality || "HI_RES_LOSSLESS").toUpperCase();
  const audioMode = String(options.audioMode || "").toUpperCase();
  const isAtmos = Boolean(options.atmos || audioMode === "ATMOS" || audioMode === "DOLBY_ATMOS" || ["ATMOS", "DOLBY_ATMOS"].includes(quality));
  const manifestType = String(options.manifestType || "MPEG_DASH").toUpperCase();
  if (!["HLS", "MPEG_DASH"].includes(manifestType)) {
    throw new ApiError(400, "invalid_manifest_type", "manifestType must be HLS or MPEG_DASH");
  }
  const requested = Array.isArray(options.formats) ? options.formats.map(String).map(x => x.toUpperCase()).filter(Boolean) : [];
  if (requested.some(format => !TIDAL_FORMATS.has(format))) {
    throw new ApiError(400, "invalid_audio_format", "formats may contain HEAACV1, AACLC, FLAC, FLAC_HIRES, or EAC3_JOC");
  }
  const formats = isAtmos ? ["EAC3_JOC"] : (requested.length ? requested : readQualityFormats(quality, false));
  const result = await api(env, `trackManifests/${encodeURIComponent(String(id))}`, {
    adaptive: options.adaptive || "true",
    manifestType,
    uriScheme: options.uriScheme || "HTTPS",
    usage: options.usage || "PLAYBACK",
    formats
  }, { v2: true });
  const attrs = result?.data?.data?.attributes ?? result?.data?.attributes ?? result?.attributes ?? {};
  const uri = attrs.uri ?? attrs.url ?? null;
  if (typeof uri !== "string" || !/^https?:\/\//i.test(uri)) {
    throw new ApiError(502, "tidal_manifest_url_missing", "Tidal did not return a usable manifest URL.", {
      manifestType, requestedFormats: formats
    });
  }
  const returnedFormats = Array.isArray(attrs.formats) ? attrs.formats : [];
  const atmosAvailable = returnedFormats.includes("EAC3_JOC");
  return normalizeStreamResult("tidal", id, {
    provider: "tidal",
    trackId: String(id),
    url: uri,
    streamType: "manifest",
    manifestType,
    mimeType: manifestType === "HLS" ? "application/vnd.apple.mpegurl" : "application/dash+xml",
    codec: atmosAvailable ? "E-AC-3 JOC" : (returnedFormats.includes("FLAC_HIRES") ? "FLAC" : returnedFormats.includes("FLAC") ? "FLAC" : null),
    quality: atmosAvailable ? "DOLBY_ATMOS" : returnedFormats.includes("FLAC_HIRES") ? "HI_RES_LOSSLESS" : returnedFormats.includes("FLAC") ? "LOSSLESS" : returnedFormats.includes("AACLC") ? "HIGH" : "LOW",
    bitDepth: attrs.bitDepth ?? null,
    sampleRate: attrs.sampleRate ?? null,
    bitrate: null,
    audioMode: atmosAvailable ? "DOLBY_ATMOS" : "STEREO",
    isAtmos: atmosAvailable,
    encrypted: false,
    protection: null,
    available: true,
    playable: true,
    previewOnly: false,
    expiresAt: parseManifestExpiry(uri),
    formats: returnedFormats.map(format => ({
      name: format,
      url: uri,
      manifestType,
      codec: format === "EAC3_JOC" ? "E-AC-3 JOC" : format.startsWith("FLAC") ? "FLAC" : null,
      quality: format === "EAC3_JOC" ? "DOLBY_ATMOS" : format === "FLAC_HIRES" ? "HI_RES_LOSSLESS" : format === "FLAC" ? "LOSSLESS" : format === "AACLC" ? "HIGH" : "LOW",
      mimeType: manifestType === "HLS" ? "application/vnd.apple.mpegurl" : "application/dash+xml"
    })),
    note: atmosAvailable
      ? "Dolby Atmos manifest selected. Playback may require a compatible client and provider-authorized license handling."
      : isAtmos ? "Dolby Atmos was requested, but Tidal did not confirm EAC3_JOC in the returned formats." : null
  });
}

export async function stream(env, id, options = {}) {
  return getManifestStream(env, id, options);
}
