# Unified Music REST API

Unified is a provider-agnostic music REST API for Tidal, Deezer, Qobuz, YouTube Music, and SoundCloud. It runs on Cloudflare Workers and uses [Hono](https://hono.dev/) for routing, middleware, error handling, and HTTP responses.

The public API contract is Unified's own generic `/v1/*` design. The `binimum/hifi-api` route shapes are implemented **only for Tidal compatibility**, and they are kept in a separate router. The other providers do not inherit Tidal's endpoint naming or response structure.

> **Implementation status:** this is a foundation with adapters and route coverage, not yet verified full feature parity or end-to-end playback on every provider. Upstream private interfaces can change. Run the tests locally and verify provider calls using credentials for your own instance before exposing it publicly.

## Install and run

Requires Node.js 20+.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Deploy:

```sh
npx wrangler login
npx wrangler deploy
```

For a public instance, set an API key before deployment:

```sh
npx wrangler secret put UNIFIED_API_KEY
```

Clients then send `X-API-Key: your-key` or `Authorization: Bearer your-key`. `/`, `/openapi.json`, and `/v1/health` are public. Other endpoints require the key when `UNIFIED_API_KEY` is configured.

## Architecture

```text
src/
  index.js                  Hono app, CORS, API-key middleware, error handling
  routes/
    v1.js                   Provider-neutral Unified REST contract
    tidal-compat.js         Tidal-only hifi-api compatibility routes
  providers/
    tidal.js                Tidal adapter
    deezer.js               Deezer Pipe GraphQL adapter
    qobuz.js                Qobuz adapter
    ytmusic.js              YouTube Music Innertube adapter
    soundcloud.js           SoundCloud API-v2 adapter and client-ID discovery
  lib.js                    Shared HTTP helpers, normalization, errors and IDs
```

Each provider adapter owns its upstream request formats and credentials. Unified normalizes the response shape at the REST boundary. A missing or failed provider contributes an entry to the multi-provider search `errors` array rather than failing the entire combined search.

## Provider bindings

Binding names below intentionally preserve the requested hyphens. In JavaScript use bracket notation, for example `env["t-cid"]`.

| Variable | Meaning | Required |
|---|---|---:|
| `t-cid` | Tidal client ID | Yes |
| `t-cs` | Tidal client secret | Yes |
| `t-rt` | Tidal refresh token | Yes |
| `t-cc` | Tidal country code | Yes |
| `d-arl` | Deezer ARL session value | Yes |
| `q-cid` | Qobuz client/app ID | Yes |
| `q-cs` | Qobuz client secret/config value | Yes |
| `q-uat` | Qobuz user auth token | Yes |
| `ytm-api-key` | YouTube Music Innertube API key override | Optional; frontend discovery is attempted by default |
| `ytm-cookie` | Optional YouTube Music cookie context | Optional |
| `ytm-visitor-data` | Optional visitor-data value | Optional |
| `ytm-client-version` | Optional Innertube client-version override | Optional |
| `ytm-country` | Optional YouTube Music country code | Optional |
| `sc-cid` | SoundCloud client ID override | Optional; frontend discovery is attempted by default |
| `UNIFIED_API_KEY` | Protects non-public routes | Recommended for deployed instances |

Use `npx wrangler secret put NAME` for deployed secrets. For local development, set these in `.dev.vars`; do not commit that file.

## Generic Unified REST routes

These routes use Unified's generic naming and normalized schema regardless of the provider:

| Route | Purpose |
|---|---|
| `GET /v1/health` | Instance health and version |
| `GET /v1/providers` | Configured status and capabilities for all five providers; never returns credential values |
| `GET /v1/search?q=...&type=track` | Search all providers by default |
| `GET /v1/search?q=...&type=album&provider=qobuz` | Search a specific provider and resource type |
| `GET /v1/match?isrc=...` | Look for exact ISRC matches across provider catalogs |
| `GET /v1/tracks/{id}` | Track metadata |
| `GET /v1/tracks/{id}/stream` | Provider-supported playback/manifest resolution |
| `GET /v1/tracks/{id}/lyrics` | Lyrics, when supported |
| `GET /v1/albums/{id}` | Album metadata and available track data |
| `GET /v1/artists/{id}` | Artist metadata and supported catalog data |
| `GET /v1/playlists/{id}` | Playlist metadata and available tracks |
| `GET /v1/resolve?url=...` | Map a provider URL to a Unified resource identifier when recognizable |
| `GET /openapi.json` | OpenAPI 3.1 document for the generic Unified API |

Resource IDs are namespaced so provider IDs cannot collide:

```text
tidal:track:123
deezer:track:456
qobuz:track:789
youtube-music:track:abc
soundcloud:track:012
```

URL-encode IDs when necessary. Search is aggregated concurrently and returns `results`, flattened `items`, per-provider `errors`, and a `partial` flag. Metadata fields that cannot be verified should be null or omitted rather than guessed.

Example:

```http
GET /v1/search?q=Ella%20Mai&type=track&provider=all
```

## Tidal-only compatibility routes

The following root-level paths intentionally follow the route naming and parameter conventions of [`binimum/hifi-api`](https://github.com/binimum/hifi-api), solely for callers that need Tidal compatibility. They call the Tidal adapter; they are not the API design for the other providers.

- `GET /info/?id=...`
- `GET /track/?id=...&quality=HI_RES_LOSSLESS`
- `GET /trackManifests/?id=...&formats=FLAC&formats=FLAC_HIRES`
- `GET /search/?s=...`, `/search/?a=...`, `/search/?al=...`, `/search/?v=...`, `/search/?p=...`, or `/search/?i=ISRC`
- `GET /album/?id=...&limit=100&offset=0`
- `GET /artist/?id=...` or `/artist/?f=...&skip_tracks=true`
- `GET /playlist/?id=...&limit=100&offset=0`
- `GET /mix/?id=...`
- `GET /recommendations/?id=...`
- `GET /artist/similar/?id=...&cursor=...`
- `GET /album/similar/?id=...&cursor=...`
- `GET /cover/?id=...` or `/cover/?q=...`
- `GET /lyrics/?id=...`
- `GET /topvideos/?countryCode=US&limit=25&offset=0`
- `GET /video/?id=...&quality=HIGH`

`GET`/`POST /widevine` is deliberately disabled. Unified does not proxy DRM-license requests, decrypt protected media, or rewrite provider license URLs.

## Provider-specific limitations

- **Tidal:** refreshes access tokens server-side. The compatibility routes expose track playback information and v2 track manifest metadata. Actual playback availability and audio quality depend on the account and upstream response.
- **Deezer:** uses the internal Pipe GraphQL route with the configured `d-arl` session value. Stream output is entitlement/media metadata; protected audio is not decrypted or reconstructed.
- **Qobuz:** catalog calls use the JSON API path family. The legacy `track/getFileUrl` method may return HTTP 410; the current encrypted web-player flow is not implemented in this foundation.
- **YouTube Music:** uses internal Innertube search/player/browse calls. API-key discovery is attempted from the served frontend when `ytm-api-key` is absent. Encrypted signature URLs are not deciphered.
- **SoundCloud:** uses API-v2 and track transcodings. `sc-cid` overrides best-effort client ID discovery from current frontend bundles; discovery results are cached per Worker isolate and may expire.

These private interfaces can change without notice. A configured provider is not necessarily reachable, and a returned metadata object does not guarantee that an audio stream is playable.

## Verify

```sh
npm run check
npm test
```

Tests exercise Hono routing, error handling, API-key enforcement, generic routes, and Tidal compatibility dispatch. They do not prove that live upstream services accept a particular credential or route.
