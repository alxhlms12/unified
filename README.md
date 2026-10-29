# Unified Music REST API

A Cloudflare Workers REST API foundation for Tidal, Deezer, Qobuz, YouTube Music, and SoundCloud. Provider adapters are isolated so a missing credential or a broken upstream does not stop the other providers from responding.

## Status: foundation, not yet full feature parity

The project includes the REST router, configuration handling, provider status, OpenAPI, aggregated search, ISRC matching, normalized metadata, a SoundCloud frontend client-ID discovery routine, GraphQL-based Deezer calls, and compatibility routes matching the documented `binimum/hifi-api` route shapes.

**It has not been live-tested against all five services.** Internal endpoints change and all provider requests require valid account/configuration values. Some playback functionality is intentionally surfaced as unsupported when it would require decrypting protected media or forwarding DRM-license requests. Tidal catalog/playback-info endpoints are mapped; Deezer exposes track/media entitlement metadata rather than decrypting media; Qobuz's legacy `track/getFileUrl` route has been reported deprecated; YouTube Music only returns direct formats when the internal player response provides a URL without an encrypted signature; SoundCloud uses its public frontend bundles for best-effort `client_id` discovery and its API-v2 transcodings.

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

For a shared/public instance, set an API key before deployment:

```sh
npx wrangler secret put UNIFIED_API_KEY
```

Client requests then send `X-API-Key: your-key` or `Authorization: Bearer your-key`. The API key is optional for local development and required by convention for any publicly exposed instance.

## Provider bindings

Cloudflare Worker binding names below intentionally preserve the requested names, including hyphens. In JavaScript, read them with bracket notation (`env["t-cid"]`).

| Variable | Meaning | Required? |
|---|---|---:|
| `t-cid` | Tidal client ID | Yes |
| `t-cs` | Tidal client secret | Yes |
| `t-rt` | Tidal refresh token | Yes |
| `t-cc` | Tidal country code | Yes |
| `d-arl` | Deezer ARL session cookie | Yes |
| `q-cid` | Qobuz app/client ID | Yes |
| `q-cs` | Qobuz app secret | Yes |
| `q-uat` | Qobuz user auth token | Yes |
| `ytm-api-key` | YouTube Music Innertube API key override | Optional; frontend discovery is attempted by default |
| `ytm-cookie` | Optional YouTube Music browser cookie | Optional |
| `ytm-visitor-data` | Optional Innertube visitor data | Optional |
| `ytm-client-version` | Optional Innertube client version override | Optional |
| `sc-cid` | SoundCloud client ID override | Optional; frontend discovery is attempted by default |
| `UNIFIED_API_KEY` | Protects non-public endpoints | Recommended for deployed instances |

Use `npx wrangler secret put NAME` for real credentials in deployed Worker instances. For local development, use `.dev.vars` and never commit it.

## Main unified REST routes

| Route | What it does |
|---|---|
| `GET /v1/health` | Instance health and version |
| `GET /v1/providers` | Configuration status and adapter capabilities; never returns credentials |
| `GET /v1/search?q=...&type=track` | Searches all configured providers by default |
| `GET /v1/search?q=...&provider=tidal` | Searches one provider |
| `GET /v1/match?isrc=...` | Searches catalogs for a recording identifier |
| `GET /v1/tracks/{provider}:track:{id}` | Track metadata |
| `GET /v1/tracks/{provider}:track:{id}/stream` | Provider-supported stream/manifest resolution |
| `GET /v1/tracks/{provider}:track:{id}/lyrics` | Lyrics where supported |
| `GET /v1/albums/{provider}:album:{id}` | Album metadata |
| `GET /v1/artists/{provider}:artist:{id}` | Artist metadata |
| `GET /v1/playlists/{provider}:playlist:{id}` | Playlist metadata |
| `GET /v1/resolve?url=...` | Recognizes supported provider URLs |
| `GET /openapi.json` | OpenAPI 3.1 document |

Provider IDs are explicit, for example `tidal:track:123`, `deezer:track:456`, `qobuz:track:789`, `youtube-music:track:abc`, or `soundcloud:track:012`. URL-encode IDs if a client library needs it.

## Tidal `hifi-api` compatibility routes

This Worker includes route shapes from the documented `binimum/hifi-api` baseline:

- `/info/?id=...`
- `/track/?id=...&quality=HI_RES_LOSSLESS`
- `/trackManifests/?id=...&formats=FLAC&formats=FLAC_HIRES`
- `/search/?s=...`, `/search/?a=...`, `/search/?al=...`, `/search/?v=...`, `/search/?p=...`, or `/search/?i=ISRC`
- `/album/?id=...&limit=100&offset=0`
- `/artist/?id=...` or `/artist/?f=...&skip_tracks=true`
- `/playlist/?id=...&limit=100&offset=0`
- `/mix/?id=...`
- `/recommendations/?id=...`
- `/artist/similar/?id=...&cursor=...`
- `/album/similar/?id=...&cursor=...`
- `/cover/?id=...` or `/cover/?q=...`
- `/lyrics/?id=...`
- `/topvideos/?countryCode=US&limit=25&offset=0`
- `/video/?id=...&quality=HIGH`

`GET`/`POST /widevine` is deliberately disabled. Unified does not proxy DRM-license requests, decrypt DRM-protected media, or alter provider license URLs.

## Provider notes

- **Tidal:** refreshes access tokens server-side and maps the documented compatibility route shapes. Stream endpoint responses are returned as upstream playback metadata.
- **Deezer:** uses the Pipe GraphQL route (`pipe.deezer.com/api`) and ARL-to-JWT exchange pattern documented by independent clients. Protected media is not decrypted; the stream route returns entitlement/media metadata without inventing a playable URL.
- **Qobuz:** catalog endpoints use the qobuz.com JSON API paths as a reference. The legacy file-URL endpoint may return HTTP 410; the adapter reports that distinctly. Current web-player encrypted CMAF playback is not implemented here.
- **YouTube Music:** uses the internal Innertube search/player/browse routes. API key discovery is attempted from the public frontend when `ytm-api-key` is absent. It does not decipher encrypted signature URLs.
- **SoundCloud:** uses `api-v2.soundcloud.com`; `sc-cid` overrides best-effort discovery from current frontend JS bundles. Discovered IDs are cached per Worker isolate and may expire.

## Verify the local project

```sh
npm run check
npm test
```

The tests use mocked Worker requests for routing/configuration behavior. They do not prove the live upstream services will accept a particular credential or route.
