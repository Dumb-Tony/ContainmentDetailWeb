/* Milestone 5 — installability and offline play.
 *
 * There is no Steam here. What a browser gives a game that a plain web page does not is that
 * it INSTALLS and that it RUNS WITH NO NETWORK, and both are honestly true of this build:
 * solo play reaches no host at all, `assets/lib/NOTICE.md` records the one exception, and
 * `m0-tests.js` K6 enforces it. So there is a real offline mode to earn, and three files earn
 * it: `manifest.webmanifest`, `assets/icons/`, and `sw.js`.
 *
 * ⚠ WHAT THIS SUITE IS ACTUALLY FOR, AND WHY THE HAPPY PATH IS THE UNIMPORTANT HALF.
 *
 * This repo is push-is-the-deploy. `tools/verify-live.ps1` proves by git blob hash which
 * commit the live URL is serving, and nothing is reported as done until it matches. A
 * cache-first service worker — the default shape of every tutorial — defeats that
 * verification completely while leaving every green light on: the URL IS serving the new
 * bytes, verify-live IS telling the truth, and the returning player never sees any of it
 * because their browser never asks. They keep yesterday's build for ever, silently, and the
 * pipeline reports success.
 *
 * A suite that proves the cache works and does not prove it steps aside for a newer build has
 * therefore tested the safe half only. Section E is the one that matters: it puts a complete
 * build in the cache, changes what the network is serving, and asserts the player gets the
 * NEW one — for the page and for every subresource. Everything else here is scaffolding for
 * that assertion.
 *
 * ⚠ HOW `sw.js` IS EXERCISED. It is fetched as text and evaluated with `new Function`, with a
 * fake `self` (an install target has no window), a controllable `fetch` (a test has to decide
 * what the network is serving) and a controllable `caches`. The routing under test is
 * therefore the shipped `fetch` handler itself rather than a helper it happens to call, and
 * every claim in sw.js's header is asserted against that code and not against a
 * re-implementation of it. Nothing here registers a real worker: a registered worker would
 * outlive the assertion and start precaching 2 MB into a machine three other suites share.
 *
 * ⚠ AND THE CacheStorage IS A FAKE, WHICH IS NOT WHAT THIS SUITE WANTED. `window.caches` is
 * genuinely available here — http://localhost is a secure context — and the first version of
 * section E used it. It died four operations in, every time, with no output for E, F, G or H
 * and no error either. MEASURED with `performance.now()` inside the headless run, which
 * reports VIRTUAL time:
 *
 *     put 0 at 185ms · put 1 at 195ms · put 2 at 1008ms · put 3 at 9967ms · nothing after
 *
 * A CacheStorage round trip leaves the renderer with an empty task queue and no timer, so
 * Chrome's virtual clock jumps forward to find work — and the jumps grow by an order of
 * magnitude each time. The fifth would land past `--virtual-time-budget=90000`, at which
 * point Chrome dumps the DOM and exits mid-suite. Four operations is the entire ceiling, and
 * the strategy under test needs several hundred.
 *
 * So the cache under test is the Map below. What is lost is real, and section R says so: this
 * suite does not prove Chrome's quota behaviour, its eviction, or its Response round-tripping.
 * What is kept is the part that matters, which is every decision `sw.js` makes about WHICH
 * BUILD WINS — and none of those decisions is a claim about the storage layer.
 *
 * Run it with:
 *   powershell -ExecutionPolicy Bypass -File tools/smoketest.ps1 -Tests tools/platform-tests.js -Port 8451
 */

import { lines, counts, ok, eq, near, note, emit, run, heading, suite } from './harness.js';

import { loadContent, INCIDENTS } from '../src/sim/content.js';
import { loadSite } from '../src/sim/progression.js';
import { loadOnboarding } from '../src/sim/certification.js';
import { loadLocale, LOCALES, DEFAULT_LOCALE } from '../src/core/i18n.js';

/* Everything resolves against the repo root, the way `sw.js` itself does — the same bytes
 * serve from http://localhost:8401/ and from /ContainmentDetailWeb/ on Pages. */
const ROOT = new URL('../', import.meta.url).href;
const at = (p) => new URL(p, ROOT).href;
const pathOf = (u) => new URL(u, ROOT).pathname;

const grab = async (p) => {
  const r = await fetch(at(p), { cache: 'no-store' });
  return { ok: r.ok, status: r.status, res: r, text: r.ok ? await r.text() : '' };
};

/* ══ the sandbox ═══════════════════════════════════════════════════════════════════════ */

const SW_SRC = (await grab('sw.js')).text;

/** A programmable origin. `build` is the id its index.html will carry. */
function origin(build, opts = {}) {
  const state = {
    build,
    offline: !!opts.offline,
    missing: new Set(opts.missing || []),
    status: opts.status || {},          // path -> HTTP status to answer with
    extraHead: opts.extraHead || '',
    asked: [],
  };
  const impl = async (input) => {
    const href = typeof input === 'string' ? input : input.url;
    const u = new URL(href, ROOT);
    const path = u.pathname.replace(pathOf(''), '');
    state.asked.push(path);
    if (state.offline) throw new TypeError('Failed to fetch');
    if (state.status[path]) return new Response('', { status: state.status[path] });
    if (state.missing.has(path)) return new Response('not found', { status: 404 });
    const body = path === 'index.html' || path === ''
      ? indexFor(state.build, state.extraHead)
      : `/* ${path} :: ${state.build} */\n`;
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': String(body.length) },
    });
  };
  return { state, impl };
}

const indexFor = (id, extraHead = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="cd-build" content="${id}">${extraHead}
<title>Containment Detail</title></head><body>build ${id}</body></html>`;

/**
 * ⚠ E, F AND G RUN AGAINST A STAND-IN PRECACHE LIST, and that is a decision rather than a
 * shortcut. Sections C and D are where the real 73-file list is checked, one fetch at a time,
 * from both directions. What E onwards tests is the STRATEGY — which build wins, what a
 * failure costs, what is never touched — and none of that is a claim about the list.
 *
 * Driving six full passes of 73 files through the real Cache API costs more than the headless
 * run has: the first version of this suite was cut off part way through section E and
 * reported nothing at all for E, F, G and H. Six files exercise every branch — an entry
 * point, two modules, two content files, an icon — with site.json in the middle so the
 * failure and resume cases have somewhere to break.
 */
const STAND_IN = [
  'index.html',
  'src/main.js',
  'src/game.js',
  'content/site.json',
  'content/maps/cold-storage-l2.json',
  'assets/icons/icon-48.png',
];

/**
 * A CacheStorage that lives in a Map. Only the five calls `sw.js` makes are implemented, and
 * they are implemented the way the spec describes them rather than the way that would be
 * convenient: `put` CONSUMES the response body, `match` hands back a fresh Response every
 * time, `keys` is in insertion order, and `ignoreSearch` compares without the query.
 */
function makeCaches() {
  const store = new Map();
  const keyOf = (r) => (typeof r === 'string' ? r : r.url);
  const bare = (u) => u.split('?')[0];
  const view = (entries) => ({
    async match(req, opts = {}) {
      const want = opts.ignoreSearch ? bare(keyOf(req)) : keyOf(req);
      for (const [k, v] of entries) {
        if ((opts.ignoreSearch ? bare(k) : k) !== want) continue;
        return new Response(v.body, { status: v.status, headers: v.headers });
      }
      return undefined;
    },
    async put(req, res) {
      const body = await res.text();          // a real put consumes it too
      entries.set(keyOf(req), { body, status: res.status, headers: [...res.headers] });
    },
    async delete(req) { return entries.delete(keyOf(req)); },
    async keys() { return [...entries.keys()]; },
  });
  return {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      return view(store.get(name));
    },
    async keys() { return [...store.keys()]; },
    async has(name) { return store.has(name); },
    async delete(name) { return store.delete(name); },
  };
}

/* One store per section, so a section cannot inherit another's caches — the same isolation
 * `tools/run-tests.ps1` gives each suite, for the same reason. */
let CACHES = makeCaches();

/** Evaluate `sw.js` against a fake global scope and a chosen origin. */
function install(net, full = false) {
  const posted = [];
  const self0 = {
    location: { href: at('sw.js'), origin: location.origin },
    listeners: [],
    addEventListener(type, fn) { this.listeners.push(type); },
    skipWaiting() { self0.skipWaits++; },
    skipWaits: 0,
    claimed: false,
    unregistered: false,
    registration: { unregister: async () => { self0.unregistered = true; return true; } },
    clients: {
      claim: async () => { self0.claimed = true; },
      matchAll: async () => [{ postMessage: (m) => posted.push(m) }],
    },
  };
  const factory = new Function('self', 'caches', 'fetch', `${SW_SRC}\nreturn self.__cdSw;`);
  const api = factory(self0, CACHES, net.impl);
  if (!full) api.PRECACHE.splice(0, api.PRECACHE.length, ...STAND_IN);
  return { api, self: self0, posted, net };
}

/* A fetch event, near enough for the routing the handler actually reads. A real `Request`
 * with mode:'navigate' cannot be constructed from script, so navigations are plain objects —
 * every line of `sw.js` that touches one reads only .method, .url, .mode and .destination. */
function fetchEvent(request) {
  const e = {
    request,
    responded: null,
    waited: [],
    respondWith(p) { e.responded = p; },
    waitUntil(p) { e.waited.push(p); },
  };
  return e;
}
const navRequest = (href) => ({ method: 'GET', url: href, mode: 'navigate', destination: 'document' });

const buildCaches = async () => (await CACHES.keys()).filter((k) => k.startsWith('cd-build-'));
const wipe = async () => { CACHES = makeCaches(); };

/** One full "session": navigate to the entry point, then let the update pass finish. */
async function visit(rig) {
  const nav = await rig.api.serveNavigation(navRequest(at('index.html')), true);
  const body = await nav.response.clone().text();
  if (nav.html) await rig.api.reconcile(nav.html);
  return { nav, body };
}

const said = (rig, state) => rig.posted.filter((m) => m.state === state);

/* ══ R. one round trip through the browser's own CacheStorage ══════════════════════════ */

/**
 * ⚠ THIS SECTION USED TO DO A REAL CacheStorage ROUND TRIP, AND WAS REMOVED FOR BEING FLAKY.
 * Recording that here rather than deleting it, because the next person to look at the fake
 * CacheStorage above will have the same idea.
 *
 * Three real calls — open, put, match — cost 1053ms of virtual time on one run, 9968ms on the
 * next, and on the third they overran the whole 90000ms budget and the DOM was dumped before
 * the section could report. Chrome is searching for work to do, not obeying a schedule, and
 * a CacheStorage reply gives it nothing to find. Moving the section last limited the damage
 * to three assertions rather than a hundred and fifteen, but a suite whose total is 118 on
 * one run and 115 on the next is a suite nobody can read, and `tools/run-tests.ps1` prints
 * that total as the headline number for the whole repo.
 *
 * Measured out of band instead, in a throwaway suite: `caches.open`, `cache.put`,
 * `cache.match`, `caches.keys` and `caches.delete` all behave against the real API in this
 * browser exactly as the Map above does. That is a measurement and not an assertion, and it
 * is marked as one.
 *
 * What this section still asserts is the platform gate itself, which costs nothing: without
 * CacheStorage and a secure context there is no offline mode to have, and both are things a
 * change to the harness could quietly take away.
 */
async function sectionR() {
  heading('R. the platform gate offline capability is standing on');
  note(`virtual time at the end of the run: ${performance.now().toFixed(0)}ms of the harness's 90000ms budget`);

  ok('R1 CacheStorage exists — without it there is nothing for the worker to keep a build in',
    typeof caches === 'object' && !!caches);
  ok('R2 and the page is a secure context, which is what service worker registration is gated on',
    window.isSecureContext === true);
  ok('R3 and the browser has the registration API at all',
    'serviceWorker' in navigator);
  note('the CacheStorage the sandbox above uses is a Map, not this one — see the file header for the measurement that forced it');
  emit();
}

/* ══ A. the manifest ═══════════════════════════════════════════════════════════════════ */

async function sectionA() {
  heading('A. the manifest says what the game is, in the game\'s own colours');

  const got = await grab('manifest.webmanifest');
  ok('A1 manifest.webmanifest is served', got.ok, `HTTP ${got.status}`);
  /* MEASURED, not asserted. GitHub Pages sends application/manifest+json; tools/serve.ps1's
   * MIME table has no .webmanifest row, so locally it is octet-stream. Chrome parses either,
   * and the dev server is not this agent's file to edit — so this is reported rather than
   * failed, and the gap is in the report. */
  note(`content-type from this server: ${got.res.headers.get('content-type')}`);

  let man = null;
  try { man = JSON.parse(got.text); } catch (e) { man = null; }
  ok('A2 and it parses as JSON — an unparseable manifest is silently no manifest at all', !!man);
  if (!man) return;

  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons',
    'background_color', 'theme_color', 'id']) {
    ok(`A3 it declares ${k}`, man[k] !== undefined);
  }

  /**
   * ⚠ display:standalone IS A DECISION, AND THE REASON IS THE ESCAPE KEY.
   *
   * This is a pointer-locked first-person game. `src/core/input.js` lists Escape among the
   * keys nothing may bind, with the note that Escape is how the user leaves pointer lock and
   * the browser owns it — and `src/ui/commswheel.js` treats it as "reserved; we only read
   * it". A manifest asking for display:fullscreen gives Escape a SECOND owner, and the
   * browser's meaning fires first: the player's first press drops the app out of fullscreen
   * instead of releasing the mouse, and they are looking at their desktop rather than at the
   * pause they asked for. standalone still removes the URL bar and the tab strip, which is
   * the win that was actually wanted, and leaves Escape entirely to the game.
   */
  eq('A4 display is standalone, so the browser does not take Escape off a pointer-locked game',
    man.display, 'standalone');

  /* Relative on purpose: the same bytes serve from the site root in development and from
   * /ContainmentDetailWeb/ on Pages. An absolute start_url installs an app that works on one. */
  ok('A5 start_url is relative, so an install works at the site root and under a project path',
    !/^https?:|^\//.test(man.start_url), man.start_url);
  ok('A6 and scope with it', !/^https?:|^\//.test(man.scope), man.scope);
  eq('A7 start_url resolves to the build root', new URL(man.start_url, at('manifest.webmanifest')).href, ROOT);

  /* ⚠ THE COLOURS ARE THE GAME'S OR THEY ARE WRONG. Checked against index.html's :root rather
   * than against a remembered hex, so a palette change makes this file lie loudly instead of
   * quietly. background_color is --bg, the colour the canvas clears to, so the install splash
   * does not flash a different black. theme_color is --panel, the colour of every panel the
   * game draws. */
  const html = (await grab('index.html')).text;
  const cssVar = (n) => (new RegExp(`--${n}\\s*:\\s*(#[0-9a-fA-F]{3,8})`).exec(html) || [])[1];
  eq('A8 background_color is index.html\'s --bg, not a colour somebody liked',
    man.background_color.toLowerCase(), String(cssVar('bg')).toLowerCase());
  eq('A9 theme_color is --panel, so the browser chrome matches the game\'s chrome',
    man.theme_color.toLowerCase(), String(cssVar('panel')).toLowerCase());

  const metaTheme = /<meta\s+name="theme-color"\s+content="([^"]+)"/.exec(html);
  ok('A10 index.html carries a matching theme-color meta, for the browsers that read that instead',
    !!metaTheme && metaTheme[1].toLowerCase() === man.theme_color.toLowerCase(),
    metaTheme ? metaTheme[1] : 'absent');

  const link = /<link\s+rel="manifest"\s+href="([^"]+)"/.exec(html);
  ok('A11 and links the manifest, or none of it is ever read', !!link, 'no <link rel=manifest>');
  eq('A12 the link resolves to the manifest this suite just checked',
    link ? new URL(link[1], at('index.html')).href : '', at('manifest.webmanifest'));

  /* ⚠ EVERY ICON PATH IS FETCHED AND EVERY DECLARED SIZE IS MEASURED. A manifest whose icon
   * 404s is a manifest with no icons, and Chrome does not say so anywhere a developer looks;
   * a manifest that says 512x512 over a 192px file gets a blurred install prompt. Both are
   * invisible from the JSON. */
  ok('A13 it declares at least one icon', Array.isArray(man.icons) && man.icons.length > 0);
  let maskable = 0;
  for (const icon of man.icons || []) {
    const r = await fetch(new URL(icon.src, at('manifest.webmanifest')).href, { cache: 'no-store' });
    ok(`A14 ${icon.src} is served`, r.ok, `HTTP ${r.status}`);
    if (!r.ok) continue;
    const dim = await pixels(new URL(icon.src, at('manifest.webmanifest')).href);
    eq(`A15 ${icon.src} really is ${icon.sizes}`, `${dim.w}x${dim.h}`, icon.sizes);
    eq(`A16 ${icon.src} really is ${icon.type}`, r.headers.get('content-type'), icon.type);
    if (String(icon.purpose || '').includes('maskable')) maskable++;
  }
  ok('A17 one icon is maskable, so Android does not letterbox the mark inside a white square',
    maskable >= 1);

  const anySizes = (man.icons || []).filter((i) => !String(i.purpose || '').includes('maskable'))
    .map((i) => i.sizes);
  ok('A18 the installable sizes Chrome asks for are both present', anySizes.includes('192x192') && anySizes.includes('512x512'),
    anySizes.join(' '));
  emit();
}

/** Decode a PNG through the browser and read its real dimensions and pixels. */
function pixels(href) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      resolve({ w: img.naturalWidth, h: img.naturalHeight, data: g.getImageData(0, 0, c.width, c.height).data });
    };
    img.onerror = () => reject(new Error(`could not decode ${href}`));
    img.src = href;
  });
}

/* ══ B. the icons, measured rather than admired ════════════════════════════════════════ */

/**
 * ⚠ "IT LOOKS FINE" IS NOT A TEST, AND AN ICON IS THE EASIEST THING IN A BUILD TO SHIP BLANK.
 *
 * The generator writes PNGs by photographing a page in headless Chrome. If the font falls
 * back and U+25C9 renders as a tofu box, or the glyph fails to load at all, the pipeline
 * still reports "wrote icon-512.png (57 kb)" and every other check in this file still passes.
 * So the mark is measured off the pixels: there is ink, it is centred, it is the right size,
 * and it has real contrast against the field.
 *
 * "Ink" is red > 128. --amber is #e5a13a (R 229) and --bg is #05070a (R 5), so the test is
 * simply "is this pixel the mark or the field" and antialiasing and the glow — which peaks
 * around R 38 — cannot vote.
 */
async function sectionB() {
  heading('B. the icon is legible at 48px, and that is a measurement');

  const px = await pixels(at('assets/icons/icon-48.png'));
  eq('B1 the 48px icon is 48px', `${px.w}x${px.h}`, '48x48');

  const ink = inkBox(px, 128);
  ok('B2 there is a mark on it at 48px — the failure this catches is a blank or tofu render',
    ink.count > 0, `${ink.count} lit pixels`);
  const frac = ink.count / (px.w * px.h);
  note(`ink at 48px: ${(frac * 100).toFixed(1)}% of pixels, bounding box ${ink.w}x${ink.h}`);
  ok('B3 and it is a mark rather than a fill or a speck', frac > 0.10 && frac < 0.60, frac.toFixed(3));

  /* A mark that fills the frame has no icon-ness left; one that fills a third is a dot on a
   * black square. Both are what you get by eye at 512 and cannot see at 48. */
  const span = ink.w / px.w;
  near('B4 the mark occupies about 72% of the frame', span, 0.72, 0.08);

  /**
   * ⚠ CENTRING A GLYPH IS NOT CENTRING ITS INK. `align-items:center` centres the LINE BOX,
   * and U+25C9 is a circle on the maths axis rather than in the middle of its em — the first
   * render came out 11px low in a 192px frame. Invisible at 512, and exactly the sort of
   * thing that makes a small icon look subtly wrong next to every other icon in a dock.
   * tools/make-icons.ps1 corrects it with a measured -5.7vmin nudge; this is the other end of
   * that measurement, so the correction cannot silently rot.
   */
  near('B5 the mark is centred horizontally', ink.cx / px.w, 0.5, 0.03);
  near('B6 and vertically — a glyph centred on its line box is not centred on its ink',
    ink.cy / px.h, 0.5, 0.03);
  note(`centre at 48px: ${(ink.cx / px.w).toFixed(3)}, ${(ink.cy / px.h).toFixed(3)} of the frame`);

  const c = contrast(px, 128);
  ok(`B7 the mark stands off the field at ${c.toFixed(1)}:1 — above WCAG's 4.5 for the size it is read at`,
    c >= 4.5, c.toFixed(2));

  /**
   * ⚠ MASKABLE MEANS THE OUTER FIFTH IS THROWN AWAY. Android clips an install icon to a
   * platform shape — circle, squircle, teardrop — inside a safe circle 80% of the icon's
   * width. An "any" icon submitted as maskable loses its edges; the usual symptom is a logo
   * with its corners sliced off on exactly one launcher, which nobody developing on a desktop
   * ever sees. So: no ink outside that circle, measured.
   */
  const mp = await pixels(at('assets/icons/icon-maskable-512.png'));
  eq('B8 the maskable icon is 512px', `${mp.w}x${mp.h}`, '512x512');
  const reach = maxInkRadius(mp, 128);
  note(`maskable ink reaches ${(reach * 200).toFixed(1)}% of the icon width; the safe circle is 80%`);
  ok('B9 no part of the maskable mark falls outside Android\'s 80% safe circle',
    reach <= 0.40, `${(reach * 200).toFixed(1)}%`);

  const big = await pixels(at('assets/icons/icon-512.png'));
  eq('B10 the 512px icon is 512px', `${big.w}x${big.h}`, '512x512');
  const bigBox = inkBox(big, 128);
  near('B11 the 48px icon is the same mark as the 512px one, not a different crop',
    bigBox.w / big.w, ink.w / px.w, 0.04);

  /* Size matters here in a way it does not for a screenshot: every byte is in the precache,
   * so the icons are part of what a player downloads to go offline. */
  let bytes = 0;
  for (const f of ['icon-48.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    bytes += (await (await fetch(at(`assets/icons/${f}`), { cache: 'no-store' })).arrayBuffer()).byteLength;
  }
  note(`four icons total ${(bytes / 1024).toFixed(1)} kb`);
  ok('B12 the icon set stays under 200 kb — it rides in the offline precache', bytes < 200 * 1024,
    `${(bytes / 1024).toFixed(1)} kb`);
  emit();
}

function inkBox(px, thr) {
  let minX = 1e9; let maxX = -1; let minY = 1e9; let maxY = -1; let count = 0;
  for (let y = 0; y < px.h; y++) {
    for (let x = 0; x < px.w; x++) {
      if (px.data[(y * px.w + x) * 4] <= thr) continue;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return {
    count, minX, maxX, minY, maxY,
    w: maxX - minX + 1, h: maxY - minY + 1,
    cx: (minX + maxX + 1) / 2, cy: (minY + maxY + 1) / 2,
  };
}

/** WCAG contrast between the mean ink colour and the mean field colour, measured. */
function contrast(px, thr) {
  const lum = (r, g, b) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const A = [0, 0, 0, 0]; const B = [0, 0, 0, 0];
  for (let i = 0; i < px.data.length; i += 4) {
    const t = px.data[i] > thr ? A : B;
    t[0] += px.data[i]; t[1] += px.data[i + 1]; t[2] += px.data[i + 2]; t[3]++;
  }
  if (!A[3] || !B[3]) return 0;
  const la = lum(A[0] / A[3], A[1] / A[3], A[2] / A[3]);
  const lb = lum(B[0] / B[3], B[1] / B[3], B[2] / B[3]);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The furthest lit pixel from the centre, as a fraction of the icon's width. */
function maxInkRadius(px, thr) {
  const cx = px.w / 2; const cy = px.h / 2; let r2 = 0;
  for (let y = 0; y < px.h; y++) {
    for (let x = 0; x < px.w; x++) {
      if (px.data[(y * px.w + x) * 4] <= thr) continue;
      const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
      if (d > r2) r2 = d;
    }
  }
  return Math.sqrt(r2) / px.w;
}

/* ══ C. the precache list is real ══════════════════════════════════════════════════════ */

/**
 * ⚠ A TYPO IN THE PRECACHE LIST IS A SILENT LOSS OF THE WHOLE FEATURE. One URL that 404s
 * aborts the pass, no cache is ever completed, and the symptom is that the player simply
 * never becomes offline-capable — no error, no banner, nothing to notice, on a machine you do
 * not own. The list has to be fetched, not read.
 */
async function sectionC() {
  heading('C. every URL the worker precaches exists, and nothing else is in there');

  const rig = install(origin('unused'), true);   // the REAL list, not the stand-in
  const list = rig.api.PRECACHE;
  ok('C1 sw.js parses and exports its precache list', Array.isArray(list) && list.length > 0);
  note(`sw.js revision ${rig.api.SW_REV}, ${list.length} URLs`);

  eq('C2 no duplicates in the list — a duplicate is a symptom of a hand-merged edit',
    new Set(list).size, list.length);
  const shaped = list.filter((p) => /^(https?:|\/|\.\.)/.test(p));
  eq(`C3 every entry is a plain relative path${shaped.length ? ` — ${shaped.join(', ')}` : ''}`,
    shaped.length, 0);
  const notShipped = list.filter((p) => /^(tools|docs|GAME_BIBLE)\//.test(p) || /\.md$/.test(p));
  eq(`C4 nothing from tools, docs or the bible is in the player's download${notShipped.length ? ` — ${notShipped.join(', ')}` : ''}`,
    notShipped.length, 0);

  let bytes = 0; const dead = [];
  for (const p of list) {
    const r = await fetch(at(p), { cache: 'no-store' });
    if (!r.ok) { dead.push(`${p} (HTTP ${r.status})`); continue; }
    bytes += (await r.arrayBuffer()).byteLength;
  }
  eq(`C5 every precached URL resolves${dead.length ? ` — ${dead.join(', ')}` : ''}`, dead.length, 0);
  note(`precache is ${list.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB (${bytes} bytes)`);

  /* Not a rule, a tripwire. A build that doubles in size is a build somebody should look at
   * before every player downloads it to go offline. */
  ok('C6 the whole offline build is under 4 MiB', bytes < 4 * 1024 * 1024, `${bytes} bytes`);
  emit();
}

/* ══ D. and the list is COMPLETE ═══════════════════════════════════════════════════════ */

/**
 * ⚠ THE OTHER HALF OF C, AND THE HALF THAT ROTS. C proves nothing in the list is missing from
 * the repo. This proves nothing in the repo is missing from the list — which is the direction
 * that actually breaks, because four agents are adding content files to this build and none
 * of them is thinking about sw.js. `content/provenance.json` appeared while this suite was
 * being written.
 *
 * It is measured rather than listed. A browser cannot enumerate a directory, but it can be
 * asked what it just loaded: `performance.getEntriesByType('resource')` is the exact module
 * graph and boot content of the page this suite is running inside. That misses whatever boot
 * did not touch — the other eight incidents, the second locale — so the content loaders are
 * then walked over every incident and locale with `fetch` recording what they ask for. The
 * union is the build.
 */
async function sectionD() {
  heading('D. the precache list covers what the build actually loads');

  const rig = install(origin('unused'), true);   // the REAL list, not the stand-in
  const listed = new Set(rig.api.PRECACHE.map((p) => pathOf(p)));

  const wanted = new Set();
  const add = (u) => {
    const url = new URL(u, location.href);
    if (url.origin !== location.origin) return;          // the broker is not ours to cache
    if (url.pathname.startsWith(pathOf('tools/'))) return; // the suite and its harness
    if (/\/_[^/]*\.html$/.test(url.pathname)) return;      // the scratch page this runs from
    /* ⚠ AND sw.js ITSELF IS NOT A BUILD RESOURCE. This suite fetches it as text, so it shows
     * up in the resource list, and precaching it would be actively wrong: a worker script is
     * fetched out of band by the browser's own update machinery, never through the worker's
     * fetch handler, and a cached copy of it is the one file that could genuinely strand
     * somebody on an old worker. `updateViaCache: 'none'` on the registration says the same
     * thing to the HTTP cache. */
    if (url.pathname === pathOf('sw.js')) return;
    wanted.add(url.pathname);
  };

  for (const e of performance.getEntriesByType('resource')) add(e.name);
  const fromBoot = wanted.size;

  /* Walk everything boot did not: eight more incidents, both locales, the site and the
   * competency document. Recorded through `fetch` rather than assumed, because the loaders
   * resolve their own paths against `import.meta.url` and this suite should not restate that. */
  const real = window.fetch;
  window.fetch = (input, init) => { add(typeof input === 'string' ? input : input.url); return real.call(window, input, init); };
  try {
    for (const id of INCIDENTS) await loadContent({ incident: id });
    await loadSite();
    await loadOnboarding();
    for (const l of LOCALES) await loadLocale(l);
  } finally {
    window.fetch = real;
    await loadLocale(DEFAULT_LOCALE);   // put the locale back for whatever runs after this
  }
  note(`${fromBoot} resources loaded by boot, ${wanted.size} once all ${INCIDENTS.length} incidents and ${LOCALES.length} locales are walked`);

  const missing = [...wanted].filter((p) => !listed.has(p));
  eq(`D1 every file the build loads is precached${missing.length ? ` — add to PRECACHE in sw.js: ${missing.join(', ')}` : ''}`,
    missing.length, 0);

  /* The reverse: dead weight. Icons and the manifest are legitimately in the list and never
   * fetched by the running game, so they are exempt by name rather than by pattern. */
  const exempt = (p) => /\/assets\/icons\//.test(p) || /manifest\.webmanifest$/.test(p) || /index\.html$/.test(p);
  const unused = [...listed].filter((p) => !wanted.has(p) && !exempt(p));
  eq(`D2 and nothing is precached that the build never asks for${unused.length ? ` — ${unused.join(', ')}` : ''}`,
    unused.length, 0);

  /* Deliberate exclusions, asserted so that "we left it out" is a decision on the record
   * rather than something nobody got round to. */
  ok('D3 the licence notice is deliberately not precached — §25 material no code fetches',
    !listed.has(pathOf('assets/lib/NOTICE.md')));
  ok('D4 nor is content/provenance.json, for the same reason',
    !listed.has(pathOf('content/provenance.json')));
  ok('D5 but PeerJS is, even though solo play never opens a connection — index.html loads it '
    + 'with a script tag, so an offline page without it would boot with Peer undefined and '
    + 'differ from the online one',
  listed.has(pathOf('assets/lib/peerjs-1.5.4/peerjs.min.js')));
  emit();
}

/* ══ E. THE ONE THAT MATTERS ═══════════════════════════════════════════════════════════ */

/**
 * ⚠ THE FAILURE THIS SECTION EXISTS TO MAKE IMPOSSIBLE.
 *
 * `caches.match(e.request).then(r => r || fetch(e.request))` is what every tutorial writes and
 * it would end push-is-the-deploy for this repo without a single red light. A player who
 * opened the game yesterday would receive yesterday's index.html and yesterday's modules for
 * ever; `tools/verify-live.ps1` would go on passing, because the URL genuinely is serving the
 * new commit; and the only person who could see the problem is the player, who has no way to
 * know there is one.
 *
 * So the property under test is not "the cache works". It is: WITH A COMPLETE BUILD IN THE
 * CACHE AND A DIFFERENT BUILD ON THE NETWORK, AN ONLINE PLAYER GETS THE NETWORK'S.
 */
async function sectionE() {
  heading('E. the network outranks the cache, for the page and for every file under it');
  await wipe();

  /* Session one, on build A, ending with a complete cache. */
  const a = install(origin('aaa1111 2026-08-23T09:00:00-04:00'));
  const first = await visit(a);
  ok('E1 the first visit is served from the network', /aaa1111/.test(first.body));
  eq('E2 and leaves exactly one cache behind', (await buildCaches()).length, 1);
  const cacheA = (await buildCaches())[0];
  note(`cache name: ${cacheA}`);
  ok('E3 named for the build it holds, sanitised out of the cd-build stamp',
    cacheA.startsWith('cd-build-aaa1111-'), cacheA);
  eq('E4 the pass reported a whole build', said(a, 'ready').length, 1);
  note(`precached ${said(a, 'ready')[0].fetched} files, ${said(a, 'ready')[0].bytes} bytes reported by content-length`);
  emit();   // the harness greps a dumped DOM; a section that is cut off must still say how far it got

  /* Session two. The deploy has happened; the cache still holds A. */
  const b = install(origin('bbb2222 2026-08-23T11:30:00-04:00'));
  const nav = await b.api.serveNavigation(navRequest(at('index.html')), true);
  const page = await nav.response.clone().text();
  ok('E5 ⚠ THE HEADLINE: an online player with build A cached is served build B\'s page',
    /bbb2222/.test(page), page.slice(0, 120));
  ok('E6 and it is a 200 from the network rather than a cache hit', nav.response.status === 200);

  const asset = await b.api.serveAsset(new Request(at('src/game.js')), new URL(at('src/game.js')));
  const text = await asset.text();
  ok('E7 and so is every module under it — a fresh page over a stale module is the worse bug',
    /bbb2222/.test(text), text.slice(0, 80));

  const json = await b.api.serveAsset(new Request(at('content/site.json'), { cache: 'no-store' }),
    new URL(at('content/site.json')));
  ok('E8 including the content the game fetches with cache:no-store',
    /bbb2222/.test(await json.text()));
  emit();

  /* Before the update pass runs, offline still gives the last COMPLETE build — never a
   * half-and-half of the two. */
  const off1 = install(origin('irrelevant', { offline: true }));
  const o1 = await off1.api.serveNavigation(navRequest(at('index.html')), true);
  eq('E9 offline, the page comes from the cache with a real 200', o1.response.status, 200);
  ok('E10 and it is build A — the last build that was cached whole', /aaa1111/.test(await o1.response.text()));
  const o1m = await off1.api.serveAsset(new Request(at('src/game.js')), new URL(at('src/game.js')));
  ok('E11 with modules from the same build, never a mix of two',
    /aaa1111/.test(await o1m.text()));
  emit();

  /* Now let session two's update pass finish. */
  await b.api.reconcile(nav.html);
  const names = await buildCaches();
  eq('E12 the swap is atomic: one cache, not two', names.length, 1);
  ok('E13 and it is the new build\'s', names[0].startsWith('cd-build-bbb2222-'), names[0]);

  const off2 = install(origin('irrelevant', { offline: true }));
  const o2 = await off2.api.serveNavigation(navRequest(at('index.html')), true);
  ok('E14 offline now serves build B', /bbb2222/.test(await o2.response.text()));
  const o2m = await off2.api.serveAsset(new Request(at('src/game.js')), new URL(at('src/game.js')));
  ok('E15 coherently', /bbb2222/.test(await o2m.text()));

  /* Re-visiting the same build must not re-download it. */
  const b2 = install(origin('bbb2222 2026-08-23T11:30:00-04:00'));
  await visit(b2);
  eq('E16 revisiting the same build precaches nothing at all', said(b2, 'ready').length, 0);
  ok('E17 and asks the network only for the page itself', b2.net.state.asked.length === 1,
    b2.net.state.asked.join(', '));
  emit();
}

/* ══ F. what happens when it goes wrong ════════════════════════════════════════════════ */

/**
 * ⚠ A PLAYER MUST NEVER BE STUCK ON AN OLD BUILD WITH NO WAY TO GET THE NEW ONE.
 *
 * With network-first that is true by construction — being online IS the way — but the cache
 * still has to degrade correctly around it. The three ways a real update goes wrong are: a
 * file 404s, the worker is killed part way through, and the worker itself turns out to be the
 * bug. All three have to leave the player with something coherent.
 */
async function sectionF() {
  heading('F. a failed update costs the player nothing, and the worker can be retired');
  await wipe();

  const good = install(origin('ccc3333'));
  await visit(good);
  eq('F1 a complete build is cached to start from', (await buildCaches()).length, 1);

  /* One file has gone missing from the deploy. */
  const broken = install(origin('ddd4444', { missing: ['content/site.json'] }));
  const nav = await broken.api.serveNavigation(navRequest(at('index.html')), true);
  ok('F2 the player is still served the new page from the network',
    /ddd4444/.test(await nav.response.clone().text()));
  await broken.api.reconcile(nav.html);

  const fails = said(broken, 'failed');
  eq('F3 the pass fails rather than completing a build with a hole in it', fails.length, 1);
  ok('F4 and says which file did it', /site\.json/.test(fails[0].why), fails[0].why);

  const names = await buildCaches();
  ok('F5 ⚠ the working cache is untouched — a failed update does not cost the player their offline copy',
    names.includes(await activeName()), names.join(', '));
  const off = install(origin('irrelevant', { offline: true }));
  const o = await off.api.serveNavigation(navRequest(at('index.html')), true);
  ok('F6 offline still serves the last whole build', /ccc3333/.test(await o.response.text()));
  const om = await off.api.serveAsset(new Request(at('src/game.js')), new URL(at('src/game.js')));
  ok('F7 and not a Frankenstein of the two — the half-written cache has no sentinel, so it cannot answer',
    /ccc3333/.test(await om.text()));
  emit();

  /* ⚠ AN INTERRUPTED PASS RESUMES. A service worker is killed roughly thirty seconds after its
   * last event, so a 2 MiB sequential precache on a slow link WILL be terminated part way
   * through, repeatedly. A pass that restarted from zero each time would never finish on the
   * link that needs it most. */
  const fixed = install(origin('ddd4444'));
  const nav2 = await fixed.api.serveNavigation(navRequest(at('index.html')), true);
  await fixed.api.reconcile(nav2.html);
  const ready = said(fixed, 'ready');
  eq('F8 the retry completes', ready.length, 1);
  ok('F9 and resumes rather than restarting — the files the aborted pass got are kept',
    ready[0].held > 0 && ready[0].fetched < ready[0].files,
    `held ${ready[0].held}, fetched ${ready[0].fetched} of ${ready[0].files}`);
  note(`resume kept ${ready[0].held} of ${ready[0].files} files from the aborted pass`);
  eq('F10 and the old build is dropped once the new one is whole', (await buildCaches()).length, 1);

  /* ⚠ AN INCOMPLETE CACHE IS NEVER READ FROM. Planted by hand, because the shape that matters
   * is "a cache with files in it and no sentinel" and no ordinary path produces one on demand. */
  await wipe();
  const orphan = await CACHES.open('cd-build-eee5555');
  await orphan.put(at('index.html'), new Response(indexFor('eee5555'), { status: 200 }));
  const off2 = install(origin('irrelevant', { offline: true }));
  const o2 = await off2.api.serveNavigation(navRequest(at('index.html')), true);
  eq('F11 half a build is not a build: an unsentinelled cache does not answer', o2.response.status, 503);
  ok('F12 and the player is told why rather than shown a browser error page',
    /no network/i.test(await o2.response.text()));
  await wipe();
  emit();

  /* The kill switch. */
  const live = install(origin('fff6666'));
  await visit(live);
  eq('F13 a build is cached', (await buildCaches()).length, 1);
  const off3 = install(origin('fff6666', { extraHead: '<meta name="cd-sw" content="off">' }));
  const nav3 = await off3.api.serveNavigation(navRequest(at('index.html')), true);
  await off3.api.reconcile(nav3.html);
  eq('F14 ⚠ index.html can retire the worker: every cache is dropped', (await buildCaches()).length, 0);
  ok('F15 and it unregisters itself, so the next load has no worker at all', off3.self.unregistered);
  ok('F16 which makes disarming a bad worker a one-line commit to the file every deploy touches',
    said(off3, 'retired').length === 1);

  /* An unstamped page names no build, so there is nothing to cache coherently. */
  await wipe();
  const unstamped = install(origin('x'));
  unstamped.net.state.build = '{{COMMIT}}';
  const nav4 = await unstamped.api.serveNavigation(navRequest(at('index.html')), true);
  await unstamped.api.reconcile(nav4.html);
  eq('F17 an unsubstituted build stamp caches nothing rather than caching under a fake name',
    (await buildCaches()).length, 0);
  eq('F18 and says so', said(unstamped, 'unstamped').length, 1);
  emit();
}

async function activeName() {
  const rig = install(origin('probe'));
  return rig.api.activeCacheName();
}

/* ══ G. routing: what the worker refuses to touch ══════════════════════════════════════ */

async function sectionG() {
  heading('G. the worker keeps its hands off everything that is not this build');
  await wipe();

  const rig = install(origin('ggg7777'));

  /* ⚠ THE SIGNALLING BROKER IS NEVER INTERCEPTED. §25 and assets/lib/NOTICE.md say this build
   * reaches exactly one external host, only when somebody hosts or joins, and m0-tests K6
   * enforces that against src/. A worker that touched cross-origin requests would be a second
   * place that claim has to hold, and one of the two would eventually stop holding. */
  const broker = fetchEvent({ method: 'GET', url: 'https://0.peerjs.com/peerjs/id', mode: 'cors', destination: '' });
  rig.api.handlers.fetch(broker);
  ok('G1 a cross-origin request is not intercepted at all', broker.responded === null);
  eq('G2 and the worker never asked the network on its behalf', rig.net.state.asked.length, 0);

  const post = fetchEvent({ method: 'POST', url: at('index.html'), mode: 'same-origin', destination: '' });
  rig.api.handlers.fetch(post);
  ok('G3 nor is a non-GET — a worker has no business replaying a POST', post.responded === null);

  /**
   * ⚠ ONLY index.html DEFINES THE BUILD, AND THAT IS NOT A SPECIAL CASE FOR THE TOOLING.
   *
   * It is the honest rule — the entry point is what a build IS — but it has a consequence
   * worth naming. `tools/smoketest.ps1` and `tools/shot.ps1` serve `_smoketest-<port>.html`
   * and `_shot.html` out of this same root: copies of index.html with a suite spliced in,
   * carrying the same cd-build stamp. If any HTML page could drive the cache, every headless
   * run on this machine would kick off a 2 MiB precache inside its own virtual-time budget.
   */
  const entry = fetchEvent(navRequest(at('index.html')));
  rig.api.handlers.fetch(entry);
  ok('G4 a navigation to index.html is served', entry.responded !== null);
  eq('G5 and drives the cache', entry.waited.length, 1);

  const root = fetchEvent(navRequest(ROOT));
  rig.api.handlers.fetch(root);
  eq('G6 so does the bare directory, which is the URL Pages actually serves', root.waited.length, 1);

  const scratch = fetchEvent(navRequest(at('_smoketest-8451.html')));
  rig.api.handlers.fetch(scratch);
  ok('G7 a harness scratch page is still served', scratch.responded !== null);
  eq('G8 but does not get to say what the build is', scratch.waited.length, 0);

  await Promise.all([...entry.waited, ...root.waited]);
  emit();

  /* ⚠ 404 IS AN ANSWER; 5xx IS NOT. The network saying "no such file" is the deploy speaking,
   * and resurrecting a file it removed is exactly the staleness this design refuses. An origin
   * that is up and serving nothing is a different thing, and a coherent cached build beats an
   * error page there. */
  const gone = install(origin('ggg7777', { missing: ['content/site.json'] }));
  const g404 = await gone.api.serveAsset(new Request(at('content/site.json')), new URL(at('content/site.json')));
  eq('G9 a 404 is passed through rather than answered from the cache', g404.status, 404);

  const down = install(origin('ggg7777', { status: { 'content/site.json': 503 } }));
  const g503 = await down.api.serveAsset(new Request(at('content/site.json')), new URL(at('content/site.json')));
  eq('G10 a 5xx falls back to the cache — the origin is up and serving nothing', g503.status, 200);
  ok('G11 with the cached build\'s bytes', /ggg7777/.test(await g503.text()));

  const downNav = await down.api.serveNavigation(navRequest(at('index.html')), true);
  eq('G12 and a navigation does too, so an origin outage is not a dead game', downNav.response.status, 200);

  /* ⚠ A WORKER THAT CANNOT HELP MUST LOOK EXACTLY LIKE NO WORKER. With nothing cached and no
   * network, a subresource has to fail the way a bare fetch fails — src/sim/content.js REFUSES
   * loudly on a rejected fetch, and handing back a synthesised 503 instead would reroute that
   * failure through the "HTTP 503" branch and change the message a player is shown. */
  await wipe();
  const nothing = install(origin('x', { offline: true }));
  const dead = await nothing.api.serveAsset(new Request(at('src/game.js')), new URL(at('src/game.js')));
  ok('G13 offline with nothing cached, a module request fails as a network error rather than as a fake 503',
    dead.type === 'error');

  /* The scope guard: this worker sits at the repo root, so on Pages its scope is
   * /ContainmentDetailWeb/ and nothing above that is its business. */
  ok('G14 the entry-point test is anchored to the worker\'s own directory, not to /',
    rig.api.isEntryPoint(new URL(at('index.html'))) && !rig.api.isEntryPoint(new URL('/elsewhere/index.html', location.href)));
  emit();
}

/* ══ H. the registration line, and the fact that it is optional ════════════════════════ */

async function sectionH() {
  heading('H. the game does not depend on any of this');

  /* ⚠ MEASURED: this whole suite has just run inside a fully booted game with NO service
   * worker registered — `src/main.js` does not yet carry the registration line, on purpose,
   * because that file belongs to another agent. Everything above is therefore a statement
   * about a build that works identically without it. */
  ok('H1 the game booted and published its handle with no worker registered', !!window.__CD);
  note(`service worker controlling this page: ${navigator.serviceWorker && navigator.serviceWorker.controller ? 'yes' : 'none'}`);

  const html = (await grab('index.html')).text;
  ok('H2 index.html does not register the worker itself — one entry point, and it is main.js',
    !/serviceWorker/.test(html));
  ok('H3 index.html still loads three.js and peerjs from the vendored copies (K9/K10 from the other side)',
    /assets\/lib\/r128\/three\.min\.js/.test(html) && /assets\/lib\/peerjs-1\.5\.4\/peerjs\.min\.js/.test(html));
  ok('H4 and the head additions brought no external host with them',
    !/https?:\/\//.test(html.slice(0, html.indexOf('<style>'))));

  /* The exact line, asserted so that the URL in the report and the URL the worker computes
   * for itself are provably the same one. */
  const mainUrl = at('src/main.js');
  eq('H5 `new URL(\'../sw.js\', import.meta.url)` from src/main.js resolves to the worker',
    new URL('../sw.js', mainUrl).href, at('sw.js'));

  const rig = install(origin('unused'));
  eq('H6 whose own scope root is the build root', rig.api.HERE, ROOT);
  ok('H7 sw.js is served as JavaScript', /javascript|ecmascript/i.test(
    (await fetch(at('sw.js'), { cache: 'no-store' })).headers.get('content-type') || ''));

  const kill = /<meta\s+name="cd-sw"\s+content="on">/.test(html);
  ok('H8 index.html carries the cd-sw switch in its armed position', kill);
  emit();
}

/* ══ drive ═════════════════════════════════════════════════════════════════════════════ */

await suite('platform', async () => {
  await run('A', () => sectionA());
  await run('B', () => sectionB());
  await run('C', () => sectionC());
  await run('D', () => sectionD());
  await run('E', () => sectionE());
  await run('F', () => sectionF());
  await run('G', () => sectionG());
  await run('H', () => sectionH());
  /* R last: it is the only section that touches the real CacheStorage, and the cost of doing
   * that is unbounded enough that it must not be able to take the rest of the run with it. */
  await run('R', () => sectionR());
});
void lines; void counts;
