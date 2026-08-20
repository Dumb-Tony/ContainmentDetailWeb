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
import { observedBy, operativeViewer, cameraViewer } from './sim/perception.js';
import { PingBoard, requestPing } from './sim/comms.js';
import { InstanceSet } from './sim/instances.js';
import { dist } from './sim/geometry.js';

/** A command is what one operative is asking for this step, whoever is asking. */
export const EMPTY_COMMAND = Object.freeze({
  axis: { x: 0, y: 0 }, sprint: false, crouch: false,
});

export const EVENTS = Object.freeze({
  PHASE_CHANGED: 'PHASE_CHANGED',
  SQUAD_CHANGED: 'SQUAD_CHANGED',
  OPERATIVE_DOWNED: 'OPERATIVE_DOWNED',
  OPERATIVE_REVIVED: 'OPERATIVE_REVIVED',
  OPERATIVE_LOST: 'OPERATIVE_LOST',
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
  INSTANCE_COLLECTED: 'INSTANCE_COLLECTED',
  INSTANCE_LOGGED: 'INSTANCE_LOGGED',
  SET_PURGED: 'SET_PURGED',
  NOTICE: 'NOTICE',
});

/** A defensible starting manifest for the cold-storage draught. Not the only one that
 *  works — GDD Pillar 4 wants more than one defensible loadout, and the suite asserts that
 *  two different ones can finish. Kept as the fallback and as the suite's fixed baseline. */
export const RECOMMENDED_MANIFEST = Object.freeze([
  { itemId: 'thermal-imager', qty: 1 },
  { itemId: 'floodlight-tripod', qty: 3 },
  { itemId: 'reinforced-transit-case', qty: 1 },
  { itemId: 'trauma-kit', qty: 1 },
  { itemId: 'motion-sensor', qty: 1 },
]);

/**
 * What to put in the van for THIS incident, derived from the anomaly's own safe-grade
 * procedure rather than hard-coded.
 *
 * ⚠ A CONSTANT HERE WAS A BUG WAITING FOR THE SECOND ANOMALY. The recommended manifest
 * was the draught's kit — three floodlight tripods and an imager — and it would have been
 * offered, unchanged, to a squad deploying against something that cannot be fenced and
 * reads at ambient on thermal. The button says "recommended"; it has to mean it.
 *
 * It reads the SAFE procedure, not the minimum: the minimum is what you can get away with,
 * and a manifest screen that opens on "what you can get away with" is not a recommendation.
 * Quantities are the wager and stay the player's (GDD §10.7) — this only decides what is
 * worth having one of, plus a spare fence post or camera because one is never enough.
 */
export function recommendedManifest(content) {
  const safe = (content.anomaly.containment.procedures.find((p) => p.grade === 'safe')
    || content.anomaly.containment.procedures[0]);
  if (!safe) return RECOMMENDED_MANIFEST.slice();

  const spares = { 'floodlight-tripod': 3, 'portable-heater': 2, 'remote-camera': 3, 'portable-barrier': 2 };
  const out = safe.requiredEquipment
    .filter((id) => content.itemsById.has(id))
    .map((id) => ({ itemId: id, qty: spares[id] || 1 }));

  /* Medical is never on a containment procedure's list and is always worth the volume. */
  if (!out.some((x) => x.itemId === 'trauma-kit')) out.push({ itemId: 'trauma-kit', qty: 1 });

  /* Trim to the cargo budget, cheapest-first, so the default always deploys. */
  const budget = content.items.cargoVolumeBudget;
  const vol = (list) => list.reduce((a, x) => a + content.itemsById.get(x.itemId).cargoVolume * x.qty, 0);
  while (vol(out) > budget) {
    const fat = out.filter((x) => x.qty > 1).sort((a, b) => b.qty - a.qty)[0];
    if (fat) fat.qty--; else { out.pop(); }
    if (!out.length) break;
  }
  return out;
}

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
    this.ledger = new EvidenceLedger(content.anomaly);
    this.mission = new Mission();

    /**
     * THE SQUAD IS A LIST, AND `player` IS THE SAME OBJECT AS `players[0]` — not a copy.
     * Taken from SmallTownEmergencyServices `createInitialState` (Dev/INDEX.md → local
     * co-op): it keeps every single-player call site working and, because it is an alias
     * rather than a duplicate, the two cannot drift apart the way a copy silently would.
     *
     * Every operative — local, second-on-the-couch, or on another continent — is driven
     * by a COMMAND in `this.commands`. From `step()` down, the simulation cannot tell
     * which is which, and that is the whole reason netcode is a seam here rather than a
     * rewrite.
     */
    this.players = [];
    this.player = null;
    this.commands = new Map();

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
    this.ledger.reset();
    this.mission.reset();

    this.players.length = 0;
    this.commands.clear();
    this.players.push(new Player(this.site, 'p1', 'Operative 1'));
    this.localId = this.localId || 'p1';
    this.player = this.players[0];
    this._nextPlayerN = 2;

    /** itemId -> remaining count sitting in the cargo cache at the command point. */
    this.cache = new Map();
    this.cargoIssued = 0;
    /** Batteries follow the ITEM, not the carrier — hand the imager over and its charge
     *  goes with it, which is the only behaviour a squad can reason about. */
    this.itemBattery = new Map();
    this.imagerHold = new Map();   // playerId -> ms the mass has been held in view
    this.imagerOnIds = new Set();
    /** playerId -> the custody state of the case in their hands, so putting it down (or
     *  dropping it because they went down) restores exactly what they picked up. */
    this._carried = new Map();
    this.notices = [];
    /* GDD §11.3, the squad's channel — and deliberately the NON-VOICE one first. §19.2
     * says no required rule may depend on a microphone or on stereo hearing, so the
     * primary way a squad talks has to be something a player with neither can use to run
     * a whole operation. It is host state, like the notices above it. */
    this.comms = new PingBoard();
    /* The distributed-object family (GDD §26.2). Empty for an incident that does not use
     * one, which costs nothing: an empty set contributes no sinks and offers no verbs. */
    this.instances = new InstanceSet();
    const inst = this.content.map.instanceSites || [];
    if (inst.length) {
      const pres = (this.content.anomaly.presence && this.content.anomaly.presence.instances) || {};
      this.instances.reset(inst, {
        chillC: pres.chillCelsius,
        falloffM: pres.falloffMetres,
        depositRadiusM: pres.depositRadiusMetres,
        reachM: CONFIG.player.reachMetres,
      });
    }
    /** Private to this machine. A snapshot replaces `notices` and never touches these. */
    this.localNotices = [];
    this.result = null;
    this.custody = 'none';        // none | sealed | verified
    this.observation = { observed: false, by: [], count: 0 };
    this.viewers = [];
    this.extracted = false;
  }

  /* ── the squad ───────────────────────────────────────────────────────────── */

  playerById(id) { return this.players.find((p) => p.id === id) || null; }

  /**
   * Whose eyes the renderer and the HUD are behind. On the host that is operative one; on
   * a client it is whichever seat the host handed them. Everything presentational reads
   * THIS rather than `player`, so the same renderer serves both without a branch.
   */
  get viewPlayer() { return this.playerById(this.localId) || this.players[0]; }

  /** @returns {Player} */
  addPlayer(name) {
    const id = `p${this._nextPlayerN++}`;
    const p = new Player(this.site, id, name || `Operative ${this.players.length + 1}`);
    this.players.push(p);
    this.bus.emit(EVENTS.SQUAD_CHANGED, { id, joined: true }, this.clock.simTimeMs);
    return p;
  }

  /**
   * Take an operative off the roster entirely (they said goodbye, rather than dropping).
   *
   * GDD §11.5: "intentional departure transfers unique mission items to a recoverable
   * field crate". Nothing they were holding may vanish with them, because some of it is
   * the only one on the floor and the operation cannot be finished without it.
   */
  removePlayer(id) {
    const i = this.players.findIndex((p) => p.id === id);
    if (i <= 0) return false;          // p1 is the host's own operative and never leaves
    const p = this.players[i];
    this._returnEverything(p);
    this.players.splice(i, 1);
    this.commands.delete(id);
    this.comms.retire(id);
    this.imagerOnIds.delete(id);
    this.imagerHold.delete(id);
    this.bus.emit(EVENTS.SQUAD_CHANGED, { id, joined: false }, this.clock.simTimeMs);
    return true;
  }

  /** Everything in their slots and hands goes back to the cargo point, recoverable. */
  _returnEverything(p) {
    for (const slot of SLOTS) {
      const itemId = p.slots.get(slot.id);
      if (!itemId) continue;
      p.slots.set(slot.id, null);
      this.cache.set(itemId, (this.cache.get(itemId) || 0) + 1);
    }
    if (p.hands) {
      /* A SEALED case is not cargo — putting custody in a crate at the far end of the
       * floor would be a quiet mission failure. It goes down where they stood. */
      if (p.hands === 'reinforced-transit-case' && this._carried.get(p.id)) {
        this._putDownCase(p);
      } else {
        this.cache.set(p.hands, (this.cache.get(p.hands) || 0) + 1);
        p.hands = null;
      }
    }
  }

  /** The command a given operative is issuing this step. Absent reads as "standing still". */
  setCommand(playerId, cmd) {
    if (cmd === null) this.commands.delete(playerId);
    else this.commands.set(playerId, cmd);
  }

  commandFor(playerId) { return this.commands.get(playerId) || EMPTY_COMMAND; }

  /**
   * GDD §19.1 difficulty assists, from the settings screen into the simulation.
   *
   * ⚠ `src/sim` cannot import `src/ui`, so the settings object never reaches the rules —
   * a caller pushes the one number in. That is not a workaround, it is the reason the
   * whole campaign can be driven headless: the simulation has no opinion about where 1.4
   * came from. Section K fails the build if this direction is ever reversed.
   *
   * `playerId` scopes the timing assist to one operative's own bleed-out clock. Omit it
   * and it applies to the local squad and to the anomaly's contact spacing — the solo
   * case, where "the host" and "the player who set it" are the same person.
   */
  /**
   * A squad call — GDD §11.3. Returns a refusal addressed to the caller, or null.
   *
   * ⚠ THE REFUSAL GOES TO `noticeLocal`, NEVER `notice`. "You cannot see that from here"
   * is addressed to one operative and nobody else needs to hear it — and a refusal on the
   * squad feed would be destroyed by the next snapshot 80ms later, which is exactly the
   * bug two real browsers found and the two-feed split exists to prevent.
   */
  ping(playerId, phraseId, x, z) {
    const res = requestPing(this.comms, this.playerById(playerId), String(phraseId || ''),
      { x, z }, { atMs: this.clock.simTimeMs, blockers: this.site.blockingRects() });
    return res.ok ? null : res.why;
  }

  setAssists(assists, playerId = null) {
    const t = Math.max(1, Math.min(2, Number(assists && assists.procedureTiming) || 1));
    if (playerId) {
      const p = this.players.find((q) => q.id === playerId);
      if (p) p.assistTiming = t;
      return t;
    }
    for (const p of this.players) p.assistTiming = t;
    this.anomaly.assistTiming = t;
    return t;
  }

  /** Back-compatible single-player hook: main.js and the suite drive operative one. */
  setAxis(axis) {
    const c = this.commands.get('p1') || { ...EMPTY_COMMAND };
    this.commands.set('p1', { ...c, axis });
  }

  /* ── client-side prediction (GDD §20.4) ──────────────────────────────────
   * A client never steps the mission — the host owns all of it. But waiting 80ms to see
   * your own feet move is intolerable, so a client integrates its OWN operative locally
   * and blends toward the host's answer as snapshots land.
   *
   * ⚠ Predict POSITION only. Predicting anything the host arbitrates — a seal, an
   * evidence entry, a battery — would mean showing the player an outcome the host may
   * refuse, which is worse than latency. Movement is safe to predict precisely because
   * it is the one thing the host recomputes from the same axis the client sent.
   */
  predictLocal(playerId, stepMs) {
    const p = this.playerById(playerId);
    if (!p || p.incapacitated) return;
    const blockers = this.site.blockingRects().concat(this.deployables.blockingRects());
    const cmd = this.commandFor(playerId);
    p.sprinting = !!cmd.sprint;
    p.crouching = !!cmd.crouch;
    p.step(stepMs, cmd.axis || { x: 0, y: 0 }, blockers, {
      onIce: this.anomaly.iceAt(p.x, p.z),
      assisted: !!p.hands && this._assistFor(p) !== null,
    });
  }

  /** @returns {number} the correction distance in metres, for the netgraph. */
  reconcileLocal(playerId) {
    const p = this.playerById(playerId);
    if (!p || p.netX === undefined) return 0;
    const err = dist(p.x, p.z, p.netX, p.netZ);
    if (err > CONFIG.net.snapErrorM) { p.x = p.netX; p.z = p.netZ; return err; }
    p.x += (p.netX - p.x) * CONFIG.net.blend;
    p.z += (p.netZ - p.z) * CONFIG.net.blend;
    return err;
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

    /* 1. the field, rebuilt from the world. EVERY warm body is a lure, including a downed
     *    one — an operative on the floor is still the warmest thing in the room, which is
     *    what makes leaving them there a decision rather than an inconvenience. */
    const emitters = this.deployables.heatEmitters();
    for (const p of this.players) if (p.alive) emitters.push({ ...p.heatSource(), active: true });
    this.heat.setEmitters(emitters);
    /* ⚠ THE INSTANCES ARE SINKS ON THE SAME FIELD, and that is the whole design of the
     * third procedure family rather than an implementation detail. Each is four degrees of
     * cold at 0.9m, so the imager the squad brought to fence a draught is the instrument
     * that finds them — and superposition, which nothing here writes, makes three in a
     * drawer legible from the doorway while one on its own is a smudge you have to stand
     * over. The field that is a WALL in one incident is an INSTRUMENT in another. */
    const sink = this.anomaly.asSink();
    this.heat.setSinks([...(sink ? [sink] : []), ...this.instances.sinks()]);
    this.heat.drift(stepMs, this.anomaly.isLoose);

    /* 2. the squad. One pass per operative, each reading its own command — there is no
     *    branch anywhere below here for "is this one local". */
    const blockers = this.site.blockingRects().concat(this.deployables.blockingRects());
    for (const p of this.players) {
      if (!p.alive) continue;
      const cmd = this.commandFor(p.id);
      p.sprinting = !!cmd.sprint;
      p.crouching = !!cmd.crouch;

      const lost = p.stepDowned(stepMs, CONFIG.player.bleedOutMs);
      if (lost) {
        this.comms.retire(p.id);
        this.notice(`${p.name} stopped answering.`);
        this.bus.emit(EVENTS.OPERATIVE_LOST, { id: p.id }, simTimeMs);
      }

      if (!p.incapacitated) {
        const dragged = this.players.find((q) => q.draggedBy === p.id) || null;
        p.step(stepMs, cmd.axis || { x: 0, y: 0 }, blockers, {
          onIce: this.anomaly.iceAt(p.x, p.z),
          assisted: !!p.hands && this._assistFor(p) !== null,
          dragging: !!dragged,
        });
        /* A dragged casualty is towed a metre behind, not teleported onto the carrier. */
        if (dragged) {
          dragged.x = p.x + Math.sin(p.yaw) * 0.9;
          dragged.z = p.z + Math.cos(p.yaw) * 0.9;
        }
      }
      p.stepStress(stepMs, {
        lightLevel: this.lightAt(p.x, p.z),
        anomalyDistance: dist(p.x, p.z, this.anomaly.x, this.anomaly.z),
        anomalyLoose: this.anomaly.isLoose,
      });
    }
    if (this.players.every((p) => !p.alive)) {
      this.endMission('The squad was lost on the floor.', simTimeMs);
      return;
    }

    /* 3. power. Batteries after movement so "in range of the draught" is this step's truth. */
    const before = this.deployables.list.map((d) => d.hasPower);
    this.deployables.stepPower(stepMs, this.anomaly);
    this.deployables.list.forEach((d, i) => {
      if (before[i] && !d.hasPower) this.bus.emit(EVENTS.BATTERY_DEAD, { itemId: d.itemId, uid: d.uid }, simTimeMs);
    });
    for (const id of this.imagerOnIds) {
      const p = this.playerById(id);
      if (!p) continue;
      const near = this.anomaly.isAwake && dist(p.x, p.z, this.anomaly.x, this.anomaly.z) <= CONFIG.anomaly.batteryDrainRadiusM;
      const left = Math.max(0, this.batteryFor('thermal-imager') - stepMs * (near ? CONFIG.anomaly.batteryDrainMultiplier : 1));
      this.itemBattery.set('thermal-imager', left);
      if (left === 0) { this.imagerOnIds.delete(id); this.notice('The imager screen goes dark. Battery flat.'); }
    }

    /* Expired calls leave the board. ⚠ REQUIRED, not housekeeping: `encode()` sends the
     * raw list, so without this the snapshot grows a row per call for the whole operation
     * and clients keep drawing markers that stopped being true minutes ago. */
    this.comms.prune(simTimeMs);

    /* Carried objects follow their carrier, and a live imager reads whatever is close
     * enough to read. Verification is bookkeeping — no rule consults it, because the game
     * does not care whether you checked, only whether you were right. */
    this.instances.step(this.players);
    for (const id of this.imagerOnIds) {
      const p = this.playerById(id);
      if (p && p.alive) this.instances.verifyWithImager(this.heat, p.x, p.z);
    }

    /* 4. the anomaly, reading the field built in step 1. Every operative is a candidate
     *    meal; `chooseTarget` picks the strongest it can reach, so a squad that spreads
     *    out is choosing which of them is the bait. */
    const sources = [];
    for (const p of this.players) {
      if (p.alive) sources.push({ id: p.id, x: p.x, z: p.z, peakC: CONFIG.player.bodyHeatC });
    }
    for (const d of this.deployables.list) {
      if (d.isEmitter && d.active) sources.push({ id: d.uid, x: d.x, z: d.z, peakC: d.item.heatOutputCelsius });
    }
    /* Who is watching it. Judged on the host, like everything else it might be decided by
     * (GDD §20.3) — a client's camera feed is 80ms stale and must never be what loses the
     * operation. An operative who is down is not watching anything. */
    const viewers = [];
    for (const p of this.players) if (p.alive && !p.downed) viewers.push(operativeViewer(p));
    for (const d of this.deployables.list) {
      if (d.itemId === 'remote-camera' && d.active) viewers.push(cameraViewer(d));
    }
    this.observation = observedBy(this.anomaly.x, this.anomaly.z, viewers, this.site.blockingRects());
    this.viewers = viewers;

    const prevState = this.anomaly.state;
    const res = this.anomaly.step(stepMs, simTimeMs, {
      sources, operatives: this.players.filter((p) => p.alive), pressureStage: m.stage,
      observation: this.observation,
      instances: this.instances,
    });
    if (this.anomaly.state !== prevState) {
      const t = this.anomaly.transitions[this.anomaly.transitions.length - 1];
      m.applyPressureDelta(t ? t.pressureDelta : 0);
      this.bus.emit(EVENTS.ANOMALY_STATE_CHANGED, { from: prevState, to: this.anomaly.state, trigger: t && t.triggerId }, simTimeMs);
      if (t && t.telegraph) this.notice(t.telegraph);
    }
    for (const c of res.contacts) {
      m.tally.contacts++;
      const victim = c.operative;
      const wasDown = victim.downed;
      for (const a of c.applies) victim.applyCondition(a.condition, a.severity);
      this.bus.emit(EVENTS.CONTACT, { count: c.count, id: victim.id }, simTimeMs);
      if (victim.downed && !wasDown) {
        this.notice(this.players.length > 1
          ? `${victim.name} is down. Somebody get to them.`
          : `${victim.name} is down, and there is nobody else on this floor.`);
        this.bus.emit(EVENTS.OPERATIVE_DOWNED, { id: victim.id }, simTimeMs);
        /* Whatever they were carrying hits the floor where they fell — including, if it
         * comes to that, custody itself. */
        if (victim.hands) this._putDownCase(victim);
      } else {
        this.notice(`${victim.name}: contact. The cold goes through you and your leg stops answering.`);
      }
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

    /* Withdrawal is judged on the NEAREST operative. A squad has not backed off while one
     * of them is still standing over it, however far away the other four are. */
    let nearest = Infinity;
    for (const p of this.players) if (p.alive) nearest = Math.min(nearest, dist(p.x, p.z, this.anomaly.x, this.anomaly.z));
    m.stepPressure(stepMs, {
      anomalyLoose: this.anomaly.isLoose,
      anomalyAwake: this.anomaly.isAwake,
      operativeDistance: nearest,
      activeEmitters: this.deployables.list.filter((d) => d.isEmitter && d.active).length,
    });

    /* Arrival ends when the squad leaves the command point, not after N metres of
     * walking — otherwise pacing back and forth at the vehicle counts as investigating. */
    if (m.phase === PHASE.ARRIVAL
      && this.players.some((p) => dist(p.x, p.z, this.site.cache.x, this.site.cache.z) > 6)) {
      m.setPhase(PHASE.INVESTIGATION, simTimeMs);
      this.bus.emit(EVENTS.PHASE_CHANGED, { phase: m.phase }, simTimeMs);
    }
    const carrier = this.players.find((p) => p.hands === 'reinforced-transit-case');
    if (m.phase !== PHASE.EXTRACTION && this.custody === 'verified' && carrier) {
      m.setPhase(PHASE.EXTRACTION, simTimeMs);
      this.bus.emit(EVENTS.PHASE_CHANGED, { phase: m.phase }, simTimeMs);
    }

    /* Extraction: custody is not complete until the payload reaches transfer (§6.1 G).
     * Who is standing on the stair when it does is recorded per operative, because the
     * debrief has to be able to say that the case came up and somebody did not. */
    if (carrier && this.custody === 'verified' && this.site.inExtraction(carrier.x, carrier.z)) {
      for (const p of this.players) p.extracted = this.site.inExtraction(p.x, p.z);
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

  /**
   * Evidence is squad-wide, and the entry names WHO saw it. GDD §7.2 wants provenance on
   * every observation — with five operatives, "who was holding the imager" is exactly the
   * sort of thing the debrief and the board have to be able to answer.
   */
  _stepEvidence(stepMs, simTimeMs) {
    for (const p of this.players) {
      if (!p.alive) continue;
      const prov = (source = p.name) => ({
        simTimeMs, x: p.x, z: p.z, room: this.site.roomNameAt(p.x, p.z),
        source, integrity: 'clean',
      });

      const on = this.imagerOnIds.has(p.id);
      const held = (on && this.anomaly.isLoose && dist(p.x, p.z, this.anomaly.x, this.anomaly.z) <= 16)
        ? (this.imagerHold.get(p.id) || 0) + stepMs : 0;
      this.imagerHold.set(p.id, held);

      if (thermalVoidObserved(on, this.anomaly, p, held)) {
        this._log('thermal-void', prov(`${p.name} · thermal imager`));
      }
      if (frostBoundaryObserved(this.anomaly, p)) this._log('frost-boundary', prov());
    }
    if (batteryDrainObserved(this.deployables, this.anomaly)) {
      const p = this.player;
      this._log('battery-drain', {
        simTimeMs, x: p.x, z: p.z, room: this.site.roomNameAt(p.x, p.z),
        source: 'equipment telemetry', integrity: 'clean',
      });
    }
  }

  /** The imager's remaining charge, in ms. Follows the item across a handover. */
  batteryFor(itemId) {
    if (!this.itemBattery.has(itemId)) {
      const it = this.itemsById.get(itemId);
      this.itemBattery.set(itemId, (it && it.batteryMinutes ? it.batteryMinutes : 0) * 60000);
    }
    return this.itemBattery.get(itemId);
  }

  /** A free-handed teammate close enough to take some of the weight (GDD §11.2). */
  _assistFor(carrier) {
    for (const q of this.players) {
      if (q === carrier || q.incapacitated || q.hands) continue;
      if (dist(carrier.x, carrier.z, q.x, q.z) <= CONFIG.player.assistReachM) return q;
    }
    return null;
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
   * @param {string} [playerId]  whose reach to resolve. Defaults to operative one, so
   *                             every single-player call site is unchanged.
   * @returns {{kind:string, text:string, target?:any}|null}
   */
  contextAction(playerId = 'p1') {
    const p = this.playerById(playerId);
    if (!p || !p.alive) return null;
    const reach = CONFIG.player.reachMetres;

    /* A downed operative has one verb, and it is not theirs to press. */
    if (p.downed) return null;

    /* Carrying one of the set. It is in the HANDS, so the only two verbs are log it or put
     * it down — and the walk back to the case is the cost the whole incident is made of. */
    const held = this.instances.carriedBy(p.id);
    if (held) {
      const box = this.deployables.byItem('reinforced-transit-case')
        .find((d) => !d.sealed && dist(p.x, p.z, d.x, d.z) <= this.instances.depositRadiusM);
      if (box) return { kind: 'deposit', text: `Log the ${held.label.toLowerCase()} into the case`, target: box };
      return { kind: 'drop-instance', text: `Set the ${held.label.toLowerCase()} down` };
    }

    if (p.hands) return { kind: 'put-down', text: `Put down the ${this.itemsById.get(p.hands).displayName}` };

    /* A teammate on the floor outranks everything except a seal. GDD §9.5 — the rescue
     * decision is the point, so it must never be buried under "retrieve the tripod". */
    const casualty = this.players.find((q) => q !== p && q.alive && q.downed
      && dist(p.x, p.z, q.x, q.z) <= reach + 0.6);
    if (casualty) {
      if (p.carrying('trauma-kit')) return { kind: 'revive', text: `Stabilise ${casualty.name}`, target: casualty };
      if (casualty.draggedBy === p.id) return { kind: 'release', text: `Let go of ${casualty.name}`, target: casualty };
      return { kind: 'drag', text: `Drag ${casualty.name} clear`, target: casualty };
    }

    /* The seal comes first: when it is available it is the only thing that matters. */
    const caseDep = this.deployables.byItem('reinforced-transit-case')
      .find((d) => !d.sealed && dist(p.x, p.z, d.x, d.z) <= reach);
    /**
     * ⚠ "IS IT IN THE CASE" IS NOT ALWAYS A DISTANCE.
     *
     * For a mass it is: the draught has to be within 1.5m of the case for the latches to
     * mean anything. For a distributed set it is not, and cannot be — the anomaly has no
     * meaningful position, its `anomalySpawn` is a formality the map format requires, and
     * the objects are already inside the box. The distance test put the tally incident's
     * seal twenty metres away from where the operation actually finishes, so the verb
     * simply never appeared and the incident could not be completed at all.
     *
     * The set's version of the same question is whether the account is closed, and
     * `isHeld` already answers it — the `accounted` state is of the vulnerable kind, which
     * is the same thing `banked` and `held` are for the other two families.
     */
    const inTheCase = this.anomaly.isDistributed
      ? true
      : (caseDep && dist(this.anomaly.x, this.anomaly.z, caseDep.x, caseDep.z) <= 1.5);
    if (caseDep && this.anomaly.isHeld && inTheCase) {
      return { kind: 'seal', text: 'SEAL THE CASE', target: caseDep };
    }

    /* A contaminated case outranks everything except the seal and a casualty, the same way
     * the seal does — for the same reason. Standing at a case with the wrong thing in it,
     * there is exactly one useful action, and burying it under "retrieve the transit case"
     * would let a squad carry a case they cannot seal to a stair head they cannot leave by.
     * Offered ONLY while contaminated, so it never appears as a way to casually undo a
     * correct deposit. */
    if (this.instances.contaminated) {
      const spoiled = this.deployables.byItem('reinforced-transit-case')
        .find((d) => !d.sealed && dist(p.x, p.z, d.x, d.z) <= reach);
      if (spoiled) {
        return {
          kind: 'purge', target: spoiled,
          text: `Open the case and turn it out (${this.instances.inCase.length} inside)`,
        };
      }
    }

    const cands = [];
    const dep = this.deployables.nearest(p.x, p.z, reach);
    if (dep) {
      const d = dist(p.x, p.z, dep.x, dep.z);
      if (dep.sealed && this.custody === 'verified') cands.push({ d, kind: 'carry-case', text: 'Lift the transit case', target: dep });
      else if (dep.sealed) cands.push({ d, kind: 'blocked', text: 'Custody unverified — the case must hold thirty seconds', target: dep });
      else cands.push({ d, kind: 'retrieve', text: `Retrieve the ${dep.item.displayName}`, target: dep });
    }

    const loose = this.instances.nearestLoose(p.x, p.z, reach);
    if (loose) {
      cands.push({
        d: dist(p.x, p.z, loose.x, loose.z), kind: 'collect', target: loose,
        /* The prompt says what it LOOKS like, never what it is. An object the imager has
         * confirmed says so; one nobody has read is just an object, and the whole incident
         * is the difference between those two sentences. */
        text: loose.verified ? `Take the ${loose.label.toLowerCase()} — reads cold` : `Take the ${loose.mundaneLabel.toLowerCase()}`,
      });
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
    /**
     * Nearest wins, and a tie is broken by how SMALL the thing is.
     *
     * ⚠ A plain distance sort is not enough once objects can be lying on top of a
     * deployable, which is exactly what happens the moment a contaminated case is turned
     * out: eleven objects and the case they came from all at the same coordinates. The
     * distances were equal, `retrieve the transit case` had been pushed first, and picking
     * any of them back up became impossible — the operative stood in the pile they had
     * just made and was offered the case, over and over.
     *
     * So a tie resolves to the more specific object. You can always step away from a case;
     * you cannot step away from a tie.
     */
    const grain = { collect: 0, purge: 1, deposit: 1, retrieve: 2, 'carry-case': 2, blocked: 3 };
    cands.sort((a, b) => (a.d - b.d) || ((grain[a.kind] ?? 2) - (grain[b.kind] ?? 2)));
    return cands[0];
  }

  /** Put a carried case back on the floor, keeping its custody state with it. */
  _putDownCase(p) {
    const item = this.itemsById.get(p.hands);
    if (!item) { p.hands = null; return null; }
    const d = this.deployables.place(item, p.x, p.z, p.yaw);
    const was = this._carried.get(p.id);
    if (was) {
      d.sealed = was.sealed;
      d.custodyHeldMs = was.custodyHeldMs;
      d.batteryMs = was.batteryMs;
      if (d.sealed) this.anomaly.sealedIn = d;
      this._carried.delete(p.id);
    }
    p.hands = null;
    return d;
  }

  doInteract(playerId = 'p1') {
    const p = this.playerById(playerId);
    if (!p) return 'No such operative.';
    const a = this.contextAction(playerId);
    if (!a) return 'Nothing in reach.';
    const t = this.clock.simTimeMs;
    switch (a.kind) {
      case 'seal': {
        this.mission.tally.sealAttempts++;
        const err = this.anomaly.trySeal(a.target, t);
        this.bus.emit(EVENTS.SEAL_ATTEMPT, { ok: !err, err, id: p.id }, t);
        if (err) { this.notice(err); return err; }
        this.custody = 'sealed';
        this.mission.setPhase(PHASE.CONTAINMENT_ACTIVE, t);
        this.notice('Latches over. The case seams frost as the load transfers. Hold it.');
        return null;
      }
      case 'carry-case':
        p.hands = a.target.itemId;
        this._carried.set(p.id, { sealed: a.target.sealed, custodyHeldMs: a.target.custodyHeldMs, batteryMs: a.target.batteryMs });
        this.deployables.remove(a.target);
        this.notice(`${p.name} has it. It is heavier than it looks and it is still cold.`);
        return null;
      case 'put-down':
        this._putDownCase(p);
        return null;
      case 'collect': {
        const err = this.instances.collect(p.id, a.target);
        if (err) { this.noticeLocal(err); return err; }
        this.bus.emit(EVENTS.INSTANCE_COLLECTED, { id: a.target.id, by: p.id }, t);
        return null;
      }
      case 'drop-instance':
        this.instances.drop(p.id, p.x, p.z);
        return null;
      case 'deposit': {
        const r = this.instances.deposit(p.id, a.target.x, a.target.z);
        if (!r.ok) { this.noticeLocal(r.why); return r.why; }
        /* ⚠ THE ONLY FEEDBACK IS THE NUMBER, and a wrong object is SILENT. Saying "that
         * one was mundane" here would delete the incident: the verification family is
         * about noticing that the count did not move, and a game that tells you would be
         * asking you to read a label rather than to keep an account. */
        this.notice(r.ticked
          ? `The case answers. ${this.instances.counted} logged.`
          : `The case takes it. ${this.instances.counted} logged.`);
        this.bus.emit(EVENTS.INSTANCE_LOGGED, { id: r.instance.id, counted: this.instances.counted, by: p.id }, t);
        return null;
      }
      case 'purge': {
        const out = this.instances.purge(a.target.x, a.target.z);
        this.notice(`The case is turned out. ${out.length} back on the floor, and none of them will say which.`);
        this.bus.emit(EVENTS.SET_PURGED, { n: out.length, by: p.id }, t);
        return null;
      }
      case 'retrieve': {
        const item = a.target.item;
        if (!p.take(item)) { this.notice('No slot free for that.'); return 'No slot free.'; }
        this.deployables.remove(a.target);
        this.bus.emit(EVENTS.RETRIEVED, { itemId: item.id, id: p.id }, t);
        return null;
      }
      case 'drag': {
        /* One carrier at a time — contention as a property, not a rule. The field simply
         * cannot hold two draggers (the SmallTownEmergencyServices pattern). */
        if (a.target.draggedBy) return `${a.target.name} is already being moved.`;
        a.target.draggedBy = p.id;
        this.notice(`${p.name} has hold of ${a.target.name}.`);
        return null;
      }
      case 'release':
        a.target.draggedBy = null;
        return null;
      case 'revive': {
        if (!a.target.revive()) return 'Nothing to do for them.';
        for (const s of SLOTS) if (p.slots.get(s.id) === 'trauma-kit') { p.slots.set(s.id, null); break; }
        this.mission.tally.treatments++;
        this.mission.tally.rescues++;
        this.bus.emit(EVENTS.OPERATIVE_REVIVED, { id: a.target.id, by: p.id }, t);
        this.notice(`${a.target.name} is back on their feet. Stabilised, not fixed.`);
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
          simTimeMs: t, x: p.x, z: p.z,
          room: this.site.roomNameAt(p.x, p.z),
          source: p.name, integrity: 'clean',
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
  takeFromCache(itemId, playerId = 'p1') {
    const p = this.playerById(playerId);
    if (!p || p.incapacitated) return 'Not right now.';
    const n = this.cache.get(itemId) || 0;
    if (n <= 0) return 'None left in cargo.';
    if (dist(p.x, p.z, this.site.cache.x, this.site.cache.z) > CONFIG.player.reachMetres + 1.2) {
      return 'Too far from the cargo point.';
    }
    const item = this.itemsById.get(itemId);
    if (!p.take(item)) return `No free slot takes a ${item.bulk} item.`;
    this.cache.set(itemId, n - 1);
    return null;
  }

  /** Put the held item back into cargo. Recoverable mistakes, GDD Pillar 4. */
  returnToCache(playerId = 'p1') {
    const p = this.playerById(playerId);
    if (!p) return 'No such operative.';
    const id = p.heldItemId;
    if (!id) return 'Nothing in hand.';
    if (dist(p.x, p.z, this.site.cache.x, this.site.cache.z) > CONFIG.player.reachMetres + 1.2) {
      return 'Too far from the cargo point.';
    }
    p.drop(p.heldSlot);
    this.cache.set(id, (this.cache.get(id) || 0) + 1);
    return null;
  }

  /** Deploy the held item where the operative is standing. */
  deployHeld(playerId = 'p1') {
    const p = this.playerById(playerId);
    if (!p || p.incapacitated) return 'Not right now.';
    const id = p.heldItemId;
    if (!id) return 'Nothing in hand.';
    const item = this.itemsById.get(id);
    if (!item.deployable) return `The ${item.displayName.toLowerCase()} is not something you set down.`;
    /* Refuse a placement inside geometry rather than letting it clip — a fence post inside
     * a wall is a fence post the player thinks they have. */
    const fx = p.x - Math.sin(p.yaw) * 0.9, fz = p.z - Math.cos(p.yaw) * 0.9;
    for (const r of this.site.blockingRects()) {
      if (fx > r[0] - 0.2 && fx < r[2] + 0.2 && fz > r[1] - 0.2 && fz < r[3] + 0.2) return 'No room to set that down here.';
    }
    p.drop(p.heldSlot);
    const d = this.deployables.place(item, fx, fz, p.yaw);
    this.mission.tally.deployablesPlaced++;
    this.bus.emit(EVENTS.DEPLOYED, { itemId: id, uid: d.uid, by: p.id }, this.clock.simTimeMs);
    return null;
  }

  /** The imager is a held instrument, not a mode: it costs a hand and a battery. */
  toggleImager(playerId = 'p1') {
    const p = this.playerById(playerId);
    if (!p || !p.carrying('thermal-imager')) return 'You did not bring the imager.';
    if (this.batteryFor('thermal-imager') <= 0) return 'The imager battery is flat.';
    if (this.imagerOnIds.has(p.id)) this.imagerOnIds.delete(p.id);
    else this.imagerOnIds.add(p.id);
    return null;
  }

  /** Back-compatible reader: is operative one looking at the thermal screen? */
  get imagerOn() { return this.imagerOnIds.has('p1'); }
  set imagerOn(v) { if (v) this.imagerOnIds.add('p1'); else this.imagerOnIds.delete('p1'); }
  get imagerHoldMs() { return this.imagerHold.get('p1') || 0; }
  get imagerBatteryMs() { return this.batteryFor('thermal-imager'); }

  useHeld(playerId = 'p1') {
    const p = this.playerById(playerId);
    if (!p || p.incapacitated) return 'Not right now.';
    const id = p.heldItemId;
    if (id === 'thermal-imager') return this.toggleImager(playerId);
    if (id === 'trauma-kit') {
      if (!p.treat()) return 'Nothing to stabilise.';
      p.drop(p.heldSlot);
      this.mission.tally.treatments++;
      this.notice('Stabilised. It will not get worse; it is not going to get better here either.');
      return null;
    }
    if (id === 'sample-kit') {
      if (!this.anomaly.icePatches.length && !this.anomaly.isHeld) return 'No frost worth taking.';
      this.notice('Frost sample sealed. Research will want this.');
      p.drop(p.heldSlot);
      return null;
    }
    if (id) return this.deployHeld(playerId);
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

  /**
   * How lit this spot is, 0–1: the mains, plus every floodlight anyone has set down.
   *
   * ⚠ THE RADIUS BELONGS TO THE ITEM. It was hard-coded here as 6.5 while CONFIG carried a
   * `stress.lightReliefRadiusM: 4.5` that nothing read — two different numbers for one
   * radius, and the one you would have found by searching the config was the wrong one.
   * It sits in items.json now, beside the heat output and the falloff, because a lamp's
   * reach is a property of the lamp. A second light source is a content file, not an
   * `itemId ===` test, and this loop no longer names the floodlight at all.
   */
  lightAt(x, z) {
    let l = this.site.mainsLightAt(x, z);
    for (const d of this.deployables.list) {
      if (!d.active) continue;
      const r = d.item && d.item.lightRadiusMetres;
      if (!r) continue;
      const dd = dist(x, z, d.x, d.z);
      l = Math.max(l, Math.max(0, 1 - (dd / r) ** 2));
    }
    return Math.min(1, l);
  }

  /** Squad-wide, and therefore the HOST'S to own: it travels in the snapshot. */
  notice(text) {
    this.notices.push({ text, atMs: this.clock.simTimeMs });
    if (this.notices.length > 40) this.notices.shift();
    this.bus.emit(EVENTS.NOTICE, { text }, this.clock.simTimeMs);
  }

  /**
   * Private to this machine, and NEVER carried by a snapshot.
   *
   * ⚠ THIS EXISTS BECAUSE THE SNAPSHOT ATE THE REFUSALS. A client that asks for something
   * the host will not allow is told why — and `applySnapshot` replaced `notices` wholesale
   * with the host's list, so the reason was destroyed within about 80ms and the player saw
   * nothing at all. Found in two real browsers over a real connection, because a loopback
   * test that reads the notice immediately never gets far enough to lose it. A refusal is
   * addressed to ONE operative; the squad feed is addressed to all of them; they cannot
   * share a list.
   */
  noticeLocal(text) {
    this.localNotices.push({ text, atMs: this.clock.simTimeMs, local: true });
    if (this.localNotices.length > 20) this.localNotices.shift();
    this.bus.emit(EVENTS.NOTICE, { text, local: true }, this.clock.simTimeMs);
  }

  recentNotices(n = 4, windowMs = 9000) {
    const t = this.clock.simTimeMs;
    return this.notices.concat(this.localNotices)
      .filter((x) => t - x.atMs < windowMs)
      .sort((a, b) => a.atMs - b.atMs)
      .slice(-n);
  }

  endMission(failReason, simTimeMs) {
    if (this.result) return this.result;
    this.mission.failReason = failReason;
    this.mission.endedMs = simTimeMs;
    let cargoRecovered = Array.from(this.cache.values()).reduce((a, b) => a + b, 0);
    for (const p of this.players) {
      cargoRecovered += Array.from(p.slots.values()).filter(Boolean).length + (p.hands ? 1 : 0);
    }
    this.mission.tally.deployablesLost = this.deployables.list.length;
    this.result = this.mission.grade({
      custody: this.custody, extracted: this.extracted,
      players: this.players, player: this.player,
      ledger: this.ledger, deployables: this.deployables, simTimeMs,
      cargoIssued: this.cargoIssued, cargoRecovered,
    });
    this.result.failReason = failReason;
    this.mission.setPhase(PHASE.DEBRIEF, simTimeMs);
    this.bus.emit(EVENTS.MISSION_ENDED, { result: this.result }, simTimeMs);
    return this.result;
  }
}

export { PHASE, ANOMALY_STATE, CLAIMS, SLOTS };
