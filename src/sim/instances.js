/* Distributed objects — GDD §26.2's third procedure family, "distributed-object recovery
 * and verification".
 *
 * THE PROBLEM THIS SOLVES. The build had two containment grammars: build a wall out of
 * heat, or keep something in view. Both are about ONE thing in ONE place, and both end
 * with a case closing around it. §26.2 asks for a third family that is genuinely different,
 * and §24 lists "scope expands through anomaly uniqueness" as a critical risk with a shared
 * grammar as the mitigation — so a third family has to be new PROCEDURE, not new code paths
 * bolted onto the anomaly.
 *
 * So: the anomaly is not a mass, it is a SET. Some number of objects, scattered among more
 * candidate sites than there are objects, and the operation is search, verify, recover,
 * account. Nothing hunts you. The clock is the only pressure and the mistake is arithmetic.
 *
 * ⚠ THE TELL IS THE HEAT FIELD, AND THAT IS THE WHOLE REASON THIS COSTS ALMOST NO CODE.
 * An instance is a small cold sink — four degrees at 0.9m of falloff. It is therefore
 * already painted by `ThermalFloor`, already sampled by `heat.temperatureAt`, and already
 * visible through the imager the squad brought for a different reason entirely. Two
 * consequences fall out of superposition rather than being written:
 *
 *   · one instance alone is a smudge you have to be within a couple of metres to read;
 *   · three of them in a drawer add up and are obvious from across the room.
 *
 * That is the search gradient of the whole incident, and no line of code decides it. The
 * same field that is a WALL in the draught incident is an INSTRUMENT here, which is the
 * clearest statement this codebase can make about why there is only one field.
 *
 * VERIFICATION IS A PROCEDURE, NOT A LOOKUP. The case counts what is inside it. A mundane
 * object deposited does not tick the counter — it CONTAMINATES, and clearing it means
 * opening the case, which lets go of everything already in there. So being sure before you
 * deposit is worth a walk back, and "how many are there" is a question the evidence trail
 * answers rather than the HUD.
 *
 * No renderer, no DOM, no wall clock. Section K of the suite enforces that.
 */

import { dist2 } from './geometry.js';
import { t as msg } from '../core/i18n.js';

/** Where an object can be in its life. Small, closed, and the state machine is linear. */
export const INSTANCE_STATE = Object.freeze({
  /** On the floor at its site, not yet picked up. */
  LOOSE: 'loose',
  /** In an operative's hands. Exactly one per operative — they are not pocketable. */
  CARRIED: 'carried',
  /** In the transit case and counted. */
  DEPOSITED: 'deposited',
});

/**
 * One candidate object at one site.
 *
 * `anomalous` is the truth and it is NOT a secret the engine keeps — it ships in the
 * incident file and any player who opens the devtools can read it. That is deliberate and
 * worth being honest about: this is a co-operative game against an environment, there is
 * no adversary to hide it from, and building a server to protect a JSON file would be
 * ceremony. What the game asks is that you find out IN THE FICTION, with an instrument, in
 * the dark, on a clock — the same thing it asks about the draught's threshold, which is
 * also written down in a file the player could read.
 */
class Instance {
  constructor({ id, x, z, anomalous, label, mundaneLabel }) {
    this.id = id;
    this.x = x;
    this.z = z;
    this.homeX = x;
    this.homeZ = z;
    this.anomalous = !!anomalous;
    this.label = label || (this.anomalous ? 'Object' : 'Object');
    /** What it says it is before anyone has read it — identical for both kinds, on purpose. */
    this.mundaneLabel = mundaneLabel || this.label;
    this.state = INSTANCE_STATE.LOOSE;
    this.carriedBy = null;
    /** Set when an operative has confirmed it on the imager. Bookkeeping for the HUD and
     *  the debrief; the RULES never read it, because the game does not care whether you
     *  checked — only whether you were right. */
    this.verified = false;
  }

  get loose() { return this.state === INSTANCE_STATE.LOOSE; }
  get carried() { return this.state === INSTANCE_STATE.CARRIED; }
  get deposited() { return this.state === INSTANCE_STATE.DEPOSITED; }

  /**
   * How this object disturbs the heat field, or null.
   *
   * ⚠ ONLY WHILE IT IS LOOSE OR CARRIED. A deposited object is inside a heated case at
   * 39°C and stops reading as a void — which means the imager cannot be used to audit the
   * case from outside, and the count on the case is the only account you get. That is not
   * a limitation, it is the reason the arithmetic matters.
   */
  asSink(chillC, falloffM) {
    if (!this.anomalous || this.deposited) return null;
    return { id: `inst-${this.id}`, x: this.x, z: this.z, chillC, falloffM };
  }
}

/**
 * The set, and every rule about it.
 *
 * Sites come from the incident (what happened here), the chill numbers from the anomaly
 * (what this thing is). Neither is a constant in this file.
 */
export class InstanceSet {
  constructor() {
    this.reset();
  }

  reset(sites = [], { chillC = 4, falloffM = 0.9, depositRadiusM = 1.5, reachM = 2.2 } = {}) {
    this.list = sites.map((s, i) => new Instance({
      id: s.id || `i${i + 1}`,
      x: s.at[0], z: s.at[1],
      anomalous: s.anomalous,
      label: s.label,
      mundaneLabel: s.mundaneLabel,
    }));
    this.chillC = chillC;
    this.falloffM = falloffM;
    this.depositRadiusM = depositRadiusM;
    this.reachM = reachM;
    /** Cleared to false the moment a mundane object goes in. See `contaminated`. */
    this.contaminatedBy = null;
    return this;
  }

  /** How many of these are actually the anomaly. The number the squad has to discover. */
  get total() { return this.list.filter((i) => i.anomalous).length; }
  /** How many candidates there are altogether — always more, or there is nothing to verify. */
  get candidates() { return this.list.length; }
  /** What is in the case, right or wrong. */
  get inCase() { return this.list.filter((i) => i.deposited); }
  /** The count the CASE reports. It counts what answers, not what is inside. */
  get counted() { return this.list.filter((i) => i.deposited && i.anomalous).length; }
  /** True once somebody has put something in that does not belong there. */
  get contaminated() { return this.list.some((i) => i.deposited && !i.anomalous); }
  /** Every one of them accounted for and nothing else in the box. */
  get complete() { return this.counted === this.total && !this.contaminated; }
  /** Still out there. What the imager is for. */
  get loose() { return this.list.filter((i) => i.loose); }

  byId(id) { return this.list.find((i) => i.id === id) || null; }
  carriedBy(playerId) { return this.list.find((i) => i.carried && i.carriedBy === playerId) || null; }

  /** Every sink this set contributes to the heat field this step. */
  sinks() {
    const out = [];
    for (const i of this.list) {
      const s = i.asSink(this.chillC, this.falloffM);
      if (s) out.push(s);
    }
    return out;
  }

  /** The nearest thing an operative could pick up, within reach. */
  nearestLoose(x, z, reach = this.reachM) {
    let best = null, bestD = reach * reach;
    for (const i of this.list) {
      if (!i.loose) continue;
      const d = dist2(x, z, i.x, i.z);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Pick one up. ⚠ ONE PER OPERATIVE, and it is in their HANDS, not a slot: §9.2 gives
   * five slots and two hands, and an object you can pocket turns the whole recovery into
   * one lap with a bag. Making it a hands item is what makes the walk cost something and
   * what makes a second operative worth having.
   */
  collect(playerId, instance) {
    if (!instance || !instance.loose) return msg('mission.refuse.nothingToPickUp');
    if (this.carriedBy(playerId)) return msg('mission.refuse.handsFull');
    instance.state = INSTANCE_STATE.CARRIED;
    instance.carriedBy = playerId;
    return null;
  }

  /** Put it back down where you are standing. Not where it came from — you moved it. */
  drop(playerId, x, z) {
    const held = this.carriedBy(playerId);
    if (!held) return null;
    held.state = INSTANCE_STATE.LOOSE;
    held.carriedBy = null;
    held.x = x; held.z = z;
    return held;
  }

  /**
   * Into the case. The case is at (caseX, caseZ) and must be within `depositRadiusM`.
   *
   * Returns `{ok, ticked, contaminated, why}`. `ticked` is whether the counter moved, which
   * is the ONLY feedback the squad gets and is the whole verification mechanic: a mundane
   * object goes in silently and the number does not change, and that silence is the failure
   * you have to notice.
   */
  deposit(playerId, caseX, caseZ) {
    const held = this.carriedBy(playerId);
    if (!held) return { ok: false, ticked: false, contaminated: this.contaminated, why: msg('mission.refuse.nothingInHandToLog') };
    if (dist2(held.x, held.z, caseX, caseZ) > this.depositRadiusM * this.depositRadiusM
      && dist2(caseX, caseZ, held.x, held.z) > this.depositRadiusM * this.depositRadiusM) {
      return { ok: false, ticked: false, contaminated: this.contaminated, why: msg('mission.refuse.tooFarFromCase') };
    }
    held.state = INSTANCE_STATE.DEPOSITED;
    held.carriedBy = null;
    held.x = caseX; held.z = caseZ;
    if (!held.anomalous && !this.contaminatedBy) this.contaminatedBy = held.id;
    return { ok: true, ticked: held.anomalous, contaminated: this.contaminated, instance: held };
  }

  /**
   * Open the case and take everything back out. The cost of a mistake.
   *
   * ⚠ EVERYTHING, not just the wrong one. You cannot reach in and pick out the one that
   * does not belong, because they are indistinguishable — that is the premise of the whole
   * incident. Purging is a full reset of the case's contents onto the floor at the case,
   * and every one of them has to be verified and deposited again.
   */
  purge(atX, atZ, { spreadM = 0.75 } = {}) {
    const out = [];
    for (const i of this.list) {
      if (!i.deposited) continue;
      i.state = INSTANCE_STATE.LOOSE;
      i.verified = false;
      out.push(i);
    }
    /* ⚠ THEY SCATTER, they do not stack on the case.
     *
     * The first version put every one of them back at the case's exact coordinates, which
     * made the pile unworkable: `nearestLoose` cannot tell apart four objects at the same
     * point, so an operative reaching into their own pile got whichever happened to be
     * first in the list — including the mundane one they had just paid for. Turning a case
     * out and having the contents land in a single column is not what happens anyway.
     *
     * Deterministic ring, indexed rather than random: a mission replays from its seed and
     * a purge is not a place to spend an RNG draw. */
    out.forEach((inst, k) => {
      const a = (k / Math.max(1, out.length)) * Math.PI * 2;
      inst.x = atX + Math.cos(a) * spreadM;
      inst.z = atZ + Math.sin(a) * spreadM;
    });
    this.contaminatedBy = null;
    return out;
  }

  /**
   * What an operative with a live imager can currently read.
   *
   * The rule is the FIELD, not a distance to the object: `heat.temperatureAt` at the
   * object's position, compared with ambient. That is why three in a drawer are legible
   * from the doorway and one on its own is not — superposition does it, and nothing here
   * knows that is happening.
   */
  verifyWithImager(heat, x, z, { rangeM = 6.0, minDropC = 1.2, apertureM = 2.0 } = {}) {
    const out = [];
    const r2 = rangeM * rangeM;
    for (const i of this.list) {
      if (i.deposited) continue;
      const d2 = dist2(x, z, i.x, i.z);
      if (d2 > r2) continue;
      const drop = heat.ambientC - heat.temperatureAt(i.x, i.z);
      /* ⚠ THE READING FALLS OFF WITH DISTANCE, or superposition buys nothing.
       *
       * The first version compared the raw drop against a flat threshold inside a fixed
       * range, which made confirmation BINARY: everything cold enough was readable from
       * exactly 3.0m and everything else from nowhere. Three objects together and one on
       * its own were then equally easy to find, which deletes the entire search gradient
       * the incident is built on — and the test that asserted the gradient exists was the
       * only thing that noticed.
       *
       * A small cold target subtends less the further away it is, so the signal falls off
       * the same softened inverse-square the field itself uses. That is not a coincidence
       * worth hiding: 2°C reads out to about 1.6m and 5°C to about 3.6m, so the office
       * cluster is findable from the doorway and the singleton in aisle C has to be stood
       * over. Nothing decides that but arithmetic. */
      const signal = drop / (1 + d2 / (apertureM * apertureM));
      if (signal < minDropC) continue;
      i.verified = true;
      out.push(i);
    }
    return out;
  }

  /** Follow the carrier. Called from the squad pass, like a dragged casualty. */
  step(players) {
    for (const i of this.list) {
      if (!i.carried) continue;
      const p = players.find((q) => q.id === i.carriedBy);
      if (!p) { i.state = INSTANCE_STATE.LOOSE; i.carriedBy = null; continue; }
      i.x = p.x; i.z = p.z;
    }
  }

  /**
   * ⚠ A DISCONNECTED OPERATIVE PUTS IT DOWN, they do not carry it out of the world.
   * The same rule §11.5 forces on custody of the case, for the same reason: an object that
   * left with somebody's laptop is an operation nobody can finish.
   */
  releaseHeldBy(playerId, x, z) { return this.drop(playerId, x, z); }

  /* ── the wire ─────────────────────────────────────────────────────────────
   * Positions to the centimetre, matching every other position in protocol.js. `anomalous`
   * does not travel: the client already has the incident file. */
  encode() {
    return this.list.map((i) => [
      i.id, Math.round(i.x * 100), Math.round(i.z * 100),
      i.state === INSTANCE_STATE.LOOSE ? 0 : i.state === INSTANCE_STATE.CARRIED ? 1 : 2,
      i.carriedBy || '', i.verified ? 1 : 0,
    ]);
  }

  decode(rows) {
    if (!Array.isArray(rows)) return this;
    for (const [id, xCm, zCm, st, by, ver] of rows) {
      const i = this.byId(id);
      if (!i) continue;
      i.x = xCm / 100; i.z = zCm / 100;
      i.state = st === 0 ? INSTANCE_STATE.LOOSE : st === 1 ? INSTANCE_STATE.CARRIED : INSTANCE_STATE.DEPOSITED;
      i.carriedBy = by || null;
      i.verified = !!ver;
    }
    return this;
  }
}
