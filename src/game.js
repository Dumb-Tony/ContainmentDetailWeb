/* The mission, assembled. Everything mutable lives here; every system is stepped from one
 * place, in one order, inside the clock's callback — so pausing is total by construction
 * and no system can forget to check a flag (the pattern from AirportBaggageCrew `Game.step`).
 *
 * STEP ORDER IS LOAD-BEARING and is asserted:
 *   1. rebuild the heat field  — emitters and the cold mass are re-read from the world, so
 *                                a flat battery stops fencing on the step it dies
 *   2. player                  — movement, then conditions
 *   3. power                   — batteries, after movement so proximity is this step's
 *   4. anomaly                 — reads the field built in 1
 *   5. custody, evidence, pressure, phase
 *
 * Rebuilding the field from scratch every step rather than mutating it is the same
 * decision as AirportBaggageCrew's per-step spatial grid: there is no stale-cell failure
 * mode, and at a dozen emitters it costs nothing.
 */

import { CONFIG, SLOTS } from './config.js';
import { GameClock } from './core/clock.js';
import { EventBus } from './core/eventBus.js';
import { Rng, hashStr } from './core/rng.js';
import { Site } from './sim/site.js';
import { HeatField } from './sim/heat.js';
import { DeployableSet } from './sim/deployables.js';
import { Anomaly, ANOMALY_STATE } from './sim/anomaly.js';
import { Player } from './sim/player.js';
import {
  EvidenceLedger, CLAIMS, sourceInReach, thermalVoidObserved,
  frostBoundaryObserved, batteryDrainObserved,
} from './sim/evidence.js';
import { Mission, PHASE } from './sim/mission.js';
import { dist } from './sim/geometry.js';

export const EVENTS = Object.freeze({
  PHASE_CHANGED: 'PHASE_CHANGED',
  ANOMALY_STATE_CHANGED: 'ANOMALY_STATE_CHANGED',
  EVIDENCE_LOGGED: 'EVIDENCE_LOGGED',
  CONTACT: 'CONTACT',
  DEPLOYED: 'DEPLOYED',
  RETRIEVED: 'RETRIEVED',
  CIRCUIT_CHANGED: 'CIRCUIT_CHANGED',
  DOOR_CHANGED: 'DOOR_CHANGED',
  SEAL_ATTEMPT: 'SEAL_ATTEMPT',
  CUSTODY_VERIFIED: 'CUSTODY_VERIFIED',
  CUSTODY_LOST: 'CUSTODY_LOST',
  BATTERY_DEAD: 'BATTERY_DEAD',
  MISSION_ENDED: 'MISSION_ENDED',
  NOTICE: 'NOTICE',
});

/** A defensible starting manifest. Not the only one that works — GDD Pillar 4 wants more
 *  than one defensible loadout, and the suite asserts that two different ones can finish. */
export const RECOMMENDED_MANIFEST = Object.freeze([
  { itemId: 'thermal-imager', qty: 1 },
  { itemId: 'floodlight-tripod', qty: 3 },
  { itemId: 'reinforced-transit-case', qty: 1 },
  { itemId: 'trauma-kit', qty: 1 },
  { itemId: 'motion-sensor', qty: 1 },
]);

export class Game {
  constructor(content, { seed = 'containment-detail' } = {}) {
    this.content = content;
    this.itemsById = content.itemsById;
    this.bus = new EventBus();
    this.clock = new GameClock({ stepMs: CONFIG.sim.stepMs, maxFrameMs: CONFIG.sim.maxFrameMs });
    this.rng = new Rng(hashStr(String(seed)), 'mission');
    this.seedLabel = String(seed);

    this.site = new Site(content.map);
    this.heat = new HeatField();
    this.deployables = new DeployableSet();
    this.anomaly = new Anomaly(content.anomaly, this.site, this.heat, this.deployables);
    this.player = new Player(this.site);
    this.ledger = new EvidenceLedger(content.anomaly);
    this.mission = new Mission();

    this.reset(seed);
  }

  reset(seed = this.seedLabel) {
    this.seedLabel = String(seed);
    this.rng.reset(hashStr(this.seedLabel));
    this.clock.reset();
    this.bus.clearLog();
    this.heat.reset();
    this.deployables.reset();
    this.anomaly.reset();
    this.player.reset();
    this.ledger.reset();
    this.mission.reset();

    /** itemId -> remaining count sitting in the cargo cache at the command point. */
    this.cache = new Map();
    this.cargoIssued = 0;
    this.imagerBatteryMs = (this.itemsById.get('thermal-imager').batteryMinutes || 0) * 60000;
    this.imagerOn = false;
    this.imagerHoldMs = 0;
    this.notices = [];
    this.result = null;
    this.custody = 'none';        // none | sealed | verified
    this.extracted = false;
  }

  /* ── phase B: the wager ──────────────────────────────────────────────────── */

  manifestVolume(manifest) {
    let v = 0;
    for (const { itemId, qty } of manifest) {
      const it = this.itemsById.get(itemId);
      if (it) v += it.cargoVolume * qty;
    }
    return v;
  }

  /**
   * Commit a cargo manifest and deploy. Refuses over budget — the budget IS the wager
   * (GDD §10.7), and a loadout screen that quietly allows one more tripod is not one.
   */
  commitLoadout(manifest) {
    const budget = this.content.items.cargoVolumeBudget;
    const vol = this.manifestVolume(manifest);
    if (vol > budget) return `Cargo over budget: ${vol} of ${budget}.`;
    this.cache.clear();
    this.cargoIssued = 0;
    for (const { itemId, qty } of manifest) {
      if (!this.itemsById.has(itemId) || qty <= 0) continue;
      this.cache.set(itemId, (this.cache.get(itemId) || 0) + qty);
      this.cargoIssued += qty;
    }
    /* Personal kit starts empty on purpose: the first thing every operation does is walk
     * to the vehicle and decide what to carry into the dark. */
    this.mission.setPhase(PHASE.ARRIVAL, this.clock.simTimeMs, `manifest ${vol}/${budget}`);
    this.bus.emit(EVENTS.PHASE_CHANGED, { phase: this.mission.phase });
    return null;
  }

  /* ── the step ────────────────────────────────────────────────────────────── */

  /** Real frames in, fixed steps out. main.js calls this and nothing else. */
  frame(nowMs) {
    const dt = this._lastFrameMs === undefined ? 0 : nowMs - this._lastFrameMs;
    this._lastFrameMs = nowMs;
    return this.clock.advance(dt, (stepMs, simTimeMs) => this.step(stepMs, simTimeMs));
  }

  /** Test hook: run forward without real frames. */
  skipMs(ms) { return this.clock.skipMs(ms, (s, t) => this.step(s, t)); }

  step(stepMs, simTimeMs) {
    const m = this.mission;
    if (m.phase === PHASE.BRIEFING || m.phase === PHASE.LOADOUT || m.phase === PHASE.DEBRIEF) return;

    /* 1. the field, rebuilt from the world */
    const emitters = this.deployables.heatEmitters();
    if (this.player.alive) emitters.push({ ...this.player.heatSource(), active: true });
    this.heat.setEmitters(emitters);
    const sink = this.anomaly.asSink();
    this.heat.setSinks(sink ? [sink] : []);
    this.heat.drift(stepMs, this.anomaly.isLoose);

    /* 2. the operative */
    const blockers = this.site.blockingRects().concat(this.deployables.blockingRects());
    const onIce = this.anomaly.iceAt(this.player.x, this.player.z);
    if (this.player.alive) {
      this.player.step(stepMs, this._axis || { x: 0, y: 0 }, blockers, { onIce });
      this.player.stepStress(stepMs, {
        lightLevel: this.lightAt(this.player.x, this.player.z),
        anomalyDistance: dist(this.player.x, this.player.z, this.anomaly.x, this.anomaly.z),
        anomalyLoose: this.anomaly.isLoose,
      });
    }

    /* 3. power. Batteries after movement so "in range of the draught" is this step's truth. */
    const before = this.deployables.list.map((d) => d.hasPower);
    this.deployables.stepPower(stepMs, this.anomaly);
    this.deployables.list.forEach((d, i) => {
      if (before[i] && !d.hasPower) this.bus.emit(EVENTS.BATTERY_DEAD, { itemId: d.itemId, uid: d.uid }, simTimeMs);
    });
    if (this.imagerOn) {
      this.imagerBatteryMs = Math.max(0, this.imagerBatteryMs - stepMs *
        (this.anomaly.isAwake && dist(this.player.x, this.player.z, this.anomaly.x, this.anomaly.z) <= CONFIG.anomaly.batteryDrainRadiusM
          ? CONFIG.anomaly.batteryDrainMultiplier : 1));
      if (this.imagerBatteryMs === 0) { this.imagerOn = false; this.notice('The imager screen goes dark. Battery flat.'); }
    }

    /* 4. the anomaly, reading the field built in step 1 */
    const sources = [];
    if (this.player.alive) sources.push({ id: 'operative', x: this.player.x, z: this.player.z, peakC: CONFIG.player.bodyHeatC });
    for (const d of this.deployables.list) {
      if (d.isEmitter && d.active) sources.push({ id: d.uid, x: d.x, z: d.z, peakC: d.item.heatOutputCelsius });
    }
    const prevState = this.anomaly.state;
    const res = this.anomaly.step(stepMs, simTimeMs, {
      sources, operatives: this.player.alive ? [this.player] : [], pressureStage: m.stage,
    });
    if (this.anomaly.state !== prevState) {
      const t = this.anomaly.transitions[this.anomaly.transitions.length - 1];
      m.applyPressureDelta(t ? t.pressureDelta : 0);
      this.bus.emit(EVENTS.ANOMALY_STATE_CHANGED, { from: prevState, to: this.anomaly.state, trigger: t && t.triggerId }, simTimeMs);
      if (t && t.telegraph) this.notice(t.telegraph);
    }
    for (const c of res.contacts) {
      m.tally.contacts++;
      for (const a of c.applies) this.player.applyCondition(a.condition, a.severity);
      this.bus.emit(EVENTS.CONTACT, { count: c.count }, simTimeMs);
      this.notice(c.count === 1
        ? 'Contact. The cold goes through you and your leg stops answering.'
        : 'Second contact. You are not going to survive a third.');
      if (!this.player.alive) this.endMission('Operative lost to repeated exposure.', simTimeMs);
    }

    /* 5. custody, evidence, pressure, phase */
    const cust = this.anomaly.stepCustody(stepMs, simTimeMs);
    if (cust.lost) {
      this.custody = 'none';
      m.tally.custodyLosses++;
      this.bus.emit(EVENTS.CUSTODY_LOST, {}, simTimeMs);
      this.notice('The heater cycle lengthens, then stops. Frost walks out of the seams.');
    } else if (cust.verified && this.custody !== 'verified') {
      this.custody = 'verified';
      m.setPhase(PHASE.CUSTODY_ESTABLISHED, simTimeMs);
      this.bus.emit(EVENTS.CUSTODY_VERIFIED, {}, simTimeMs);
      this.notice('Case interior stable for thirty seconds. Custody verified — get it to the stairs.');
    }

    this._stepEvidence(stepMs, simTimeMs);

    m.stepPressure(stepMs, {
      anomalyLoose: this.anomaly.isLoose,
      anomalyAwake: this.anomaly.isAwake,
      operativeDistance: dist(this.player.x, this.player.z, this.anomaly.x, this.anomaly.z),
      activeEmitters: this.deployables.list.filter((d) => d.isEmitter && d.active).length,
    });

    /* Arrival ends when the squad leaves the command point, not after N metres of
     * walking — otherwise pacing back and forth at the vehicle counts as investigating. */
    if (m.phase === PHASE.ARRIVAL && dist(this.player.x, this.player.z, this.site.cache.x, this.site.cache.z) > 6) {
      m.setPhase(PHASE.INVESTIGATION, simTimeMs);
      this.bus.emit(EVENTS.PHASE_CHANGED, { phase: m.phase }, simTimeMs);
    }
    if (m.phase !== PHASE.EXTRACTION && this.custody === 'verified' && this.player.hands) {
      m.setPhase(PHASE.EXTRACTION, simTimeMs);
      this.bus.emit(EVENTS.PHASE_CHANGED, { phase: m.phase }, simTimeMs);
    }

    /* Extraction: custody is not complete until the payload reaches transfer (§6.1 G). */
    if (this.site.inExtraction(this.player.x, this.player.z) && this.player.hands === 'reinforced-transit-case' && this.custody === 'verified') {
      this.extracted = true;
      this.endMission(null, simTimeMs);
    }

    if (m.stage >= 4 && m.pressure >= CONFIG.pressure.max) {
      this.endMission('Incident breach. The floor was lost before the squad established custody.', simTimeMs);
    }
    if (simTimeMs >= CONFIG.sim.missionLimitMs) {
      this.endMission('Operation ran past its window. Recalled.', simTimeMs);
    }
  }

  _stepEvidence(stepMs, simTimeMs) {
    const p = this.player;
    const prov = () => ({
      simTimeMs, x: p.x, z: p.z, room: this.site.roomNameAt(p.x, p.z),
      source: 'operative', integrity: 'clean',
    });

    if (this.imagerOn && this.anomaly.isLoose && dist(p.x, p.z, this.anomaly.x, this.anomaly.z) <= 16) {
      this.imagerHoldMs += stepMs;
    } else this.imagerHoldMs = 0;

    if (thermalVoidObserved(this.imagerOn, this.anomaly, p, this.imagerHoldMs)) {
      this._log('thermal-void', { ...prov(), source: 'thermal-imager' });
    }
    if (frostBoundaryObserved(this.anomaly, p)) this._log('frost-boundary', prov());
    if (batteryDrainObserved(this.deployables, this.anomaly)) this._log('battery-drain', prov());
  }

  _log(evidenceId, provenance) {
    const e = this.ledger.record(evidenceId, provenance);
    if (e) {
      this.bus.emit(EVENTS.EVIDENCE_LOGGED, { entry: e }, provenance.simTimeMs);
      this.notice(`Logged: ${e.raw}`);
    }
    return e;
  }

  /* ── interaction ─────────────────────────────────────────────────────────── */

  /**
   * ONE resolver for the context verb, so the prompt the HUD shows and the action the key
   * performs cannot disagree. (The lesson recorded against SmallTownEmergencyServices
   * `contextPrompt`/`doInteract` in Dev\INDEX.md.)
   *
   * ⚠ NEAREST WINS, not a fixed category order. A category order looks tidy and is wrong:
   * standing at the office desk with the transit case set down a metre away, a
   * deployables-first order offers "retrieve the case" while the player is plainly
   * reading the plant log, and one keypress undoes the procedure. The only thing that
   * jumps the queue is the seal, because when the seal is available nothing else matters.
   *
   * @returns {{kind:string, text:string, target?:any}|null}
   */
  contextAction() {
    const p = this.player;
    if (!p.alive) return null;
    const reach = CONFIG.player.reachMetres;

    if (p.hands) return { kind: 'put-down', text: `Put down the ${this.itemsById.get(p.hands).displayName}` };

    /* The seal comes first: when it is available it is the only thing that matters. */
    const caseDep = this.deployables.byItem('reinforced-transit-case')
      .find((d) => !d.sealed && dist(p.x, p.z, d.x, d.z) <= reach);
    if (caseDep && this.anomaly.state === ANOMALY_STATE.BANKED
      && dist(this.anomaly.x, this.anomaly.z, caseDep.x, caseDep.z) <= 1.5) {
      return { kind: 'seal', text: 'SEAL THE CASE', target: caseDep };
    }

    const cands = [];
    const dep = this.deployables.nearest(p.x, p.z, reach);
    if (dep) {
      const d = dist(p.x, p.z, dep.x, dep.z);
      if (dep.sealed && this.custody === 'verified') cands.push({ d, kind: 'carry-case', text: 'Lift the transit case', target: dep });
      else if (dep.sealed) cands.push({ d, kind: 'blocked', text: 'Custody unverified — the case must hold thirty seconds', target: dep });
      else cands.push({ d, kind: 'retrieve', text: `Retrieve the ${dep.item.displayName}`, target: dep });
    }

    const sw = this.site.circuitSwitchNear(p.x, p.z, reach);
    if (sw) cands.push({ d: dist(p.x, p.z, sw.switchX, sw.switchZ), kind: 'circuit', text: `${sw.on ? 'Kill' : 'Throw'} the ${sw.displayName.toLowerCase()}`, target: sw });

    const door = this.site.doorNear(p.x, p.z, reach + 0.4);
    if (door) {
      const d = dist(p.x, p.z, (door.rect[0] + door.rect[2]) / 2, (door.rect[1] + door.rect[3]) / 2);
      if (!this.site.canOperateDoor(door)) cands.push({ d, kind: 'blocked', text: `${door.displayName} — no power on this circuit`, target: door });
      else cands.push({ d, kind: 'door', text: `${door.open ? 'Close' : 'Open'} the ${door.displayName.toLowerCase()}`, target: door });
    }

    const src = sourceInReach(this.site, p.x, p.z, reach + 0.6);
    if (src && !this.ledger.has(src.evidenceId)) {
      cands.push({ d: dist(p.x, p.z, src.at[0], src.at[1]), kind: 'evidence', text: src.prompt, target: src });
    }

    const dCache = dist(p.x, p.z, this.site.cache.x, this.site.cache.z);
    if (dCache <= reach + 1.0) cands.push({ d: dCache, kind: 'cache', text: 'Open the cargo manifest', target: null });

    if (!cands.length) return null;
    cands.sort((a, b) => a.d - b.d);
    return cands[0];
  }

  doInteract() {
    const a = this.contextAction();
    if (!a) return 'Nothing in reach.';
    const t = this.clock.simTimeMs;
    switch (a.kind) {
      case 'seal': {
        this.mission.tally.sealAttempts++;
        const err = this.anomaly.trySeal(a.target, t);
        this.bus.emit(EVENTS.SEAL_ATTEMPT, { ok: !err, err }, t);
        if (err) { this.notice(err); return err; }
        this.custody = 'sealed';
        this.mission.setPhase(PHASE.CONTAINMENT_ACTIVE, t);
        this.notice('Latches over. The case seams frost as the load transfers. Hold it.');
        return null;
      }
      case 'carry-case':
        this.player.hands = a.target.itemId;
        this._carriedCase = a.target;
        this.deployables.remove(a.target);
        this.notice('You have it. It is heavier than it looks and it is still cold.');
        return null;
      case 'put-down': {
        const item = this.itemsById.get(this.player.hands);
        const d = this.deployables.place(item, this.player.x, this.player.z, this.player.yaw);
        if (this._carriedCase) { d.sealed = this._carriedCase.sealed; d.custodyHeldMs = this._carriedCase.custodyHeldMs; d.batteryMs = this._carriedCase.batteryMs; this.anomaly.sealedIn = d; this._carriedCase = null; }
        this.player.hands = null;
        return null;
      }
      case 'retrieve': {
        const item = a.target.item;
        if (!this.player.take(item)) { this.notice('No slot free for that.'); return 'No slot free.'; }
        this.deployables.remove(a.target);
        this.bus.emit(EVENTS.RETRIEVED, { itemId: item.id }, t);
        return null;
      }
      case 'circuit': {
        this.site.setCircuit(a.target.id, !a.target.on);
        if (a.target.on) this.mission.tally.circuitsRestored++;
        this.bus.emit(EVENTS.CIRCUIT_CHANGED, { id: a.target.id, on: a.target.on }, t);
        this.notice(a.target.on ? `${a.target.displayName} live.` : `${a.target.displayName} dead.`);
        return null;
      }
      case 'door': {
        this.site.setDoorOpen(a.target, !a.target.open);
        if (a.target.open) this.mission.tally.doorsOpened++;
        this.bus.emit(EVENTS.DOOR_CHANGED, { id: a.target.id, open: a.target.open }, t);
        return null;
      }
      case 'evidence':
        this._log(a.target.evidenceId, {
          simTimeMs: t, x: this.player.x, z: this.player.z,
          room: this.site.roomNameAt(this.player.x, this.player.z),
          source: 'operative', integrity: 'clean',
        });
        return null;
      case 'cache':
        return 'OPEN_CACHE';
      default:
        this.notice(a.text);
        return a.text;
    }
  }

  /** Take one unit of an item from the cargo cache into a slot. */
  takeFromCache(itemId) {
    const n = this.cache.get(itemId) || 0;
    if (n <= 0) return 'None left in cargo.';
    if (dist(this.player.x, this.player.z, this.site.cache.x, this.site.cache.z) > CONFIG.player.reachMetres + 1.2) {
      return 'Too far from the cargo point.';
    }
    const item = this.itemsById.get(itemId);
    if (!this.player.take(item)) return `No free slot takes a ${item.bulk} item.`;
    this.cache.set(itemId, n - 1);
    return null;
  }

  /** Put the held item back into cargo. Recoverable mistakes, GDD Pillar 4. */
  returnToCache() {
    const id = this.player.heldItemId;
    if (!id) return 'Nothing in hand.';
    if (dist(this.player.x, this.player.z, this.site.cache.x, this.site.cache.z) > CONFIG.player.reachMetres + 1.2) {
      return 'Too far from the cargo point.';
    }
    this.player.drop(this.player.heldSlot);
    this.cache.set(id, (this.cache.get(id) || 0) + 1);
    return null;
  }

  /** Deploy the held item where the operative is standing. */
  deployHeld() {
    const id = this.player.heldItemId;
    if (!id) return 'Nothing in hand.';
    const item = this.itemsById.get(id);
    if (!item.deployable) return `The ${item.displayName.toLowerCase()} is not something you set down.`;
    /* Refuse a placement inside geometry rather than letting it clip — a fence post inside
     * a wall is a fence post the player thinks they have. */
    const p = this.player;
    const fx = p.x - Math.sin(p.yaw) * 0.9, fz = p.z - Math.cos(p.yaw) * 0.9;
    for (const r of this.site.blockingRects()) {
      if (fx > r[0] - 0.2 && fx < r[2] + 0.2 && fz > r[1] - 0.2 && fz < r[3] + 0.2) return 'No room to set that down here.';
    }
    this.player.drop(this.player.heldSlot);
    const d = this.deployables.place(item, fx, fz, p.yaw);
    this.mission.tally.deployablesPlaced++;
    this.bus.emit(EVENTS.DEPLOYED, { itemId: id, uid: d.uid }, this.clock.simTimeMs);
    return null;
  }

  /** The imager is a held instrument, not a mode: it costs a hand and a battery. */
  toggleImager() {
    if (!this.player.carrying('thermal-imager')) return 'You did not bring the imager.';
    if (this.imagerBatteryMs <= 0) return 'The imager battery is flat.';
    this.imagerOn = !this.imagerOn;
    return null;
  }

  useHeld() {
    const id = this.player.heldItemId;
    if (id === 'thermal-imager') return this.toggleImager();
    if (id === 'trauma-kit') {
      if (!this.player.treat()) return 'Nothing to stabilise.';
      this.player.drop(this.player.heldSlot);
      this.mission.tally.treatments++;
      this.notice('Stabilised. It will not get worse; it is not going to get better here either.');
      return null;
    }
    if (id === 'sample-kit') {
      if (!this.anomaly.icePatches.length && this.anomaly.state !== ANOMALY_STATE.BANKED) return 'No frost worth taking.';
      this.notice('Frost sample sealed. Research will want this.');
      this.player.drop(this.player.heldSlot);
      return null;
    }
    if (id) return this.deployHeld();
    return 'Nothing in hand.';
  }

  /* ── the procedure card ──────────────────────────────────────────────────── */

  /**
   * Commit a plan (GDD §18.4, five fields). It is NOT validated for correctness — the
   * planner does not know the answer either, and a planner that refused a wrong plan
   * would be doing the deduction the game exists to make the player do.
   */
  commitProcedure(card) {
    this.mission.procedure = { ...card, committedMs: this.clock.simTimeMs };
    this.mission.procedureCommittedMs = this.clock.simTimeMs;
    this.mission.setPhase(PHASE.PROCEDURE_COMMITTED, this.clock.simTimeMs);
    this.bus.emit(EVENTS.PHASE_CHANGED, { phase: this.mission.phase }, this.clock.simTimeMs);
    return null;
  }

  abortProcedure() {
    this.mission.abortCount++;
    this.mission.setPhase(PHASE.INVESTIGATION, this.clock.simTimeMs, 'aborted');
    this.notice('Procedure aborted. Back off and re-plan.');
  }

  /* ── odds and ends ───────────────────────────────────────────────────────── */

  lightAt(x, z) {
    let l = this.site.mainsLightAt(x, z);
    for (const d of this.deployables.list) {
      if (d.itemId !== 'floodlight-tripod' || !d.active) continue;
      const dd = dist(x, z, d.x, d.z);
      l = Math.max(l, Math.max(0, 1 - (dd / 6.5) ** 2));
    }
    return Math.min(1, l);
  }

  notice(text) {
    this.notices.push({ text, atMs: this.clock.simTimeMs });
    if (this.notices.length > 40) this.notices.shift();
    this.bus.emit(EVENTS.NOTICE, { text }, this.clock.simTimeMs);
  }

  recentNotices(n = 4, windowMs = 9000) {
    const t = this.clock.simTimeMs;
    return this.notices.filter((x) => t - x.atMs < windowMs).slice(-n);
  }

  endMission(failReason, simTimeMs) {
    if (this.result) return this.result;
    this.mission.failReason = failReason;
    this.mission.endedMs = simTimeMs;
    const cargoRecovered = Array.from(this.cache.values()).reduce((a, b) => a + b, 0)
      + Array.from(this.player.slots.values()).filter(Boolean).length
      + (this.player.hands ? 1 : 0);
    this.mission.tally.deployablesLost = this.deployables.list.length;
    this.result = this.mission.grade({
      custody: this.custody, extracted: this.extracted, player: this.player,
      ledger: this.ledger, deployables: this.deployables, simTimeMs,
      cargoIssued: this.cargoIssued, cargoRecovered,
    });
    this.result.failReason = failReason;
    this.mission.setPhase(PHASE.DEBRIEF, simTimeMs);
    this.bus.emit(EVENTS.MISSION_ENDED, { result: this.result }, simTimeMs);
    return this.result;
  }

  /** main.js writes the movement axis here once per frame; the sim reads it per step. */
  setAxis(axis) { this._axis = axis; }
}

export { PHASE, ANOMALY_STATE, CLAIMS, SLOTS };
