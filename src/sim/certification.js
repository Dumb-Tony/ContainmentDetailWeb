/* Base certification — GDD §18.6, the first of three training layers.
 *
 * ── THE CONSTRAINT, WHICH IS THE WHOLE DESIGN ────────────────────────────────
 *
 * §18.6 ends with one sentence that rules out almost every tutorial a game of this kind
 * would normally ship:
 *
 *     "Tutorials teach the reasoning pattern, not the solution to later anomalies."
 *
 * A tutorial that says "a sustained gradient above 40°C stops it" has handed over the answer
 * to the first incident and, worse, has taught a NUMBER where the game is about a METHOD.
 * §7.4 asks for confidence rather than checklist completion; the second incident then finds
 * a squad that memorised a threshold instead of learning to look, and the third finds them
 * unable to work at all. So nothing in `content/onboarding.json` names a rule, a threshold,
 * a distance or an anomaly. Every competency is a VERB the operative performs.
 *
 * ── IT CERTIFIES WHAT WAS DONE, NOT WHAT WAS READ ────────────────────────────
 *
 * Each competency names an event on the analytics bus and is satisfied by that event
 * happening the authored number of times. There is no acknowledgement step and no "press F
 * to continue", because a player who clicked through a panel has demonstrated nothing.
 *
 * The consequence is that certification can be earned during ordinary play by somebody who
 * never opened the training screen. That is the correct outcome and not a loophole: the
 * certificate records a competence, and a player who has deployed a floodlight and picked it
 * up again is competent at deploying floodlights whether or not they were told to be.
 *
 * ── IT GATES NOTHING ─────────────────────────────────────────────────────────
 *
 * §12.1: progression grants options, context and efficiency, never power. A certificate that
 * locked the mission board would be the base charging a player for a lesson they may not
 * need, and §18.6's third layer is a difficulty preset rather than a permission. `blocking`
 * is not a field here and must not become one.
 */

import { t as msg } from '../core/i18n.js';

/**
 * Load the competency document. Same URL discipline as content and locales: relative to
 * this module, so the build works at the site root and under a project path alike.
 */
export async function loadOnboarding(path = '../../content/onboarding.json') {
  const res = await fetch(new URL(path, import.meta.url).href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`onboarding: HTTP ${res.status}`);
  return validateOnboarding(await res.json());
}

/**
 * The document, loaded once at module scope, so nothing has to remember to load it.
 *
 * ⚠ SAME REASONING AS `core/i18n.js`, AND THE SAME FAILURE POSTURE. The alternative is a
 * line in an entry point that every future entry point has to repeat, and the failure when
 * somebody forgets is a feature that silently does nothing — which is the worst kind,
 * because it looks exactly like a feature that is working and has nothing to report.
 *
 * A failure here is NOT fatal: `DOCUMENT` stays null, `Game` skips certification entirely,
 * and the game runs. Certification is a record of competence and nothing gates on it, so
 * losing it costs a screen and never an operation. `loadError` says so out loud, and the
 * suite asserts it is null.
 */
export let DOCUMENT = null;
export let loadError = null;
try {
  DOCUMENT = await loadOnboarding();
} catch (e) {
  loadError = e;
  /* eslint-disable-next-line no-console */
  console.warn('[certification] competency document unavailable; certification is off.', e);
}

/**
 * Refuse a document that would certify nothing, or that would teach an answer.
 *
 * ⚠ THE SECOND CHECK IS THE UNUSUAL ONE AND IT IS THE POINT. A competency whose text names
 * a number is a competency that is teaching a threshold, and the whole file exists to not do
 * that. It cannot be enforced perfectly — prose is prose — but a digit followed by a unit is
 * exactly the shape of the thing §18.6 forbids, and catching the obvious case keeps the
 * intent visible to whoever edits this next.
 */
export function validateOnboarding(doc) {
  const problems = [];
  const layers = new Set((doc.layers || []).map((l) => l.id));
  if (!layers.size) problems.push('no layers');
  if (!(doc.competencies || []).length) problems.push('no competencies');

  const seen = new Set();
  for (const c of doc.competencies || []) {
    const at = `competency ${c.id || '(unnamed)'}`;
    if (!c.id) problems.push(`${at}: no id`);
    if (seen.has(c.id)) problems.push(`${at}: duplicate id`);
    seen.add(c.id);
    if (!c.event) problems.push(`${at}: names no event`);
    if (!layers.has(c.layer)) problems.push(`${at}: layer "${c.layer}" is not declared`);
    if (!(c.requires && c.requires.count > 0)) problems.push(`${at}: requires no count`);
    if (!c.displayName) problems.push(`${at}: no displayName`);
    if (!c.why) problems.push(`${at}: no why — a competency nobody can justify is a chore`);
    /* A threshold, a distance, a temperature or a duration in the prose. */
    const prose = `${c.displayName || ''} ${c.why || ''}`;
    const number = prose.match(/\b\d+(\.\d+)?\s*(°?[CF]\b|m\b|s\b|dB\b|%)/i);
    if (number) problems.push(`${at}: teaches a figure ("${number[0]}") — §18.6 forbids it`);
  }
  if (problems.length) throw new Error(`onboarding document: ${problems.join('; ')}`);
  return doc;
}

/**
 * Watches a game's bus and records which competencies have been demonstrated.
 *
 * Stateless about WHEN — it counts events and compares against the authored requirement, so
 * attaching it half way through an operation certifies what happens from then on and never
 * claims credit for what it did not see.
 */
export class Certification {
  /**
   * @param {object} doc      a validated onboarding document
   * @param {object} [earned] previously earned competency ids, from a profile
   */
  constructor(doc, earned = []) {
    this.doc = doc;
    this.counts = new Map();
    this.earned = new Set(earned);
    this._unsub = null;
    /** Competencies newly earned since the last `drain()`, in the order they were earned. */
    this._fresh = [];
  }

  /** Attach to a game's event bus. Returns an unsubscribe function. */
  watch(bus) {
    this.detach();
    this._unsub = bus.onAny((e) => this.record(e.type));
    return () => this.detach();
  }

  detach() { if (this._unsub) { this._unsub(); this._unsub = null; } }

  /** Count one event and earn anything it completes. */
  record(eventType) {
    const n = (this.counts.get(eventType) || 0) + 1;
    this.counts.set(eventType, n);
    for (const c of this.doc.competencies) {
      if (this.earned.has(c.id)) continue;
      if (c.event !== eventType) continue;
      if (n >= c.requires.count) { this.earned.add(c.id); this._fresh.push(c.id); }
    }
    return n;
  }

  /** Newly earned ids, and clears them — so a caller can announce each one exactly once. */
  drain() { const out = this._fresh; this._fresh = []; return out; }

  has(id) { return this.earned.has(id); }
  get complete() { return this.doc.competencies.every((c) => this.earned.has(c.id)); }

  /** Progress within one layer: {earned, total}. */
  layerProgress(layerId) {
    const inLayer = this.doc.competencies.filter((c) => c.layer === layerId);
    return { earned: inLayer.filter((c) => this.earned.has(c.id)).length, total: inLayer.length };
  }

  /**
   * What to show, in layer order.
   *
   * ⚠ IT REPORTS PROGRESS AND NEVER A NEXT STEP. "Now go and deploy a floodlight" is an
   * instruction, and an instruction is how a tutorial becomes a checklist — §7.4 again. The
   * screen says what has been demonstrated and what has not; working out how to demonstrate
   * the rest is the same skill the game is about.
   */
  rows() {
    const byOrder = [...this.doc.layers].sort((a, b) => (a.order || 0) - (b.order || 0));
    return byOrder.map((l) => ({
      ...l,
      ...this.layerProgress(l.id),
      competencies: this.doc.competencies.filter((c) => c.layer === l.id)
        .map((c) => ({ ...c, earned: this.earned.has(c.id) })),
    }));
  }

  /** For a profile. Only the ids: the document is content and may change under them. */
  encode() { return [...this.earned]; }

  /** One line for the base screen, localised. */
  summary() {
    const done = this.doc.competencies.filter((c) => this.earned.has(c.id)).length;
    return msg(this.complete ? 'certification.complete' : 'certification.progress',
      { earned: done, total: this.doc.competencies.length });
  }
}
