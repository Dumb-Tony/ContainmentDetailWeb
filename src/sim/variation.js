/* Controlled variation — GDD §14.4.
 *
 * A scenario seed selects the eight things §14.4 lists: where the incident started, which
 * routes are shut, which power and comms are faulted, where the civilians are, which
 * evidence is on the floor and which source is the false lead, the weather and time, the
 * secondary hazard, and the anomaly's own parameters within approved bounds.
 *
 * TWO SENTENCES OF §14.4 ARE THE WHOLE DESIGN, and they are the last two:
 *
 *   "Critical procedure items always have redundant discovery paths."
 *   "Randomization must not generate unwinnable states."
 *
 * Everything here exists to obey them. A variation layer that can produce an operation
 * nobody can finish is worse than no variation at all — it is the same failure as a
 * content file that lies about a rule, arriving one seed in fifty and impossible to
 * reproduce from a bug report. So this module does not just choose; it CHECKS, and
 * `varyContent` returns problems the same way the content validators do.
 *
 * ⚠ THE BOUNDS ARE CONTENT AND THE CHOOSING IS CODE, which is the same split senses.js
 * makes for triggers. An incident file says "the origin may be any of these four" and
 * "these two circuits may start faulted"; it does not say how one is picked, and it cannot
 * introduce a new axis of variation. An incident that declares no `variation` block varies
 * in nothing and loads exactly as it did before — which is why this could be added without
 * touching a line of the four incidents that predate it.
 *
 * ⚠ AND THE EVIDENCE RULE IS THE SHARP ONE. §27.2 requires two evidence paths per rule and
 * the content now has them; variation may remove AT MOST ONE path for any given rule, never
 * both. That is what makes "critical procedure items always have redundant discovery paths"
 * true under a seed rather than only in the authored default — and it is why the two-paths
 * work was worth doing before this existed rather than after.
 *
 * No DOM, no renderer, no wall clock. Deterministic from the seed: the same seed produces
 * the same operation, six decimals, or a bug report is not reproducible.
 */

import { mulberry32, hashStr } from '../core/rng.js';

/** The eight axes §14.4 names. Closed, for the same reason the senses are. */
export const VARIATION_AXES = Object.freeze([
  'origin', 'routes', 'faults', 'civilians', 'evidence', 'weather', 'hazard', 'behaviour',
]);

/**
 * Weather, as a table rather than a number, because it has to reach three systems that
 * must not disagree: the ambient temperature the heat field starts at, the room tone the
 * sound field measures audibility against, and the sentence the briefing prints.
 *
 * ⚠ Ambient is NOT decoration here. Every contour radius in the game is
 * `d0·sqrt((peak-ambient)/(threshold-ambient) - 1)`, so two degrees of weather is a real
 * change in how much fence a floodlight buys — and the sound field's `ambientDb` is what
 * decides how far a footstep carries. A seed that says "wet" changes both, and the squad
 * has to notice.
 */
export const WEATHER = Object.freeze({
  still: { label: 'Still and dry', ambientDeltaC: 0, ambientDeltaDb: 0,
    line: 'Still, dry, nothing moving outside.' },
  cold: { label: 'Hard frost', ambientDeltaC: -3, ambientDeltaDb: -2,
    line: 'Hard frost since midnight. The floor is colder than the forecast said and quieter with it.' },
  wet: { label: 'Steady rain', ambientDeltaC: 1, ambientDeltaDb: 6,
    line: 'Steady rain on the roof. Warmer than it should be, and you cannot hear yourself think.' },
  wind: { label: 'Gusting', ambientDeltaC: -1, ambientDeltaDb: 3,
    line: 'Gusting hard from the north-east. Everything loose is making a noise.' },
});

/** Times of day, which change what the mains are doing and who is still on site. */
export const TIMES = Object.freeze({
  night: { label: 'Night', line: 'Small hours. Nobody on site but the person who called it in.' },
  dawn: { label: 'First light', line: 'First light. The site wakes up in about two hours whatever happens.' },
  day: { label: 'Daylight', line: 'Middle of the day. Two contractors are being kept off the floor for you.' },
});

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];

/**
 * Choose a variation for one incident and one seed. PURE — it reads the incident's declared
 * bounds and returns a plain record. It applies nothing and validates nothing.
 *
 * @returns {object} `{ seed, origin, routesShut, faults, civilians, dropped, falseLead,
 *   weather, time, hazard, behaviour }`
 */
export function chooseVariation(pack, seed = 'default') {
  const v = pack.incident.variation || {};
  const rand = mulberry32(hashStr(`${pack.incident.id}:${seed}`));
  const out = {
    seed: String(seed),
    origin: null, routesShut: [], faults: [], civilians: [],
    dropped: [], falseLead: null,
    weather: 'still', time: 'night', hazard: null, behaviour: {},
  };

  /* 1. Incident origin and anchor position. */
  if (Array.isArray(v.origins) && v.origins.length) out.origin = pick(rand, v.origins);

  /* 2. Locked, flooded, burned, collapsed or quarantined routes. A route is a door id the
   *    seed may shut and hold shut; the count is bounded by the content, never by this. */
  if (Array.isArray(v.routes) && v.routes.length) {
    const n = Math.min(v.routesShutMax === undefined ? 1 : v.routesShutMax, v.routes.length);
    const pool = v.routes.slice();
    for (let i = 0; i < n; i++) {
      if (!pool.length) break;
      out.routesShut.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
  }

  /* 3. Power and communication faults: a circuit that will not come up when thrown. */
  if (Array.isArray(v.faults) && v.faults.length) {
    const n = Math.min(v.faultsMax === undefined ? 1 : v.faultsMax, v.faults.length);
    const pool = v.faults.slice();
    for (let i = 0; i < n; i++) {
      if (!pool.length) break;
      out.faults.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
  }

  /* 4. Civilian locations and states — which witness is where, and whether they will talk. */
  if (Array.isArray(v.civilians) && v.civilians.length) {
    for (const c of v.civilians) {
      const at = Array.isArray(c.positions) && c.positions.length ? pick(rand, c.positions) : null;
      out.civilians.push({ id: c.id, at, state: Array.isArray(c.states) ? pick(rand, c.states) : 'present' });
    }
  }

  /* 5. Evidence subset and false lead. See the header: at most one path per rule. */
  if (Array.isArray(v.droppable) && v.droppable.length) {
    const n = Math.min(v.dropMax === undefined ? 1 : v.dropMax, v.droppable.length);
    const pool = v.droppable.slice();
    for (let i = 0; i < n; i++) {
      if (!pool.length) break;
      out.dropped.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
  }
  if (Array.isArray(v.falseLeads) && v.falseLeads.length) out.falseLead = pick(rand, v.falseLeads);

  /* 6. Weather and time. */
  out.weather = Array.isArray(v.weather) && v.weather.length ? pick(rand, v.weather) : 'still';
  out.time = Array.isArray(v.times) && v.times.length ? pick(rand, v.times) : 'night';

  /* 7. Secondary hazard package. */
  if (Array.isArray(v.hazards) && v.hazards.length) out.hazard = pick(rand, v.hazards);

  /* 8. Anomaly behaviour, within approved bounds.
   *
   * ⚠ WITHIN BOUNDS THE CONTENT DECLARES, and the bounds are a BAND rather than a
   * multiplier this file invents. §8.2 requires a rule to be consistent and communicable;
   * a seed that could put a speed anywhere would make the anomaly a different anomaly, and
   * the squad's evidence about the last one would be worthless. */
  for (const [k, band] of Object.entries(v.behaviour || {})) {
    if (!Array.isArray(band) || band.length !== 2) continue;
    const [lo, hi] = band;
    out.behaviour[k] = lo + rand() * (hi - lo);
  }
  return out;
}

/**
 * Apply a chosen variation to a bound content pack, and CHECK IT.
 *
 * Returns `{ pack, problems }`. Problems are phrased like the content validators' because
 * they are the same kind of thing: a statement that this operation cannot be finished, made
 * before anybody deploys into it rather than twenty minutes in.
 */
export function applyVariation(pack, v) {
  const problems = [];
  const map = { ...pack.map };

  /* 1. Origin. */
  if (v.origin) map.anomalySpawn = v.origin.slice();

  /* 5. Evidence. Drop the named sources, then check what survives.
   *
   * ⚠ THE CHECK IS PER RULE, NOT PER SOURCE. Dropping two sources is fine; dropping the
   * only two that reveal the same rule is not, and the difference is invisible in a list
   * of ids. This is the sentence in §14.4 that the whole module is arranged around. */
  const dropped = new Set(v.dropped);
  map.evidenceSources = (pack.map.evidenceSources || []).filter((s) => !dropped.has(s.evidenceId));

  const rulePaths = new Map();
  for (const e of pack.anomaly.evidenceRules) {
    if (!e.revealsRule) continue;
    if (!rulePaths.has(e.revealsRule)) rulePaths.set(e.revealsRule, { total: 0, left: 0 });
    const r = rulePaths.get(e.revealsRule);
    r.total++;
    /* A rule is still discoverable if any of its paths is either on the floor as a static
     * source, or is a live observation the game generates rather than places. */
    const placed = map.evidenceSources.some((s) => s.evidenceId === e.id);
    const live = !(pack.map.evidenceSources || []).some((s) => s.evidenceId === e.id);
    if (placed || live) r.left++;
  }
  for (const [rule, r] of rulePaths) {
    if (r.left === 0) problems.push(`variation "${v.seed}" removes every discovery path for rule ${rule} (§14.4: critical procedure items always have redundant discovery paths)`);
  }

  /* 6. Weather, into both fields and the briefing. */
  const w = WEATHER[v.weather] || WEATHER.still;
  const t = TIMES[v.time] || TIMES.night;

  const incident = {
    ...pack.incident,
    briefing: pack.incident.briefing ? {
      ...pack.incident.briefing,
      known: [
        ...(pack.incident.briefing.known || []),
        { text: `${w.label}. ${w.line}`, confidence: 'probable' },
        { text: `${t.label}. ${t.line}`, confidence: 'probable' },
      ],
    } : pack.incident.briefing,
  };

  /* 2, 3, 7 and 8 are applied to the live Game rather than to the document, because they
   * are about state rather than geometry. `Game.applyVariation` does that; the record
   * travels on the pack so it is available to whoever builds one. */
  return {
    pack: { ...pack, map, incident, variation: v, weather: w, time: t },
    problems,
  };
}

/** Choose and apply in one call, which is what the loader wants. */
export function varyContent(pack, seed) {
  const v = chooseVariation(pack, seed);
  return applyVariation(pack, v);
}
