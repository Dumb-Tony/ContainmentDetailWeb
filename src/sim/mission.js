/* Mission phases, Incident Pressure, and the debrief — GDD §5.4, §6.1, §6.4.
 *
 * PRESSURE IS A DIRECTOR INPUT, NOT A RAGE METER (§5.4). The HUD is given the stage WORD
 * and never the number, and this file is the only thing that can change it. It rises with
 * time and with disturbance, and it falls when the squad withdraws or completes a step of
 * the procedure — so backing off is a real move rather than a wasted minute.
 *
 * THE GRADE IS DIMENSIONAL (§6.4). There is no single opaque rank hiding what happened.
 * Nine dimensions are reported separately and the overall word is derived from them, so a
 * Costly success reads as a success that cost something rather than as a mediocre score.
 */

import { CONFIG } from '../config.js';

export const PHASE = Object.freeze({
  BRIEFING: 'Briefing',
  LOADOUT: 'Loadout',
  ARRIVAL: 'Arrival',
  INVESTIGATION: 'Investigation',
  PROCEDURE_COMMITTED: 'ProcedureCommitted',
  CONTAINMENT_ACTIVE: 'ContainmentActive',
  CUSTODY_ESTABLISHED: 'CustodyEstablished',
  EXTRACTION: 'Extraction',
  DEBRIEF: 'Debrief',
});

/* Ordered, so "have we reached at least X" is a comparison and not a set membership test. */
const PHASE_ORDER = [
  PHASE.BRIEFING, PHASE.LOADOUT, PHASE.ARRIVAL, PHASE.INVESTIGATION,
  PHASE.PROCEDURE_COMMITTED, PHASE.CONTAINMENT_ACTIVE, PHASE.CUSTODY_ESTABLISHED,
  PHASE.EXTRACTION, PHASE.DEBRIEF,
];

export class Mission {
  constructor() { this.reset(); }

  reset() {
    this.phase = PHASE.BRIEFING;
    this.phaseLog = [];
    this.pressure = 0;
    this.outcome = null;          // set once, at debrief
    this.failReason = null;
    this.startedMs = 0;
    this.endedMs = 0;
    /* The procedure card the squad committed to (GDD §18.4). Five fields, player-chosen,
     * never validated for correctness — the planner does not know the answer either. */
    this.procedure = null;
    this.procedureCommittedMs = null;
    this.abortCount = 0;
    /* Debrief inputs, written through as they happen rather than reconstructed at the end. */
    this.tally = {
      contacts: 0, treatments: 0, deployablesPlaced: 0, deployablesLost: 0,
      custodyLosses: 0, doorsOpened: 0, circuitsRestored: 0, sealAttempts: 0,
      peakPressure: 0, timeInBreachMs: 0, rescues: 0,
    };
  }

  atLeast(p) { return PHASE_ORDER.indexOf(this.phase) >= PHASE_ORDER.indexOf(p); }

  setPhase(p, simTimeMs, note = '') {
    if (this.phase === p) return false;
    this.phaseLog.push({ from: this.phase, to: p, simTimeMs, note });
    this.phase = p;
    return true;
  }

  get stage() {
    const th = CONFIG.pressure.stageThresholds;
    let s = 0;
    for (let i = 0; i < th.length; i++) if (this.pressure >= th[i]) s = i;
    return s;
  }

  get stageName() { return CONFIG.pressure.stageNames[this.stage]; }

  /**
   * @param {object} ctx {anomalyLoose, operativeDistance, activeEmitters, anomalyAwake}
   */
  stepPressure(stepMs, ctx) {
    if (!ctx.anomalyLoose) {
      /* Custody sheds pressure fast. Entering a controlled procedure phase is one of the
       * §5.4 relief conditions, and it is what makes the last two minutes survivable. */
      this.pressure = Math.max(0, this.pressure - (12 / 60000) * stepMs);
    } else {
      let perMin = CONFIG.pressure.perMinute;
      /* Withdrawal: far away, with nothing running, the situation settles. */
      if (ctx.operativeDistance > CONFIG.pressure.withdrawalDistanceM && ctx.activeEmitters === 0) {
        perMin = CONFIG.pressure.withdrawalPerMinute;
      }
      if (ctx.anomalyAwake) perMin += 1.6;
      this.pressure = Math.max(0, Math.min(CONFIG.pressure.max, this.pressure + (perMin / 60000) * stepMs));
    }
    if (this.pressure > this.tally.peakPressure) this.tally.peakPressure = this.pressure;
    if (this.stage >= 3) this.tally.timeInBreachMs += stepMs;
    return this.pressure;
  }

  /** Transitions the anomaly reports carry their own pressure delta, from content. */
  applyPressureDelta(d) {
    this.pressure = Math.max(0, Math.min(CONFIG.pressure.max, this.pressure + d * 4));
  }

  /* ── the debrief ─────────────────────────────────────────────────────────── */

  /**
   * Nine dimensions, each with a word and a one-line reason. The overall assessment is
   * derived from them — Exemplary / Controlled / Costly / Compromised / Failed (§6.4).
   */
  grade({ custody, extracted, players, player, ledger, deployables, simTimeMs, cargoIssued, cargoRecovered, instances = null }) {
    const squad = players && players.length ? players : [player];
    const lostPeople = squad.filter((p) => !p.alive);
    const downed = squad.filter((p) => p.alive && p.downed);
    const injured = squad.filter((p) => p.alive && p.injured);
    const leftBehind = extracted ? squad.filter((p) => p.alive && !p.extracted) : [];
    const claims = ledger.scoreClaims();
    const dims = [];
    const add = (name, word, why) => dims.push({ name, word, why });

    /**
     * ⚠ A DISTRIBUTED SET CAN BE SEALED INCOMPLETE, and this is the only place that says
     * so. Nothing in the field stops a squad closing the case on three of five — deliberately,
     * because a game that refused would be checking the answer for them and the stocktake
     * sheet would be decoration. So the debrief is where the account is settled, and
     * "Established" has to mean established over the whole set rather than over whatever
     * happened to be in the box.
     */
    const partial = instances && instances.candidates
      && instances.counted > 0 && instances.counted < instances.total;
    const setDetail = instances && instances.candidates
      ? ` ${instances.counted} of ${instances.total} recovered.` : '';
    add('Containment integrity',
      partial ? 'Partial'
        : custody === 'verified' ? 'Established' : custody === 'sealed' ? 'Unverified' : 'None',
      partial
        ? `The case was sealed on an incomplete set.${setDetail} What was left on the floor is still there.`
        : custody === 'verified'
          ? `Custody held ${(CONFIG.anomaly.custodyVerifySeconds)}s and the case left the floor.${setDetail}`
          : custody === 'sealed'
            ? 'The case was sealed but custody was never verified.'
            : 'The anomaly was still loose when the operation ended.');

    /* Reported for the SQUAD, and it names who — a debrief that says "Injured" when one
     * of four is on a stretcher and three walked out is not a debrief. */
    add('Personnel survival',
      lostPeople.length ? 'Lost' : downed.length ? 'Critical' : injured.length ? 'Injured' : 'Intact',
      lostPeople.length
        ? `${lostPeople.map((p) => p.name).join(', ')} did not come back. ${squad.length - lostPeople.length} of ${squad.length} extracted.`
        : downed.length
          ? `${downed.map((p) => p.name).join(', ')} came out on a stretcher.`
          : injured.length
            ? `${injured.map((p) => `${p.name} (exposure ${p.conditions.exposure.severity}, mobility ${p.conditions.mobility.severity}${p.conditions.exposure.stabilised || p.conditions.mobility.stabilised ? ', stabilised' : ', untreated'})`).join(' · ')}`
            : `All ${squad.length} clear. Nobody took a contact.`);

    if (this.tally.rescues || leftBehind.length) {
      add('Squad conduct',
        leftBehind.length ? 'Incomplete' : 'Sound',
        leftBehind.length
          ? `${leftBehind.map((p) => p.name).join(', ')} was still on the floor when the case went up the stairs.`
          : `${this.tally.rescues} casualt${this.tally.rescues === 1 ? 'y' : 'ies'} recovered under pressure.`);
    }

    add('Civilian outcome', 'Not applicable', 'The floor was already cleared before deployment.');

    const falseLeads = ledger.entries.filter((e) => e.isFalseLead).length;
    add('Evidence quality',
      claims.correct >= 4 && claims.wrong === 0 ? 'High' : claims.correct >= 2 ? 'Serviceable' : 'Thin',
      `${ledger.entries.length} observations logged, ${claims.correct} rules read correctly, ${claims.wrong} misread, ${falseLeads} false lead${falseLeads === 1 ? '' : 's'} recorded.`);

    add('Secrecy and exposure', 'Held', 'Sub-level operation; no surface exposure.');

    const lost = this.tally.deployablesLost;
    add('Equipment stewardship',
      lost === 0 ? 'Complete' : lost <= 2 ? 'Partial' : 'Poor',
      `${cargoRecovered} of ${cargoIssued} issued items recovered; ${lost} left on the floor.`);

    add('Infrastructure damage', 'None', `${this.tally.circuitsRestored} circuit${this.tally.circuitsRestored === 1 ? '' : 's'} restored, no structural damage.`);

    /**
     * ⚠ THIS GRADED THE DRAUGHT AND CALLED IT THE MISSION.
     *
     * It read `ledger.has('frost-boundary') && ledger.has('thermal-void')` — two of
     * `graybox-draught`'s evidence ids, written into the mission model — so an operation
     * against any of the other five anomalies could log every observation on the floor and
     * still be reported as Partial, for ever, with no way to move it. The debrief is the
     * one place a squad finds out what the operation was worth, and for five of six
     * incidents it was answering a question about a different anomaly.
     *
     * Graded on the fraction of the anomaly's own RULES the squad documented, which is
     * what "research completion" means in any file, and reported as the count so the
     * number can be argued with rather than taken.
     */
    const ruleIds = new Set();
    const documented = new Set();
    for (const r of ledger.rules.values()) {
      if (!r.revealsRule) continue;
      ruleIds.add(r.revealsRule);
      if (ledger.has(r.id)) documented.add(r.revealsRule);
    }
    const share = ruleIds.size ? documented.size / ruleIds.size : 0;
    add('Research completion',
      share >= 0.75 ? 'Substantial' : share >= 0.4 ? 'Partial' : 'Thin',
      `${documented.size} of ${ruleIds.size} rules documented; ${ledger.entries.length} of ${ledger.rules.size} observations logged.`);

    const mins = simTimeMs / 60000;
    add('Time to stabilisation',
      custody === 'verified' ? `${mins.toFixed(1)} min` : '—',
      `Peak pressure ${this.tally.peakPressure.toFixed(0)} (${CONFIG.pressure.stageNames[this.stage]}); ${(this.tally.timeInBreachMs / 1000).toFixed(0)}s above Active.`);

    /* The overall word. Custody is necessary but not sufficient for the top grade — GDD
     * §6.4: "a Costly success remains progress but generates consequences". */
    const everyoneOut = lostPeople.length === 0 && leftBehind.length === 0;
    let overall;
    /* ⚠ A partial set can never be Exemplary or Controlled however cleanly it was done.
     * The squad walked out of a building with two of the things still in it, and every
     * other dimension reading green is exactly the report that would let them believe the
     * operation was finished. */
    if (partial) overall = 'Compromised';
    else if (custody === 'verified' && extracted && everyoneOut && injured.length === 0 && downed.length === 0
      && lost === 0 && claims.wrong === 0) overall = 'Exemplary';
    else if (custody === 'verified' && extracted && lostPeople.length === 0) {
      overall = (injured.length || downed.length || lost > 0 || leftBehind.length) ? 'Costly' : 'Controlled';
    } else if (custody === 'verified' && !extracted) overall = 'Compromised';
    else if (lostPeople.length) overall = 'Failed';
    else overall = 'Compromised';

    return { overall, dims, claims };
  }
}
