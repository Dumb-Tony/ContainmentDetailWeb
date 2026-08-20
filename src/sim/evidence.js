/* The evidence ledger and the hypothesis board — GDD §7.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE (§7.2): the ledger records the RAW OBSERVATION and
 * its provenance. It does not record conclusions. "Motion sensor activated while the
 * camera view was obstructed" is an entry; "evidence: moves while unseen" is not. Every
 * `rawObservation` string here is read from the content file rather than written in code,
 * so the thing the player reads in the log is literally the thing the designer authored.
 *
 * Interpretation lives one layer up, on the board, and it belongs to the player. The board
 * holds CLAIMS. Evidence raises or lowers a claim's support; nothing here ever ticks a
 * claim true on the player's behalf, and contradictions stay visible instead of being
 * quietly resolved (§7.4).
 *
 * Append-only. An entry is never edited or deleted — a contaminated sample is recorded as
 * contaminated, which is a fact about the operation and belongs in the debrief.
 */

import { dist } from './geometry.js';

/** The claims the board can hold. Each names the rule it is about, so the debrief can say
 *  which rules the squad actually worked out. `truth` is what the simulation does; it is
 *  never shown before the debrief and never used to auto-resolve a claim. */
export const CLAIMS = Object.freeze([
  /* ⚠ THE BOARD HAS TO KNOW ABOUT THE EVIDENCE THAT EXISTS. `supportFor` returns "strong"
   * only on two hits with a confirmed one among them, so a claim listing a single source
   * was permanently stuck below strong however carefully a squad worked — and two of these
   * listed exactly one. GDD §27.2 asks for two evidence paths per rule and the content now
   * has them; a board that had not been told is a board that quietly disagrees with the
   * ledger about what the squad has proved. */
  { id: 'claim-heat-hunts', dimension: 'trigger',
    text: 'It moves toward the strongest heat it can reach.',
    truth: true, supportedBy: ['survivor-account', 'thermal-void', 'frost-bloom', 'lantern-pair', 'chart-recorder'] },
  { id: 'claim-gradient-blocks', dimension: 'constraint',
    text: 'A sustained heat gradient above 40C stops it dead.',
    truth: true, supportedBy: ['frost-boundary', 'frost-bloom', 'ambulance-transcript'] },
  { id: 'claim-insulation-blocks', dimension: 'constraint',
    text: 'Closed-cell insulation stops it. Steel racking does not.',
    truth: true, supportedBy: ['frost-boundary', 'thermal-void'] },
  { id: 'claim-thermal-visible', dimension: 'form',
    text: 'Thermal imaging sees it in every state. There is no stealth phase.',
    truth: true, supportedBy: ['thermal-void', 'crew-imager'] },
  { id: 'claim-drains-batteries', dimension: 'capability',
    text: 'It drains battery-powered equipment near it.',
    truth: true, supportedBy: ['battery-drain', 'spent-cells'] },
  { id: 'claim-chiller-anchor', dimension: 'anchor',
    text: 'The failed chiller is the anchor. Kill the chiller and it disperses.',
    truth: false, supportedBy: ['maintenance-log'] },
  { id: 'claim-airflow-carries', dimension: 'trigger',
    text: 'It travels on the building airflow and follows the ductwork.',
    truth: false, supportedBy: ['stairwell-draught'] },
]);

export class EvidenceLedger {
  constructor(anomalyDef) {
    this.rules = new Map(anomalyDef.evidenceRules.map((e) => [e.id, e]));
    this.reset();
  }

  reset() {
    /** Append-only. */
    this.entries = [];
    this._seen = new Set();
    /** claimId -> 'believed' | 'excluded' | null. The player's own reading. */
    this.claimState = new Map(CLAIMS.map((c) => [c.id, null]));
  }

  has(evidenceId) { return this._seen.has(evidenceId); }

  /**
   * Record one observation.
   * @returns {object|null} the entry, or null if this observation is already logged
   */
  record(evidenceId, { simTimeMs, x, z, room, source, integrity = 'clean' }) {
    if (this._seen.has(evidenceId)) return null;
    const rule = this.rules.get(evidenceId);
    if (!rule) return null;
    this._seen.add(evidenceId);
    const entry = {
      seq: this.entries.length + 1,
      evidenceId,
      /* Straight from content. Not paraphrased, not interpreted. */
      raw: rule.rawObservation,
      type: rule.type,
      dimension: rule.dimension,
      reliability: rule.reliability,
      isFalseLead: !!rule.isFalseLead,
      simTimeMs, x, z, room, source, integrity,
      annotation: '',
    };
    this.entries.push(entry);
    return entry;
  }

  annotate(seq, text) {
    const e = this.entries.find((x) => x.seq === seq);
    if (e) e.annotation = String(text).slice(0, 160);
    return !!e;
  }

  setClaim(claimId, state) {
    if (!this.claimState.has(claimId)) return false;
    this.claimState.set(claimId, state);
    return true;
  }

  /**
   * Qualitative support for a claim. Never a percentage — GDD §7.4 keeps the number
   * hidden and shows a word, because a number invites optimising the meter instead of
   * reading the site.
   */
  supportFor(claim) {
    const hits = claim.supportedBy.filter((id) => this._seen.has(id));
    if (hits.length === 0) return { word: 'no support', hits };
    const best = hits
      .map((id) => this.rules.get(id))
      .reduce((a, b) => (RELIABILITY_RANK[b.reliability] > RELIABILITY_RANK[a.reliability] ? b : a));
    if (hits.length >= 2 && best.reliability === 'confirmed') return { word: 'strong', hits };
    if (best.reliability === 'confirmed') return { word: 'confirmed observation', hits };
    if (best.reliability === 'probable') return { word: 'probable', hits };
    if (best.reliability === 'disputed') return { word: 'disputed', hits };
    return { word: 'unreliable', hits };
  }

  /** Claims the player marked believed that the simulation does not obey, and vice versa.
   *  Debrief only (§6.4 evidence quality). */
  scoreClaims() {
    let correct = 0, wrong = 0, unmarked = 0;
    for (const c of CLAIMS) {
      const s = this.claimState.get(c.id);
      if (s === null) { unmarked++; continue; }
      const believed = s === 'believed';
      if (believed === c.truth) correct++; else wrong++;
    }
    return { correct, wrong, unmarked, total: CLAIMS.length };
  }
}

const RELIABILITY_RANK = { unreliable: 0, disputed: 1, probable: 2, confirmed: 3 };

/* ── field detectors ──────────────────────────────────────────────────────────
 * Each answers "has the squad just observed this, and how". They take world state and
 * return an evidence id or null. They never write to the ledger themselves — the caller
 * does, with the provenance attached, so there is exactly one writer. */

/** A static source on the map, close enough to examine. */
/**
 * The NEAREST static source within reach, skipping any the caller does not want.
 *
 * ⚠ RETURNING THE FIRST HIT IN ARRAY ORDER MADE ARRAY POSITION A GAMEPLAY PROPERTY, and it
 * is half of the bug class that has now bitten this project three times. Of two sources
 * inside `reach` of each other, the earlier one in the JSON answered for both — and once
 * it was logged, the later one had NO VERB AT ALL, because `contextAction` only offers an
 * evidence candidate the ledger does not already hold. Two shipped pairs were in exactly
 * that state and neither had ever been stood on.
 *
 * The `skip` predicate is the part that matters. Without it a logged nearest source still
 * swallows the one behind it, which is the same bug one step further along.
 */
export function sourceInReach(site, x, z, reach, skip = null) {
  let best = null, bestD = Infinity;
  for (const s of site.doc.evidenceSources || []) {
    const d = dist(x, z, s.at[0], s.at[1]);
    if (d <= reach && d < bestD && !(skip && skip(s))) { best = s; bestD = d; }
  }
  return best;
}

/** `thermal-void`: the imager held on the mass long enough to see it hold its shape. */
export function thermalVoidObserved(imagerActive, anomaly, player, holdMs) {
  if (!imagerActive || !anomaly.isLoose) return false;
  if (dist(player.x, player.z, anomaly.x, anomaly.z) > 16) return false;
  return holdMs >= 2000;
}

/**
 * `frost-boundary`: the frost edge stopping dead at a gradient. Only observable when the
 * draught is actually being held by heat — which is why it is the one piece of evidence a
 * team cannot collect by walking around, and why it usually arrives on the first attempt
 * that half-works.
 */
export function frostBoundaryObserved(anomaly, player, sightRange = 9) {
  if (!anomaly.isLoose) return false;
  if (!(anomaly.fenced || anomaly.blockedThisStep)) return false;
  return dist(player.x, player.z, anomaly.x, anomaly.z) <= sightRange;
}

/** `battery-drain`: two powered items in the same room shedding charge far above rated. */
export function batteryDrainObserved(deployables, anomaly) {
  if (!anomaly.isAwake) return false;
  const inRange = deployables.list.filter(
    (d) => d.batteryMaxMs > 0 && d.on && dist(d.x, d.z, anomaly.x, anomaly.z) <= 5,
  );
  return inRange.length >= 2;
}
