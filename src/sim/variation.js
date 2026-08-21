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
import { t as msg } from '../core/i18n.js';

/**
 * A weather or time-of-day row, with its words read from the message table.
 *
 * ⚠ THE KEY IS THE ID AND THE LABEL IS NOT. `still`, `cold`, `wet`, `wind` are what a seed
 * chooses, what `applyVariation` compares against and what a saved profile records for
 * §13's archive; the LABEL and the LINE are prose and belong in content/locales. Accessors
 * rather than a spread, for the reason audio.js records: `{ ...row }` copies a getter's
 * value at module load, which would freeze English at boot with nothing failing.
 */
const worded = (group, id, row) => Object.freeze(Object.defineProperties({ ...row }, {
  label: { get: () => msg(`${group}.${id}.label`), enumerable: true },
  line: { get: () => msg(`${group}.${id}.line`), enumerable: true },
}));

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
  still: worded('weather', 'still', { ambientDeltaC: 0, ambientDeltaDb: 0 }),
  cold: worded('weather', 'cold', { ambientDeltaC: -3, ambientDeltaDb: -2 }),
  wet: worded('weather', 'wet', { ambientDeltaC: 1, ambientDeltaDb: 6 }),
  wind: worded('weather', 'wind', { ambientDeltaC: -1, ambientDeltaDb: 3 }),
});

/** Times of day, which change what the mains are doing and who is still on site. */
export const TIMES = Object.freeze({
  night: worded('time', 'night', {}),
  dawn: worded('time', 'dawn', {}),
  day: worded('time', 'day', {}),
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

  /**
   * ⚠ A "MAX" THAT IS ALWAYS TAKEN IS A QUOTA, AND FIVE SHIPPED LISTS WERE CONSTANTS.
   *
   * `routesShutMax`, `faultsMax` and `dropMax` read as caps and behaved as quotas: the
   * count was `min(max, list.length)` and every seed took exactly that many. So a list
   * whose length equals its max varies NOTHING — neither which nor how many — and four
   * incidents shipped one: `cold-storage-draught` on both routes and faults,
   * `cold-storage-figure`, `ashlar-gallery-draught` and `blackthorn-caller` on faults. Each
   * of them jams the same door and faults the same circuit on every seed the game can
   * generate, while reading as an axis in the file and being counted as one.
   *
   * Drawing 0..n makes the word mean what it says, and it makes "nothing went wrong with
   * the building tonight" a world the seed can produce — which §14.4 wants and which no
   * shipped incident could reach.
   */
  const take = (list, max) => {
    const n = Math.min(max === undefined ? 1 : max, list.length);
    const want = Math.floor(rand() * (n + 1));
    const pool = list.slice();
    const out2 = [];
    for (let i = 0; i < want && pool.length; i++) {
      out2.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
    return out2;
  };

  /* 2. Locked, flooded, burned, collapsed or quarantined routes. A route is a door id the
   *    seed may shut and hold shut; the count is bounded by the content, never by this. */
  if (Array.isArray(v.routes) && v.routes.length) out.routesShut = take(v.routes, v.routesShutMax);

  /* 3. Power and communication faults: a circuit that will not come up when thrown. */
  if (Array.isArray(v.faults) && v.faults.length) out.faults = take(v.faults, v.faultsMax);

  /* 4. Civilian locations and states — which witness is where, and whether they will talk. */
  if (Array.isArray(v.civilians) && v.civilians.length) {
    for (const c of v.civilians) {
      const at = Array.isArray(c.positions) && c.positions.length ? pick(rand, c.positions) : null;
      out.civilians.push({ id: c.id, at, state: Array.isArray(c.states) ? pick(rand, c.states) : 'present' });
    }
  }

  /* 5. Evidence subset and false lead. See the header: at most one path per rule. */
  if (Array.isArray(v.droppable) && v.droppable.length) out.dropped = take(v.droppable, v.dropMax);
  /* A false lead is drawn the same way, and may be NONE: a single-entry list picked from
   * unconditionally is a constant, and four incidents had one. A night with nothing
   * misleading on the floor is a different night, and the seed should be able to make it. */
  if (Array.isArray(v.falseLeads) && v.falseLeads.length) out.falseLead = take(v.falseLeads, 1)[0] || null;

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

  /* 1. Origin.
   *
   * ⚠ AND IT MUST BE SOMEWHERE A BODY FITS. An origin inside a wall is not a hard-to-reach
   * anomaly, it is one that is pre-fenced at zero escape rays and cannot be lured, walked
   * to or sealed — an unwinnable state arriving one seed in four with nothing to say it
   * had. Author coordinates that look perfectly reasonable on a floor plan and are inside a
   * pallet stack; one of the four I wrote for the figure incident was, and the seed sweep
   * is what found it.
   *
   * The test is deliberately here rather than in `validateMap`, and cheaply: a rect
   * containment check against the statics, with the operative's own radius, needs no Site
   * and runs once at load. */
  if (v.origin) {
    const [ox, oz] = v.origin;
    const R = 0.34;
    const stuck = (map.statics || []).some((r) =>
      ox > r[0] - R && ox < r[2] + R && oz > r[1] - R && oz < r[3] + R);
    if (stuck) {
      problems.push(`variation "${v.seed}" starts the incident at [${ox}, ${oz}], which is inside the geometry — it could not be reached, lured or sealed (§14.4: randomization must not generate unwinnable states)`);
    }
    map.anomalySpawn = v.origin.slice();
  }

  /* 4. Civilians. A witness IS an evidence source on this floor, so moving one moves where
   * the squad has to go to hear it, and a witness who will not talk removes a path.
   *
   * ⚠ WHICH IS WHY IT GOES THROUGH THE SAME PER-RULE CHECK BELOW rather than having its own.
   * "The supervisor has gone home" and "the chart recorder was never installed" are the same
   * event as far as §14.4's redundant-discovery promise is concerned, and giving civilians a
   * separate path would be a second place for that promise to be broken. */
  let sources = (pack.map.evidenceSources || []).slice();
  for (const c of v.civilians || []) {
    const i = sources.findIndex((s) => s.evidenceId === c.id);
    if (i < 0) continue;
    if (c.state === 'absent') { sources.splice(i, 1); continue; }
    const moved = { ...sources[i] };
    if (c.at) moved.at = c.at.slice();
    if (c.state === 'shaken') moved.prompt = `${moved.prompt} — they are not keen`;
    sources[i] = moved;
  }

  /* 5. Evidence. Drop the named sources, then check what survives.
   *
   * ⚠ THE CHECK IS PER RULE, NOT PER SOURCE. Dropping two sources is fine; dropping the
   * only two that reveal the same rule is not, and the difference is invisible in a list
   * of ids. This is the sentence in §14.4 that the whole module is arranged around. */
  const dropped = new Set(v.dropped);
  map.evidenceSources = sources.filter((s) => !dropped.has(s.evidenceId));

  const rulePaths = new Map();
  for (const e of pack.anomaly.evidenceRules) {
    if (!e.revealsRule) continue;
    if (!rulePaths.has(e.revealsRule)) rulePaths.set(e.revealsRule, { total: 0, left: 0 });
    const r = rulePaths.get(e.revealsRule);
    r.total++;
    /* A rule is still discoverable if any of its paths is either on the floor as a static
     * source, or is a live observation the game generates rather than places.
     *
     * ⚠ "NOT AUTHORED ON THIS FLOOR" IS NOT THE SAME STATEMENT AS "GENERATED BY PLAY", and
     * this read the first while meaning the second. It held only while the sole unplaced
     * entries were the earned ones. An anomaly is shared between packages, so the moment it
     * shipped an entry written for a DIFFERENT floor — a contractor's permit book that
     * exists in Ashlar House and nowhere in a cold store — that entry counted as a
     * surviving path on every floor that does not place it, and a seed could strip a rule
     * bare while this reported it had one left. An entry is reachable when it is on the
     * floor or when the engine earns it. There is no third way in, and `earnedBy` is the
     * only thing that says which. */
    const placed = map.evidenceSources.some((s) => s.evidenceId === e.id);
    const live = !!e.earnedBy;
    if (placed || live) r.left++;
  }
  for (const [rule, r] of rulePaths) {
    if (r.left === 0) problems.push(`variation "${v.seed}" removes every discovery path for rule ${rule} (§14.4: critical procedure items always have redundant discovery paths)`);
  }

  /* 6. Weather, into both fields and the briefing.
   *
   * ⚠ THE BRIEFING LINE IS ONE MESSAGE, not `label + '. ' + line`. Two whole sentences glued
   * with a full stop is still assembly, and a language that wants the consequence before the
   * condition has no way to say so. `weather.known` carries both and decides the order. */
  const w = WEATHER[v.weather] || WEATHER.still;
  const tod = TIMES[v.time] || TIMES.night;

  const incident = {
    ...pack.incident,
    briefing: pack.incident.briefing ? {
      ...pack.incident.briefing,
      known: [
        ...(pack.incident.briefing.known || []),
        { text: msg('weather.known', { label: w.label, line: w.line }), confidence: 'probable' },
        { text: msg('time.known', { label: tod.label, line: tod.line }), confidence: 'probable' },
      ],
    } : pack.incident.briefing,
  };

  /* 2, 3, 7 and 8 are applied to the live Game rather than to the document, because they
   * are about state rather than geometry. `Game.applyVariation` does that; the record
   * travels on the pack so it is available to whoever builds one. */
  return {
    pack: { ...pack, map, incident, variation: v, weather: w, time: tod },
    problems,
  };
}

/** Choose and apply in one call, which is what the loader wants. */
export function varyContent(pack, seed) {
  const v = chooseVariation(pack, seed);
  return applyVariation(pack, v);
}
