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

  /**
   * Nothing warm within a radius, for a while.
   *
   * ⚠ THE HEAT QUANTITY HAD NO "NOTHING" OPERATOR AND EVERY OTHER QUANTITY DID.
   *
   * Observation has `unobserved-for`, sound has `masked-for`, the gradient has
   * `gradient-below`, the distributed set has `set-clean`. Heat — the first quantity this
   * game ever measured, and the one four anomalies are built on — had only the positive
   * form. So a heat-based RESTRAINT had no way back: an author could say "it stops when
   * something warm is near" and could not say "and it starts again when the warmth leaves".
   * `netherfold-toll` hit this and built its exit out of the same positive sense with a
   * three-second sustain instead, which is a better rule than a negation would have been in
   * that one case and is not a general answer.
   *
   * The asymmetry was invisible because nothing had needed it for six anomalies, which is
   * exactly how a closed vocabulary develops a hole: the missing word is the one nobody has
   * tried to say yet.
   *
   * ⚠ IT IS NOT `!heat-within`. The sustain is the whole point — a restraint that released
   * on a single cold frame would release every time somebody walked behind a rack — and
   * §8.2's fair-under-latency argument is the same one `unobserved-for` makes: the
   * transition that COSTS the squad carries the sustain, so a flicker never decides it.
   * `sustainSeconds` is handled by the trigger machinery, as it is for every other sense
   * here; this reports the instantaneous fact and lets the sustain do its job.
   *
   * The operative's OWN body counts, because it is a heat source on the same field as
   * everything else and pretending otherwise would make "stand back" mean nothing.
   */
  'no-heat-within': {
    poll: (a, w, ctx) => !ctx.sources.some((s) => dist(a.x, a.z, s.x, s.z) <= w.radiusMetres),
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
   * ⚠ `thresholdCelsius` IS THE ANOMALY'S FIGURE, NOT THE ENGINE'S, and this comment used
   * to claim it was "carried in the content and consumed by the heat field" when nothing
   * consumed it at all. Every gradient test took `CONFIG.heat.gradientThresholdC`, so an
   * anomaly that authored a different number loaded clean and obeyed forty. A comment
   * asserting a thing that is false is worse than no comment: it tells the next reader not
   * to look. It is now read by `Anomaly.gradientThresholdC` and passed to `blocksPath` —
   * still not here, because `isFenced` casts the rays and this sense only reports.
   */
  'path-blocked-by-gradient': { poll: (a) => a.fenced },

  /** The inverse, with a sustain: the fence has a hole and has had one for a while. */
  'gradient-below': { poll: (a) => !a.fenced },

  /** Satisfied by an operative closing a case around it. See `Anomaly.trySeal`. */
  'enclosed-by': { performed: true, poll: () => false },

  /* ── perception (GDD §8.6, §11.2) ───────────────────────────────────────────
   * The second measurable quantity in the game, and the reason a second anomaly can be a
   * different PROCEDURE rather than the same one with different numbers. Heat is a field
   * you build walls out of; observation is a resource you have to keep pointed at
   * something while you do other work.
   *
   * ⚠ These two are deliberately NOT symmetric. `observed` fires the moment coverage
   * exists, so a fence of eyes closes as fast as a fence of heat. `unobserved` carries a
   * sustain in the content, so coverage that flickers — someone turning their head, a
   * camera that clipped a passing teammate — does not release it. §8.2 requires that
   * network delay never decides an exact-frame failure, and this is where that is paid. */
  observed: {
    poll: (a, w, ctx) => {
      const n = ctx.observation ? ctx.observation.count : 0;
      return n >= (w.viewers || 1);
    },
  },

  'unobserved-for': { poll: (a, w, ctx) => !ctx.observation || ctx.observation.count === 0 },

  /* ── the auditory field (GDD §26.2, "auditory lure and restraint") ──────────
   * The fourth measurable quantity, and the first one the SQUAD emits whether it means to
   * or not. Heat is something you place and observation is something you point; noise is
   * something you make, so being quiet is a playable state — and a loud source is a tool
   * as well as a hazard, because it masks everything quieter than itself. That is what
   * makes a lure a lure rather than just bait.
   *
   * ⚠ `!== undefined` RATHER THAN `||`. A level of 0 dB is a real reading and `||` would
   * turn it into "no reading at all" — the same falsy-zero trap `lastUsed.get(id) || -1e9`
   * fell into in anomaly.js, which handed a capability a free second use at sim-time zero. */
  'noise-above': {
    poll: (a, w, ctx) => !!ctx.sound && ctx.sound.levelDb !== undefined
      && ctx.sound.levelDb >= w.thresholdDb,
  },

  /** The source it has actually picked out of the noise, close enough to commit to. Reads
   *  `heard`, so it inherits masking for free — a lure drowned by a louder one was never
   *  chosen, exactly as a target behind a 40C wall was never chosen. */
  'loudest-noise-within': {
    poll: (a, w, ctx) => {
      const h = ctx.sound && ctx.sound.heard;
      return !!h && dist(a.x, a.z, h.x, h.z) <= w.radiusMetres;
    },
  },

  /** Nothing beats the room. The restraint half, and deliberately NOT symmetric with the
   *  one above: it carries a sustain in the content, so a lure that flickers at the
   *  threshold — a battery browning out, somebody walking between it and the thing — does
   *  not release it. The same asymmetry `observed`/`unobserved-for` has, paid for §8.2. */
  'masked-for': { poll: (a, w, ctx) => !ctx.sound || !ctx.sound.heard },

  /* ── the set (GDD §26.2, distributed-object recovery and verification) ──────
   * The third measurable quantity, and the first one that is a COUNT rather than a field.
   * Heat asks "how hot is it there", observation asks "is anyone looking", and this asks
   * "how many of them are accounted for" — which is why the third procedure family is a
   * different job and not the same job with different numbers.
   *
   * ⚠ `instances-accounted` IS NOT PERFORMED, and that is a real decision. The seal is
   * performed because §8.4 says containment must be a state the squad CREATES, and a
   * climax that happens to you is not a climax. But this sense is not the climax — the
   * seal still is. This only reports whether the arithmetic is finished, and it has to be
   * pollable so that the state can go BACK when somebody opens the case again. */
  'instances-accounted': {
    poll: (a, w, ctx) => {
      const set = ctx.instances;
      if (!set || !set.candidates) return false;
      if (w.requireClean !== false && set.contaminated) return false;
      const need = w.count === undefined ? set.total : w.count;
      return set.counted >= need;
    },
  },

  /** Something is still out there. The inverse, so a content file can telegraph on it
   *  rather than the engine deciding when to nag. */
  'instances-loose': {
    poll: (a, w, ctx) => {
      const set = ctx.instances;
      if (!set) return false;
      return set.list.filter((i) => i.anomalous && !i.deposited).length >= (w.count || 1);
    },
  },

  /** The wrong thing is in the box. A state a squad can be in for a long time without
   *  knowing, which is the point of it. */
  'set-contaminated': { poll: (a, w, ctx) => !!(ctx.instances && ctx.instances.contaminated) },

  /** ⚠ The inverse, and it exists because a rule needs a way BACK. The draught pairs
   *  `path-blocked-by-gradient` with `gradient-below` for exactly this reason: a state
   *  machine authored with only the entering transition is a trap, and the first version
   *  of the tally anomaly had one — contaminate the case once and the incident could never
   *  be completed again, even after the case had been turned out and refilled correctly.
   *  `validateAnomaly` now refuses a non-terminal state with no way out of it. */
  'set-clean': {
    poll: (a, w, ctx) => !!(ctx.instances && ctx.instances.candidates && !ctx.instances.contaminated),
  },
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

/** Which measurable quantity an anomaly MOVES TOWARD. Closed for the same reason the
 *  senses are: an anomaly may hunt a quantity the engine can compute, and may not invent
 *  one. Sensing a thing and walking to it are different questions and both are content. */
export const HUNT_KINDS = Object.freeze(['heat', 'sound', 'none']);

/** What an anomaly cannot cross. Also closed, and also NOT the same question as either of
 *  the two above: the draught senses heat, hunts heat and is stopped by heat, which made
 *  all three look like one property until an anomaly arrived that did none of them. */
export const BLOCK_KINDS = Object.freeze(['insulation', 'gradient']);

export function isSense(name) { return Object.prototype.hasOwnProperty.call(SENSES, name); }
export function isPerformed(name) { return !!(SENSES[name] && SENSES[name].performed); }
