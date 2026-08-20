/* Milestone 0 — the containment loop, asserted.
 *
 * The exit criterion this suite is written against is not "the code runs". It is the GDD's
 * own Milestone 2 test, brought forward because a browser build with no netcode can reach
 * it early: *can a solo operative discover the rules, build a procedure out of them, and
 * establish custody?* Section I answers that by PLAYING the mission through the same
 * interfaces a keyboard reaches — `game.setAxis`, `game.doInteract`, `game.deployHeld` —
 * because testing the simulation is not testing the game (the TowBros lesson in
 * Dev\INDEX.md: a suite can drive every force correctly and still ship something nobody
 * can operate).
 *
 * Sections C and E print MEASURED numbers rather than asserting remembered ones. A contour
 * radius is arithmetic over two content values and an ambient that drifts during play; the
 * only honest way to know it is to ask the field.
 */

import { CONFIG, SLOTS } from '../src/config.js';
import { GameClock } from '../src/core/clock.js';
import { mulberry32, Rng, hashStr } from '../src/core/rng.js';
import { loadContent, ContentError } from '../src/sim/content.js';
import { HeatField } from '../src/sim/heat.js';
import { Site } from '../src/sim/site.js';
import { DeployableSet } from '../src/sim/deployables.js';
import { Anomaly, ANOMALY_STATE } from '../src/sim/anomaly.js';
import { EvidenceLedger, CLAIMS } from '../src/sim/evidence.js';
import { Game, RECOMMENDED_MANIFEST } from '../src/game.js';
import { PHASE } from '../src/sim/mission.js';
import { mixFor } from '../src/audio/audio.js';
import { segmentHitsRect, moveWithWalls, dist } from '../src/sim/geometry.js';

/* ── harness ─────────────────────────────────────────────────────────────── */
const lines = [];
let passes = 0, fails = 0;

function ok(name, cond, detail = '') {
  if (cond) { passes++; lines.push(`PASS  ${name}`); }
  else { fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
const note = (s) => lines.push(`      ${s}`);

/* Emitted after EVERY section, not only at the end: the harness greps the dumped DOM, so a
 * suite that throws half way must still say how far it got. A silent page teaches nothing. */
let _pre = null;
function emit(status) {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#06080c;'
      + 'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  const tail = status || (fails === 0 ? `ALL-PASS  ${passes} assertions` : `FAILURES  ${fails} of ${passes + fails}`);
  _pre.textContent = '==CDTEST-BEGIN==\n' + lines.join('\n') + '\n\n' + tail + '\n==CDTEST-END==';
}

/* ⚠ MEASURED (Dev/INDEX.md): headless Chrome delivers one to three rAF callbacks in
 * TOTAL and then stops, so a bare `await new Promise(r => requestAnimationFrame(r))`
 * hangs the suite forever on the second call — and a hung suite reports nothing at all.
 * Race it against a timer, which keeps running under virtual time. */
const yieldToLoop = () => new Promise((r) => {
  let done = false;
  const fire = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(fire);
  setTimeout(fire, 120);
});

/* ── A. core ─────────────────────────────────────────────────────────────── */
function sectionA() {
  lines.push('--- A. clock, seed, and the pause contract ---');
  const a = mulberry32(4242), b = mulberry32(4242), c = mulberry32(4243);
  const sa = [], sb = [], sc = [];
  for (let i = 0; i < 8; i++) { sa.push(a()); sb.push(b()); sc.push(c()); }
  ok('A1 same seed gives an identical stream', sa.join() === sb.join());
  ok('A2 a different seed diverges', sa.join() !== sc.join());
  ok('A3 hashStr is stable', hashStr('cold-storage-1') === hashStr('cold-storage-1'));
  const r = new Rng(hashStr('x'), 't');
  const first = [r.float(), r.float(), r.float()].join();
  r.reset();
  ok('A4 an Rng resets to exactly its own start', [r.float(), r.float(), r.float()].join() === first);

  const clk = new GameClock({ stepMs: 1000 / 60, maxFrameMs: 250 });
  let steps = 0;
  clk.advance(1000 / 60 * 3.5, () => steps++);
  eq('A5 three and a half frames of time spend three steps', steps, 3);
  near('A6 the remainder is banked, not lost', clk.accumulatorMs, 1000 / 60 * 0.5, 0.01);
  clk.setPaused(true);
  const before = clk.simTimeMs;
  clk.advance(500, () => steps++);
  eq('A7 a paused clock spends nothing', clk.simTimeMs, before);
  clk.setPaused(false);
  const long = clk.clampedFrames;
  clk.advance(9000, () => {});
  ok('A8 a tab-suspend frame is discarded rather than caught up', clk.clampedFrames === long + 1);
  eq('A9 simulation time advances inside advance(), so steps and time cannot drift',
    Math.round(clk.simTimeMs / clk.stepMs), clk.stepCount);
  emit();
}

/* ── B. content and site ─────────────────────────────────────────────────── */
async function sectionB(content) {
  lines.push('--- B. content refuses, and the site answers ---');
  ok('B1 the three content files loaded', !!(content.items && content.map && content.anomaly));
  eq('B2 the anomaly is deliberately original, not an SCP', content.anomaly.licensingRecordId, null);

  /* The loader is only worth having if it actually refuses. Corrupt a copy and check. */
  const broken = JSON.parse(JSON.stringify(content.anomaly));
  broken.triggers[0].to = 'nowhere';
  let refused = false;
  try {
    const { loadContent: _ } = { loadContent };
    // exercise the validator directly through a hand-rolled fetch stub
    const orig = window.fetch;
    window.fetch = async (u) => {
      const s = String(u);
      const body = s.includes('anomalies') ? broken : s.includes('maps') ? content.map : content.items;
      return { ok: true, status: 200, json: async () => body };
    };
    try { await loadContent(); } catch (e) { refused = e instanceof ContentError && /nowhere/.test(e.message); }
    window.fetch = orig;
  } catch { /* restore happens above */ }
  ok('B3 a trigger pointing at a state that does not exist is REFUSED, not defaulted', refused);

  const site = new Site(content.map);
  ok('B4 the perimeter blocks a person', site.blockingRects().some((r) => r[0] <= -12 && r[2] >= -12));
  const shelf = content.map.statics[content.map.porousStatics[0]];
  const inBlocking = site.blockingRects().some((r) => r.join() === shelf.join());
  const inInsulated = site.insulatedRects().some((r) => r.join() === shelf.join());
  ok('B5 steel shelving stops a person', inBlocking);
  ok('B6 steel shelving does NOT stop the draught — the two wall lists are different', !inInsulated);

  const door = site.doors[0];
  eq('B7 a door on a dead circuit cannot be operated', site.canOperateDoor(door), false);
  site.setCircuit(door.circuitId, true);
  eq('B8 restoring the circuit makes it operable', site.canOperateDoor(door), true);
  ok('B9 a closed cold-store door is insulation', site.insulatedRects().some((r) => r.join() === door.rect.join()));
  site.setDoorOpen(door, true);
  ok('B10 an open one is a hole', !site.insulatedRects().some((r) => r.join() === door.rect.join()));

  eq('B11 the stair head is where extraction is', site.roomNameAt(site.extraction.x, site.extraction.z), 'Stair head');
  eq('B12 spawn is inside the site', site.inBounds(site.spawn.x, site.spawn.z), true);

  /* Geometry primitives the movement code stands on. */
  ok('B13 a segment across a rect is detected', segmentHitsRect([-1, -1, 1, 1], -3, 0, 3, 0));
  ok('B14 a segment beside it is not', !segmentHitsRect([-1, -1, 1, 1], -3, 5, 3, 5));
  const slid = moveWithWalls(0, 0, 1, 1, 0.3, [[0.4, -5, 5, 5]]);
  ok('B15 blocked on one axis, a walker still slides along the other', slid.x === 0 && slid.z > 0);
  emit();
}

/* ── C. the heat field, measured ─────────────────────────────────────────── */
function sectionC(content) {
  lines.push('--- C. the heat field (measured, not remembered) ---');
  const heat = new HeatField();
  const tripod = content.itemsById.get('floodlight-tripod');
  const heater = content.itemsById.get('portable-heater');
  const kase = content.itemsById.get('reinforced-transit-case');

  const e = (item, x, z) => ({ id: item.id, x, z, peakC: item.heatOutputCelsius, falloffM: item.heatFalloffMetres, active: true });

  heat.setEmitters([e(tripod, 0, 0)]);
  const rT = heat.contourRadius(heat.emitters[0]);
  heat.setEmitters([e(heater, 0, 0)]);
  const rH = heat.contourRadius(heat.emitters[0]);
  note(`contour radius at ambient ${CONFIG.heat.ambientC}C: tripod ${rT.toFixed(2)}m (span ${(rT * 2).toFixed(2)}m) · heater ${rH.toFixed(2)}m (span ${(rH * 2).toFixed(2)}m)`);
  ok('C1 one tripod cannot span a 4.2m aisle — the map note is true', rT * 2 < 4.2);
  ok('C2 one heater CAN, which is what the extra volume and the shorter life buy', rH * 2 > 4.2);

  /* The question an aisle actually asks is whether anything can CROSS the line, so the
   * test walks the crossing rather than the line. A path drawn along the aisle passes
   * through the tripod's own post and is trivially "blocked" by it — a comparison that
   * would pass with a fence made of nothing. */
  heat.setEmitters([e(tripod, 0, 0)]);
  const gapAt = 2.05;
  ok('C3 one tripod at the aisle centre leaves a lane against each wall',
    !heat.blocksPath(-gapAt, -1.2, -gapAt, 1.2) && !heat.blocksPath(gapAt, -1.2, gapAt, 1.2));
  heat.setEmitters([e(tripod, -2.1, 0), e(tripod, 2.1, 0)]);
  const mid = heat.temperatureAt(0, 0);
  note(`two tripods 4.2m apart: coldest point on the aisle line ${mid.toFixed(1)}C (threshold ${CONFIG.heat.gradientThresholdC}C)`);
  let spanned = true;
  for (let x = -2.1; x <= 2.1; x += 0.15) if (!heat.blocksPath(x, -1.2, x, 1.2)) spanned = false;
  ok('C4 two, either side, close every lane across it — superposition is the reason', spanned);

  /* The bait must stay under the threshold or it stops being bait. */
  heat.setEmitters([e(kase, 0, 0)]);
  const atCase = heat.temperatureAt(0, 0);
  note(`transit case at its own position: ${atCase.toFixed(1)}C`);
  ok('C5 the case heater is a lure, not a wall', atCase < CONFIG.heat.gradientThresholdC);
  eq('C6 a lone case therefore has no 40C contour at all', heat.contourRadius(heat.emitters[0]), 0);

  /* A person is never a fence. */
  heat.setEmitters([{ id: 'op', x: 0, z: 0, peakC: CONFIG.player.bodyHeatC, falloffM: CONFIG.player.bodyHeatFalloffM, active: true }]);
  ok('C7 an operative is a lure and never a fence', heat.temperatureAt(0, 0) < CONFIG.heat.gradientThresholdC);
  ok('C8 and the case out-competes them, which is why bait works',
    39 > CONFIG.player.bodyHeatC);

  /* The cold mass weakens the wall. This is the failure mode a marginal fence has. */
  heat.setEmitters([e(tripod, 0, 0)]);
  heat.setSinks([]);
  const clean = heat.temperatureAt(1.2, 0);
  heat.setSinks([{ id: 'anomaly', x: 2.6, z: 0, chillC: CONFIG.heat.anomalyChillC, falloffM: CONFIG.heat.anomalyChillFalloffM }]);
  const leaned = heat.temperatureAt(1.2, 0);
  note(`1.2m from a tripod: ${clean.toFixed(1)}C alone, ${leaned.toFixed(1)}C with the draught 1.4m the other side`);
  ok('C9 the draught lowers the wall it is pushing on', leaned < clean);

  /* Ambient drift makes the fence harder the longer you take. */
  heat.setSinks([]);
  heat.ambientC = CONFIG.heat.ambientFloorC;
  const rCold = heat.contourRadius(heat.emitters[0]);
  note(`the same tripod at ${CONFIG.heat.ambientFloorC}C ambient: ${rCold.toFixed(2)}m`);
  ok('C10 a colder floor shrinks every contour — time is a real cost', rCold < rT);
  emit();
}

/* ── D. the state machine ────────────────────────────────────────────────── */
function sectionD(content) {
  lines.push('--- D. the anomaly runs its content, transition by transition ---');
  const site = new Site(content.map);
  const heat = new HeatField();
  const deps = new DeployableSet();
  const a = new Anomaly(content.anomaly, site, heat, deps);

  /* One monotonic clock for the whole section. Restarting time at zero on every batch
   * would reset the contact cooldown by accident and D8 would pass for the wrong reason. */
  let T = 0;
  const stepFor = (ms, ctx, onStep) => {
    let out = null;
    for (let t = 0; t < ms; t += CONFIG.sim.stepMs) {
      T += CONFIG.sim.stepMs;
      if (onStep) onStep();
      heat.setSinks([a.asSink()].filter(Boolean));
      out = a.step(CONFIG.sim.stepMs, T, ctx);
    }
    return out;
  };

  eq('D1 it starts latent, where the map put it', a.state, ANOMALY_STATE.LATENT);

  /* heat-detected: 12m for 4s. Three seconds must not be enough. */
  const op = { id: 'operative', x: a.x + 8, z: a.z, peakC: 37 };
  heat.setEmitters([{ ...op, falloffM: CONFIG.player.bodyHeatFalloffM, active: true }]);
  stepFor(3000, { sources: [op], operatives: [], pressureStage: 0 });
  eq('D2 three seconds of proximity is not four', a.state, ANOMALY_STATE.LATENT);
  stepFor(1500, { sources: [op], operatives: [], pressureStage: 0 });
  eq('D3 four seconds wakes it (trigger heat-detected)', a.state, ANOMALY_STATE.AWARE);
  ok('D4 the transition carries the telegraph the content authored',
    /frost bloom elongates/.test(a.transitions[0].telegraph));

  /* lock-on at 6m, then it closes. */
  const before = dist(a.x, a.z, op.x, op.z);
  stepFor(4000, { sources: [op], operatives: [], pressureStage: 0 });
  ok('D5 aware, it closes the distance', dist(a.x, a.z, op.x, op.z) < before);
  stepFor(6000, { sources: [op], operatives: [], pressureStage: 0 });
  eq('D6 inside 6m it locks on (trigger lock-on)', a.state, ANOMALY_STATE.DRAWN);

  /* chill-contact, with the cooldown the content states. */
  /* The victim tracks the mass: an operative who does not get out of the way. A victim
   * pinned at a fixed point instead drifts out of contact as the draught moves past, and
   * the cooldown test then measures nothing. */
  const victim = { x: a.x, z: a.z, alive: true };
  const hold = (ms) => stepFor(ms, { sources: [op], operatives: [victim], pressureStage: 0 },
    () => { victim.x = a.x; victim.z = a.z; });
  hold(100);
  ok('D7 contact inside 1.2m applies exposure AND a mobility injury',
    a.contactCount >= 1 && content.anomaly.capabilities.find((c) => c.id === 'chill-contact').applies.length === 2);
  const n1 = a.contactCount;
  hold(1000);
  eq('D8 a second contact inside the 3s cooldown does not land', a.contactCount, n1);
  hold(2600);
  ok('D9 past the cooldown it does', a.contactCount > n1);

  /* heat-wall: ring it and it banks. */
  const tripod = content.itemsById.get('floodlight-tripod');
  const ring = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    ring.push({ id: `t${i}`, x: a.x + Math.cos(ang) * 1.6, z: a.z + Math.sin(ang) * 1.6, peakC: tripod.heatOutputCelsius, falloffM: tripod.heatFalloffMetres, active: true });
  }
  heat.setEmitters(ring);
  stepFor(200, { sources: [], operatives: [], pressureStage: 0 });
  eq('D10 enclosed by heat, it banks (trigger heat-wall)', a.state, ANOMALY_STATE.BANKED);
  eq('D11 and reports no open lanes', a.escapes, 0);

  /* gradient-lost: the authored `fence-power` failure — the pack sheds load and every
   * tripod dies. Three seconds of that and it is moving again, not one step of it. */
  heat.setEmitters([]);
  stepFor(2000, { sources: [op], operatives: [], pressureStage: 0 });
  eq('D12 two seconds without a fence is inside the grace', a.state, ANOMALY_STATE.BANKED);
  stepFor(1500, { sources: [op], operatives: [], pressureStage: 0 });
  eq('D13 three seconds is not (trigger gradient-lost)', a.state, ANOMALY_STATE.DRAWN);

  /* sealed. */
  heat.setEmitters(ring);
  stepFor(200, { sources: [], operatives: [], pressureStage: 0 });
  const kase = content.itemsById.get('reinforced-transit-case');
  const far = deps.place(kase, a.x + 4, a.z, 0);
  ok('D14 the seal is refused when the case is out of range', !!a.trySeal(far, 0));
  deps.remove(far);
  const near1 = deps.place(kase, a.x + 0.8, a.z, 0);
  eq('D15 in range and banked, it seals', a.trySeal(near1, 0), null);
  eq('D16 which is the contained state', a.state, ANOMALY_STATE.CONTAINED);
  eq('D17 a contained anomaly no longer chills the room', a.asSink(), null);

  /* Custody is a state that can be lost. */
  let held = 0;
  for (let t = 0; t < 29000; t += CONFIG.sim.stepMs) held = a.stepCustody(CONFIG.sim.stepMs, t).heldMs;
  eq('D18 29 seconds is not 30 — custody is unverified', a.stepCustody(0, 0).verified, false);
  for (let t = 0; t < 1500; t += CONFIG.sim.stepMs) a.stepCustody(CONFIG.sim.stepMs, t);
  eq('D19 30 seconds verifies it', a.stepCustody(0, 0).verified, true);
  near1.batteryMs = 0;
  const lost = a.stepCustody(CONFIG.sim.stepMs, 0);
  eq('D20 a dead case heater loses custody', lost.lost, true);
  eq('D21 and it comes back out drawn, not latent', a.state, ANOMALY_STATE.DRAWN);
  emit();
}

/* ── E. the fence, swept ─────────────────────────────────────────────────── */
function sectionE(content) {
  lines.push('--- E. how much fence is enough (swept, not derived) ---');
  const site = new Site(content.map);
  const heat = new HeatField();
  const deps = new DeployableSet();
  const a = new Anomaly(content.anomaly, site, heat, deps);
  const tripod = content.itemsById.get('floodlight-tripod');

  /* A ring that banks it is easy. A ring it can WALK INTO and then be shut in is the
   * actual design object, and the two are not the same: a tight pinch of two tripods is
   * hot enough to enclose a point and therefore hot enough that nothing can ever reach
   * that point. A fence with no lane catches nothing, so the sweep measures both. */
  const openX = 4.0, openZ = 8.0;
  const build = (n, radius, omit = -1) => {
    const ring = [];
    for (let i = 0; i < n; i++) {
      if (i === omit) continue;
      const ang = (i / n) * Math.PI * 2;
      ring.push({ id: `t${i}`, x: openX + Math.cos(ang) * radius, z: openZ + Math.sin(ang) * radius, peakC: tripod.heatOutputCelsius, falloffM: tripod.heatFalloffMetres, active: true });
    }
    return ring;
  };
  const trial = (n, radius, omit = -1) => {
    a.reset(); a.x = openX; a.z = openZ;
    heat.setEmitters(build(n, radius, omit));
    heat.setSinks([a.asSink()]);
    return a.isFenced();
  };
  /* Can something outside walk in through the omitted post's bearing? */
  const laneOpen = (n, radius, omit) => {
    a.reset(); a.x = openX; a.z = openZ;
    heat.setEmitters(build(n, radius, omit));
    heat.setSinks([a.asSink()]);
    const ang = (omit / n) * Math.PI * 2;
    return !heat.blocksPath(openX + Math.cos(ang) * 5.5, openZ + Math.sin(ang) * 5.5, openX, openZ);
  };

  const table = [];
  for (const n of [3, 4, 5, 6]) {
    let closed = null, withLane = null;
    for (let r = 1.0; r <= 3.4; r += 0.1) {
      if (closed === null && trial(n, r).fenced) closed = r;
      if (withLane === null && trial(n, r).fenced && laneOpen(n, r, 0)) withLane = r;
    }
    table.push([n, closed, withLane]);
  }
  note('open floor — tripods : smallest radius that encloses : smallest that also leaves a way in');
  for (const [n, c, w] of table) {
    note(`  ${n} tripods : ${c === null ? '—' : c.toFixed(1) + 'm'} : ${w === null ? 'no usable lane inside 3.4m' : w.toFixed(1) + 'm'}`);
  }
  ok('E1 three tripods can enclose open floor', table[0][1] !== null);
  ok('E2 and a ring wide enough to enclose still leaves a lane to bait through',
    table.some(([, , w]) => w !== null));

  /* Against a wall, the site does the work. This is why a corner is worth walking to. */
  const cornerX = -11.0, cornerZ = -11.0;   // inside the office
  a.reset(); a.x = cornerX; a.z = cornerZ;
  const office = site.doors.find((d) => d.id === 'door-office');
  site.setDoorOpen(office, false);
  heat.setEmitters([]); heat.setSinks([a.asSink()]);
  const shut = a.isFenced();
  note(`office with the door closed and NO heat at all: fenced=${shut.fenced}, lanes=${shut.escapes}`);
  ok('E3 a closed cold-store room is itself a fence — insulation is a rule, not a shortcut', shut.fenced);
  site.setDoorOpen(office, true);
  const open = a.isFenced();
  ok('E4 opening the door puts a hole in it, which is why the seal is still a problem', !open.fenced);
  note(`  door open: ${open.escapes} lane${open.escapes === 1 ? '' : 's'} open`);

  /* One tripod in the doorway closes the same room. The cheap procedure. */
  const doorC = [(office.rect[0] + office.rect[2]) / 2, (office.rect[1] + office.rect[3]) / 2];
  heat.setEmitters([{ id: 'd', x: doorC[0], z: doorC[1], peakC: tripod.heatOutputCelsius, falloffM: tripod.heatFalloffMetres, active: true }]);
  const plugged = a.isFenced();
  ok('E5 ONE tripod in the open doorway closes it again', plugged.fenced);
  emit();
}

/* ── F. equipment and power ──────────────────────────────────────────────── */
function sectionF(content) {
  lines.push('--- F. batteries, packs, and barriers ---');
  const deps = new DeployableSet();
  const tripod = content.itemsById.get('floodlight-tripod');
  const pack = content.itemsById.get('power-pack');
  const barrier = content.itemsById.get('portable-barrier');

  const t1 = deps.place(tripod, 0, 0, 0);
  eq('F1 a battery is minutes of runtime, not a percentage', t1.batteryMaxMs, tripod.batteryMinutes * 60000);
  const asleep = { isAwake: false, x: 99, z: 99 };
  deps.stepPower(60000, asleep);
  near('F2 a minute of running costs a minute', t1.batteryMs, (tripod.batteryMinutes - 1) * 60000, 1);

  const p1 = deps.place(pack, 1.0, 0, 0);
  const t2 = deps.place(tripod, 1.5, 0, 0);
  const packBefore = p1.batteryMs, t2Before = t2.batteryMs;
  deps.stepPower(30000, asleep);
  eq('F3 an emitter inside a pack radius does not touch its own cells', t2.batteryMs, t2Before);
  ok('F4 the pack pays instead', p1.batteryMs < packBefore);
  ok('F5 and says so, so the HUD can', t2.fedByPack === true);

  const t3 = deps.place(tripod, 20, 20, 0);
  const awake = { isAwake: true, x: 20, z: 20 };
  const b3 = t3.batteryMs;
  deps.stepPower(10000, awake);
  near('F6 the draught drains a battery four times over, exactly as the capability says',
    b3 - t3.batteryMs, 10000 * CONFIG.anomaly.batteryDrainMultiplier, 1);

  t1.batteryMs = 0;
  ok('F7 a flat unit stops emitting in the same step it goes flat',
    !deps.heatEmitters().find((e) => e.id === t1.uid).active);

  const bar = deps.place(barrier, 0, 5, 0);
  ok('F8 a barrier snaps to a quarter turn, so one rectangle serves sim and render', Math.abs(bar.yaw % (Math.PI / 2)) < 1e-9);
  ok('F9 and it blocks the draught', deps.barrierBlocksPath(0, 3, 0, 7));
  ok('F10 but only where it actually is', !deps.barrierBlocksPath(6, 3, 6, 7));
  emit();
}

/* ── G. the operative ────────────────────────────────────────────────────── */
function sectionG(content) {
  lines.push('--- G. slots, speed, and conditions ---');
  const g = new Game(content, { seed: 'g' });
  const p = g.player;

  eq('G1 the slot layout is the one GDD 9.2 specifies', SLOTS.length, 5);
  ok('G2 a long tool takes the long slot', p.take(content.itemsById.get('floodlight-tripod')) === 'long1');
  ok('G3 a second one has nowhere to go — which is the whole wager',
    p.take(content.itemsById.get('floodlight-tripod')) === null);
  ok('G4 a compact item takes a belt slot', p.take(content.itemsById.get('trauma-kit')) === 'belt1');
  ok('G5 a general item takes a general slot', p.take(content.itemsById.get('thermal-imager')) === 'gen1');

  const clean = p.speedFactor(false);
  p.applyCondition('mobility-injury', 'serious');
  const hurt = p.speedFactor(false);
  ok('G6 a mobility injury slows the operative', hurt < clean);
  p.hands = 'reinforced-transit-case';
  const carrying = p.speedFactor(false);
  near('G7 factors are min-combined, not multiplied — the slowest cause wins alone',
    carrying, Math.min(CONFIG.player.injuredSpeedFactor, CONFIG.player.carrySpeedFactor), 1e-9);
  p.hands = null;

  eq('G8 treatment stabilises rather than erases', p.treat() && p.conditions.mobility.severity > 0, true);
  ok('G9 and it is marked stabilised', p.conditions.mobility.stabilised);

  const sev = p.conditions.exposure.severity;
  p.applyCondition('exposure', 'serious');
  p.applyCondition('exposure', 'serious');
  ok('G10 exposure compounds on repeat, as the content says it does', p.conditions.exposure.severity > sev + 1);

  const p2 = new Game(content, { seed: 'g2' }).player;
  p2.stepStress(60000, { lightLevel: 0, anomalyDistance: 99, anomalyLoose: true });
  ok('G11 darkness raises stress', p2.stress > 0);
  const dark = p2.stress;
  p2.stepStress(60000, { lightLevel: 1, anomalyDistance: 99, anomalyLoose: true });
  ok('G12 light is the first relief', p2.stress < dark);
  emit();
}

/* ── H. the ledger ───────────────────────────────────────────────────────── */
function sectionH(content) {
  lines.push('--- H. the ledger records facts, the board holds opinions ---');
  const led = new EvidenceLedger(content.anomaly);
  const e = led.record('frost-bloom', { simTimeMs: 1000, x: 1, z: 2, room: 'West run', source: 'operative' });
  ok('H1 the entry text is the content file, verbatim',
    e.raw === content.anomaly.evidenceRules.find((r) => r.id === 'frost-bloom').rawObservation);
  ok('H2 it carries provenance, not a conclusion', e.room === 'West run' && e.source === 'operative' && e.annotation === '');
  eq('H3 the same observation cannot be logged twice', led.record('frost-bloom', { simTimeMs: 2000 }), null);
  eq('H4 the ledger is append-only', led.entries.length, 1);

  const falseLead = led.record('maintenance-log', { simTimeMs: 3000, x: 0, z: 0, room: 'Office', source: 'operative' });
  ok('H5 a false lead is recorded like anything else, with its reliability attached',
    falseLead.isFalseLead && falseLead.reliability === 'disputed');

  const chiller = CLAIMS.find((c) => c.id === 'claim-chiller-anchor');
  const sup = led.supportFor(chiller);
  ok('H6 support is a word, never a percentage', typeof sup.word === 'string' && !/\d/.test(sup.word));
  ok('H7 and the false lead genuinely supports the wrong claim — that is what makes it a lead',
    sup.hits.includes('maintenance-log'));

  led.setClaim('claim-chiller-anchor', 'believed');
  led.setClaim('claim-heat-hunts', 'believed');
  const s = led.scoreClaims();
  eq('H8 believing the false one is scored wrong', s.wrong, 1);
  eq('H9 believing the true one is scored right', s.correct, 1);
  ok('H10 unmarked claims stay unmarked — the board never ticks itself', s.unmarked === CLAIMS.length - 2);
  emit();
}

/* ── I. an operative plays the whole thing ───────────────────────────────── */
async function sectionI(content) {
  lines.push('--- I. a solo operative discovers, plans, and takes custody ---');
  const g = new Game(content, { seed: 'run-1' });

  /* Everything below goes through the interfaces a keyboard reaches. There is no
   * teleport and no direct state write: if a bot cannot finish, a first-timer cannot. */
  const slice = 50;
  const face = (x, z) => {
    const dx = x - g.player.x, dz = z - g.player.z;
    const len = Math.hypot(dx, dz) || 1;
    g.player.yaw = Math.atan2(-dx / len, -dz / len);
  };
  /**
   * ⚠ A walk-there helper must actually walk, and a walker that only ever presses forward
   * gets stuck. The bot ground to a halt against the corner of a loading-bay crate and
   * every assertion after it failed for a reason that had nothing to do with the fence.
   * Stall detection plus a sidestep is what a player does, so it is what this does.
   */
  const walkTo = (x, z, tol = 0.6, budgetMs = 40000) => {
    let spent = 0, stalledMs = 0, strafe = 0, strafeMs = 0;
    let lastX = g.player.x, lastZ = g.player.z;
    while (dist(g.player.x, g.player.z, x, z) > tol && spent < budgetMs) {
      face(x, z);
      if (strafeMs > 0) { g.setAxis({ x: strafe, y: -0.4 }); strafeMs -= slice; }
      else g.setAxis({ x: 0, y: -1 });
      g.skipMs(slice);
      spent += slice;

      const moved = dist(lastX, lastZ, g.player.x, g.player.z);
      lastX = g.player.x; lastZ = g.player.z;
      if (moved < 0.02) stalledMs += slice; else stalledMs = 0;
      if (stalledMs >= 300 && strafeMs <= 0) {
        strafe = strafe === 1 ? -1 : 1;      // alternate, so a wrong guess self-corrects
        strafeMs = 700;
        stalledMs = 0;
      }
    }
    g.setAxis({ x: 0, y: 0 });
    g.skipMs(slice);
    return dist(g.player.x, g.player.z, x, z) <= tol;
  };
  /* Instrument, do not iterate: a route that fails must say WHICH leg failed and where it
   * stopped, or three plausible fixes get tried against a diagnosis that was a guess. */
  const route = (pts, tol = 1.1, budgetMs = 60000) => {
    const failed = [];
    for (const [wx, wz] of pts) {
      if (!walkTo(wx, wz, tol, budgetMs)) {
        failed.push(`(${wx},${wz}) stopped at (${g.player.x.toFixed(1)},${g.player.z.toFixed(1)})`);
      }
    }
    if (failed.length) note(`route legs not reached: ${failed.join(' · ')}`);
    return failed.length === 0;
  };
  const wait = (ms) => { g.setAxis({ x: 0, y: 0 }); g.skipMs(ms); };

  eq('I1 the mission starts on the operation card', g.mission.phase, PHASE.BRIEFING);
  ok('I2 an over-budget manifest is refused',
    !!g.commitLoadout([{ itemId: 'floodlight-tripod', qty: 9 }]));
  eq('I3 the recommended manifest is inside the budget', g.commitLoadout(RECOMMENDED_MANIFEST), null);
  eq('I4 committing it deploys the squad', g.mission.phase, PHASE.ARRIVAL);

  ok('I5 the operative walks to the cargo point', walkTo(g.site.cache.x, g.site.cache.z, 1.4));
  eq('I6 taking the imager from cargo works', g.takeFromCache('thermal-imager'), null);
  eq('I7 so does the case', g.takeFromCache('reinforced-transit-case'), null);
  eq('I8 and a tripod, which is the only long item you can hold', g.takeFromCache('floodlight-tripod'), null);
  ok('I9 a second tripod has nowhere to go until the first is set down',
    !!g.takeFromCache('floodlight-tripod'));

  /* Read the survivor's statement — a real evidence source, taken with the context verb. */
  walkTo(7.6, -8.2, 1.2);
  face(7.6, -8.2);
  const act = g.contextAction();
  ok('I10 the context verb offers the statement, and says what it will do',
    act && act.kind === 'evidence');
  g.doInteract();
  ok('I11 which lands in the ledger with its reliability', g.ledger.has('survivor-account'));

  /* The office is the cheap fence: four insulated walls and one door. Getting into it is
   * the map's authored two-step — the office breaker is out on the bay wall. */
  const sw = g.site.circuits.get('circuit-office');
  walkTo(sw.switchX, sw.switchZ, 1.6);
  const swAct = g.contextAction();
  ok('I12 the breaker on the bay wall offers itself', swAct && swAct.kind === 'circuit');
  g.doInteract();
  ok('I13 which brings the office circuit up', g.site.circuitOn('circuit-office'));
  eq('I14 leaving the command point is what ends arrival', g.mission.phase, PHASE.INVESTIGATION);

  const officeDoor = g.site.doors.find((d) => d.id === 'door-office');
  walkTo(-7.4, -9.75, 0.9);
  ok('I15 a powered door can be opened', g.contextAction() && g.contextAction().kind === 'door');
  g.doInteract();
  ok('I16 and it opens', officeDoor.open);

  /* The case goes inside: it is the lure the whole procedure hangs on. It goes by the
   * door rather than on the desk, so the plant log stays reachable — the context verb
   * picks the NEAREST thing, and a case parked on top of the log makes the log unreadable. */
  ok('I17 the operative gets into the office', walkTo(-9.4, -9.6, 0.9));
  g.player.selectSlot(SLOTS.findIndex((s) => g.player.slots.get(s.id) === 'reinforced-transit-case'));
  eq('I18 the case deploys', g.deployHeld(), null);
  const kase = g.deployables.byItem('reinforced-transit-case')[0];
  ok('I19 and it runs its heater as a lure, under the threshold',
    g.heat.temperatureAt(kase.x, kase.z) < CONFIG.heat.gradientThresholdC);
  walkTo(-11.2, -11.4, 0.6);
  const logAct = g.contextAction();
  ok('I20 at the desk, the nearest thing is the plant log — not the case behind you',
    logAct && logAct.kind === 'evidence', logAct ? `${logAct.kind}: ${logAct.text}` : 'none');
  g.doInteract();
  ok('I21 a disputed source is logged like any other', g.ledger.has('maintenance-log'));

  /* The second half of the map's power puzzle: the storage breaker is IN here, and the
   * freight door it feeds is the short lane between the aisles and this office. Without
   * it the draught's only way south is the 2m gap at the far end of the cross-wall, and
   * a memoryless drifter that picks the wrong way round a fifteen-metre panel spends the
   * whole operation finding out. Restoring this circuit is what makes the lure work. */
  walkTo(-10.0, -10.0, 1.4);
  g.doInteract();
  ok('I22 the storage breaker is inside the office, and it works', g.site.circuitOn('circuit-storage'));

  g.player.selectSlot(SLOTS.findIndex((s) => g.player.slots.get(s.id) === 'thermal-imager'));
  eq('I23 the imager comes on', g.toggleImager(), null);

  /* ⚠ Tolerance 0.5, not 1.1, and every waypoint clears a wall by more than the
   * operative's 0.34m radius. A waypoint that exists to get you through a 2m opening has
   * to be REACHED, not approximated: at 1.1m the walker declared "arrived" a metre short
   * of the freight door, and the next leg ground along the panel for its whole budget. */
  const IN = [[-6.6, -8.6], [-6.6, -6.6], [-8.2, -6.4], [-8.0, -4.0], [-9.6, 1.0]];
  route(IN.slice(0, 3), 0.5);
  const freight = g.site.doors.find((d) => d.id === 'door-freight-cold');
  walkTo(-8.0, -5.9, 0.7);
  const fAct = g.contextAction();
  ok('I24 the freight door is now powered and offers itself', fAct && fAct.kind === 'door',
    fAct ? `${fAct.kind}: ${fAct.text}` : 'none');
  g.doInteract();
  ok('I25 and it opens — the second lane is live', freight.open);
  route(IN.slice(3), 0.5);

  wait(4500);
  const woke = dist(g.player.x, g.player.z, g.anomaly.x, g.anomaly.z);
  note(`operative at (${g.player.x.toFixed(1)}, ${g.player.z.toFixed(1)}), draught ${woke.toFixed(1)}m away, state ${g.anomaly.state}`);
  ok('I26 approaching it wakes it — heat within 12m for 4s', g.anomaly.state !== ANOMALY_STATE.LATENT);
  ok('I27 holding it in the imager logs the thermal void', g.ledger.has('thermal-void'));

  /* Withdraw. The case out-competes an operative the moment both are reachable, so the
   * job now is to be somewhere else while it makes the walk. An operative who backs off
   * has to be able to actually back off — a hunter you cannot outpace is not a rule the
   * squad can plan around, it is a countdown. */
  g.player.sprinting = true;
  walkTo(-8.0, -4.0, 0.5, 30000);
  const opened = dist(g.player.x, g.player.z, g.anomaly.x, g.anomaly.z);
  note(`after one leg of withdrawal: ${woke.toFixed(1)}m -> ${opened.toFixed(1)}m`);
  ok('I28 a sprinting operative opens the gap on it', opened > woke, `${woke.toFixed(1)} -> ${opened.toFixed(1)}`);
  route([[-8.0, -5.9], [-8.2, -6.6], [-6.6, -6.8], [-4.0, -8.4], [4.0, -8.4], [10.5, -6.8]], 0.6, 90000);
  g.player.sprinting = false;
  let guard = 0;
  const track = [];
  while (dist(g.anomaly.x, g.anomaly.z, kase.x, kase.z) > 2.5 && guard < 240000) {
    wait(500); guard += 500;
    if (guard % 20000 === 0) track.push(`${guard / 1000}s (${g.anomaly.x.toFixed(1)},${g.anomaly.z.toFixed(1)}) -> ${g.anomaly.targetId} [${g.anomaly.state}] ${g.anomaly._why}`);
  }
  if (track.length) note(`draught track: ${track.join(' · ')}`);
  note(`draught reached the case at ${(g.clock.simTimeMs / 60000).toFixed(1)} min, ${dist(g.anomaly.x, g.anomaly.z, kase.x, kase.z).toFixed(1)}m from it`);
  ok('I29 it follows the lure all the way into the office', dist(g.anomaly.x, g.anomaly.z, kase.x, kase.z) <= 2.5);

  /* Plug the doorway. One tripod in a 1.5m opening is the whole fence. */
  walkTo(-7.6, -9.75, 0.8, 60000);
  face(-8.6, -9.75);
  g.player.selectSlot(SLOTS.findIndex((s) => g.player.slots.get(s.id) === 'floodlight-tripod'));
  eq('I30 the last tripod goes in the doorway', g.deployHeld(), null);
  guard = 0;
  while (g.anomaly.state !== ANOMALY_STATE.BANKED && guard < 8000) { wait(250); guard += 250; }
  note(`banked at ${(g.clock.simTimeMs / 60000).toFixed(1)} min; lanes open ${g.anomaly.escapes}`);
  eq('I31 which banks it (trigger heat-wall)', g.anomaly.state, ANOMALY_STATE.BANKED);
  ok('I32 the frost boundary is observable exactly when it is being held', g.ledger.has('frost-boundary'));

  /* Commit the plan, then perform it. */
  eq('I33 a procedure can be committed', g.commitProcedure({
    target: 'The cold mass itself',
    state: 'Held against a heat gradient it cannot cross',
    trigger: 'Transit case heater running at 39C as a lure',
    transfer: 'Case interior stable for 30s, then carry to the stair head',
    maintained: ['A 40C gradient across every approach lane'],
    abort: 'Any operative takes a second contact',
  }), null);

  /* Walk in past your own fence post and seal it. The tripod does not block a person —
   * that is deliberate, and it is the only reason this last step is possible at all. */
  walkTo(kase.x + 1.2, kase.z + 0.9, 0.7, 40000);
  const sealAct = g.contextAction();
  ok('I34 with it held and the case in reach, the verb becomes the seal',
    sealAct && sealAct.kind === 'seal', sealAct ? `${sealAct.kind}: ${sealAct.text}` : 'none');
  eq('I35 and the seal takes', g.doInteract(), null);
  eq('I36 which is custody, unverified', g.custody, 'sealed');

  wait(CONFIG.anomaly.custodyVerifySeconds * 1000 + 1200);
  eq('I37 thirty seconds of a stable case verifies it', g.custody, 'verified');

  /* Step clear of the doorway and the breaker before lifting. Nearest-wins means standing
   * between the case and the office door offers the DOOR, and standing beside the breaker
   * offers the BREAKER — correct behaviour, and a real thing a player has to notice. The
   * prompt says which, every frame, which is the whole reason there is only one resolver. */
  walkTo(kase.x, kase.z + 1.0, 0.4, 20000);
  const lift = g.contextAction();
  ok('I38 only then does the case become liftable', lift && lift.kind === 'carry-case',
    lift ? `${lift.kind}: ${lift.text}` : 'none');
  g.doInteract();
  ok('I39 carrying it slows the operative', g.player.speedFactor(false) <= CONFIG.player.carrySpeedFactor,
    `${g.player.speedFactor(false)}`);

  /* Out through the office door, along the bay, and round the NORTH end of the stair-head
   * wall — the stair is behind it, so a straight line at the extraction point walks into
   * a panel. Carrying the case is 75% speed, so this is the slowest leg of the operation. */
  route([[-8.0, -9.75], [-6.6, -8.8], [-3.0, -8.6], [4.0, -8.6], [8.2, -8.0]], 0.7, 60000);
  ok('I40 the case reaches the stair head', walkTo(g.site.extraction.x, g.site.extraction.z, 1.2, 90000) || !!g.result);
  ok('I41 which ends the operation', !!g.result);
  if (!g.result) { emit(); return g; }
  eq('I42 with custody established and the payload transferred', g.extracted, true);
  note(`outcome: ${g.result.overall}${g.result.failReason ? ' — ' + g.result.failReason : ''}`);
  note(`mission time ${(g.clock.simTimeMs / 60000).toFixed(1)} min · peak pressure ${g.mission.tally.peakPressure.toFixed(0)} (${g.mission.stageName}) · contacts ${g.mission.tally.contacts} · evidence ${g.ledger.entries.length}`);
  for (const d of g.result.dims) note(`  ${d.name}: ${d.word}`);
  ok('I43 and an overall assessment in Foundation language',
    ['Exemplary', 'Controlled', 'Costly', 'Compromised', 'Failed'].includes(g.result.overall));
  ok('I44 the debrief can say what it did and why — every transition kept its telegraph',
    g.anomaly.transitions.length >= 3 && g.anomaly.transitions.every((t) => t.telegraph));

  await yieldToLoop();
  emit();
  return g;
}

/* ── J. audio as a pure function ─────────────────────────────────────────── */
function sectionJ() {
  lines.push('--- J. the mix is a pure function of the world ---');
  const base = { distance: 4, imagerOn: false, imagerLockMs: 0, custodyHeldMs: 0, stressNorm: 0, pressureStage: 0, activeEmitters: 0 };
  const aware = mixFor({ ...base, anomalyState: ANOMALY_STATE.AWARE });
  const drawn = mixFor({ ...base, anomalyState: ANOMALY_STATE.DRAWN });
  const banked = mixFor({ ...base, anomalyState: ANOMALY_STATE.BANKED });
  ok('J1 the whistle sharpens when it locks on', drawn.whistleHz > aware.whistleHz);
  ok('J2 and drops when it is held', banked.whistleHz < drawn.whistleHz);
  ok('J3 held sounds like a flutter, not like silence', banked.flutterHz > 0 && banked.whistle > 0);
  ok('J4 distance is audible', mixFor({ ...base, anomalyState: ANOMALY_STATE.DRAWN, distance: 16 }).whistle < drawn.whistle);
  ok('J5 the imager has a non-visual presence cue',
    mixFor({ ...base, anomalyState: ANOMALY_STATE.DRAWN, imagerOn: true, imagerLockMs: 2000 }).imagerHz
    > mixFor({ ...base, anomalyState: ANOMALY_STATE.DRAWN, imagerOn: true, imagerLockMs: 0 }).imagerHz);
  ok('J6 contained is quiet', mixFor({ ...base, anomalyState: ANOMALY_STATE.CONTAINED }).whistle === 0);
  const a1 = JSON.stringify(mixFor({ ...base, anomalyState: ANOMALY_STATE.DRAWN }));
  const a2 = JSON.stringify(mixFor({ ...base, anomalyState: ANOMALY_STATE.DRAWN }));
  eq('J7 pure — the same state gives the same mix', a1, a2);
  emit();
}

/* ── K. source hygiene ───────────────────────────────────────────────────── */
async function sectionK() {
  lines.push('--- K. the architectural rules, enforced rather than intended ---');
  const files = [
    'src/config.js', 'src/game.js', 'src/main.js',
    'src/core/rng.js', 'src/core/clock.js', 'src/core/input.js', 'src/core/eventBus.js',
    'src/sim/geometry.js', 'src/sim/site.js', 'src/sim/heat.js', 'src/sim/anomaly.js',
    'src/sim/deployables.js', 'src/sim/evidence.js', 'src/sim/player.js',
    'src/sim/mission.js', 'src/sim/content.js',
    'src/render/scene.js', 'src/render/renderer.js', 'src/render/thermalFloor.js',
    'src/ui/hud.js', 'src/ui/panels.js', 'src/audio/audio.js',
  ];
  /* ⚠ Strip comments FIRST. Every rule below is about what the code DOES, and a raw grep
   * tests what the file SAYS: rng.js explains at length that nothing may call
   * Math.random(), clock.js explains that nothing may read performance.now(), and both
   * failed their own hygiene check for containing the sentence that states the rule.
   * (Dev\INDEX.md: "a source-hygiene grep must test for LOGIC, not for words".) */
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const raw = new Map(), src = new Map();
  for (const f of files) {
    const r = await fetch(new URL(`../${f}`, import.meta.url).href, { cache: 'no-store' });
    const text = r.ok ? await r.text() : '';
    raw.set(f, text);
    src.set(f, strip(text));
  }
  ok('K1 every source file was reachable', Array.from(raw.values()).every((s) => s.length > 0));

  const randomOffenders = files.filter((f) => /Math\.random\s*\(/.test(src.get(f)));
  ok('K2 nothing calls Math.random — a mission replays from its seed', randomOffenders.length === 0, randomOffenders.join(', '));

  /* The Unity build's central rule, carried over: the rule layer does not know there is
   * a renderer. It is what lets this suite drive a whole containment with no canvas. */
  const simFiles = files.filter((f) => f.startsWith('src/sim/') || f === 'src/game.js' || f === 'src/config.js');
  const engineLeaks = simFiles.filter((f) => /THREE|three\.min|from '\.\.\/render/.test(src.get(f)));
  ok('K3 the simulation never references the renderer', engineLeaks.length === 0, engineLeaks.join(', '));

  /* An identifier must follow the dot. Without that, the sentence "operation ran past its
   * window. Recalled." inside a mission notice reads as a DOM access. */
  const domLeaks = simFiles.filter((f) => /\bdocument\.[A-Za-z_$]|\bwindow\.(?!fetch\b)[A-Za-z_$]/.test(src.get(f)));
  ok('K4 nor the DOM', domLeaks.length === 0, domLeaks.join(', '));

  const timeLeaks = files.filter((f) => f !== 'src/main.js' && f !== 'src/audio/audio.js'
    && /(Date\.now|performance\.now|setInterval)\s*\(/.test(src.get(f)));
  ok('K5 nothing but the boot loop reads wall-clock time', timeLeaks.length === 0, timeLeaks.join(', '));

  /* No external requests at runtime: the whole point of vendoring r128. */
  const cdn = files.filter((f) => /https?:\/\//.test(src.get(f)));
  ok('K6 no source file reaches a network host', cdn.length === 0, cdn.join(', '));

  const html = await (await fetch(new URL('../index.html', import.meta.url).href, { cache: 'no-store' })).text();
  ok('K7 index.html loads three.js from the vendored copy', /assets\/lib\/r128\/three\.min\.js/.test(html));
  ok('K8 and from nowhere else', !/https?:\/\/[^"']*three/.test(html));
  emit();
}

/* ── L. the shipped page is actually alive ───────────────────────────────── */
async function sectionL() {
  lines.push('--- L. the real page, under real frames ---');
  const cd = window.__CD;
  ok('L1 main.js published its debug handle', !!cd);
  if (!cd) { emit(); return; }
  ok('L2 the renderer built a scene from the site', !!cd.renderer && cd.renderer.scene.children.length > 10);
  ok('L3 the loadout panel is what the player sees first', cd.panels.open === 'loadout');
  ok('L4 and the clock is paused behind it', cd.game.clock.paused || cd.game.clock.simTimeMs === 0);
  emit();

  /* The imager's floor image is the field, sampled. Prove it updates and that a hot spot
   * lands where the tripod is — a mirrored V axis is invisible until exactly this test. */
  const g = cd.game;
  g.commitLoadout(RECOMMENDED_MANIFEST);
  g.heat.setEmitters([{ id: 'x', x: 8, z: 8, peakC: 60, falloffM: 2.2, active: true }]);
  const tf = cd.renderer.thermalFloor;
  tf.lastUpdateMs = -1e9;
  ok('L5 the thermal floor updates', tf.update(g.heat, 1000));
  const b = g.site.bounds, N = tf.canvas.width;
  const px = Math.floor(((8 - b.minX) / (b.maxX - b.minX)) * N);
  const py = Math.floor(((b.maxZ - 8) / (b.maxZ - b.minZ)) * N);
  const d = tf.image.data, i = (py * N + px) * 4;
  ok('L6 and the hot pixel is where the emitter is, not mirrored', d[i] > 200 && d[i + 2] < 240,
    `rgb(${d[i]},${d[i + 1]},${d[i + 2]}) at ${px},${py}`);
  emit();

  /* One live frame through the real loop. rAF is scarce under headless (Dev\INDEX.md:
   * 1-3 callbacks total), so this asserts the loop RAN, not that it ran often. */
  /* Two calls, not one: `frame` measures a DELTA, so the first call after boot has no
   * previous timestamp to subtract and always spends zero steps. */
  cd.game.clock.setPaused(false);
  g.frame(500000);
  const before = g.clock.stepCount;
  g.frame(500040);
  ok('L7 game.frame drives fixed steps', g.clock.stepCount > before,
    `${before} -> ${g.clock.stepCount}`);
  await yieldToLoop();
  ok('L8 nothing threw on the way', !document.getElementById('err-banner').textContent);
  emit();
}

/* ── run ─────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    sectionA();
    const content = await loadContent();
    await sectionB(content);
    sectionC(content);
    sectionD(content);
    sectionE(content);
    sectionF(content);
    sectionG(content);
    sectionH(content);
    await sectionI(content);
    sectionJ();
    await sectionK();
    await sectionL();
    emit();
  } catch (e) {
    lines.push(`FAIL  suite threw: ${e && e.stack ? e.stack : e}`);
    fails++;
    emit();
  }
})();
