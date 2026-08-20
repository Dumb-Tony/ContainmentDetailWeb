/* The sound field. The second thing you can build a procedure out of, and it is not heat.
 *
 * GDD §26.2 asks the slice for three incident packages testing DISTINCT PROCEDURE FAMILIES
 * and names one of them "auditory lure and restraint". A family is only distinct if the
 * quantity underneath it behaves differently, so the first job of this file is to be a
 * different kind of field rather than a recoloured one. Three differences, and everything
 * else here falls out of them:
 *
 *   1. A WALL IS A PRICE, NOT A FULL STOP. `heat.blocksPath` returns a boolean because a
 *      40°C contour genuinely is a yes/no — the draught crosses it or it does not. Sound
 *      has no such line: every surface passes some of it, and how much is the number the
 *      player acts on. A cold-store panel costs about 32 dB and a steel shelving run about
 *      5, so the same lure is inaudible one room away and perfectly clear one aisle away.
 *      Model that as a boolean and the only actionable quantity has been thrown away —
 *      "blocked" tells a squad to give up, "twelve decibels" tells them to add a second panel.
 *
 *   2. IT GOES ROUND CORNERS. Heat does not, which is why `insulatedRects()` can be a list
 *      of things that end a ray. Sound leaks through the hole rather than the wall, so
 *      `pathLossDb` prices the straight line AND a one-bend detour past the corners of
 *      whatever is in the way, and returns the cheaper. On the shipped map that is worth
 *      23 dB across the office door: closed, the sound pays for the panel; open, it pays
 *      only for the walk. The map's two-step power puzzle is therefore an auditory puzzle
 *      for free, with nothing anywhere special-casing a door.
 *
 *   3. THE SQUAD IS A SOURCE WHETHER IT WANTS TO BE OR NOT. You place a floodlight; you do
 *      not place your own footsteps. `operativeNoiseDb` reads speed, not intent, so being
 *      quiet is a playable state with a measurable cost — a walk carries about sixteen
 *      metres in this room and a crouch about three. And because sources superpose in
 *      ENERGY, MASKING is arithmetic rather than a special case: a loud continuous source
 *      raises the floor around it and hides everything quieter. That is what "auditory
 *      lure" means as a mechanic instead of as a fiction — the thing you put down to draw
 *      the anomaly is the same thing that covers your approach, and two lures of equal
 *      strength mask each other into silence and leave whoever is walking as the loudest
 *      thing in the room.
 *
 * MODEL. Superposition in energy, one log at the end:
 *
 *     P(p) = P_ambient + Σ P0_i / (1 + (d_i/d0_i)²) · 10^(−loss_i(p)/10)
 *     L(p) = 10 · log10 P(p)
 *
 * The spreading term is the same softened inverse-square heat uses, and that is not a
 * coincidence or a copy: at d0 = 1m it IS the free-field law. Measured against −20·log10(d)
 * by the suite: 0.46 dB high at 3m, 0.04 at 10m, 0.005 at 30m — so it is the real law
 * everywhere a rule cares about and a softened one only inside the couple of metres where
 * the real law goes to infinity. Energy summation
 * rather than max() for the same reason heat superposes rather than maxing — two quiet
 * sources really do add up, and a rule that says otherwise is one a player disproves by
 * standing between them.
 *
 * AUDIBILITY IS A CONTRAST, NOT A THRESHOLD. There is no absolute hearing-floor constant
 * here and deliberately never was one. A source is audible where it beats everything else
 * at that point by `audibilityMarginDb`, and since the sum always contains the room's own
 * `ambientDb`, the room tone IS the floor. One mechanism, so a designer who quietens the
 * room cannot leave a second, louder floor behind to contradict it.
 *
 * THE ACOUSTICS BELONG TO THE SITE, not to this module. A concrete cold store and a
 * plastered house are not the same room, and the build already has both maps; the
 * constants are therefore constructor arguments defaulted from CONFIG rather than reads
 * scattered through the methods. It is also what makes the field testable without a world.
 *
 * Cost discipline, matching heat.js: the free-field tier carries no sqrt, no pow and one
 * log per SAMPLE rather than per source, because the per-source spreading denominator only
 * ever wants d². The occluded tier pays an exp per source and a sqrt per detour candidate,
 * both dwarfed by the segment tests they ride along with.
 *
 * Measured on the shipped map, 7 sources and 20 occluders, real clock, over two runs:
 * `freeFieldLevelAt` 0.06 us, `levelAt` 16–18 us, `audibleSourcesFrom` 16–18 us,
 * `micReading` 16–17 us. A full step — four operatives sampled, one anomaly listening, one
 * microphone — is about 100 us, or 0.6% of a 16.67 ms frame. THE TWO TIERS ARE NOT A STYLE
 * CHOICE: a 9,000-sample overlay of the kind the imager draws costs 0.55 ms on the
 * free-field tier and 144 ms on the occluded one, so anything that samples in bulk has to
 * use the first and be drawn with the walls on top of it.
 *
 * ⚠ THE SUITE CANNOT MEASURE ANY OF THAT. `smoketest.ps1` runs Chrome with
 * --virtual-time-budget, which freezes performance.now() for the whole of a synchronous
 * loop, so every timing taken inside the harness reads 0.000 us — convincingly, and
 * wrongly. The numbers above come from a separate un-virtualised run of the same code;
 * what the suite asserts instead is the WORK (occluder sweeps per sample), which virtual
 * time cannot lie about.
 */

import { CONFIG } from '../config.js';
import { dist } from './geometry.js';

/* Math.exp/Math.log rather than Math.pow/Math.log10: identical results, and this runs per
 * source per sample. 10^(x/10) = e^(x·ln10/10). */
const DB_PER_LOG = 10 / Math.LN10;
const LOG_PER_DB = Math.LN10 / 10;

export const dbToPower = (db) => Math.exp(db * LOG_PER_DB);
export const powerToDb = (p) => (p > 0 ? Math.log(p) * DB_PER_LOG : -Infinity);

/* How far outside a rect a diffraction bend point sits. Not a tunable — it is an epsilon,
 * and CONFIG is for numbers a designer is meant to move. */
const CORNER_INSET_M = 0.12;

/**
 * ⚠ THIS IS `geometry.segmentHitsRect`, RE-WRITTEN ALLOCATION-FREE, AND THAT IS NOT
 * GRATUITOUS. The shared one builds an array of four two-element arrays per call to loop
 * over its slabs — five allocations — and a single `levelAt` sample runs it a hundred
 * times across seven sources and their bend candidates. Measured on the shipped map at 7
 * sources and 20 occluders, in Chrome with the virtual clock off: `levelAt` cost 136.0 us
 * per sample before and 16–18 us after, and one bend search 16.9 us before and 1.7 us
 * after. That is the difference between this field costing 4.8% of a frame per simulation
 * step and costing 0.6%. It is the same argument `temperatureAt` makes for inlining `dist`
 * to drop a square root it never wanted, one order of magnitude further down.
 *
 * The AABB reject in front of it is where most of that came from: a segment across one
 * aisle cannot touch nineteen of the twenty rects, and four comparisons say so before the
 * slab test starts. `dx`/`dz` are passed in because the caller has already computed them
 * once for the whole sweep.
 *
 * Semantics are identical to `segmentHitsRect` and the suite asserts they agree.
 */
function segHitsRect(r, ax, az, dx, dz) {
  let t0 = 0, t1 = 1, p, q, t;

  p = -dx; q = ax - r[0];
  if (p === 0) { if (q < 0) return false; }
  else { t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }

  p = dx; q = r[2] - ax;
  if (p === 0) { if (q < 0) return false; }
  else { t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }

  p = -dz; q = az - r[1];
  if (p === 0) { if (q < 0) return false; }
  else { t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }

  p = dz; q = r[3] - az;
  if (p === 0) { if (q < 0) return false; }
  else { t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }

  return true;
}

/**
 * Where a sound could bend to get round this rect. Six candidates written into a caller-
 * supplied buffer as (x,z) pairs, because this runs inside the sample loop and an array
 * of six two-element arrays per hit rect was a measurable share of the cost above.
 *
 * ⚠ A WALL HAS THICKNESS, SO ITS END IS TWO EDGES AND NOT ONE. Hugging the corners was the
 * obvious candidate set and it silently closed every gap on the shipped map: for a source
 * and a listener on opposite sides of the cross-wall, a bend at the lower corner is grazed
 * by the leg arriving from above and a bend at the upper corner is grazed by the leg
 * arriving from below, so both candidates paid for the wall twice and the 2m opening
 * between the wall's end and the bay wall may as well not have existed. Measured: that
 * gap needs 0.44m of overshoot past the end for a listener two metres behind it, and more
 * the closer either party stands. Twice the wall's thickness covers it and puts the bend
 * in the middle of the opening the map actually has.
 *
 * Both sets are kept. The two overshot END points are how you get round a wall; the four
 * hugged CORNERS are how you get round a crate, and they give a much shorter — therefore
 * louder, therefore more accurate — detour when the straight line only just clips an edge.
 */
function writeBendPoints(r, out) {
  const E = CORNER_INSET_M;
  const w = r[2] - r[0], h = r[3] - r[1];
  const over = E + 2 * (w < h ? w : h);
  if (w >= h) {
    const mz = (r[1] + r[3]) * 0.5;
    out[0] = r[0] - over; out[1] = mz;
    out[2] = r[2] + over; out[3] = mz;
  } else {
    const mx = (r[0] + r[2]) * 0.5;
    out[0] = mx; out[1] = r[1] - over;
    out[2] = mx; out[3] = r[3] + over;
  }
  out[4] = r[0] - E;  out[5] = r[1] - E;
  out[6] = r[2] + E;  out[7] = r[1] - E;
  out[8] = r[0] - E;  out[9] = r[3] + E;
  out[10] = r[2] + E; out[11] = r[3] + E;
}

export class SoundField {
  /**
   * @param {object} [acoustics]  every value defaults from CONFIG.sound; an incident that
   *   is not set in a concrete cold store overrides the ones that differ.
   */
  constructor({
    ambientDb = CONFIG.sound.ambientDb,
    referenceDistanceM = CONFIG.sound.referenceDistanceM,
    audibilityMarginDb = CONFIG.sound.audibilityMarginDb,
    massiveLossDb = CONFIG.sound.massiveLossDb,
    panelLossDb = CONFIG.sound.panelLossDb,
    rackLossDb = CONFIG.sound.rackLossDb,
    cornerLossDb = CONFIG.sound.cornerLossDb,
  } = {}) {
    this.baseAmbientDb = ambientDb;
    this.ambientDb = ambientDb;
    this.ambientPower = dbToPower(ambientDb);
    this.referenceDistanceM = referenceDistanceM;
    this.audibilityMarginDb = audibilityMarginDb;
    this.massiveLossDb = massiveLossDb;
    this.panelLossDb = panelLossDb;
    this.rackLossDb = rackLossDb;
    this.cornerLossDb = cornerLossDb;

    /** @type {{id:string,x:number,z:number,db:number,d0sq:number,p0:number}[]} */
    this.sources = [];
    /** @type {{rect:number[],lossDb:number}[]} */
    this.occluders = [];

    /* Scratch for the bend search. See the note in `pathLossDb`. */
    this._hits = [];
    this._bend = new Float64Array(12);
  }

  reset() {
    this.setAmbientDb(this.baseAmbientDb);
    this.sources = [];
    this.occluders = [];
  }

  /** The room's own noise. An incident whose plant is still running says so here, and every
   *  audibility answer in the game moves with it — a loud room is a room you can work in,
   *  and a dead-silent one is a room where walking is a broadcast. */
  setAmbientDb(db) {
    this.ambientDb = db;
    this.ambientPower = dbToPower(db);
  }

  /**
   * Rebuilt every step from the world, exactly as `HeatField.setEmitters` is and for the
   * same reason: a lure whose battery died or an operative who stopped walking must leave
   * nothing behind. It is also how a TRANSIENT is modelled — a dropped case is a source
   * that exists for a few steps and then does not — which is why the field itself is
   * steady-state and has no notion of duration.
   *
   * A source is `{id, x, z, db, kind?, refM?, active?}`; `db` is its level at `refM` metres.
   */
  setSources(list) {
    this.sources = list.map((s) => {
      const d0 = s.refM || this.referenceDistanceM;
      return { ...s, d0sq: d0 * d0, p0: s.active === false ? 0 : dbToPower(s.db) };
    });
  }

  /**
   * ⚠ THE THIRD RELATIONSHIP TO WALLS. site.js already carries two lists that disagree on
   * purpose — `blockingRects()` stops a person, `insulatedRects()` stops the draught — and
   * sound wants neither of them, because neither is a list of things sound cannot cross.
   * There is no such list. An occluder is a rect with a PRICE, and `occludersFor` below is
   * where the site's two lists become prices.
   *
   * Rebuilt whenever the building changes, or every step; there is no cached derivation to
   * forget to invalidate, which is the whole argument for rebuilding rather than mutating.
   */
  setOccluders(list) { this.occluders = list; }

  /**
   * The two site lists, priced.
   *
   * ⚠ A PORTABLE BARRIER IS AN ABSOLUTE WALL TO THE DRAUGHT AND ONLY A PARTIAL ONE TO
   * SOUND, and that asymmetry is the point. It is what stops the auditory incident being
   * solved by re-running the thermal procedure with the same kit: the panel that ends a
   * heat ray dead buys about twelve decibels here, which is worth having and is not a
   * fence. §26.2 asks for distinct procedure families, and two families answered by the
   * same three items are one family with two skins.
   *
   * The tiers:
   *   · insulated statics and CLOSED powered doors — cold-store panel, the building
   *     itself. An OPEN door is in neither site list, so it is priced at nothing and the
   *     map's two-step power puzzle becomes an auditory puzzle with no code that knows
   *     what a door is.
   *   · everything else that stops a person — steel shelving and stacked crates. It stops
   *     you walking and it stops you seeing, and it barely slows sound at all. That is the
   *     third disagreement between the site's lists and it is the interesting one.
   *   · deployed barrier panels, priced between the two.
   *
   * @param {Site} site
   * @param {DeployableSet} [deployables]
   */
  occludersFor(site, deployables) {
    const massive = new Set(site.insulatedRects());
    const out = [];
    for (const r of site.blockingRects()) {
      out.push({ rect: r, lossDb: massive.has(r) ? this.massiveLossDb : this.rackLossDb });
    }
    if (deployables) {
      for (const r of deployables.barrierRects()) out.push({ rect: r, lossDb: this.panelLossDb });
    }
    return out;
  }

  /* ── the field ───────────────────────────────────────────────────────────── */

  /**
   * Spreading only, the building ignored. An UPPER BOUND on `levelAt`, never an
   * approximation of it, because occlusion can only subtract.
   *
   * This is the tier for anything bulk. A noise overlay drawn across the floor samples
   * thousands of points and cannot afford a segment test per source per pixel — and does
   * not need one, because an overlay is answering "where is it loud" and the walls are
   * drawn on top of it anyway.
   */
  freeFieldLevelAt(x, z) {
    let p = this.ambientPower;
    for (const s of this.sources) {
      if (s.p0 === 0) continue;
      const dx = x - s.x, dz = z - s.z;
      p += s.p0 / (1 + (dx * dx + dz * dz) / s.d0sq);
    }
    return powerToDb(p);
  }

  /**
   * The field, sampled: total level in dB at a point, room tone included, every source
   * charged what the building costs it.
   *
   * This is the number an operative's own HUD shows ("you are making this much noise"), the
   * number a `noise-above` trigger polls at the anomaly's position, and a stress input.
   * There is no separate "is it loud here" predicate because there is nothing to threshold
   * against except this.
   */
  levelAt(x, z) {
    return powerToDb(this._sumPower(x, z, null));
  }

  /**
   * Everything audible at a point EXCEPT one source: the masking level it has to beat. The
   * direct analogue of `HeatField.temperatureWithout`, and the reason a lure can hide a
   * squad — what the squad is measured against is the room plus the lure.
   */
  maskLevelAt(x, z, exceptId) {
    return powerToDb(this._sumPower(x, z, exceptId));
  }

  _sumPower(x, z, exceptId) {
    let p = this.ambientPower;
    for (const s of this.sources) {
      if (s.p0 === 0 || s.id === exceptId) continue;
      const dx = x - s.x, dz = z - s.z;
      const free = s.p0 / (1 + (dx * dx + dz * dz) / s.d0sq);
      const loss = this.pathLossDb(s.x, s.z, x, z);
      p += loss > 0 ? free * Math.exp(-loss * LOG_PER_DB) : free;
    }
    return p;
  }

  /** One known source at one point, the building included. Used by the microphone, which
   *  has to re-weight each source separately before it can sum them. */
  levelFrom(s, x, z) {
    if (!s || s.p0 === 0) return -Infinity;
    const dx = x - s.x, dz = z - s.z;
    const free = s.db - DB_PER_LOG * Math.log(1 + (dx * dx + dz * dz) / s.d0sq);
    if (!this.occluders.length) return free;
    return free - this.pathLossDb(s.x, s.z, x, z);
  }

  /**
   * What a source of `sourceDb` standing at A would present at B. The source need not
   * exist: this is the PLANNER's question, asked before anything is placed — "if I put the
   * noisemaker at the end of aisle B, does it reach the loading bay, and by how much?"
   */
  levelOfAt(sourceDb, ax, az, bx, bz, { refM = this.referenceDistanceM } = {}) {
    const dx = bx - ax, dz = bz - az;
    return sourceDb
      - DB_PER_LOG * Math.log(1 + (dx * dx + dz * dz) / (refM * refM))
      - this.pathLossDb(ax, az, bx, bz);
  }

  /**
   * Does it get there at all? The boolean a sense can poll, and this field's answer to
   * `heat.blocksPath` — inverted, because heat's path question is "is the way SHUT" and
   * sound's is "does it CARRY".
   *
   * ⚠ MEASURED AGAINST THE ROOM ALONE, NOT AGAINST THE OTHER SOURCES. It is the best case:
   * "this reaches, in a quiet room". A lure that `carriesTo` the anomaly can still be
   * masked by a louder one; that is `audibleSourcesFrom`'s question, it costs a pass over
   * every source, and a planner UI redrawing a reach ring should not pay for it.
   */
  carriesTo(sourceDb, ax, az, bx, bz, opts = {}) {
    const margin = opts.marginDb === undefined ? this.audibilityMarginDb : opts.marginDb;
    return this.levelOfAt(sourceDb, ax, az, bx, bz, opts) >= this.ambientDb + margin;
  }

  /* ── what the building costs ─────────────────────────────────────────────── */

  /** Sum of the prices of every occluder the straight line crosses. Occluders are
   *  rectangles and a rectangle either crosses a segment or it does not, so unlike heat's
   *  `blocksPath` this is EXACT rather than sampled: there is no `pathSampleMetres` here
   *  and no gap between two samples for a lure to slip through. */
  _wallLossDb(ax, az, bx, bz, hitsOut) {
    const dx = bx - ax, dz = bz - az;
    const loX = dx < 0 ? bx : ax, hiX = dx < 0 ? ax : bx;
    const loZ = dz < 0 ? bz : az, hiZ = dz < 0 ? az : bz;
    const list = this.occluders;
    let loss = 0;
    for (let i = 0; i < list.length; i++) {
      const r = list[i].rect;
      if (r[0] > hiX || r[2] < loX || r[1] > hiZ || r[3] < loZ) continue;
      if (!segHitsRect(r, ax, az, dx, dz)) continue;
      loss += list[i].lossDb;
      if (hitsOut) hitsOut.push(r);
    }
    return loss;
  }

  /**
   * What the building costs a sound travelling A→B, in dB over and above free-field
   * spreading. 0 across open floor.
   *
   * DIFFRACTION, ONE BEND. When the straight line is expensive the sound goes round: try
   * two-segment paths via the corners of whatever the straight line hit, and charge each
   * `cornerLossDb` plus the extra spreading the longer walk costs. That is Maekawa's
   * barrier attenuation in spirit — what a corner costs you is the detour — and it is what
   * makes an open doorway a hole rather than a slightly cheaper wall.
   *
   * ⚠ ONE BEND, AND IT MUST NOT BECOME PATHFINDING. Two bends squares the candidate count
   * to buy a route nobody can hear anyway: a listener two corners and two rooms away is
   * hearing the building, not the source, and the model saying so is correct rather than a
   * limitation. It is the same argument the draught's steering makes about not solving the
   * building, for the same reason — no graph, no memory, and a concave space genuinely is
   * quiet inside. That quiet is a place to stand, which is half of "restraint".
   *
   * Note what this does NOT take: a source. The excess-spreading term is a ratio of two
   * softened distances and is insensitive to d0 past a couple of metres, so the answer is
   * a property of the building and the two points alone — which is what lets one path
   * answer serve sources at different reference distances.
   */
  pathLossDb(ax, az, bx, bz) {
    /* Scratch buffers reused across calls: this is the sample loop and the allocations
     * showed up in the profile. Single-threaded, and nothing here calls itself, so the
     * only rule is that a caller may not re-enter `pathLossDb` from inside it. */
    const hits = this._hits;
    hits.length = 0;
    const direct = this._wallLossDb(ax, az, bx, bz, hits);
    if (direct === 0) return 0;

    /* A detour costs at least one corner plus a non-negative walk, so when the wall is
     * cheaper than a corner nothing can beat going straight through it. Exact rather than
     * an approximation, and the reason a crate or a shelving run never opens the search. */
    const corner = this.cornerLossDb;
    if (direct <= corner) return direct;

    const d0sq = this.referenceDistanceM * this.referenceDistanceM;
    const directLen = dist(ax, az, bx, bz);
    const directSpread = DB_PER_LOG * Math.log(1 + (directLen * directLen) / d0sq);

    let best = direct;
    const bend = this._bend;
    const nHits = hits.length;
    for (let i = 0; i < nHits; i++) {
      writeBendPoints(hits[i], bend);
      for (let k = 0; k < 12; k += 2) {
        const cx = bend[k], cz = bend[k + 1];
        const detour = dist(ax, az, cx, cz) + dist(cx, cz, bx, bz);
        const spread = DB_PER_LOG * Math.log(1 + (detour * detour) / d0sq);
        let cost = corner + (spread - directSpread);
        /* Prune before the segment tests. Wall losses are never negative, so a candidate
         * already worse than the incumbent on geometry alone cannot be rescued by them. */
        if (cost >= best) continue;
        cost += this._wallLossDb(ax, az, cx, cz, null) + this._wallLossDb(cx, cz, bx, bz, null);
        if (cost < best) best = cost;
      }
    }
    return best;
  }

  /* ── who can be picked out of the noise ──────────────────────────────────── */

  /**
   * Every source a listener at this point can separate from everything else, loudest
   * first. Each entry carries what it was competing against, because "you cannot hear the
   * lure" and "you cannot hear the lure BECAUSE the generator is louder here" are
   * different pieces of information and §8.2 asks for the actionable one.
   *
   * This is the auditory `chooseTarget` and it is where the lure mechanic lives. A source
   * is audible when it beats the sum of the room and every OTHER source by the margin, so:
   * one loud lure is heard and hides the squad behind it, and two equal lures mask each
   * other into silence and leave whoever is walking as the loudest thing in the room.
   * Nothing special-cases "ignore the lure"; the arithmetic does it, the same way
   * reachability rather than a special case is what makes a floodlight a fence post.
   */
  audibleSourcesFrom(x, z, opts = {}) {
    const margin = opts.marginDb === undefined ? this.audibilityMarginDb : opts.marginDb;
    const ignoreId = opts.ignoreId;

    const parts = [];
    let total = this.ambientPower;
    for (const s of this.sources) {
      if (s.p0 === 0 || s.id === ignoreId) continue;
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      const loss = this.pathLossDb(s.x, s.z, x, z);
      let p = s.p0 / (1 + d2 / s.d0sq);
      if (loss > 0) p *= Math.exp(-loss * LOG_PER_DB);
      total += p;
      parts.push({ s, p, d2, loss });
    }

    const out = [];
    for (const c of parts) {
      /* `total - c.p` always retains the ambient term, so the mask can never reach zero
       * and is always a real level rather than -Infinity. */
      const maskDb = powerToDb(total - c.p);
      const db = powerToDb(c.p);
      if (db < maskDb + margin) continue;
      out.push({
        id: c.s.id, kind: c.s.kind, x: c.s.x, z: c.s.z,
        db, maskDb, lossDb: c.loss, distanceM: Math.sqrt(c.d2), source: c.s,
      });
    }
    /* ⚠ A TOTAL ORDER, NOT JUST "LOUDEST". Two identical sources at identical range would
     * otherwise be separated by the order the caller happened to build the array in, and
     * that array is rebuilt every step from a player list whose order is a join order. The
     * id is the last resort precisely because it is the one thing that does not move. */
    out.sort((a, b) => (b.db - a.db) || (a.distanceM - b.distanceM)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /** The loudest thing audible from here, or null in a room where nothing beats the tone.
   *  What the anomaly steers at, and what a `loudest-noise-within` sense reads. */
  loudestAudibleFrom(x, z, opts = {}) {
    const all = this.audibleSourcesFrom(x, z, opts);
    return all.length ? all[0] : null;
  }
}

/* ── the squad, as something that can be heard ───────────────────────────────── */

/**
 * How loud an operative is, from SPEED rather than from intent.
 *
 * ⚠ NOT FROM `sprinting` AND `crouching` ALONE. Those are the keys being held: an operative
 * sprinting into a wall is holding the sprint key and standing still, and a field that read
 * the flag would have them roaring at a shelving run they are not moving along. Speed is
 * also what makes the in-between states real — coasting out of a sprint is audibly a walk
 * before the key comes up.
 *
 * Crouching CAPS the level rather than scaling it, because the point of crouching is that
 * it puts a ceiling on how loud you can possibly be. That ceiling is the playable state: a
 * crouched operative carries about three metres in this room and a walking one about
 * sixteen, and the difference between those two numbers is the whole of "move quietly".
 */
export function operativeNoiseDb(p) {
  const still = CONFIG.player.stillNoiseDb;
  const speed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  let db = still;
  if (speed > 0.05) {
    const walk = CONFIG.player.walkNoiseDb;
    const sprint = CONFIG.player.sprintNoiseDb;
    const wSpeed = CONFIG.player.walkSpeed;
    const sSpeed = CONFIG.player.sprintSpeed;
    db = speed <= wSpeed
      ? still + (walk - still) * (speed / wSpeed)
      : walk + (sprint - walk) * Math.min(1, (speed - wSpeed) / (sSpeed - wSpeed));
  }
  if (p.crouching) db = Math.min(db, CONFIG.player.crouchNoiseDb);
  return db;
}

/**
 * An operative as a source. The counterpart of `Player.heatSource`, and unlike it there is
 * no way to switch it off: standing still is quiet and never silent, because GDD §11.2's
 * "no player should be assigned to stare at an unchanging screen" has an auditory twin —
 * nobody should be assigned to stand perfectly still for the whole operation either.
 *
 * `extraDb` is how a caller composes what this field has no business knowing about: ice
 * underfoot, a dropped case, a casualty who is not being quiet about it. Composition
 * rather than a flag per cause, for the same reason `speedFactor` min-combines — no two
 * systems may each believe they own how loud a person is.
 */
export function operativeSource(p, { extraDb = 0 } = {}) {
  return {
    id: p.id, kind: 'operative', x: p.x, z: p.z,
    db: operativeNoiseDb(p) + extraDb, active: true,
  };
}

/** A deployed noisemaker. Its level is content (`noiseOutputDb` on the item), its reach is
 *  the field's, and a flat battery removes it from the physics in the same step it removes
 *  it from the sound — the contract `DeployableSet.heatEmitters` already keeps. Returns
 *  null for an item that makes no noise, so a caller can map the whole deployable list. */
export function deployableSource(d, { extraDb = 0 } = {}) {
  const db = d.item && d.item.noiseOutputDb;
  if (db === undefined) return null;
  return {
    id: d.uid, kind: 'deployable', x: d.x, z: d.z,
    db: db + extraDb, refM: d.item.noiseRefMetres, active: !!d.active,
  };
}

/* ── the directional microphone (GDD §26.2 equipment) ────────────────────────── */

/**
 * The instrument that reads this field, as the imager reads heat — and it has to cost
 * something for the same reason the imager's narrow FOV does (§10.2).
 *
 * What it buys: gain on axis, and rejection everywhere else. The rejection is the real
 * power and it is not the same thing as the gain — a shotgun mic does not make the room
 * louder, it makes everything you are not pointing at quieter, INCLUDING the diffuse room
 * tone. That is why pointing away from the generator lets you hear the footsteps it was
 * masking, and it is the skill the equipment exists to reward. Measured with the shipped
 * item's pattern: it recovers a source up to 22 dB below whatever is masking it, out of
 * 26 dB of nominal on-axis-to-off-axis discrimination. Bounded, so a squad cannot simply
 * point at the problem — they still have to quieten the room.
 *
 * What it costs: `coneRad` is the full width across which response falls from on-axis to
 * full rejection, so the useful lobe is narrow and the operator has to sweep; and
 * `selfNoiseDb` is their own noise, which floors the entire reading.
 *
 * ⚠ THE OPERATOR'S OWN NOISE IS NOT REJECTED BY THE PATTERN, and getting that wrong is
 * what decides whether the equipment has a cost at all. Rejecting it off-axis like any
 * other source — the operator is behind the mic, after all — dropped a walking operative's
 * floor to 35 dB and they went on resolving everything they could resolve standing still,
 * which is an instrument with no posture and no reason to stop moving. Handling noise and
 * your own boots come up the body of the thing rather than through the air, so they get a
 * fixed partial reduction and nothing more. Measured with the shipped numbers: standing
 * still floors the reading at 25 dB, three below what the naked ear manages in this room;
 * walking floors it at 43 and every quiet thing in the building disappears.
 *
 * The defaults live here rather than in CONFIG for the same reason `operativeViewer`'s
 * cone does: they describe one piece of equipment, and equipment that wants different
 * numbers is a different item passing different ones.
 */
export function operativeMic(p, {
  coneRad = 0.908,
  onAxisGainDb = 12,
  offAxisRejectionDb = -14,
  diffuseRejectionDb = -6,
  handlingRejectionDb = -12,
} = {}) {
  return {
    id: `${p.id}-mic`, ownerId: p.id,
    x: p.x, z: p.z, yaw: p.yaw,
    coneRad, onAxisGainDb, offAxisRejectionDb, diffuseRejectionDb, handlingRejectionDb,
    selfNoiseDb: operativeNoiseDb(p),
  };
}

/**
 * The shipped item's own numbers, translated into `operativeMic` options.
 *
 * `content/equipment/items.json` authors the microphone's polar pattern the way it authors
 * a lamp's `lightRadiusMetres` — the instrument's numbers belong to the instrument. The
 * only translation needed is degrees to radians, and it lives here rather than at every
 * call site because a conversion each caller has to remember is a conversion that will
 * eventually be forgotten in one of them. The suite asserts that the defaults above and
 * the shipped item agree, so a mic built either way is the same instrument.
 *
 * `handlingRejectionDb` is deliberately NOT read from the item: how much of your own
 * movement comes up the handle is a property of a person holding a thing, not of which
 * thing they are holding.
 */
export function micOptionsFromItem(item) {
  const o = {};
  if (item.listenConeDegrees !== undefined) o.coneRad = item.listenConeDegrees * Math.PI / 180;
  if (item.onAxisGainDb !== undefined) o.onAxisGainDb = item.onAxisGainDb;
  if (item.offAxisRejectionDb !== undefined) o.offAxisRejectionDb = item.offAxisRejectionDb;
  if (item.diffuseRejectionDb !== undefined) o.diffuseRejectionDb = item.diffuseRejectionDb;
  return o;
}

/** Smooth polar response. A hard cone edge makes a source at the boundary flicker in and
 *  out as the operator breathes, which reads as the instrument being broken rather than as
 *  a sampling artefact; smoothstep costs three multiplies and removes the whole class. */
function polarGainDb(cosTheta, cosEdge, onDb, offDb) {
  if (cosTheta <= cosEdge) return offDb;
  const t = (cosTheta - cosEdge) / (1 - cosEdge);
  return offDb + (onDb - offDb) * t * t * (3 - 2 * t);
}

/**
 * What the microphone resolves, loudest first.
 *
 * A full re-mix rather than a filtered copy of `audibleSourcesFrom`: every source is
 * re-levelled by where it sits in the polar pattern BEFORE anything is compared, so the
 * masking arithmetic happens in the microphone's frame. Filtering the naked-ear answer by
 * the cone would have produced an instrument that can only confirm what you could already
 * hear, which is not worth a hand and a cargo slot.
 *
 * Bearings come back signed and relative to where the mic is pointed, because the readout
 * a player acts on is "swing left", not a compass rose. The forward convention is
 * (−sin yaw, −cos yaw) — the same one the camera, the movement code and `perception.sees`
 * use, and deriving it again differently here would put the needle a quarter turn out.
 */
export function micReading(mic, field, opts = {}) {
  const margin = opts.marginDb === undefined ? field.audibilityMarginDb : opts.marginDb;
  const fx = -Math.sin(mic.yaw), fz = -Math.cos(mic.yaw);
  const cosEdge = Math.cos(mic.coneRad / 2);

  /* The floor: room tone as this pattern hears it, plus the operator themselves — the tone
   * gets the diffuse rejection because it arrives from everywhere, the operator gets only
   * the handling reduction because they arrive up the handle. */
  const handling = mic.handlingRejectionDb === undefined ? 0 : mic.handlingRejectionDb;
  const floorPower = dbToPower(field.ambientDb + mic.diffuseRejectionDb)
    + (mic.selfNoiseDb === undefined ? 0 : dbToPower(mic.selfNoiseDb + handling));

  const parts = [];
  let total = floorPower;
  for (const s of field.sources) {
    if (s.p0 === 0 || s.id === mic.ownerId) continue;
    const raw = field.levelFrom(s, mic.x, mic.z);
    if (!Number.isFinite(raw)) continue;
    const dx = s.x - mic.x, dz = s.z - mic.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const cos = d < 1e-6 ? 1 : (fx * dx + fz * dz) / d;
    const right = d < 1e-6 ? 0 : (-fz * dx + fx * dz) / d;
    const db = raw + polarGainDb(cos, cosEdge, mic.onAxisGainDb, mic.offAxisRejectionDb);
    const p = dbToPower(db);
    total += p;
    parts.push({ s, db, p, d, cos, right });
  }

  const resolved = [];
  for (const c of parts) {
    const maskDb = powerToDb(total - c.p);
    if (c.db < maskDb + margin) continue;
    resolved.push({
      id: c.s.id, kind: c.s.kind, x: c.s.x, z: c.s.z,
      db: c.db, maskDb, distanceM: c.d,
      offAxisRad: Math.atan2(c.right, c.cos),
    });
  }
  resolved.sort((a, b) => (b.db - a.db) || (a.distanceM - b.distanceM)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    resolved,
    loudest: resolved.length ? resolved[0] : null,
    floorDb: powerToDb(floorPower),
    selfNoiseDb: mic.selfNoiseDb,
  };
}
