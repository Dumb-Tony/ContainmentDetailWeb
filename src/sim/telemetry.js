/* One operation, reduced to the answers GDD §21.1 asks for — and nothing else.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * §21.2's core events all fire and ride an event bus that keeps the last 256 of them.
 * §21.1 lists seven questions telemetry "should answer". §21.3 gives six balance targets.
 * And §23 Milestone 5 asks for "external balance and onboarding tests", which cannot be run
 * at all unless somebody can take something away from a session.
 *
 * Nothing collected any of it. The events existed, the questions existed, and there was no
 * step in between — so every §26.4 criterion about players reads OPEN, and would still read
 * OPEN after a hundred playtests, because a facilitator watching over a shoulder is not
 * data and a bus log that dies with the tab is not either.
 *
 * ── WHAT IT REFUSES TO CARRY, AND WHY THAT IS THE HARD PART ───────────────────
 *
 * §21.2 ends with a prohibition, and a telemetry file is exactly where a prohibition gets
 * quietly lost: **no free text and no personal data**. The one piece of free text in this
 * game is a callsign somebody typed. So this file:
 *
 *   · never reads a name, from anywhere;
 *   · identifies operatives by SEAT (`p1`…`p5`), which is a position in a squad and not a
 *     person, and which is already what the analytics bus carries;
 *   · takes no `NOTICE`, because notices are prose written for a player — the bus does not
 *     even keep them, deliberately;
 *   · carries no comms phrase TEXT, only phrase ids from a closed vocabulary;
 *   · and is asserted against all of that by `tools/telemetry-tests.js`, which greps the
 *     produced record for every callsign in the session rather than trusting this comment.
 *
 * ⚠ IT IS ALSO NOT A REPORTER. Nothing here posts anywhere. The build contacts exactly one
 * network host — the signalling broker, documented in `assets/lib/NOTICE.md` — and a
 * telemetry endpoint would make that claim false. What this produces is a value; handing it
 * to somebody is a separate decision a human makes, and `main.js` exposes it as something
 * you can copy rather than something that leaves on its own.
 *
 * ── WHAT IT CANNOT ANSWER ────────────────────────────────────────────────────
 *
 * Three of §21.1's seven are about what people THOUGHT — "are failures perceived as fair",
 * "where do teams form their first useful hypothesis" in the sense of the moment it clicked,
 * and whether a team can name the decisive mistake. Those need interviews. This file reports
 * the observable half and says which half that is, rather than producing a number that looks
 * like an answer to a question it did not ask.
 */

import { EVENTS } from '../game.js';
import { PHASE } from './mission.js';

/** Events that may appear in a record. Anything not on this list is dropped, by name. */
export const RECORDED = Object.freeze([
  EVENTS.PHASE_CHANGED, EVENTS.SQUAD_CHANGED,
  EVENTS.EQUIPMENT_SELECTED, EVENTS.DEPLOYED, EVENTS.RETRIEVED, EVENTS.BATTERY_DEAD,
  EVENTS.EVIDENCE_LOGGED, EVENTS.HYPOTHESIS_CHANGED,
  EVENTS.PROCEDURE_COMMITTED, EVENTS.PROCEDURE_REVISED,
  EVENTS.ANOMALY_STATE_CHANGED, EVENTS.CONTACT,
  EVENTS.OPERATIVE_DOWNED, EVENTS.OPERATIVE_REVIVED, EVENTS.OPERATIVE_LOST,
  EVENTS.OPERATIVE_EXTRACTED,
  EVENTS.SEAL_ATTEMPT, EVENTS.CUSTODY_VERIFIED, EVENTS.CUSTODY_LOST,
  EVENTS.CIRCUIT_CHANGED, EVENTS.DOOR_CHANGED,
  EVENTS.INSTANCE_LOGGED, EVENTS.SET_PURGED,
  EVENTS.DIRECTIVE_OUTCOME, EVENTS.MISSION_ENDED,
]);

/**
 * Field names a record may carry. Everything else is dropped.
 *
 * ⚠ AN ALLOW-LIST AND NOT A DENY-LIST, because a deny-list is wrong the first time somebody
 * adds a field. `id` is a seat, `name` is a person, and only one of those is on this list —
 * which is the whole §21.2 prohibition expressed as eleven words.
 */
const KEEP = new Set([
  'id', 'seat', 'itemId', 'uid', 'slot', 'evidenceId', 'claimId', 'value',
  'from', 'to', 'trigger', 'phase', 'count', 'counted', 'n', 'on', 'open',
  'extracted', 'joined', 'kitLeftBehind', 'contacts', 'why',
]);

const clean = (evt) => {
  const out = { t: evt.type, ms: Math.round(evt.simTimeMs || 0) };
  for (const k of Object.keys(evt)) {
    if (k === 'type' || k === 'simTimeMs') continue;
    if (!KEEP.has(k)) continue;
    const v = evt[k];
    /* Only scalars. An object could carry anything, including a name somebody nested. */
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
  }
  return out;
};

/** Phase boundaries, from the mission's own log rather than reconstructed. */
function phaseSpans(mission, endedMs) {
  const spans = [];
  for (let i = 0; i < mission.phaseLog.length; i++) {
    const e = mission.phaseLog[i];
    const next = mission.phaseLog[i + 1];
    spans.push({ phase: e.to, fromMs: Math.round(e.simTimeMs), toMs: Math.round(next ? next.simTimeMs : endedMs) });
  }
  return spans;
}

/**
 * Reduce one Game to a record.
 *
 * @param {Game} game
 * @param {object} [opts] `{ build, locale, difficulty }` — context the sim does not own.
 * @returns {object} plain JSON, safe to hand to a person
 */
export function sessionRecord(game, opts = {}) {
  const m = game.mission;
  const endedMs = m.endedMs || game.clock.simTimeMs;
  const events = game.bus.log.filter((e) => RECORDED.includes(e.type)).map(clean);
  const spans = phaseSpans(m, endedMs);

  const span = (phase) => spans.filter((s) => s.phase === phase)
    .reduce((n, s) => n + (s.toMs - s.fromMs), 0);
  const containmentMs = span(PHASE.CONTAINMENT_ACTIVE) + span(PHASE.CUSTODY_ESTABLISHED);

  const claims = game.ledger.scoreClaims();
  const revisions = events.filter((e) => e.t === EVENTS.PROCEDURE_REVISED).length;
  const changes = events.filter((e) => e.t === EVENTS.HYPOTHESIS_CHANGED).length;

  /* §21.1 "which role lacks meaningful work": contributions PER SEAT, from events that
   * carry one. A seat with none is the question being answered, so seats with zero are
   * listed rather than omitted — an absent row reads as "no data" and this is data. */
  const perSeat = {};
  for (const p of game.players) perSeat[p.id] = 0;
  for (const e of events) if (e.id && Object.prototype.hasOwnProperty.call(perSeat, e.id)) perSeat[e.id]++;

  return {
    schema: 'containment-detail/session/1',
    build: opts.build || null,
    locale: opts.locale || null,
    incident: (game.content.incident && game.content.incident.id) || null,
    anomaly: game.anomaly.def.id,
    map: game.site.id,
    seed: game.seedLabel,
    scenarioSeed: (game.content.variation && game.content.variation.seed) || null,
    squadSize: game.players.length,

    /* §21.1: how long does each part take. */
    durationMs: Math.round(endedMs),
    phases: spans,
    /* §21.3: "containment phase duration: 15-25% of mission time". Reported as the fraction
     * it is, so nobody has to divide two numbers from different screens. */
    containmentMs,
    containmentShare: endedMs > 0 ? containmentMs / endedMs : 0,

    /* §21.1: which evidence is found, ignored or misunderstood. */
    evidence: {
      logged: game.ledger.entries.length,
      available: game.ledger.rules.size,
      falseLeads: game.ledger.entries.filter((e) => e.isFalseLead).length,
      claimsCorrect: claims.correct,
      claimsWrong: claims.wrong,
    },

    /* §21.1: how often do teams revise a procedure. */
    procedure: {
      committed: events.some((e) => e.t === EVENTS.PROCEDURE_COMMITTED),
      revisions,
      aborts: m.abortCount,
      hypothesisChanges: changes,
    },

    /* §21.1: what causes containment faults. Every transition already carries its trigger. */
    outcome: {
      overall: game.result ? game.result.overall : null,
      custody: game.custody,
      extracted: !!game.extracted,
      custodyLosses: m.tally.custodyLosses,
      contacts: m.tally.contacts,
      downed: events.filter((e) => e.t === EVENTS.OPERATIVE_DOWNED).length,
      lost: events.filter((e) => e.t === EVENTS.OPERATIVE_LOST).length,
      peakPressure: Math.round(m.tally.peakPressure),
      deployablesLost: m.tally.deployablesLost,
    },

    perSeatContributions: perSeat,
    events,

    /* ⚠ SAID OUT LOUD, IN THE RECORD ITSELF. Three of §21.1's seven questions are about what
     * people thought, and no file can answer those. A record that quietly omitted them would
     * read, to somebody totalling up a playtest, as though the set were complete. */
    unanswerable: [
      'Are failures perceived as fair? — needs a post-test interview.',
      'Where does a team form its first useful hypothesis? — the board records WHEN a claim '
        + 'was marked, not when it was understood.',
      'Can a failed team name the decisive mistake? — needs a post-test interview.',
    ],
  };
}

/** The record as a string a person can paste somewhere. */
export function sessionRecordText(game, opts = {}) {
  return JSON.stringify(sessionRecord(game, opts), null, 2);
}
