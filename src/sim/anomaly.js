/* The draught. Five states, five triggers, and not one line of scripted drama.
 *
 * Every rule here is read from content/anomalies/graybox-draught.json — the radii, the
 * sustain times, the threshold, the telegraphs. Nothing is hard-coded that the content
 * file also states, because the moment those two disagree the player is being taught a
 * rule the game does not obey, and Pillar 1's design test ("after a failure, can players
 * explain what they misunderstood?") stops being answerable.
 *
 *   latent  ──heat-detected──▶ aware ──lock-on──▶ drawn
 *      └──────────────── heat-wall ─────────────────┴──▶ banked ──sealed──▶ contained
 *                                                     ◀─gradient-lost─┘
 *
 * TWO THINGS DECIDE EVERYTHING:
 *
 * 1. It hunts the strongest REACHABLE heat. A tripod is hotter than a person, but its own
 *    40C contour makes it unreachable, so the tripod is a wall and the person is a meal.
 *    Nothing special-cases "ignore floodlights" — reachability does it, which is why a
 *    transit case running its heater at 39C is a lure and the same case at 41C would not be.
 *
 * 2. Banked means ENCLOSED, not merely obstructed. `isFenced` casts escape rays and asks
 *    whether ANY of them reaches open floor. Heat blocks a ray, an insulated panel blocks
 *    a ray, a closed cold-store door blocks a ray, and steel shelving does not. That one
 *    function is the containment rule, and everything the squad builds is an argument with it.
 */

import { CONFIG } from '../config.js';
import { dist, segmentHitsRect } from './geometry.js';

const STATE = Object.freeze({
  LATENT: 'latent', AWARE: 'aware', DRAWN: 'drawn', BANKED: 'banked', CONTAINED: 'contained',
});

export class Anomaly {
  /**
   * @param {object} def   the validated anomaly document
   * @param {Site} site
   * @param {HeatField} heat
   * @param {DeployableSet} deployables
   */
  constructor(def, site, heat, deployables) {
    this.def = def;
    this.site = site;
    this.heat = heat;
    this.deployables = deployables;

    /* Triggers indexed by id so the rules can be quoted back at the player verbatim. */
    this.trigger = new Map(def.triggers.map((t) => [t.id, t]));
    this.stateDef = new Map(def.states.map((s) => [s.id, s]));
    this.reset();
  }

  reset() {
    this.x = this.site.anomalySpawn.x;
    this.z = this.site.anomalySpawn.z;
    this.state = STATE.LATENT;
    this.stateEnteredMs = 0;
    this.targetId = null;
    this.heatSustainMs = 0;      // heat-detected
    this.gradientLostMs = 0;     // gradient-lost
    this.lastContactMs = -1e9;
    this.contactCount = 0;
    this.fenced = false;
    this.blockedThisStep = false;
    this.icePatches = [];
    this.lastIceMs = -1e9;
    this.telegraph = null;       // set on the step a transition is imminent/just fired
    this.transitions = [];       // append-only, for the debrief
    this.sealedIn = null;        // the transit case Deployable once custody starts
    this._slideSign = 0;         // which way round an obstacle it is currently going
    this._progressTarget = null; // and how long that has been getting it nowhere
    this._bestDist = Infinity;
    this._stuckMs = 0;
  }

  get isAwake() { return this.state === STATE.AWARE || this.state === STATE.DRAWN; }
  get isLoose() { return this.state !== STATE.CONTAINED; }
  get speedMps() {
    const s = this.stateDef.get(this.state);
    return s && s.speedMps ? s.speedMps : 0;
  }

  /** The cold mass the heat field subtracts. Absent once it is in the box. */
  asSink() {
    if (this.state === STATE.CONTAINED) return null;
    return {
      id: 'anomaly', x: this.x, z: this.z,
      chillC: CONFIG.heat.anomalyChillC, falloffM: CONFIG.heat.anomalyChillFalloffM,
    };
  }

  /* ── path tests ─────────────────────────────────────────────────────────── */

  /** Anything solid to the draught crossing this line: insulation, panels, closed doors. */
  solidBlocksPath(ax, az, bx, bz) {
    for (const r of this.site.insulatedRects()) if (segmentHitsRect(r, ax, az, bx, bz)) return true;
    return this.deployables.barrierBlocksPath(ax, az, bx, bz);
  }

  /** The full rule: a 40C gradient, an insulated panel, or a closed cold-store door. */
  pathBlocked(ax, az, bx, bz) {
    if (this.solidBlocksPath(ax, az, bx, bz)) return true;
    return this.heat.blocksPath(ax, az, bx, bz);
  }

  /**
   * Escape test. Cast `rayCount` rays to `testRadiusM`; the draught is fenced when not one
   * of them reaches the radius. Returns {fenced, escapes, weakestBearing} — `escapes` is
   * how many lanes are still open, which is what the imager operator is really counting.
   */
  isFenced() {
    const R = CONFIG.fence.testRadiusM;
    const n = CONFIG.fence.rayCount;
    let escapes = 0, weakestBearing = null, weakestHeat = Infinity;

    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const ex = this.x + Math.cos(a) * R, ez = this.z + Math.sin(a) * R;
      if (this.solidBlocksPath(this.x, this.z, ex, ez)) continue;
      if (this.heat.blocksPath(this.x, this.z, ex, ez)) {
        const hot = this.heat.hottestOnPath(this.x, this.z, ex, ez).c;
        if (hot < weakestHeat) { weakestHeat = hot; weakestBearing = a; }
        continue;
      }
      escapes++;
      if (weakestBearing === null) weakestBearing = a;
    }
    return { fenced: escapes === 0, escapes, weakestBearing, weakestHeat };
  }

  /* ── targeting ──────────────────────────────────────────────────────────── */

  /**
   * The strongest heat it can actually get to.
   *
   * `sources` are {id, x, z, peakC}. Ties break toward the nearer source, so a lure placed
   * near an operative wins — which is what makes a bait case work at all.
   *
   * ⚠ HEAT REJECTS A TARGET; A WALL DOES NOT. Rejecting anything with a solid between it
   * and the draught looks equivalent and silently breaks the whole game: the cold store's
   * cross-wall stands between the aisles and the loading bay, so every target on the far
   * side vanished, `chooseTarget` returned null, and the thing sat in the corner it woke
   * up in for four minutes doing nothing. It is a draught — it does not need line of
   * sight to know where the warm room is, it needs a way through, and finding one is the
   * steering fan's job.
   *
   * The heat test stays, because it is a rule rather than an obstacle: a floodlight is
   * hotter than anything else on the floor and its own 40C contour blocks the approach to
   * itself. That is the entire reason a tripod is a fence post and not a magnet, and
   * nothing anywhere special-cases "ignore floodlights".
   */
  chooseTarget(sources) {
    let best = null, bestKey = -Infinity;
    for (const s of sources) {
      if (this.heat.blocksPath(this.x, this.z, s.x, s.z)) continue;
      const d = dist(this.x, this.z, s.x, s.z);
      const key = s.peakC * 1000 - d;
      if (key > bestKey) { bestKey = key; best = s; }
    }
    return best;
  }

  /* ── movement ───────────────────────────────────────────────────────────── */

  /**
   * Drift toward the target, refusing any step that would cross the rule.
   *
   * Straight on when there is room; otherwise a hand on the wall and rotate one way until
   * something opens. A draught flows along a surface it cannot cross, and that is what
   * makes leading the thing across the floor possible at all — the cold store's cross-wall
   * admits it at exactly two places, and a purely head-on drifter sits against the panel
   * forever.
   *
   * ⚠ IT MUST NOT BECOME PATHFINDING. There is no graph and no memory of where it has
   * been; `_slideSign` is which way round it is currently going and nothing else. It can
   * and does pick the wrong way round an obstacle and take the long route, which is
   * correct — a draught is not solving the building. A concave trap still holds it, which
   * is precisely what a fence is and why the procedure is not decorative.
   */
  _drift(stepMs, target, pressureStage) {
    const gain = 1 + CONFIG.anomaly.pressureSpeedGain * Math.max(0, pressureStage);
    const step = this.speedMps * gain * (stepMs / 1000);
    if (step <= 0 || !target) { this.blockedThisStep = !!target; return; }

    const want = Math.atan2(target.z - this.z, target.x - this.x);
    /* ⚠ PROBE FURTHER THAN ONE STEP. A step at 2 m/s is 33mm, and a 33mm probe says
     * "clear" for any heading that is not literally inside the panel — so the thing
     * stepped straight at the wall, got refused, turned tangentially for one step, found
     * the direct heading "clear" again from 3cm out, and turned back. Measured: 120
     * seconds pinned against the freight door with a net travel of 10cm. A metre of
     * lookahead is what turns that oscillation into wall-following. */
    const probe = Math.max(step, 1.2);
    const clear = (a, d) => {
      const nx = this.x + Math.cos(a) * d, nz = this.z + Math.sin(a) * d;
      return this.site.inBounds(nx, nz) && !this.pathBlocked(this.x, this.z, nx, nz);
    };
    /* `_why` is the steering decision, kept for the debug overlay and the suite. A drifter
     * that is not going where you expect is otherwise a black box, and reasoning about
     * which of four branches fired is exactly the guesswork that costs afternoons. */
    const go = (a, why) => {
      this.x += Math.cos(a) * step;
      this.z += Math.sin(a) * step;
      this.blockedThisStep = false;
      this._why = why;
    };

    const Q = Math.PI / 2;

    /* 1. Straight on, if there is a metre of it.
     *
     * ⚠ THE COMMITMENT IS RELEASED ON A LONGER PROBE THAN IT IS TAKEN. Releasing it the
     * instant a 1.2m direct hop opens up produced a creep-and-thrash: the thing edged
     * diagonally toward the wall until direct was blocked, followed for one step, found
     * direct clear again from 3cm further out, and released — re-picking the follow side
     * from scratch each time and averaging zero progress. Measured: four minutes spent
     * inside a three-metre band of one wall. Two probe distances is the whole fix. */
    if (clear(want, probe)) {
      go(want, 'direct');
      if (clear(want, probe * 2.5)) this._slideSign = 0;
      return;
    }

    /* 1b. A hand on the wall can be the WRONG hand. A memoryless follower that commits to
     *     one direction will happily take the long way round — that is fine, and the
     *     design says so — but it will also walk into a dead end and stay there. Measured:
     *     four and a half minutes wedged in the south-west corner of the West run, target
     *     six metres away through a doorway in the other direction, while the squad stood
     *     around waiting for a lure that was working perfectly.
     *
     *     So: if it has not got any closer to what it wants for a while, it tries the
     *     other way. This is one bit and one timer, not a map — a fence still holds it,
     *     because inside a fence NEITHER direction makes progress and flipping just walks
     *     it around its own cage. */
    const d = dist(this.x, this.z, target.x, target.z);
    if (target.id !== this._progressTarget) { this._progressTarget = target.id; this._bestDist = d; this._stuckMs = 0; }
    if (d < this._bestDist - 0.25) { this._bestDist = d; this._stuckMs = 0; } else this._stuckMs += stepMs;
    if (this._stuckMs >= CONFIG.anomaly.reroundMs) {
      this._slideSign = -(this._slideSign || 1);
      this._stuckMs = 0;
      this._bestDist = d;
    }

    /* 2. Otherwise follow the surface, one-handed. The side is chosen once — whichever
     *    tangent is actually open, and if both are, the one that ends nearer the target —
     *    and then the heading rotates in THAT DIRECTION ONLY until something is clear.
     *    Rotating both ways is not wall-following, it is indecision with extra steps. */
    if (!this._slideSign) {
      const cw = clear(want + Q, probe), ccw = clear(want - Q, probe);
      if (cw !== ccw) this._slideSign = cw ? 1 : -1;
      else {
        const at = (a) => dist(this.x + Math.cos(a) * probe, this.z + Math.sin(a) * probe, target.x, target.z);
        this._slideSign = at(want + Q) <= at(want - Q) ? 1 : -1;
      }
    }
    const s = this._slideSign;
    for (let k = 1; k <= 16; k++) {
      const off = s * k * (Math.PI / 12);      // 15 degrees at a time, out to 240
      if (clear(want + off, probe)) { go(want + off, `follow${(off * 57.3).toFixed(0)}`); return; }
    }

    /* 3. Nowhere with a metre in it. Take what there is rather than freezing — a fence
     *    should hold it because it is enclosed, not because the steering gave up. */
    for (const off of [0, s * Q, -s * Q, Math.PI]) {
      if (clear(want + off, step)) { go(want + off, `crawl${(off * 57.3).toFixed(0)}`); return; }
    }
    this.blockedThisStep = true;
  }

  /* ── transitions ────────────────────────────────────────────────────────── */

  _enter(stateId, triggerId, simTimeMs) {
    if (this.state === stateId) return false;
    const t = this.trigger.get(triggerId);
    this.transitions.push({
      simTimeMs, from: this.state, to: stateId, triggerId,
      telegraph: t ? t.telegraph : '',
      pressureDelta: t ? (t.pressureDelta || 0) : 0,
    });
    this.state = stateId;
    this.stateEnteredMs = simTimeMs;
    this.heatSustainMs = 0;
    this.gradientLostMs = 0;
    return true;
  }

  /**
   * One simulation step.
   *
   * @param {number} stepMs
   * @param {number} simTimeMs
   * @param {object} ctx  {sources, operatives, pressureStage}
   * @returns {{transitioned:boolean, contacts:Array}}
   */
  step(stepMs, simTimeMs, ctx) {
    const out = { transitioned: false, contacts: [] };
    if (this.state === STATE.CONTAINED) return out;

    const fence = this.isFenced();
    this.fenced = fence.fenced;
    this.escapes = fence.escapes;
    this.weakestBearing = fence.weakestBearing;

    const target = this.chooseTarget(ctx.sources);
    this.targetId = target ? target.id : null;

    /* heat-wall — from any state, enclosure banks it. Checked FIRST so a fence completed
     * during a hunt takes effect on the same step the last lane closes, rather than after
     * one more metre of travel. That metre is the difference between a seal and a contact. */
    if (this.state !== STATE.BANKED && this.fenced) {
      out.transitioned = this._enter(STATE.BANKED, 'heat-wall', simTimeMs) || out.transitioned;
    }

    switch (this.state) {
      case STATE.LATENT: {
        /* heat-detected: any source within 12m for longer than 4s. */
        const t = this.trigger.get('heat-detected');
        const near = ctx.sources.some((s) => dist(this.x, this.z, s.x, s.z) <= t.when.radiusMetres);
        this.heatSustainMs = near ? this.heatSustainMs + stepMs : 0;
        this.telegraph = near && this.heatSustainMs > t.when.sustainSeconds * 500 ? t.telegraph : null;
        if (this.heatSustainMs >= t.when.sustainSeconds * 1000) {
          out.transitioned = this._enter(STATE.AWARE, 'heat-detected', simTimeMs) || out.transitioned;
        }
        break;
      }

      case STATE.AWARE: {
        this._drift(stepMs, target, ctx.pressureStage);
        const t = this.trigger.get('lock-on');
        if (target && dist(this.x, this.z, target.x, target.z) <= t.when.radiusMetres) {
          this.telegraph = t.telegraph;
          out.transitioned = this._enter(STATE.DRAWN, 'lock-on', simTimeMs) || out.transitioned;
        } else this.telegraph = null;
        break;
      }

      case STATE.DRAWN: {
        this._drift(stepMs, target, ctx.pressureStage);
        this.telegraph = null;
        /* chill-contact. Cooldown is in content; compounding is in content. */
        const cap = this.def.capabilities.find((c) => c.id === 'chill-contact');
        if (simTimeMs - this.lastContactMs >= cap.cooldownMs) {
          for (const op of ctx.operatives) {
            if (dist(this.x, this.z, op.x, op.z) <= cap.rangeMetres) {
              this.lastContactMs = simTimeMs;
              this.contactCount++;
              out.contacts.push({ operative: op, applies: cap.applies, count: this.contactCount });
              break;
            }
          }
        }
        /* ice-surface: a slip hazard that outlives the visit. */
        const ice = this.def.capabilities.find((c) => c.id === 'ice-surface');
        if (ice && simTimeMs - this.lastIceMs >= ice.cooldownMs) {
          this.lastIceMs = simTimeMs;
          this.icePatches.push({ x: this.x, z: this.z, r: 1.4, atMs: simTimeMs });
          if (this.icePatches.length > 40) this.icePatches.shift();
        }
        break;
      }

      case STATE.BANKED: {
        /* gradient-lost: the fence has a hole and has had one for 3s. The grace is what
         * makes a momentary flicker — someone walking through their own fence — survivable. */
        const t = this.trigger.get('gradient-lost');
        this.gradientLostMs = this.fenced ? 0 : this.gradientLostMs + stepMs;
        this.telegraph = !this.fenced ? t.telegraph : null;
        if (this.gradientLostMs >= t.when.sustainSeconds * 1000) {
          out.transitioned = this._enter(STATE.DRAWN, 'gradient-lost', simTimeMs) || out.transitioned;
        }
        break;
      }
      default: break;
    }
    return out;
  }

  /**
   * The `sealed` trigger. Deliberately NOT automatic: an operative performs it, because
   * GDD §8.4 says containment is a state the squad creates, and a climax that happens to
   * you is not a climax. Returns a refusal string, or null on success.
   */
  trySeal(caseDep, simTimeMs) {
    const t = this.trigger.get('sealed');
    if (this.state !== STATE.BANKED) return 'It is not held. Close the fence first.';
    if (!caseDep) return 'No transit case deployed.';
    if (caseDep.itemId !== t.when.itemId) return 'That is not a transit case.';
    if (!caseDep.hasPower) return 'The case heater is dead. It will not hold.';
    if (dist(this.x, this.z, caseDep.x, caseDep.z) > t.when.radiusMetres) {
      return `The case is ${dist(this.x, this.z, caseDep.x, caseDep.z).toFixed(1)}m away. It must be within ${t.when.radiusMetres}m.`;
    }
    caseDep.sealed = true;
    caseDep.custodyHeldMs = 0;
    this.sealedIn = caseDep;
    this.x = caseDep.x; this.z = caseDep.z;
    this._enter(STATE.CONTAINED, 'sealed', simTimeMs);
    return null;
  }

  /** Custody is a state, not a cutscene (GDD §8.4). It can be lost. */
  stepCustody(stepMs, simTimeMs) {
    const c = this.sealedIn;
    if (this.state !== STATE.CONTAINED || !c) return { verified: false, lost: false };
    if (!c.hasPower) {
      /* The heater cycle lengthens, then frost creeps from the seams — the failure signal
       * the content authored for integrity condition `case-heater`. */
      c.sealed = false;
      this.sealedIn = null;
      this._enter(STATE.DRAWN, 'gradient-lost', simTimeMs);
      return { verified: false, lost: true };
    }
    c.custodyHeldMs += stepMs;
    return {
      verified: c.custodyHeldMs >= CONFIG.anomaly.custodyVerifySeconds * 1000,
      lost: false,
      heldMs: c.custodyHeldMs,
    };
  }

  iceAt(x, z) {
    for (const p of this.icePatches) if (dist(x, z, p.x, p.z) <= p.r) return true;
    return false;
  }
}

export { STATE as ANOMALY_STATE };
