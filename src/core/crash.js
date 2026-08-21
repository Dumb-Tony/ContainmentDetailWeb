/* The crash boundary — what this page does when the game throws.
 *
 * ⚠ WHY THIS EXISTS, AND WHAT WAS ACTUALLY WRONG.
 *
 * `main.js` installs `window.addEventListener('error', …)` and paints the FIRST message
 * into `#err-banner`, tallying the rest as "(+N further errors)". That is a reasonable
 * banner and it is not a crash boundary, because of where the loop reschedules itself:
 *
 *     function frame(now) {
 *       requestAnimationFrame(frame);        // ← FIRST LINE
 *       … everything that can throw …
 *       renderer.render(); hud.update(); drawCaptions(); audio.apply(…);
 *     }
 *
 * The next frame is already booked before anything runs, so a throw does not stop the
 * loop — it repeats it. Sixty times a second, forever, and what the player sees depends
 * entirely on WHERE in the body the throw landed:
 *
 *   · throw before `renderer.render()` — the canvas holds its last painted frame. The
 *     world is frozen, the keyboard does nothing, and a thin red line at the top of the
 *     screen says something in a font nobody reads. It looks like a hang.
 *
 *   · throw after `renderer.render()` — inside `hud.update()`, `drawCaptions()` or the
 *     audio mix — and this is the bad one. THE WORLD KEEPS ANIMATING AND THE HUD STOPS.
 *     Battery, stress, custody timer, squad status and the context prompt all freeze at
 *     their last good value while the anomaly walks around behind them. The player reads
 *     "CUSTODY 00:12" off a display that stopped twenty seconds ago and believes it.
 *     GDD §18.1 requires the UI to distinguish observed fact from interpretation; a HUD
 *     that has stopped updating and does not say so is neither, and a game that throws
 *     once per frame and keeps painting is strictly worse than one that stops, because
 *     the player cannot tell that anything is wrong.
 *
 * So the rule this file implements is: a game that cannot keep its promises STOPS, says
 * so in words a player can act on, and hands over a report a developer can read.
 *
 * ⚠ WHAT IT DELIBERATELY DOES NOT DO.
 *
 *   · It does not try/catch the frame body. Wrapping the loop would swallow the error
 *     before DevTools' "pause on exceptions" ever sees it, and would hide the stack that
 *     is the only useful thing about a crash. The error still goes to the console
 *     untouched; this listens to `window`, downstream of everything.
 *   · It does not recover, retry, or roll back. There is no snapshot of a known-good game
 *     state to roll back TO, and inventing one is how a corrupt save gets written.
 *   · It does not phone home. `assets/lib/NOTICE.md` states that this build reaches
 *     exactly one network host and that it is the signalling broker; `tools/m0-tests.js`
 *     section K6 asserts it. A crash reporter would be a second one, and would be a
 *     privacy claim this project has not made. The incident is put on the screen with a
 *     button that copies it, and that is the whole delivery mechanism.
 *   · It does not deduplicate by message. Two errors with the same words from different
 *     call sites are two bugs; one error whose message embeds a player name is one bug
 *     wearing five hats. The stack is the identity — see `crashSignature`.
 *   · It makes no sound. §18.1 wants critical states redundant across colour, shape, text
 *     and sound, and this manages three of the four: a crash boundary that starts an
 *     AudioContext to announce that the game is broken is one more thing that can throw.
 *
 * ⚠ FOR WHOEVER ADDS THIS FILE TO `tools/m0-tests.js` SECTION K'S FILE LIST: it needs the
 * K5 exemption that `src/main.js` and `src/audio/audio.js` already have, because it reads
 * `Date.now()` — once, as the default for the injectable `now`. K5's rule is that nothing
 * but the boot loop reads wall-clock time, and this IS boot-layer code: it is installed by
 * main.js, it touches the DOM, and a crash report with no wall-clock stamp cannot be matched
 * against a player's account of when it happened. The clock is injectable precisely so the
 * suite drives it, and `tools/audit-tests.js` section A does. Every other K rule passes:
 * no Math.random, no network host, no innerHTML.
 */

import { hashStr } from './rng.js';

/** How much repetition is a loop rather than a hiccup. See `CrashBoundary.halt`. */
export const CRASH_LIMITS = Object.freeze({
  /* Three of the SAME signature. At 60 Hz a per-frame throw reaches three in 50 ms, so
   * the banner appears at the same moment the world freezes rather than half a minute
   * later; and a genuinely one-off error — a resize race, a rejected pointer-lock, a
   * gamepad disconnecting mid-poll — fires once and is left alone. */
  repeatLimit: 3,
  /* Or thirty errors of any kind. A page producing thirty distinct failures is not going
   * to produce a playable thirty-first. */
  totalLimit: 30,
  /* Distinct signatures kept. Past this the counters still count; only the detail is
   * dropped, so a storm cannot grow the page it is reporting on. */
  maxRecords: 12,
  /* Distinct messages kept per signature. */
  maxMessages: 4,
  /* Stack frames kept per signature, and the number that form its identity. */
  maxFrames: 8,
  signatureFrames: 3,
});

/* ── reading a stack ──────────────────────────────────────────────────────── */

/**
 * One stack line, with the origin taken off.
 *
 * ⚠ THE ORIGIN HAS TO GO OR NOTHING DEDUPLICATES ACROSS RUNS. The suite serves this page
 * on a different port every suite (`run-tests.ps1` walks 8411 upward) and Pages serves it
 * from a third host, so `http://127.0.0.1:8493/src/game.js:812:19` and
 * `https://dumb-tony.github.io/ContainmentDetailWeb/src/game.js:812:19` are the same
 * frame and must produce the same signature. The line and column stay: they are what
 * identifies the site.
 */
export function normaliseFrame(line) {
  return String(line)
    .trim()
    .replace(/^at\s+/, '')
    /* scheme://host[:port]/  →  nothing.  Also strips a Pages sub-path prefix, which is
     * why the repo-relative part is matched rather than the whole URL. */
    .replace(/[a-z]+:\/\/[^/)\s]+\/(?:[^)\s]*?\/)?(?=(?:src|tools|assets|content)\/)/gi, '')
    .replace(/[a-z]+:\/\/[^/)\s]+\//gi, '')
    .replace(/\?[^):\s]*/g, '')            // cache-busting query, if anything grows one
    .replace(/\s+/g, ' ');
}

/** The frames of an error, normalised, deepest first. Empty when there is no stack. */
export function stackFrames(err, max = CRASH_LIMITS.maxFrames) {
  const raw = err && typeof err === 'object' && typeof err.stack === 'string' ? err.stack : '';
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    /* Chrome puts the message on line one and every frame after it begins with `at`.
     * Firefox has no message line and uses `name@url:line:col`. Both are accepted; a
     * line matching neither is not a frame. */
    const isChrome = /^\s+at\s/.test(line);
    const isFirefox = /@[^\s]+:\d+:\d+\s*$/.test(line);
    if (!isChrome && !isFirefox) continue;
    out.push(normaliseFrame(line));
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The identity of a crash: WHERE it was thrown, not what it said.
 *
 * ⚠ MESSAGES VARY AND SITES DO NOT. `Player p4 is not on the roster` and `Player p2 is
 * not on the roster` are one bug; keying on the message makes them two, and a per-frame
 * throw whose message embeds `simTimeMs` becomes ten thousand. Keying on the top frames
 * collapses them correctly, and the messages are kept alongside the record so nothing is
 * lost — `summary()` prints every distinct one it saw.
 *
 * An error with no stack (a cross-origin `Script error.`, a thrown string, a rejection
 * carrying a number) falls back to name+message, which is all the identity there is.
 */
export function crashSignature(err, kindHint = 'error') {
  const frames = stackFrames(err, CRASH_LIMITS.signatureFrames);
  if (frames.length) return `${kindHint}|${frames.join(' <- ')}`;
  const name = (err && err.name) || (err && err.constructor && err.constructor.name) || typeof err;
  const msg = messageOf(err);
  return `${kindHint}|no-stack|${name}: ${msg}`;
}

/** Whatever this thing has to say for itself, as a bounded single line. */
export function messageOf(err) {
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  if (typeof err === 'string') return err.slice(0, 300);
  if (typeof err !== 'object') return String(err).slice(0, 300);
  if (typeof err.message === 'string' && err.message) return err.message.slice(0, 300);
  /* A rejection carrying a plain object is common and `[object Object]` tells nobody
   * anything, so it is serialised — defensively, because a getter can throw. */
  try { return JSON.stringify(err).slice(0, 300); } catch { return String(err).slice(0, 300); }
}

/**
 * A short, stable handle for one crash — the thing a player reads out over a support
 * channel and a developer greps for.
 *
 * Derived from the signature, so the SAME bug on two machines produces the same
 * reference and two reports can be recognised as one. FNV-1a via `hashStr`, reused from
 * `src/core/rng.js` rather than rewritten (Dev\INDEX.md → Randomness & hashing).
 */
export function incidentRef(signature) {
  return `CD-${hashStr(String(signature)).toString(36).toUpperCase().padStart(7, '0').slice(-7)}`;
}

/* ── which build this is ──────────────────────────────────────────────────── */

/**
 * The commit this page was served from, or an honest admission that nobody said.
 *
 * ⚠ THERE IS NO BUILD STEP. `push` is the deploy (the house rule: public repo, index.html
 * at the root, Pages serving `main`), so there is no bundler to stamp anything and the
 * commit is not knowable from inside the page unless the page is told. It is told by a
 * meta tag, and when the tag is missing this returns `unstamped:<lastModified>` rather
 * than a plausible-looking number — a crash report that names the wrong commit is worse
 * than one that admits it does not know which.
 */
export function buildId(doc = globalThis.document) {
  try {
    const meta = doc && doc.querySelector && doc.querySelector('meta[name="cd-build"]');
    const v = meta && meta.getAttribute('content');
    if (v && v.trim() && !/^\{\{|\$Format:/.test(v)) return v.trim().slice(0, 64);
  } catch { /* no DOM */ }
  if (globalThis.CD_BUILD) return String(globalThis.CD_BUILD).slice(0, 64);
  const lm = (doc && doc.lastModified) || '';
  return lm ? `unstamped:${lm}` : 'unstamped';
}

/** Which operation the player was on, from the URL the boot reads. */
export function deploymentOf(loc = globalThis.location) {
  const out = { incident: 'cold-storage-draught', scenario: null, seed: null, href: '' };
  try {
    const u = new URL(String(loc.href));
    out.href = u.pathname + u.search;
    out.incident = u.searchParams.get('incident') || out.incident;
    out.scenario = u.searchParams.get('scenario');
    out.seed = u.searchParams.get('seed');
  } catch { /* no location: the harness, or a worker */ }
  return out;
}

/* ── the boundary ─────────────────────────────────────────────────────────── */

const PLAYER_LINES = Object.freeze({
  running: [
    'Something in this operation failed.',
    'The game is still running. If the display stops matching what you do, reload —'
    + ' nothing you have already banked is at risk.',
  ],
  halted: [
    'Containment Detail has stopped.',
    'It hit the same error repeatedly and stopped on purpose, rather than keep drawing a'
    + ' screen that is no longer true. Everything earned in previous operations is saved;'
    + ' this operation is not.',
    'Reload the page to deploy again.',
  ],
});

export class CrashBoundary {
  /**
   * @param {object} opts
   *   doc, win, loc   injected so the whole class is testable without a real page
   *   build           build id string; defaults to `buildId(doc)`
   *   deployment      {incident, scenario, seed, href}; defaults to `deploymentOf(loc)`
   *   now             () => epoch ms. Injected because §K5 reserves wall-clock reads to
   *                   the boot loop, and because a test needs a clock it controls.
   *   bannerId        element to render into; created if absent
   *   onHalt          called once, when the boundary decides the page is finished
   *   limits          overrides for CRASH_LIMITS
   */
  constructor({
    doc = globalThis.document, win = globalThis, loc = globalThis.location,
    build = null, deployment = null, now = () => Date.now(),
    bannerId = 'err-banner', onHalt = null, limits = null, render = true,
  } = {}) {
    this.doc = doc;
    this.win = win;
    this.now = now;
    this.build = build || buildId(doc);
    this.deployment = deployment || deploymentOf(loc);
    this.bannerId = bannerId;
    this.onHalt = onHalt;
    this.limits = { ...CRASH_LIMITS, ...(limits || {}) };
    this.shouldRender = render;

    /** signature -> record. Insertion-ordered, so the FIRST crash is printed first. */
    this.records = new Map();
    /** Every error seen, including ones whose detail was dropped past `maxRecords`. */
    this.total = 0;
    /** Failed <img>/<script>/<link> loads. Counted, reported, and never a halt. */
    this.resourceFailures = [];
    this.halted = false;
    this.haltedBecause = null;
    this.startedAtMs = now();
    /* ⚠ An exception thrown INSIDE an error handler is itself reported to `window.onerror`,
     * so a boundary that throws while rendering the banner recurses until the stack ends —
     * and the last thing the page does is die of the crash reporter. Every entry point is
     * wrapped and this flag makes re-entry a no-op. */
    this._inside = false;
    this._restoreRaf = null;
    this._painted = '';
    this._bannerEl = null;
  }

  /* ── intake ────────────────────────────────────────────────────────────── */

  /** Report one thrown value. `kind` is 'error' or 'rejection'. Returns the record. */
  report(err, kind = 'error') {
    if (this._inside) return null;
    this._inside = true;
    try {
      return this._record(err, kind);
    } catch (e) {
      /* The boundary itself broke. Say so in the crudest way available and stop trying. */
      this._panic(e);
      return null;
    } finally {
      this._inside = false;
    }
  }

  _record(err, kind) {
    this.total++;
    const sig = crashSignature(err, kind);
    let rec = this.records.get(sig);
    const at = this.now();
    if (!rec) {
      if (this.records.size >= this.limits.maxRecords) {
        /* Detail is dropped, the count is not. `summary()` says how many were elided so
         * the report never implies it saw everything when it did not. */
        this._checkHalt();
        if (this.shouldRender) this.paint();
        return null;
      }
      rec = {
        ref: incidentRef(sig),
        signature: sig,
        kind,
        name: (err && err.name) || (typeof err === 'string' ? 'thrown string' : typeof err),
        messages: [],
        frames: stackFrames(err),
        count: 0,
        firstAtMs: at,
        lastAtMs: at,
        deployment: this.deployment.incident,
      };
      this.records.set(sig, rec);
    }
    rec.count++;
    rec.lastAtMs = at;
    const msg = messageOf(err);
    if (!rec.messages.includes(msg) && rec.messages.length < this.limits.maxMessages) {
      rec.messages.push(msg);
    }
    this._checkHalt();
    if (this.shouldRender) this.paint();
    return rec;
  }

  /**
   * A `<script>`, `<img>` or `<link>` that failed to load. These arrive on the same
   * `error` event with `e.target` set and no `e.error`, and they are a DIFFERENT KIND OF
   * FACT: three.min.js missing is fatal and boot already says so in its own words, while
   * a decorative asset missing is not a reason to stop a containment. Counted, printed,
   * never a halt.
   */
  reportResource(target) {
    if (this._inside) return null;
    this._inside = true;
    try {
      const src = (target && (target.src || target.href)) || '(unknown)';
      const tag = (target && target.tagName) ? String(target.tagName).toLowerCase() : '?';
      const line = `${tag} ${String(src).replace(/^[a-z]+:\/\/[^/]+\//i, '')}`;
      if (!this.resourceFailures.includes(line) && this.resourceFailures.length < 16) {
        this.resourceFailures.push(line);
      }
      if (this.shouldRender) this.paint();
      return line;
    } catch (e) {
      this._panic(e);
      return null;
    } finally {
      this._inside = false;
    }
  }

  /* ── the decision ──────────────────────────────────────────────────────── */

  _checkHalt() {
    if (this.halted) return;
    for (const rec of this.records.values()) {
      if (rec.count >= this.limits.repeatLimit) {
        this.halt(`the same error ${rec.count} times in ${rec.lastAtMs - rec.firstAtMs} ms`);
        return;
      }
    }
    if (this.total >= this.limits.totalLimit) {
      this.halt(`${this.total} errors since the page loaded`);
    }
  }

  /**
   * Stop the page.
   *
   * ⚠ HOW IT STOPS, AND WHY IT IS DONE HERE RATHER THAN IN THE LOOP. `frame()` books the
   * next frame on its first line, so by the time anything throws the next one is already
   * scheduled and the loop cannot be stopped from inside its own body without editing it.
   * `installCrashBoundary({ haltFrameLoop: true })` therefore wraps
   * `requestAnimationFrame` at install time and starts refusing new requests once halted.
   * The self-rescheduling loop then runs exactly one more time and stops, because the
   * reschedule it performs is the one that is refused.
   *
   * That is a global patch and it is deliberately loud about it: `restore()` undoes it,
   * the suite installs with `haltFrameLoop: false`, and nothing else is touched.
   */
  halt(why) {
    if (this.halted) return;
    this.halted = true;
    this.haltedBecause = why;
    if (this.shouldRender) this.paint();
    try { if (this.onHalt) this.onHalt(why, this); } catch { /* a halt handler may not undo the halt */ }
  }

  /* ── the report ────────────────────────────────────────────────────────── */

  /** The developer half, as plain text. This is what the copy button copies. */
  summary() {
    const d = this.deployment;
    const out = [];
    out.push(`build ${this.build}`);
    out.push(`incident ${d.incident}${d.scenario ? `  scenario ${d.scenario}` : ''}${d.seed ? `  seed ${d.seed}` : ''}`);
    if (d.href) out.push(`url ${d.href}`);
    out.push(`${this.total} error${this.total === 1 ? '' : 's'}, ${this.records.size} distinct`
      + (this.halted ? `  ·  STOPPED: ${this.haltedBecause}` : '  ·  still running'));
    for (const rec of this.records.values()) {
      out.push('');
      out.push(`[${rec.ref}]  ${rec.kind === 'rejection' ? 'unhandled rejection' : rec.name}`
        + `  ×${rec.count}` + (rec.count > 1 ? ` over ${rec.lastAtMs - rec.firstAtMs} ms` : ''));
      for (const m of rec.messages) out.push(`  ${m}`);
      if (rec.messages.length >= this.limits.maxMessages) out.push('  …and other wordings');
      for (const f of rec.frames) out.push(`    at ${f}`);
      if (!rec.frames.length) out.push('    (no stack — cross-origin script, or a thrown non-Error)');
    }
    const elided = this.total - Array.from(this.records.values()).reduce((a, r) => a + r.count, 0);
    if (elided > 0) out.push(`\n…and ${elided} further error${elided === 1 ? '' : 's'} whose detail was not kept.`);
    if (this.resourceFailures.length) {
      out.push('');
      out.push(`${this.resourceFailures.length} asset${this.resourceFailures.length === 1 ? '' : 's'} failed to load:`);
      for (const r of this.resourceFailures) out.push(`  ${r}`);
    }
    return out.join('\n');
  }

  /** The whole banner as text — player half then developer half. Tests read this. */
  text() {
    const head = this.halted ? PLAYER_LINES.halted : PLAYER_LINES.running;
    return `${head.join('\n')}\n\n${this.summary()}`;
  }

  /* ── the banner ────────────────────────────────────────────────────────── */

  /**
   * ⚠ EVERY STRING GOES IN THROUGH `textContent`. An error message can contain anything
   * — a callsign somebody typed, a URL, a fragment of JSON — and the one place in this
   * build guaranteed to be handed hostile text is the thing that reports hostile text.
   * There is no `innerHTML` in this file and there must not be one.
   */
  paint() {
    const doc = this.doc;
    if (!doc || !doc.body || !doc.createElement) return null;
    /* ⚠ THE BANNER IS NOT REBUILT PER ERROR. A per-frame throw with the halt disabled —
     * which is how the suite drives this — would otherwise rebuild eight DOM nodes sixty
     * times a second while reporting that the page is in trouble. Repaint only when the
     * thing being reported has actually changed. */
    const stamp = `${this.total}|${this.records.size}|${this.halted ? 1 : 0}|${this.resourceFailures.length}`;
    if (stamp === this._painted) return this._bannerEl || null;
    this._painted = stamp;
    let b = doc.getElementById && doc.getElementById(this.bannerId);
    if (!b) {
      b = doc.createElement('div');
      b.id = this.bannerId;
      /* Inline, because a page that failed to load its stylesheet still has to be able to
       * show this. It matches index.html's own #err-banner rule. */
      b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:60;padding:9px 14px;'
        + 'background:#5a1a14;color:#ffdcd6;font-family:ui-monospace,Consolas,monospace;'
        + 'font-size:12px;white-space:pre-wrap;max-height:40vh;overflow:auto';
      doc.body.appendChild(b);
    }
    b.style.display = 'block';
    /* Redundant across colour, shape and text (§18.1): the halted state is not merely a
     * darker red, it grows a border and its first word changes. */
    b.style.borderBottom = this.halted ? '3px solid #ff6a55' : '';
    b.setAttribute('role', 'alert');
    b.setAttribute('aria-live', 'assertive');
    b.setAttribute('data-cd-halted', this.halted ? '1' : '0');
    b.setAttribute('data-cd-errors', String(this.total));
    while (b.firstChild) b.removeChild(b.firstChild);

    const head = this.halted ? PLAYER_LINES.halted : PLAYER_LINES.running;
    const title = doc.createElement('strong');
    title.textContent = head[0];
    title.style.cssText = 'display:block;font-size:13px;letter-spacing:.06em;margin-bottom:4px';
    b.appendChild(title);
    for (const line of head.slice(1)) {
      const p = doc.createElement('span');
      p.style.cssText = 'display:block;margin-bottom:4px';
      p.textContent = line;
      b.appendChild(p);
    }

    /* Built before the buttons, because the copy fallback selects its contents. */
    const pre = doc.createElement('pre');
    pre.style.cssText = 'margin:0;white-space:pre-wrap;font:inherit;opacity:.9';
    pre.textContent = this.summary();

    /* ⚠ A `<span>` ROW, NOT A `<div>`. `tools/smoketest.ps1` and `tools/bench.ps1` pull the
     * crash text out of a dumped DOM with `id="err-banner"[^>]*>(.*?)</div>`, which stops
     * at the first `</div>` inside. Keeping every child a non-div keeps that extraction
     * whole, so a suite that dies before it reports still says why. */
    const row = doc.createElement('span');
    row.style.cssText = 'display:block;margin:6px 0';
    const btn = (label, fn) => {
      const el = doc.createElement('button');
      el.type = 'button';
      el.textContent = label;
      el.style.cssText = 'font:inherit;margin-right:8px;padding:3px 10px;cursor:pointer;'
        + 'background:#2a0f0c;color:#ffdcd6;border:1px solid #ff6a55;border-radius:4px';
      try { el.addEventListener('click', fn); } catch { /* detached document */ }
      return el;
    };
    row.appendChild(btn('Reload', () => { try { this.win.location.reload(); } catch { /* no location */ } }));
    row.appendChild(btn('Copy report', (e) => {
      const text = this.text();
      const nav = this.win && this.win.navigator;
      try {
        if (nav && nav.clipboard && nav.clipboard.writeText) {
          nav.clipboard.writeText(text);
          if (e && e.target) e.target.textContent = 'Copied';
          return;
        }
      } catch { /* clipboard denied: fall through to selecting it */ }
      /* No clipboard permission is normal on a file:// or an insecure origin, so the
       * fallback is to select the text and say so — never to silently do nothing. */
      try {
        const sel = this.doc.getSelection && this.doc.getSelection();
        const range = this.doc.createRange();
        range.selectNodeContents(pre);
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        if (e && e.target) e.target.textContent = 'Selected — press Ctrl+C';
      } catch { /* nothing more to offer */ }
    }));
    b.appendChild(row);
    b.appendChild(pre);
    this._bannerEl = b;
    return b;
  }

  /** The boundary broke. No DOM, no formatting, no further attempts. */
  _panic(e) {
    try {
      const b = this.doc && this.doc.getElementById && this.doc.getElementById(this.bannerId);
      if (b) {
        b.style.display = 'block';
        b.textContent = `The crash reporter itself failed: ${e && e.message ? e.message : e}`;
      }
    } catch { /* there is nothing left to try */ }
    this.shouldRender = false;
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */

  /** Attach to `window`. Returns `this`. */
  attach({ haltFrameLoop = true } = {}) {
    const win = this.win;
    if (!win || !win.addEventListener) return this;

    this._onError = (e) => {
      /* A failed resource load fires `error` on window during the capture phase with
       * `e.target` pointing at the element and no `e.error`. It is not an exception. */
      if (e && e.target && e.target !== win && !e.error && !e.message) {
        this.reportResource(e.target);
        return;
      }
      /* `e.error` is the real thing when the browser has it. Cross-origin scripts give
       * only `e.message === 'Script error.'` with no stack, and a synthetic Error built
       * from filename/lineno is the best identity available for those. */
      let err = e && e.error;
      if (!err) {
        err = new Error((e && e.message) || 'unknown error');
        err.name = 'ErrorEvent';
        err.stack = `${err.name}: ${err.message}\n    at ${(e && e.filename) || '(unknown)'}`
          + `:${(e && e.lineno) || 0}:${(e && e.colno) || 0}`;
      }
      this.report(err, 'error');
    };
    this._onRejection = (e) => { this.report(e && 'reason' in e ? e.reason : e, 'rejection'); };

    /* Capture phase: resource errors do not bubble, so a listener on the bubble phase
     * never sees a missing script at all. */
    win.addEventListener('error', this._onError, true);
    win.addEventListener('unhandledrejection', this._onRejection);

    if (haltFrameLoop && typeof win.requestAnimationFrame === 'function') {
      const raf = win.requestAnimationFrame.bind(win);
      this._restoreRaf = () => { win.requestAnimationFrame = raf; };
      const self = this;
      win.requestAnimationFrame = function guardedRaf(cb) {
        if (self.halted) return 0;
        return raf(cb);
      };
    }
    return this;
  }

  /** Undo `attach`. The suite uses it; the game never does. */
  restore() {
    const win = this.win;
    try {
      if (this._onError) win.removeEventListener('error', this._onError, true);
      if (this._onRejection) win.removeEventListener('unhandledrejection', this._onRejection);
    } catch { /* already gone */ }
    if (this._restoreRaf) { this._restoreRaf(); this._restoreRaf = null; }
    return this;
  }
}

/**
 * The one line `main.js` adds.
 *
 *   import { installCrashBoundary } from './core/crash.js';
 *   installCrashBoundary();
 *
 * and the twelve lines it removes: `firstError`, `errorCount`, `showError`, and the two
 * `window.addEventListener` calls that feed it. Both writing to `#err-banner` at once
 * would have them overwrite each other, and the older one keeps only the first message.
 */
export function installCrashBoundary(opts = {}) {
  const { haltFrameLoop = true, ...rest } = opts;
  const boundary = new CrashBoundary(rest);
  boundary.attach({ haltFrameLoop });
  try { globalThis.__CD_CRASH = boundary; } catch { /* frozen global */ }
  return boundary;
}
