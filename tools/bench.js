/* Containment Detail — the wall-clock performance harness, page side.
 *
 * GDD §23 Milestone 3 gates on "performance ... budgets pass", §27.1 on "performance is
 * measured in a representative mission" and §27.3 on it passing "with a full squad". None
 * of that is a yes/no a unit test can assert; it is a number, in milliseconds, against
 * 16.67. This file produces that number, and `tools/bench.ps1` is what drives it.
 *
 * WHAT IT MEASURES, and why in this shape:
 *   · one simulation step, broken down in `Game.step`'s own documented order, because that
 *     order is the only breakdown a reader can check against the source
 *   · the same, at one operative and at five — §11.1 supports 1-5 and nobody had run five
 *   · the same, on all five Incident Packages — the tally puts five extra sinks on the heat
 *     field and the caller runs the sound field across sixty-one occluders, and if the
 *     budget breaks anywhere it breaks there
 *   · the frame: `renderer.render()`, `hud.update()`, and the thermal floor on its own
 *   · the primitives underneath all of it, because "the anomaly costs 40us" is not
 *     actionable and "each of its 130 path samples costs 0.3us" is
 *
 * ⚠ THE INSTRUMENT IS THE HARD PART, AND THE FIRST VERSION OF IT LIED.
 *
 * `performance.now()` on this page is quantised to 100 MICROSECONDS. The page is not
 * cross-origin isolated (serve.ps1 sends no COOP/COEP headers and cannot be made to), so
 * Chrome clamps the timer as a Spectre mitigation. Measured here, every run, and printed
 * in section A. That is the whole of the "it reads 0.000us" trap a previous attempt hit:
 * a single `sound.levelAt` costs about 16us, which is a sixth of one tick of the only
 * clock available, so it reads ZERO — convincingly, repeatably, and wrongly.
 *
 * The fix is not a better clock. It is to time a BATCH and divide: every measurement below
 * is calibrated until the timed span is at least ~2ms, which puts quantisation under 5%.
 * `calibrate()` does that automatically, so the same source gives honest numbers on a
 * faster machine without anybody re-tuning a constant.
 *
 * ⚠ AND VIRTUAL TIME IS NOT THE CULPRIT, WHICH IS WORTH RECORDING BECAUSE IT WAS BLAMED.
 * The same synchronous benchmark was run with and without `--virtual-time-budget` in this
 * Chrome: 4e7 iterations of a fixed loop read 277.4ms real and 276.6ms virtual, and
 * `Date.now()` agreed with `performance.now()` to 1ms in both. Virtual time does not
 * freeze the clock through a synchronous loop here. What it DOES do is make `--dump-dom`
 * wait, which is why bench.ps1 keeps it: measured, a real-time run lost its result
 * entirely because the page's async continuation landed after the load event and the DOM
 * was dumped without it. Section A cross-checks `performance.now()` against `Date.now()`
 * over a known-slow loop on every run, so if a future Chrome ever does freeze it, this
 * refuses to report instead of inventing a number.
 *
 * ⚠ NOTHING HERE MAY BE ASYNCHRONOUS AFTER THE FIRST TASK. `fetch` is replaced with a
 * synchronous-XHR shim below so the whole benchmark — content load included — completes
 * inside the module's own evaluation, before the load event can fire. That is what makes
 * the dump deterministic rather than a race the harness wins most of the time.
 *
 * The file is `bench.js` and not `_bench.js` on purpose: `.gitignore` excludes `_*.js`
 * from the repo, and a benchmark nobody else can run is not evidence.
 */

import { CONFIG, SLOTS } from '../src/config.js';
import { loadContent, INCIDENTS } from '../src/sim/content.js';
import { Game } from '../src/game.js';
import { PHASE } from '../src/sim/mission.js';
import { Renderer } from '../src/render/renderer.js';
import { Hud } from '../src/ui/hud.js';
import { operativeSource, deployableSource } from '../src/sim/sound.js';
import { observedBy, operativeViewer, cameraViewer } from '../src/sim/perception.js';
import { dist } from '../src/sim/geometry.js';
import { THERMAL_FLOOR_RESOLUTION } from '../src/render/thermalFloor.js';

const FRAME_BUDGET_MS = 1000 / 60;     // 16.666..., the number the verdict is against
const STEP_MS = CONFIG.sim.stepMs;
const SQUAD_SIZES = [1, 5];            // GDD §11.1: one to five operatives

/* Everything measured accumulates into this, and it is printed. A loop whose result is
 * never read is a loop V8 is entitled to delete, and a deleted loop measures nothing. */
let SINK = 0;

const lines = [];
const data = [];                        // key|median|worst, for bench.ps1's run-to-run spread
const say = (s) => lines.push(s);
const fmt = (v, w = 8, dp = 3) => (v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(dp)).padStart(w);

/* ── the synchronous fetch shim ───────────────────────────────────────────────
 * See the header. Only `ok/status/statusText/json/text` are implemented because that is
 * the whole of what content.js touches; anything else should fail loudly rather than
 * quietly returning undefined. */
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

/* ── A. the instrument ───────────────────────────────────────────────────────── */

/** Smallest non-zero gap two back-to-back reads can see. This is the quantum. */
function timerQuantumMs() {
  let q = Infinity;
  for (let i = 0; i < 120000; i++) {
    const a = performance.now(), b = performance.now();
    const d = b - a;
    if (d > 0 && d < q) q = d;
  }
  return q;
}

/**
 * A loop whose cost is far above any plausible quantum, timed on both clocks — and run
 * until it stops getting faster.
 *
 * ⚠ THE MACHINE HAS TO BE SPUN UP OR THE FIRST RUN IS A DIFFERENT MACHINE. Two runs of
 * this harness back to back disagreed by 40-50% on EVERYTHING — every incident, every
 * system, every primitive, in the same direction — and the first was always the slow one.
 * That is not measurement noise, which would be scattered; it is a CPU coming off idle
 * clocks. Repeating the reference loop until consecutive timings agree to 3% burns the
 * ramp before anything is measured, and the first-to-best ratio below is printed because
 * it is also the honest bound on how much of any remaining spread is the machine.
 */
function instrumentCheck() {
  /**
   * ⚠ THIS USED TO TIME A SPIN LOOP, AND THE OPTIMISER ATE IT.
   *
   * It ran 4×10⁷ iterations of `Math.sqrt(i + acc * 1e-12)` ten times, breaking when two
   * consecutive runs agreed to 3%, and returned the LAST one. That measured 277 ms in the
   * morning and **0.0 ms in the afternoon**, on the same machine, with the same Chrome: once
   * V8 tiers the loop up it can see `acc * 1e-12` underflow to nothing and folds the body
   * away. The break condition never fires on a 200 → 0 → 0 sequence, so all ten ran and the
   * zero was returned — and the guard below correctly refused to report timings.
   *
   * The guard was right and the instrument was asking the wrong question. "Is the clock
   * working" is not answered by timing arithmetic; a loop that takes no time tells you
   * nothing about a clock, and any loop can be made to take no time.
   *
   * SO SPIN ON THE CLOCK ITSELF. Busy-wait until `Date.now()` has advanced by a target, and
   * measure the same span with `performance.now()`. The optimiser cannot elide a loop whose
   * condition reads the wall clock, and the thing being compared is the thing in question.
   */
  const TARGET_MS = 40;
  const d0 = Date.now();
  const p0 = performance.now();
  let spins = 0;
  let acc = 0;
  while (Date.now() - d0 < TARGET_MS) { spins++; acc += Math.sqrt(spins); }
  const dateMs = Date.now() - d0;
  const perfMs = performance.now() - p0;
  SINK += acc;
  return { perfMs, dateMs, first: perfMs, best: perfMs, spins };
}

/* ── B. the measurement primitive ────────────────────────────────────────────── */

/** Every sample whose timed span came out under this is quantisation, not measurement. */
const MIN_SPAN_MS = 1.0;
let thinSamples = 0;

/**
 * @returns {{med:number, worst:number, best:number, batch:number, samples:number, spanMs:number}}
 *   all per-repetition, in MILLISECONDS.
 *
 * MEDIAN AND WORST, never a mean: a frame budget is a promise about the bad frames, and a
 * mean is exactly the statistic that hides them. `worst` is the worst SAMPLE, and when
 * `batch` is above one that is a worst batch AVERAGE — it understates a true worst call
 * and the printed batch size is how a reader knows by how much.
 *
 * ⚠ `batch` IS GIVEN, NOT CALIBRATED, AND THAT IS THE SECOND THING THIS HARNESS GOT WRONG.
 * It used to time one call, work out how many would fill 2ms, and use that. Two problems,
 * both measured:
 *
 *   · calibrating before the warm-up timed COLD code, read half a millisecond for one
 *     simulation step, and settled on a batch of three. Every sample after that was three
 *     warm steps read through a 0.1ms clock, and the whole-step figures came out four to
 *     eight times the sum of their own parts. The medians were exact multiples of 100us,
 *     which is the tell: a real measurement is not that round.
 *   · fixing that left a subtler one. The batch a run chose depended on how that run's
 *     first timing happened to land, so run 1 measured 46-step batches and run 2 measured
 *     23-step ones — and because a batch runs the world forward, those are not two
 *     measurements of the same thing. The run-to-run spread was 25%.
 *
 * A fixed batch is reproducible by construction. The cost is that the numbers are chosen
 * for THIS machine, so `spanMs` is printed and anything that came in under 1ms is counted
 * and reported: on a machine four times faster, that count is how you know which batch
 * sizes need raising.
 */
function bench(key, fn, { before = null, batch = 100, samples = 21, warmBatches = 0 } = {}) {
  /* V8 deoptimises then reoptimises the first few hundred iterations of anything, so the
   * warm-up is real work, discarded — and it is sized in REPETITIONS rather than batches
   * so that a measurement with a batch of one still gets warmed. */
  const warm = warmBatches || Math.max(3, Math.ceil(600 / batch));
  for (let w = 0; w < warm; w++) {
    if (before) before();
    for (let k = 0; k < batch; k++) fn(k);
  }
  const out = [];
  let span = 0;
  for (let s = 0; s < samples; s++) {
    if (before) before();
    const t = performance.now();
    for (let k = 0; k < batch; k++) fn(k);
    const d = performance.now() - t;
    span += d;
    out.push(d / batch);
  }
  out.sort((a, b) => a - b);
  /* p95 as well as the max, because a frame budget wants "how bad do the bad ones get"
   * and the max of 121 samples is one GC pause away from being a story about the garbage
   * collector. Both are printed; neither is a mean. */
  const r = {
    med: out[out.length >> 1], p95: out[Math.min(out.length - 1, Math.floor(out.length * 0.95))],
    worst: out[out.length - 1], best: out[0],
    batch, samples, spanMs: span / samples,
  };
  if (r.spanMs < MIN_SPAN_MS) thinSamples++;
  if (key) data.push(`${key}|${r.med.toFixed(6)}|${r.worst.toFixed(6)}`);
  return r;
}

/** us, for anything that is not a whole frame. */
const us = (r) => `${fmt(r.med * 1000, 9)} ${fmt(r.worst * 1000, 9)}`;
const ms = (r) => `${fmt(r.med, 9)} ${fmt(r.worst, 9)}`;

/* ── C. a world to measure ───────────────────────────────────────────────────── */

function inAnyRect(rects, x, z, pad) {
  for (const r of rects) {
    if (x > r[0] - pad && x < r[2] + pad && z > r[1] - pad && z < r[3] + pad) return true;
  }
  return false;
}

/**
 * A standable point near (cx,cz). Spiralling outward rather than trusting a hand-picked
 * coordinate is what lets one setup serve three maps that share no geometry at all — a
 * literal offset that is open floor in the cold store is inside a wall in Ashlar.
 */
function freeSpotNear(site, cx, cz, radius, angle, pad = 0.45) {
  const b = site.bounds, rects = site.blockingRects();
  for (let k = 0; k < 26; k++) {
    const r = radius + k * 0.4;
    for (let a = 0; a < 8; a++) {
      const th = angle + a * (Math.PI / 4);
      const x = cx + Math.cos(th) * r, z = cz + Math.sin(th) * r;
      if (x <= b.minX + 0.8 || x >= b.maxX - 0.8 || z <= b.minZ + 0.8 || z >= b.maxZ - 0.8) continue;
      if (inAnyRect(rects, x, z, pad)) continue;
      return { x, z };
    }
  }
  return { x: cx, z: cz };
}

/** Face a point, in the game's own forward convention: forward is (-sin yaw, -cos yaw). */
const yawToward = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));

/**
 * A mid-operation world: a squad spread around the approach, a fence standing, the anomaly
 * in the most expensive state its content offers, and the imager lit.
 *
 * `deployables` is the fence GDD §10.6 actually builds — four floodlight tripods, the
 * transit case (which is itself a 39°C emitter) and a power pack. Six deployables is the
 * top of what a cargo budget of 11 pays for, so it is the right worst case.
 */
function buildWorld(content, { operatives, fence = true }) {
  const game = new Game(content, { seed: 'bench' });
  for (let i = 1; i < operatives; i++) game.addPlayer(`Bench ${i + 1}`);
  game.commitLoadout([{ itemId: 'thermal-imager', qty: 1 }]);

  const site = game.site;
  const anom = freeSpotNear(site, site.anomalySpawn.x, site.anomalySpawn.z, 0, 0, 0.35);
  const centre = { x: (site.spawn.x + anom.x) / 2, z: (site.spawn.z + anom.z) / 2 };

  if (fence) {
    const plan = [
      ['floodlight-tripod', 0], ['floodlight-tripod', Math.PI / 2],
      ['floodlight-tripod', Math.PI], ['floodlight-tripod', -Math.PI / 2],
      ['reinforced-transit-case', Math.PI / 4], ['power-pack', -Math.PI / 4],
    ];
    for (const [itemId, ang] of plan) {
      const it = game.itemsById.get(itemId);
      if (!it) continue;
      const s = freeSpotNear(site, anom.x, anom.z, 2.6, ang, 0.3);
      game.deployables.place(it, s.x, s.z, ang);
    }
  }

  const n = game.players.length;
  const ring = game.players.map((p, i) => {
    const ang = (i / n) * Math.PI * 2 + 0.35;
    const s = freeSpotNear(site, centre.x, centre.z, 3.2, ang, 0.4);
    return { x: s.x, z: s.z, yaw: yawToward(s.x, s.z, anom.x, anom.z) };
  });

  /* The most expensive state the content offers, because that is the one a budget has to
   * survive. Assigned rather than entered through `_enter`: entering is a game action with
   * side effects (telegraphs, transition records, pressure deltas) and this is a pin. */
  const states = content.anomaly.states;
  const worstState = states.find((s) => s.kind === 'hunting')
    || states.find((s) => s.kind === 'active')
    || states.find((s) => s.kind !== 'contained')
    || null;

  const w = { game, ring, anom, worstState, incident: content.incident.id };
  pose(w);
  return w;
}

/**
 * Put the world back exactly where the last sample found it.
 *
 * ⚠ WITHOUT THIS THE BENCHMARK MEASURES ITS OWN WAKE. Batches run thousands of steps: the
 * squad walks off the map, the floor drifts to its ambient floor, and — the one that
 * actually changes the answer — `stepPower` flattens every battery, at which point the
 * emitters go inactive and the heat field the anomaly is tested against has four fewer
 * sources in it. The step gets CHEAPER the longer you measure it.
 */
function pose(w) {
  const g = w.game;
  g.players.forEach((p, i) => {
    p.reset();
    const r = w.ring[i];
    p.x = r.x; p.z = r.z; p.yaw = r.yaw;
    /* Slot ids by their accepted bulk, not by index — the imager is `general` kit and a
     * belt pouch takes `compact`, and the HUD draws whatever it finds. */
    const gen = SLOTS.find((s) => s.accepts.includes('general'));
    const belt = SLOTS.find((s) => s.accepts.includes('compact'));
    if (gen) p.slots.set(gen.id, 'thermal-imager');
    if (belt) p.slots.set(belt.id, 'flashlight');
  });
  g.imagerOnIds.clear();
  g.imagerOnIds.add(g.players[0].id);
  g.observationHold.clear();

  const a = g.anomaly;
  a.x = w.anom.x; a.z = w.anom.z;
  if (w.worstState) { a.state = w.worstState.id; a.stateEnteredMs = 0; }
  a.sustain.clear(); a.lastUsed.clear();
  a.transitions.length = 0; a.icePatches.length = 0;
  a.contactCount = 0; a.sealedIn = null;
  a._slideSign = 0; a._progressTarget = null; a._bestDist = Infinity; a._stuckMs = 0;

  for (const d of g.deployables.list) { d.batteryMs = d.batteryMaxMs; d.on = true; d.fedByPack = false; }
  for (const i of g.instances.list) { i.state = 'loose'; i.carriedBy = null; }

  g.heat.ambientC = g.heat.baseAmbientC;
  g.custody = 'none';
  g.result = null;
  g.mission.pressure = CONFIG.pressure.max * 0.5;    // mid-operation, stage 3
  g.mission.phase = PHASE.INVESTIGATION;
}

/* Sixty-four axes on a circle. A constant axis walks the squad off the map inside one
 * batch; an orbiting one keeps every operative inside half a metre of where it started
 * and still runs the whole of `moveWithWalls` on every step. Precomputed so the trig is
 * not inside the timed region. */
const AXES = Array.from({ length: 64 }, (_, i) => {
  const t = (i / 64) * Math.PI * 2;
  return { x: Math.cos(t), y: Math.sin(t) };
});

/* Sample points for the field primitives, spread over the map. Precomputed for the same
 * reason, and deterministic so two runs sample the same places. */
function samplePoints(site, n = 256) {
  const b = site.bounds;
  let s = 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return Array.from({ length: n }, () => ({
    x: b.minX + rnd() * (b.maxX - b.minX),
    z: b.minZ + rnd() * (b.maxZ - b.minZ),
  }));
}

/* ── D. the systems, in Game.step's own order ────────────────────────────────── */

/**
 * One closure per numbered comment in `Game.step`. They call the same methods in the same
 * order with the same arguments — that is the only way a breakdown can be checked, and
 * section F cross-checks the sum against a measured whole step so a drifted copy shows up
 * as a gap rather than as a plausible table.
 */
function systemsOf(w) {
  const g = w.game;
  const pts = samplePoints(g.site);
  let simT = 8 * 60000;                 // eight minutes in: a representative mission clock

  const heatRebuild = () => {
    const emitters = g.deployables.heatEmitters();
    for (const p of g.players) if (p.alive) emitters.push({ ...p.heatSource(), active: true });
    g.heat.setEmitters(emitters);
    const sink = g.anomaly.asSink();
    g.heat.setSinks([...(sink ? [sink] : []), ...g.instances.sinks()]);
    g.heat.drift(STEP_MS, g.anomaly.isLoose);
    SINK += g.heat.emitters.length + g.heat.sinks.length;
  };

  const soundRebuild = () => {
    const heard = [];
    for (const p of g.players) {
      if (!p.alive) continue;
      const s = operativeSource(p);
      if (s) heard.push(s);
    }
    for (const d of g.deployables.list) {
      const s = deployableSource(d);
      if (s) heard.push(s);
    }
    g.sound.setSources(heard);
    g.sound.setOccluders(g.sound.occludersFor(g.site, g.deployables));
    SINK += g.sound.sources.length + g.sound.occluders.length;
  };

  const playerPass = (k) => {
    const blockers = g.site.blockingRects().concat(g.deployables.blockingRects());
    const axis = AXES[k & 63];
    for (const p of g.players) {
      if (!p.alive) continue;
      p.sprinting = false;
      p.crouching = false;
      p.stepDowned(STEP_MS, CONFIG.player.bleedOutMs);
      if (!p.incapacitated) {
        p.step(STEP_MS, axis, blockers, {
          onIce: g.anomaly.iceAt(p.x, p.z), assisted: false, dragging: false,
        });
      }
      p.stepStress(STEP_MS, {
        lightLevel: g.lightAt(p.x, p.z),
        anomalyDistance: dist(p.x, p.z, g.anomaly.x, g.anomaly.z),
        anomalyLoose: g.anomaly.isLoose,
      });
      SINK += p.x;
    }
  };

  /* Power, comms pruning and the carried-object pass. Not one of the seven the brief
   * names, and it has to be here anyway or the parts cannot sum to the whole. */
  const powerEtc = () => {
    g.deployables.stepPower(STEP_MS, g.anomaly);
    g.comms.prune(simT);
    g.instances.step(g.players);
    for (const id of g.imagerOnIds) {
      const p = g.playerById(id);
      if (p && p.alive) g.instances.verifyWithImager(g.heat, p.x, p.z);
    }
    SINK += g.deployables.list.length;
  };

  const perception = () => {
    const viewers = [];
    for (const p of g.players) if (p.alive && !p.downed) viewers.push(operativeViewer(p));
    for (const d of g.deployables.list) {
      if (d.itemId === 'remote-camera' && d.active) viewers.push(cameraViewer(d));
    }
    const o = observedBy(g.anomaly.x, g.anomaly.z, viewers, g.site.blockingRects());
    g.observation = o; g.viewers = viewers;
    SINK += o.count;
  };

  const anomalyStep = () => {
    const sources = [];
    for (const p of g.players) {
      if (p.alive) sources.push({ id: p.id, x: p.x, z: p.z, peakC: CONFIG.player.bodyHeatC });
    }
    for (const d of g.deployables.list) {
      if (d.isEmitter && d.active) sources.push({ id: d.uid, x: d.x, z: d.z, peakC: d.item.heatOutputCelsius });
    }
    const res = g.anomaly.step(STEP_MS, simT, {
      sources,
      operatives: g.players.filter((p) => p.alive),
      pressureStage: g.mission.stage,
      observation: g.observation,
      instances: g.instances,
      sound: {
        levelDb: g.sound.levelAt(g.anomaly.x, g.anomaly.z),
        heard: g.sound.loudestAudibleFrom(g.anomaly.x, g.anomaly.z),
      },
    });
    SINK += res.contacts.length;
  };

  const evidence = () => { g._stepEvidence(STEP_MS, simT); SINK += g.ledger.entries.length; };
  const custody = () => { SINK += g.anomaly.stepCustody(STEP_MS, simT).lost ? 1 : 0; };

  const pressure = () => {
    let nearest = Infinity;
    for (const p of g.players) if (p.alive) nearest = Math.min(nearest, dist(p.x, p.z, g.anomaly.x, g.anomaly.z));
    SINK += g.mission.stepPressure(STEP_MS, {
      anomalyLoose: g.anomaly.isLoose,
      anomalyAwake: g.anomaly.isAwake,
      operativeDistance: nearest,
      activeEmitters: g.deployables.list.filter((d) => d.isEmitter && d.active).length,
    });
  };

  /* One command object per axis, reused. main.js builds a fresh one per frame and so does
   * the netcode, but allocating five of them inside the timed loop would be measuring the
   * harness. */
  const CMDS = AXES.map((a) => ({ axis: a, sprint: false, crouch: false, yaw: 0, pitch: 0 }));

  /**
   * The whole thing, through the shipped entry point.
   *
   * ⚠ THE SQUAD HAS TO BE WALKING. Without a command every operative reads EMPTY_COMMAND,
   * stands still, and drops to `stillNoiseDb` 34 — at which point nothing on the floor is
   * audible over the room, `loudestAudibleFrom` returns on its first reject, and the
   * caller (the one anomaly that hunts on sound) measured 40% cheaper than the sum of its
   * own parts. A motionless squad is not a mission and it is not a budget either.
   *
   * `simT` is advanced by hand because `step` takes its time as an argument; leaving it
   * pinned at zero is the trap main.js records against `runBotShift`.
   */
  const wholeStep = (k) => {
    const cmd = CMDS[k & 63];
    for (const p of g.players) g.setCommand(p.id, cmd);
    simT += STEP_MS;
    g.step(STEP_MS, simT);
    SINK += g.mission.pressure;
  };

  /* The batch per system, and it is a real parameter rather than a tidy constant. Two
   * pressures pull against each other: a batch has to be long enough that the 100us clock
   * quantum is a rounding error — custody costs 40 NANOSECONDS, so it needs a hundred
   * thousand repetitions to clear the quantum by two orders of magnitude — and short
   * enough that the world has not walked away from the pose it was measured in. Only the
   * two that MOVE things are kept short: the squad orbits, so five hundred steps leaves it
   * within half a metre, and the anomaly does not, so it gets twenty-five. Everything else
   * either rebuilds from scratch or is idempotent, and `pose` puts back the two things a
   * long batch does change — the batteries and the ambient drift. */
  return {
    order: [
      ['1 heat field rebuild', heatRebuild, 8000],
      ['2 sound field rebuild', soundRebuild, 2000],
      ['3 player pass', playerPass, 1500],
      ['4 power, comms, carried', powerEtc, 8000],
      ['5 perception (observedBy)', perception, 4000],
      ['6 anomaly step', anomalyStep, 25],
      ['7 evidence', evidence, 6000],
      ['8 custody', custody, 100000],
      ['9 pressure', pressure, 30000],
    ],
    wholeStep,
    pts,
    resetClock: () => { simT = 8 * 60000; },
  };
}

/* ── E. output ───────────────────────────────────────────────────────────────── */

let out = null;
function emit(tail = '') {
  if (!out) {
    out = document.createElement('pre');
    out.id = 'bench-out';
    out.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#06080c;'
      + 'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(out);
  }
  out.textContent = '==CDBENCH-BEGIN==\n' + lines.join('\n') + (tail ? '\n' + tail : '')
    + '\n==CDBENCH-END==\n==CDBENCH-DATA==\n' + data.join('\n') + '\n==CDBENCH-DATA-END==\n';
}

/* ── the run ─────────────────────────────────────────────────────────────────── */

async function run() {
  /* A. the instrument, before anything trusts it. */
  const q = timerQuantumMs();
  const chk = instrumentCheck();
  say('--- A. the instrument ---');
  say(`  performance.now() quantum      ${fmt(q * 1000, 9)} us   (${q >= 0.05 ? 'CLAMPED — batching is mandatory' : 'fine grained'})`);
  say(`  clock cross-check: ${chk.spins.toLocaleString()} spins over ${chk.dateMs} ms of wall clock, `
    + `${chk.perfMs.toFixed(1)} ms of performance.now() — ${(100 * Math.abs(chk.perfMs - chk.dateMs) / chk.dateMs).toFixed(1)}% apart`);
  data.push(`machine|reference-loop|${chk.best.toFixed(3)}|${chk.best.toFixed(3)}`);
  say(`  hardwareConcurrency ${navigator.hardwareConcurrency}   devicePixelRatio ${window.devicePixelRatio}   viewport ${window.innerWidth}x${window.innerHeight}`);
  const frozen = chk.perfMs <= 0 || chk.dateMs <= 0 || Math.abs(chk.perfMs - chk.dateMs) > 0.25 * chk.dateMs + 5;
  if (frozen) {
    say('');
    say('  INSTRUMENT FAILED — performance.now() disagrees with the wall clock. Refusing to');
    say('  report timings. Run without --virtual-time-budget and check the Chrome version.');
    emit('INSTRUMENT FAILED');
    return;
  }
  say('  clocks agree — timings below are wall clock.');
  say('');

  /* B. every incident, at one operative and at five. */
  const worlds = [];
  say('--- B. one simulation step, whole, by incident and squad size ---');
  say('  incident                      ops  blockers  emitters  sinks  srcs  occl   median us   worst us   % frame');
  for (const id of INCIDENTS) {
    const content = await loadContent({ incident: id });
    for (const ops of SQUAD_SIZES) {
      const w = buildWorld(content, { operatives: ops });
      const s = systemsOf(w);
      const g = w.game;
      /* One pass of the rebuilds so the counts printed are the ones a step actually sees. */
      s.order[0][1](); s.order[1][1]();
      /* Thirty-two steps is about half a second of mission: long enough that a 0.1ms clock
       * reads it to within a couple of percent, short enough that the anomaly has not
       * crossed the room by the end of the sample. */
      const r = bench(`step|${id}|${ops}`, s.wholeStep, {
        before: () => { pose(w); s.resetClock(); }, batch: 32, samples: 41,
      });
      say(`  ${id.padEnd(26)} ${String(ops).padStart(3)} `
        + `${String(g.site.blockingRects().length).padStart(9)} ${String(g.heat.emitters.length).padStart(9)}`
        + `${String(g.heat.sinks.length).padStart(7)} ${String(g.sound.sources.length).padStart(5)}`
        + `${String(g.sound.occluders.length).padStart(6)}   ${us(r)}   ${fmt(100 * r.med / FRAME_BUDGET_MS, 6, 2)}%`);
      worlds.push({ id, ops, w, s, whole: r });
    }
  }
  say('');
  /* What the last batch of steps actually did. A step that ended the mission early-returns
   * and is nearly free, and a table of cheap numbers with no note saying the squad was
   * dead by sample four is the most convincing wrong answer this harness could give. */
  say('  what those steps did (last batch, so a mission that ended shows up here)');
  say('  incident                      ops  batch  phase           contacts  down  evidence  transitions  nearest m');
  for (const c of worlds) {
    const g = c.w.game;
    let near = Infinity;
    for (const p of g.players) if (p.alive) near = Math.min(near, dist(p.x, p.z, g.anomaly.x, g.anomaly.z));
    const down = g.players.filter((p) => p.downed || !p.alive).length;
    say(`  ${c.id.padEnd(26)} ${String(c.ops).padStart(3)} ${String(c.whole.batch).padStart(6)}  ${String(g.mission.phase).padEnd(16)}`
      + `${String(g.mission.tally.contacts).padStart(6)}${String(down).padStart(6)}${String(g.ledger.entries.length).padStart(10)}`
      + `${String(g.anomaly.transitions.length).padStart(13)}   ${fmt(near, 8, 2)}`);
  }
  say('');

  /* What the kit on the floor costs. Six deployables is what a cargo budget of 11 buys and
   * it is the difference between an empty floor and a built fence: four tripods and the
   * case are five more heat emitters, and the tripods, the case and the pack are five more
   * sound sources — every one of which is another term in both fields, every step.
   *
   * ⚠ THE DELTA CAN COME OUT NEGATIVE, AND THAT IS THE RESULT RATHER THAN AN ERROR. More
   * kit is unambiguously more terms in both fields, so a bare floor cannot be more work in
   * the fields — but it can be more work in the ANOMALY, because a fence is a short
   * circuit. `isFenced` stops at the first bearing that is walled off, and `chooseTarget`
   * picks the strongest source it can REACH, which with tripods down is a metre away and
   * with none is whichever operative is furthest across the map. The longer line is the
   * expensive one. So the fence costs a little in the fields and can save more than that
   * in the path tests, and the honest summary is that six deployables are within the noise
   * of no deployables at all. */
  say('  what the fence costs — five operatives, whole step, bare floor vs six deployables');
  say('  incident                     bare us    fenced us   delta us');
  for (const id of INCIDENTS) {
    const content = await loadContent({ incident: id });
    const bare = buildWorld(content, { operatives: 5, fence: false });
    const bs = systemsOf(bare);
    const rb = bench(`bare|${id}|5`, bs.wholeStep, {
      before: () => { pose(bare); bs.resetClock(); }, batch: 32, samples: 25,
    });
    const fenced = worlds.find((x) => x.id === id && x.ops === 5).whole;
    say(`  ${id.padEnd(26)} ${fmt(rb.med * 1000, 9, 1)} ${fmt(fenced.med * 1000, 12, 1)} ${fmt((fenced.med - rb.med) * 1000, 10, 1)}`);
  }
  say('');
  emit('running…');

  /* C. the breakdown, in Game.step's order, five operatives. */
  for (const ops of SQUAD_SIZES) {
    say(`--- C. one step broken down, ${ops} operative${ops === 1 ? '' : 's'} (us; median / worst) ---`);
    const cols = worlds.filter((x) => x.ops === ops);
    say('  system                        ' + cols.map((c) => c.id.slice(0, 17).padStart(19)).join(''));
    const sums = cols.map(() => 0);
    for (let i = 0; i < cols[0].s.order.length; i++) {
      const cells = [];
      cols.forEach((c, ci) => {
        const [label, fn, batch] = c.s.order[i];
        const r = bench(`sys|${label}|${c.id}|${ops}`, fn, {
          before: () => { pose(c.w); c.s.resetClock(); }, batch,
        });
        sums[ci] += r.med;
        cells.push(`${fmt(r.med * 1000, 9, 2)} /${fmt(r.worst * 1000, 8, 2)}`);
      });
      say('  ' + cols[0].s.order[i][0].padEnd(30) + cells.join(''));
    }
    say('  ' + 'sum of the nine'.padEnd(30) + sums.map((v) => fmt(v * 1000, 19, 2)).join(''));
    say('  ' + 'measured whole step'.padEnd(30) + cols.map((c) => fmt(c.whole.med * 1000, 19, 2)).join(''));
    /* DERIVED, not measured: everything in `step()` that is not one of the nine above —
     * notices, bus events, phase and endMission checks, and the contact loop. It is a
     * subtraction of two medians, so it carries both their errors and can come out
     * slightly negative when it is genuinely near zero. */
    say('  ' + 'the rest of step() [derived]'.padEnd(30) + sums.map((v, i) => fmt((cols[i].whole.med - v) * 1000, 19, 2)).join(''));
    say('  ' + 'nine / whole'.padEnd(30) + sums.map((v, i) => `${fmt(100 * v / cols[i].whole.med, 18, 0)}%`).join(''));
    say('');
    emit('running…');
  }

  /* D. the primitives everything above is made of. */
  say('--- D. field primitives, one sample (us; median / worst) ---');
  say('  Sampled at 256 points spread over the WHOLE map, which is the bulk-overlay case and');
  say('  not the in-step case: `sound.levelAt` prices every source against every occluder on');
  say('  the line, and the AABB reject in front of the slab test throws away almost every');
  say('  rect for a short line and almost none for a diagonal across the floor. The anomaly');
  say('  polls it from a metre or two away, which is the cheap end; a noise overlay would be');
  say('  paying the number below, per pixel.');
  say('  incident                   ops     heat.temperatureAt   sound.freeFieldLevelAt         sound.levelAt      heat.blocksPath 6m');
  for (const c of worlds) {
    const g = c.w.game, pts = c.s.pts;
    /* The fields have to be standing or these measure an empty sum. Section B's rebuilds
     * already ran on this world, but `pose` does not re-run them, so do it here. */
    c.s.order[0][1](); c.s.order[1][1]();
    const rT = bench(`prim|temperatureAt|${c.id}|${c.ops}`, (k) => { SINK += g.heat.temperatureAt(pts[k & 255].x, pts[k & 255].z); }, { batch: 20000 });
    const rF = bench(`prim|freeField|${c.id}|${c.ops}`, (k) => { SINK += g.sound.freeFieldLevelAt(pts[k & 255].x, pts[k & 255].z); }, { batch: 20000 });
    const rL = bench(`prim|levelAt|${c.id}|${c.ops}`, (k) => { SINK += g.sound.levelAt(pts[k & 255].x, pts[k & 255].z); }, { batch: 150 });
    const rB = bench(`prim|blocksPath|${c.id}|${c.ops}`, (k) => {
      const p = pts[k & 255];
      SINK += g.heat.blocksPath(p.x, p.z, p.x + 6, p.z) ? 1 : 0;
    }, { batch: 1000 });
    say(`  ${c.id.padEnd(26)} ${String(c.ops).padStart(3)} ${us(rT)} ${us(rF)} ${us(rL)} ${us(rB)}`);
  }
  say('');
  emit('running…');

  /* E. the frame. A new canvas per incident: `new WebGLRenderer({canvas})` on a canvas
   * that already has a context gets the SAME context back, so reusing one would have
   * every incident after the first drawing the first one's scene. */
  /* ⚠ THIS USED TO SHIM `THREE.CapsuleGeometry` AND NO LONGER HAS TO, which is worth the
   * paragraph because the shim is how the bug was found. `renderer.js` _syncMates built a
   * teammate body as
   *
   *     new THREE.Mesh(new THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(...) : ..., mat)
   *
   * and `new THREE.CapsuleGeometry ? a : b` is not a feature test — `new` binds tighter
   * than `?:`, so it CONSTRUCTS first and only then asks whether the result is truthy.
   * CapsuleGeometry arrived in three r142 and this build ships r128, so the guard's own
   * fallback was unreachable and the first frame with a second operative in it threw
   * `THREE.CapsuleGeometry is not a constructor` — inside the rAF loop, so every frame.
   * Solo play never touched it, which is why it survived. Fixed by dropping one `new`.
   *
   * The shim went with it. On r128 the guard now falls through to CylinderGeometry on its
   * own, so section E measures the shipped path with nothing supplied — which is what it
   * was always supposed to be measuring. Section K13 in the suite greps for the shape. */

  say('--- E. frame cost, five operatives (ms; median / worst) ---');
  say(`  thermal floor is a fixed ${THERMAL_FLOOR_RESOLUTION}x${THERMAL_FLOOR_RESOLUTION} grid = ${THERMAL_FLOOR_RESOLUTION * THERMAL_FLOOR_RESOLUTION} samples per update, 10 Hz`);
  say('                                render, imager off      render, imager on     hud.update    thermalFloor');
  say('  incident                     med     p95     max     med     p95     max     med    p95      med    p95');
  const frames = [];
  for (const c of worlds.filter((x) => x.ops === 5)) {
    const g = c.w.game;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
    document.body.appendChild(canvas);
    const hudRoot = document.createElement('div');
    hudRoot.style.cssText = 'position:fixed;inset:0;pointer-events:none';
    document.body.appendChild(hudRoot);

    let renderer = null, hud = null, rOff = null, rOn = null, rHud = null, rFloor = null;
    try {
      renderer = new Renderer(window.THREE, canvas, g);
      hud = new Hud(hudRoot, g, renderer);
      let t = 8 * 60000;
      /* Sim time has to advance or the thermal floor's 100ms gate never opens and
       * `render()` is measured without the one thing in it that scales with the field. */
      const tick = () => { t += STEP_MS; g.clock.simTimeMs = t; };
      const beforeFrame = () => { pose(c.w); t = 8 * 60000; g.clock.simTimeMs = t; };

      /* Batch of one: a frame is already thousands of times the clock quantum, so these are
       * real individual frames and `worst` is a real worst frame rather than a batch mean. */
      g.imagerOnIds.clear();
      rOff = bench(`frame|render-off|${c.id}`, () => { tick(); renderer.render(); SINK += renderer._bobPhase || 0; },
        { before: beforeFrame, batch: 1, samples: 121, warmBatches: 60 });
      g.imagerOnIds.add(g.players[0].id);
      rOn = bench(`frame|render-on|${c.id}`, () => { tick(); renderer.render(); SINK += renderer._bobPhase || 0; },
        { before: beforeFrame, batch: 1, samples: 121, warmBatches: 60 });
      rHud = bench(`frame|hud|${c.id}`, () => { tick(); hud.update(); SINK += hudRoot.childElementCount; },
        { before: beforeFrame, batch: 200 });
      /* ⚠ FORCE THE GATE OPEN BY HAND, and it is not enough to pass everyMs = 0. The gate
       * is `simTimeMs - lastUpdateMs < everyMs`, and `beforeFrame` rewinds sim time to
       * eight minutes while `lastUpdateMs` is left wherever the previous batch pushed it —
       * so the difference goes NEGATIVE and every call after the first sample returned
       * immediately. It measured 0.025ms for 9,216 field samples, which is about sixty
       * times faster than the field can be read, and looked like a plausible small number
       * rather than an obvious zero. */
      rFloor = bench(`frame|thermalFloor|${c.id}`, () => {
        tick();
        renderer.thermalFloor.lastUpdateMs = -1e9;
        renderer.thermalFloor.update(g.heat, t, 0);
        SINK += renderer.thermalFloor.updates;
      }, { before: beforeFrame, batch: 4, samples: 41 });
      say(`  ${c.id.padEnd(26)}${fmt(rOff.med, 8)}${fmt(rOff.p95, 8)}${fmt(rOff.worst, 8)}  `
        + `${fmt(rOn.med, 8)}${fmt(rOn.p95, 8)}${fmt(rOn.worst, 8)}  `
        + `${fmt(rHud.med, 7)}${fmt(rHud.p95, 7)}  ${fmt(rFloor.med, 7)}${fmt(rFloor.p95, 7)}`);
      frames.push({ id: c.id, rOff, rOn, rHud, rFloor, whole: c.whole });
    } catch (e) {
      say(`  ${c.id.padEnd(28)} FAILED: ${e && e.message}`);
    } finally {
      if (renderer && renderer.renderer) {
        try { renderer.renderer.forceContextLoss(); } catch (e) { /* nothing to lose */ }
        try { renderer.renderer.dispose(); } catch (e) { /* already gone */ }
      }
      canvas.remove();
      hudRoot.remove();
    }
  }
  say('');

  /* F. the verdict. */
  say('--- F. the verdict, against a 16.67 ms frame ---');
  say('  A 60 Hz frame at CONFIG.sim.stepMs spends exactly one simulation step, one');
  say('  render and one hud.update. The thermal floor runs at 10 Hz, so it lands on one');
  say('  frame in six and is already inside the render figure on that frame.');
  say('');
  say('  step + render + hud, five operatives, in milliseconds');
  say('  incident                      median       p95       max   % of frame (median)   verdict');
  let worstFrame = null;
  for (const f of frames) {
    const med = f.whole.med + f.rOn.med + f.rHud.med;
    const p95 = f.whole.p95 + f.rOn.p95 + f.rHud.p95;
    const wrs = f.whole.worst + f.rOn.worst + f.rHud.worst;
    const pct = 100 * med / FRAME_BUDGET_MS;
    data.push(`frame|${f.id}|${med.toFixed(6)}|${p95.toFixed(6)}`);
    say(`  ${f.id.padEnd(26)} ${fmt(med, 9)} ${fmt(p95, 9)} ${fmt(wrs, 9)} ${fmt(pct, 17, 1)}%   ${p95 < FRAME_BUDGET_MS ? 'PASS' : 'FAIL'}`);
    if (!worstFrame || med > worstFrame.med) worstFrame = { id: f.id, med, p95, wrs, pct };
  }
  if (worstFrame) {
    say('');
    say(`  Most expensive incident with a full squad: ${worstFrame.id}`);
    say(`  ${worstFrame.med.toFixed(3)} ms of a ${FRAME_BUDGET_MS.toFixed(2)} ms frame — ${worstFrame.pct.toFixed(1)}% — p95 ${worstFrame.p95.toFixed(3)} ms, worst ${worstFrame.wrs.toFixed(3)} ms.`);
    say(`  Headroom at the median: ${(FRAME_BUDGET_MS / worstFrame.med).toFixed(1)}x.`);
    say(`  MILESTONE 3 PERFORMANCE GATE: ${worstFrame.wrs < FRAME_BUDGET_MS ? 'PASS — every sampled frame fit'
      : worstFrame.p95 < FRAME_BUDGET_MS ? 'PASS at p95; the worst single frame went over, see the max column'
        : 'FAIL'}`);
  }
  say('');
  say(`  ${thinSamples} of ${data.length} measurements timed a span under ${MIN_SPAN_MS.toFixed(1)} ms, where the`);
  say('  0.1 ms clock quantum is worth more than 10% — raise those batch sizes if this is');
  say('  not zero, and expect it to stop being zero on a machine much faster than this one.');
  say(`  sink ${SINK.toFixed(3)}   (printed so the optimiser cannot delete the work above)`);
  emit(`BENCH-COMPLETE  ${data.length} measurements`);
}

try {
  await run();
} catch (e) {
  say('');
  say(`BENCH ABORTED: ${e && e.stack ? e.stack : e}`);
  emit('BENCH ABORTED');
}
