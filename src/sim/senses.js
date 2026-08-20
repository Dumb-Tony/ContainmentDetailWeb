/* The closed vocabularies a content file is allowed to name — GDD §20.6.
 *
 * THE RULE, stated once: **a JSON key may name a QUANTITY, never an OPERATOR.** A content
 * file says `{ "sense": "heat-within", "radiusMetres": 12, "sustainSeconds": 4 }`. It does
 * not say how "within" is computed, and it cannot introduce a new way of computing it.
 * Every operator lives here, in code, under test. §20.6 puts it plainly: "complex behaviour
 * belongs in tested modules referenced by data, not arbitrary executable content".
 *
 * That constraint is why this file exists at all. The anomaly engine used to switch on
 * hard-coded trigger ids — `heat-detected`, `lock-on`, `heat-wall` — which meant the first
 * anomaly WAS the engine and a second one could not be written without editing it. GDD §15
 * wants an Incident Package to be a content unit; §23 Milestone 3 wants three of them
 * sharing one map. Neither is possible while the rules live in a switch statement.
 *
 * Adding a sense is deliberately a code change with a test. That is the point: a new
 * operator is a new thing the game can perceive, and §8.2 requires every rule to be
 * observable, consistent, actionable, communicable, composable and fair under latency.
 * A designer gets to combine them freely; they do not get to invent them in a JSON file.
 */

import { dist } from './geometry.js';

/**
 * Each entry is `{ poll(anomaly, when, ctx) => boolean, performed?: boolean }`.
 *
 * `performed: true` marks a sense that is NOT polled — it is satisfied by an operative
 * doing something (the seal). GDD §8.4: containment is a state the squad CREATES, and a
 * climax that happens to you is not a climax. Polling those would let custody establish
 * itself while everyone stood watching.
 */
export const SENSES = Object.freeze({
  /** Any heat source at all within a radius. The waking trigger: it does not care which. */
  'heat-within': {
    poll: (a, w, ctx) => ctx.sources.some((s) => dist(a.x, a.z, s.x, s.z) <= w.radiusMetres),
  },

  /** The one it has actually chosen, close enough to commit to. Reads `targetId`, so it
   *  inherits reachability for free — a target behind a 40C wall was never chosen. */
  'strongest-heat-within': {
    poll: (a, w, ctx) => {
      const t = ctx.target;
      return !!t && dist(a.x, a.z, t.x, t.z) <= w.radiusMetres;
    },
  },

  /**
   * ENCLOSURE, not obstruction. The content phrases this as "a continuous heat gradient
   * above 40C spans the anomaly's approach path", and the honest reading of that in a room
   * with more than one way out is: every way out is spanned. `isFenced` casts the rays;
   * this sense just reports the answer.
   *
   * ⚠ `thresholdCelsius` is carried in the content and consumed by the heat field, not
   * here. If you ever make this sense read it directly, the two will drift.
   */
  'path-blocked-by-gradient': { poll: (a) => a.fenced },

  /** The inverse, with a sustain: the fence has a hole and has had one for a while. */
  'gradient-below': { poll: (a) => !a.fenced },

  /** Satisfied by an operative closing a case around it. See `Anomaly.trySeal`. */
  'enclosed-by': { performed: true, poll: () => false },
});

/**
 * What a capability DOES. Same rule as the senses: the content names the verb and the
 * numbers, the code owns the meaning.
 *
 * Kept small on purpose. GDD §24 lists "scope expands through anomaly uniqueness" as a
 * CRITICAL risk and prescribes a shared containment grammar as the mitigation — every
 * capability a new anomaly wants should be a combination of these before it is a new one.
 */
export const EFFECT_VERBS = Object.freeze([
  /* Touching an operative applies the named conditions. Cooldown and compounding are
   * content; what a condition means is `Player.applyCondition`. */
  'contact',
  /* Leaves something on the floor that outlives the visit — ice, residue, a scorch. */
  'surface-hazard',
  /* Eats charge in a radius. Consumed by `DeployableSet.stepPower`, not by the anomaly. */
  'drain-power',
]);

/** Field disturbance kinds an anomaly's presence may impose on a scalar field. */
export const FIELD_KINDS = Object.freeze(['sink', 'source', 'none']);

export function isSense(name) { return Object.prototype.hasOwnProperty.call(SENSES, name); }
export function isPerformed(name) { return !!(SENSES[name] && SENSES[name].performed); }
