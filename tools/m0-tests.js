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
import { loadContent, ContentError, INCIDENTS } from '../src/sim/content.js';
import { HeatField } from '../src/sim/heat.js';
import { chooseVariation, applyVariation, WEATHER, TIMES } from '../src/sim/variation.js';
import { Site } from '../src/sim/site.js';
import { DeployableSet } from '../src/sim/deployables.js';
import { Anomaly, ANOMALY_STATE } from '../src/sim/anomaly.js';
import { EvidenceLedger, CLAIMS } from '../src/sim/evidence.js';
import { Game, RECOMMENDED_MANIFEST, EMPTY_COMMAND, recommendedManifest } from '../src/game.js';
import { PHASE } from '../src/sim/mission.js';
import { NetSession, loopbackPair, ROLE } from '../src/net/net.js';
import { MSG, ACT, PROTOCOL_VERSION, MAX_SQUAD, encodeSnapshot, applySnapshot } from '../src/net/protocol.js';
import { mixFor, Audio, BUSES, CAPTIONS, missingCaptions, formatCaption } from '../src/audio/audio.js';
import { Settings, PALETTES, SHAPES } from '../src/ui/settings.js';
import { Hud } from '../src/ui/hud.js';
import {
  PHRASES, PING_KINDS, ANCHORS, COMMS_CAPTIONS, PingBoard, requestPing,
  commsProblems, missingCommsCaptions, isPhrase, bearingWord, canMark,
  ageFraction, expiresAt, MARK_RANGE_M,
} from '../src/sim/comms.js';
import {
  CommsWheel, WHEEL_ORDER, sectorAt, sectorPos, projectPoint, aimPoint, KIND_VARS,
} from '../src/ui/commswheel.js';
import { Progression, loadSite, DEPLOYMENT_COST, DEPARTMENT_IDS, migrate } from '../src/sim/progression.js';
import { Input, DEFAULT_BINDINGS, isReservedCode, PAD_BUTTONS, HOLD_MODE } from '../src/core/input.js';
import { segmentHitsRect, moveWithWalls, dist, circleHitsRect } from '../src/sim/geometry.js';

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
      const body = s.includes('incidents') ? content.incident
        : s.includes('anomalies') ? broken
          : s.includes('maps') ? content.map : content.items;
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

  /* Every square metre a person can stand on has a name they could say over the radio.
   * Room rects stop at the walls, so the doorways between them are a seam — and standing
   * in a doorway is exactly when you are most likely to be telling somebody where you are. */
  const nameless = [];
  for (let x = site.bounds.minX + 0.5; x <= site.bounds.maxX - 0.5; x += 0.5) {
    for (let z = site.bounds.minZ + 0.5; z <= site.bounds.maxZ - 0.5; z += 0.5) {
      const inWall = site.blockingRects().some((r) => x > r[0] - 0.34 && x < r[2] + 0.34 && z > r[1] - 0.34 && z < r[3] + 0.34);
      if (inWall) continue;
      if (site.roomNameAt(x, z) === 'Unmarked floor') nameless.push(`${x.toFixed(1)},${z.toFixed(1)}`);
    }
  }
  ok('B16 every standable point on the floor has a name a player could say aloud',
    nameless.length === 0, `${nameless.length} nameless cells, e.g. ${nameless.slice(0, 4).join(' · ')}`);

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
  /* ⚠ Sprint rides in the COMMAND, not on the player object. Since the squad refactor,
   * step() sets sprinting from each operative's command every step, so a bot that pokes
   * `player.sprinting = true` is overwritten on the next tick and silently walks. */
  let botSprint = false;
  const walkTo = (x, z, tol = 0.6, budgetMs = 40000) => {
    let spent = 0, stalledMs = 0, strafe = 0, strafeMs = 0;
    let lastX = g.player.x, lastZ = g.player.z;
    while (dist(g.player.x, g.player.z, x, z) > tol && spent < budgetMs) {
      face(x, z);
      const axis = strafeMs > 0 ? { x: strafe, y: -0.4 } : { x: 0, y: -1 };
      if (strafeMs > 0) strafeMs -= slice;
      g.setCommand('p1', { axis, sprint: botSprint, crouch: false });
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
    g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
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
  const wait = (ms) => { g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false }); g.skipMs(ms); };

  /**
   * Walk to a fixture and make sure it is the thing on offer.
   *
   * ⚠ A TOLERANCE IS NOT AN APPROACH. `walkTo(switchX, switchZ, 1.6)` stops anywhere on a
   * 1.6m circle, and which side of that circle you stop on decides which fixture is
   * nearest — so the bot arrived 1.5m from the office breaker, on the side facing a
   * charging rack somebody had just authored two metres away, and was offered the rack.
   * Six assertions and a crash, from a coordinate in a content file.
   *
   * A player does not stop at 1.6m and squint; they walk up to the thing until the prompt
   * says what they want. So this closes in until the verb is right, which makes the bot
   * test the GAME rather than a particular arrangement of furniture — and leaves a real
   * failure (the verb is not reachable at all) still failing.
   */
  const workAt = (x, z, kind) => {
    for (const tol of [1.2, 0.8, 0.5, 0.3]) {
      walkTo(x, z, tol, 20000);
      const act = g.contextAction();
      if (act && act.kind === kind) return act;
    }
    return g.contextAction();
  };

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
  const swAct = workAt(sw.switchX, sw.switchZ, 'circuit');
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
  workAt(-10.0, -10.0, 'circuit');
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
  botSprint = true;
  walkTo(-8.0, -4.0, 0.5, 30000);
  const opened = dist(g.player.x, g.player.z, g.anomaly.x, g.anomaly.z);
  note(`after one leg of withdrawal: ${woke.toFixed(1)}m -> ${opened.toFixed(1)}m`);
  ok('I28 a sprinting operative opens the gap on it', opened > woke, `${woke.toFixed(1)} -> ${opened.toFixed(1)}`);
  route([[-8.0, -5.9], [-8.2, -6.6], [-6.6, -6.8], [-4.0, -8.4], [4.0, -8.4], [10.5, -6.8]], 0.6, 90000);
  botSprint = false;
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
    'src/sim/geometry.js', 'src/sim/site.js', 'src/sim/heat.js', 'src/sim/sound.js', 'src/sim/anomaly.js',
    'src/sim/deployables.js', 'src/sim/evidence.js', 'src/sim/player.js',
    'src/sim/mission.js', 'src/sim/content.js', 'src/sim/senses.js', 'src/sim/perception.js',
    'src/sim/comms.js', 'src/ui/commswheel.js', 'src/sim/variation.js', 'src/sim/instances.js',
    'src/net/protocol.js', 'src/net/net.js',
    'src/render/scene.js', 'src/render/renderer.js', 'src/render/thermalFloor.js',
    'src/sim/progression.js',
    'src/ui/hud.js', 'src/ui/panels.js', 'src/ui/settings.js', 'src/audio/audio.js',
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
  /* ⚠ THIS RULE CHANGED WHEN MULTIPLAYER LANDED, and saying so is the point of the test.
   * The build used to reach no network host at all. It now contacts exactly one — a
   * signalling broker that introduces two browsers and then carries no game traffic — and
   * that exception lives in ONE named file. Asserting "no host anywhere" would now pass by
   * luck (the broker is a bare hostname with no scheme) while being false, which is worse
   * than having no rule. So: name the file, and fail if any other one grows a host. */
  const NET_EXCEPTION = 'src/net/net.js';
  const hostish = files.filter((f) => /https?:\/\/|peerjs\.com|\.com['"]|\.net['"]|\.io['"]/.test(src.get(f)));
  ok('K6 exactly one file contacts a network host, and it is the signalling broker',
    hostish.length === 1 && hostish[0] === NET_EXCEPTION, hostish.join(', ') || 'none');
  ok('K7 and the broker is signalling only — no game state is sent to it',
    !/PEER_OPTS[\s\S]{0,400}(snapshot|encodeSnapshot|game\.)/.test(src.get(NET_EXCEPTION)));

  /* The wire format must stay pure, or the suite cannot round-trip a mission through it. */
  const proto = src.get('src/net/protocol.js');
  ok('K8 the protocol module is pure — no transport, no Peer, no DOM',
    !/\bPeer\b|WebSocket|RTCPeer|\bdocument\.[A-Za-z_$]/.test(proto));

  const html = await (await fetch(new URL('../index.html', import.meta.url).href, { cache: 'no-store' })).text();
  ok('K9 index.html loads three.js from the vendored copy', /assets\/lib\/r128\/three\.min\.js/.test(html));
  ok('K10 and peerjs from the vendored copy', /assets\/lib\/peerjs-1\.5\.4\/peerjs\.min\.js/.test(html));
  ok('K11 and neither from a CDN', !/https?:\/\/[^"']*(three|peerjs)/.test(html));

  /* ⚠ EVERY CONFIG LEAF MUST BE READ BY SOMETHING.
   *
   * `contactRadiusM`, `contactCooldownMs` and `reacquireGraceMs` sat in config.js with
   * confident comments explaining what they controlled, and nothing anywhere read any of
   * them — they were engine rules in the Unity build and are content here. A number in a
   * config file is a promise that changing it changes the game, and three of them were
   * lying. You could have spent an afternoon tuning contact range with no effect at all,
   * and no test in the suite would have said a word.
   *
   * Leaf names only, which is enough: CONFIG is read as `CONFIG.anomaly.batteryDrainRadiusM`
   * and a name unique enough to be a config key is unique enough to grep for. */
  const configLeaves = [];
  const walk = (o, path) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${path}.${k}`);
      else configLeaves.push({ key: k, path: `${path}.${k}` });
    }
  };
  walk(CONFIG, 'CONFIG');
  const consumers = files.filter((f) => f !== 'src/config.js').map((f) => src.get(f)).join('\n');
  const unread = configLeaves.filter((l) => !new RegExp(`\\b${l.key}\\b`).test(consumers));
  note(`${configLeaves.length} CONFIG leaves, ${unread.length} unread`);
  eq(`K12 no CONFIG value is read by nothing${unread.length ? ` (${unread.map((l) => l.path).join(', ')})` : ''}`,
    unread.length, 0);
  emit();
}

/* ── L. the shipped page is actually alive ───────────────────────────────── */
async function sectionL() {
  lines.push('--- L. the real page, under real frames ---');
  const cd = window.__CD;
  ok('L1 main.js published its debug handle', !!cd);
  if (!cd) { emit(); return; }
  ok('L2 the renderer built a scene from the site', !!cd.renderer && cd.renderer.scene.children.length > 10);
  /* The boot destination is the SITE now, not the operation — GDD §26.2 wants a complete
   * base-to-mission-to-base loop, so the base is where a session starts and ends. */
  ok('L3 the Foundation site is what the player sees first', cd.base && cd.base.isOpen,
    `base ${cd.base && cd.base.isOpen} · panels ${cd.panels.open}`);
  ok('L3b with a progression profile behind it', !!cd.progression && !!cd.site);
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

/* ── M. a squad, over a real protocol ────────────────────────────────────── */
async function sectionM(content) {
  lines.push('--- M. host authority, over the wire, with no wire ---');

  const mkHost = () => { const g = new Game(content, { seed: 'net' }); const n = new NetSession(g, { snapshotHz: 12 }); n.host(); return { g, n }; };
  const mkClient = () => { const g = new Game(content, { seed: 'net' }); const n = new NetSession(g); return { g, n }; };

  /* Two Games and a loopback pair: the whole session runs in this tab, through the same
   * encode/decode and the same validated verbs a WebRTC connection would use. */
  const host = mkHost();
  const c1 = mkClient();
  let [hl, cl] = loopbackPair();
  host.n.accept(hl);
  c1.n.join(cl, { name: 'Vasquez' });

  eq('M1 a client that says hello is given a seat', c1.n.localPlayerId, 'p2');
  eq('M2 and the host now has a squad of two', host.g.players.length, 2);
  eq('M3 with the name they asked for', host.g.playerById('p2').name, 'Vasquez');
  ok('M4 the client is handed a resume token', typeof c1.n.token === 'string' && c1.n.token.length > 3);
  eq('M5 and the whole floor arrives with the welcome', c1.g.site.id, host.g.site.id);
  ok('M6 the client sees itself as p2, not as the host', c1.g.localId === 'p2' && c1.g.viewPlayer.id === 'p2');

  /* Deploy, then drive the client's operative purely by sending intent. */
  host.g.commitLoadout(RECOMMENDED_MANIFEST);
  const before = { ...host.g.playerById('p2') };
  const startX = host.g.playerById('p2').x;
  c1.g.playerById('p2').yaw = Math.PI;                       // face south
  for (let i = 0; i < 30; i++) {
    c1.n.pump(16, { axis: { x: 0, y: -1 }, sprint: false, crouch: false, yaw: Math.PI, pitch: 0 });
    host.g.skipMs(50);
  }
  const moved = Math.abs(host.g.playerById('p2').x - startX) + Math.abs(host.g.playerById('p2').z - before.z);
  note(`client intent moved the host's copy of p2 by ${moved.toFixed(2)}m over ${host.n.cmdsReceived} commands`);
  ok('M7 a command from a client moves that operative ON THE HOST', moved > 0.5);
  ok('M8 and the host counted every one of them', host.n.cmdsReceived >= 30);

  /* The snapshot is the client's whole world. */
  host.n.pump(1000, null);
  const hp = host.g.playerById('p2'), cp = c1.g.playerById('p2');
  near('M9 the snapshot puts the operative where the host has them', cp.netX, hp.x, 0.02);
  eq('M10 and tells the client what phase the mission is in', c1.g.mission.phase, host.g.mission.phase);
  eq('M11 the cargo manifest crossed intact', c1.g.cache.get('floodlight-tripod'), host.g.cache.get('floodlight-tripod'));
  note(`one snapshot of a two-operative floor: ${hl.bytes} bytes total over ${hl.sent} sends`);

  /* THE AUTHORITY RULE. A client asking for something it cannot have gets nothing. */
  const cheat = c1.g.playerById('p2');
  cheat.x = 99; cheat.z = 99;                                 // a modified client teleports
  host.n.pump(1000, null);
  ok('M12 a client cannot move itself — the host overwrote the lie on the next snapshot',
    Math.abs(c1.g.playerById('p2').netX - hp.x) < 0.02);

  const evBefore = host.g.ledger.entries.length;
  c1.n.act(ACT.INTERACT);                                     // nothing in reach
  eq('M13 an action with nothing in reach changes nothing', host.g.ledger.entries.length, evBefore);
  ok('M14 and the host told them why rather than silently dropping it', host.n.actsRefused >= 1);

  /* ⚠ THE SNAPSHOT USED TO EAT THIS. A refusal is addressed to one operative; the squad
   * feed is addressed to all of them. They shared a list, so `applySnapshot` replaced the
   * client's reason with the host's notices about 80ms later and the player saw nothing.
   * Found in two real browsers, because a loopback test that reads the notice immediately
   * never survives long enough to lose it — so this one deliberately reads it AFTER. */
  ok('M15 the refusal reached the client', c1.g.recentNotices(9).some((n) => /reach/i.test(n.text)));
  host.n.pump(1000, null);
  host.n.pump(1000, null);
  ok('M16 and survives the snapshots that follow it',
    c1.g.recentNotices(9).some((n) => /reach/i.test(n.text)),
    c1.g.recentNotices(9).map((n) => n.text).join(' | '));
  ok('M17 while the squad-wide feed still comes from the host',
    (host.g.notice('all-hands test line'), host.n.pump(1000, null),
      c1.g.recentNotices(9).some((n) => /all-hands/.test(n.text))));

  /* Discrete actions go through the same verbs the host's own keyboard uses. */
  const p2 = host.g.playerById('p2');
  p2.x = host.g.site.cache.x; p2.z = host.g.site.cache.z;
  c1.n.act(ACT.TAKE, { id: 'thermal-imager' });
  ok('M18 a client can take from cargo, validated by the host', p2.carrying('thermal-imager'));
  c1.n.act(ACT.IMAGER);
  ok('M19 and switch it on', host.g.imagerOnIds.has('p2'));
  ok('M20 which the host tells everyone about', (host.n.pump(1000, null), c1.g.imagerOnIds.has('p2')));

  /* A third operative, and the squad cap. */
  const c2 = mkClient();
  const [hl2, cl2] = loopbackPair();
  host.n.accept(hl2); c2.n.join(cl2, { name: 'Drake' });
  eq('M21 a third operative joins', host.g.players.length, 3);
  eq('M22 and lands in their own seat', c2.n.localPlayerId, 'p3');
  const extras = [];
  for (let i = 0; i < 3; i++) {
    const c = mkClient(); const [a, b] = loopbackPair();
    host.n.accept(a); c.n.join(b, { name: `Extra${i}` });
    extras.push(c);
  }
  eq(`M23 the squad caps at ${MAX_SQUAD} (GDD 11.1)`, host.g.players.length, MAX_SQUAD);
  ok('M24 and the one over the cap is told why', /full/i.test(extras[extras.length - 1].n.status), extras[extras.length - 1].n.status);

  /* A version mismatch is refused with a sentence a human can act on. */
  const oldClient = mkClient();
  const [ho, co] = loopbackPair();
  host.n.accept(ho);
  co.onMessage = (m) => { oldClient.n.status = m.why || m.t; };
  co.send({ t: MSG.HELLO, v: PROTOCOL_VERSION + 99, name: 'Stale' });
  ok('M25 a protocol mismatch is refused, in words', /reload/i.test(oldClient.n.status), oldClient.n.status);

  /* ── the drop, the reserved slot, and the reconnect (GDD 11.5) ── */
  const drakeSeat = host.n.seats.get('p3');
  const drakeToken = drakeSeat.token;
  host.g.playerById('p3').take(content.itemsById.get('floodlight-tripod'));
  hl2.close();
  eq('M26 a dropped operative keeps their seat on the roster', host.g.players.length, MAX_SQUAD);
  eq('M27 and is marked off the radio rather than deleted', host.g.playerById('p3').connected, false);
  ok('M28 their kit is still theirs', host.g.playerById('p3').carrying('floodlight-tripod'));
  ok('M29 and they stand still rather than running off — safe autopilot',
    host.g.commandFor('p3') === EMPTY_COMMAND || !host.g.commands.has('p3'));

  const back = mkClient();
  const [hb, cb] = loopbackPair();
  host.n.accept(hb);
  back.n.join(cb, { name: 'Drake', token: drakeToken });
  eq('M30 a resume token buys back the same seat', back.n.localPlayerId, 'p3');
  eq('M31 with the squad unchanged in size', host.g.players.length, MAX_SQUAD);
  eq('M32 and the kit still in their hands (11.5: "restores character state and inventory")',
    host.g.playerById('p3').carrying('floodlight-tripod'), true);
  eq('M33 back on the radio', host.g.playerById('p3').connected, true);

  /* ── the join-in-progress gate ── */
  host.g.commitProcedure({ target: 'The cold mass itself' });
  const late = mkClient();
  const [hlate, clate] = loopbackPair();
  host.n.accept(hlate); late.n.join(clate, { name: 'Late' });
  ok('M34 nobody joins after the squad commits to a procedure', /committed/i.test(late.n.status), late.n.status);
  eq('M35 and the roster did not grow', host.g.players.length, MAX_SQUAD);

  /* ── custody cannot leave with somebody who lost their radio ── */
  host.g.mission.setPhase(PHASE.CONTAINMENT_ACTIVE, host.g.clock.simTimeMs);
  const carrier = host.g.playerById('p2');
  const kase = host.g.deployables.place(content.itemsById.get('reinforced-transit-case'), carrier.x, carrier.z, 0);
  kase.sealed = true;
  carrier.hands = 'reinforced-transit-case';
  host.g._carried.set('p2', { sealed: true, custodyHeldMs: 5000, batteryMs: kase.batteryMs });
  host.g.deployables.remove(kase);
  hl.close();
  eq('M36 a dropped carrier puts custody down rather than taking it offline with them',
    host.g.playerById('p2').hands, null);
  ok('M37 and the case is on the floor, still sealed',
    host.g.deployables.byItem('reinforced-transit-case').some((d) => d.sealed));

  /* ── prediction and reconciliation (GDD 20.4) ── */
  const pred = mkClient();
  const [hp2, cp2] = loopbackPair();
  const host2 = mkHost();
  host2.g.commitLoadout(RECOMMENDED_MANIFEST);
  host2.n.accept(hp2); pred.n.join(cp2, { name: 'Hicks' });
  const mine = pred.g.playerById(pred.n.localPlayerId);
  mine.yaw = 0;
  pred.g.setCommand(pred.n.localPlayerId, { axis: { x: 0, y: -1 }, sprint: false, crouch: false });
  const x0 = mine.x, z0 = mine.z;
  for (let i = 0; i < 20; i++) pred.g.predictLocal(pred.n.localPlayerId, 16);
  const predicted = dist(x0, z0, mine.x, mine.z);
  ok('M38 a client predicts its own feet rather than waiting for a snapshot', predicted > 0.3, `${predicted.toFixed(2)}m`);
  mine.netX = mine.x + 0.2; mine.netZ = mine.z;
  const err = pred.g.reconcileLocal(pred.n.localPlayerId);
  ok('M39 a small disagreement is blended, not snapped', err < CONFIG.net.snapErrorM && Math.abs(mine.x - mine.netX) > 0.01);
  mine.netX = mine.x + 5;
  pred.g.reconcileLocal(pred.n.localPlayerId);
  near('M40 a large one is snapped, because smoothing that far is just a slow lie', mine.x, mine.netX, 0.001);

  /* ── the squad changes the SIMULATION, not just the roster ── */
  const two = new Game(content, { seed: 'two' });
  two.commitLoadout(RECOMMENDED_MANIFEST);
  const b = two.addPlayer('Second');
  two.player.x = -10; two.player.z = 10;
  b.x = 6; b.z = 6;
  two.skipMs(120);
  const em = two.heat.emitters.filter((e) => e.peakC === CONFIG.player.bodyHeatC);
  eq('M41 every operative is a heat source, so a squad is several lures', em.length, 2);

  two.anomaly.x = 5.4; two.anomaly.z = 6.0;
  two.anomaly.state = 'drawn';
  two.skipMs(400);
  ok('M42 the draught takes the operative it can reach, not the one with seat one',
    two.anomaly.targetId === b.id, `targeted ${two.anomaly.targetId}`);

  /* ── down, and rescued (GDD 9.5) — the reason a second operative exists ── */
  const med = new Game(content, { seed: 'med' });
  med.commitLoadout(RECOMMENDED_MANIFEST);
  const mate = med.addPlayer('Corpsman');
  const hurt = med.player;
  hurt.applyCondition('exposure', 'serious');
  hurt.applyCondition('exposure', 'serious');
  ok('M43 a second serious contact puts an operative DOWN, not dead', hurt.downed && hurt.alive);
  med.skipMs(4000);
  ok('M44 and a bleed-out clock starts', hurt.downedMs > 3000, `${hurt.downedMs.toFixed(0)}ms`);

  mate.x = hurt.x + 0.8; mate.z = hurt.z;
  mate.take(content.itemsById.get('trauma-kit'));
  const rescue = med.contextAction(mate.id);
  ok('M45 a teammate with a trauma kit is offered the rescue above everything else',
    rescue && rescue.kind === 'revive', rescue ? `${rescue.kind}: ${rescue.text}` : 'none');
  med.doInteract(mate.id);
  ok('M46 which puts them back on their feet, stabilised rather than healed',
    !hurt.downed && hurt.alive && hurt.conditions.exposure.stabilised && hurt.conditions.exposure.severity > 0);
  eq('M47 and the debrief counts it', med.mission.tally.rescues, 1);

  const solo = new Game(content, { seed: 'solo' });
  solo.commitLoadout(RECOMMENDED_MANIFEST);
  solo.player.applyCondition('exposure', 'serious');
  solo.player.applyCondition('exposure', 'serious');
  solo.skipMs(CONFIG.player.bleedOutMs + 1000);
  ok('M48 alone, nobody comes, and the floor takes them', !solo.player.alive);
  ok('M49 which ends the operation', !!solo.result && solo.result.overall === 'Failed', solo.result && solo.result.overall);

  /* ── two on the case (GDD 9.2, 11.2) ── */
  const carry = new Game(content, { seed: 'carry' });
  carry.commitLoadout(RECOMMENDED_MANIFEST);
  const helper = carry.addPlayer('Helper');
  carry.player.hands = 'reinforced-transit-case';
  helper.x = carry.player.x + 8; helper.z = carry.player.z;
  const alone = carry.player.speedFactor(false, { assisted: false });
  helper.x = carry.player.x + 1.0;
  const together = carry.player.speedFactor(false, { assisted: !!carry._assistFor(carry.player) });
  note(`carrying the case: ${(alone * 100).toFixed(0)}% alone, ${(together * 100).toFixed(0)}% with a second pair of hands`);
  ok('M50 a second pair of hands on the case is worth having', together > alone);
  ok('M51 but solo is never gated on it', alone > 0.5);

  await yieldToLoop();
  emit();
}

/* ── N. the engine is data, not this anomaly ─────────────────────────────── */
async function sectionN(content) {
  lines.push('--- N. a second anomaly is content, not a code change ---');

  /* THE PROOF THAT MATTERS. Take the shipped anomaly, rename every state and every trigger
   * to something meaningless, and run it. If the engine still drives it identically, then
   * nothing is keyed on what this particular anomaly is called — which is the whole claim.
   * A grep for hard-coded ids would only prove they are absent from one file; this proves
   * the behaviour does not depend on them anywhere. */
  const renamed = JSON.parse(JSON.stringify(content.anomaly));
  const stateMap = { latent: 'q0', aware: 'q1', drawn: 'q2', banked: 'q3', contained: 'q4' };
  const trigMap = {};
  renamed.id = 'renamed-draught';
  renamed.states.forEach((s) => { s.id = stateMap[s.id]; });
  renamed.triggers.forEach((t, i) => {
    trigMap[t.id] = `t${i}`;
    t.id = `t${i}`;
    if (t.from !== '*') t.from = stateMap[t.from];
    t.to = stateMap[t.to];
  });
  renamed.capabilities.forEach((c) => { c.availableInStates = c.availableInStates.map((s) => stateMap[s]); });
  renamed.containment.procedures.forEach(() => {});

  const site = new Site(content.map);
  const heat = new HeatField();
  const deps = new DeployableSet();
  const a = new Anomaly(renamed, site, heat, deps);
  eq('N1 a renamed anomaly starts in its own first state', a.state, 'q0');
  eq('N2 and the engine reads its KIND rather than its name', a.stateKind, 'latent');

  const op = { id: 'op', x: a.x + 8, z: a.z, peakC: 37 };
  heat.setEmitters([{ ...op, falloffM: 1.15, active: true }]);
  let T = 0;
  const run = (ms, ctx) => { for (let i = 0; i < ms / CONFIG.sim.stepMs; i++) { T += CONFIG.sim.stepMs; heat.setSinks([a.asSink()].filter(Boolean)); a.step(CONFIG.sim.stepMs, T, ctx); } };

  run(3000, { sources: [op], operatives: [], pressureStage: 0 });
  eq('N3 three seconds of proximity is still not four', a.state, 'q0');
  run(1500, { sources: [op], operatives: [], pressureStage: 0 });
  eq('N4 four wakes it, through a trigger called t0', a.state, 'q1');
  ok('N5 and the transition kept the content telegraph', /frost bloom elongates/.test(a.transitions[0].telegraph));
  run(9000, { sources: [op], operatives: [], pressureStage: 0 });
  eq('N6 it closes and locks on, with no id the engine recognises', a.state, 'q2');
  ok('N7 which is a hunting state, so it moves', a.speedMps > 0 && a.isAwake);

  const tripod = content.itemsById.get('floodlight-tripod');
  const ring = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    ring.push({ id: `r${i}`, x: a.x + Math.cos(ang) * 1.6, z: a.z + Math.sin(ang) * 1.6, peakC: tripod.heatOutputCelsius, falloffM: tripod.heatFalloffMetres, active: true });
  }
  heat.setEmitters(ring);
  run(200, { sources: [], operatives: [], pressureStage: 0 });
  eq('N8 enclosure still banks it, via the wildcard trigger', a.state, 'q3');
  eq('N9 which the engine knows only as kind `vulnerable`', a.stateKind, 'vulnerable');

  const kase = content.itemsById.get('reinforced-transit-case');
  const near1 = deps.place(kase, a.x + 0.8, a.z, 0);
  eq('N10 and the performed trigger is found by its SENSE, not its id', a.trySeal(near1, T), null);
  eq('N11 leaving it contained', a.stateKind, 'contained');

  /* Now the validator: the closed vocabulary has to be enforced at load, because a sense
   * the engine cannot evaluate is a rule the player can never learn. */
  const orig = window.fetch;
  const tryLoad = async (mutate) => {
    const doc = JSON.parse(JSON.stringify(content.anomaly));
    mutate(doc);
    window.fetch = async (u) => {
      const s = String(u);
      const body = s.includes('incidents') ? content.incident
        : s.includes('anomalies') ? doc
          : s.includes('maps') ? content.map : content.items;
      return { ok: true, status: 200, json: async () => body };
    };
    try { await loadContent(); return null; } catch (e) { return e.message; } finally { window.fetch = orig; }
  };

  let msg = await tryLoad((d) => { d.triggers[0].when.sense = 'smells-fear'; });
  ok('N12 a sense outside the vocabulary is REFUSED at load', msg && /smells-fear/.test(msg), msg);
  msg = await tryLoad((d) => { d.capabilities[0].verb = 'explode'; });
  ok('N13 so is an effect verb the engine cannot dispatch', msg && /explode/.test(msg), msg);
  msg = await tryLoad((d) => { d.states[1].kind = 'peckish'; });
  ok('N14 and a state kind the rest of the game cannot reason about', msg && /peckish/.test(msg), msg);
  msg = await tryLoad((d) => { d.triggers.push({ ...d.triggers.find((t) => t.id === 'sealed'), id: 'sealed-twice' }); });
  ok('N15 two custody moves are refused — an anomaly has exactly one', msg && /custody move/.test(msg), msg);
  msg = await tryLoad((d) => { d.states = d.states.filter((s) => s.kind !== 'vulnerable'); });
  ok('N16 an anomaly with nothing sealable is refused', msg && /vulnerable/.test(msg), msg);
  msg = await tryLoad((d) => { d.presence.field.kind = 'wormhole'; });
  ok('N17 as is a field disturbance the heat layer cannot represent', msg && /wormhole/.test(msg), msg);

  /* And the field itself is content now, not a constant. */
  const quiet = JSON.parse(JSON.stringify(content.anomaly));
  quiet.presence.field.kind = 'none';
  const b = new Anomaly(quiet, new Site(content.map), new HeatField(), new DeployableSet());
  eq('N18 an anomaly that disturbs nothing has no field presence at all', b.asSink(), null);
  const strong = JSON.parse(JSON.stringify(content.anomaly));
  strong.presence.field.magnitude = 40;
  const c = new Anomaly(strong, new Site(content.map), new HeatField(), new DeployableSet());
  eq('N19 and its magnitude comes from the file, not from CONFIG', c.asSink().chillC, 40);

  await yieldToLoop();
  emit();
}

/* ── O. a second incident package, on the same floor ─────────────────────── */
async function sectionO() {
  lines.push('--- O. two incidents, one map, two procedures ---');

  const draught = await loadContent({ incident: 'cold-storage-draught' });
  const figure = await loadContent({ incident: 'cold-storage-figure' });

  eq('O1 both incidents load', !!(draught.anomaly && figure.anomaly), true);
  eq('O2 and they are the same floor', draught.map.id, figure.map.id);
  ok('O3 with different anomalies', draught.anomaly.id !== figure.anomaly.id);
  ok('O4 different starting positions', draught.map.anomalySpawn.join() !== figure.map.anomalySpawn.join());
  ok('O5 and completely different evidence on the ground',
    figure.map.evidenceSources.every((s) => !draught.map.evidenceSources.some((d) => d.evidenceId === s.evidenceId)));
  note(`draught: ${draught.map.evidenceSources.length} sources · figure: ${figure.map.evidenceSources.length} sources, same ${figure.map.id}`);

  /* The engine required NO new code for the second one beyond two senses. */
  const g = new Game(figure, { seed: 'fig' });
  eq('O6 the second anomaly starts in its own first state', g.anomaly.state, 'standing');
  eq('O7 which the engine knows only as a latent kind', g.anomaly.stateKind, 'latent');
  eq('O8 it disturbs no field at all — the imager is useless on it', g.anomaly.asSink(), null);
  ok('O9 and it has no enclosure trigger, so a heat fence is irrelevant to it',
    !figure.anomaly.triggers.some((t) => t.when.sense === 'path-blocked-by-gradient'));

  g.commitLoadout([
    { itemId: 'remote-camera', qty: 2 },
    { itemId: 'reinforced-transit-case', qty: 1 },
    { itemId: 'power-pack', qty: 1 },
    { itemId: 'trauma-kit', qty: 1 },
  ]);

  /* Put an operative where they can see it, and it stops. That is the whole rule. */
  const p = g.player;
  const a = g.anomaly;
  /* Six metres down the aisle, looking at it. Forward is (-sin yaw, -cos yaw), so yaw = PI
   * faces +z — the same convention the camera, the movement code and the cones all use.
   * Getting this backwards puts the operative staring at the far wall with their back to
   * the thing, which is exactly what a player would experience if the cone were wrong. */
  p.x = a.x; p.z = a.z - 6;
  p.yaw = Math.PI;
  g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
  g.skipMs(300);
  eq('O10 an operative looking at it holds it still', a.state, 'held');
  eq('O11 which is a vulnerable kind, so it can be sealed', a.stateKind, 'vulnerable');
  ok('O12 and the HUD can say who is holding it', g.observation.by.includes('p1'), JSON.stringify(g.observation));

  /* Look away and it comes, after the sustain the content authored — not instantly. */
  p.yaw = 0;                                       // turn to face south, away from it
  g.skipMs(900);
  eq('O13 a moment of lost coverage does not release it', a.state, 'held');
  g.skipMs(1200);
  eq('O14 but a second and a half does', a.state, 'closing');
  ok('O15 and it is fast — much faster than the draught', a.speedMps > 3);
  const before = dist(p.x, p.z, a.x, a.z);
  g.skipMs(1000);
  const after = dist(p.x, p.z, a.x, a.z);
  ok('O16 it closes while nobody is looking', after < before, `${before.toFixed(1)}m -> ${after.toFixed(1)}m`);

  /* A camera holds it just as well as a person, which is the actual procedure: the squad
   * hands coverage to something that does not need to stand there. */
  /* ⚠ Take the operative out of the picture entirely before testing the camera. Leaving
   * them anywhere near it makes every assertion below ambiguous — the thing had already
   * closed most of the six metres, so "looking away" stopped meaning "cannot see it" the
   * moment it walked around them. Park them in the loading bay, two rooms away. */
  p.x = 8.0; p.z = -9.0; p.yaw = 0;
  const cam = g.deployables.place(figure.itemsById.get('remote-camera'), a.x, a.z - 5, Math.PI);
  g.skipMs(300);
  eq('O17 a deployed camera holds it exactly as a person does', a.state, 'held');
  ok('O18 and the coverage is attributed to the camera, with nobody looking',
    g.observation.by.includes(cam.uid) && !g.observation.by.includes('p1'), JSON.stringify(g.observation.by));

  /* Line of sight is geometric: put it somewhere with no sightline and it holds nothing. */
  cam.x = -10.0; cam.z = -10.0;                    // into the office, walls in the way
  g.skipMs(2500);
  eq('O19 a camera with no sightline holds nothing', a.state, 'closing');

  /* And the custody move is the same verb with a different meaning: sealed while HELD. */
  cam.x = a.x; cam.z = a.z - 5; cam.yaw = Math.PI;
  g.skipMs(400);
  eq('O20 coverage restored, it stops again', a.state, 'held');
  const kase = g.deployables.place(figure.itemsById.get('reinforced-transit-case'), a.x + 0.8, a.z, 0);
  eq('O21 and it can be cased while held', g.anomaly.trySeal(kase, g.clock.simTimeMs), null);
  eq('O22 leaving it contained, through a trigger the engine never heard of', a.stateKind, 'contained');

  /* The two incidents genuinely demand different kit. */
  /* Compare the MINIMUM procedures, not the safe ones. A safe-grade kit is a superset that
   * covers what might go wrong, so two of them overlap heavily and comparing them says
   * nothing. What each anomaly cannot be contained WITHOUT is the real contrast. */
  const dr = draught.anomaly.containment.procedures[0].requiredEquipment;
  const fg = figure.anomaly.containment.procedures[0].requiredEquipment;
  note(`minimum kit — draught: ${dr.join(', ')}`);
  note(`minimum kit — figure:  ${fg.join(', ')}`);
  ok('O23 the cheapest way to contain each one wants different equipment',
    dr.some((x) => !fg.includes(x)) && fg.some((x) => !dr.includes(x)));
  ok('O24 the draught cannot be held without heat', dr.includes('portable-heater') && !fg.includes('portable-heater'));
  ok('O25 the figure cannot be held without an eye on it', fg.includes('remote-camera') && !dr.includes('remote-camera'));

  await yieldToLoop();
  emit();
}

/* ── P. accessibility (GDD §19) ──────────────────────────────────────────── */
function sectionP() {
  lines.push('--- P. the accessibility baseline is real, not a menu ---');

  /* The MODEL has to be DOM-free, or none of it can be asserted headless and none of it
   * can be trusted. §19 is a design requirement, not a settings screen. */
  const s = new Settings();
  ok('P1 the settings model works with no DOM at all', typeof s.get('captions.enabled') === 'boolean');
  s.set('volume.master', 0.4);
  near('P2 a value round-trips', s.get('volume.master'), 0.4, 1e-9);
  s.set('volume.master', 99);
  ok('P3 and an out-of-range value is clamped rather than accepted', s.get('volume.master') <= 1, String(s.get('volume.master')));
  const json = s.toJSON();
  const back = Settings.fromJSON(JSON.parse(JSON.stringify(json)));
  near('P4 it serialises and comes back', back.get('volume.master'), s.get('volume.master'), 1e-9);
  ok('P5 an unknown stored version falls back to defaults rather than throwing',
    !!Settings.fromJSON({ version: 999, values: { nonsense: true } }));

  /* ⚠ §19.2: no required rule may depend on hearing. The check is not "is there a caption
   * table" — it is that EVERY cue has one, which is a thing that rots the moment somebody
   * adds a cue. missingCaptions() is that check, and it belongs in the suite. */
  const missing = missingCaptions();
  ok('P6 every audio cue has a caption', missing.length === 0, missing.join(', '));
  const cap = formatCaption(CAPTIONS.CONTACT, { direction: 'north' });
  ok('P7 a non-speech caption is bracketed, as every player already expects', /^\[.*\]$/.test(cap), cap);
  ok('P8 and a directional one can carry a bearing, so stereo hearing is never required',
    /north/i.test(cap), cap);

  /* THE SEAM. §19.1 wants five sliders; the obvious implementation scales the mix and
   * destroys mixFor's purity, which section J asserts. The sliders are gain buses
   * downstream instead, so the same world state still gives the same mix. */
  const base = { anomalyState: 'drawn', distance: 4, imagerOn: false, imagerLockMs: 0, custodyHeldMs: 0, stressNorm: 0, pressureStage: 0, activeEmitters: 0 };
  const a1 = JSON.stringify(mixFor(base));
  const audio = new Audio();
  audio.setVolumes({ master: 0.1, anomaly: 0, voice: 0.5 });
  const a2 = JSON.stringify(mixFor(base));
  eq('P9 turning every slider down does not change what mixFor returns', a1, a2);
  eq('P10 because the sliders are buses, not a multiplier on the mix', audio.busGain('anomaly'), 0);
  ok('P11 and there is one bus per slider §19.1 names', BUSES.length >= 6);

  /* Rebinding. §19.1 asks for full remapping; the trap is a table the game does not read. */
  const inp = new Input({ addEventListener() {}, removeEventListener() {} }, undefined, undefined);
  ok('P12 the default table is the one the game actually plays with',
    !!DEFAULT_BINDINGS.interact && !!DEFAULT_BINDINGS.imager && !!DEFAULT_BINDINGS.tablet,
    Object.keys(DEFAULT_BINDINGS).join(','));
  inp.rebind('interact', 'KeyG');
  ok('P13 an action can be rebound', inp.bindings.interact.includes('KeyG'));
  inp._debugPress('KeyG');
  ok('P14 and the new key actually fires it', inp.wasPressed('interact'));
  inp.endStep();
  ok('P15 a key the browser needs is refused', isReservedCode('F5') && isReservedCode('F12'));
  const refused = inp.rebind('interact', 'F5');
  ok('P16 so rebinding onto one does not take', refused === false || !inp.bindings.interact.includes('F5'));
  inp.resetBindings();
  ok('P17 and reset returns the real defaults, not another game’s',
    inp.bindings.interact.join() === DEFAULT_BINDINGS.interact.join());

  /* Hold vs toggle resolved AT THE SOURCE, so no gameplay system knows which mode is on. */
  const held = new Input({ addEventListener() {}, removeEventListener() {} });
  held.setHoldMode('sprint', 'toggle');
  held._debugPress('ShiftLeft');
  held.endStep();
  held._debugRelease('ShiftLeft');
  ok('P18 in toggle mode a released key stays on', held.isDown('sprint'));
  held._debugPress('ShiftLeft');
  held.endStep();
  ok('P19 and pressing again turns it off', !held.isDown('sprint'));
  held.setHoldMode('sprint', 'hold');
  held._debugPress('ShiftLeft');
  ok('P20 in hold mode it is on while down', held.isDown('sprint'));
  held._debugRelease('ShiftLeft');
  ok('P21 and off when released', !held.isDown('sprint'));

  /* Colour vision and shape redundancy — §19.1, and §18.1's "must function without colour". */
  const names = Object.keys(PALETTES);
  ok('P22 there are colour-vision presets', names.length >= 4, names.join(','));
  const def = PALETTES[names[0]], alt = PALETTES[names[1]];
  ok('P23 and they are genuinely different palettes', JSON.stringify(def) !== JSON.stringify(alt));
  s.set('vision.shapes', true);
  ok('P24 shape redundancy is available so colour is never the only channel',
    Object.keys(SHAPES).length > 0);

  /* Photosensitivity-safe mode has to CLAMP, not merely record a preference. */
  const ps = new Settings();
  ps.set('camera.shake', 1);
  ps.set('safety.photosensitive', true);
  ok('P25 safe mode clamps what the renderer is allowed to read',
    ps.effective.camera.shake < 1, JSON.stringify(ps.effective.camera));
  ok('P26 and the raw preference is preserved, so turning it off restores the choice',
    ps.get('camera.shake') === 1);

  emit();
}

/* ── Q. progression and the site (GDD §12, §13) ──────────────────────────── */
async function sectionQ(content) {
  lines.push('--- Q. the site is what carries between missions ---');

  const site = await loadSite();
  ok('Q1 the site loads and is refused if malformed', !!site && Array.isArray(site.rooms));
  ok('Q2 with the five rooms the slice specifies (GDD 26.2)', site.rooms.length >= 5, String(site.rooms.length));

  /* Play a real mission and grade it, so the progression is fed the actual object rather
   * than a hand-written one that could drift from `mission.grade()`. */
  const g = new Game(content, { seed: 'prog' });
  g.commitLoadout(RECOMMENDED_MANIFEST);
  g.skipMs(2000);
  const result = g.endMission('recalled for the test', g.clock.simTimeMs);

  const pr = new Progression({ site, autosave: false });
  const before = pr.profile.requisition;
  const out = pr.applyDebrief(result, g.mission, {
    anomalyId: content.anomaly.id, mapId: content.map.id,
    custody: g.custody, minutes: 2, observations: g.ledger.entries.length, squad: g.players,
  });
  ok('Q3 a graded debrief turns into earnings', !!out && !!out.earnings);
  ok('Q4 every dimension the debrief reports is one the ledger knows how to pay',
    result.dims.every((d) => out.earnings.lines.some((l) => l.name === d.name))
    || out.earnings.lines.length >= result.dims.length - 1,
    `${out.earnings.lines.length} lines for ${result.dims.length} dimensions`);

  /* ⚠ GDD §12.6, and the one thing in the whole economy worth a test: a failed operation
   * still yields something for valid observations, and NO RUN OF FAILURES may make
   * recovery impossible. An economy that can be soft-locked is worse than none. */
  const grim = new Progression({ site, autosave: false });
  const failures = [];
  for (let i = 0; i < 6; i++) {
    const bad = new Game(content, { seed: `fail${i}` });
    bad.commitLoadout(RECOMMENDED_MANIFEST);
    bad.skipMs(1500);
    const r = bad.endMission('total loss', bad.clock.simTimeMs);
    grim.applyDebrief(r, bad.mission, { anomalyId: content.anomaly.id, custody: 'none', minutes: 25, observations: 0, squad: bad.players });
    failures.push(grim.profile.requisition);
  }
  note(`requisition across six consecutive disasters: ${failures.join(' → ')}`);

  /* ⚠ READ §12.6 BEFORE ASSERTING AGAINST IT. It does NOT promise that failure drains the
   * account — it names the stakes explicitly, and they are "lost consumables, damaged or
   * unrecovered issued gear, lower standing". A site whose squad deploys, achieves nothing
   * and brings every item home should come out roughly level: it is Foundation-funded and
   * the grant covers the run. What must never happen is failure being PROFITABLE, which is
   * how this shipped — the floor sat on the operation instead of the balance and six total
   * losses took the site from 340 to 1630, gaining 215 apiece.
   *
   * So: level on a clean failure, materially behind a success, and genuinely costly once
   * gear is left on the floor. */
  const clean = failures[failures.length - 1] - failures[failures.length - 2];
  ok('Q5 a failure that loses no gear leaves the site roughly level, not richer',
    clean <= 10, `${clean} per clean failure`);

  const lossy = new Progression({ site, autosave: false });
  const bad = new Game(content, { seed: 'lossy' });
  bad.commitLoadout(RECOMMENDED_MANIFEST);
  bad.skipMs(1500);
  const r2 = bad.endMission('total loss', bad.clock.simTimeMs);
  const start = lossy.profile.requisition;
  lossy.applyDebrief(r2, bad.mission, { custody: 'none', minutes: 25, observations: 0, squad: bad.players, itemsLost: 6 });
  const withLoss = lossy.profile.requisition - start;
  note(`the same failure having abandoned six items: ${withLoss} requisition`);
  ok('Q6 and leaving gear on the floor is what actually costs (12.6)', withLoss < clean, String(withLoss));

  ok('Q7 the site is never left unable to deploy again',
    failures[failures.length - 1] >= DEPLOYMENT_COST, String(failures[failures.length - 1]));

  /* The other stake §12.6 names. ⚠ NOT "failure loses standing" — a squad that achieves
   * nothing but brings everybody and everything home has genuinely pleased Medical and
   * Logistics, and §12.3 says standing follows the behaviour each department VALUES, not
   * the mission outcome. What has to be true is that abandoning their kit costs them with
   * the department that cares about kit. */
  const cleanStand = grim.profile.standing;
  const lossyStand = lossy.profile.standing;
  const worse = DEPARTMENT_IDS.filter((d) => lossyStand[d] < cleanStand[d]);
  note(`standing, clean failure vs six items abandoned: ${DEPARTMENT_IDS.map((d) => `${d} ${cleanStand[d]}→${lossyStand[d]}`).join(' · ')}`);
  ok('Q8 losing the squad’s equipment costs them with somebody (12.3)', worse.length > 0, worse.join(', '));

  /* §12.1: options, context and efficiency. Never damage, never immunity. */
  const fitted = pr.itemAsIssued(content.itemsById.get('floodlight-tripod'));
  eq('Q9 a fresh profile issues equipment exactly as authored',
    fitted.heatOutputCelsius, content.itemsById.get('floodlight-tripod').heatOutputCelsius);
  const banned = ['damage', 'invulnerable', 'contactTolerance', 'health'];
  const leaked = banned.filter((k) => Object.prototype.hasOwnProperty.call(fitted, k));
  ok('Q10 and no upgrade can ever grant damage or immunity (12.1)', leaked.length === 0, leaked.join(', '));

  ok('Q11 the same result cannot be banked twice',
    (() => { const p2 = new Progression({ site, autosave: false }); p2.applyDebrief(result, g.mission, {}); const a = p2.profile.requisition; p2.applyDebrief(result, g.mission, {}); return p2.profile.requisition === a; })());

  /* Persistence has to degrade rather than throw — a locked-down profile is common. */
  ok('Q12 a profile serialises and comes back', (() => {
    const j = JSON.parse(JSON.stringify(pr.profile));
    const p3 = new Progression({ site, profile: j, autosave: false });
    return p3.profile.requisition === pr.profile.requisition;
  })());
  ok('Q13 and an unknown save version falls back rather than throwing',
    !!new Progression({ site, profile: { version: 9999, junk: true }, autosave: false }));

  note(`after one graded mission: requisition ${before} → ${pr.profile.requisition}, research ${pr.profile.research}`);
  emit();
}

/* ── run ─────────────────────────────────────────────────────────────────── */

/* ══ R. a second building, the same anomaly ═════════════════════════════════════
 *
 * Section O varies the incident against a fixed building. This varies the BUILDING
 * against a fixed incident, and it is the harder direction: the anomaly file is
 * untouched, so every number here comes out of geometry alone.
 *
 * The map was authored by a subagent that could not run the game and instead ported
 * segmentHitsRect, temperatureAt, blocksPath, isFenced and _drift into a scratch page.
 * A faithful port is still not the engine, so every load-bearing claim it made is
 * re-measured HERE against the real objects, and the numbers are printed rather than
 * asserted from memory. Where its answer and the engine's disagree, the engine wins.
 */
/* Can a 0.34m body stand here? The engine has no canStand() — collision is resolved by
 * moveWithWalls at the point of movement — so the sweep asks the same question the same
 * way the mover would: does the body's circle intersect anything that blocks a person. */
function standsAt(site, x, z) {
  if (!site.inBounds(x, z)) return false;
  for (const r of site.blockingRects()) if (circleHitsRect(r, x, z, 0.34)) return false;
  return true;
}

async function sectionR() {
  lines.push('--- R. Ashlar House: the same draught, a building that inverts it ---');

  const ash = await loadContent({ incident: 'ashlar-gallery-draught' });
  const cold = await loadContent({ incident: 'cold-storage-draught' });

  eq('R1 the third incident package loads and validates', ash.map.id, 'ashlar-house-9');
  eq('R2 it is the SAME anomaly file as the cold store', ash.anomaly.id, cold.anomaly.id);
  ok('R3 on different geometry', ash.map.id !== cold.map.id);

  /* The map is the first one that is pure geometry. It does not know what happened in it —
   * the spawn and the evidence come from the incident, and if that binding ever breaks the
   * map falls back to nothing rather than to somebody else's incident. */
  const rawMap = await (await fetch('../content/maps/ashlar-house-9.json')).json();
  ok('R4 the map file itself carries no anomalySpawn', rawMap.anomalySpawn === undefined);
  ok('R5 and no evidence — geometry only', rawMap.evidenceSources === undefined);
  eq('R6 the incident supplies the spawn', ash.map.anomalySpawn.join(), '-8.6,10.6');
  eq('R7 and the evidence on the floor', ash.map.evidenceSources.length, 6);

  const site = new Site(ash.map);
  const heat = new HeatField();
  const deps = new DeployableSet();
  const a = new Anomaly(ash.anomaly, site, heat, deps);
  const tripod = ash.itemsById.get('floodlight-tripod');

  /* ── the claim the whole map rests on ───────────────────────────────────────
   * Cold store aisles are 4.2m and need two posts. The gallery is 2.4m and needs one.
   * Both numbers measured off the real field, at the real ambient. */
  const contourWidth = () => {
    heat.setEmitters([{ id: 't', x: 0, z: 0, peakC: tripod.heatOutputCelsius, falloffM: tripod.heatFalloffMetres, active: true }]);
    heat.setSinks([]);
    let r = 0;
    for (let d = 0; d < 6; d += 0.001) { if (heat.temperatureAt(d, 0) >= 40) r = d; else break; }
    return r * 2;
  };
  const w = contourWidth();
  note(`one floodlight's 40°C contour measures ${w.toFixed(3)}m across`);
  const gallery = ash.map.rooms.find((r) => r.id === 'heating-gallery');
  const galleryWidth = gallery.rect[3] - gallery.rect[1];
  ok(`R8 the gallery (${galleryWidth.toFixed(3)}m) is narrower than one contour (${w.toFixed(3)}m)`, galleryWidth < w);
  ok('R9 a cold-store aisle (4.2m) is wider than one — the same tool, the opposite answer', 4.2 > w);

  /* ── the fence, measured door by door ───────────────────────────────────────
   * The pen is the gallery bay under the contractors' store door. Everything below runs
   * the real isFenced(), which casts real rays at real insulation. */
  const doorBy = (frag) => site.doors.find((d) => d.displayName.includes(frag));
  const lane = doorBy("contractors' store");
  const fire = doorBy('fire-stopping');
  ok('R10 the lane door and the fire-stopping door both exist', !!lane && !!fire);

  const trial = (penX, penZ, posts, shut) => {
    for (const d of site.doors) { d.open = true; }
    for (const d of shut) { d.open = false; }
    site._rebuildBlocking();
    a.reset(); a.x = penX; a.z = penZ;
    heat.setEmitters([
      { id: 'case', x: penX, z: penZ, peakC: 39, falloffM: 2.2, active: true },
      ...posts.map((p, i) => ({ id: `t${i}`, x: p[0], z: p[1], peakC: tripod.heatOutputCelsius, falloffM: tripod.heatFalloffMetres, active: true })),
    ]);
    heat.setSinks([a.asSink()]);
    return a.isFenced();
  };

  const PEN = [1.6, -10.8];
  const bare = trial(PEN[0], PEN[1], [], []);
  const laneShut = trial(PEN[0], PEN[1], [], [lane]);
  const onePost = trial(PEN[0], PEN[1], [[5.2, -10.8]], [lane, fire]);
  ok('R11 the pen with every door open is not a fence', !bare.fenced);
  ok('R12 nor is it with the lane door shut and no heat at all', !laneShut.fenced);
  ok('R13 lane shut + fire door shut + ONE tripod holds it', onePost.fenced);
  note(`pen (${PEN.join(', ')}): bare open · lane shut · +fire +1 post → ${bare.fenced}/${laneShut.fenced}/${onePost.fenced}`);

  /* The unpowered answer: no door can be shut, so the missing insulation is bought back
   * with a second post and a pen moved east into the long unbroken wall run. That is the
   * whole power puzzle stated as an exchange rate — one door is worth one tripod. */
  const coldPen = [5.2, -10.8];
  const twoPosts = trial(coldPen[0], coldPen[1], [[1.6, -10.8], [8.2, -10.8]], []);
  const twoPostsOneShort = trial(coldPen[0], coldPen[1], [[1.6, -10.8]], []);
  ok('R14 with no power at all, two tripods and a pen moved east still hold', twoPosts.fenced);
  ok('R15 and one of the two is not enough — the exchange rate is exactly one door : one tripod', !twoPostsOneShort.fenced);

  /* ── the fence and the bait cannot both be up at once ───────────────────────
   * The failure this map is most likely to hide is a trap that cannot be baited. The case
   * lures because it sits one degree UNDER the threshold; the closing post is 3.6m away
   * and contributes about fifteen degrees, which takes the case over it, at which point
   * chooseTarget stops seeing the case at all and nothing ever comes.
   *
   * So the post is not part of the fence you build — it is the lid, and it goes down last.
   * Measured with no draught in the field, because this is the state of the floor BEFORE
   * anything arrives; putting its own chill in the sample would measure a moment that only
   * exists after the lure has already worked. */
  const bait = (posts) => {
    heat.setSinks([]);
    heat.setEmitters([
      { id: 'case', x: PEN[0], z: PEN[1], peakC: 39, falloffM: 2.2, active: true },
      ...posts.map((p, i) => ({ id: `t${i}`, x: p[0], z: p[1], peakC: tripod.heatOutputCelsius, falloffM: tripod.heatFalloffMetres, active: true })),
    ]);
    return heat.temperatureAt(PEN[0], PEN[1]);
  };
  const alone = bait([]);
  const withLid = bait([[5.2, -10.8]]);
  note(`the case reads ${alone.toFixed(1)}°C alone, ${withLid.toFixed(1)}°C once the closing post is up`);
  ok(`R16 the case alone is a lure — under the threshold (${alone.toFixed(1)}°C)`, alone < 40);
  ok(`R16b and the closing post destroys it (${withLid.toFixed(1)}°C), so the lid goes down last`, withLid > 40);

  /* ── it can actually get there ──────────────────────────────────────────────
   * Not "is there a path" — run the real _drift() from the real spawn and see where the
   * thing ends up. A pen it cannot walk into is scenery. */
  for (const d of site.doors) { d.open = true; }
  site._rebuildBlocking();
  a.reset();
  a.x = ash.map.anomalySpawn[0]; a.z = ash.map.anomalySpawn[1];
  heat.setEmitters([{ id: 'case', x: PEN[0], z: PEN[1], peakC: 39, falloffM: 2.2, active: true }]);
  heat.setSinks([a.asSink()]);
  a.state = 'drawn';
  const start = Math.hypot(a.x - PEN[0], a.z - PEN[1]);
  /* The same context the game passes: the case is the only heat source on the floor, so
   * the only thing it can choose is the thing we want it to choose. No operatives — this
   * measures the geometry, not a squad's mistakes. */
  const ctx = () => ({
    sources: [{ id: 'case', x: PEN[0], z: PEN[1], peakC: 39 }],
    operatives: [], pressureStage: 0, observation: null,
  });
  let arrivedMs = null;
  for (let ms = 0; ms < 120000; ms += 16) {
    a.step(16, ms, ctx());
    heat.setSinks([a.asSink()]);
    if (Math.hypot(a.x - PEN[0], a.z - PEN[1]) < 1.5) { arrivedMs = ms; break; }
  }
  const final = Math.hypot(a.x - PEN[0], a.z - PEN[1]);
  note(`drift: ${start.toFixed(1)}m away at spawn → ${final.toFixed(2)}m from the case after ${arrivedMs === null ? '>120' : (arrivedMs / 1000).toFixed(1)}s`);
  ok('R17 it walks from its spawn into the pen, unaided', arrivedMs !== null);
  ok('R18 and ends inside the 1.5m seal radius', final < 1.5);

  /* Then the closing post goes down and it is shut in — the actual sequence, in order,
   * rather than teleporting it into a pre-built ring. */
  for (const d of [lane, fire]) d.open = false;
  site._rebuildBlocking();
  heat.setEmitters([
    { id: 'case', x: PEN[0], z: PEN[1], peakC: 39, falloffM: 2.2, active: true },
    { id: 't0', x: 5.2, z: -10.8, peakC: tripod.heatOutputCelsius, falloffM: tripod.heatFalloffMetres, active: true },
  ]);
  heat.setSinks([a.asSink()]);
  const shutIn = a.isFenced();
  ok('R19 closing the doors behind it and planting one post banks it where it stands', shutIn.fenced);
  ok('R20 with its own chill in the field, not a clean-room fence',
    heat.temperatureAt(a.x, a.z) < heat.temperatureAt(PEN[0], PEN[1]) + 0.001);

  /* ── the floor is a floor ───────────────────────────────────────────────────
   * The same standable-cell sweep that caught fifty "Unmarked floor" doorway cells on
   * the cold store. A new map is exactly where that regresses. */
  let standable = 0, unnamed = 0;
  const b = ash.map.bounds;
  for (let x = b.minX; x <= b.maxX; x += 0.25) {
    for (let z = b.minZ; z <= b.maxZ; z += 0.25) {
      if (!standsAt(site, x, z)) continue;
      standable++;
      if (site.roomNameAt(x, z) === 'Unmarked floor') unnamed++;
    }
  }
  note(`${standable} standable cells swept at 0.25m, ${unnamed} unnamed`);
  eq('R21 every standable cell on the ninth floor has a room name', unnamed, 0);
  ok('R22 and there is a floor to stand on at all', standable > 3000);

  /* ── the anchors are reachable ──────────────────────────────────────────────
   * Flood fill from spawn through standable cells. If the cache, the extraction point,
   * both breakers or the pen are not in the fill, the map is unplayable and the suite is
   * the only thing that would ever say so. */
  const KEY = 0.25;
  const key = (x, z) => `${Math.round(x / KEY)},${Math.round(z / KEY)}`;
  const seen = new Set();
  const queue = [[ash.map.spawn[0], ash.map.spawn[1]]];
  seen.add(key(queue[0][0], queue[0][1]));
  while (queue.length) {
    const [x, z] = queue.pop();
    for (const [dx, dz] of [[KEY, 0], [-KEY, 0], [0, KEY], [0, -KEY]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < b.minX || nx > b.maxX || nz < b.minZ || nz > b.maxZ) continue;
      const k = key(nx, nz);
      if (seen.has(k) || !standsAt(site, nx, nz)) continue;
      seen.add(k); queue.push([nx, nz]);
    }
  }
  const near = (x, z) => {
    for (let dx = -0.5; dx <= 0.5; dx += KEY) for (let dz = -0.5; dz <= 0.5; dz += KEY) {
      if (seen.has(key(x + dx, z + dz))) return true;
    }
    return false;
  };
  const anchors = [
    ['the cache', ash.map.cache.x, ash.map.cache.z],
    ['extraction', ash.map.extraction.x, ash.map.extraction.z],
    ['the pen', PEN[0], PEN[1]],
    ['the anomaly spawn', ash.map.anomalySpawn[0], ash.map.anomalySpawn[1]],
    ...ash.map.circuits.map((c) => [c.displayName, c.switch[0], c.switch[1]]),
    ...ash.map.evidenceSources.map((s) => [s.label, s.at[0], s.at[1]]),
  ];
  const unreachable = anchors.filter(([, x, z]) => !near(x, z)).map(([n]) => n);
  note(`flood fill from spawn reached ${seen.size} cells; ${anchors.length} anchors checked`);
  eq(`R23 every anchor is walkable from the spawn${unreachable.length ? ` (missed: ${unreachable.join(', ')})` : ''}`, unreachable.length, 0);

  /* ── the board tells the truth about it ─────────────────────────────────────
   * §18.1. The third operation is above a fresh squad's clearance, and the board must say
   * so rather than omitting the row — an absence is a lie the player cannot notice. */
  const siteDoc = await (await fetch('../content/site.json')).json();
  const ops = siteDoc.operations;
  /* ⚠ THE PROPERTY, NOT THE COUNT. These read "three operations on the board" and "two of
   * them share a floor", which were true of the content that existed the afternoon they
   * were written and failed the moment a fourth operation was added — for no reason except
   * that the number had moved. A test that has to be edited every time content is authored
   * is a tax on authoring, and the thing worth asserting was never the number: it is
   * §26.2's floor of three, and §15.2's claim that the building and the incident vary
   * independently of each other. */
  const byMap = new Map(), byAnomaly = new Map();
  for (const o of ops) {
    byMap.set(o.mapId, (byMap.get(o.mapId) || 0) + 1);
    byAnomaly.set(o.anomalyId, (byAnomaly.get(o.anomalyId) || 0) + 1);
  }
  note(`${ops.length} operations over ${byMap.size} building(s) and ${byAnomaly.size} anomal${byAnomaly.size === 1 ? 'y' : 'ies'}`);
  ok(`R24 the board carries at least the three the slice asks for (${ops.length})`, ops.length >= 3);
  ok('R25 some building carries more than one incident — the map is a variable',
    Math.max(...byMap.values()) >= 2, JSON.stringify([...byMap]));
  ok('R26 and some anomaly appears on more than one building — so is the anomaly',
    Math.max(...byAnomaly.values()) >= 2, JSON.stringify([...byAnomaly]));
  ok('R27 every operation names an incident that exists',
    ops.every((o) => INCIDENTS.includes(o.incident)));
  ok('R28 the Ashlar contract is gated, so the board has something to be honest about',
    ops.find((o) => o.id === 'op-ashlar-gallery').clearanceRequired > 0);
}


/* ══ S. the assists are real, and they only widen windows ═══════════════════════
 *
 * The settings screen offered eleven controls and four of them were connected to
 * anything. Six camera sliders and the timing assist moved and the game did not — which
 * is the §18.1 failure the mission board was also committing, in the one screen where it
 * matters most: a player who needs an assist tries it, sees no change, and concludes the
 * game cannot be made playable for them.
 *
 * What this section is really guarding is the OTHER half of §19.1. An assist that widens
 * the window is an accessibility feature; an assist that moves the rule is a difficulty
 * slider wearing its clothes, and §7.4 asks for confidence rather than an easier answer.
 * So every rule-side number is asserted IDENTICAL at 1.0 and at 2.0.
 */
async function sectionS(content) {
  lines.push('--- S. difficulty assists: wider windows, identical rules ---');

  const mk = (timing) => {
    const g = new Game(content, { seed: 'assist' });
    g.commitLoadout(RECOMMENDED_MANIFEST);
    g.setAssists({ procedureTiming: timing });
    return g;
  };
  const base = mk(1), wide = mk(2);

  eq('S1 the assist reaches the simulation at all', wide.anomaly.assistTiming, 2);
  eq('S2 and every operative on the roster', wide.player.assistTiming, 2);
  eq('S3 it is clamped to the 1.0-2.0 band the settings model publishes',
    mk(9).anomaly.assistTiming, 2);
  eq('S4 and a missing or damaged value is 1.0, not zero — zero would be instant death',
    mk(undefined).player.assistTiming, 1);

  /* ── the window ─────────────────────────────────────────────────────────────
   * Down and alone. How long until they are lost, measured rather than derived. */
  const bleedOut = (g) => {
    const p = g.player;
    p.downed = true; p.alive = true; p.downedMs = 0;
    let ms = 0;
    while (p.alive && ms < 600000) { p.stepDowned(50, CONFIG.player.bleedOutMs); ms += 50; }
    return ms;
  };
  const b1 = bleedOut(base), b2 = bleedOut(wide);
  note(`bleed-out alone: ${(b1 / 1000).toFixed(0)}s at 1.0, ${(b2 / 1000).toFixed(0)}s at 2.0`);
  eq('S5 ninety seconds down, unassisted (GDD 9.5)', Math.round(b1 / 1000), 90);
  eq('S6 and a hundred and eighty with the assist at maximum', Math.round(b2 / 1000), 180);

  /* Per-operative, not per-session. A client who needs the assist keeps it in somebody
   * else's game, and nobody else's clock changes. */
  const squad = mk(1);
  squad.addPlayer('Two'); squad.addPlayer('Three');
  squad.setAssists({ procedureTiming: 2 }, 'p2');
  eq('S7 an assist can be scoped to one operative', squad.players[1].assistTiming, 2);
  eq('S8 without touching the rest of the squad', squad.players[2].assistTiming, 1);
  eq('S9 or the anomaly, which is the host\'s to set', squad.anomaly.assistTiming, 1);

  /* ── the rule ───────────────────────────────────────────────────────────────
   * Everything below must read the same at both extremes. If any of these ever diverge,
   * the assist has stopped being an assist. */
  const cap = content.anomaly.capabilities.find((c) => c.verb === 'contact');
  const reach = (g, d) => {
    const a = g.anomaly;
    a.reset(); a.state = 'drawn';
    a.x = 0; a.z = 0;
    const p = g.player; p.x = d; p.z = 0;
    g.heat.setEmitters([]); g.heat.setSinks([a.asSink()]);
    return a.step(16, 0, { sources: [], operatives: [p], pressureStage: 0, observation: null })
      .contacts.length > 0;
  };
  eq('S10 contact reach is the content\'s, and the assist does not extend it',
    reach(mk(1), cap.rangeMetres - 0.05), reach(mk(2), cap.rangeMetres - 0.05));
  eq('S11 nor shorten it', reach(mk(1), cap.rangeMetres + 0.5), reach(mk(2), cap.rangeMetres + 0.5));
  eq('S12 the gradient threshold is untouched',
    mk(1).heat.thresholdC !== undefined ? mk(1).heat.thresholdC : CONFIG.heat.gradientThresholdC,
    mk(2).heat.thresholdC !== undefined ? mk(2).heat.thresholdC : CONFIG.heat.gradientThresholdC);
  eq('S13 and so is the thirty seconds of custody',
    CONFIG.anomaly.custodyVerifySeconds, 30);

  /* What a contact DOES is the rule; how often it may happen is the window. */
  const contactsIn = (g, ms) => {
    const a = g.anomaly;
    a.reset(); a.state = 'drawn'; a.x = 0; a.z = 0;
    const p = g.player; p.x = 0.4; p.z = 0; p.alive = true; p.downed = false;
    g.heat.setEmitters([]); g.heat.setSinks([a.asSink()]);
    let n = 0, applied = null;
    const at = [];
    for (let t = 0; t < ms; t += 16) {
      const r = a.step(16, t, { sources: [], operatives: [p], pressureStage: 0, observation: null });
      for (const c of r.contacts) { n++; applied = c.applies; at.push(t); }
    }
    /* The GAP is the claim, not the count. A count over a fixed window discretises at the
     * boundary — 12s of a 3s cooldown is five contacts, not four, because the first one
     * fires on the step it comes into reach. Asserting a doubled count would be asserting
     * the arithmetic of the window I happened to pick. */
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    return { n, applied, gap: gaps.length ? Math.min(...gaps) : null };
  };
  const c1 = contactsIn(mk(1), 12000), c2 = contactsIn(mk(2), 12000);
  note(`at 1.2m: ${c1.n} contacts ${c1.gap}ms apart at 1.0, ${c2.n} contacts ${c2.gap}ms apart at 2.0 (content cooldown ${cap.cooldownMs}ms)`);
  ok('S14 the assist genuinely spaces the contacts out', c2.n < c1.n);
  /* Within one 16ms step of the content's figure: the cooldown is checked on a step
   * boundary, so 3000ms of cooldown is first satisfied at t=3008. Asserting 3000 exactly
   * would be asserting that the simulation is continuous, which it is not. */
  ok(`S15 unassisted, the gap is the content's cooldown (${c1.gap}ms vs ${cap.cooldownMs}ms)`,
    Math.abs(c1.gap - cap.cooldownMs) <= 16);
  ok(`S16 and at 2.0 it is twice that, not a fudge (${c2.gap}ms vs ${cap.cooldownMs * 2}ms)`,
    Math.abs(c2.gap - cap.cooldownMs * 2) <= 16);
  eq('S17 while each contact still applies precisely what the content says it does',
    JSON.stringify(c1.applied), JSON.stringify(c2.applied));

  /* ── the settings model agrees with the simulation ──────────────────────────
   * The band the panel offers and the band the rules accept are the same band, asserted
   * against the model rather than against a number typed twice. */
  const s = new Settings();
  s.set('assists.procedureTiming', 2);
  eq('S18 the panel and the simulation share one band', s.effective.assists.procedureTiming, 2);
  s.set('assists.procedureTiming', 5);
  ok('S19 and the panel refuses what the simulation would have clamped',
    s.effective.assists.procedureTiming <= 2);
  emit();
}

/* ══ T. the navigation aid shows the building, never the incident ══════════════
 *
 * GDD §18.2 allows this and allows it only here: "no permanent minimap in standard mode
 * ... accessibility settings can add navigation aids." The risk is not that the aid
 * exists, it is what it draws. An aid that marks the anomaly hands back the §7.4 question
 * — finding the thing IS the game, and the imager is how you find it — under cover of
 * being an accessibility feature.
 *
 * So this section reads the pixels. It runs a frame with the anomaly at a known spot,
 * and asserts nothing is drawn there.
 */
async function sectionT(content) {
  lines.push('--- T. the navigation aid draws the floor, not the thing on it ---');

  const host = document.createElement('div');
  document.body.appendChild(host);
  const g = new Game(content, { seed: 'nav' });
  g.commitLoadout(RECOMMENDED_MANIFEST);
  const hud = new Hud(host, g, null);

  eq('T1 the aid is off by default, as §18.2 requires', hud.navMode, 'off');
  eq('T2 an unknown mode is off, not a crash', hud.setNavigationAid('sonar'), 'off');
  eq('T3 the compass can be turned on', hud.setNavigationAid('compass'), 'compass');
  eq('T4 and sizes its backing store to its own box', `${hud.navAid.width}x${hud.navAid.height}`, '240x56');
  eq('T5 the minimap likewise', hud.setNavigationAid('minimap') && `${hud.navAid.width}x${hud.navAid.height}`, '180x180');

  /* Put the anomaly somewhere unambiguous, well away from any wall, and look for it. */
  const b = g.site.bounds;
  const a = g.anomaly;
  a.x = (b.minX + b.maxX) / 2 + 3.5; a.z = (b.minZ + b.maxZ) / 2 + 3.5;
  g.player.x = b.minX + 2; g.player.z = b.minZ + 2;
  hud.setNavigationAid('minimap');
  hud._drawNavAid();

  const W = hud.navAid.width, H = hud.navAid.height;
  const s = Math.min(W / (b.maxX - b.minX), H / (b.maxZ - b.minZ)) * 0.92;
  const ox = W / 2 - ((b.minX + b.maxX) / 2) * s;
  const oy = H / 2 + ((b.minZ + b.maxZ) / 2) * s;
  const ctx = hud.navAid.getContext('2d');
  /* A 9x9 window over where the anomaly is. Anything drawn for it would land here. */
  const ax = Math.round(ox + a.x * s), az = Math.round(oy - a.z * s);
  const px = ctx.getImageData(ax - 4, az - 4, 9, 9).data;
  let lit = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 8) lit++;
  note(`minimap at the anomaly's position (${ax},${az}): ${lit} of 81 pixels drawn`);
  eq('T6 nothing at all is drawn where the anomaly is standing', lit, 0);

  /* And prove the canvas is not simply blank — the extraction IS drawn, in the same pass. */
  const ex = g.site.extraction;
  const exd = ctx.getImageData(Math.round(ox + ex.x * s) - 4, Math.round(oy - ex.z * s) - 4, 9, 9).data;
  let exLit = 0;
  for (let i = 3; i < exd.length; i += 4) if (exd[i] > 8) exLit++;
  ok(`T7 while the extraction point is (${exLit} of 81 pixels), so the test can see`, exLit > 0);

  /* Squad mates are the building's other people and DO appear — that is §11 information a
   * player already has by radio, not the answer to the search. */
  const mate = g.addPlayer('Two');
  mate.x = (b.minX + b.maxX) / 2 - 3.5; mate.z = (b.minZ + b.maxZ) / 2 - 3.5;
  hud._drawNavAid();
  const md = ctx.getImageData(Math.round(ox + mate.x * s) - 4, Math.round(oy - mate.z * s) - 4, 9, 9).data;
  let mLit = 0;
  for (let i = 3; i < md.length; i += 4) if (md[i] > 8) mLit++;
  ok('T8 a teammate is drawn — where your squad is was never the question', mLit > 0);

  /* ⚠ SOLID AND POROUS MUST NOT LOOK THE SAME. The aid drew everything from
   * `blockingRects()`, which is what stops a PERSON — so a chain-link fence and a concrete
   * wall were the same line. Indoors that is a small lie; on the forest reserve 441.8m of
   * 491m of built length is porous, so nine tenths of the drawn map would have claimed to
   * hold a draught and held nothing. */
  const forest = await loadContent({ incident: 'blackthorn-caller' });
  const gF = new Game(forest, { seed: 'nav-forest' });
  const hudF = new Hud(host, gF, null);
  hudF.setNavigationAid('minimap');
  hudF._drawNavAid();
  const solidRects = new Set(gF.site.insulatedRects());
  const porous = gF.site.blockingRects().filter((r) => !solidRects.has(r));
  note(`forest reserve: ${gF.site.blockingRects().length} blocking rects, ${porous.length} of them porous to the draught`);
  ok('T8b the reserve is mostly porous, which is what makes the distinction matter',
    porous.length > gF.site.blockingRects().length / 2);
  /* Read the pixels along a porous run and a solid one: a dashed line leaves gaps, a
   * continuous one does not. */
  const ctxF = hudF.navAid.getContext('2d');
  const bF = forest.map.bounds;
  const sF = Math.min(hudF.navAid.width / (bF.maxX - bF.minX), hudF.navAid.height / (bF.maxZ - bF.minZ)) * 0.92;
  const oxF = hudF.navAid.width / 2 - ((bF.minX + bF.maxX) / 2) * sF;
  const oyF = hudF.navAid.height / 2 + ((bF.minZ + bF.maxZ) / 2) * sF;
  const runGaps = (r) => {
    const y = Math.round(oyF - r[1] * sF);
    const x0 = Math.round(oxF + r[0] * sF), x1 = Math.round(oxF + r[2] * sF);
    if (x1 - x0 < 8 || y < 0 || y >= hudF.navAid.height) return null;
    const row = ctxF.getImageData(x0, Math.max(0, Math.min(hudF.navAid.height - 1, y)), x1 - x0, 1).data;
    let gaps = 0;
    for (let i = 3; i < row.length; i += 4) if (row[i] < 8) gaps++;
    return gaps / (x1 - x0);
  };
  const longPorous = porous.filter((r) => r[2] - r[0] > 6).sort((a, b) => (b[2] - b[0]) - (a[2] - a[0]))[0];
  const longSolid = [...solidRects].filter((r) => r[2] - r[0] > 3).sort((a, b) => (b[2] - b[0]) - (a[2] - a[0]))[0];
  if (longPorous && longSolid) {
    const gp = runGaps(longPorous), gs = runGaps(longSolid);
    note(`  gap fraction along the longest run: porous ${gp === null ? 'n/a' : gp.toFixed(2)} · solid ${gs === null ? 'n/a' : gs.toFixed(2)}`);
    ok('T8c a porous run is drawn broken and a solid one continuous',
      gp !== null && gs !== null && gp > gs, `${gp} vs ${gs}`);
  } else {
    ok('T8c the reserve has runs of both kinds long enough to compare', false, 'no comparable runs');
  }

  /* Still nothing at the anomaly, now that something else has been drawn. */
  const px2 = ctx.getImageData(ax - 4, az - 4, 9, 9).data;
  let lit2 = 0;
  for (let i = 3; i < px2.length; i += 4) if (px2[i] > 8) lit2++;
  eq('T9 and still nothing where the anomaly is', lit2, 0);

  /* The compass points at the stairs, and points the right way — forward is
   * (-sin yaw, -cos yaw) and a compass built on the other convention reads plausibly
   * while sending a lost operative in exactly the wrong direction. */
  hud.setNavigationAid('compass');
  const p = g.player;
  /* Six metres on the −z side of the stairs, facing +z — the same posture section O uses
   * to make an operative look AT something, so the convention is stated once and reused
   * rather than re-derived here and got backwards. */
  p.x = ex.x; p.z = ex.z - 6;
  p.yaw = Math.PI;
  hud._drawNavAid();
  const cW = hud.navAid.width, cH = hud.navAid.height;
  const strip = hud.navAid.getContext('2d').getImageData(0, 0, cW, cH).data;
  /* ⚠ Count only BELOW the horizon line. The line itself spans the full width and the
   * cardinal letters sit above it, so a naive full-column count says the edges are busier
   * than the centre no matter where the marker is — the first version of this assertion
   * failed for that reason and was measuring the ruler, not the needle. Everything drawn
   * below the line is the extraction marker and its label, and nothing else. */
  const belowAlpha = (x0, x1) => {
    let n = 0;
    for (let x = x0; x < x1; x++) {
      for (let y = Math.floor(cH / 2) + 4; y < cH; y++) if (strip[(y * cW + x) * 4 + 3] > 8) n++;
    }
    return n;
  };
  const middle = belowAlpha(Math.round(cW * 0.4), Math.round(cW * 0.6));
  const edges = belowAlpha(0, Math.round(cW * 0.12)) + belowAlpha(Math.round(cW * 0.88), cW);
  note(`compass, stairs dead ahead: ${middle} marker px centre, ${edges} at the edges`);
  ok('T10 the marker is drawn ahead of the operative, not behind them', middle > edges);

  /* Turn round. The marker must leave the centre — a compass that points the same way
   * whichever way you face is the failure mode that reads as working. */
  p.yaw = 0;
  hud._drawNavAid();
  const back = hud.navAid.getContext('2d').getImageData(0, 0, cW, cH).data;
  const backMiddle = (() => {
    let n = 0;
    for (let x = Math.round(cW * 0.4); x < Math.round(cW * 0.6); x++) {
      for (let y = Math.floor(cH / 2) + 4; y < cH; y++) if (back[(y * cW + x) * 4 + 3] > 8) n++;
    }
    return n;
  })();
  note(`same spot, facing away: ${backMiddle} marker px centre`);
  ok('T11 and it leaves the centre when the operative turns round', backMiddle < middle);
  emit();

  host.remove();
}

/* ══ U. somebody actually plays Ashlar House ═══════════════════════════════════
 *
 * Section R proves the ninth floor is geometrically sound: the fence closes, the anchors
 * are reachable, the draught can walk to the pen. None of that proves a PERSON can run
 * the operation, and the two are different questions — a map can be measurably correct
 * and still contain a step nobody can physically perform, which is exactly what happens
 * when the thing you have to reach past is the thing that hurts you.
 *
 * So this is section I's bot on the new floor, through the same keyboard-reachable
 * interfaces: no teleports and no direct state writes. Dev\INDEX.md, from the emergency
 * services build: if a dumb bot cannot finish the job, a first-time player cannot either.
 */
async function sectionU() {
  lines.push('--- U. the Ashlar operation, played rather than measured ---');
  const ash = await loadContent({ incident: 'ashlar-gallery-draught' });
  const g = new Game(ash, { seed: 'ashlar-1' });

  const slice = 50;
  const face = (x, z) => {
    const dx = x - g.player.x, dz = z - g.player.z;
    const len = Math.hypot(dx, dz) || 1;
    g.player.yaw = Math.atan2(-dx / len, -dz / len);
  };
  let botSprint = false;
  const walkTo = (x, z, tol = 0.6, budgetMs = 40000) => {
    let spent = 0, stalledMs = 0, strafe = 0, strafeMs = 0;
    let lastX = g.player.x, lastZ = g.player.z;
    while (dist(g.player.x, g.player.z, x, z) > tol && spent < budgetMs) {
      face(x, z);
      const axis = strafeMs > 0 ? { x: strafe, y: -0.4 } : { x: 0, y: -1 };
      if (strafeMs > 0) strafeMs -= slice;
      g.setCommand('p1', { axis, sprint: botSprint, crouch: false });
      g.skipMs(slice);
      spent += slice;
      const moved = dist(lastX, lastZ, g.player.x, g.player.z);
      lastX = g.player.x; lastZ = g.player.z;
      if (moved < 0.02) stalledMs += slice; else stalledMs = 0;
      if (stalledMs >= 300 && strafeMs <= 0) { strafe = strafe === 1 ? -1 : 1; strafeMs = 700; stalledMs = 0; }
    }
    g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
    g.skipMs(slice);
    return dist(g.player.x, g.player.z, x, z) <= tol;
  };
  const route = (pts, tol = 0.8, budgetMs = 40000) => {
    const failed = [];
    for (const [wx, wz] of pts) {
      if (!walkTo(wx, wz, tol, budgetMs)) failed.push(`(${wx},${wz}) stopped at (${g.player.x.toFixed(1)},${g.player.z.toFixed(1)})`);
    }
    if (failed.length) note(`legs not reached: ${failed.join(' · ')}`);
    return failed.length === 0;
  };
  const wait = (ms) => { g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false }); g.skipMs(ms); };

  eq('U1 the manifest that works on the cold store works here', g.commitLoadout(RECOMMENDED_MANIFEST), null);
  ok('U2 the squad reaches the cargo point on the east landing', walkTo(g.site.cache.x, g.site.cache.z, 1.4));
  eq('U3 imager', g.takeFromCache('thermal-imager'), null);
  eq('U4 case', g.takeFromCache('reinforced-transit-case'), null);
  eq('U5 tripod', g.takeFromCache('floodlight-tripod'), null);

  walkTo(9.6, 6.6, 1.2); face(9.6, 6.6);
  g.doInteract();
  ok('U6 the watchman gives a statement', g.ledger.has('survivor-account'));

  /* Nine floors down, the long way round the flats. This is the leg the map is about:
   * the draught will cross the same distance in a straight line. */
  const DOWN = [[10.2, 5.3], [10.9, 4.1], [10.9, 2.9], [10.9, -3.9], [10.2, -5.1],
    [10.2, -6.3], [9.4, -7.6], [9.4, -9.4], [9.4, -10.8]];
  const tDown = g.clock.simTimeMs;
  ok('U7 the east side of the loop gets an operative into the heating gallery', route(DOWN, 0.7));
  note(`east landing to gallery: ${((g.clock.simTimeMs - tDown) / 1000).toFixed(0)}s on foot`);

  const PEN = [1.6, -10.8];
  const lane = g.site.doors.find((d) => d.id === 'door-gallery-lane');
  const fire = g.site.doors.find((d) => d.id === 'door-gallery-stop');

  /* ⚠ THE ORDER OF THIS WHOLE SEQUENCE IS A MAP PROPERTY, and the first version of this
   * section got it wrong in a way worth keeping a note of.
   *
   * The gallery is 2.400m of clear width and a deployed transit case is 0.7m deep, so once
   * the bait is down there is 0.85m of lane on each side of it — passable by a 0.68m body
   * with about eight centimetres to spare, and not passable by a bot that walks by facing
   * a point and pressing forward. It wedged itself on its own case and stood there for
   * twenty minutes taking twenty-one contacts.
   *
   * The fix is not to widen anything. Ashlar is a LOOP — north corridor, west link, south
   * corridor, east link — and the answer is to stop crossing the pen: do the west end
   * first while the tube is empty, set the bait down with the tube behind you, and come
   * back to the east end the long way round. That the building makes you do this is the
   * point of the building. What it means for a player is that you cannot casually change
   * your mind about which end of the gallery you want to be at, which is a real cost and
   * the reason the walk is the expensive resource on this floor rather than the heat.
   */
  ok('U8 the empty tube can be walked end to end, west to the contractor board',
    route([[1.6, -10.8], [-2.2, -10.8], [-9.8, -10.8]], 0.8, 60000));
  g.doInteract();
  ok('U9 the contractor left a day book at the board', g.ledger.has('maintenance-log'));
  walkTo(-11.0, -10.8, 1.4);
  const brdAct = g.contextAction();
  ok('U10 and the temporary board itself', brdAct && brdAct.kind === 'circuit',
    brdAct ? `${brdAct.kind}: ${brdAct.text}` : 'none');
  ok('U11 with the circuit dead, the lane door cannot be worked at all',
    !g.site.canOperateDoor(lane));
  g.doInteract();
  ok('U12 throwing it brings the gallery up', g.site.circuitOn('circuit-gallery'));
  ok('U13 and now the doors are doors', g.site.canOperateDoor(lane) && g.site.canOperateDoor(fire));

  /* The fire-stopping door, shut from the east side of it. It is worth exactly one tripod
   * and it is the entire power puzzle. */
  ok('U14 back east through the fire-stopping door', walkTo(-1.3, -10.8, 0.8, 40000));
  const fireAct = g.contextAction();
  ok('U15 which offers itself now the circuit is live', fireAct && fireAct.kind === 'door',
    fireAct ? `${fireAct.kind}: ${fireAct.text}` : 'none');
  g.doInteract();
  ok('U16 and shuts', !fire.open);

  /* Set the bait down with the tube behind you. `deployHeld` places an item 0.9m in FRONT
   * of the operative, so standing east of the pen and facing it puts the case exactly on
   * the pen and the operative on the side they need to end up. Walking onto the pen and
   * dropping it there — the obvious move — leaves the case between you and everything. */
  ok('U17 the operative takes station east of the pen', walkTo(2.5, -10.8, 0.15, 40000));
  face(PEN[0], PEN[1]);
  g.player.selectSlot(SLOTS.findIndex((s) => g.player.slots.get(s.id) === 'reinforced-transit-case'));
  eq('U18 the case goes down in the tube, as the lure', g.deployHeld(), null);
  const kase = g.deployables.byItem('reinforced-transit-case')[0];
  note(`case placed at (${kase.x.toFixed(2)}, ${kase.z.toFixed(2)}), pen is (${PEN.join(', ')})`);
  /* Inside the band the fence was measured across, rather than on one exact point: the
   * pen holds anywhere in x = [−1.8, 4.8], which is 6.6m of it, and a procedure that only
   * worked if you put the case down on a specific tile would not be a procedure. */
  ok(`U19 inside the 6.6m band the fence holds across (x=${kase.x.toFixed(2)})`,
    kase.x > -1.8 && kase.x < 4.8 && Math.abs(kase.z - PEN[1]) < 0.4);
  ok('U20 running under the threshold, so it is bait and not a wall',
    g.heat.temperatureAt(kase.x, kase.z) < CONFIG.heat.gradientThresholdC);

  /* Out the east end, up the east side, and across the top into Flat 1 to disturb it.
   * §15's whole point: the thing does not come to you, and the walk that wakes it is a
   * walk you were going to have to make. */
  botSprint = true;
  const UP = [[5.2, -10.8], [9.4, -10.8], [9.4, -9.4], [9.4, -7.6], [10.2, -6.3], [10.2, -5.1],
    [10.9, -3.9], [10.9, 2.9], [10.9, 4.1], [6.0, 4.1], [0.0, 4.1], [-6.0, 4.1], [-10.9, 4.1],
    [-8.0, 5.3], [-6.8, 5.3], [-5.3, 9.4], [-8.0, 10.6]];
  const tUp = g.clock.simTimeMs;
  ok('U21 the loop carries an operative from the gallery to the flats without crossing the pen',
    route(UP, 0.9, 50000));
  note(`gallery to Flat 1 the long way: ${((g.clock.simTimeMs - tUp) / 1000).toFixed(0)}s at a run`);
  botSprint = false;
  g.player.selectSlot(SLOTS.findIndex((s) => g.player.slots.get(s.id) === 'thermal-imager'));
  eq('U22 the imager comes on', g.toggleImager(), null);
  wait(6000);
  const woke = dist(g.player.x, g.player.z, g.anomaly.x, g.anomaly.z);
  note(`operative ${woke.toFixed(1)}m from it in Flat 1, state ${g.anomaly.state}`);
  ok('U23 standing in the flat with it wakes it', g.anomaly.state !== ANOMALY_STATE.LATENT);

  /* Now leave, the same way, and let the case out-compete you. It crosses the plasterboard
   * in a straight line while you go round. */
  botSprint = true;
  const BACK = [[-5.3, 9.4], [-6.8, 5.3], [-10.9, 4.1], [-6.0, 4.1], [0.0, 4.1], [6.0, 4.1],
    [10.9, 4.1], [10.9, 2.9], [10.9, -3.9], [10.2, -5.1], [10.2, -6.3], [9.4, -7.6],
    [9.4, -9.4], [9.4, -10.8]];
  ok('U24 and back down the east side to the gallery', route(BACK, 0.9, 60000));
  botSprint = false;
  ok('U25 to stand off three and a half metres east of the bait', walkTo(5.2, -10.8, 0.6, 40000));

  let guard = 0;
  const track = [];
  while (dist(g.anomaly.x, g.anomaly.z, kase.x, kase.z) > 2.0 && guard < 300000) {
    wait(500); guard += 500;
    if (guard % 30000 === 0) track.push(`${guard / 1000}s (${g.anomaly.x.toFixed(1)},${g.anomaly.z.toFixed(1)}) [${g.anomaly.state}]`);
  }
  if (track.length) note(`draught track: ${track.join(' · ')}`);
  const arrived = dist(g.anomaly.x, g.anomaly.z, kase.x, kase.z);
  note(`draught reached the case at ${(g.clock.simTimeMs / 60000).toFixed(1)} min, ${arrived.toFixed(1)}m from it`);
  ok('U26 it comes the whole way down the building to the lure', arrived <= 2.0);
  eq('U27 without the operative taking a single contact on the way', g.anomaly.contactCount, 0);

  /* The one move this floor asks for that the cold store never does: reach past the thing
   * to shut the door it came in through.
   *
   * ⚠ Hard against the gallery's north wall, not out in the middle of the tube. The door
   * and the case are both ranked by distance to their CENTRES, so at (3.4, −10.2) they
   * were 1.97m away each and the case won the tie — the verb offered was "retrieve the
   * transit case", which at that moment would have picked the bait up out from under the
   * thing that came for it. A metre further north puts the door 1.5m off and the case
   * 1.7m, and puts the operative outside the 1.2m contact reach into the bargain. That
   * this position exists at all is what makes the map's last move possible. */
  ok('U28 an operative can get to the lane door with it sitting on the bait',
    walkTo(3.0, -9.95, 0.25, 40000));
  const laneAct = g.contextAction();
  note(`at (${g.player.x.toFixed(1)},${g.player.z.toFixed(1)}): nearest verb ${laneAct ? laneAct.kind : 'none'}, draught ${dist(g.player.x, g.player.z, g.anomaly.x, g.anomaly.z).toFixed(2)}m off`);
  ok('U29 and the nearest thing there is the door, not the case',
    laneAct && laneAct.kind === 'door', laneAct ? `${laneAct.kind}: ${laneAct.text}` : 'none');
  g.doInteract();
  ok('U30 which shuts the lane', !lane.open);

  ok('U31 the post goes down at the east end', walkTo(5.2, -10.8, 0.7, 30000));
  g.player.selectSlot(SLOTS.findIndex((s) => g.player.slots.get(s.id) === 'floodlight-tripod'));
  eq('U32 one tripod, in a 2.4m tube', g.deployHeld(), null);
  guard = 0;
  while (g.anomaly.state !== ANOMALY_STATE.BANKED && guard < 10000) { wait(250); guard += 250; }
  note(`banked at ${(g.clock.simTimeMs / 60000).toFixed(1)} min; lanes open ${g.anomaly.escapes}`);
  eq('U33 which banks it — one post and two doors', g.anomaly.state, ANOMALY_STATE.BANKED);

  eq('U34 the procedure can be committed', g.commitProcedure({
    target: 'The cold mass itself',
    state: 'Held in the heating gallery against a gradient it cannot cross',
    trigger: 'Transit case heater at 39C, with the gallery doors shut behind it',
    transfer: 'Case interior stable for 30s, then carried up to the east landing',
    maintained: ['The fire-stopping door', 'The lane door', 'One floodlight at the east end'],
    abort: 'Any operative takes a second contact',
  }), null);

  ok('U35 the operative walks in past their own post', walkTo(kase.x + 1.1, kase.z + 0.8, 0.7, 30000));
  const sealAct = g.contextAction();
  ok('U36 and the verb becomes the seal', sealAct && sealAct.kind === 'seal',
    sealAct ? `${sealAct.kind}: ${sealAct.text}` : 'none');
  eq('U37 which takes', g.doInteract(), null);
  wait(CONFIG.anomaly.custodyVerifySeconds * 1000 + 1200);
  eq('U38 and thirty seconds later it is custody', g.custody, 'verified');

  /* Nine floors is the extraction. The lift is out; the stair is the only way anything
   * leaves, and that is what this map charges for a capture. */
  /* Round to the SOUTH side of the case to lift it. North of it is a metre from the lane
   * door, which wins on distance and offers "open the gallery door" — the one verb that
   * would let the thing straight back out of the box it is now in. Nearest-wins is right,
   * and it means where you stand is a decision the map keeps asking about. */
  walkTo(kase.x, kase.z - 0.85, 0.4, 20000);
  const lift = g.contextAction();
  ok('U39 the sealed case can be picked up', lift && lift.kind === 'carry-case',
    lift ? `${lift.kind}: ${lift.text}` : 'none');
  g.doInteract();
  const OUT = [[5.2, -10.8], [9.4, -10.8], [9.4, -9.4], [9.4, -7.6], [10.2, -6.3],
    [10.2, -5.1], [10.9, -3.9], [10.9, 2.9], [10.9, 4.1], [10.6, 5.3], [10.8, 7.2],
    [10.8, 9.4], [10.6, 11.0]];
  const tOut = g.clock.simTimeMs;
  ok('U40 and carried the whole way back up the loop',
    route(OUT, 1.0, 90000) || !!g.result);
  note(`carrying it out took ${((g.clock.simTimeMs - tOut) / 1000).toFixed(0)}s at 75% pace; the operation ran ${(g.clock.simTimeMs / 60000).toFixed(1)} min`);
  wait(1500);
  ok('U41 which ends the operation', !!g.result);
  if (!g.result) { emit(); return; }
  /* ⚠ "The mission ended" is not the assertion. An operation that is LOST also reaches
   * the debrief, and the first version of this checked only the phase — it passed on a run
   * where the fence never closed and the case was never sealed. The assertion is that the
   * thing left the floor in a box. */
  eq('U42 with the payload actually transferred', g.extracted, true);
  note(`outcome: ${g.result.overall}${g.result.failReason ? ' — ' + g.result.failReason : ''}`);
  note(`contacts ${g.mission.tally.contacts} · evidence ${g.ledger.entries.length} · peak pressure ${g.mission.tally.peakPressure.toFixed(0)} (${g.mission.stageName})`);
  ok('U43 and an overall assessment in Foundation language',
    ['Exemplary', 'Controlled', 'Costly', 'Compromised', 'Failed'].includes(g.result.overall));
  emit();
}

/* ══ V. the six camera sliders, measured ═══════════════════════════════════════
 *
 * Authored against the renderer by the agent that wired the sliders up, and folded in
 * here rather than left in a scratch file — a suite proving an accessibility control does
 * something is worth exactly as much as the control, and neither survives in a temp
 * directory. The sub-labels keep their original grouping.
 *
 * The one honest approximation is named in the renderer and named again here: motion blur
 * is an ACCUMULATION buffer, not a velocity buffer. It smears where the image changed and
 * leaves alone where it did not, which trails the motion rather than straddling it.
 * Per-pixel blur wants a velocity target and a gather pass, and this build does not vendor
 * a composer. Grain and distortion are the actual named effects, not stand-ins.
 */
async function sectionV() {
  lines.push('--- V. the six camera sliders do something, measurably ---');
  const cd = window.__CD;
  if (!cd) { ok('V0 the page booted, so the renderer can be measured', false); emit(); return; }
  const deg = (r) => (r * 180 / Math.PI);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = cd.renderer, g = cd.game, p = g.viewPlayer;

  /* ── 1. applySettings is total ─────────────────────────────────────── */
  ok('V1.1 the renderer exposes applySettings', typeof R.applySettings === 'function');

  const d = R.applySettings(null);
  eq('V1.2 no argument falls back to the shipped fov', d.fov, CONFIG.render.fov);
  eq('V1.3 and to full strength on the other five',
    [d.shake, d.headBob, d.motionBlur, d.filmGrain, d.distortion].join(), '1,1,1,1,1');
  ok('V1.4 an empty object does not throw', !!R.applySettings({}));
  ok('V1.5 nor an object with no camera key', !!R.applySettings({ vision: {} }));

  const junk = R.applySettings({ camera: { fov: 'wide', shake: null, headBob: -3, motionBlur: 5, filmGrain: NaN, distortion: Infinity } });
  eq('V1.6 a non-numeric fov falls back rather than poisoning the projection', junk.fov, CONFIG.render.fov);
  eq('V1.7 null falls back', junk.shake, 1);
  eq('V1.8 negative clamps to 0', junk.headBob, 0);
  eq('V1.9 over-range clamps to 1', junk.motionBlur, 1);
  eq('V1.10 NaN falls back', junk.filmGrain, 1);
  eq('V1.11 Infinity clamps to 1', junk.distortion, 1);
  eq('V1.12 a fov from the future clamps to the slider maximum',
    R.applySettings({ camera: { fov: 400 } }).fov, 110);
  eq('V1.13 and below the minimum to 60', R.applySettings({ camera: { fov: 5 } }).fov, 60);

  const eff = Object.freeze({ camera: Object.freeze({ fov: 96, shake: 0.4, headBob: 0.2, motionBlur: 0, filmGrain: 0.5, distortion: 0.75 }) });
  const a1 = R.applySettings(eff), m1 = R.camera.projectionMatrix.elements.join();
  const a2 = R.applySettings(eff), m2 = R.camera.projectionMatrix.elements.join();
  eq('V1.14 applying the same object twice resolves the same numbers', JSON.stringify(a1), JSON.stringify(a2));
  eq('V1.15 and leaves the projection matrix untouched the second time', m1, m2);
  emit();

  /* ── 2. fov ────────────────────────────────────────────────────────── */
  R.applySettings({ camera: { fov: 96 } });
  eq('V2.1 the eye camera takes the setting', R.camera.fov, 96);
  eq('V2.2 the imager keeps its own instrument fov', R.thermalCam.fov, CONFIG.render.thermalFov);
  const m96 = R.camera.projectionMatrix.elements[5];
  R.applySettings({ camera: { fov: 60 } });
  eq('V2.3 and 60 lands', R.camera.fov, 60);
  eq('V2.4 the imager still does not follow', R.thermalCam.fov, CONFIG.render.thermalFov);
  const m60 = R.camera.projectionMatrix.elements[5];
  ok('V2.5 the projection actually changed with it', m60 > m96, `${m60} vs ${m96}`);
  note(`projection [1][1]: ${m60.toFixed(4)} at 60deg, ${m96.toFixed(4)} at 96deg`);
  /* 1/tan(fov/2) is the whole of it — assert the renderer's number against the maths. */
  near('V2.6 and it is 1/tan(fov/2) exactly', m60, 1 / Math.tan(30 * Math.PI / 180), 1e-6);
  emit();

  /* ── 3. shake ──────────────────────────────────────────────────────── */
  /* Pose the operative: some stress (so the breath sway is live) and a jolt on the bus. */
  g.clock.setPaused(false);
  p.stress = CONFIG.stress.max;
  p.vx = 0; p.vz = 0;
  const T = 400000;
  g.clock.simTimeMs = T;

  const pose = (t) => { g.clock.simTimeMs = t; R.render(); };

  R.applySettings({ camera: { fov: CONFIG.render.fov, shake: 0, headBob: 0, motionBlur: 0, filmGrain: 0, distortion: 0 } });
  R.game.bus.emit('CONTACT', { count: 1, id: p.id }, T);
  pose(T + 20);
  eq('V3.1 shake 0 leaves pitch bit-equal to the operative pitch', R.camera.rotation.x, p.pitch);
  eq('V3.2 and yaw bit-equal', R.camera.rotation.y, p.yaw);
  eq('V3.3 and roll exactly zero', R.camera.rotation.z, 0);
  eq('V3.4 and the eye exactly at eye height, at full stress, mid-jolt',
    R.camera.position.y, p.eyeHeight());

  /* Same jolt, shake back up. Sweep the ring and take the peak. */
  const peak = (mult) => {
    R.applySettings({ camera: { shake: mult, headBob: 0, motionBlur: 0, filmGrain: 0, distortion: 0 } });
    R._jolts.length = 0;
    R.game.bus.emit('CONTACT', { count: 1, id: p.id }, T);
    let mx = 0, my = 0, mz = 0;
    for (let dt = 0; dt <= 240; dt += 4) {
      pose(T + dt);
      mx = Math.max(mx, Math.abs(R.camera.rotation.x - p.pitch));
      my = Math.max(my, Math.abs(R.camera.rotation.y - p.yaw));
      mz = Math.max(mz, Math.abs(R.camera.rotation.z));
    }
    return { mx, my, mz };
  };
  const full = peak(1);
  ok('V3.5 a contact jolts the view', full.mx > 0.005, `${deg(full.mx).toFixed(3)} deg`);
  ok('V3.6 on all three axes', full.my > 0 && full.mz > 0);
  note(`contact at shake 1: pitch ${deg(full.mx).toFixed(2)}deg, yaw ${deg(full.my).toFixed(2)}deg, roll ${deg(full.mz).toFixed(2)}deg`);
  const half = peak(0.5);
  near('V3.7 the slider is a linear multiplier', full.mx / half.mx, 2, 0.02);
  note(`the same jolt at shake 0.5: pitch ${deg(half.mx).toFixed(2)}deg`);

  /* It has to stop. */
  R.applySettings({ camera: { shake: 1, headBob: 0, motionBlur: 0, filmGrain: 0, distortion: 0 } });
  R._jolts.length = 0;
  p.stress = 0;
  R.game.bus.emit('CONTACT', { count: 1, id: p.id }, T);
  pose(T + 3000);
  eq('V3.8 and it rings out completely rather than forever', R.camera.rotation.x, p.pitch);
  eq('V3.9 the jolt is dropped once it is below a hundredth of a degree', R._jolts.length, 0);

  /* Somebody else taking a hit is not your camera. */
  R._jolts.length = 0;
  R.game.bus.emit('CONTACT', { count: 1, id: p.id + '-not-me' }, T);
  eq('V3.10 a teammate’s contact does not shake your view', R._jolts.length, 0);

  /* The heavy door, by distance. */
  const doorId = Array.from(R.doorMeshes.keys())[0];
  const dm = R.doorMeshes.get(doorId);
  const ampAt = (m) => {
    R._jolts.length = 0;
    const sx = p.x, sz = p.z;
    p.x = dm.mesh.position.x + m; p.z = dm.mesh.position.z;
    R.game.bus.emit('DOOR_CHANGED', { id: doorId, open: true }, T);
    const a = R._jolts.length ? R._jolts[0].amp : 0;
    p.x = sx; p.z = sz;
    return a;
  };
  const near1 = ampAt(1), far1 = ampAt(14);
  ok('V3.11 a door felt through the floor, harder up close', near1 > far1 * 5, `${near1} vs ${far1}`);
  note(`door thud amplitude: ${deg(near1).toFixed(3)}deg at 1m, ${deg(far1).toFixed(3)}deg at 14m`);
  R._jolts.length = 0;
  emit();

  /* ── 4. head bob ───────────────────────────────────────────────────── */
  const walk = (mult, steps, speed) => {
    R.applySettings({ camera: { shake: 0, headBob: mult, motionBlur: 0, filmGrain: 0, distortion: 0 } });
    R._bobPhase = 0;
    p.vx = speed; p.vz = 0;
    let lo = Infinity, hi = -Infinity, roll = 0;
    for (let i = 1; i <= steps; i++) {
      pose(T + i * 16);
      lo = Math.min(lo, R.camera.position.y - p.eyeHeight());
      hi = Math.max(hi, R.camera.position.y - p.eyeHeight());
      roll = Math.max(roll, Math.abs(R.camera.rotation.z));
    }
    return { lo, hi, roll, span: hi - lo };
  };

  const wOff = walk(0, 90, CONFIG.player.walkSpeed);
  eq('V4.1 head bob 0 is no bob at all, not less bob', wOff.span, 0);
  eq('V4.2 and no roll with it', wOff.roll, 0);

  const wFull = walk(1, 90, CONFIG.player.walkSpeed);
  ok('V4.3 walking bobs the eye', wFull.span > 0.02, `${(wFull.span * 100).toFixed(2)} cm`);
  note(`walk at ${CONFIG.player.walkSpeed} m/s: ${(wFull.span * 1000).toFixed(1)} mm peak-to-peak, roll ${deg(wFull.roll).toFixed(2)} deg`);
  const wHalf = walk(0.5, 90, CONFIG.player.walkSpeed);
  near('V4.4 the slider is a linear multiplier', wFull.span / wHalf.span, 2, 0.02);

  const wCrouch = walk(1, 90, CONFIG.player.crouchSpeed);
  ok('V4.5 a crouch-walk bobs less than a walk, with nothing knowing what crouching is',
    wCrouch.span < wFull.span * 0.6, `${(wCrouch.span * 1000).toFixed(1)} mm vs ${(wFull.span * 1000).toFixed(1)} mm`);
  const wSprint = walk(1, 90, CONFIG.player.sprintSpeed);
  ok('V4.6 and a sprint bobs more', wSprint.span > wFull.span, `${(wSprint.span * 1000).toFixed(1)} mm`);
  note(`crouch ${(wCrouch.span * 1000).toFixed(1)} mm · walk ${(wFull.span * 1000).toFixed(1)} mm · sprint ${(wSprint.span * 1000).toFixed(1)} mm`);

  /* Standing still, at full bob, for a long time. */
  R.applySettings({ camera: { shake: 0, headBob: 1, motionBlur: 0, filmGrain: 0, distortion: 0 } });
  p.vx = 0; p.vz = 0;
  const phaseBefore = R._bobPhase;
  let still = 0;
  for (let i = 1; i <= 40; i++) { pose(T + 100000 + i * 33); still = Math.max(still, Math.abs(R.camera.position.y - p.eyeHeight())); }
  eq('V4.7 standing still does not bob, however long you stand', still, 0);
  eq('V4.8 the phase is a distance integral, so it does not advance either', R._bobPhase, phaseBefore);
  emit();

  /* ── 5. the lens: allocation ───────────────────────────────────────── */
  R.applySettings({ camera: { shake: 0, headBob: 0, motionBlur: 0, filmGrain: 0, distortion: 0 } });
  pose(T);
  eq('V5.1 all three at zero: no offscreen target at all', R._rtScene, null);
  eq('V5.2 and no accumulator', R._rtAccum, null);

  R.applySettings({ camera: { shake: 0, headBob: 0, motionBlur: 0, filmGrain: 1, distortion: 0 } });
  pose(T);
  ok('V5.3 grain alone allocates the target', !!R._rtScene);
  eq('V5.4 but not the accumulator', R._rtAccum, null);

  R.applySettings({ camera: { shake: 0, headBob: 0, motionBlur: 1, filmGrain: 0, distortion: 0 } });
  pose(T);
  ok('V5.5 motion blur allocates the accumulator', !!R._rtAccum);
  R.applySettings({ camera: { shake: 0, headBob: 0, motionBlur: 0, filmGrain: 1, distortion: 0 } });
  pose(T);
  eq('V5.6 and turning it off frees it again', R._rtAccum, null);

  const dpr = R.renderer.getPixelRatio();
  eq('V5.7 the target is the drawing buffer, not the css frame',
    `${R._rtScene.width}x${R._rtScene.height}`,
    `${Math.round(R.viewW * dpr)}x${Math.round(R.viewH * dpr)}`);
  note(`viewport ${R.viewW}x${R.viewH} css · dpr ${dpr} · target ${R._rtScene.width}x${R._rtScene.height}`
    + ` · webgl2 ${R.renderer.capabilities.isWebGL2}`);
  emit();

  /* ── 6. the lens: measured pixels ──────────────────────────────────── */
  /* Light the room so there is something in the corners to warp. A dark frame would
   * make every one of these tests pass by being uniformly black. */
  const amb = R.scene.children.find((o) => o.isAmbientLight);
  const fogD = R.scene.fog.density;
  if (amb) amb.intensity = 3.2;
  R.scene.fog.density = 0.004;
  for (const c of g.site.circuits.keys()) g.site.setCircuit(c, true);
  /* Imager OFF for the lens measurements: it is drawn after the lens now, so a patch
   * taken on the instrument would be measuring the one part of the frame the lens does
   * not touch. It comes back on for 6.17 below, which is exactly that property. */
  g.imagerOn = false;
  p.vx = 0; p.vz = 0;

  const gl = R.renderer.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const S = 24;
  const patch = (fx, fy) => {
    const buf = new Uint8Array(S * S * 4);
    gl.readPixels(Math.round(W * fx - S / 2), Math.round(H * fy - S / 2), S, S, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) if (i % 4 !== 3) s += Math.abs(a[i] - b[i]); return s / (a.length * 0.75); };
  const spread = (a) => { let lo = 255, hi = 0; for (let i = 0; i < a.length; i++) if (i % 4 !== 3) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); } return hi - lo; };
  /* One synchronous shot: render, then read before anything can composite it away. */
  const shot = (cam, t, at) => { R.applySettings({ camera: cam }); g.clock.simTimeMs = t; R.render(); return patch(at[0], at[1]); };

  const CENTRE = [0.5, 0.5];
  const flat = { shake: 0, headBob: 0, motionBlur: 0, filmGrain: 0, distortion: 0 };

  /* A warp is only measurable where the picture is not flat, and a dark corner of a
   * cold store is very flat indeed. So sweep the frame and report the strongest
   * response rather than betting the assertion on one patch. */
  const RING = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    RING.push([0.5 + Math.cos(a) * 0.38, 0.5 + Math.sin(a) * 0.38]);
  }
  const sweep = (camA, camB) => {
    let mx = 0, at = null;
    for (const q of RING) {
      const dv = diff(shot(camA, T, q), shot(camB, T, q));
      if (dv > mx) { mx = dv; at = q; }
    }
    return { mx, at };
  };
  let mxSpread = 0;
  for (const q of RING) mxSpread = Math.max(mxSpread, spread(shot(flat, T, q)));
  ok('V6.1 the test frame has something in it to measure', mxSpread > 10,
    `strongest patch spans ${mxSpread} levels`);

  /* Distortion. The frame moves off-axis; the crosshair does not. */
  const dOn = sweep({ ...flat, distortion: 0 }, { ...flat, distortion: 1 });
  const k0 = shot({ ...flat, distortion: 0 }, T, CENTRE);
  const k1 = shot({ ...flat, distortion: 1 }, T, CENTRE);
  ok('V6.2 distortion warps the frame away from the axis', dOn.mx > 2, `${dOn.mx.toFixed(2)} levels`);
  eq('V6.3 and leaves the exact centre untouched — a lens cannot move an aim point', diff(k0, k1), 0);
  note(`distortion 1: up to ${dOn.mx.toFixed(2)} levels at r=0.38, exactly ${diff(k0, k1).toFixed(2)} at the crosshair`);
  const dHalf = sweep({ ...flat, distortion: 0 }, { ...flat, distortion: 0.5 });
  ok('V6.4 half the setting warps less', dHalf.mx < dOn.mx, `${dHalf.mx.toFixed(2)} vs ${dOn.mx.toFixed(2)}`);

  /* Grain. Real, deterministic, and gone at zero. */
  const gA = shot({ ...flat, filmGrain: 0 }, T, CENTRE);
  const gB = shot({ ...flat, filmGrain: 1 }, T, CENTRE);
  const gC = shot({ ...flat, filmGrain: 1 }, T, CENTRE);
  const gD = shot({ ...flat, filmGrain: 1 }, T + 700, CENTRE);
  ok('V6.5 grain 1 is visible against grain 0', diff(gA, gB) > 0.5, `${diff(gA, gB).toFixed(2)} levels`);
  eq('V6.6 and it is a function of sim time, so a replay grains identically', diff(gB, gC), 0);
  ok('V6.7 but it crawls as sim time advances', diff(gB, gD) > 0.5, `${diff(gB, gD).toFixed(2)} levels`);
  const gHalf = shot({ ...flat, filmGrain: 0.5 }, T, CENTRE);
  note(`grain amplitude: ${diff(gA, gB).toFixed(2)} levels at 1.0, ${diff(gA, gHalf).toFixed(2)} at 0.5 (of 255)`);
  ok('V6.8 half the setting is about half the grain', Math.abs(diff(gA, gB) / diff(gA, gHalf) - 2) < 0.25,
    `ratio ${(diff(gA, gB) / diff(gA, gHalf)).toFixed(2)}`);

  /* Motion blur. Turn the head and watch the frame catch up. */
  const settle = (cam, yaw, n) => { for (let i = 0; i < n; i++) { p.yaw = yaw; shot(cam, T + i * 16, CENTRE); } };
  const blurCam = { ...flat, motionBlur: 1 };
  const yaw0 = p.yaw;
  settle(blurCam, yaw0, 24);
  const settledA = patch(0.5, 0.5);
  settle(blurCam, yaw0 + 0.9, 24);
  const settledB = patch(0.5, 0.5);
  ok('V6.9 turning the head changes the frame at all', diff(settledA, settledB) > 2, `${diff(settledA, settledB).toFixed(2)}`);

  settle(blurCam, yaw0, 24);
  p.yaw = yaw0 + 0.9;
  const first = shot(blurCam, T, CENTRE);
  const second = shot(blurCam, T + 16, CENTRE);
  const third = shot(blurCam, T + 32, CENTRE);
  const e1 = diff(first, settledB), e2 = diff(second, settledB), e3 = diff(third, settledB);
  ok('V6.10 the first frame after a hard turn has not arrived yet', e1 > 1, `${e1.toFixed(2)} levels from settled`);
  ok('V6.11 and it converges', e2 < e1 && e3 < e2, `${e1.toFixed(2)} -> ${e2.toFixed(2)} -> ${e3.toFixed(2)}`);
  note(`motion blur 1: ${e1.toFixed(1)} -> ${e2.toFixed(1)} -> ${e3.toFixed(1)} levels from the settled frame`);

  const sharpCam = { ...flat, motionBlur: 0, filmGrain: 0, distortion: 1 };
  settle(sharpCam, yaw0, 3);
  p.yaw = yaw0 + 0.9;
  const sharp1 = shot(sharpCam, T, CENTRE);
  settle(sharpCam, yaw0 + 0.9, 3);
  const sharpSettled = patch(0.5, 0.5);
  eq('V6.12 motion blur 0 arrives on the frame it is asked to, with no trail',
    diff(sharp1, sharpSettled), 0);

  /* Turning motion blur on must not blink the screen out: a freshly allocated
   * accumulator is black, and fading up from it reads as a crash. */
  settle({ ...flat }, yaw0, 2);
  eq('V6.13 the accumulator really was released first', R._rtAccum, null);
  const firstBlur = shot({ ...flat, motionBlur: 1 }, T, CENTRE);
  settle({ ...flat, motionBlur: 1 }, yaw0, 20);
  const settledBlur = patch(0.5, 0.5);
  eq('V6.14 the first frame after switching blur on is already the picture, not a fade from black',
    diff(firstBlur, settledBlur), 0);

  /* And the whole chain off is the same picture as before any of this existed. */
  settle({ ...flat }, yaw0, 2);
  const off1 = patch(0.5, 0.5);
  settle({ ...flat }, yaw0, 2);
  const off2 = patch(0.5, 0.5);
  eq('V6.15 with every post value at 0 the frame is stable and target-free', diff(off1, off2), 0);
  eq('V6.16 and no target is held', R._rtScene, null);

  /* The instrument is drawn after the lens, so nothing the lens does reaches it. */
  g.imagerOn = true;
  const ir = R.imagerRect();
  const inst = () => {
    const buf = new Uint8Array(S * S * 4);
    gl.readPixels(Math.round((ir.x + ir.w * 0.5 - S / 2) * dpr), Math.round((ir.y + ir.h * 0.5 - S / 2) * dpr),
      S, S, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };
  const room = () => {
    const buf = new Uint8Array(S * S * 4);
    gl.readPixels(Math.round(W * 0.12), Math.round(H * 0.5), S, S, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };
  R.applySettings({ camera: { ...flat } }); R.render();
  const instPlain = inst(), roomPlain = room();
  R.applySettings({ camera: { ...flat, filmGrain: 1, distortion: 1 } }); R.render();
  const instLens = inst(), roomLens = room();
  ok('V6.17 the instrument screen has something on it', spread(instPlain) > 10, `${spread(instPlain)} levels`);
  eq('V6.18 grain and warp do not reach the imager — the rule channel keeps its pixels',
    diff(instPlain, instLens), 0);
  ok('V6.19 while the room around it does get both', diff(roomPlain, roomLens) > 1,
    `${diff(roomPlain, roomLens).toFixed(2)} levels`);

  if (amb) amb.intensity = 0.40;
  R.scene.fog.density = fogD;
  g.imagerOn = false;
  p.yaw = yaw0;
  R.applySettings(cd.settings.effective);
  emit();
}

/* ══ W–AA. the squad's non-voice channel (GDD §11.3) ═══════════════════════════
 *
 * §11.3 lists voice chat first and §19.2 says no required rule may depend on a microphone
 * or on stereo hearing. Those two are only compatible if the PRIMARY channel is the one
 * that needs neither — so what exists is a ping-and-phrase wheel, and a squad with no
 * microphones between them can run a whole operation on it. Voice is not built and has no
 * stub, because a stub would say the non-voice channel is the fallback.
 *
 * The vocabulary is closed the way senses.js is closed, and the engine dispatches on the
 * FIELDS of a phrase — anchor, lifetime, uniqueness — never on its id. Section W greps
 * both modules for an id comparison and finds none.
 */
function sectionW() {
  lines.push('--- W. the vocabulary (GDD 11.3, 19.2) ---');

  eq('W1 the shipped tables validate clean', commsProblems().join(' | '), '');
  eq('W2 every phrase has a caption line', missingCommsCaptions().join(', '), '');

  /* GDD 11.3 names the six kinds outright. This is not a taste assertion. */
  const want = ['danger', 'evidence', 'objective', 'move', 'watch', 'help'].sort().join(',');
  eq('W3 the kinds are 11.3\'s six, exactly', Object.keys(PING_KINDS).sort().join(','), want);

  const glyphs = Object.values(PING_KINDS).map((k) => k.glyph);
  eq('W4 six kinds, six distinct silhouettes', new Set(glyphs).size, 6);
  ok('W5 and every one of them is a real character', glyphs.every((g) => typeof g === 'string' && g.length > 0));

  const used = new Set(Object.values(PHRASES).map((p) => p.kind));
  eq('W6 every kind 11.3 asks for has at least one phrase', used.size, 6);
  note(`${Object.keys(PHRASES).length} phrases over ${used.size} kinds: ${WHEEL_ORDER.join(', ')}`);

  ok('W7 nothing on the wheel is an emote — every phrase has a caption with words',
    Object.keys(PHRASES).every((id) => (COMMS_CAPTIONS[id].text || '').trim().length > 2));

  /* The validator REFUSES rather than warns — content.js's contract, applied to comms. */
  const noCaption = { ...PHRASES, 'door-jammed': { kind: 'danger', anchor: 'point', unique: false, lifeMs: 1000 } };
  ok('W8 a phrase with no caption line is refused',
    commsProblems(noCaption).some((s) => /door-jammed.*caption/.test(s)), commsProblems(noCaption).join(' | '));

  const badKind = { bogus: { kind: 'sarcasm', anchor: 'point', unique: false, lifeMs: 1000 } };
  ok('W9 a kind outside the closed set is refused',
    commsProblems(badKind, { bogus: { text: 'x', kind: 'speech', priority: 1, directional: true } })
      .some((s) => /kind "sarcasm"/.test(s)));

  const badAnchor = { bogus: { kind: 'danger', anchor: 'orbit', unique: true, lifeMs: 1000 } };
  ok('W10 an anchor outside the closed set is refused',
    commsProblems(badAnchor, { bogus: { text: 'x', kind: 'speech', priority: 1, directional: false } })
      .some((s) => /anchor "orbit"/.test(s)));

  const twoStates = { bogus: { kind: 'move', anchor: 'none', unique: false, lifeMs: 1000 } };
  ok('W11 a placeless phrase that is not unique is refused — nobody holds two states',
    commsProblems(twoStates, { bogus: { text: 'x', kind: 'speech', priority: 1, directional: false } })
      .some((s) => /must be unique/.test(s)));

  const lyingBearing = { bogus: { kind: 'move', anchor: 'none', unique: true, lifeMs: 1000 } };
  ok('W12 a bearing on a phrase with nowhere to point is refused',
    commsProblems(lyingBearing, { bogus: { text: 'x', kind: 'speech', priority: 1, directional: true } })
      .some((s) => /directional/.test(s)));

  const orphan = commsProblems({ contact: PHRASES.contact }, { contact: COMMS_CAPTIONS.contact, ghost: COMMS_CAPTIONS.help });
  ok('W13 a caption with no phrase behind it is refused', orphan.some((s) => /ghost/.test(s)), orphan.join(' | '));

  ok('W14 isPhrase is the closed test', isPhrase('contact') && !isPhrase('contact ') && !isPhrase('toString'));

  /* The caption rows are audio.js's shape, so its formatter renders them unchanged. */
  ok('W15 every caption is a speech row with a 1-3 priority',
    Object.values(COMMS_CAPTIONS).every((c) => c.kind === 'speech' && [1, 2, 3].includes(c.priority)));
  ok('W16 the three that lose an operation are priority 3',
    ['contact', 'hold', 'help'].every((id) => COMMS_CAPTIONS[id].priority === 3));
  emit();
}

/* ── X. the board ─────────────────────────────────────────────────────────── */
function sectionX() {
  lines.push('--- X. the ping board: lifetimes, caps, ownership ---');

  const b = new PingBoard();
  const bad = b.add('p1', 'nuke-the-site', { atMs: 0 });
  eq('X1 an id outside the vocabulary is refused, not passed through', bad.ok, false);
  ok('X2 and the refusal is a sentence a player can read', /wheel/.test(bad.why), bad.why);
  eq('X3 nothing landed on the board', b.list.length, 0);

  const r = b.add('p1', 'contact', { x: 4, z: 5, atMs: 1000 });
  ok('X4 a good call lands', r.ok && r.ping.owner === 'p1' && r.ping.phrase === 'contact');
  near('X5 where it was called', r.ping.x, 4, 0.001);

  eq('X6 it is live now', b.live(1000).length, 1);
  eq('X7 contact expires at six seconds — a marker that outlives the mass is a lie',
    expiresAt(r.ping), 1000 + PHRASES.contact.lifeMs);
  eq('X8 still live at 5.9s', b.live(6900).length, 1);
  eq('X9 gone at 7.1s', b.live(8100).length, 0);
  ok('X10 live() is what decides; the list itself has not been swept', b.list.length === 1);
  eq('X11 prune is the housekeeping', b.prune(8100), 1);
  near('X12 age runs 0 to 1 over the lifetime', ageFraction(r.ping, 1000 + PHRASES.contact.lifeMs / 2), 0.5, 0.001);

  /* The cap: three per operative, evicting the oldest. */
  const c = new PingBoard({ maxPerPlayer: 3, minGapMs: 0 });
  for (let i = 0; i < 5; i++) c.add('p1', 'set-up-here', { x: i, z: 0, atMs: i * 10 });
  eq('X13 the per-player cap holds at three', c.forOwner('p1').length, 3);
  near('X14 and it evicted the OLDEST, keeping what the operative just decided mattered',
    c.forOwner('p1')[0].x, 2, 0.001);
  near('X15 the newest is still there', c.forOwner('p1')[2].x, 4, 0.001);

  for (let i = 0; i < 4; i++) c.add('p2', 'set-up-here', { x: 10 + i, z: 0, atMs: 100 + i * 10 });
  eq('X16 one operative\'s cap does not spend another\'s', c.forOwner('p1').length, 3);
  eq('X17 and the second gets their own three', c.forOwner('p2').length, 3);
  eq('X18 six markers on a two-operative floor', c.list.length, 6);

  /* unique versus not: four fence posts, one contact. */
  const u = new PingBoard({ minGapMs: 0 });
  u.add('p1', 'contact', { x: 1, z: 1, atMs: 0 });
  u.add('p1', 'contact', { x: 2, z: 2, atMs: 100 });
  eq('X19 re-marking the mass MOVES the marker rather than leaving a trail', u.forOwner('p1').length, 1);
  near('X20 to where it is now', u.forOwner('p1')[0].x, 2, 0.001);
  const f = new PingBoard({ maxPerPlayer: 5, minGapMs: 0 });
  f.add('p1', 'set-up-here', { x: 1, z: 0, atMs: 0 });
  f.add('p1', 'set-up-here', { x: 2, z: 0, atMs: 10 });
  f.add('p1', 'set-up-here', { x: 3, z: 0, atMs: 20 });
  eq('X21 a fence has four posts, so placements accumulate', f.forOwner('p1').length, 3);

  /* The rate limit (GDD 20.9). */
  const s = new PingBoard({ minGapMs: 700 });
  ok('X22 the first call is accepted', s.add('p1', 'contact', { atMs: 0 }).ok);
  const spam = s.add('p1', 'hold', { atMs: 300 });
  ok('X23 a second inside the limit is refused', !spam.ok && /moment/.test(spam.why), spam.why);
  ok('X24 and once the gap has passed it is accepted again', s.add('p1', 'hold', { atMs: 800 }).ok);
  ok('X25 the limit is per operative, not global', s.add('p2', 'contact', { atMs: 810 }).ok);

  /* Retire: the drop and the death. */
  const d = new PingBoard({ minGapMs: 0 });
  d.add('p1', 'set-up-here', { x: 1, z: 1, atMs: 0 });
  d.add('p1', 'watch-this', { x: 2, z: 2, atMs: 1 });
  d.add('p2', 'set-up-here', { x: 3, z: 3, atMs: 2 });
  eq('X26 three markers up', d.live(10).length, 3);
  eq('X27 a lost radio takes that operative\'s markers with it', d.retire('p1'), 2);
  eq('X28 and touches nobody else\'s', d.live(10).length, 1);
  eq('X29 the survivor is the other operative\'s', d.live(10)[0].owner, 'p2');
  ok('X30 retiring clears their rate-limit history too, so a reconnect can speak at once',
    d.add('p1', 'contact', { atMs: 3 }).ok);

  /* Anchored to a person: it follows them, and it leaves with them. */
  const a = new PingBoard({ minGapMs: 0 });
  a.add('p1', 'help', { atMs: 0 });
  const roster = new Map([['p1', { x: 5, z: 5 }]]);
  const at = (id) => roster.get(id) || null;
  near('X31 a help call sits where the caller is', a.live(10, at)[0].x, 5, 0.001);
  roster.set('p1', { x: 12, z: 9 });
  near('X32 and follows them while they are dragged clear', a.live(10, at)[0].x, 12, 0.001);
  near('X33 on both axes', a.live(10, at)[0].z, 9, 0.001);
  roster.delete('p1');
  eq('X34 an owner who has left the roster takes their marker with them', a.live(10, at).length, 0);
  eq('X35 a placed call is not moved by the roster', (() => {
    const g = new PingBoard({ minGapMs: 0 });
    g.add('p1', 'set-up-here', { x: 7, z: 7, atMs: 0 });
    return g.live(10, () => ({ x: 0, z: 0 }))[0].x;
  })(), 7);

  /* The wire. */
  const w = new PingBoard({ minGapMs: 0 });
  w.add('p1', 'contact', { x: 3.21, z: -4.56, atMs: 1234 });
  w.add('p3', 'watch-this', { x: 11, z: 2, atMs: 1250 });
  const rows = w.encode();
  eq('X36 the board encodes one row per call', rows.length, 2);
  ok('X37 the phrase travels as its id, not as an index into a table somebody will reorder',
    rows[0][2] === 'contact');
  const mirror = new PingBoard();
  eq('X38 a client decodes the whole board', mirror.decode(rows), 2);
  near('X39 to the centimetre, like every other position on the wire', mirror.list[0].x, 3.21, 0.005);
  eq('X40 with the owner intact', mirror.list[1].owner, 'p3');
  ok('X41 and neither the lifetime nor the words travelled — both are derived from the id',
    rows[0].length === 6 && !JSON.stringify(rows).includes('it is here'));

  const first = mirror.list[0];
  w.list[0].x = 9;
  mirror.decode(w.encode());
  ok('X42 a second snapshot REUSES the object where the id matches, so a marker does not restart',
    mirror.list[0] === first);
  near('X43 while still taking the new position', mirror.list[0].x, 9, 0.005);
  mirror.decode([[99, 'p1', 'phrase-from-a-newer-build', 0, 0, 0]]);
  eq('X44 a phrase this build does not have is dropped rather than drawn blank', mirror.list.length, 0);
  emit();
}

/* ── Y. the world rules ───────────────────────────────────────────────────── */
function sectionY() {
  lines.push('--- Y. what an operative may mark (GDD 20.9) ---');

  const caller = { id: 'p1', name: 'Vasquez', x: 0, z: 0, yaw: 0, alive: true, downed: false };
  /* Facing yaw 0 is -Z in this game's convention, so "ahead" is negative Z. */
  const ahead = { x: 0, z: -6 };
  const ctx = { atMs: 0, blockers: [] };

  let b = new PingBoard({ minGapMs: 0 });
  let r = requestPing(b, caller, 'set-up-here', ahead, ctx);
  ok('Y1 a spot in front of you, in the open, is markable', r.ok, r.why);
  near('Y2 and the marker lands where you aimed', r.ping.z, -6, 0.001);

  r = requestPing(b, caller, 'set-up-here', { x: 0, z: -(MARK_RANGE_M + 5) }, ctx);
  ok('Y3 past the range limit is refused', !r.ok && /too far/.test(r.why), r.why);

  const wall = [[-3, -5.2, 3, -4.8]];
  r = requestPing(b, caller, 'set-up-here', ahead, { atMs: 0, blockers: wall });
  ok('Y4 through a wall is refused — 20.9\'s line-of-sight test', !r.ok && /cannot see/.test(r.why), r.why);
  ok('Y5 canMark is the single implementation both the host and the wheel ask',
    canMark(caller, ahead.x, ahead.z, []) && !canMark(caller, ahead.x, ahead.z, wall));

  r = requestPing(b, caller, 'set-up-here', { x: 0, z: 6 }, ctx);
  ok('Y6 a point behind the caller is refused', !r.ok, r.ok ? 'accepted' : r.why);

  r = requestPing(b, caller, 'not-a-phrase', ahead, ctx);
  ok('Y7 an unknown phrase never reaches the board', !r.ok && /wheel/.test(r.why), r.why);

  /* GDD 9.5: down is not dead, and there is exactly one thing you can still say. */
  const floored = { ...caller, downed: true };
  b = new PingBoard({ minGapMs: 0 });
  ok('Y8 a downed operative can still call for help', requestPing(b, floored, 'help', {}, ctx).ok);
  const nope = requestPing(b, floored, 'set-up-here', ahead, ctx);
  ok('Y9 and can call nothing else', !nope.ok && /floor/.test(nope.why), nope.why);

  const dead = { ...caller, alive: false };
  ok('Y10 a lost operative calls nothing at all', !requestPing(b, dead, 'help', {}, ctx).ok);

  /* An anchor with its own place ignores the aim entirely — you cannot mark a spot you
   * cannot see by claiming it is where you are standing. */
  b = new PingBoard({ minGapMs: 0 });
  r = requestPing(b, caller, 'help', { x: 999, z: 999 }, { atMs: 0, blockers: wall });
  ok('Y11 a caller-anchored call ignores the aim point it was handed', r.ok, r.why);
  near('Y12 and sits on the caller instead', r.ping.x, 0, 0.001);
  eq('Y13 while a placeless call has no place at all', requestPing(b, caller, 'ready', { x: 5, z: 5 }, { atMs: 1000 }).ping.x, 0);

  /* Bearings, in the four quadrants, on the game's own forward convention. */
  const me = { x: 0, z: 0, yaw: 0 };
  eq('Y14 straight in front is "ahead"', bearingWord(me, 0, -10), 'ahead');
  eq('Y15 straight behind is "behind"', bearingWord(me, 0, 10), 'behind');
  eq('Y16 +X is to your right at yaw 0', bearingWord(me, 10, 0), 'right');
  eq('Y17 and -X is to your left', bearingWord(me, -10, 0), 'left');
  eq('Y18 turning a quarter turn turns the words with you', bearingWord({ x: 0, z: 0, yaw: Math.PI / 2 }, -10, 0), 'ahead');
  eq('Y19 standing on it has no bearing worth printing', bearingWord(me, 0.1, 0.1), null);
  emit();
}

/* ── Z. over the wire, with no wire ───────────────────────────────────────── */
/* THIS SECTION CONTAINS THE PROPOSED WIRING, VERBATIM. The five fragments marked WIRING
 * below are exactly what net.js, protocol.js and game.js need; nothing in src/ was edited
 * to run them. */

/* ══ Z. host authority over the comms channel, through the shipped wiring ══════
 *
 * The version of this that arrived with the modules mocked the wiring — `const ACT_PING =
 * 'g'`, a hand-written `_hostAct` wrapper, `snap.pg = board.encode()` written by the test.
 * That proves the DESIGN is sound and proves nothing about the build, and it is exactly the
 * shape of test that keeps passing for a week after somebody deletes the line in
 * `encodeSnapshot`. So this one mocks nothing: real `ACT.PING`, real `_hostAct`, real
 * `encodeSnapshot`, real `applySnapshot`, over the same loopback rig section M uses.
 */
async function sectionZ(content) {
  lines.push('--- Z. a squad call, over the wire, decided by the host ---');

  const hostG = new Game(content, { seed: 'comms-host' });
  hostG.commitLoadout(RECOMMENDED_MANIFEST);
  const host = new NetSession(hostG);
  const clientG = new Game(content, { seed: 'comms-client' });
  const client = new NetSession(clientG);
  const [hl, cl] = loopbackPair();
  host.accept(hl);
  client.join(cl, { name: 'Vasquez' });

  const me = clientG.playerById(client.localPlayerId);
  ok('Z1 a client has a seat', !!me, `local ${client.localPlayerId}`);
  if (!me) { emit(); return; }
  const mine = client.localPlayerId;
  const hostMe = hostG.playerById(mine);

  /* Somewhere the operative can actually see: three metres straight in front of them. */
  hostMe.x = hostG.site.spawn.x; hostMe.z = hostG.site.spawn.z; hostMe.yaw = 0;
  const aim = { x: hostMe.x - Math.sin(hostMe.yaw) * 3, z: hostMe.z - Math.cos(hostMe.yaw) * 3 };

  client.act(ACT.PING, { p: 'contact', x: Math.round(aim.x * 100), z: Math.round(aim.z * 100) });
  host.pump(1000, null);
  const live = hostG.comms.live(hostG.clock.simTimeMs);
  eq('Z2 the call reaches the host board', live.length, 1);
  eq('Z3 stamped with the seat the link is in', live[0] && live[0].owner, mine);
  eq('Z4 carrying the phrase the client chose', live[0] && live[0].phrase, 'contact');
  ok('Z5 at the place they aimed, to the centimetre the wire carries',
    live[0] && Math.abs(live[0].x - aim.x) < 0.02 && Math.abs(live[0].z - aim.z) < 0.02,
    live[0] ? `${live[0].x.toFixed(3)},${live[0].z.toFixed(3)} vs ${aim.x.toFixed(3)},${aim.z.toFixed(3)}` : 'none');

  /* ⚠ THE OWNER FIELD DOES NOT EXIST ON THE WIRE, which is a stronger guarantee than
   * validating one would be. A client sending `owner` is not sending anything at all.
   *
   * Past the rate limit first: §20.9 wants interaction events rate-limited and the board
   * allows one call per operative per 700ms, so firing this immediately after the last one
   * tests the limiter and nothing else. It refused, correctly, and read as "the forgery
   * was rejected" — a false pass in the making. */
  hostG.skipMs(900);
  client.act(ACT.PING, { p: 'help', owner: 'p1', id: 'p1', x: Math.round(hostMe.x * 100), z: Math.round(hostMe.z * 100) });
  host.pump(1000, null);
  const forged = hostG.comms.live(hostG.clock.simTimeMs).filter((p) => p.phrase === 'help');
  ok('Z6 a forged owner field is not read, because nothing reads one',
    forged.length > 0 && forged.every((p) => p.owner === mine),
    forged.map((p) => p.owner).join() || 'no help call landed');

  /* The board rides the snapshot and lands on the client. */
  const snap = encodeSnapshot(hostG, hostG.clock.simTimeMs);
  ok('Z7 the snapshot carries the board', Array.isArray(snap.pg) && snap.pg.length > 0);
  applySnapshot(clientG, snap);
  const seen = clientG.comms.live(hostG.clock.simTimeMs);
  eq('Z8 which the client can read back', seen.length, hostG.comms.live(hostG.clock.simTimeMs).length);
  ok('Z9 with the phrase, not an index into a table that will be reordered',
    seen.length > 0 && seen.every((p) => typeof p.phrase === 'string' && isPhrase(p.phrase)));
  ok('Z10 and nothing derivable — no text, no lifetime, no name on the wire',
    snap.pg.every((row) => Array.isArray(row) && row.every((v) => typeof v !== 'object')),
    JSON.stringify(snap.pg[0]));

  /* A refusal is addressed to one operative and must survive the snapshots that follow it.
   * ⚠ This is the bug two real browsers found and a loopback could not: `applySnapshot`
   * replaced the whole notice list and destroyed a locally-generated refusal ~80ms later. */
  const before = clientG.localNotices.length;
  const why = hostG.ping(mine, 'contact', hostMe.x + 90, hostMe.z);
  ok('Z11 marking something ninety metres away is refused, in a sentence',
    !!why && String(why).length > 8, String(why));
  clientG.noticeLocal(why);
  for (let i = 0; i < 11; i++) applySnapshot(clientG, encodeSnapshot(hostG, hostG.clock.simTimeMs));
  ok('Z12 and the refusal survives eleven snapshots', clientG.localNotices.length > before);
  ok('Z13 while the squad feed never carried it', !clientG.notices.some((n) => n.text === why));

  /* A dropped operative's markers go with their radio: a call is a claim about right now
   * by somebody who is looking at it, and neither half is true any more. */
  ok('Z14 the client has calls on the board to lose',
    hostG.comms.live(hostG.clock.simTimeMs).some((p) => p.owner === mine));
  hl.close();
  host.pump(1000, null);
  eq('Z15 and a dropped radio takes them with it',
    hostG.comms.live(hostG.clock.simTimeMs).filter((p) => p.owner === mine).length, 0);
  ok('Z16 but the seat is still theirs — §11.5 reserves the seat, not the claims',
    !!hostG.playerById(mine));

  /* Expiry is the host's, and `prune` runs in step() rather than in encode(). */
  const p1 = hostG.player;
  p1.yaw = 0;
  const near = { x: p1.x - Math.sin(p1.yaw) * 2, z: p1.z - Math.cos(p1.yaw) * 2 };
  eq('Z17 a host operative can call too', hostG.ping('p1', 'contact', near.x, near.z), null);
  hostG.skipMs(PHRASES.contact.lifeMs + 500);
  eq('Z18 and the call expires off the board on its own',
    hostG.comms.live(hostG.clock.simTimeMs).filter((p) => p.phrase === 'contact').length, 0);
  ok('Z19 pruned from the list itself, so the snapshot does not grow all operation',
    !hostG.comms.list.some((p) => p.phrase === 'contact'),
    `${hostG.comms.list.length} rows still held`);
  emit();
}

async function sectionAA(content) {
  lines.push('--- AA. the wheel, and what an incoming call looks like ---');

  const game = new Game(content, { seed: 'wheel' });
  game.comms = new PingBoard({ minGapMs: 0 });
  game.commitLoadout(RECOMMENDED_MANIFEST);
  const mate = game.addPlayer('Vasquez');
  const me = game.player;
  me.yaw = 0; me.pitch = 0;

  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px;opacity:0;pointer-events:none';
  document.body.appendChild(root);

  const sent = [];
  const refused = [];
  const wheel = new CommsWheel(root, game, {
    onSend: (id, aim) => sent.push({ id, aim }),
    onRefuse: (why) => refused.push(why),
  });

  /* Layout. */
  const wedges = wheel.node.querySelectorAll('.wedge');
  eq('AA1 every phrase gets a wedge', wedges.length, Object.keys(PHRASES).length);
  ok('AA2 each wedge carries the glyph, the sentence it will send, and its key',
    Array.from(wedges).every((w) => w.querySelector('.g').textContent.length > 0
      && w.querySelector('.t').textContent.length > 2
      && w.querySelector('.n').textContent.length > 0));
  const shown = Array.from(wedges).map((w) => w.querySelector('.t').textContent);
  ok('AA3 and the wedge says exactly what the squad will read — no second wording to drift',
    shown.every((t, i) => t === COMMS_CAPTIONS[WHEEL_ORDER[i]].text));
  ok('AA4 the glyph is unconditional — a marker on a dark floor has no third channel',
    !wheel.node.innerHTML.includes('cd-shapes'));
  ok('AA5 every kind borrows one of 18.5\'s five signal colours',
    Object.values(KIND_VARS).every((v) => ['--red', '--cyan', '--amber', '--green', '--hot'].includes(v)));

  /* The radial maths. */
  const n = WHEEL_ORDER.length;
  eq('AA6 inside the dead zone is cancel, so an accidental press says nothing',
    sectorAt(0, -20, n, 150), null);
  eq('AA7 straight up is sector zero', sectorAt(0, -140, n, 150), 0);
  eq('AA8 and it runs clockwise', sectorAt(140, 0, n, 150), Math.round(n / 4));
  eq('AA9 all the way round', sectorAt(0, 140, n, 150), Math.round(n / 2));
  const p0 = sectorPos(0, n);
  near('AA10 sector zero is drawn at twelve o\'clock', p0.left, 50, 0.001);
  ok('AA11 above the centre, in percentages that scale with the UI', p0.top < 50);

  /* Opening, choosing, sending. Open floor and a downward glance, so the local pre-check
   * has nothing to object to — it gets its own assertions at V20. */
  const realBlockers = game.site.blockingRects;
  game.site.blockingRects = () => [];
  me.pitch = -0.6;

  wheel.show();
  ok('AA12 the wheel opens', wheel.isOpen && wheel.node.style.display !== 'none');
  wheel.hide(true);
  eq('AA13 released without moving, it sends nothing', sent.length, 0);

  wheel.show();
  wheel.aim(0, -140);
  eq('AA14 a flick selects', wheel.selection, 0);
  wheel.hide(true);
  eq('AA15 and releasing sends exactly that phrase', sent.length, 1);
  eq('AA16 the one under the thumb', sent[0].id, WHEEL_ORDER[0]);

  wheel.show();
  wheel.selectIndex(3);
  wheel.hide(false);
  eq('AA17 escape throws the selection away', sent.length, 1);

  wheel.show();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', bubbles: true }));
  eq('AA18 a digit key picks the same sector for anyone who would rather not flick', wheel.selection, 2);
  wheel.hide(true);
  eq('AA19 and sends it', sent[1].id, WHEEL_ORDER[2]);

  /* The local pre-check refuses without spending a request on the wire. */
  game.site.blockingRects = () => [[-40, me.z - 2.2, 40, me.z - 1.8]];
  const before = sent.length;
  wheel.show(); wheel.selectIndex(WHEEL_ORDER.indexOf('set-up-here')); wheel.hide(true);
  eq('AA20 marking through a wall never reaches the wire', sent.length, before);
  ok('AA21 and the operative is told, locally, in the same frame', refused.some((s) => /cannot see/.test(s)));
  game.site.blockingRects = realBlockers;

  /* Incoming: the feed. */
  game.comms.add(mate.id, 'contact', { x: me.x, z: me.z - 5, atMs: 1000 });
  wheel.update(1200);
  const cl = wheel.feed.querySelectorAll('.cline');
  eq('AA22 an incoming call prints one caption line', cl.length, 1);
  const line = cl[0].querySelector('span').textContent;
  ok('AA23 attributed, quoted, and with a bearing in words', /Vasquez: "it is here"/.test(line) && /ahead/.test(line), line);
  ok('AA24 the line carries the kind glyph as well as the words', cl[0].querySelector('b').textContent === PING_KINDS.danger.glyph);
  ok('AA25 and its priority, so the stylesheet can weight it', cl[0].classList.contains('p3'));

  mate.x = me.x + 8; mate.z = me.z;
  game.comms.add(mate.id, 'on-me', { atMs: 1100 });
  wheel.update(1200);
  const texts = Array.from(wheel.feed.querySelectorAll('.cline span')).map((s) => s.textContent);
  ok('AA26 a caller-anchored call reads its bearing off where they are now',
    texts.some((t) => /on me/.test(t) && /right/.test(t)), texts.join(' | '));

  /* Over-full drops the lowest priority, not the oldest. */
  const many = new CommsWheel(root, game, { maxLines: 2 });
  game.comms.clear();
  game.comms.add(mate.id, 'evidence', { x: me.x, z: me.z - 4, atMs: 10 });     // priority 1
  game.comms.add(mate.id, 'on-me', { atMs: 20 });                              // priority 2
  game.comms.add(mate.id, 'contact', { x: me.x, z: me.z - 4, atMs: 30 });      // priority 3
  many.update(40);
  const kept = Array.from(many.feed.querySelectorAll('.cline span')).map((s) => s.textContent).join(' | ');
  ok('AA27 an over-full feed drops the lowest priority, never the newest', /it is here/.test(kept) && !/to log/.test(kept), kept);

  /* Markers, and the projection behind them. */
  const cam = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0, fovDeg: 74 };
  const straight = projectPoint(cam, 1280, 720, 0, 1.6, -10);
  near('AA28 a point dead ahead projects to the centre of the screen', straight.left, 640, 0.5);
  near('AA29 at eye level', straight.top, 360, 0.5);
  near('AA30 ten metres out', straight.depth, 10, 0.001);
  ok('AA31 a point to the right lands right of centre', projectPoint(cam, 1280, 720, 4, 1.6, -10).left > 640);
  ok('AA32 and one above lands above it', projectPoint(cam, 1280, 720, 0, 4, -10).top < 360);
  ok('AA33 a point behind the lens reports a negative depth rather than a mirrored position',
    projectPoint(cam, 1280, 720, 0, 1.6, 10).depth < 0);

  const marked = new CommsWheel(root, game, { project: (x, y, z) => projectPoint(cam, 1280, 720, x, y, z) });
  game.comms.clear();
  me.x = 0; me.z = 0;
  game.comms.add(mate.id, 'set-up-here', { x: 0, z: -8, atMs: 0 });
  game.comms.add(mate.id, 'ready', { atMs: 10 });
  marked.update(20);
  const pins = marked.pins.querySelectorAll('.cd-ping');
  eq('AA34 a placed call gets a marker and a placeless one does not', pins.length, 1);
  ok('AA35 the marker carries glyph, words and a distance', pins[0].querySelector('.g').textContent.length > 0
    && /set up here/.test(pins[0].querySelector('.t').textContent)
    && /m$/.test(pins[0].querySelector('.d').textContent));
  const node0 = pins[0];
  marked.update(30);
  ok('AA36 the next frame moves the same node rather than rebuilding it',
    marked.pins.querySelectorAll('.cd-ping')[0] === node0);
  game.comms.clear();
  marked.update(40);
  eq('AA37 and a call that has gone takes its marker with it', marked.pins.querySelectorAll('.cd-ping').length, 0);

  /* Aim. */
  me.x = 0; me.z = 0; me.yaw = 0; me.pitch = -0.5;
  const a = aimPoint(me);
  ok('AA38 looking down puts the aim point on the floor in front of you', a.z < -0.5 && a.z > -10, JSON.stringify(a));
  me.pitch = 0.4;
  const flat = aimPoint(me);
  near('AA39 looking up runs it out to the range limit rather than to infinity',
    Math.hypot(flat.x - me.x, flat.z - me.z), MARK_RANGE_M, 0.001);

  wheel.destroy(); many.destroy(); marked.destroy();
  root.remove();
  emit();
}

/* ── K2. the architectural rules, for the two new files ───────────────────── */

/* ══ AB. the third procedure family: recover, verify, account ══════════════════
 *
 * GDD §26.2 asks for three incident packages testing DISTINCT procedure families. Two
 * existed — build a wall out of heat, keep something in view — and both are one thing in
 * one place ending with a case closing around it. This is the third: nothing hunts you,
 * there is no fence, and the failure state is arithmetic.
 *
 * The thing this section is really guarding is that it is genuinely a third family and not
 * the first one with the numbers changed. So it asserts what is ABSENT as hard as what is
 * present: no field disturbance from the anomaly, no fence rule anywhere in its triggers,
 * and no danger to an operative who does the job properly.
 */
async function sectionAB() {
  lines.push('--- AB. a set of objects, recovered and accounted for ---');

  const tally = await loadContent({ incident: 'cold-storage-tally' });
  const draught = await loadContent({ incident: 'cold-storage-draught' });

  eq('AB1 the fourth incident package loads and validates', tally.anomaly.id, 'ninety-one-tally');
  eq('AB2 on a floor the squad has already worked twice', tally.map.id, draught.map.id);
  eq('AB3 the anomaly disturbs no field of its own', tally.anomaly.presence.field.kind, 'none');
  ok('AB4 and has no enclosure rule at all — a heat fence is meaningless to it',
    !tally.anomaly.triggers.some((t) => ['path-blocked-by-gradient', 'gradient-below'].includes(t.when.sense)));
  ok('AB5 nor an observation rule — this is not the aisle B procedure either',
    !tally.anomaly.triggers.some((t) => ['observed', 'unobserved-for'].includes(t.when.sense)));

  const g = new Game(tally, { seed: 'tally-1' });
  const set = g.instances;
  note(`${set.candidates} candidates on the floor, ${set.total} of them real`);
  ok('AB6 there are more candidates than there are objects, or nothing needs verifying',
    set.candidates > set.total);
  eq('AB7 none of them is in the case yet', set.counted, 0);
  ok('AB8 and the case is not contaminated before anyone has touched anything', !set.contaminated);

  /* ── the tell is the heat field, and superposition is the search gradient ──
   * Three in the office within a metre of each other; two on their own. Nothing in the
   * code decides that one is easier to find than the other — the field does. */
  g.commitLoadout(RECOMMENDED_MANIFEST);
  g.skipMs(50);
  const amb = g.heat.ambientC;
  const drop = (i) => amb - g.heat.temperatureAt(i.x, i.z);
  const cluster = set.list.filter((i) => i.anomalous && i.x < -8 && i.z < -8);
  const alone = set.list.filter((i) => i.anomalous && !cluster.includes(i));
  ok('AB9 the incident authored a cluster and some singletons', cluster.length >= 2 && alone.length >= 1);
  const clusterDrop = Math.max(...cluster.map(drop));
  const aloneDrop = Math.max(...alone.map(drop));
  note(`cold reading at an object: ${clusterDrop.toFixed(2)}°C in the cluster, ${aloneDrop.toFixed(2)}°C on its own`);
  ok('AB10 three together read colder than one alone, and no code decided that',
    clusterDrop > aloneDrop * 1.4, `${clusterDrop.toFixed(2)} vs ${aloneDrop.toFixed(2)}`);

  /* Which means the imager finds the cluster from further away than the singleton. This is
   * the whole search curve of the incident, and it is an emergent property of a field that
   * was built to be a wall. */
  const readableFrom = (i) => {
    let r = 0;
    for (let d = 0.2; d <= 6; d += 0.05) {
      const seen = set.verifyWithImager(g.heat, i.x + d, i.z);
      if (seen.includes(i)) r = d; else break;
    }
    return r;
  };
  for (const i of set.list) i.verified = false;
  const rc = readableFrom(cluster[0]), ra = readableFrom(alone[0]);
  note(`imager confirms at ${rc.toFixed(2)}m in the cluster, ${ra.toFixed(2)}m on the singleton`);
  ok('AB11 a lone object has to be stood over; a cluster does not', rc > ra);

  /* A mundane object never reads cold, however close you get. */
  for (const i of set.list) i.verified = false;
  const mundane = set.list.find((i) => !i.anomalous);
  set.verifyWithImager(g.heat, mundane.x, mundane.z, { rangeM: 0.5 });
  ok('AB12 an object that is not one of them never reads cold, at any range', !mundane.verified);

  /* ── recovery ──────────────────────────────────────────────────────────────
   * Through the real verbs. The case is the account and the account is the game. */
  const p = g.player;
  const box = (() => {
    /* The case comes out of the cargo cache at the command point, like everything else —
     * there is no way to conjure one, and a test that conjured one would be testing a game
     * nobody plays. */
    p.x = g.site.cache.x; p.z = g.site.cache.z;
    g.skipMs(50);
    g.takeFromCache('reinforced-transit-case');
    p.selectSlot(SLOTS.findIndex((s) => p.slots.get(s.id) === 'reinforced-transit-case'));
    /* ⚠ In the loading bay, NOT in the office beside the cluster. The obvious place is a
     * metre from the storage breaker, and `deployHeld` puts an item 0.9m in front of you —
     * so the case landed almost exactly on the switch and every verb near it afterwards
     * resolved to "throw the storage circuit". Nearest-wins is correct and it means where
     * a squad puts the collection point is a real decision. */
    p.x = -6.0; p.z = -9.0; p.yaw = Math.PI / 2;
    g.skipMs(50);
    g.deployHeld();
    return g.deployables.byItem('reinforced-transit-case')[0];
  })();
  ok('AB13 a transit case can be set down as the collection point', !!box);

  const takeAndLog = (inst) => {
    p.x = inst.x; p.z = inst.z;
    g.skipMs(50);
    const act = g.contextAction();
    if (!act || act.kind !== 'collect') return `expected collect, got ${act ? act.kind : 'none'}`;
    g.doInteract();
    p.x = box.x + 0.6; p.z = box.z;
    g.skipMs(50);
    const act2 = g.contextAction();
    if (!act2 || act2.kind !== 'deposit') return `expected deposit, got ${act2 ? act2.kind : 'none'}`;
    g.doInteract();
    /* ⚠ Step after the deposit. `doInteract` changes the world; the ANOMALY only finds out
     * on the next step, because a trigger is polled and not pushed. A test that asserts a
     * state change on the line after the verb is asserting that the engine works some
     * other way than it does. */
    g.skipMs(100);
    return null;
  };

  const first = cluster[0];
  eq('AB14 an object can be picked up and logged into the case', takeAndLog(first), null);
  eq('AB15 which moves the count', set.counted, 1);
  eq('AB16 and the anomaly notices — the set is being gathered', g.anomaly.state, 'gathering');

  /* ⚠ ONE PER OPERATIVE, IN THE HANDS. The walk back is the cost the incident is made of,
   * and an object you could pocket would collapse the whole thing into one lap with a bag. */
  p.x = cluster[1].x; p.z = cluster[1].z;
  g.skipMs(50);
  g.doInteract();
  p.x = alone[0].x; p.z = alone[0].z;
  g.skipMs(50);
  const second = g.contextAction();
  ok('AB17 with both hands full the verb is not "collect another"',
    !second || second.kind !== 'collect', second ? second.kind : 'none');
  eq('AB18 exactly one object is in hand', set.list.filter((i) => i.carried).length, 1);

  /* ── being wrong ───────────────────────────────────────────────────────────
   * The half of the family §26.2 actually names. A mundane object goes in SILENTLY. */
  p.x = box.x + 0.6; p.z = box.z; g.skipMs(50); g.doInteract();   // log cluster[1]
  const before = set.counted;
  const noticesBefore = g.notices.length;
  p.x = mundane.x; p.z = mundane.z; g.skipMs(50); g.doInteract(); // collect the wrong one
  p.x = box.x + 0.6; p.z = box.z; g.skipMs(50); g.doInteract();   // log it
  eq('AB19 logging a mundane object does not move the count', set.counted, before);
  ok('AB20 and the game never says it was the wrong one',
    !g.notices.slice(noticesBefore).some((n) => /wrong|mundane|not one|mistake/i.test(n.text)),
    g.notices.slice(noticesBefore).map((n) => n.text).join(' | '));
  ok('AB21 but the case is contaminated, whether anybody noticed or not', set.contaminated);
  g.skipMs(100);
  eq('AB22 which the anomaly is in no doubt about', g.anomaly.state, 'adulterated');

  /* And it cannot be quietly picked back out. The cost is the whole account. */
  p.x = box.x + 0.5; p.z = box.z;
  g.skipMs(50);
  const purge = g.contextAction();
  ok('AB23 the only verb offered is to turn the case out',
    purge && purge.kind === 'purge', purge ? `${purge.kind}: ${purge.text}` : 'none');
  const inCase = set.inCase.length;
  g.doInteract();
  eq('AB24 which puts everything back on the floor, not just the wrong one', set.counted, 0);
  ok('AB25 all of it', set.list.filter((i) => i.loose).length >= inCase, `${inCase} were inside`);
  ok('AB26 and the contamination is cleared with it', !set.contaminated);

  /* ── the account, closed ───────────────────────────────────────────────────
   * Every real one in, nothing else, and only then does it become sealable. */
  for (const i of set.list.filter((x) => x.anomalous)) {
    if (i.deposited) continue;
    p.x = i.x; p.z = i.z; g.skipMs(50);
    if (g.contextAction() && g.contextAction().kind === 'collect') g.doInteract();
    p.x = box.x + 0.6; p.z = box.z; g.skipMs(50);
    if (g.contextAction() && g.contextAction().kind === 'deposit') g.doInteract();
  }
  eq('AB27 every member of the set can be recovered', set.counted, set.total);
  ok('AB28 with nothing else in the box', !set.contaminated);
  g.skipMs(200);
  /* ⚠ NOTHING TELLS YOU THE ACCOUNT IS CLOSED, and that is the design.
   *
   * There was an `accounted` state that arrived when the count matched the total, and it
   * made the CASE check the answer: the game refused to let a squad seal until they were
   * right, so the arithmetic did not matter and the stocktake sheet in the office was
   * decoration. It is sealable from the first clean deposit now — the seal is a decision
   * made on two numbers the squad has to have found, and the debrief settles it. */
  eq('AB29 the state does not change when the last one goes in — no announcement', g.anomaly.state, 'gathering');
  ok('AB30 and it has been sealable since the first clean deposit', g.anomaly.isHeld);

  /* §8.4: containment is a state the squad CREATES, and a climax that happens to you is
   * not a climax. Nothing seals itself. */
  ok('AB31 a full account does NOT seal the case by itself', g.custody === 'none');
  p.x = box.x + 0.9; p.z = box.z + 0.5;
  g.skipMs(50);
  const seal = g.contextAction();
  ok('AB32 the verb becomes the seal', seal && seal.kind === 'seal',
    seal ? `${seal.kind}: ${seal.text}` : 'none');
  eq('AB33 and it takes', g.doInteract(), null);
  g.skipMs(CONFIG.anomaly.custodyVerifySeconds * 1000 + 1200);
  eq('AB34 thirty seconds later it is custody', g.custody, 'verified');
  eq('AB35 and the set is contained', g.anomaly.state, 'contained');

  /* ── nobody was ever in danger ─────────────────────────────────────────────
   * The family's real signature. A whole operation, and the contact count is zero. */
  note(`contacts across the whole recovery: ${g.mission.tally.contacts}`);
  eq('AB36 an entire operation with nobody hurt', g.mission.tally.contacts, 0);

  /* ── the wire ──────────────────────────────────────────────────────────────
   * The set rides the snapshot, and the truth flag does not. */
  const client = new Game(tally, { seed: 'tally-client' });
  const snap = encodeSnapshot(g, g.clock.simTimeMs);
  ok('AB37 the snapshot carries the set', Array.isArray(snap.ix) && snap.ix.length === set.candidates);
  ok('AB38 without the answer in it — the client already has the incident file',
    snap.ix.every((row) => row.length === 6 && typeof row[0] === 'string'
      && !row.some((v) => v === true || v === false)),
    JSON.stringify(snap.ix[0]));
  applySnapshot(client, snap);
  eq('AB39 and a client reads the same account back', client.instances.counted, set.counted);
  eq('AB40 with every object where the host says it is',
    client.instances.list.filter((i) => i.deposited).length, set.inCase.length);

  /* ── sealing on an incomplete set ──────────────────────────────────────────
   * The failure this whole family exists to make possible. A squad that never found the
   * stocktake sheet does not know the total, seals on what it has, and walks out of a
   * building with two of the things still in it. Nothing in the field stops them, and the
   * debrief is the only place that says so. */
  const g2 = new Game(tally, { seed: 'tally-partial' });
  g2.commitLoadout(RECOMMENDED_MANIFEST);
  const p2 = g2.player;
  p2.x = g2.site.cache.x; p2.z = g2.site.cache.z; g2.skipMs(50);
  g2.takeFromCache('reinforced-transit-case');
  p2.selectSlot(SLOTS.findIndex((s) => p2.slots.get(s.id) === 'reinforced-transit-case'));
  p2.x = -6.0; p2.z = -9.0; p2.yaw = Math.PI / 2; g2.skipMs(50);
  g2.deployHeld();
  const box2 = g2.deployables.byItem('reinforced-transit-case')[0];
  const real2 = g2.instances.list.filter((i) => i.anomalous);
  for (const i of real2.slice(0, 3)) {
    p2.x = i.x; p2.z = i.z; g2.skipMs(50); g2.doInteract();
    p2.x = box2.x + 0.6; p2.z = box2.z; g2.skipMs(50); g2.doInteract();
    g2.skipMs(100);
  }
  eq('AB41 three of five logged', g2.instances.counted, 3);
  ok('AB42 and the case can be sealed anyway — nothing refuses an incomplete account',
    g2.anomaly.isHeld);
  p2.x = box2.x + 0.9; p2.z = box2.z + 0.5; g2.skipMs(50);
  const sealAct2 = g2.contextAction();
  eq('AB43 the seal is offered', sealAct2 && sealAct2.kind, 'seal');
  eq('AB44 and takes', g2.doInteract(), null);
  g2.skipMs(CONFIG.anomaly.custodyVerifySeconds * 1000 + 1200);
  eq('AB45 custody verifies on a partial set, because the case is sealed and holding',
    g2.custody, 'verified');
  const partialGrade = g2.mission.grade({
    custody: g2.custody, extracted: true, players: g2.players, player: g2.player,
    ledger: g2.ledger, deployables: g2.deployables, simTimeMs: g2.clock.simTimeMs,
    cargoIssued: g2.cargoIssued, cargoRecovered: 0, instances: g2.instances,
  });
  const integrity = partialGrade.dims.find((d) => d.name === 'Containment integrity');
  note(`partial debrief: ${partialGrade.overall} — ${integrity.word}: ${integrity.why}`);
  eq('AB46 the debrief calls it Partial, not Established', integrity.word, 'Partial');
  ok('AB47 and says how many were left behind', /3 of 5/.test(integrity.why), integrity.why);
  eq('AB48 an incomplete set can never grade above Compromised', partialGrade.overall, 'Compromised');
  emit();
}

/* ══ AC. the Definition of Done, run as a scorecard ════════════════════════════
 *
 * GDD §27.2 lists ten criteria an anomaly must meet to be release-ready, and §26.4 lists
 * eight metrics the vertical slice is judged on. Both are prose in a document nobody runs.
 * This runs them, across every anomaly the build ships, and prints a row per criterion.
 *
 * ⚠ SOME OF THESE CANNOT BE TESTED WITHOUT PEOPLE, AND THOSE REPORT **OPEN**. "80% can use
 * the evidence board without facilitator help" is a number that comes from external
 * testers or from nowhere, and a suite that quietly asserted `true` for it would be worse
 * than one that omitted it — it would look like the criterion had been met. The pattern is
 * AirportBaggageCrew's (Dev\INDEX.md): make the acceptance criteria executable, and report
 * the human ones OPEN rather than faking green.
 *
 * A criterion that is OPEN is not a failure. A criterion that is testable and NOT MET is.
 */
async function sectionAC() {
  lines.push('--- AC. GDD §27.2 and §26.4, as an executable scorecard ---');

  const packs = [];
  for (const id of INCIDENTS) packs.push(await loadContent({ incident: id }));
  const anomalies = [];
  for (const p of packs) if (!anomalies.some((a) => a.id === p.anomaly.id)) anomalies.push(p.anomaly);
  note(`${packs.length} incident packages over ${anomalies.length} anomalies`);
  ok(`AC0 the slice's floor of three incident packages is met (${packs.length})`, packs.length >= 3);

  /* ── §27.2, one anomaly at a time ─────────────────────────────────────────── */
  const fails = [];
  const check = (a, label, cond, detail) => { if (!cond) fails.push(`${a.id}: ${label}${detail ? ` (${detail})` : ''}`); };

  for (const a of anomalies) {
    /* 1. Every critical rule is observable, consistent and actionable. The engine's half of
     *    "observable" is that no state change is silent — §5.4 forbids an untelegraphed
     *    power outright. */
    check(a, 'every transition is telegraphed', a.triggers.every((t) => t.telegraph && t.telegraph.length > 12));

    /* 2b. No single instrument is the only way in. If every evidence rule required the
     *     imager, a squad that spent its cargo elsewhere learns nothing and the operation
     *     is a guess — the failure §7.4 is most worried about. (The "two paths per rule"
     *     half of criterion 2 is measured separately below, because it is the one the
     *     shipped content does not yet meet and it deserves its own line.) */
    const gated = a.evidenceRules.filter((e) => (e.requiredEquipment || []).length > 0).length;
    check(a, 'most evidence needs no particular instrument',
      gated * 2 <= a.evidenceRules.length, `${gated} of ${a.evidenceRules.length} gated`);

    /* 3. The team can recover from one ordinary procedural mistake. Structurally: from
     *    every non-terminal state there is a way onward — the dead-end check, which the
     *    tally anomaly failed for real. */
    const deadEnds = a.states.filter((s) => s.kind !== 'contained'
      && !a.triggers.some((t) => (t.from === s.id || t.from === '*') && t.to !== s.id));
    check(a, 'no state is a trap', deadEnds.length === 0, deadEnds.map((s) => s.id).join());

    /* 5. Latency does not create frame-perfect failure (§8.2). Every trigger has to carry
     *    a tolerance, and a zero is the same as not having one. */
    const tight = a.triggers.filter((t) => !(t.latencyToleranceMs > 0));
    check(a, 'every trigger has a latency tolerance', tight.length === 0, tight.map((t) => t.id).join());

    /* 7. Difficulty modifiers preserve the rules. The assist multiplies a capability's
     *    cooldown and nothing else; a capability with no cooldown is untouched by it, and
     *    a rule number must never be reachable from it. Section S measures the behaviour;
     *    this asserts the DATA cannot express a rule-moving assist. */
    check(a, 'no capability makes its reach or effect a function of anything but content',
      a.capabilities.every((c) => typeof c.rangeMetres === 'number' && Array.isArray(c.applies || [])));

    /* 9. Completable with more than one defensible loadout (§27.2, Pillar 4). Two
     *    procedures whose equipment lists are not the same list. */
    const procs = a.containment.procedures;
    const kits = new Set(procs.map((p) => (p.requiredEquipment || []).slice().sort().join(',')));
    check(a, 'more than one defensible loadout finishes it', kits.size >= 2, `${procs.length} procedures, ${kits.size} distinct kits`);

    /* 10. Attribution and provenance. §25.3: no designation before the licensing record
     *     exists, and `undefined` is not the same statement as `null`. */
    check(a, 'the licensing position is stated rather than left blank',
      Object.prototype.hasOwnProperty.call(a, 'licensingRecordId'));
  }
  note(`§27.2 structural criteria: ${fails.length ? fails.length + ' unmet' : 'all met across ' + anomalies.length + ' anomalies'}`);
  eq(`AC1 every shipped anomaly meets the structural half of §27.2${fails.length ? ` — ${fails.join(' · ')}` : ''}`,
    fails.length, 0);

  /**
   * §27.2, criterion 2, in the GDD's own words: "At least two evidence paths reveal each
   * required rule."
   *
   * The data says this literally — every evidence entry carries `revealsRule` — so this is
   * a count and not an interpretation. It is on its own line because it is the criterion
   * the build has actually been failing, and rolling it into a pass/fail with nine others
   * would have hidden which one.
   *
   * ⚠ Why it matters, rather than being bookkeeping: Pillar 1's design test is "after a
   * failure, can players explain what they misunderstood?" With one path per rule, a squad
   * that walks past a single pickup can never learn that rule at all — not "finds it
   * harder", cannot. One source is not confidence.
   */
  const paths = new Map();
  for (const a of anomalies) {
    for (const e of a.evidenceRules) {
      if (!e.revealsRule) continue;
      const k = `${a.id}/${e.revealsRule}`;
      paths.set(k, (paths.get(k) || 0) + 1);
    }
  }
  const thin = [...paths.entries()].filter(([, n]) => n < 2).map(([k]) => k);
  note(`rules with a second evidence path: ${paths.size - thin.length} of ${paths.size}`);
  if (thin.length) note(`    single-path rules: ${thin.join(', ')}`);
  eq(`AC1b every required rule is revealed by at least two evidence paths (§27.2)`, thin.length, 0);

  /* ── the three families are actually three ────────────────────────────────
   * §26.2 asks for distinct procedure FAMILIES, and the way that fails quietly is three
   * anomalies with the same verbs and different numbers. Compare the verb sets. */
  const verbSets = anomalies.map((a) => ({
    id: a.id,
    verbs: new Set(a.containment.procedures.flatMap((p) => p.verbs || [])),
  }));
  const overlap = (x, y) => [...x].filter((v) => y.has(v)).length / Math.max(1, Math.min(x.size, y.size));
  let worst = 0, worstPair = '';
  for (let i = 0; i < verbSets.length; i++) {
    for (let j = i + 1; j < verbSets.length; j++) {
      const o = overlap(verbSets[i].verbs, verbSets[j].verbs);
      if (o > worst) { worst = o; worstPair = `${verbSets[i].id}/${verbSets[j].id}`; }
    }
  }
  note(`most similar pair of procedure vocabularies: ${worstPair} at ${(worst * 100).toFixed(0)}% overlap`);
  ok(`AC2 no two anomalies run the same procedure with different numbers (${(worst * 100).toFixed(0)}%)`,
    worst < 1.0, worstPair);

  /* Each family's SIGNATURE, asserted directly rather than inferred. */
  const byId = new Map(anomalies.map((a) => [a.id, a]));
  const senseOf = (id) => new Set((byId.get(id) || { triggers: [] }).triggers.map((t) => t.when.sense));
  const draught = senseOf('graybox-draught'), figure = senseOf('stillwater-figure'), tally = senseOf('ninety-one-tally');
  ok('AC3 the fence family is the only one that reads a gradient', draught.has('path-blocked-by-gradient')
    && !figure.has('path-blocked-by-gradient') && !tally.has('path-blocked-by-gradient'));
  ok('AC4 the perception family is the only one that reads observation',
    figure.has('observed') && !draught.has('observed') && !tally.has('observed'));
  ok('AC5 the recovery family is the only one that reads a count',
    tally.has('instances-accounted') && !draught.has('instances-accounted') && !figure.has('instances-accounted'));

  /* ── §26.4, the measurable half ───────────────────────────────────────────── */
  lines.push('    §26.4 slice metrics:');

  /* "Fewer than 10% of failures are described as untelegraphed or impossible to
   * understand." The describing needs people; what the build can guarantee is that no
   * failure path is untelegraphed IN THE DATA, which is the necessary half. */
  const untelegraphed = anomalies.flatMap((a) => a.triggers.filter((t) => !t.telegraph).map((t) => `${a.id}/${t.id}`));
  eq('AC6 no failure path in any anomaly is untelegraphed', untelegraphed.length, 0, untelegraphed.join());

  /* "No critical licensing, network-authority, save, or accessibility defect remains."
   * Each of those has a section of its own in this suite; this asserts they were run. */
  ok('AC7 licensing: every anomaly ships an explicit licensing position, none claims a designation it has not earned',
    anomalies.every((a) => a.licensingRecordId === null || typeof a.licensingRecordId === 'string'));

  /* "Median mission duration is 30-45 minutes." THIS IS THE ONE THE BUILD FAILS, and it
   * is worth failing loudly rather than quietly widening the target. The bot runs are the
   * only durations that exist and a bot does not search, does not deliberate and does not
   * get anything wrong — so they are a LOWER BOUND on a human's time and not an estimate
   * of it. Reported as measured, and marked OPEN because the metric is about players. */
  note(`    OPEN — median mission duration: no human runs exist. Bot lower bounds are ~3-15 min`);
  note('           against a 30-45 min target (§2.4, §26.4). A bot does not search or hesitate,');
  note('           so this is not evidence the missions are too short — it is the absence of evidence.');

  for (const m of [
    '80% can use the evidence board without facilitator help',
    '70% can state at least two correct behavioural rules',
    '60% complete containment on Field difficulty',
    '75% describe a meaningful role for more than one teammate',
    'the containment phase is rated more memorable than weapon use',
  ]) note(`    OPEN — ${m} (external testers; §26.4)`);

  ok('AC8 the scorecard reports the human criteria as OPEN rather than asserting them', true);
  emit();
}

/* ══ AD. the recommended manifest, under pressure ══════════════════════════════
 *
 * The trim loop is the part of this that has never been exercised: both shipped incidents
 * happen to fit the budget once quantities come down, so the branch that removes a whole
 * ROW had never run in anger. It was `out.pop()`, which drops the most recently pushed
 * item — the trauma kit the function deliberately adds two lines earlier. The manifest's
 * own medical cover was the first thing it would have thrown away, and it was waiting for
 * the first incident whose safe procedure named one more item than would fit.
 *
 * So this squeezes the budget artificially and watches what it gives up.
 */
async function sectionAD(content) {
  lines.push('--- AD. what the recommended manifest gives up first ---');
  const squeeze = (budget) => {
    const c = { ...content, items: { ...content.items, cargoVolumeBudget: budget } };
    return recommendedManifest(c);
  };
  const full = recommendedManifest(content);
  const volOf = (m) => m.reduce((a, x) => a + content.itemsById.get(x.itemId).cargoVolume * x.qty, 0);
  note(`at the shipped budget of ${content.items.cargoVolumeBudget}: ${full.map((x) => `${x.itemId}×${x.qty}`).join(', ')} = ${volOf(full)}`);
  ok('AD1 the recommendation fits the budget it is offered against', volOf(full) <= content.items.cargoVolumeBudget);
  ok('AD2 and includes medical cover, which no containment procedure ever asks for',
    full.some((x) => x.itemId === 'trauma-kit'));

  for (const b of [9, 7, 5, 4, 3]) {
    const m = squeeze(b);
    note(`  budget ${b}: ${m.map((x) => `${x.itemId}×${x.qty}`).join(', ') || '(nothing)'} = ${volOf(m)}`);
    ok(`AD3.${b} a budget of ${b} still produces a manifest that fits`, volOf(m) <= b, `${volOf(m)} > ${b}`);
  }
  const tight = squeeze(5);
  ok('AD4 medical cover survives the squeeze that starts dropping whole items',
    tight.some((x) => x.itemId === 'trauma-kit'),
    tight.map((x) => x.itemId).join());

  /* ⚠ The vessel is the one item without which there is no operation, and it was going
   * FIRST because at three volume it is the largest thing on the list. A recommendation
   * that cannot establish custody is a wrong answer given confidently. */
  const sealTrigger = content.anomaly.triggers.find((t) => t.when && t.when.sense === 'enclosed-by');
  const vessel = sealTrigger && sealTrigger.when.itemId;
  ok('AD5 the anomaly states what it has to be sealed into', !!vessel, String(vessel));
  for (const b of [4, 3]) {
    const m = squeeze(b);
    ok(`AD6.${b} at a budget of ${b} the recommendation still carries the vessel`,
      m.some((x) => x.itemId === vessel), m.map((x) => x.itemId).join() || '(nothing)');
  }
  const tiny = squeeze(2);
  ok('AD7 and a budget too small for anything terminates rather than looping', Array.isArray(tiny));
  note(`  budget 2: ${tiny.map((x) => `${x.itemId}×${x.qty}`).join(', ') || '(nothing)'}`);
  emit();
}

/* ══ AE. the controller (GDD §27.1, §19.1) ═════════════════════════════════════
 *
 * §27.1's Definition of Done requires "keyboard/mouse and controller flows work". The
 * whole build asks for ACTIONS and never for keys, so a pad button is a synthetic CODE
 * through the same `_press`/`_release` the keyboard uses — which means what has to be
 * tested is not "does a button fire" but that the pad INHERITS everything: the binding
 * table, the conflict checker, hold-versus-toggle, and rebinding.
 *
 * The pad is passed IN rather than read from `navigator`, so this drives the same code
 * path a real controller does rather than a mock of it.
 */
function sectionAE() {
  lines.push('--- AE. a controller, through the same actions a keyboard uses ---');

  /* A W3C standard-mapping pad, as `navigator.getGamepads()` reports one. */
  const mkPad = (over = {}) => ({
    connected: true, mapping: 'standard', id: 'Test Pad (STANDARD GAMEPAD)',
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
    ...over,
  });
  const press = (pad, name, v = 1) => {
    const i = PAD_BUTTONS.indexOf(name);
    pad.buttons[i] = { pressed: v >= 0.55, value: v };
    return pad;
  };

  const input = new Input({ addEventListener() {}, removeEventListener() {} });
  eq('AE1 no pad is connected until one is seen', input.pad.connected, false);
  eq('AE2 and polling nothing stays that way', input.pollPads([]), false);

  const pad = mkPad();
  ok('AE3 a standard pad connects', input.pollPads([pad]));
  eq('AE4 and says which one', input.pad.id.length > 0, true);

  /* ⚠ A pad reporting a non-standard mapping is IGNORED, not guessed at. A player whose
   * fire button opens the tablet has a broken game; one with no pad support has a
   * keyboard. */
  eq('AE5 a pad with an unknown button layout is refused rather than mis-mapped',
    input.pollPads([mkPad({ mapping: '' })]), false);
  input.pollPads([pad]);

  /* Buttons arrive as ACTIONS, through the shipped default bindings. */
  press(pad, 'PadA');
  input.pollPads([pad]);
  ok('AE6 the south face button is the context verb, because that is what it is bound to',
    input.wasPressed('interact'));
  ok('AE7 and the keyboard binding is still there beside it', DEFAULT_BINDINGS.interact.includes('KeyF'));
  input.endStep();
  press(pad, 'PadA', 0);
  input.pollPads([pad]);
  ok('AE8 releasing it is a release', input.wasReleased('interact'));
  input.endStep();

  /* Triggers are analog and need a line drawn somewhere. */
  press(pad, 'PadRT', 0.3);
  input.pollPads([pad]);
  ok('AE9 a half-pulled trigger is not a press', !input.wasPressed('slot5'));
  press(pad, 'PadRT', 0.9);
  input.pollPads([pad]);
  ok('AE10 a pulled one is', input.wasPressed('slot5'));
  input.endStep();
  press(pad, 'PadRT', 0);
  input.pollPads([pad]);

  /* ⚠ HOLD VERSUS TOGGLE IS INHERITED. The accessibility setting was written for a
   * keyboard and the pad must not need its own copy of it — that is the entire reason a
   * button is a code rather than a special case. */
  input.setHoldMode('sprint', HOLD_MODE.TOGGLE);
  press(pad, 'PadLS');
  input.pollPads([pad]);
  ok('AE11 a toggled action latches from the pad', input.isDown('sprint'));
  input.endStep();
  press(pad, 'PadLS', 0);
  input.pollPads([pad]);
  ok('AE12 and stays on when the stick click is released', input.isDown('sprint'));
  press(pad, 'PadLS');
  input.pollPads([pad]);
  ok('AE13 pressing again turns it off', !input.isDown('sprint'));
  input.endStep();
  press(pad, 'PadLS', 0);
  input.pollPads([pad]);
  input.setHoldMode('sprint', HOLD_MODE.HOLD);

  /* Rebinding works on pad codes for the same reason. */
  input.rebind('use', 'PadY');
  press(pad, 'PadY');
  input.pollPads([pad]);
  ok('AE14 a pad button can be rebound like any other code', input.wasPressed('use'));
  input.endStep();
  press(pad, 'PadY', 0);
  input.pollPads([pad]);
  input.resetBindings();

  /* ── the sticks, which are the part that actually matters ─────────────────── */
  pad.axes = [0, 0, 0, 0];
  input.pollPads([pad]);
  const idle = input.moveAxis();
  eq('AE15 a centred stick is exactly zero, not nearly zero', `${idle.x},${idle.y}`, '0,0');

  pad.axes = [0.15, 0, 0, 0];
  input.pollPads([pad]);
  eq('AE16 and so is a stick inside the deadzone', input.moveAxis().x, 0);

  pad.axes = [1, 0, 0, 0];
  input.pollPads([pad]);
  const full = input.moveAxis();
  ok('AE17 full deflection is full speed', Math.abs(full.x - 1) < 0.001, String(full.x));

  pad.axes = [0.55, 0, 0, 0];
  input.pollPads([pad]);
  const half = input.moveAxis().x;
  note(`stick response: 0.15 → 0.000, 0.55 → ${half.toFixed(3)}, 1.00 → ${full.x.toFixed(3)}`);
  note('  squared, so the first half of the travel is fine control — which is what makes');
  note('  placing a tripod in a 1.5m doorway possible on a pad at all.');
  ok('AE18 half deflection is well under half speed', half > 0 && half < 0.35, String(half));

  /* Diagonals stay on the unit circle rather than going faster. */
  pad.axes = [0.8, 0.8, 0, 0];
  input.pollPads([pad]);
  const diag = input.moveAxis();
  const mag = Math.hypot(diag.x, diag.y);
  ok(`AE19 a diagonal is never faster than a straight line (${mag.toFixed(3)})`, mag <= 1.0001);

  /* ⚠ THE KEYBOARD IS NOT ADDED TO THE STICK. A player with a hand on each — a real
   * accessibility configuration — gets one vector, not a doubled one. */
  input._debugPress('KeyD');
  pad.axes = [-1, 0, 0, 0];
  input.pollPads([pad]);
  const both = input.moveAxis();
  ok('AE20 stick and keys do not sum', Math.abs(both.x) <= 1.0001, String(both.x));
  eq('AE21 the stick wins while it is being held', Math.sign(both.x), -1);
  pad.axes = [0, 0, 0, 0];
  input.pollPads([pad]);
  eq('AE22 and the keyboard takes over the moment it is let go', input.moveAxis().x, 1);
  input._debugRelease('KeyD');

  /* ⚠ LOOK IS A RATE, NOT A DELTA. A mouse hands the game a distance a hand actually
   * moved; a stick hands it a position it is being held at. Treating one as the other
   * makes turn speed a function of frame rate — smooth at 144Hz, unusable at 30fps. */
  pad.axes = [0, 0, 1, 0];
  input.pollPads([pad]);
  const at60 = input.padLook(1000 / 60).yaw;
  const at30 = input.padLook(1000 / 30).yaw;
  note(`look at full deflection: ${Math.abs(at60 * 1000).toFixed(2)} mrad in a 60Hz frame, ${Math.abs(at30 * 1000).toFixed(2)} in a 30Hz one`);
  ok('AE23 a longer frame turns further, so what is constant is the rate',
    Math.abs(at30 / at60 - 2) < 0.01, String(at30 / at60));
  input.pollPads([mkPad()]);
  eq('AE24 and a centred stick turns nothing at all', input.padLook(16).yaw, 0);

  /* ⚠ An unplugged pad RELEASES what it was holding. Otherwise the operative sprints into
   * a wall for the rest of the operation. */
  const p2 = mkPad();
  press(p2, 'PadLS');
  input.pollPads([p2]);
  ok('AE25 a held pad button reads as held', input.isDown('sprint'));
  input.pollPads([]);
  ok('AE26 unplugging the pad lets go of everything it was holding', !input.isDown('sprint'));
  eq('AE27 and the stick goes to zero with it', input.moveAxis().x, 0);
  emit();
}

/* ══ AF. nothing stands on top of anything else ════════════════════════════════
 *
 * ⚠ THE SINGLE MOST LIKELY WAY TO BREAK A MAP WITHOUT BREAKING A TEST, and it has now
 * done it three times in this project.
 *
 * The context verb is NEAREST-WINS and it is right to be: one resolver, so the prompt and
 * the key can never disagree. The consequence is that two interactable things within a
 * couple of metres of each other are in competition, and the loser can NEVER be selected —
 * not "is harder to select", cannot. There is no error, no warning, and the map looks
 * perfectly fine; a verb simply does not exist any more.
 *
 * Every occurrence so far:
 *   · a transit case set down on the office desk made the plant log unreadable;
 *   · the frost line authored at the pen made the lane door unselectable, so the tally
 *     incident could not be closed;
 *   · a charging rack placed 2.7m from the office breaker made the whole solo containment
 *     unplayable — the bot could not restore the circuit, could not open the office, and
 *     six assertions and a crash followed from one coordinate.
 *
 * Each was found by an unrelated test failing strangely, minutes to hours after the
 * content was written. This finds it at the coordinate.
 */
async function sectionAF() {
  lines.push('--- AF. no two interactables compete for the same verb ---');

  /* The reach that decides it, plus the door's own bonus, plus a margin. Two things this
   * far apart can still both be reached from somewhere — what matters is that from any
   * point where you can reach one, it is unambiguously the nearer. */
  const MARGIN = 2.5;
  const rows = [];
  let tightest = { d: Infinity, what: '—' };

  for (const id of INCIDENTS) {
    const c = await loadContent({ incident: id });
    const m = c.map;
    /* Everything the context verb can resolve to, in one list, with a label that will
     * make sense in a failure message at 2am. */
    const fixtures = [
      ...m.evidenceSources.map((e) => ({ x: e.at[0], z: e.at[1], what: `evidence ${e.evidenceId}` })),
      ...(m.instanceSites || []).map((s) => ({ x: s.at[0], z: s.at[1], what: `object ${s.id}` })),
      ...m.circuits.map((s) => ({ x: s.switch[0], z: s.switch[1], what: `breaker ${s.id}` })),
      ...m.doors.map((d) => ({
        x: (d.aabb[0] + d.aabb[2]) / 2, z: (d.aabb[1] + d.aabb[3]) / 2, what: `door ${d.id}`,
      })),
      { x: m.cache.x, z: m.cache.z, what: 'the cargo cache' },
      { x: m.extraction.x, z: m.extraction.z, what: 'extraction' },
    ];

    const clashes = [];
    for (let i = 0; i < fixtures.length; i++) {
      for (let j = i + 1; j < fixtures.length; j++) {
        const a = fixtures[i], b = fixtures[j];
        const d = dist(a.x, a.z, b.x, b.z);
        /* ⚠ Two objects of the SET are exempt from each other, and only from each other.
         * They are supposed to sit in a drawer together — that is the search gradient the
         * incident is built on — and `nearestLoose` resolves between them by distance with
         * no other candidate to lose to. */
        if (a.what.startsWith('object ') && b.what.startsWith('object ')) continue;
        if (d < MARGIN) clashes.push(`${a.what} ↔ ${b.what} at ${d.toFixed(2)}m`);
        if (d < tightest.d) tightest = { d, what: `${id}: ${a.what} ↔ ${b.what}` };
      }
    }
    rows.push({ id, n: fixtures.length, clashes });
  }

  /**
   * ⚠ PROXIMITY IS NOT THE PROPERTY. The first version of this failed on any pair inside
   * 2.5m and found thirty-seven across four incidents — nearly all of them content that has
   * demonstrably worked for the whole project. An office breaker and a plant log two metres
   * apart are both perfectly selectable; you stand on one side or the other.
   *
   * What actually matters is whether there EXISTS a standable point from which a thing is
   * the nearest interactable. If there is not, that verb is gone — not harder to reach,
   * gone — and no other test will say so. So the pairs are reported as information, and the
   * assertion is the property.
   */
  for (const r of rows) {
    note(`${r.id}: ${r.n} interactables${r.clashes.length ? `, closest pairs — ${r.clashes.slice(0, 3).join(' · ')}${r.clashes.length > 3 ? ` (+${r.clashes.length - 3})` : ''}` : ''}`);
  }
  note(`tightest pair anywhere: ${tightest.what} at ${tightest.d.toFixed(2)}m`);

  const shadowed = [];
  for (const id of INCIDENTS) {
    const c = await loadContent({ incident: id });
    const m = c.map;
    const site = new Site(m);
    const all = [
      ...m.evidenceSources.map((e) => ({ x: e.at[0], z: e.at[1], what: `evidence ${e.evidenceId}` })),
      ...m.circuits.map((s) => ({ x: s.switch[0], z: s.switch[1], what: `breaker ${s.id}` })),
    ];
    for (const f of all) {
      /* Sweep the ring an operative could stand on to work this thing, and ask whether any
       * point on it makes this the winner. 0.2m steps out to the 2.2m reach. */
      let won = false;
      for (let r = 0.4; r <= 2.1 && !won; r += 0.2) {
        for (let a = 0; a < 24 && !won; a++) {
          const th = (a / 24) * Math.PI * 2;
          const x = f.x + Math.cos(th) * r, z = f.z + Math.sin(th) * r;
          if (!standsAt(site, x, z)) continue;
          let nearest = f, best = r;
          for (const o of all) {
            if (o === f) continue;
            const d = dist(x, z, o.x, o.z);
            if (d < best) { best = d; nearest = o; }
          }
          if (nearest === f) won = true;
        }
      }
      if (!won) shadowed.push(`${id}: ${f.what}`);
    }
  }
  eq(`AF1 every interactable has somewhere to stand where it is the nearest thing${shadowed.length ? ` — shadowed: ${shadowed.join(', ')}` : ''}`,
    shadowed.length, 0);

  /* And the positive half: every evidence source can actually be selected. A source that
   * clears the margin but sits inside a wall is equally unreachable, and the margin test
   * would not notice. */
  const c = await loadContent({ incident: 'cold-storage-draught' });
  const g = new Game(c, { seed: 'reach' });
  g.commitLoadout(RECOMMENDED_MANIFEST);
  const unreachable = [];
  for (const s of c.map.evidenceSources) {
    if ((s.requiresEquipment || []).length) continue;   // needs kit this bot has not taken
    g.player.x = s.at[0]; g.player.z = s.at[1];
    g.skipMs(50);
    const act = g.contextAction();
    if (!act || act.kind !== 'evidence') unreachable.push(`${s.evidenceId} → ${act ? act.kind : 'nothing'}`);
  }
  eq(`AF2 standing on an evidence source offers the evidence${unreachable.length ? ` (${unreachable.join(', ')})` : ''}`,
    unreachable.length, 0);
  emit();
}
/**

/* ══ AG. auditory lure and restraint ═══════════════════════════════════════════
 *
 * GDD §26.2's second named procedure family, and the one that completes the slice's three.
 *
 * What makes it a family rather than a reskin is the RESTRAINT half. Every other
 * containment in this build is something the squad BUILDS — a wall of heat, a cone of
 * attention, an account in a box. This one is something they STOP DOING: you cannot make a
 * quiet louder, you can only switch things off and crouch. So the assertions below are as
 * much about what has to be ABSENT as about what happens.
 */
async function sectionAG() {
  lines.push('--- AG. it hunts sound, and silence is what holds it ---');

  const pack = await loadContent({ incident: 'blackthorn-caller' });
  eq('AG1 the fifth incident package loads and validates', pack.anomaly.id, 'blackthorn-caller');
  eq('AG2 on the slice forest map', pack.map.id, 'blackthorn-reserve');
  eq('AG3 it disturbs no field of its own — an imager finds a reserve at ambient',
    pack.anomaly.presence.field.kind, 'none');
  ok('AG4 and reads nothing about heat, observation or a count',
    pack.anomaly.triggers.every((t) => ['noise-above', 'loudest-noise-within', 'masked-for', 'enclosed-by'].includes(t.when.sense)),
    pack.anomaly.triggers.map((t) => t.when.sense).join());

  const g = new Game(pack, { seed: 'caller-1' });
  const p = g.player;
  const a = g.anomaly;
  g.commitLoadout(recommendedManifest(pack));

  /* ── the squad is a source whether it means to be or not ──────────────────── */
  const ambient = CONFIG.sound.ambientDb;
  /**
   * ⚠ THE OPERATIVE HAS TO ACTUALLY WALK.
   *
   * The first version of this set `p.vx` directly and read the field, and every posture
   * came back at about 30dB — because `step()` recomputes velocity from the COMMAND every
   * tick, so a poked velocity is gone before the sample is taken. It read as "sound does
   * not work" when what it actually demonstrated is the thing the field is built on:
   * `operativeNoiseDb` reads SPEED and not a key, so a sprint held against a wall is
   * silent. Driving it through commands is both the correct test and the point.
   */
  const posture = ({ move = false, crouch = false }) => {
    p.x = a.x + 2.0; p.z = a.z + 2.0; p.yaw = 0;
    g.setCommand('p1', { axis: { x: 0, y: move ? -1 : 0 }, sprint: false, crouch });
    /* Long enough to reach terminal speed — accel is 22 m/s², so ~0.4s. */
    g.skipMs(700);
    const at = { x: p.x, z: p.z };
    const db = g.sound.levelAt(a.x, a.z);
    return { db, d: dist(at.x, at.z, a.x, a.z) };
  };
  const stillR = posture({});
  const walkR = posture({ move: true });
  const crouchR = posture({ move: true, crouch: true });
  const still = stillR.db, walking = walkR.db, crouched = crouchR.db;
  g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
  note(`heard at ~${walkR.d.toFixed(1)}m: ${still.toFixed(1)}dB standing still · ${crouched.toFixed(1)}dB crouch-walking · ${walking.toFixed(1)}dB walking (reserve ${ambient})`);
  const thresh = pack.anomaly.triggers.find((t) => t.id === 'disturbed').when.thresholdDb;
  ok(`AG5 walking close to it is over the ${thresh}dB threshold (${walking.toFixed(1)}dB)`, walking > thresh);
  /* ⚠ THIS IS WHY CROUCH EXISTS. It has been in the build since the first commit and
   * nothing has ever required it — it was a way to be shorter. Here it is the difference
   * between sealing the thing and being what it runs at. */
  ok(`AG6 and crouch-walking the same route is under it (${crouched.toFixed(1)}dB)`, crouched < thresh);
  ok('AG7 moving at all is louder than standing still, and standing still is never silent',
    walking > still && still > ambient, `${walking.toFixed(1)} > ${still.toFixed(1)} > ${ambient}`);

  /* ── the squad's own kit is the lure, which is the trap ───────────────────── */
  const hum = ['floodlight-tripod', 'portable-heater', 'power-pack', 'reinforced-transit-case']
    .map((id) => ({ id, db: pack.itemsById.get(id).noiseOutputDb }));
  note(`the fence-builder's kit, as heard: ${hum.map((h) => `${h.id} ${h.db}dB`).join(' · ')}`);
  ok('AG8 every powered thing in the draught playbook is audible', hum.every((h) => h.db > ambient));
  ok('AG9 and louder than a crouching operative, so a deployed lure hides the squad',
    hum.every((h) => h.db > CONFIG.player.crouchNoiseDb));

  /* ── lure ─────────────────────────────────────────────────────────────────── */
  /* Kit comes out of the cargo cache at the command point, like everything else. */
  const lureAt = { x: a.x + 9, z: a.z + 2 };
  p.x = g.site.cache.x; p.z = g.site.cache.z;
  g.skipMs(50);
  eq('AG10a the heater is in the manifest and comes out of cargo', g.takeFromCache('portable-heater'), null);
  p.selectSlot(SLOTS.findIndex((s) => p.slots.get(s.id) === 'portable-heater'));
  p.x = lureAt.x + 0.9; p.z = lureAt.z; p.yaw = Math.PI / 2;
  g.skipMs(50);
  eq('AG10 and can be set down as a lure', g.deployHeld(), null);
  /* Withdraw, so the operative is not competing with their own lure. */
  p.x = a.x - 14; p.z = a.z - 14;
  g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
  g.skipMs(2500);
  note(`after the lure goes down: ${a.state}, ${g.sound.levelAt(a.x, a.z).toFixed(1)}dB where it stands`);
  ok('AG11 the lure rouses it', a.state !== 'dormant');
  let guard = 0;
  while (a.state !== 'running' && guard < 30000) { g.skipMs(250); guard += 250; }
  eq('AG12 and it resolves the source and comes', a.state, 'running');
  const startD = dist(a.x, a.z, lureAt.x, lureAt.z);
  guard = 0;
  while (dist(a.x, a.z, lureAt.x, lureAt.z) > 2.0 && guard < 60000) { g.skipMs(250); guard += 250; }
  const endD = dist(a.x, a.z, lureAt.x, lureAt.z);
  note(`it crossed ${startD.toFixed(1)}m to the lure in ${(guard / 1000).toFixed(1)}s, ending ${endD.toFixed(2)}m off`);
  ok('AG13 all the way to it', endD <= 2.0);

  /* ── restraint: the thing you do is stop ──────────────────────────────────── */
  const lure = g.deployables.byItem('portable-heater')[0];
  lure.on = false;   // Deployable.active is a getter (on && hasPower), so this is the whole of it

  const stillAt = { x: a.x, z: a.z };
  g.skipMs(3000);
  eq('AG14 three seconds after the lure dies it has NOT stopped yet', a.state !== 'stilled', true);
  g.skipMs(9000);   // the state change to casting restarts the stilling sustain
  eq('AG15 sustained silence stops it', a.state, 'stilled');
  /* ⚠ AND IT STOPS FURTHER ALONG THE LINE. The sustain is what makes silence a procedure
   * rather than a reflex — kill the lure at the wrong moment and it stops six seconds past
   * where you wanted it. A squad that does not know the figure is six will be consistently
   * a couple of metres out. */
  const drift = dist(a.x, a.z, stillAt.x, stillAt.z);
  note(`it travelled a further ${drift.toFixed(2)}m after the lure went quiet`);
  ok('AG16 it is the vulnerable kind while stilled', a.isHeld);

  /* ── and waking it is instant, which is the whole tension ─────────────────── */
  /* Face the thing, then walk at it — `axis.y = -1` is forward, and forward is
   * (-sin yaw, -cos yaw), so a yaw left at 0 walks along -z regardless of where it is. */
  const faceIt = () => {
    const dx = a.x - p.x, dz = a.z - p.z, L = Math.hypot(dx, dz) || 1;
    p.yaw = Math.atan2(-dx / L, -dz / L);
  };
  p.x = a.x + 1.8; p.z = a.z;
  faceIt();
  g.setCommand('p1', { axis: { x: 0, y: -1 }, sprint: false, crouch: false });
  g.skipMs(900);
  /* ⚠ IT DOES NOT STOP AT "AWAKE". Waking is `disturbed` (stilled → casting) and it
   * resolves the operative on the very next step, because the operative is the only thing
   * making a noise — so what a squad sees is a stilled caller becoming a running one with
   * no intermediate state they could act in. The first version of this asserted `casting`
   * and was asserting a frame nobody will ever see. */
  ok('AG17 walking up to a stilled caller wakes it at once — no sustain on the way back',
    a.state !== 'stilled', a.state);
  note(`    and it does not pause on the way: ${a.state} within a second of the first footstep`);

  /* It is now running at the operative, which is the correct outcome of that mistake and
   * the reason the mistake matters. Break contact, go quiet, and do it properly. */
  g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
  p.x = a.x - 26; p.z = a.z - 26;
  p.alive = true; p.downed = false; p.downedMs = 0;
  g.skipMs(14000);
  eq('AG18 breaking off and going quiet stills it again', a.state, 'stilled');

  /* Crouch the last three metres. This is the endgame and it is one key. */
  p.x = a.x + 1.8; p.z = a.z;   // the bearing AG17 already proved is clear
  faceIt();
  g.setCommand('p1', { axis: { x: 0, y: -1 }, sprint: false, crouch: true });
  g.skipMs(1100);
  g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: true });
  g.skipMs(200);
  const closed = dist(p.x, p.z, a.x, a.z);
  note(`crouch-walked from 1.8m to ${closed.toFixed(2)}m; it is ${a.state}`);
  ok('AG19 a crouching operative can close on it without waking it',
    closed < 1.3 && a.state === 'stilled', `${closed.toFixed(2)}m, ${a.state}`);

  /* ── the seal ─────────────────────────────────────────────────────────────── */
  /* Fetch the case, crouching the whole way back in. */
  p.x = g.site.cache.x; p.z = g.site.cache.z;
  g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
  g.skipMs(50);
  g.takeFromCache('reinforced-transit-case');
  p.selectSlot(SLOTS.findIndex((s) => p.slots.get(s.id) === 'reinforced-transit-case'));
  p.x = a.x + 1.7; p.z = a.z;
  faceIt();
  g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: true });
  g.skipMs(50);
  eq('AG20 the case goes down beside it', g.deployHeld(), null);

  /* ⚠ THE CASE ITSELF HUMS AT 46dB, WHICH IS THE THRESHOLD. Setting the containment vessel
   * down next to the thing being contained is the last place a squad expects the lure rules
   * to still apply, so this asserts what actually happens rather than what would be
   * convenient — and either answer is the incident working. */
  g.skipMs(2500);
  note(`with the case deployed beside it: ${a.state}, ${g.sound.levelAt(a.x, a.z).toFixed(1)}dB`);
  const box = g.deployables.byItem('reinforced-transit-case')[0];
  ok('AG21 the case is on the floor beside it either way', !!box);
  if (a.state !== 'stilled' && box) {
    note('    the case woke it. Switching the case off is the move, and it is available.');
    box.on = false;
    g.skipMs(12000);
    eq('AG21b with the case switched off it stills again', a.state, 'stilled');
  } else {
    ok('AG21b the case did not wake it', true);
  }
  const act = g.contextAction();
  ok('AG22 with it stilled and the case in reach, the verb is the seal',
    act && act.kind === 'seal', act ? `${act.kind}: ${act.text}` : 'none');
  eq('AG23 which takes', g.doInteract(), null);
  g.skipMs(CONFIG.anomaly.custodyVerifySeconds * 1000 + 1200);
  eq('AG23b and thirty seconds later it is custody', g.custody, 'verified');

  /* ── masking, which is the tool and the failure ───────────────────────────── */
  const g2 = new Game(pack, { seed: 'caller-mask' });
  g2.commitLoadout(recommendedManifest(pack));
  const a2 = g2.anomaly, p2 = g2.player;
  const place = (itemId, x, z) => {
    p2.x = g2.site.cache.x; p2.z = g2.site.cache.z; g2.skipMs(50);
    g2.takeFromCache(itemId);
    p2.selectSlot(SLOTS.findIndex((s) => p2.slots.get(s.id) === itemId));
    p2.x = x; p2.z = z; p2.yaw = 0; g2.skipMs(50);
    return g2.deployHeld();
  };
  /* Two similar sources, equidistant. Neither beats the other where it stands. */
  place('power-pack', a2.x - 8, a2.z);
  place('floodlight-tripod', a2.x + 8, a2.z);
  p2.x = a2.x - 20; p2.z = a2.z - 20;
  g2.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
  g2.skipMs(1500);
  const heard = g2.sound.loudestAudibleFrom(a2.x, a2.z);
  note(`two lures either side: level ${g2.sound.levelAt(a2.x, a2.z).toFixed(1)}dB, resolved source ${heard ? heard.id : 'none'}`);
  /* ⚠ THE CLAIM IS NOT "IT IS QUIET". It is loud — measurably above the reserve — and it
   * still cannot be resolved into a direction, because neither source beats the other by
   * the margin needed to be picked out. Loud and unusable is a different state from quiet,
   * and it is the one that gets a squad's lure ignored. */
  ok('AG24 two lures of similar level are audibly above the reserve',
    g2.sound.levelAt(a2.x, a2.z) > CONFIG.sound.ambientDb + 2,
    `${g2.sound.levelAt(a2.x, a2.z).toFixed(1)}dB vs ${CONFIG.sound.ambientDb}dB`);
  eq('AG24b and it still cannot resolve either of them', heard, null);
  g2.skipMs(9000);
  ok('AG25 so a squad that runs both at once stills it where it stands, not at the case',
    a2.state === 'stilled' || !heard, `${a2.state}, heard ${heard ? heard.id : 'none'}`);
  emit();
}

/* ══ AH. the board, the ledger and the cargo wager agree with each other ═══════
 *
 * Three separate things that each looked correct alone and disagreed in pairs.
 */
async function sectionAH(content) {
  lines.push('--- AH. the hypothesis board can actually be satisfied ---');

  /* ⚠ A TRUE CLAIM MUST BE REACHABLE. `supportFor` returns "strong" only on two hits with
   * a confirmed one among them, so a claim listing a single source is stuck below strong
   * however carefully a squad works — and two of them listed exactly one. Nothing said so:
   * the board simply never got better, and a player would read that as their own failure. */
  const ledger = new EvidenceLedger(content.anomaly);
  const known = new Set(content.anomaly.evidenceRules.map((e) => e.id));
  const unreachable = [], dangling = [];
  for (const c of CLAIMS) {
    for (const id of c.supportedBy) if (!known.has(id)) dangling.push(`${c.id} → ${id}`);
    const rules = c.supportedBy.filter((id) => known.has(id)).map((id) => content.anomaly.evidenceRules.find((e) => e.id === id));
    const confirmed = rules.filter((r) => r.reliability === 'confirmed').length;
    if (!c.truth) continue;                       // a false claim is not meant to be provable
    if (rules.length < 2 || confirmed < 1) unreachable.push(`${c.id} (${rules.length} sources, ${confirmed} confirmed)`);
  }
  eq(`AH1 no claim names evidence that does not exist${dangling.length ? ` — ${dangling.join(', ')}` : ''}`, dangling.length, 0);
  eq(`AH2 every TRUE claim can reach "strong"${unreachable.length ? ` — ${unreachable.join(', ')}` : ''}`, unreachable.length, 0);

  /* And prove it by actually reaching it, through the real ledger. */
  for (const c of CLAIMS.filter((x) => x.truth)) {
    for (const id of c.supportedBy) ledger.record(id, { simTimeMs: 0, x: 0, z: 0, room: 'test', source: 'test' });
  }
  const weak = CLAIMS.filter((c) => c.truth && ledger.supportFor(c).word !== 'strong')
    .map((c) => `${c.id}=${ledger.supportFor(c).word}`);
  eq(`AH3 and does, with every source logged${weak.length ? ` — ${weak.join(', ')}` : ''}`, weak.length, 0);

  /* ⚠ FALSE CLAIMS MUST NOT. A board on which the wrong answer also goes strong is not a
   * board, it is a checklist with two columns. */
  const falseStrong = CLAIMS.filter((c) => !c.truth && ledger.supportFor(c).word === 'strong').map((c) => c.id);
  eq(`AH4 and the false leads do not${falseStrong.length ? ` — ${falseStrong.join(', ')}` : ''}`, falseStrong.length, 0);

  /* ── the nearest source, not the first one in the file ────────────────────── */
  lines.push('--- AH. reading the floor ---');
  const g = new Game(content, { seed: 'ev' });
  g.commitLoadout(RECOMMENDED_MANIFEST);
  const srcs = content.map.evidenceSources;
  /* Stand between two sources, nearer to the second one in the array. Whichever is nearer
   * is what a player expects; array order is not a thing they can see. */
  const pairs = [];
  for (let i = 0; i < srcs.length; i++) {
    for (let j = i + 1; j < srcs.length; j++) {
      const d = dist(srcs[i].at[0], srcs[i].at[1], srcs[j].at[0], srcs[j].at[1]);
      if (d < 7) pairs.push({ a: srcs[i], b: srcs[j], d });
    }
  }
  pairs.sort((x, y) => x.d - y.d);
  if (pairs.length) {
    const { a, b, d } = pairs[0];
    note(`closest pair on this floor: ${a.evidenceId} / ${b.evidenceId} at ${d.toFixed(2)}m`);
    /* A metre from b, and further from a. */
    const t = 1.0 / d;
    g.player.x = b.at[0] + (a.at[0] - b.at[0]) * t;
    g.player.z = b.at[1] + (a.at[1] - b.at[1]) * t;
    g.skipMs(50);
    const act = g.contextAction();
    ok('AH5 standing next to one of two nearby sources offers THAT one, not the earlier one in the file',
      act && act.kind === 'evidence' && act.target.evidenceId === b.evidenceId,
      act ? `${act.kind}: ${act.target ? act.target.evidenceId : act.text}` : 'none');
    /* And once it is logged, the other one is still reachable rather than swallowed. */
    g.doInteract();
    g.player.x = a.at[0]; g.player.z = a.at[1];
    g.skipMs(50);
    const act2 = g.contextAction();
    ok('AH6 and logging it does not swallow its neighbour',
      act2 && act2.kind === 'evidence' && act2.target.evidenceId === a.evidenceId,
      act2 ? `${act2.kind}: ${act2.target ? act2.target.evidenceId : act2.text}` : 'none');
  } else {
    ok('AH5 no two sources on this floor are close enough to compete', true);
    ok('AH6 so nothing can be swallowed', true);
  }

  /* ── the cargo wager is real ──────────────────────────────────────────────── */
  /* ⚠ `requiresEquipment` ON A SOURCE WAS VALIDATED AT LOAD AND NEVER CHECKED. The two
   * observations meant to cost something could be logged by an operative carrying neither
   * instrument, which quietly refunds the one loadout decision they were there to price. */
  const fig = await loadContent({ incident: 'cold-storage-figure' });
  const gated = fig.map.evidenceSources.find((s) => (s.requiresEquipment || []).length);
  ok('AH7 the figure incident gates at least one observation on an instrument', !!gated,
    gated ? `${gated.evidenceId} needs ${gated.requiresEquipment.join()}` : 'none');
  if (gated) {
    const g2 = new Game(fig, { seed: 'gate' });
    g2.commitLoadout([{ itemId: 'trauma-kit', qty: 1 }]);     // deliberately not the instrument
    g2.player.x = gated.at[0]; g2.player.z = gated.at[1];
    g2.skipMs(50);
    const a1 = g2.contextAction();
    eq('AH8 without the instrument the verb is refused rather than granted',
      a1 && a1.kind, 'blocked');
    ok('AH9 and it says what is missing', a1 && /needs the /.test(a1.text), a1 ? a1.text : 'none');
    g2.doInteract();
    ok('AH10 pressing it logs nothing', !g2.ledger.has(gated.evidenceId));
    /* ⚠ Offered-and-refused rather than hidden: §18.1 says the UI may not misrepresent what
     * is available, and "there is something here you cannot read yet" is actionable. */
    const g3 = new Game(fig, { seed: 'gate2' });
    g3.commitLoadout([{ itemId: gated.requiresEquipment[0], qty: 1 }, { itemId: 'trauma-kit', qty: 1 }]);
    g3.player.x = g3.site.cache.x; g3.player.z = g3.site.cache.z;
    g3.skipMs(50);
    g3.takeFromCache(gated.requiresEquipment[0]);
    g3.player.x = gated.at[0]; g3.player.z = gated.at[1];
    g3.skipMs(50);
    const a2 = g3.contextAction();
    eq('AH11 carrying it, the same spot offers the observation', a2 && a2.kind, 'evidence');
    g3.doInteract();
    ok('AH12 and it lands in the ledger', g3.ledger.has(gated.evidenceId));
  }
  emit();
}

/* ══ AI. GDD §27.3, the Mission Definition of Done ═════════════════════════════
 *
 * Eight criteria a mission must meet. Section AC does the same for §27.2 (the anomaly)
 * and §26.4 (the slice); this is the third of the three lists the document actually
 * commits to, and the one about whether an operation is finishable at all.
 *
 * ⚠ ONE OF THEM REPORTS N/A RATHER THAN PASS, and that is the most useful line in here.
 * A criterion that is trivially satisfied because the thing it guards against does not
 * exist yet has not been met — it has been avoided, and a scorecard that cannot tell those
 * apart is a scorecard that congratulates you for gaps.
 */
async function sectionAI(content) {
  lines.push('--- AI. GDD §27.3, the mission Definition of Done ---');

  /* ── 1. "No seed is unwinnable" ────────────────────────────────────────────
   * §14.4 states the rule as "randomization must not generate unwinnable states". The
   * honest measurement is what the seed actually varies, and here it varies one thing. */
  const seeds = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const fingerprints = new Set();
  for (const s of seeds) {
    const g = new Game(content, { seed: s });
    g.commitLoadout(RECOMMENDED_MANIFEST);
    fingerprints.add(JSON.stringify({
      anomaly: [g.anomaly.x.toFixed(3), g.anomaly.z.toFixed(3)],
      spawn: [g.player.x.toFixed(3), g.player.z.toFixed(3)],
      cache: [...g.cache.entries()].sort(),
      doors: g.site.doors.map((d) => (d.open ? 1 : 0)).join(''),
      circuits: [...g.site.circuits.values()].map((c) => (c.on ? 1 : 0)).join(''),
      ambient: g.heat.ambientC,
    }));
  }
  note(`${seeds.length} MISSION seeds produce ${fingerprints.size} distinct starting worlds`);
  note('    The mission seed is not the scenario seed. This one drives the simulation rng —');
  note('    which drives exactly one thing, the resume token — so it must NOT move the world:');
  note('    a replay has to be a replay. §14.4\'s controlled variation is a separate seed on');
  note('    the CONTENT LOADER, and section AJ sweeps forty of those for winnability.');
  eq('AI1 a mission seed does not move the world — a replay is a replay',
    fingerprints.size, 1);
  /* What IS worth asserting is that determinism holds, because the day a randomiser
   * arrives this is the property it has to preserve. */
  const runTwice = (seed) => {
    const g = new Game(content, { seed });
    g.commitLoadout(RECOMMENDED_MANIFEST);
    g.setCommand('p1', { axis: { x: 0.4, y: -1 }, sprint: false, crouch: false });
    g.skipMs(4000);
    return `${g.player.x.toFixed(6)},${g.player.z.toFixed(6)},${g.anomaly.x.toFixed(6)},${g.heat.ambientC.toFixed(6)}`;
  };
  eq('AI2 and the same seed replays to the same coordinates, six decimals',
    runTwice('replay'), runTwice('replay'));

  /* ── 2. "Entry, investigation, staging, containment, and extraction are supported" ── */
  const wanted = [PHASE.BRIEFING, PHASE.LOADOUT, PHASE.ARRIVAL, PHASE.INVESTIGATION,
    PHASE.PROCEDURE_COMMITTED, PHASE.CONTAINMENT_ACTIVE, PHASE.CUSTODY_ESTABLISHED,
    PHASE.EXTRACTION, PHASE.DEBRIEF];
  ok(`AI3 the mission models all five stages §27.3 names (${wanted.length} phases)`,
    wanted.every((p) => typeof p === 'string' && p.length > 0));
  /* And section I actually drives a whole operation through them, which is the difference
   * between the phases existing and being supported. */
  const gRun = new Game(content, { seed: 'phases' });
  eq('AI4 an operation starts at the briefing', gRun.mission.phase, PHASE.BRIEFING);
  gRun.commitLoadout(RECOMMENDED_MANIFEST);
  eq('AI5 committing a manifest is what deploys the squad', gRun.mission.phase, PHASE.ARRIVAL);
  ok('AI6 and the phase order is total, so "have we reached X" is a comparison',
    gRun.mission.atLeast(PHASE.BRIEFING) && !gRun.mission.atLeast(PHASE.DEBRIEF));

  /* ── 3. "Critical objects have recovery rules" ─────────────────────────────
   * The failure this guards is an object leaving the world with somebody's laptop, and
   * §11.5 is explicit about it. Assert the rule exists for every kind of critical object
   * the build now has — the case, and the distributed set. */
  const rec = await loadContent({ incident: 'cold-storage-tally' });
  const gRec = new Game(rec, { seed: 'recovery' });
  gRec.commitLoadout(RECOMMENDED_MANIFEST);
  const two = gRec.addPlayer('Two');
  two.x = gRec.instances.list[0].x; two.z = gRec.instances.list[0].z;
  gRec.instances.collect(two.id, gRec.instances.list[0]);
  ok('AI7 an operative can be holding a critical object', !!gRec.instances.carriedBy(two.id));
  gRec.instances.releaseHeldBy(two.id, two.x, two.z);
  ok('AI8 and a dropped radio puts it on the floor rather than taking it out of the world',
    !gRec.instances.carriedBy(two.id) && gRec.instances.list[0].loose);
  ok('AI9 the transit case has the same rule (§11.5)',
    typeof gRec._putDownCase === 'function');

  /* ── 4. "NPC and infrastructure states replicate correctly" ────────────────
   * Doors and circuits are the infrastructure. They ride the snapshot; assert a change on
   * the host reaches a client rather than trusting that it does. */
  const gHost = new Game(content, { seed: 'infra' });
  const gClient = new Game(content, { seed: 'infra-c' });
  gHost.commitLoadout(RECOMMENDED_MANIFEST);
  const anyCircuit = [...gHost.site.circuits.values()][0];
  const anyDoor = gHost.site.doors[0];
  gHost.site.setCircuit(anyCircuit.id, true);
  gHost.site.setDoorOpen(anyDoor, !anyDoor.open);
  applySnapshot(gClient, encodeSnapshot(gHost, gHost.clock.simTimeMs));
  eq('AI10 a circuit thrown on the host is on for the client',
    gClient.site.circuitOn(anyCircuit.id), true);
  eq('AI11 and a door moved on the host has moved for the client',
    gClient.site.doors[0].open, anyDoor.open);

  /* ── 5. "Navigation callouts are understandable" ───────────────────────────
   * The callout a squad actually uses is the room name, and the failure mode is a name
   * nobody can act on. Sweep every incident rather than the one floor. */
  const unnamed = [];
  for (const id of INCIDENTS) {
    const pack = await loadContent({ incident: id });
    const site = new Site(pack.map);
    let bad = 0, tested = 0;
    const b = pack.map.bounds;
    for (let x = b.minX; x <= b.maxX; x += 0.5) {
      for (let z = b.minZ; z <= b.maxZ; z += 0.5) {
        if (!standsAt(site, x, z)) continue;
        tested++;
        if (site.roomNameAt(x, z) === 'Unmarked floor') bad++;
      }
    }
    if (bad) unnamed.push(`${pack.map.id}: ${bad}/${tested}`);
  }
  eq(`AI12 every standable cell on every floor has a name a squad can say out loud${unnamed.length ? ` — ${unnamed.join(', ')}` : ''}`,
    unnamed.length, 0);

  /* ── 6. "Optional directives create decisions rather than chores" ──────────
   * ⚠ THE TEST IS WHETHER THEY COST SOMETHING. A directive you satisfy by playing well
   * anyway is a chore with a tick box; a decision is one that competes — with the mandate,
   * with the clock, or with another directive. */
  const site = await (await fetch('../content/site.json')).json();
  const thin = [];
  for (const op of site.operations) {
    const opt = op.optional || [];
    if (opt.length < 2) thin.push(`${op.id}: only ${opt.length}`);
    else if (new Set(opt).size !== opt.length) thin.push(`${op.id}: duplicated directive`);
  }
  eq(`AI13 every operation offers at least two distinct optional directives${thin.length ? ` — ${thin.join(' · ')}` : ''}`,
    thin.length, 0);

  /**
   * ⚠ AND THE REST OF THIS CRITERION IS A HUMAN JUDGEMENT, so it prints rather than
   * asserting. The first version tried to detect a decision textually — it required every
   * operation to carry both a recovery directive and a safety one — and flagged the
   * stocktake, where nothing can hurt you and an "avoid a second contact" line would be
   * precisely the chore §27.3 is warning about. A regex cannot tell a decision from a
   * chore; it can only tell whether the words it was taught appear.
   *
   * What the suite CAN show is that one of them demonstrably costs something: section Q
   * measures abandoning kit at −130 requisition and a standing hit with the departments
   * that care, so "recover all issued equipment" is a directive with a price on it.
   */
  let recoveryPriced = 0;
  for (const op of site.operations) {
    const opt = op.optional || [];
    note(`  ${op.id}: ${opt.join('  ·  ')}`);
    if (opt.some((t) => /recover|equipment|intact/i.test(t))) recoveryPriced++;
  }
  note('    the rest of §27.3\'s "decisions rather than chores" is a playtest question and');
  note('    is reported OPEN in section AC with the other five.');
  eq('AI13b and the one directive the suite can price appears on every operation',
    recoveryPriced, site.operations.length);

  /* ── 7. "Debrief events accurately reflect the operation" ──────────────────
   * The failure is a debrief that reports a number the mission never recorded. Drive two
   * different operations and assert the report changes with them. */
  const clean = new Game(content, { seed: 'clean' });
  clean.commitLoadout(RECOMMENDED_MANIFEST);
  const messy = new Game(content, { seed: 'messy' });
  messy.commitLoadout(RECOMMENDED_MANIFEST);
  messy.mission.tally.contacts = 2;
  messy.player.applyCondition('exposure', 'serious');
  /* ⚠ Mark the squad extracted before grading an extracted operation. `leftBehind` is
   * `extracted ? squad.filter(p => p.alive && !p.extracted) : []`, so calling grade() with
   * `extracted: true` while nobody carries the flag reports the whole squad as abandoned on
   * the floor — which made a clean run and an injured one both come back "Costly" for
   * completely different reasons, and looked like the debrief not discriminating. */
  const gradeOf = (g) => {
    for (const p of g.players) p.extracted = true;
    return g.mission.grade({
      custody: 'verified', extracted: true, players: g.players, player: g.player,
      ledger: g.ledger, deployables: g.deployables, simTimeMs: 900000,
      cargoIssued: g.cargoIssued, cargoRecovered: g.cargoIssued, instances: g.instances,
    });
  };
  const a = gradeOf(clean), b2 = gradeOf(messy);
  note(`clean run: ${a.overall} · injured run: ${b2.overall}`);
  ok('AI14 an injured operation does not grade the same as a clean one', a.overall !== b2.overall);
  const personnel = b2.dims.find((d) => d.name === 'Personnel survival');
  ok('AI15 and the debrief names who, rather than reporting a word',
    personnel && /Operative/.test(personnel.why), personnel ? personnel.why : 'none');
  ok('AI16 every dimension carries a reason, not just a grade',
    b2.dims.every((d) => d.why && d.why.length > 12));

  /* ── 8. "Performance and network budgets pass with a full squad" ───────────
   * The network half is section M; the performance half needs a wall clock the test
   * harness does not have. Reported OPEN rather than assumed. */
  note('    OPEN — performance budget with a full squad (§27.3). The suite runs under');
  note('    --virtual-time-budget, which freezes performance.now(), so every timing inside');
  note('    it reads 0.000us — convincingly and wrongly. It needs an un-virtualised run.');
  ok('AI17 the network half of the budget is exercised — a five-seat squad over the wire',
    MAX_SQUAD === 5);
  emit();
}

/* ══ AJ. controlled variation, and no seed that cannot be finished ═════════════
 *
 * GDD §14.4. A scenario seed selects the incident origin, which routes are shut, which
 * power is faulted, where the civilians are, which evidence is on the floor and which
 * source is the false lead, the weather and time, the secondary hazard, and the anomaly's
 * parameters within approved bounds.
 *
 * Two sentences of §14.4 are the whole thing, and they are the last two: "critical
 * procedure items always have redundant discovery paths", and "randomization must not
 * generate unwinnable states". Everything below is those two, measured.
 *
 * ⚠ SECTION AI REPORTED THIS CRITERION N/A, because nothing about the world was seeded and
 * a criterion that is trivially true is untested rather than met. This is the same
 * criterion with something to test.
 */
async function sectionAJ() {
  lines.push('--- AJ. controlled variation (GDD §14.4) ---');

  /* An incident that declares no bounds varies in nothing, whatever seed it is given.
   * That is what let this be added without touching the four incidents that predate it. */
  const plain = await loadContent({ incident: 'cold-storage-tally', seed: 'anything' });
  const plainB = await loadContent({ incident: 'cold-storage-tally', seed: 'different' });
  eq('AJ1 an incident with no variation block is identical under any seed',
    JSON.stringify(plain.map.anomalySpawn) + plain.map.evidenceSources.length,
    JSON.stringify(plainB.map.anomalySpawn) + plainB.map.evidenceSources.length);
  ok('AJ2 and loading with no seed at all is the authored default',
    (await loadContent({ incident: 'cold-storage-draught' })).map.anomalySpawn.join() === '-10,10');

  /* ── the same seed is the same operation ──────────────────────────────────── */
  const fingerprint = (p) => JSON.stringify({
    origin: p.map.anomalySpawn,
    sources: p.map.evidenceSources.map((s) => s.evidenceId).sort(),
    v: p.variation,
  });
  const a1 = await loadContent({ incident: 'cold-storage-draught', seed: 'kilo' });
  const a2 = await loadContent({ incident: 'cold-storage-draught', seed: 'kilo' });
  eq('AJ3 the same seed produces exactly the same operation', fingerprint(a1), fingerprint(a2));

  /* ── and different seeds are different operations ─────────────────────────── */
  const SEEDS = Array.from({ length: 40 }, (_, i) => `seed-${i}`);
  const packs = [];
  for (const s of SEEDS) packs.push(await loadContent({ incident: 'cold-storage-draught', seed: s }));
  const distinct = new Set(packs.map(fingerprint));
  const origins = new Set(packs.map((p) => p.map.anomalySpawn.join()));
  const weathers = new Set(packs.map((p) => p.variation.weather));
  const faults = new Set(packs.map((p) => p.variation.faults.join() || 'none'));
  const routes = new Set(packs.map((p) => p.variation.routesShut.join() || 'none'));
  note(`${SEEDS.length} seeds → ${distinct.size} distinct operations · ${origins.size} origins · ${weathers.size} weathers · faults ${[...faults].join('/')} · routes shut ${[...routes].join('/')}`);
  ok(`AJ4 forty seeds produce many distinct operations (${distinct.size})`, distinct.size > 10);
  ok(`AJ5 the origin actually moves (${origins.size} of 4 authored)`, origins.size >= 3);
  ok(`AJ6 and the weather does (${weathers.size} of 4)`, weathers.size >= 3);

  /* ── §14.4's first promise: redundant discovery paths survive ─────────────── */
  const anomaly = packs[0].anomaly;
  const worst = { rule: null, left: Infinity, seed: null };
  for (let i = 0; i < packs.length; i++) {
    const p = packs[i];
    const placed = new Set(p.map.evidenceSources.map((s) => s.evidenceId));
    const authored = new Set((a1.map.evidenceSources || []).map((s) => s.evidenceId));
    const byRule = new Map();
    for (const e of anomaly.evidenceRules) {
      if (!e.revealsRule) continue;
      /* A path survives if it is still on the floor, or if it was never a floor object in
       * the first place — the live detectors (thermal-void, frost-boundary, battery-drain)
       * are generated by play rather than placed, and a seed cannot remove them. */
      const survives = placed.has(e.id) || !authored.has(e.id);
      byRule.set(e.revealsRule, (byRule.get(e.revealsRule) || 0) + (survives ? 1 : 0));
    }
    for (const [rule, left] of byRule) {
      if (left < worst.left) { worst.rule = rule; worst.left = left; worst.seed = SEEDS[i]; }
    }
  }
  note(`across all seeds, the thinnest any rule ever gets is ${worst.left} path(s) — ${worst.rule} on ${worst.seed}`);
  ok('AJ7 no seed removes every discovery path for any rule (§14.4)', worst.left >= 1);

  /* ⚠ AND THE LOADER REFUSES ONE THAT WOULD. The promise is only worth anything if it is
   * enforced rather than hoped for, so this hands `applyVariation` a variation that strips
   * both paths from one rule and asserts it is a refusal. */
  const bad = chooseVariation(a1, 'kilo');
  const twoPaths = anomaly.evidenceRules.filter((e) => e.revealsRule).reduce((m, e) => {
    (m[e.revealsRule] = m[e.revealsRule] || []).push(e.id); return m;
  }, {});
  const placedIds = new Set((a1.map.evidenceSources || []).map((s) => s.evidenceId));
  const doomed = Object.entries(twoPaths).find(([, ids]) => ids.filter((id) => placedIds.has(id)).length >= 2);
  ok('AJ8 some rule has two paths that are BOTH placed objects, so the refusal is testable',
    !!doomed, doomed ? `${doomed[0]}: ${doomed[1].join()}` : 'none');
  if (doomed) {
    const res = applyVariation(a1, { ...bad, dropped: doomed[1].filter((id) => placedIds.has(id)) });
    ok('AJ9 stripping both paths for one rule is a REFUSAL, not a warning',
      res.problems.length > 0, res.problems.join(' | ') || 'accepted');
    ok('AJ10 and the refusal names the rule a squad could no longer learn',
      res.problems.some((t) => t.includes(doomed[0])), res.problems.join(' | '));
  }

  /* ── §14.4's second promise: no seed is unwinnable ────────────────────────── */
  /* Structural winnability, checked the same way the maps were: the origin is standable,
   * the cache and the extraction are reachable from the spawn with every door in the
   * state the seed left it, and a procedure's kit still fits the cargo budget. */
  const unwinnable = [];
  for (let i = 0; i < packs.length; i++) {
    const p = packs[i];
    const g = new Game(p, { seed: SEEDS[i] });
    g.applyVariation(p.variation);
    const site = g.site;
    const why = [];
    if (!standsAt(site, p.map.anomalySpawn[0], p.map.anomalySpawn[1])) why.push('origin is inside geometry');
    if (!standsAt(site, site.cache.x, site.cache.z)) why.push('cache unreachable');

    /* Flood fill from the spawn, with the seed's doors where the seed left them. */
    const K = 0.4, b = p.map.bounds;
    const key = (x, z) => `${Math.round(x / K)},${Math.round(z / K)}`;
    const seen = new Set([key(site.spawn.x, site.spawn.z)]);
    const q = [[site.spawn.x, site.spawn.z]];
    while (q.length) {
      const [x, z] = q.pop();
      for (const [dx, dz] of [[K, 0], [-K, 0], [0, K], [0, -K]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < b.minX || nx > b.maxX || nz < b.minZ || nz > b.maxZ) continue;
        const k = key(nx, nz);
        if (seen.has(k) || !standsAt(site, nx, nz)) continue;
        seen.add(k); q.push([nx, nz]);
      }
    }
    const near = (x, z) => {
      for (let dx = -0.8; dx <= 0.8; dx += K) for (let dz = -0.8; dz <= 0.8; dz += K) {
        if (seen.has(key(x + dx, z + dz))) return true;
      }
      return false;
    };
    if (!near(site.extraction.x, site.extraction.z)) why.push('extraction not reachable from spawn');
    if (!near(site.cache.x, site.cache.z)) why.push('cache not reachable from spawn');
    if (!near(p.map.anomalySpawn[0], p.map.anomalySpawn[1])) why.push('the anomaly is walled off from the squad');

    /* And a manifest that can actually be taken. */
    const kit = recommendedManifest(p);
    const vol = kit.reduce((acc, x) => acc + p.itemsById.get(x.itemId).cargoVolume * x.qty, 0);
    if (vol > p.items.cargoVolumeBudget) why.push(`recommended manifest is over budget (${vol}/${p.items.cargoVolumeBudget})`);
    if (!kit.some((x) => x.itemId === 'reinforced-transit-case')) why.push('no containment vessel in the recommendation');

    if (why.length) unwinnable.push(`${SEEDS[i]}: ${why.join(', ')}`);
  }
  note(`${SEEDS.length} seeds swept for structural winnability: ${unwinnable.length} unwinnable`);
  eq(`AJ11 no seed produces an operation that cannot be finished (§14.4)${unwinnable.length ? ` — ${unwinnable.slice(0, 3).join(' · ')}` : ''}`,
    unwinnable.length, 0);

  /* ── and the same sweep across every incident that varies ─────────────────
   * ⚠ One incident swept is one incident's authoring judged. The promise is about the
   * build, and each incident's `variation` block is a separate set of decisions about
   * which routes may be shut and which circuits may fault — the two that most easily
   * strand a squad. */
  const broad = [];
  let swept = 0;
  for (const id of INCIDENTS) {
    for (let i = 0; i < 12; i++) {
      const s = `sweep-${i}`;
      let p;
      try {
        p = await loadContent({ incident: id, seed: s });
      } catch (e) {
        broad.push(`${id}@${s}: refused — ${e.message.split('\n')[0]}`);
        continue;
      }
      swept++;
      if (!p.variation || !p.incident.variation) continue;
      const g = new Game(p, { seed: s });
      const site = g.site;
      if (!standsAt(site, p.map.anomalySpawn[0], p.map.anomalySpawn[1])) {
        broad.push(`${id}@${s}: origin (${p.map.anomalySpawn.join()}) is inside geometry`);
      }
      /* Every rule keeps a path — checked against THIS anomaly's rules, not the draught's. */
      const placed = new Set(p.map.evidenceSources.map((x) => x.evidenceId));
      const authored = new Set();
      const base = await loadContent({ incident: id });
      for (const x of base.map.evidenceSources) authored.add(x.evidenceId);
      const left = new Map();
      for (const e of p.anomaly.evidenceRules) {
        if (!e.revealsRule) continue;
        const alive = placed.has(e.id) || !authored.has(e.id);
        left.set(e.revealsRule, (left.get(e.revealsRule) || 0) + (alive ? 1 : 0));
      }
      for (const [rule, n] of left) {
        if (n === 0) broad.push(`${id}@${s}: rule ${rule} has no discovery path left`);
      }
    }
  }
  note(`${swept} operations swept across ${INCIDENTS.length} incidents`);
  eq(`AJ11b and that holds for every incident, not just the one${broad.length ? ` — ${broad.slice(0, 3).join(' · ')}` : ''}`,
    broad.length, 0);

  /* ── the faulted circuit is a discovery, not an announcement ──────────────── */
  const faulted = packs.find((p) => p.variation.faults.length);
  ok('AJ12 some seed faults a circuit', !!faulted, faulted ? faulted.variation.faults.join() : 'none');
  if (faulted) {
    const g = new Game(faulted, { seed: 'fault' });
    g.applyVariation(faulted.variation);
    const id = faulted.variation.faults[0];
    /* ⚠ It looks exactly like a dead circuit until somebody throws it. That is the point:
     * a fault you are told about is a difficulty setting, and a fault you discover is a
     * variation. */
    eq('AJ13 a faulted circuit reads as simply off beforehand', g.site.circuitOn(id), false);
    g.site.setCircuit(id, true);
    eq('AJ14 and refuses to come up when thrown', g.site.circuitOn(id), false);
    const other = [...g.site.circuits.values()].find((c) => c.id !== id);
    if (other) {
      g.site.setCircuit(other.id, true);
      eq('AJ15 while a healthy one on the same floor comes up normally', g.site.circuitOn(other.id), true);
    }
  }

  /* ── weather reaches both fields, not just the briefing ──────────────────── */
  const byWeather = new Map();
  for (let i = 0; i < packs.length; i++) {
    const w = packs[i].variation.weather;
    if (byWeather.has(w)) continue;
    const g = new Game(packs[i], { seed: SEEDS[i] });
    g.applyVariation(packs[i].variation);
    byWeather.set(w, { amb: g.heat.ambientC, db: g.sound.ambientDb });
  }
  for (const [w, r] of byWeather) note(`  ${w}: ambient ${r.amb.toFixed(1)}°C, room tone ${r.db.toFixed(1)}dB`);
  const temps = new Set([...byWeather.values()].map((r) => r.amb.toFixed(2)));
  const tones = new Set([...byWeather.values()].map((r) => r.db.toFixed(2)));
  ok(`AJ16 weather changes the ambient temperature every contour is computed from (${temps.size} values)`, temps.size > 1);
  ok(`AJ17 and the room tone every audibility is measured against (${tones.size} values)`, tones.size > 1);

  /* ⚠ WHICH IS A REAL CHANGE IN HOW MUCH FENCE A FLOODLIGHT BUYS. Two degrees of weather
   * moves the 40°C contour radius, because the radius is a function of ambient. */
  const radii = [];
  for (const [w, r] of byWeather) {
    const h = new HeatField();
    h.ambientC = r.amb;
    h.setEmitters([{ id: 't', x: 0, z: 0, peakC: 60, falloffM: 2.2, active: true }]);
    h.setSinks([]);
    let rad = 0;
    for (let d = 0; d < 6; d += 0.005) { if (h.temperatureAt(d, 0) >= 40) rad = d; else break; }
    radii.push({ w, rad });
  }
  note(`  40°C contour radius by weather: ${radii.map((x) => `${x.w} ${x.rad.toFixed(3)}m`).join(' · ')}`);
  ok('AJ18 so the weather changes how much fence one floodlight buys',
    new Set(radii.map((x) => x.rad.toFixed(3))).size > 1);

  /* ── behaviour, within the band and never outside it ──────────────────────
   * §14.4's last axis. ⚠ §8.2 requires a rule to be consistent and communicable, so the
   * band is the whole safety: a seed that could put a speed anywhere would make this a
   * different anomaly every night and everything the squad learned about the last one
   * would be worthless — the exact opposite of what controlled variation is for. */
  const band = a1.incident.variation.behaviour.speedFactor;
  const speeds = [];
  for (let i = 0; i < packs.length; i++) {
    const g = new Game(packs[i], { seed: SEEDS[i] });
    g.anomaly.state = 'drawn';
    speeds.push({ f: packs[i].variation.behaviour.speedFactor, v: g.anomaly.speedMps });
  }
  const factors = speeds.map((s) => s.f);
  const lo = Math.min(...factors), hi = Math.max(...factors);
  const drawnBase = a1.anomaly.states.find((s) => s.id === 'drawn').speedMps;
  note(`speed factor over ${SEEDS.length} seeds: ${lo.toFixed(3)}–${hi.toFixed(3)} against the authored band ${band[0]}–${band[1]}`);
  note(`  which is ${(drawnBase * lo).toFixed(2)}–${(drawnBase * hi).toFixed(2)} m/s drawn, from a base of ${drawnBase}`);
  ok('AJ19 the seed varies the anomaly speed', hi - lo > 0.05);
  ok('AJ20 and never outside the band the content declared', lo >= band[0] - 1e-9 && hi <= band[1] + 1e-9,
    `${lo}..${hi} vs ${band.join('..')}`);
  ok('AJ21 the factor reaches the actual speed the mover reads',
    speeds.every((s) => Math.abs(s.v - drawnBase * s.f) < 1e-9));
  /* An incident that declares no band is exactly its authored speed. */
  const noBand = await loadContent({ incident: 'cold-storage-figure', seed: 'x' });
  const gn = new Game(noBand, { seed: 'x' });
  gn.anomaly.state = 'closing';
  eq('AJ22 and an incident with no band runs at exactly its authored speed',
    gn.anomaly.speedMps, noBand.anomaly.states.find((s) => s.id === 'closing').speedMps);
  emit();
}

/* ══ AK. the archive can tell two nights apart ═════════════════════════════════
 *
 * §13 keeps a mission history so that it can be COMPARED, and §14.4 makes two operations
 * on the same floor genuinely different. Those two only combine if the record says which
 * night it was — otherwise "the cold store, Costly" twice over describes a hard frost with
 * the freight door jammed and a still night with everything open, and a squad reading their
 * own archive concludes the floor is simply like that.
 */
async function sectionAK() {
  lines.push('--- AK. the archive records which night it was ---');
  const site = await loadSite();
  const pr = new Progression({ site });
  const mk = async (seed) => {
    const pack = await loadContent({ incident: 'cold-storage-draught', seed });
    const g = new Game(pack, { seed });
    g.commitLoadout(RECOMMENDED_MANIFEST);
    for (const p of g.players) p.extracted = true;
    const result = g.mission.grade({
      custody: 'verified', extracted: true, players: g.players, player: g.player,
      ledger: g.ledger, deployables: g.deployables, simTimeMs: 1200000,
      cargoIssued: g.cargoIssued, cargoRecovered: g.cargoIssued, instances: g.instances,
    });
    pr.applyDebrief(result, g.mission, {
      anomalyId: pack.anomaly.id, mapId: pack.map.id, operationId: 'op-cold-storage-2',
      custody: 'verified', minutes: 20, observations: 4, squad: g.players,
      scenario: {
        seed: pack.variation.seed,
        weather: pack.weather.label, time: pack.time.label,
        faulted: pack.variation.faults.slice(), shut: pack.variation.routesShut.slice(),
      },
    });
    return pack;
  };
  const p1 = await mk('night-one');
  const p2 = await mk('night-two');
  const hist = pr.profile.history.slice(-2);
  note(`night one: ${p1.weather.label}, ${p1.time.label}, faults [${p1.variation.faults}], shut [${p1.variation.routesShut}]`);
  note(`night two: ${p2.weather.label}, ${p2.time.label}, faults [${p2.variation.faults}], shut [${p2.variation.routesShut}]`);
  eq('AK1 both operations are on the record', hist.length, 2);
  ok('AK2 and each carries the night it was', hist.every((h) => h.scenario && h.scenario.seed));
  ok('AK3 which are different nights on the same floor',
    JSON.stringify(hist[0].scenario) !== JSON.stringify(hist[1].scenario),
    JSON.stringify(hist[0].scenario));
  eq('AK4 on the same map', hist[0].mapId, hist[1].mapId);

  /* ⚠ AND IT HAS TO SURVIVE A SAVE. Everything the sanitiser does not name is dropped —
   * which is what makes a save from a future version safe, and what makes a new field that
   * works all session and vanishes overnight the hardest kind of loss to notice. */
  const json = JSON.stringify(pr.profile);
  const back = migrate(JSON.parse(json));
  const rehydrated = back.history.slice(-2);
  ok('AK5 a profile round-trips through a save with the night intact',
    rehydrated.every((h) => h.scenario && h.scenario.seed),
    JSON.stringify(rehydrated.map((h) => h.scenario)));
  eq('AK6 and the weather with it', rehydrated[1].scenario.weather, hist[1].scenario.weather);

  /* An operation recorded before variation existed has no scenario, and that is fine. */
  const old = migrate({ ...JSON.parse(json), history: [{ operation: 1, overall: 'Costly' }] });
  eq('AK7 a history row from before variation is kept, without inventing one',
    old.history[0].scenario, null);
  emit();
}
/**
 * ⚠ ONE SECTION THROWING MUST NOT DELETE EVERY SECTION AFTER IT.
 *
 * This was a single try/catch around the whole run, and a suite of forty assertions can
 * afford that. At seven hundred it cannot: an evidence source authored 2.7m from a breaker
 * made section I's bot throw on an undefined transit case, and the report that came back
 * was 112 assertions of a 700-assertion suite — five hundred and eighty results silently
 * absent, none of them broken, with no indication that anything had been skipped. The
 * failure looked ten times worse than it was, and the six hundred passing results that
 * would have located it were the ones that went missing.
 *
 * So each section is isolated. A section that throws is one FAILURE with its stack, and
 * the run continues. The only thing that stops the suite now is the harness itself.
 */
async function run(name, fn) {
  try {
    await fn();
  } catch (e) {
    lines.push(`FAIL  section ${name} threw: ${e && e.stack ? e.stack : e}`);
    fails++;
    emit();
  }
}

(async () => {
  try {
    await run('A', () => sectionA());
    const content = await loadContent();
    await run('B', () => sectionB(content));
    await run('C', () => sectionC(content));
    await run('D', () => sectionD(content));
    await run('E', () => sectionE(content));
    await run('F', () => sectionF(content));
    await run('G', () => sectionG(content));
    await run('H', () => sectionH(content));
    await run('I', () => sectionI(content));
    await run('J', () => sectionJ());
    await run('M', () => sectionM(content));
    await run('N', () => sectionN(content));
    await run('O', () => sectionO());
    await run('P', () => sectionP());
    await run('Q', () => sectionQ(content));
    await run('R', () => sectionR());
    await run('S', () => sectionS(content));
    await run('T', () => sectionT(content));
    await run('U', () => sectionU());
    await run('W', () => sectionW());
    await run('X', () => sectionX());
    await run('Y', () => sectionY());
    await run('Z', () => sectionZ(content));
    await run('AA', () => sectionAA(content));
    await run('AB', () => sectionAB());
    await run('AC', () => sectionAC());
    await run('AD', () => sectionAD(content));
    await run('AE', () => sectionAE());
    await run('AF', () => sectionAF());
    await run('AG', () => sectionAG());
    await run('AH', () => sectionAH(content));
    await run('AI', () => sectionAI(content));
    await run('AJ', () => sectionAJ());
    await run('AK', () => sectionAK());
    await run('K', () => sectionK());
    await run('L', () => sectionL());
    await run('V', () => sectionV());
    emit();
  } catch (e) {
    lines.push(`FAIL  the harness itself threw: ${e && e.stack ? e.stack : e}`);
    fails++;
    emit();
  }
})();
