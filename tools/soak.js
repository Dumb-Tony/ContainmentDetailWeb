/* Containment Detail — the soak test, page side.
 *
 * `tools/bench.js` measures a frame. Nothing measured an hour, and the two questions are
 * not the same question: a frame budget says whether the game is fast enough now, and a
 * soak says whether it is still that fast in forty minutes. GDD §23 Milestone 6 gates on
 * "crash, performance, networking and save-migration thresholds met", and a 30–45 minute
 * public-quality session (§26.4) is exactly the length at which a list nobody prunes
 * becomes visible.
 *
 * ⚠ A LEAK IN THIS BUILD LOOKS LIKE A LIST NOBODY PRUNES, and there is precedent. The
 * comms board grew a row per call for a whole operation because `PingBoard.encode()` sent
 * `this.list` raw and nothing expired it, so every snapshot carried every call the squad
 * had ever made — a wire cost that rose all mission and a board that never forgot. It was
 * fixed by capping the board per operative rather than by pruning, which is why the fixed
 * version is asserted here rather than assumed: `comms.encode().length` is one of the
 * counters below.
 *
 * WHAT THIS DOES:
 *   · runs every shipped Incident Package forward for a long SIMULATED duration
 *   · with a bot that actually plays — moves, calls, deploys, images, takes snapshots —
 *     because a game that is only stepped never touches the lists that grow
 *   · sampling every countable thing it can reach once a simulated minute
 *   · and reporting GROWTH PER SIMULATED MINUTE, per incident
 *
 * ⚠ THE COUNTERS ARE DISCOVERED, NOT LISTED. A hand-written list of lists to watch can
 * only find the leaks somebody already thought of, and the whole point is to find the next
 * one. `probe()` walks the object graph two levels down from the Game and records the
 * length of every array and the size of every Map and Set it meets, by path. A list added
 * next month is watched the day it appears. Six cross-module figures that no walk can
 * reach — the encoded wire size, the renderer's retained GPU objects, the HUD's DOM — are
 * added by hand on top.
 *
 * ⚠ AND IT MUST NOT BE ASYNCHRONOUS AFTER THE FIRST TASK, for the reason bench.js records
 * at length: `--dump-dom` fires on the load event, and a result produced in a later
 * microtask is a result the harness sometimes does not see. `fetch` is shimmed onto
 * synchronous XHR so the whole soak completes inside this module's own evaluation.
 */

import { CONFIG } from '../src/config.js';
import { loadContent, INCIDENTS } from '../src/sim/content.js';
import { Game, RECOMMENDED_MANIFEST, EVENTS } from '../src/game.js';
import { encodeSnapshot, applySnapshot } from '../src/net/protocol.js';
import { Renderer } from '../src/render/renderer.js';
import { Hud } from '../src/ui/hud.js';
import { PHRASES } from '../src/sim/comms.js';
import { mulberry32 } from '../src/core/rng.js';

const STEP_MS = CONFIG.sim.stepMs;

/** Read off the query string by soak.ps1, so a long run does not need a code change. */
const params = new URL(location.href).searchParams;
const MINUTES = Math.max(2, Number(params.get('minutes')) || 20);
const OPERATIVES = Math.max(1, Math.min(5, Number(params.get('ops')) || 3));
const ONLY = params.get('incident');
const WITH_RENDER = params.get('render') !== '0';

const lines = [];
const data = [];
const say = (s) => lines.push(s);

/* ── the synchronous fetch shim (see the header, and bench.js's) ─────────────── */
window.fetch = (input) => {
  const href = typeof input === 'string' ? input : String(input && input.url);
  const xhr = new XMLHttpRequest();
  xhr.open('GET', href, false);
  xhr.send(null);
  const body = xhr.responseText;
  const status = xhr.status || 200;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: xhr.statusText || '',
    url: href,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  });
};

/* ── A. the probe ─────────────────────────────────────────────────────────────
 *
 * Every array length and every Map/Set size within two levels of the Game, by path.
 *
 * ⚠ WHAT IT SKIPS AND WHY. Content is frozen and shared between the Game and the copy the
 * probe would walk, so `game.content.*` would contribute a few hundred constant counters
 * that can never move and would bury the six that can. `site` is walked because doors open
 * and circuits trip; `content` is not because nothing in it is writable. Functions,
 * typed arrays (the heat field is a fixed-size Float32Array by construction) and anything
 * that throws on access are skipped rather than guessed at.
 */
const SKIP_KEYS = new Set(['content', 'itemsById', 'items', 'map', 'anomalyDoc', 'bus_handlers']);

function countable(v) {
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  return null;
}

function probe(game, extra = {}) {
  const out = {};
  const visit = (obj, path, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 2) return;
    let keys;
    try { keys = Object.keys(obj); } catch { return; }
    for (const k of keys) {
      if (SKIP_KEYS.has(k)) continue;
      let v;
      try { v = obj[k]; } catch { continue; }   // a getter that throws is not a counter
      if (typeof v === 'function') continue;
      const n = countable(v);
      const p = path ? `${path}.${k}` : k;
      if (n !== null) { out[p] = n; continue; }
      if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) visit(v, p, depth + 1);
    }
  };
  visit(game, '', 0);
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

/* ── B. the bot ───────────────────────────────────────────────────────────────
 *
 * ⚠ STEPPING THE CLOCK IS NOT PLAYING, AND ONLY PLAYING GROWS A LIST. A soak that calls
 * `skipMs` for an hour touches the anomaly, the heat field and the sound field, and never
 * once touches the comms board, the notice feed, the deployable set, the evidence ledger
 * or the snapshot path — which is every list this test exists to watch. The first version
 * of this file reported that nothing at all grew, which was true and useless.
 *
 * So the bot acts, on a seeded stream so a growth figure is reproducible: it walks, calls,
 * deploys, retrieves, images, and takes a snapshot at the shipped rate. Everything it does
 * goes through the same verbs `src/main.js` reaches for.
 */
function makeBot(game, seed) {
  const rnd = mulberry32(seed);
  const phrases = Object.keys(PHRASES);
  let sinceCall = 0, sinceNotice = 0, sinceDeploy = 0, sinceSnap = 0, sinceImager = 0;
  /* A snapshot needs somewhere to land. Applying it to the SAME game would be a no-op
   * dressed up as a test; a second Game is the client, and it is where a wire-size leak
   * would actually show up as retained state. */
  return {
    /** @param {number} ms simulated milliseconds since the last call */
    act(ms) {
      sinceCall += ms; sinceNotice += ms; sinceDeploy += ms; sinceSnap += ms; sinceImager += ms;
      const t = game.clock.simTimeMs;

      for (const p of game.players) {
        game.setCommand(p.id, {
          axis: { x: rnd() * 2 - 1, y: rnd() * 2 - 1 },
          sprint: rnd() < 0.2, crouch: rnd() < 0.1,
          yaw: p.yaw + (rnd() - 0.5) * 0.4, pitch: 0,
        });
      }

      /* The board rate-limits to one call per operative per 700ms and caps three each, so
       * calling faster than that measures the limiter. 900ms is just past it. */
      if (sinceCall >= 900) {
        sinceCall = 0;
        const p = game.players[Math.floor(rnd() * game.players.length)];
        game.ping(p.id, phrases[Math.floor(rnd() * phrases.length)], p.x + rnd() * 4 - 2, p.z + rnd() * 4 - 2);
      }
      if (sinceNotice >= 2500) {
        sinceNotice = 0;
        /* Both feeds: `notices` rides the snapshot and `localNotices` never does, and they
         * are bounded by two different constants that have to be checked separately. */
        game.notice(`Soak notice at ${Math.round(t)}ms — a squad-wide line of the kind the mission emits.`);
        game.noticeLocal(`Soak refusal at ${Math.round(t)}ms — addressed to one operative.`);
      }
      if (sinceImager >= 4000) {
        sinceImager = 0;
        const p = game.players[0];
        if (game.imagerOnIds.has(p.id)) game.imagerOnIds.delete(p.id); else game.imagerOnIds.add(p.id);
      }
      if (sinceDeploy >= 6000) {
        sinceDeploy = 0;
        /* Deploy and retrieve in the same rhythm the squad would: a set that only ever
         * grows is a leak, and a set that grows and shrinks is a working inventory. */
        const p = game.players[Math.floor(rnd() * game.players.length)];
        /* `deployHeld` returns null on success and a refusal sentence otherwise, so a
         * truthy return is a refusal — the opposite of the obvious reading. */
        if (game.deployables.list.length > 3 && rnd() < 0.5) {
          const d = game.deployables.list[Math.floor(rnd() * game.deployables.list.length)];
          /* The same call `doInteract`'s 'retrieve' case makes. Going through `doInteract`
           * would require standing next to it, which is a pathfinding problem and not the
           * thing being measured. */
          if (d) game.deployables.remove(d);
        } else {
          for (let i = 0; i < 5 && game.deployHeld(p.id) !== null; i++) game.selectSlot(p.id, i);
        }
      }
      if (sinceSnap >= 1000 / CONFIG.net.snapshotHz) {
        sinceSnap = 0;
        this.lastSnap = encodeSnapshot(game);
        if (this.client) applySnapshot(this.client, this.lastSnap);
      }
    },
    lastSnap: null,
    client: null,
  };
}

/* ── C. the run ───────────────────────────────────────────────────────────────── */

function slope(samples, from, to) {
  if (to - from < 1) return 0;
  return (samples[to] - samples[from]) / (to - from);
}

function soakOne(pack, id) {
  const game = new Game(pack, { seed: `soak-${id}` });
  game.commitLoadout(RECOMMENDED_MANIFEST);
  for (let i = 1; i < OPERATIVES; i++) game.addPlayer(`Soak ${i + 1}`);
  const client = new Game(pack, { seed: `soak-client-${id}` });

  const bot = makeBot(game, 0xC0FFEE ^ id.length);
  bot.client = client;

  let renderer = null, hud = null, canvas = null, hudRoot = null;
  if (WITH_RENDER && window.THREE) {
    try {
      canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      canvas.style.cssText = 'position:fixed;left:-9999px;width:640px;height:360px';
      document.body.appendChild(canvas);
      hudRoot = document.createElement('div');
      hudRoot.style.cssText = 'position:fixed;left:-9999px;width:640px;height:360px';
      document.body.appendChild(hudRoot);
      renderer = new Renderer(window.THREE, canvas, game);
      hud = new Hud(hudRoot, game, renderer);
    } catch (e) {
      say(`  (no renderer for ${id}: ${e && e.message}) — GPU counters unavailable`);
      renderer = null; hud = null;
    }
  }

  const extras = () => {
    const e = {};
    /**
     * ⚠ THE WIRE, WHICH NO WALK OF THE GAME CAN SEE. The comms leak was invisible in
     * `comms.list` for as long as the board was read through `live()`, and visible the
     * instant anybody measured what `encode()` returned. Measure the wire.
     *
     * ⚠ AND BROKEN DOWN BY FIELD, because the first run of this file reported
     * `wire.snapshotBytes` still climbing at 156 bytes a minute after thirty minutes on
     * four of seven incidents — while every COUNT in the snapshot had plateaued. A total
     * that grows with nothing under it growing is a measurement that cannot be acted on.
     * One `JSON.stringify` per top-level key, once a minute, and the report names the
     * field instead of the sum.
     */
    try {
      const snap = encodeSnapshot(game);
      e['wire.snapshotBytes'] = JSON.stringify(snap).length;
      for (const [k, v] of Object.entries(snap)) e[`wire.snap.${k}`] = JSON.stringify(v).length;
    } catch { /* mid-step */ }
    try { e['wire.commsRows'] = game.comms.encode().length; } catch { /* ditto */ }
    if (renderer && renderer.renderer && renderer.renderer.info) {
      const info = renderer.renderer.info;
      e['gpu.geometries'] = info.memory.geometries;
      e['gpu.textures'] = info.memory.textures;
      if (info.programs) e['gpu.programs'] = info.programs.length;
      /**
       * ⚠ A GAUGE IS NOT A COUNTER, and reading one as the other produced four confident
       * false positives. `info.render.calls` is the draw-call count of the LAST frame and
       * three.js resets it at the top of every `render()`. It rises through a soak because
       * the scene fills with deployables and ice, which is the renderer working correctly.
       * `gauge.` prefixed counters are printed and excluded from the growth verdict.
       */
      e['gauge.renderCallsLastFrame'] = info.render.calls;
      e['gauge.trianglesLastFrame'] = info.render.triangles;
    }
    if (renderer && renderer.scene && renderer.scene.children) e['gpu.sceneChildren'] = renderer.scene.children.length;
    if (hudRoot) e['dom.hudNodes'] = hudRoot.querySelectorAll('*').length;
    return e;
  };

  const series = new Map();     // path -> number[] indexed by minute
  const record = (minute) => {
    const p = probe(game, extras());
    for (const [k, v] of Object.entries(p)) {
      let arr = series.get(k);
      if (!arr) { arr = new Array(MINUTES + 1).fill(null); series.set(k, arr); }
      arr[minute] = v;
    }
  };

  record(0);
  const SLICE_MS = 250;   // the bot gets to act four times a simulated second
  for (let m = 1; m <= MINUTES; m++) {
    for (let ms = 0; ms < 60000; ms += SLICE_MS) {
      game.skipMs(SLICE_MS);
      bot.act(SLICE_MS);
    }
    /* A frame, so the renderer's retained objects are the ones a played session retains
     * rather than the ones a never-drawn scene graph holds. Once a minute is enough:
     * geometry is allocated on first sight of a thing, not per frame. */
    if (renderer) { try { renderer.render(); hud.update(); } catch { /* a render failure is not a leak */ } }
    record(m);
  }

  const caps = knownCaps(game);
  if (canvas) {
    try { if (renderer && renderer.renderer && renderer.renderer.dispose) renderer.renderer.dispose(); } catch { /* r128 */ }
    canvas.remove();
  }
  if (hudRoot) hudRoot.remove();
  return { series, caps };
}

/* ── D. the report ────────────────────────────────────────────────────────────── */

/* Under this, a counter is noise: one item every ten minutes is a rounding artefact of
 * where a minute boundary fell, not a leak. Stated rather than hidden. */
const NOISE_PER_MIN = 0.1;

/**
 * The caps the code actually declares, read off the live objects rather than copied.
 *
 * ⚠ A RING THAT HAS NOT FILLED YET LOOKS EXACTLY LIKE A LEAK, and the first run of this
 * tool proved it: a four-minute soak reported `bus.log` STILL GROWING at 50 per minute,
 * which is true, and unbounded, which is false — `EventBus` is a ring of 256 and at fifty a
 * minute it fills at minute five. The soak was shorter than the largest ring in the build,
 * so the one thing it had time to observe was the filling.
 *
 * Two defences. A counter below a cap the code DECLARES is reported as filling rather than
 * as a leak, and a run too short to fill the largest declared cap says so at the top of its
 * own report. Neither is a substitute for running it long enough.
 */
function knownCaps(game) {
  const caps = {};
  try { caps['bus.log'] = game.bus.logSize; } catch { /* no bus */ }
  try { caps['anomaly.icePatches'] = 40; } catch { /* no anomaly */ }
  caps.notices = 40;                 // Game.notice
  caps.localNotices = 20;            // Game.noticeLocal
  try { caps['comms.list'] = game.comms.maxPerPlayer * Math.max(1, game.players.length); } catch { /* no board */ }
  try { caps['wire.commsRows'] = game.comms.maxPerPlayer * Math.max(1, game.players.length); } catch { /* ditto */ }
  /* `Certification.counts` is a Map keyed by EVENT TYPE, so it is bounded by the size of the
   * event vocabulary and not by how long anybody plays. It reads as growth for as long as
   * new kinds of event are still happening for the first time, which on a long operation is
   * most of the way through. Reported as filling, which is what it is. */
  caps['certification.counts'] = Object.keys(EVENTS).length;

  /**
   * ⚠ THREE COUNTERS THAT THIS TOOL REPORTED AS LEAKS AND ARE RAMPS TO A CAP — the exact
   * false positive the paragraph above describes, caught a second time by the same run.
   *
   * `anomaly.transitions` genuinely had no cap when the soak first ran and now has one; the
   * entry stays so the ramp toward it is reported as filling rather than re-reported as a
   * leak the next time somebody plays a flickering anomaly for half an hour.
   *
   * The other two are the SAME LIST seen through two lenses, which is why they climbed
   * together at four a minute and sixty-two bytes a minute on the gallery draught:
   * `_iceMeshes` grows to match `icePatches` and never shrinks — deliberately, it is a pool
   * and the surplus is hidden, not deleted — and every patch it draws is also a row in the
   * snapshot's `an.ic`. Both are bounded by the same forty. A soak reporting a mesh pool and
   * the wire field it mirrors as two independent leaks is a soak double-counting one number.
   */
  try { caps['anomaly.transitions'] = CONFIG.anomaly.transitionLogMax; } catch { /* older build */ }
  /* One id per operative who is currently on the floor and down. Bounded by the roster, and
   * it took a soak to notice that a LOST operative stays `downed` for ever and so never left
   * it — small, and the difference between "bounded by the squad" and "bounded by the squad,
   * eventually" is exactly what this tool is for. */
  caps['_downLogged'] = Math.max(1, game.players.length);
  /**
   * ⚠ A BYTE COUNT OF A NUMBER IS NOT A COUNTER, and the fraction guard cannot save it.
   * `wire.snap.pr` is `q3(mission.pressure)` — one quantised number, four or five characters
   * — and it gains a character as pressure climbs from 0 to 100. Half a byte a minute off a
   * base of five IS more than the 0.5%-a-minute floor, so the guard that catches a player's
   * coordinates gaining a digit does not catch this one: the base is too small for any
   * fraction to be meaningful. Bounded by the number of digits in the maximum.
   */
  caps['wire.snap.pr'] = String(CONFIG.pressure.max).length + 5;
  caps['gpu.sceneChildren'] = SCENE_FURNITURE + 40;
  caps['wire.snap.an'] = AN_BASE_BYTES + 40 * AN_ICE_BYTES;
  return caps;
}

/* The scene's fixed contents — lamp, target, anomaly body and halo, the map's own meshes —
 * measured on the largest shipped map rather than counted by hand, and rounded up. What is
 * being asserted is that the ICE POOL is bounded, not that the furniture is a specific
 * number, so a generous figure is the honest one. */
const SCENE_FURNITURE = 400;
/* `an` with no ice is 46-47 bytes; each `ic` row is three quantised numbers and a pair of
 * brackets. Both measured against `encodeSnapshot` rather than counted off the source. */
const AN_BASE_BYTES = 47;
const AN_ICE_BYTES = 22;

/**
 * ⚠ ONE ABSOLUTE THRESHOLD CANNOT SERVE A LIST AND A BYTE COUNT. Four entries a minute
 * added to an array is a leak; four BYTES a minute added to a two-kilobyte snapshot is the
 * player's coordinates gaining a digit as they walk away from the origin. Measured: the
 * lodger's `wire.snap.ps` grew 1.2 bytes a minute at the end of a thirty-minute run, off a
 * base of 777, and was reported as unbounded.
 *
 * So a counter also has to be growing by a meaningful FRACTION of itself: 0.5% a minute,
 * which is a doubling in about three hours. Anything slower than that cannot break the
 * 30-45 minute session §26.4 asks for, whatever its shape.
 */
const NOISE_FRACTION_PER_MIN = 0.005;

/**
 * ⚠ A TOTAL MUST NOT VOTE ALONGSIDE ITS OWN BREAKDOWN. `wire.snapshotBytes` is the sum of
 * the `wire.snap.*` rows printed directly under it, so when the debrief lands in the last
 * third of a run the total reads STILL GROWING while `wire.snap.rs` — the field that
 * actually moved, and the field somebody would go and fix — correctly reads "step at min
 * 30". Two verdicts, one cause, and the wrong one is the one in the summary.
 *
 * It is still printed, because the total is what the wire actually costs. It just does not
 * get a second vote in the verdict.
 */
const DERIVED = new Set(['wire.snapshotBytes']);

function report(id, series, caps) {
  const rows = [];
  for (const [path, arr] of series) {
    const first = arr[0], last = arr[MINUTES];
    if (first === null || last === null) continue;
    const grew = last - first;
    const perMin = grew / MINUTES;
    const early = slope(arr, 0, Math.max(1, Math.floor(MINUTES / 3)));
    const late = slope(arr, Math.floor((2 * MINUTES) / 3), MINUTES);
    /**
     * ⚠ A STEP IS NOT A SLOPE, and the difference is the whole verdict. Measured: the
     * snapshot's `rs` field is one byte until the mission ends and about 1,450 bytes for
     * every snapshot after it, because `encodeSnapshot` embeds the whole graded debrief in
     * `rs: game.result || 0`. That is a real and expensive finding — 1.4 kB twelve times a
     * second of an object that never changes again — and it is not a leak. It arrived in
     * one minute and stayed.
     *
     * Growth concentrated in a single sample is reported as a step change with the minute
     * it happened, so the reader goes looking for an event rather than for a missing
     * `.shift()`. The threshold is 60% of the total growth in one of thirty samples.
     */
    let biggestJump = 0, jumpAt = 0;
    for (let i = 1; i <= MINUTES; i++) {
      if (arr[i] === null || arr[i - 1] === null) continue;
      const d = arr[i] - arr[i - 1];
      if (d > biggestJump) { biggestJump = d; jumpAt = i; }
    }
    const isStep = grew > 0 && biggestJump >= grew * 0.6;
    rows.push({ path, first, last, perMin, early, late, isStep, jumpAt, biggestJump });
  }
  rows.sort((a, b) => Math.abs(b.perMin) - Math.abs(a.perMin));

  const growing = rows.filter((r) => r.perMin > NOISE_PER_MIN);
  say('');
  say(`--- ${id}: ${series.size} counters, ${MINUTES} simulated minutes, ${OPERATIVES} operative(s) ---`);
  if (!growing.length) {
    say('  nothing grew by more than 0.1 per simulated minute.');
  } else {
    say('  counter                                     start      end   per min   early    late   verdict');
    for (const r of growing) {
      /**
       * ⚠ THE VERDICT IS THE LATE SLOPE, NOT THE TOTAL. A bounded list fills up and then
       * stops: `notices` climbs to 40 in the first two minutes and never moves again, which
       * is a large total and a zero late slope. An unbounded one is still climbing at the
       * same rate at the end as at the start. The total says how big; only the shape says
       * whether it stops.
       */
      const cap = caps[r.path];
      let verdict;
      if (r.path.startsWith('gauge.')) verdict = 'gauge, not a counter';
      else if (r.late <= NOISE_PER_MIN) verdict = 'plateaued';
      else if (r.isStep) verdict = `step at min ${r.jumpAt} (+${r.biggestJump})`;
      else if (cap !== undefined && r.last < cap) verdict = `filling (cap ${cap})`;
      else if (r.late / Math.max(1, r.last) < NOISE_FRACTION_PER_MIN) verdict = 'drift, under 0.5%/min';
      else if (r.late < r.early * 0.5) verdict = 'slowing';
      else verdict = DERIVED.has(r.path) ? 'growing — see the breakdown below' : 'STILL GROWING';
      r.verdict = verdict;
      say(`  ${r.path.padEnd(42)}${String(r.first).padStart(6)}${String(r.last).padStart(9)}`
        + `${r.perMin.toFixed(2).padStart(10)}${r.early.toFixed(2).padStart(8)}${r.late.toFixed(2).padStart(8)}   ${verdict}`);
      data.push(`${id}|${r.path}|${r.first}|${r.last}|${r.perMin.toFixed(4)}|${r.late.toFixed(4)}|${verdict}`);
    }
  }
  return growing.filter((r) => r.verdict === 'STILL GROWING');
}

/* ── E. drive ─────────────────────────────────────────────────────────────────── */

function emit(tail) {
  const pre = document.getElementById('soak-out') || document.createElement('pre');
  pre.id = 'soak-out';
  pre.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#06080c;'
    + 'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
  if (!pre.parentNode) document.body.appendChild(pre);
  pre.textContent = '==CDSOAK-BEGIN==\n' + lines.join('\n') + '\n\n' + tail + '\n==CDSOAK-END==\n'
    + '==CDSOAK-DATA==\n' + data.join('\n') + '\n==CDSOAK-DATA-END==';
}

(async () => {
  say(`Containment Detail — soak, ${MINUTES} simulated minutes per incident, ${OPERATIVES} operative(s)`);
  say(`step ${STEP_MS.toFixed(3)}ms, snapshot ${CONFIG.net.snapshotHz}Hz, renderer ${WITH_RENDER ? 'on' : 'off'}`);
  /* ⚠ The whole run is synchronous, so under `--virtual-time-budget` neither `Date.now()`
   * nor `performance.now()` advances through it and a wall-clock figure printed here would
   * read 0.0s. It is not printed. `soak.ps1` times the process from outside, which is the
   * only clock that is telling the truth about this page. */
  if (MINUTES < 10) {
    say('');
    say('  !! SHORT RUN. The largest ring in this build is the event bus at 256 entries, which');
    say('     fills at about minute five. A run shorter than that observes only the filling and');
    say('     reports it as unbounded growth. Use -Minutes 20 or more for a verdict worth having.');
  }
  const unbounded = [];
  try {
    const list = ONLY ? [ONLY] : INCIDENTS.slice();
    for (const id of list) {
      const pack = await loadContent({ incident: id });
      const { series, caps } = soakOne(pack, id);
      const still = report(id, series, caps);
      for (const r of still) unbounded.push(`${id}: ${r.path} +${r.late.toFixed(2)}/min at the end`);
    }
  } catch (e) {
    say(`SOAK ABORTED: ${e && e.stack ? e.stack : e}`);
    emit('SOAK ABORTED');
    return;
  }

  say('');
  say('=== verdict ===');
  if (!unbounded.length) {
    say(`  Nothing was still growing at the end of the run, on any of ${ONLY ? 1 : INCIDENTS.length} incident(s).`);
    emit("SOAK-COMPLETE  no unbounded growth");
    return;
  }
  say(`  ${unbounded.length} counter(s) were still climbing at the same rate when the run ended:`);
  for (const u of unbounded) say(`    ${u}`);
  emit(`SOAK-UNBOUNDED  ${unbounded.length} counter(s)`);
})();
