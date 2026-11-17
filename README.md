# YouTube Embedded Player: intermittent "Error code: 152 - 15"

This repo reproduces an intermittent playback failure in the YouTube Embedded
Player (Player for Learning, `www.youtubeeducation.com`). An embed created with
the IFrame Player API and a valid `embedConfig.enc` token, minted for the same
video, sometimes shows **"This video is unavailable. Error code: 152 - 15"**
when `playVideo()` is called.

We started seeing this in production in late October 2026, on an origin that
YouTube requires to send the signed token with every embed.

## What happens

The embed page always loads fine. `embedded_player_response.previewPlayabilityStatus`
is `OK`, and the player fires `onReady`. The failure happens when
`playVideo()` is called:

1. The player sometimes calls `POST /youtubei/v1/navigation/resolve_url` for
   `https://www.youtube.com/embed/<videoId>` before playing. That request does
   **not** carry `serializedThirdPartyEmbedConfig` (the signed `enc` token).
2. Most of the time `resolve_url` returns only a `watchEndpoint`. The player then
   calls `POST /youtubei/v1/player` **with** `serializedThirdPartyEmbedConfig`,
   gets `playabilityStatus.status: OK`, and plays.
3. Sometimes `resolve_url` also returns
   `endpoint.watchEndpoint.unserializedPrefetchData.playerResponse`, and that
   prefetched player response is already
   `playabilityStatus: { status: "ERROR", errorScreen: … "Error code: 152 - 15" }`.
   The player shows that error and never calls `/player`.

On the `www.youtubeeducation.com` host, across the three runs where we recorded
the `resolve_url` responses (70 fresh profiles), the prefetch decided the
outcome:

| `resolve_url` on the first load | Played | 152 - 15 |
|---|---|---|
| returned a prefetched player response | 0 | 6 |
| returned no prefetched player response | 28 | 0 |
| wasn't called | 36 | 0 |

The `www.youtube.com` host behaves the same way: every failure (9 of 50
profiles) was a prefetched `resolve_url` response with
`PLAYABILITY_ERROR_CODE_EMBEDDER_IDENTITY_DENIED`, "Error code: 152 - 15".

Our understanding is that 152 - 15 means the video being played doesn't
match the video ID in the encrypted token. Here they match: the token is minted
for the same video the embed requests, and `resolve_url` resolves to that same
video ID. Our guess is that the prefetch runs the content-binding check without
the signed embed config, which the request doesn't include.

The failure sticks to the browser profile. A failing profile failed again with a
newly minted token every time (13 of 13 across both hosts). Clearing YouTube's
cookies fixed it in 11 of 13 cases, which points at something keyed to the
visitor (`VISITOR_INFO1_LIVE` / `__Secure-YNID`), such as an experiment
assignment.

## Observed rates (2026-11-16, video `3vijLre760w`)

| Embed host | Fresh profiles | Failed with 152 - 15 | Prefetched response in `resolve_url` |
|---|---|---|---|
| `www.youtubeeducation.com` | 100 (four runs) | 9 | 9, all failed |
| `www.youtube.com` | 50 (two runs) | 9 | 9, all failed |

The origin we tested requires the signed token on both hosts, so the bug
affects both.

## The page runs as the registered origin

Playwright serves the test page itself, but the browser loads it from
`$ORIGIN/yt-152-15-repro.html`, so the embed sees the real origin. The
`resolve_url` request carries `embeddedPlayerContext.ancestorOrigins: ["$ORIGIN"]`,
and the iframe's `origin` parameter and Referer are `$ORIGIN`. Controls with
`NO_TOKEN=1` show YouTube applies the origin's rules:

| Origin | Host | Token | Result (4 profiles each) |
|---|---|---|---|
| our registered origin | `www.youtubeeducation.com` | none | 152 - 19 every time |
| our registered origin | `www.youtube.com` | none | error every time |
| `https://www.example.com` | `www.youtubeeducation.com` | none | 152 - 2 every time |

The other subcodes we've seen, from direct requests to `/embed/<videoId>`, for
comparison: 152 - 5 (token `ts` in the future), 152 - 7 (malformed token),
152 - 13 (private IP in the token), 152 - 19 (no token).

## Running it

Needs Node 20+ and an API key enabled for the Embedded Player.

```sh
npm install
npx playwright install chromium   # once, if Playwright has no Chromium yet
YT_EMBED_API_KEY=<key> ORIGIN=https://<origin registered for the key> node repro.mjs
```

Optional environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `VIDEO_ID` | `3vijLre760w` | Video to embed |
| `RUNS` | `30` | Number of fresh browser profiles |
| `ORIGIN` | (required) | Origin of the page hosting the embed, one registered for the API key (served locally by Playwright) |
| `EMBED_HOST` | `https://www.youtubeeducation.com` | Player host passed to `YT.Player` |
| `CLIENT_IP` | your public IP | IP written into the token |

Each run opens a fresh browser profile, mints a token, loads a page that creates
the player with the IFrame API, mutes it, and calls `playVideo()`. If that
fails, it tries again in the same profile with a new token, then again after
clearing cookies. It prints one line per run and writes the details to
`results/run-<timestamp>.json`: InnerTube calls, whether each request carried
`serializedThirdPartyEmbedConfig`, `ResolveUrl_rid` / `GetPlayer_rid` and
`responseId` values, the shown error, and the profile's `VISITOR_INFO1_LIVE`
cookie. Tokens are redacted.

`mintToken.mjs` builds the token the way our server does. The payload
`{ apiKey, ts, ip, contentType: 1, contentIds: [videoId], pageType: 1, version: 2, contentFilter: 2 }`
is sealed with HPKE (X25519 / HKDF-SHA256 / AES-256-GCM) to the primary key of
`https://www.youtube.com/.well-known/embeds/encryption/rcat/youtube-public-keyset.tink.json`
and framed in Tink's wire format. `node mintToken.mjs <videoId>` prints one.

## Example failing load

From `results/run-2026-11-16T22-05-33-397Z.json` (first load in a fresh profile):

```json
{
  "path": "/youtubei/v1/navigation/resolve_url",
  "requestHasSignedEmbedConfig": false,
  "http": 200,
  "responseId": "IhMIxsTYy7-NmAMVz3RMCB1H8jFu",
  "requestIds": { "ResolveUrl_rid": "0xf1a260a7e2b34050" },
  "prefetchedPlayerResponse": { "status": "ERROR", "subreason": "Error code: 152 - 15" },
  "resolvedVideoId": "3vijLre760w"
}
```

A successful load in the same run, for comparison:

```json
{ "path": "/youtubei/v1/navigation/resolve_url", "requestHasSignedEmbedConfig": false,
  "requestIds": { "ResolveUrl_rid": "0x64d7811efe483eb1" }, "prefetchedPlayerResponse": null }
{ "path": "/youtubei/v1/player", "requestHasSignedEmbedConfig": true,
  "requestIds": { "GetPlayer_rid": "0x8e8e9d1221f22293" }, "playability": { "status": "OK" } }
```
