/* Equipment once it is standing in the world rather than in a slot.
 *
 * Ownership-free by construction (GDD §11.7): a deployable belongs to the mission, not to
 * whoever put it down. Nothing here records who placed it, so nothing can gate retrieval
 * on it, so a disconnect or a casualty cannot strand a fence post.
 *
 * Batteries are the legible failure mode (GDD §10.6). They are stored as MILLISECONDS OF
 * RUNTIME, not as a percentage, because "four minutes of heater" is a decision a player
 * can make and "63%" is not. A power pack within reach feeds an emitter off its own cells
 * instead — which is the whole reason to spend two units of cargo on one.
 *
 * Barriers snap to the nearest quarter turn. That is a deliberate limitation: an
 * axis-aligned panel is an AABB, so the same rectangle blocks the operative, blocks the
 * draught, and is drawn by the renderer, and the three can never drift apart.
 */

import { CONFIG } from '../config.js';
import { dist, segmentHitsRect } from './geometry.js';

let _uid = 0;
export const resetDeployableIds = () => { _uid = 0; };

export class Deployable {
  constructor(item, x, z, yaw) {
    this.uid = `dep-${++_uid}`;
    this.itemId = item.id;
    this.item = item;
    this.x = x; this.z = z;
    /* Quarter-turn snap. Math.round(yaw / (PI/2)) keeps the panel axis-aligned. */
    this.yaw = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
    this.batteryMaxMs = (item.batteryMinutes || 0) * 60000;
    this.batteryMs = this.batteryMaxMs;
    this.on = true;
    this.fedByPack = false;
    /* Transit case only. */
    this.sealed = false;
    this.custodyHeldMs = 0;
    /* Sensors only: the append-only episode state (armed / triggered). */
    this.armedMs = 0;
    this.tripped = false;
  }

  get isEmitter() { return this.item.heatOutputCelsius !== undefined; }
  get isBarrier() { return this.item.barrierWidthMetres !== undefined; }
  get isPack() { return this.item.feedRadiusMetres !== undefined; }
  get hasPower() { return this.batteryMaxMs === 0 || this.batteryMs > 0; }
  get active() { return this.on && this.hasPower; }

  /** The AABB a barrier presents. Panels are 2.4m long and 0.18m thick. */
  barrierRect() {
    const half = (this.item.barrierWidthMetres || 2.4) / 2;
    const thin = 0.09;
    const alongX = Math.abs(Math.cos(this.yaw)) > 0.5;
    return alongX
      ? [this.x - half, this.z - thin, this.x + half, this.z + thin]
      : [this.x - thin, this.z - half, this.x + thin, this.z + half];
  }

  /** Footprint that stops a person. Barriers and cases are solid; a tripod is not — you
   *  can push past a floodlight, and being able to is what makes a fence survivable. */
  blockingRect() {
    if (this.isBarrier) return this.barrierRect();
    if (this.itemId === 'reinforced-transit-case') return [this.x - 0.45, this.z - 0.35, this.x + 0.45, this.z + 0.35];
    return null;
  }
}

export class DeployableSet {
  constructor() { this.list = []; }
  reset() { this.list.length = 0; resetDeployableIds(); }

  place(item, x, z, yaw) {
    const d = new Deployable(item, x, z, yaw);
    this.list.push(d);
    return d;
  }

  remove(dep) {
    const i = this.list.indexOf(dep);
    if (i >= 0) this.list.splice(i, 1);
    return i >= 0;
  }

  nearest(x, z, maxDist) {
    let best = null, bestD = maxDist;
    for (const d of this.list) {
      const dd = dist(x, z, d.x, d.z);
      if (dd <= bestD) { best = d; bestD = dd; }
    }
    return best;
  }

  byItem(itemId) { return this.list.filter((d) => d.itemId === itemId); }

  /** Heat sources for the field, rebuilt each step. Only ACTIVE emitters appear, so a
   *  flat battery removes the fence post from the physics in the same step it removes it
   *  from the light. */
  heatEmitters() {
    const out = [];
    for (const d of this.list) {
      if (!d.isEmitter) continue;
      out.push({
        id: d.uid, x: d.x, z: d.z,
        peakC: d.item.heatOutputCelsius,
        falloffM: d.item.heatFalloffMetres,
        active: d.active,
      });
    }
    return out;
  }

  barrierRects() {
    const out = [];
    for (const d of this.list) if (d.isBarrier) out.push(d.barrierRect());
    return out;
  }

  blockingRects() {
    const out = [];
    for (const d of this.list) { const r = d.blockingRect(); if (r) out.push(r); }
    return out;
  }

  /** Does a deployed insulated panel cross this line? The draught's only physical wall. */
  barrierBlocksPath(ax, az, bx, bz) {
    for (const r of this.barrierRects()) if (segmentHitsRect(r, ax, az, bx, bz)) return true;
    return false;
  }

  /**
   * Spend one step of battery.
   *
   * Order matters and is asserted: pack feeding is decided BEFORE draw, so an emitter
   * inside a live pack's radius never touches its own cells even on the step the pack
   * runs out. The alternative — draw first, then reconcile — makes a pack's last step
   * silently double-charge, which is invisible until someone measures a fence's life.
   */
  stepPower(stepMs, anomaly) {
    const packs = this.list.filter((d) => d.isPack && d.on && d.batteryMs > 0);

    /* The anomaly eats charge in range while it is awake (capability `drain-battery`). */
    const drainRadius = CONFIG.anomaly.batteryDrainRadiusM;
    const drainMult = CONFIG.anomaly.batteryDrainMultiplier;
    const draining = anomaly && anomaly.isAwake;

    for (const d of this.list) {
      d.fedByPack = false;
      if (!d.on || d.batteryMaxMs === 0) continue;

      let rate = 1;
      if (draining && dist(d.x, d.z, anomaly.x, anomaly.z) <= drainRadius) rate = drainMult;

      if (!d.isPack) {
        const pack = packs.find((p) => p !== d && dist(d.x, d.z, p.x, p.z) <= (p.item.feedRadiusMetres || CONFIG.power.packFeedRadiusM));
        if (pack) {
          d.fedByPack = true;
          pack.batteryMs = Math.max(0, pack.batteryMs - stepMs * rate);
          continue;
        }
      }
      d.batteryMs = Math.max(0, d.batteryMs - stepMs * rate);
    }
  }
}
