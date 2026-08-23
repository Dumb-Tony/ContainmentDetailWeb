/* Offline capability — GDD §23 Milestone 5, the honest browser equivalent of "platform
 * features". There is no Steam here. What a browser gives a game that a web page does not
 * is that it INSTALLS and it RUNS WITH NO NETWORK, and both are true of this build for a
 * real reason: solo play reaches no host at all. `assets/lib/NOTICE.md` records the single
 * exception — a signalling broker, contacted only when somebody hosts or joins — and
 * `tools/m0-tests.js` K6 enforces it. A solo operation is therefore genuinely offlineable,
 * and until this file existed it was not offline-capable, because nothing was cached.
 *
 * ══ THE CONSTRAINT THAT OUTRANKS THE FEATURE ═══════════════════════════════════════════
 *
 * ⚠ THIS REPO IS PUSH-IS-THE-DEPLOY, AND A CACHE-FIRST WORKER WOULD SILENTLY END THAT.
 *
 * `tools/verify-live.ps1` proves, by git blob hash, exactly which commit the live URL is
 * serving, and nothing is reported as done until it matches. A cache-first service worker
 * defeats that verification completely while leaving every green light on: the URL *is*
 * serving the new bytes, `verify-live.ps1` *is* telling the truth, and the returning player
 * never sees any of it because their browser never asks. They keep yesterday's build for
 * ever, there is no symptom, and the deploy pipeline reports success. That is the worst
 * thing that could be shipped into this repo, and it is the default shape of every service
 * worker tutorial: `caches.match(e.request).then(r => r || fetch(e.request))`.
 *
 * So the rule here is inverted and absolute:
 *
 *     THE NETWORK IS THE SOURCE OF TRUTH. THE CACHE IS THE FALLBACK.
 *
 * Every GET this worker handles goes to the network first. If the network answers at all —
 * 200, 304, even 404 — those bytes go to the page unchanged and the cache is not consulted.
 * The cache is read in exactly two situations: `fetch()` rejected (there is no network), or
 * the origin answered 5xx (there is a network and it is serving nothing). Neither of those
 * is a case where a fresher build exists and the player is being denied it.
 *
 * The consequence worth stating plainly: this worker CANNOT make a page staler than it
 * would have been with no worker at all, because in every case where a no-worker page would
 * have got fresh bytes, this one fetches them too. What it adds is a floor, not a ceiling.
 * Speed comes from the browser's own HTTP cache underneath us — Pages sends max-age=600 and
 * that still applies to `fetch()` — which is exactly the freshness policy the deploy already
 * assumes. We do not second-guess it, in either direction.
 *
 * ══ HOW A CACHED BUILD IS REPLACED ═════════════════════════════════════════════════════
 *
 * The version signal is `<meta name="cd-build" content="<sha> <iso-date>">`, written by
 * `tools/stamp-build.ps1` and read by `src/core/crash.js` `buildId()`. This file reads the
 * same tag out of the HTML it just fetched from the network, so learning the current build
 * costs no extra request.
 *
 * A build's files live in one cache named `cd-build-<id>`. Files from two builds are never
 * mixed, so there is no way to assemble a Frankenstein of yesterday's `game.js` and today's
 * `content/`. The pass that fills a cache is all-or-nothing: every URL, or the cache is left
 * without its completion sentinel and is never read from. Only when the sentinel is written
 * does the new cache become the one the fallback uses, and only then is the old one deleted.
 * At every instant there is either one complete coherent build cached or none.
 *
 * ⚠ THE BUILD VERSION IS DATA, NOT A NEW SERVICE WORKER. This is the design decision that
 * makes the update invisible. The usual arrangement bakes the version into the worker's own
 * source, so every deploy produces a byte-different `sw.js`, a waiting worker, and then the
 * whole miserable apparatus of "a new version is available, reload?" — a modal dialog, or
 * worse an automatic `location.reload()`, landing on somebody who is thirty seconds from
 * establishing custody. Here `sw.js` is unchanged by a deploy. A new build creates no
 * waiting worker, raises no prompt, and reloads nothing.
 *
 * ══ WHAT A PLAYER MID-OPERATION EXPERIENCES ════════════════════════════════════════════
 *
 * Nothing. Their tab goes on running the code it already loaded, which is what happens
 * without a worker too. Anything it asks for later comes off the network, which is also what
 * happens without a worker. The precache pass runs in the background, one request at a time
 * so it cannot flood the link, and no fetch the page makes ever waits on it. There is no
 * dialog, no reload, and no `skipWaiting` racing a frame loop.
 *
 * ══ WHAT HAPPENS WHEN AN UPDATE FAILS ══════════════════════════════════════════════════
 *
 * The pass throws, the incomplete cache keeps whatever it got (so the next attempt resumes
 * rather than restarting), the previous complete cache is untouched and still serves. The
 * player keeps a coherent older build for offline use and gets the current one from the
 * network whenever they are online. There is no state in which a player is stuck on an old
 * build with no way to reach the new one: being online IS the way, unconditionally.
 *
 * And if this file itself turns out to be the problem, `<meta name="cd-sw" content="off">`
 * in index.html retires the worker — it drops every cache and unregisters. That kill switch
 * is worth ten lines here because index.html is the one file every deploy touches, so
 * disarming a bad worker is a one-line commit rather than a support problem.
 *
 * ══ REGISTRATION ═══════════════════════════════════════════════════════════════════════
 *
 * One line, at the end of `boot()` in `src/main.js`, after `cd-ready` is dispatched:
 *
 *   if ('serviceWorker' in navigator) navigator.serviceWorker
 *     .register(new URL('../sw.js', import.meta.url).href, { updateViaCache: 'none' })
 *     .catch(() => {});
 *
 * Deliberately at the END of a boot that succeeded: a build that throws on the way up never
 * registers, so it never becomes anybody's offline copy. `updateViaCache: 'none'` keeps the
 * worker script itself out of the HTTP cache, so a fix to this file is never ten minutes
 * behind. The game works identically with the line absent — it simply has no offline floor.
 */

/* Bumped only when THIS FILE changes, which a deploy does not do. Present so the worker can
 * say which version of itself is talking in a console line or a message. */
const SW_REV = 'cd-sw-1';

const CACHE_PREFIX = 'cd-build-';

/* The scope root: this file sits beside index.html, so its own directory is the build.
 * Everything is resolved against it rather than against `/`, because the same bytes serve
 * from `http://localhost:8401/` in development and `/ContainmentDetailWeb/` on Pages — the
 * URL discipline `src/sim/content.js` and `src/core/i18n.js` already keep. */
const HERE = new URL('./', self.location.href).href;
const SCOPE_PATH = new URL(HERE).pathname;
const INDEX_URL = new URL('index.html', HERE).href;

/* Not a real file. Written LAST, so its presence is the proof that a cache holds a whole
 * build rather than however much of one a terminated worker managed. */
const SENTINEL_URL = new URL('__cd-complete', HERE).href;

/**
 * Everything a solo operation needs with no network, and nothing else.
 *
 * ⚠ A TYPO IN THIS LIST IS A SILENT LOSS OF THE WHOLE FEATURE. One 404 aborts the pass, no
 * cache is ever completed, and the symptom is that the player simply never becomes
 * offline-capable — no error, no banner, nothing to notice. So `tools/platform-tests.js`
 * asserts two separate things about it: that every URL here resolves 200, and that it is
 * COMPLETE — measured against every same-origin resource the booted page actually loaded,
 * plus every file the content loaders fetch when walked over all incidents and locales. A
 * content file added without a line here fails that suite by name.
 *
 * Left out on purpose: `docs/` (screenshots for the README, not assets), `tools/`, the
 * GAME_BIBLE, `README.md`, `assets/lib/NOTICE.md` and `content/provenance.json`. The last
 * two are licensing records — real, load-bearing for §25, and never fetched at runtime, so
 * caching them would only cost a player megabytes to hold text no code reads.
 */
const PRECACHE = [
  'index.html',
  'manifest.webmanifest',

  'assets/icons/icon-48.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',

  /* The two vendored libraries. PeerJS is here even though solo play never opens a
   * connection, because index.html loads it with a plain <script> tag before main.js: an
   * offline page that skipped it would boot with `Peer` undefined and differ from the online
   * one in a way nobody would find until somebody tried to host. Offline is supposed to mean
   * the same build, not a reduced one. */
  'assets/lib/r128/three.min.js',
  'assets/lib/peerjs-1.5.4/peerjs.min.js',

  'src/config.js',
  'src/game.js',
  'src/main.js',
  'src/audio/audio.js',
  'src/core/clock.js',
  'src/core/crash.js',
  'src/core/eventBus.js',
  'src/core/i18n.js',
  'src/core/input.js',
  'src/core/rng.js',
  'src/net/lobby.js',
  'src/net/net.js',
  'src/net/protocol.js',
  'src/render/renderer.js',
  'src/render/scene.js',
  'src/render/thermalFloor.js',
  'src/sim/anomaly.js',
  'src/sim/certification.js',
  'src/sim/comms.js',
  'src/sim/content.js',
  'src/sim/deployables.js',
  'src/sim/evidence.js',
  'src/sim/geometry.js',
  'src/sim/heat.js',
  'src/sim/instances.js',
  'src/sim/mission.js',
  'src/sim/perception.js',
  'src/sim/player.js',
  'src/sim/progression.js',
  'src/sim/senses.js',
  'src/sim/site.js',
  'src/sim/sound.js',
  'src/sim/telemetry.js',
  'src/sim/variation.js',
  'src/ui/base.js',
  'src/ui/commswheel.js',
  'src/ui/hud.js',
  'src/ui/lobby.js',
  'src/ui/panels.js',
  'src/ui/settings.js',

  /* All nine incidents, not the one the player last opened. The incident is chosen by URL
   * (`?incident=…`), and a player who goes offline having only ever opened the cold store
   * would find the other eight broken — which is a worse offline mode than none, because it
   * looks like the game is broken rather than like the network is. */
  'content/onboarding.json',
  'content/site.json',
  'content/equipment/items.json',
  'content/anomalies/blackthorn-caller.json',
  'content/anomalies/coldharbour-passenger.json',
  'content/anomalies/graybox-draught.json',
  'content/anomalies/harrowbank-ballast.json',
  'content/anomalies/netherfold-toll.json',
  'content/anomalies/ninety-one-tally.json',
  'content/anomalies/pinfold-lodger.json',
  'content/anomalies/stillwater-figure.json',
  'content/incidents/ashlar-flat-lodger.json',
  'content/incidents/ashlar-gallery-draught.json',
  'content/incidents/blackthorn-caller.json',
  'content/incidents/cold-storage-draught.json',
  'content/incidents/cold-storage-figure.json',
  'content/incidents/cold-storage-passenger.json',
  'content/incidents/cold-storage-tally.json',
  'content/incidents/cold-storage-toll.json',
  'content/incidents/harrowbank-ballast.json',
  'content/maps/ashlar-house-9.json',
  'content/maps/blackthorn-reserve.json',
  'content/maps/cold-storage-l2.json',
  'content/maps/harrowbank-switchyard.json',
  /* Both shipped locales. `pseudo` is generated from en-GB at runtime and is not a file. */
  'content/locales/en-GB.json',
  'content/locales/en-US.json',
];

/* ── the small facts ─────────────────────────────────────────────────────────────────── */

/** Did the origin answer? 404 counts — the network said "no such file", which is an answer
 *  and is not a reason to resurrect a copy of a file the deploy removed. 5xx does not: the
 *  origin is up and serving nothing, and a coherent cached build beats an error page. */
const usable = (res) => !!res && res.status >= 200 && res.status < 500;

/**
 * The build id out of a page's HTML, by the same rules as `src/core/crash.js` `buildId()`:
 * an unsubstituted template (`{{…}}`, `$Format:…`) is not an id, and neither is whitespace.
 * Returns null rather than a guess — a cache named after a build that does not exist would
 * never match anything and would be re-precached on every single navigation, for ever.
 */
function buildIdOf(html) {
  const m = /<meta\s+name=["']cd-build["']\s+content=["']([^"']*)["']/i.exec(html || '');
  const v = m && m[1] && m[1].trim();
  if (!v || /^\{\{|\$Format:/.test(v)) return null;
  return v.slice(0, 64);
}

/** Cache names are opaque strings, but a name you can read in devtools is worth the regex. */
const cacheNameFor = (id) => CACHE_PREFIX + id.replace(/[^A-Za-z0-9._-]+/g, '-');

/** The kill switch, read off the same HTML as the build id. */
const isRetired = (html) => /<meta\s+name=["']cd-sw["']\s+content=["']off["']/i.test(html || '');

/**
 * Only the build's own entry point drives the cache. Every other page under the scope is
 * still served network-first, it just does not get to say what "the build" is.
 *
 * That is a principle and not a special case, but it does have a useful consequence here:
 * `tools/smoketest.ps1` and `tools/shot.ps1` serve `_smoketest-<port>.html` and `_shot.html`
 * out of this same root, and those are copies of index.html with a suite spliced in. They
 * carry the cd-build meta and would otherwise each kick off a full 2 MB precache in the
 * middle of a timed headless run.
 */
function isEntryPoint(url) {
  const p = url.pathname;
  return p === SCOPE_PATH || p === `${SCOPE_PATH}index.html`;
}

/* ── which cache, if any, holds a whole build ────────────────────────────────────────── */

let _active;          // undefined = not yet derived, null = there isn't one
const _failed = new Set();

async function activeCacheName() {
  if (_active !== undefined) return _active;
  _active = null;
  for (const name of await caches.keys()) {
    if (!name.startsWith(CACHE_PREFIX)) continue;
    const c = await caches.open(name);
    /* No sentinel means a pass was interrupted or is still running. Half a build is not a
     * build, and serving one is how you produce a bug report nobody can reproduce. */
    if (await c.match(SENTINEL_URL)) { _active = name; break; }
  }
  return _active;
}

async function fromCache(href) {
  const name = await activeCacheName();
  if (!name) return null;
  const c = await caches.open(name);
  return (await c.match(href, { ignoreSearch: true })) || null;
}

/* ── serving ─────────────────────────────────────────────────────────────────────────── */

/**
 * @returns {{response: Response, html: (Promise<string>|null)}} `html` is a promise for the
 * page's own text when this was a fresh entry-point navigation, and null otherwise — so the
 * update pass reads the build id off the response the player is already getting rather than
 * spending a second request on it.
 */
async function serveNavigation(request, entry) {
  let res = null;
  try { res = await fetch(request); } catch { /* no network; the cache is why we are here */ }

  if (usable(res)) {
    /* ⚠ CLONE BEFORE THE PAGE READS IT. A body can be consumed once, and `respondWith` is
     * the consumer. Cloning after handing it over throws "Response body is already used"
     * and takes the navigation down with it. */
    const html = entry ? res.clone().text() : null;
    return { response: res, html };
  }

  const hit = await fromCache(INDEX_URL);
  if (hit) return { response: hit, html: null };
  if (res) return { response: res, html: null };
  return { response: offlinePage(), html: null };
}

async function serveAsset(request, url) {
  let res = null;
  try { res = await fetch(request); } catch { /* fall through */ }
  if (usable(res)) return res;

  /* `ignoreSearch` because the game asks for content with `cache: 'no-store'` and a probe or
   * a cache-buster may still put a query on the end. The bytes are keyed by path. */
  const hit = await fromCache(url.href);
  if (hit) return hit;

  if (res) return res;
  /* ⚠ NOT a synthesised 503. With no worker a dead network rejects the page's `fetch()` with
   * a TypeError, and `src/sim/content.js` REFUSES loudly on that path. Handing back a
   * plausible-looking error Response instead would route the same failure through the
   * "HTTP 503" branch and change the message a player is shown for reasons that have nothing
   * to do with them. A worker that cannot help should look exactly like no worker. */
  return Response.error();
}

/** Shown only when there is no network AND nothing cached — a first visit that lost the
 *  link. Palette from index.html's `:root`, so it does not look like a browser error. */
function offlinePage() {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Containment Detail — no network</title>
<style>html,body{margin:0;height:100%;background:#05070a;color:#d7e2ea;
 font:15px/1.6 "Segoe UI",Inter,system-ui,sans-serif;display:flex;align-items:center;
 justify-content:center}div{max-width:30rem;padding:1.5rem;border-left:3px solid #e5a13a}
 h1{font-size:1.1rem;letter-spacing:.06em;text-transform:uppercase;color:#e5a13a;margin:0 0 .6rem}
 p{color:#8b9aa8;margin:0}</style></head><body><div>
<h1>No network, and no build held</h1>
<p>This browser has not finished storing a copy of Containment Detail, so there is nothing
to run offline yet. Reconnect once and it will keep one from then on.</p>
</div></body></html>`;
  return new Response(body, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* ── keeping the cache up to date ────────────────────────────────────────────────────── */

async function reconcile(htmlPromise) {
  const html = await htmlPromise;
  if (isRetired(html)) return retire();

  const id = buildIdOf(html);
  if (!id) return announce({ state: 'unstamped' });

  const name = cacheNameFor(id);
  if (await activeCacheName() === name) return;   // this exact build is already held
  if (_failed.has(name)) return;                  // already tried and failed this lifetime

  try {
    await precache(name, id);
  } catch (e) {
    /* ⚠ THE OLD CACHE IS NOT TOUCHED. Whatever went wrong, the player still has a complete
     * coherent build for offline use and the live one from the network while they are on
     * it. The partial cache is left in place on purpose so the next attempt resumes. */
    _failed.add(name);
    announce({ state: 'failed', build: id, why: (e && e.message) || String(e) });
  }
}

async function precache(name, id) {
  const cache = await caches.open(name);
  let fetched = 0; let held = 0; let bytes = 0;

  /* ⚠ ONE AT A TIME, not `Promise.all`. `cache.addAll` would be shorter and would open
   * sixty-eight parallel connections against whatever link the player is on, in the middle
   * of an operation whose netcode is sharing it. Sequential is slower and is the only
   * version that cannot be felt. It runs inside a fetch event's `waitUntil`, so the worker
   * is kept alive for it without any response waiting on it. */
  for (const path of PRECACHE) {
    const href = new URL(path, HERE).href;
    if (await cache.match(href)) { held++; continue; }   // resume, do not restart

    let res;
    try {
      res = await fetch(new Request(href, { cache: 'reload', credentials: 'same-origin' }));
    } catch (e) {
      throw new Error(`${path}: no network (${(e && e.message) || e})`);
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);

    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > 0) bytes += len;
    /* Keyed by the URL string rather than by the Request, so the `cache: 'reload'` mode used
     * to bypass the HTTP cache on the way out is not carried into the cache key. */
    await cache.put(href, res);
    fetched++;
  }

  /* Last, and only now is this cache allowed to answer anything. */
  await cache.put(SENTINEL_URL, new Response(id, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  }));
  _active = name;

  for (const k of await caches.keys()) {
    if (k.startsWith(CACHE_PREFIX) && k !== name) await caches.delete(k);
  }
  announce({ state: 'ready', build: id, files: PRECACHE.length, fetched, held, bytes });
}

/** The kill switch. Drops everything and gets out of the way; the page keeps running. */
async function retire() {
  for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX)) await caches.delete(k);
  _active = null;
  announce({ state: 'retired' });
  if (self.registration && self.registration.unregister) await self.registration.unregister();
}

/** Say it to any page listening, and to the console for the case where none is. */
async function announce(detail) {
  const msg = { source: 'cd-sw', rev: SW_REV, ...detail };
  try { console.info('[cd-sw]', JSON.stringify(detail)); } catch { /* no console */ }
  try {
    const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for (const c of all) c.postMessage(msg);
  } catch { /* no clients */ }
}

/* ── wiring ──────────────────────────────────────────────────────────────────────────── */

/* Handlers are kept as well as installed so `tools/platform-tests.js` can drive the real
 * routing — "a cross-origin request is never intercepted" is a claim about this function,
 * not about a helper it might have called. */
const handlers = Object.create(null);
const on = (type, fn) => { handlers[type] = fn; self.addEventListener(type, fn); };

on('install', () => {
  /**
   * ⚠ NOTHING IS PRECACHED HERE, ON PURPOSE. The tutorial shape is
   * `e.waitUntil(caches.open(V).then(c => c.addAll(FILES)))`, and it has two failures this
   * build cannot afford. A single 404 in the list REJECTS THE INSTALL, so the worker never
   * activates and the player silently never gets any of it. And the install would be
   * competing for bandwidth with the very page load that triggered it.
   *
   * `skipWaiting` is safe here for the reason the whole file is built around: this worker
   * has no opinion about what bytes an online page receives, so taking over a live page
   * cannot change what that page gets. In a cache-first worker the same call is how you
   * swap the build under somebody's feet.
   */
  self.skipWaiting();
});

on('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    _active = undefined;
    await activeCacheName();
  })());
});

on('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;      // not ours; let it go straight out

  let url;
  try { url = new URL(request.url); } catch { return; }

  /* ⚠ THE SIGNALLING BROKER IS NEVER TOUCHED. §25 and `assets/lib/NOTICE.md` say this build
   * reaches exactly one external host, only when somebody hosts or joins. A worker that
   * intercepted cross-origin requests would be a second place that claim has to be true,
   * and one of them would eventually stop being. */
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE_PATH)) return;

  if (request.mode === 'navigate' || request.destination === 'document') {
    const entry = isEntryPoint(url);
    const job = serveNavigation(request, entry);
    event.respondWith(job.then((r) => r.response));
    if (entry) {
      /* `waitUntil`, not awaited by `respondWith`: the page is served at network speed and
       * the update happens behind it. */
      event.waitUntil(job.then((r) => (r.html ? reconcile(r.html) : undefined)).catch(() => {}));
    }
    return;
  }

  event.respondWith(serveAsset(request, url));
});

on('message', (event) => {
  const d = event.data;
  if (!d || d.source !== 'cd-page') return;
  /* Optional. A tab left open for days never navigates, so its offline copy would sit at
   * whatever build it started on. A page that wants to can ask for a re-check; nothing in
   * the build does today, and nothing has to. */
  if (d.type === 'check') {
    event.waitUntil((async () => {
      try {
        const res = await fetch(new Request(INDEX_URL, { cache: 'no-store' }));
        if (res.ok) await reconcile(res.text());
      } catch { /* offline: nothing to reconcile against */ }
    })());
  }
  if (d.type === 'retire') event.waitUntil(retire());
});

/* The test handle. `tools/platform-tests.js` evaluates this file with a fake `self` and the
 * real Cache API, so every claim in the header above is asserted against this code and not
 * against a re-implementation of it. */
self.__cdSw = {
  SW_REV, CACHE_PREFIX, PRECACHE, HERE, SCOPE_PATH, INDEX_URL, SENTINEL_URL,
  handlers, usable, buildIdOf, cacheNameFor, isRetired, isEntryPoint,
  activeCacheName, fromCache, serveNavigation, serveAsset, offlinePage,
  reconcile, precache, retire,
  reset() { _active = undefined; _failed.clear(); },
};
