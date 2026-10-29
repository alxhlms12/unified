import { ApiError, fetchText, fetchJson, parseJwtExpiry, providerStatus, normalizeTrack, extractEdges } from "../lib.js";

const REQUIRED = ["d-arl"];
const AUTH_URL = "https://auth.deezer.com/login/arl?jo=p&rto=c&i=c";
const GRAPHQL_URL = "https://pipe.deezer.com/api";
const jwtCache = new Map();

function splitSetCookie(headers) {
  if (typeof headers?.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers?.get?.("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;,\s]+=)/g) : [];
}

function rememberCookies(arl, headers) {
  const cache = jwtCache.get(arl) ?? {};
  const jar = new Map();
  for (const part of String(cache.cookies ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) jar.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  for (const setCookie of splitSetCookie(headers)) {
    const pair = String(setCookie).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name.toLowerCase() === "arl") continue;
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  jwtCache.set(arl, { ...cache, cookies: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") });
}

function assertConfigured(env) {
  if (!env["d-arl"] || !String(env["d-arl"]).trim()) {
    throw new ApiError(503, "provider_not_configured", "Deezer is not configured on this Unified instance.", { missing: REQUIRED });
  }
}

async function getJwt(env, force = false) {
  assertConfigured(env);
  const arl = env["d-arl"];
  const current = jwtCache.get(arl);
  if (!force && current?.token && current.expiresAt > Date.now() + 30000) return current.token;
  const { response: authResponse, text } = await fetchText(AUTH_URL, {
    // Deezer's ARL->JWT handshake is a POST. Sending GET here is rejected
    // with HTTP 405 before Pipe GraphQL is ever reached.
    method: "POST",
    headers: {
      cookie: `arl=${arl}`,
      origin: "https://www.deezer.com",
      referer: "https://www.deezer.com/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      accept: "application/json, text/plain, */*"
    }
  });
  rememberCookies(arl, authResponse.headers);
  let body;
  try { body = JSON.parse(text); } catch { throw new ApiError(503, "deezer_auth_failed", "Deezer returned an invalid authentication response."); }
  const token = body.jwt ?? body.token ?? body.access_token;
  if (typeof token !== "string" || !token) throw new ApiError(503, "deezer_auth_failed", "Deezer did not return a JWT. Check d-arl.");
  const expiresAt = parseJwtExpiry(token) || Date.now() + 330000;
  jwtCache.set(arl, { ...(jwtCache.get(arl) ?? {}), token, expiresAt });
  return token;
}

async function gql(env, query, variables = {}) {
  let jwt = await getJwt(env);
  const send = async token => {
    const cookies = jwtCache.get(env["d-arl"])?.cookies;
    const { response, text } = await fetchText(GRAPHQL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: "https://www.deezer.com",
        referer: "https://www.deezer.com/",
        "user-agent": "Mozilla/5.0",
        ...(cookies ? { cookie: cookies } : {})
      },
      body: JSON.stringify({ query, variables })
    });
    rememberCookies(env["d-arl"], response.headers);
    try { return text ? JSON.parse(text) : {}; }
    catch { throw new ApiError(502, "invalid_upstream_json", "Deezer Pipe returned a non-JSON response."); }
  };
  let result;
  try { result = await send(jwt); }
  catch (error) {
    if (error?.details?.upstreamStatus !== 401) throw error;
    jwt = await getJwt(env, true);
    result = await send(jwt);
  }
  if (result?.errors?.length && !result?.data) {
    throw new ApiError(502, "deezer_graphql_error", result.errors[0]?.message || "Deezer GraphQL returned an error.");
  }
  return result?.data ?? {};
}

const TRACK_FIELDS = `id title ISRC duration isExplicit album { id displayTitle cover { id urls(pictureRequest: { width: 500, height: 500 }) } } contributors(first: 10, roles: [MAIN, FEATURED]) { edges { node { ... on Artist { id name } } } } media { rights { sub { available } } }`;
const ALBUM_FIELDS = `id displayTitle type releaseDate isExplicit cover { id urls(pictureRequest: { width: 500, height: 500 }) } contributors(first: 5, roles: [MAIN]) { edges { node { ... on Artist { id name } } } }`;
const ARTIST_FIELDS = `id name picture { id urls(pictureRequest: { width: 500, height: 500 }) }`;
const PLAYLIST_FIELDS = `id title description picture { id urls(pictureRequest: { width: 500, height: 500 }) } estimatedTracksCount owner { id name }`;

const SEARCH_QUERY = `query UnifiedSearch($query: String!, $tracksFirst: Int!, $albumsFirst: Int!, $artistsFirst: Int!, $playlistsFirst: Int!) {
  search(query: $query) { results {
    tracks(first: $tracksFirst) { edges { node { ${TRACK_FIELDS} } } pageInfo { hasNextPage endCursor } }
    albums(first: $albumsFirst) { edges { node { ${ALBUM_FIELDS} } } pageInfo { hasNextPage endCursor } }
    artists(first: $artistsFirst) { edges { node { ${ARTIST_FIELDS} } } pageInfo { hasNextPage endCursor } }
    playlists(first: $playlistsFirst) { edges { node { ${PLAYLIST_FIELDS} } } pageInfo { hasNextPage endCursor } }
  } }
}`;

export function status(env) {
  return providerStatus(env, "deezer", REQUIRED, {
    search: true, trackInfo: true, albumInfo: true, artistInfo: true, playlistInfo: true,
    synchronizedLyrics: true, directStreamResolution: false
  });
}

export async function search(env, query, type = "track", limit = 25, offset = 0) {
  const fetchCount = Math.min(limit + offset, 100);
  const data = await gql(env, SEARCH_QUERY, {
    query,
    tracksFirst: type === "track" ? fetchCount : 0,
    albumsFirst: type === "album" ? fetchCount : 0,
    artistsFirst: type === "artist" ? fetchCount : 0,
    playlistsFirst: type === "playlist" ? fetchCount : 0
  });
  const results = data.search?.results ?? {};
  const root = results[({ track: "tracks", album: "albums", artist: "artists", playlist: "playlists" })[type]];
  if (!root) throw new ApiError(400, "unsupported_search_type", "Deezer supports track, album, artist, and playlist search.");
  const items = extractEdges(root).slice(offset, offset + limit);
  return { provider: "deezer", type, total: null, items: type === "track" ? items.map(item => normalizeTrack("deezer", item)).filter(Boolean) : items,
    pageInfo: root.pageInfo ?? null };
}

export async function info(env, id) {
  const query = `query UnifiedTrack($trackId: String!) { track(trackId: $trackId) { ${TRACK_FIELDS} lyrics { text copyright writers synchronizedLines { lrcTimestamp line milliseconds duration } } media { id version token { payload expiresAt } estimatedSizes { MP3_MISC MP3_128 MP3_320 FLAC } rights { ads { available } sub { available } } } releaseDate isAtmos } }`;
  const data = await gql(env, query, { trackId: String(id) });
  if (!data.track) throw new ApiError(404, "track_not_found", "Track was not found in Deezer.");
  return data.track;
}

export async function album(env, id) {
  const query = `query UnifiedAlbum($albumId: String!, $first: Int!) { album(albumId: $albumId) { ${ALBUM_FIELDS} duration tracksCount discsCount tracks(first: $first) { edges { cursor node { ${TRACK_FIELDS} } } pageInfo { hasNextPage endCursor } } url { ... on Url { webUrl } } } }`;
  const data = await gql(env, query, { albumId: String(id), first: 100 });
  if (!data.album) throw new ApiError(404, "album_not_found", "Album was not found in Deezer.");
  return data.album;
}

export async function artist(env, id) {
  const query = `query UnifiedArtist($artistId: String!, $first: Int!) { artist(artistId: $artistId) { ${ARTIST_FIELDS} bio social { website twitter facebook instagram } topTracks(first: $first) { edges { node { ${TRACK_FIELDS} } } pageInfo { hasNextPage endCursor } } albums(types: [ALBUM, SINGLES, EP], order: RELEASE_DATE, first: $first) { edges { node { ${ALBUM_FIELDS} tracksCount } } pageInfo { hasNextPage endCursor } } url { ... on Url { webUrl } } } }`;
  const data = await gql(env, query, { artistId: String(id), first: 50 });
  if (!data.artist) throw new ApiError(404, "artist_not_found", "Artist was not found in Deezer.");
  return data.artist;
}

export async function playlist(env, id) {
  const query = `query UnifiedPlaylist($playlistId: String!, $first: Int!) { playlist(playlistId: $playlistId) { ${PLAYLIST_FIELDS} isPrivate isCollaborative estimatedDuration tracks(first: $first) { edges { cursor addedAt node { ${TRACK_FIELDS} } } pageInfo { hasNextPage endCursor } } } }`;
  const data = await gql(env, query, { playlistId: String(id), first: 100 });
  if (!data.playlist) throw new ApiError(404, "playlist_not_found", "Playlist was not found in Deezer.");
  return data.playlist;
}

export async function lyrics(env, id) {
  const track = await info(env, id);
  if (!track.lyrics) throw new ApiError(404, "lyrics_not_found", "Lyrics are not available for this Deezer track.");
  return { trackId: String(id), ...track.lyrics };
}

export async function stream(env, id) {
  // The Pipe GraphQL API can supply entitlement and media metadata, but this
  // implementation intentionally does not decrypt or reconstruct protected
  // Deezer media payloads.
  const track = await info(env, id);
  return {
    provider: "deezer",
    trackId: String(id),
    playable: Boolean(track.media?.rights?.sub?.available || track.media?.rights?.ads?.available),
    media: {
      version: track.media?.version ?? null,
      estimatedSizes: track.media?.estimatedSizes ?? null,
      rights: track.media?.rights ?? null
    },
    streamUrl: null,
    note: "A direct stream URL is not exposed by this adapter."
  };
}
