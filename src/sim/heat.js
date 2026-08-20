/* The heat field. This is the game.
 *
 * Every mechanic that matters is a question about temperature: the imager draws it, the
 * draught is drawn along it, the fence is a contour of it, and custody is a box that keeps
 * its own inside warm. One scalar field, sampled, and nothing else.
 *
 * MODEL. Sources superpose:
 *
 *     T(p) = ambient + Σ (peakC - ambient) / (1 + (d_i / d0_i)²)  -  chill(p)
 *
 * Superposition rather than max() is a design decision, not a physics one. It is what
 * lets two tripods placed either side of a 4.2m aisle bridge a gap that neither can span
 * alone — the exact problem the cold-storage map was authored around ("the aisles are
 * 4.2m wide, wider than one floodlight's 40C contour"). With max() the second tripod
 * would add nothing and that map note would be a lie.
 *
 * The anomaly subtracts. That is the other half of the design: the wall you built gets
 * weaker as the thing you built it for leans on it, so a fence that was exactly good
 * enough on the way in is not good enough at contact. Measured contour radii are printed
 * by the suite (section C) rather than asserted from memory.
 */

import { CONFIG } from '../config.js';
import { dist } from './geometry.js';

export class HeatField {
  constructor({ ambientC = CONFIG.heat.ambientC } = {}) {
    this.baseAmbientC = ambientC;
    this.ambientC = ambientC;
    /** @type {{x:number,z:number,peakC:number,falloffM:number,active:boolean,id:string}[]} */
    this.emitters = [];
    /** Cold masses. Only ever the anomaly, but the field does not need to know that. */
    this.sinks = [];
  }

  reset() {
    this.ambientC = this.baseAmbientC;
    this.emitters.length = 0;
    this.sinks.length = 0;
  }

  /** Rebuilt every step from the world, so a dead battery or a retrieved tripod cannot
   *  leave a phantom fence post behind. Cheap: there are never more than a dozen. */
  setEmitters(list) { this.emitters = list; }
  setSinks(list) { this.sinks = list; }

  /** GDD §5.4: the floor gets colder while the incident runs. A clock you can feel. */
  drift(stepMs, anomalyLoose) {
    if (!anomalyLoose) return;
    const perMs = CONFIG.heat.ambientDriftCPerMin / 60000;
    this.ambientC = Math.max(CONFIG.heat.ambientFloorC, this.ambientC - perMs * stepMs);
  }

  emitterContribution(e, x, z) {
    if (!e.active) return 0;
    const d = dist(x, z, e.x, e.z);
    const d0 = e.falloffM || CONFIG.heat.falloffMetres;
    return (e.peakC - this.ambientC) / (1 + (d / d0) * (d / d0));
  }

  sinkContribution(s, x, z) {
    const d = dist(x, z, s.x, s.z);
    const d0 = s.falloffM || CONFIG.heat.anomalyChillFalloffM;
    return s.chillC / (1 + (d / d0) * (d / d0));
  }

  /**
   * The field, sampled. Squared distance throughout — the model only ever wants (d/d0)²,
   * so the square root every helper above computes is pure waste here. It matters: the
   * imager's floor texture samples this ~9,000 times per update, ten times a second.
   */
  temperatureAt(x, z) {
    let t = this.ambientC;
    for (const e of this.emitters) {
      if (!e.active) continue;
      const dx = x - e.x, dz = z - e.z;
      const d0 = e.falloffM || CONFIG.heat.falloffMetres;
      t += (e.peakC - this.ambientC) / (1 + (dx * dx + dz * dz) / (d0 * d0));
    }
    for (const s of this.sinks) {
      const dx = x - s.x, dz = z - s.z;
      const d0 = s.falloffM || CONFIG.heat.anomalyChillFalloffM;
      t -= s.chillC / (1 + (dx * dx + dz * dz) / (d0 * d0));
    }
    return t;
  }

  /** Temperature ignoring one named sink — used to ask "how warm would it be here if the
   *  draught were not standing on it", which is what a thermal operator reads off a wall. */
  temperatureWithout(x, z, sinkId) {
    let t = this.ambientC;
    for (const e of this.emitters) t += this.emitterContribution(e, x, z);
    for (const s of this.sinks) if (s.id !== sinkId) t -= this.sinkContribution(s, x, z);
    return t;
  }

  /**
   * Radius at which a lone emitter reaches `thresholdC` over the current ambient.
   * Analytic, from the model above:  r = d0 · sqrt((peak - ambient)/(threshold - ambient) - 1)
   * Returns 0 when the emitter cannot reach the threshold at all.
   *
   * The HUD draws this ring, the suite asserts it, and it is the number that decides
   * whether an aisle needs one tripod or two.
   */
  contourRadius(e, thresholdC = CONFIG.heat.gradientThresholdC) {
    const rise = e.peakC - this.ambientC;
    const need = thresholdC - this.ambientC;
    if (need <= 0) return Infinity;
    if (rise <= need) return 0;
    const d0 = e.falloffM || CONFIG.heat.falloffMetres;
    return d0 * Math.sqrt(rise / need - 1);
  }

  /**
   * Does a continuous gradient above the threshold span this line?
   *
   * Samples at CONFIG.heat.pathSampleMetres. The sample spacing is a real design
   * parameter: too coarse and a tripod's contour develops invisible gaps the draught
   * walks through, which reads as the rule not working rather than as a sampling
   * artefact. 0.18m is roughly a tenth of a tripod's contour radius.
   */
  blocksPath(ax, az, bx, bz, thresholdC = CONFIG.heat.gradientThresholdC) {
    const len = dist(ax, az, bx, bz);
    if (len === 0) return this.temperatureAt(ax, az) >= thresholdC;
    const n = Math.max(2, Math.ceil(len / CONFIG.heat.pathSampleMetres));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (this.temperatureAt(ax + (bx - ax) * t, az + (bz - az) * t) >= thresholdC) return true;
    }
    return false;
  }

  /** The warmest sample along a line, for telemetry and for the "why did my fence fail"
   *  readout. Returns {c, x, z}. */
  hottestOnPath(ax, az, bx, bz) {
    const len = dist(ax, az, bx, bz);
    const n = Math.max(2, Math.ceil(len / CONFIG.heat.pathSampleMetres));
    let best = { c: -Infinity, x: ax, z: az };
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const c = this.temperatureAt(x, z);
      if (c > best.c) best = { c, x, z };
    }
    return best;
  }
}
