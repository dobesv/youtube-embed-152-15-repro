// Reproduces intermittent "Error code: 152 - 15" from the YouTube Embedded
// Player for an embed whose token was minted for the same video.
//
// Each run opens a fresh browser profile, loads a page that creates a player
// through the documented IFrame Player API with a freshly minted token, calls
// playVideo(), and records what the player did. Failing profiles are then
// retried with a new token, and again after clearing YouTube's cookies.
//
//   YT_EMBED_API_KEY=... node repro.mjs
//
// Optional: VIDEO_ID (default 3vijLre760w), RUNS (default 30),
// Required: ORIGIN, an origin registered for the API key; the page is served
// from it by Playwright, so no server is needed.
// EMBED_HOST (default https://www.youtubeeducation.com), NO_TOKEN=1 (control:
// create the player without embedConfig).
import { mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { getPublicIp, mintToken } from './mintToken.mjs';

const apiKey = process.env.YT_EMBED_API_KEY;
if (!apiKey) {
  console.error('Set YT_EMBED_API_KEY to an API key enabled for the Embedded Player.');
  process.exit(1);
}
const videoId = process.env.VIDEO_ID ?? '3vijLre760w';
const runs = Number(process.env.RUNS ?? 30);
const origin = process.env.ORIGIN;
if (!origin) {
  console.error('Set ORIGIN to an origin registered for the API key, e.g. https://app.example.com');
  process.exit(1);
}
const embedHost = process.env.EMBED_HOST ?? 'https://www.youtubeeducation.com';
const pageUrl = `${origin}/yt-152-15-repro.html`;
const ip = process.env.CLIENT_IP ?? (await getPublicIp());

const pageHtml = token => `<!doctype html>
<html><head><meta charset="utf-8"><title>152-15 repro</title></head><body>
<div id="player"></div>
<script>
  window.events = [];
  const log = e => window.events.push({ t: Math.round(performance.now()), ...e });
  window.onYouTubeIframeAPIReady = () => {
    window.player = new YT.Player(document.getElementById('player'), {
      videoId: ${JSON.stringify(videoId)},
      width: '100%',
      height: 315,
      host: ${JSON.stringify(embedHost)},
      ${token ? `embedConfig: { enc: ${JSON.stringify(token)} },` : ''}
      playerVars: { controls: 0, disablekb: 1, rel: 0, autoplay: 0 },
      events: {
        onReady: () => log({ ev: 'ready' }),
        onError: e => log({ ev: 'error', code: e.data }),
        onStateChange: e => log({ ev: 'state', state: e.data }),
      },
    });
  };
</script>
<script src="${embedHost}/iframe_api"></script>
</body></html>`;

// The error screen's subreason ("Error code: 152 - 15"). Its shape differs
// between hosts, so fall back to searching the whole status for the code.
const subreasonOf = status => {
  const renderer = status?.errorScreen?.playerErrorMessageRenderer;
  const text =
    renderer?.subreason?.runs?.map(r => r.text).join('') ?? renderer?.subreason?.simpleText ?? null;
  if (text) return text;
  const match = JSON.stringify(status ?? {}).match(/Error code: \d+ - \d+/);
  return match?.[0] ?? null;
};

const redact = text =>
  text
    .replace(/(embed_config=)[^&"\\]+/g, '$1<redacted>')
    .replace(/("enc\\?"\s*:\s*\\?")[^"\\]+/g, '$1<redacted>')
    .replace(/("embeddedPlayerEncryptedContext"\s*:\s*")[^"]+/g, '$1<redacted>');

const isInnertube = url => {
  const u = new URL(url);
  return /(^|\.)youtube(education)?\.com$/.test(u.hostname) && u.pathname.startsWith('/youtubei/v1/');
};

const bodyText = request => {
  const buf = request.postDataBuffer();
  if (!buf) return '';
  return buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
};

const pollEvents = async (page, done, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await page.evaluate(() => window.events ?? []);
    if (done(events) || Date.now() > deadline) return events;
    await page.waitForTimeout(250);
  }
};

async function loadAndPlay(context, label) {
  const token = process.env.NO_TOKEN === '1' ? null : await mintToken({ apiKey, videoId, ip });
  const page = await context.newPage();
  const calls = [];
  page.on('request', request => {
    if (!isInnertube(request.url()) || request.url().includes('log_event')) return;
    const text = bodyText(request);
    calls.push({
      path: new URL(request.url()).pathname,
      requestHasSignedEmbedConfig: text.includes('serializedThirdPartyEmbedConfig'),
    });
  });
  page.on('response', async response => {
    if (!isInnertube(response.url()) || response.url().includes('log_event')) return;
    const path = new URL(response.url()).pathname;
    const call = calls.find(c => c.path === path && !('http' in c));
    if (!call) return;
    call.http = response.status();
    try {
      const json = await response.json();
      const params = json?.responseContext?.serviceTrackingParams?.flatMap(s => s.params) ?? [];
      call.responseId = json?.responseContext?.responseId ?? null;
      call.requestIds = Object.fromEntries(
        params.filter(p => /_rid$/.test(p.key)).map(p => [p.key, p.value]),
      );
      if (path.endsWith('/navigation/resolve_url')) {
        const prefetched = json?.endpoint?.watchEndpoint?.unserializedPrefetchData?.playerResponse;
        call.prefetchedPlayerResponse = prefetched
          ? {
              status: prefetched.playabilityStatus?.status,
              subreason: subreasonOf(prefetched.playabilityStatus),
              reason: prefetched.playabilityStatus?.reason ?? null,
              errorCode: prefetched.playabilityStatus?.errorCode ?? null,
            }
          : null;
        call.resolvedVideoId = json?.endpoint?.watchEndpoint?.videoId ?? null;
      }
      if (path.endsWith('/player')) {
        call.playability = { status: json?.playabilityStatus?.status, subreason: subreasonOf(json?.playabilityStatus) };
      }
    } catch {
      // Not JSON; the status code is enough.
    }
  });
  await page.route(pageUrl, route => route.fulfill({ contentType: 'text/html', body: pageHtml(token) }));

  const startedAt = new Date().toISOString();
  await page.goto(pageUrl);
  let events = await pollEvents(page, evs => evs.some(e => e.ev === 'ready' || e.ev === 'error'), 20_000);
  if (events.some(e => e.ev === 'ready') && !events.some(e => e.ev === 'error')) {
    await page.evaluate(() => {
      window.player.mute();
      window.player.playVideo();
    });
    events = await pollEvents(
      page,
      evs => evs.some(e => e.ev === 'error' || (e.ev === 'state' && e.state === 1)),
      15_000,
    );
  }

  const frame = page.frames().find(f => f.url().includes('/embed/'));
  const shownError = frame
    ? await frame
        .evaluate(() => document.querySelector('.ytp-error-content-wrap-subreason')?.innerText?.trim() || null)
        .catch(() => null)
    : null;
  const embedPreview = frame
    ? await frame
        .evaluate(() => {
          try {
            const epr = window.ytcfg?.get?.('PLAYER_VARS')?.embedded_player_response;
            return epr ? JSON.parse(epr).previewPlayabilityStatus?.status ?? null : null;
          } catch {
            return null;
          }
        })
        .catch(() => null)
    : null;
  const visitor = (await context.cookies()).find(c => c.name === 'VISITOR_INFO1_LIVE' && /youtube/.test(c.domain));
  await page.close();

  const errorCodes = events.filter(e => e.ev === 'error').map(e => e.code);
  return {
    label,
    startedAt,
    outcome: errorCodes.length ? 'error' : events.some(e => e.ev === 'state' && e.state === 1) ? 'played' : 'neither',
    errorCodes,
    shownError,
    embedPreview,
    visitorInfo1Live: visitor?.value ?? null,
    calls: JSON.parse(redact(JSON.stringify(calls))),
  };
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const results = [];
try {
  for (let i = 0; i < runs; i++) {
    const context = await browser.newContext();
    const first = await loadAndPlay(context, 'fresh profile');
    const entry = { run: i, first };
    if (first.outcome === 'error') {
      entry.sameProfileNewToken = await loadAndPlay(context, 'same profile, new token');
      await context.clearCookies();
      entry.afterClearingCookies = await loadAndPlay(context, 'cookies cleared, new token');
    }
    await context.close();
    results.push(entry);
    const resolve = first.calls.find(c => c.path.endsWith('/navigation/resolve_url'));
    process.stdout.write(
      `run ${String(i).padStart(2)}: ${first.outcome.padEnd(6)} ${first.shownError ?? ''}` +
        `${resolve ? ` [resolve_url prefetch: ${resolve.prefetchedPlayerResponse ? `${resolve.prefetchedPlayerResponse.status} ${resolve.prefetchedPlayerResponse.subreason ?? ''}` : 'none'}]` : ' [no resolve_url]'}` +
        `${entry.sameProfileNewToken ? ` | same profile: ${entry.sameProfileNewToken.outcome} | cookies cleared: ${entry.afterClearingCookies.outcome}` : ''}\n`,
    );
  }
} finally {
  await browser.close();
}

const failed = results.filter(r => r.first.outcome === 'error');
const withPrefetch = results.filter(r =>
  r.first.calls.some(c => c.path.endsWith('/navigation/resolve_url') && c.prefetchedPlayerResponse),
);
console.log(`\n${failed.length} of ${results.length} fresh profiles failed (${videoId}, embed host ${embedHost}).`);
console.log(`${withPrefetch.length} first loads got a prefetched player response from resolve_url;`);
console.log(`  of those, ${withPrefetch.filter(r => r.first.outcome === 'error').length} failed.`);
console.log(
  `Failing profiles that failed again with a new token: ${failed.filter(r => r.sameProfileNewToken?.outcome === 'error').length} of ${failed.length}.`,
);
console.log(
  `Failing profiles that played after clearing cookies: ${failed.filter(r => r.afterClearingCookies?.outcome === 'played').length} of ${failed.length}.`,
);

mkdirSync('results', { recursive: true });
const file = `results/run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ videoId, embedHost, origin, runs, results }, null, 2));
console.log(`Details (tokens redacted): ${file}`);
