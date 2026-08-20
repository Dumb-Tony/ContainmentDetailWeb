/* The operative. First person, planar, deliberate — GDD §9.1: "no slide-cancelling,
 * repeated bunny hopping, or combat rolls".
 *
 * ONE SPEED FACTOR, MIN-COMBINED. Injury, carrying a case, ice underfoot and crouching all
 * want to slow the player down. They each contribute a factor and the smallest wins,
 * rather than multiplying — multiplying stacks into a crawl the moment two mild things are
 * true at once, and nobody can tell which one did it. Taken from the Unity build, where
 * the same rule is one replicated byte.
 *
 * Health is not a bar (GDD §9.3). It is a set of named conditions with severities, and
 * treatment STABILISES rather than erases: a trauma kit stops exposure getting worse and
 * clears the bleeding, and you still finish the operation limping.
 */

import { CONFIG, SLOTS } from '../config.js';
import { moveWithWalls, pushOutOfRects, dist } from './geometry.js';

export class Player {
  constructor(site) {
    this.site = site;
    this.reset();
  }

  reset() {
    this.x = this.site.spawn.x;
    this.z = this.site.spawn.z;
    this.yaw = this.site.spawn.facing;
    this.pitch = 0;
    this.vx = 0; this.vz = 0;
    this.crouching = false;
    this.sprinting = false;

    /** slotId -> itemId|null. GDD §9.2. */
    this.slots = new Map(SLOTS.map((s) => [s.id, null]));
    this.heldSlot = SLOTS[0].id;
    /** A two-handed mission object: the transit case on its way out. */
    this.hands = null;

    /** severity: 0 none, 1 minor, 2 serious. `stabilised` stops it worsening. */
    this.conditions = {
      exposure: { severity: 0, stabilised: false },
      mobility: { severity: 0, stabilised: false },
    };
    this.stress = 0;
    this.downedMs = 0;
    this.alive = true;
    this.distanceWalked = 0;
  }

  /* ── inventory ───────────────────────────────────────────────────────────── */

  slotFor(item) {
    for (const s of SLOTS) {
      if (!s.accepts.includes(item.bulk)) continue;
      if (this.slots.get(s.id) === null) return s.id;
    }
    return null;
  }

  carrying(itemId) {
    for (const v of this.slots.values()) if (v === itemId) return true;
    return false;
  }

  take(item) {
    const slot = this.slotFor(item);
    if (!slot) return null;
    this.slots.set(slot, item.id);
    this.heldSlot = slot;
    return slot;
  }

  drop(slotId) {
    const id = this.slots.get(slotId);
    if (!id) return null;
    this.slots.set(slotId, null);
    return id;
  }

  get heldItemId() { return this.slots.get(this.heldSlot) || null; }

  cycleHeld(dir = 1) {
    const ids = SLOTS.map((s) => s.id);
    const i = ids.indexOf(this.heldSlot);
    for (let k = 1; k <= ids.length; k++) {
      const j = (i + dir * k + ids.length * 2) % ids.length;
      if (this.slots.get(ids[j])) { this.heldSlot = ids[j]; return this.heldSlot; }
    }
    this.heldSlot = ids[(i + dir + ids.length) % ids.length];
    return this.heldSlot;
  }

  selectSlot(index) {
    const s = SLOTS[index];
    if (s) { this.heldSlot = s.id; return true; }
    return false;
  }

  /* ── condition ───────────────────────────────────────────────────────────── */

  applyCondition(kind, severityWord) {
    const sev = severityWord === 'serious' ? 2 : 1;
    const c = kind === 'exposure' ? this.conditions.exposure
      : kind === 'mobility-injury' ? this.conditions.mobility : null;
    if (!c) return false;
    /* Compounding: a second serious contact is worse than the first (content says so). */
    c.severity = Math.min(3, Math.max(c.severity, sev) + (c.severity >= sev ? 1 : 0));
    c.stabilised = false;
    if (c.severity >= 3) this.alive = false;
    return true;
  }

  treat() {
    let did = false;
    for (const c of [this.conditions.exposure, this.conditions.mobility]) {
      if (c.severity > 0 && !c.stabilised) { c.stabilised = true; did = true; }
    }
    return did;
  }

  get injured() { return this.conditions.exposure.severity > 0 || this.conditions.mobility.severity > 0; }

  /* ── heat ───────────────────────────────────────────────────────────────── */

  /** What the draught sees. A person is a lure and never a fence — asserted in the suite. */
  heatSource() {
    return { id: 'operative', x: this.x, z: this.z, peakC: CONFIG.player.bodyHeatC, falloffM: CONFIG.player.bodyHeatFalloffM };
  }

  /* ── movement ───────────────────────────────────────────────────────────── */

  speedFactor(onIce) {
    let f = 1;
    if (this.conditions.mobility.severity > 0) f = Math.min(f, CONFIG.player.injuredSpeedFactor);
    if (this.hands) f = Math.min(f, CONFIG.player.carrySpeedFactor);
    if (onIce) f = Math.min(f, 0.8);
    return f;
  }

  eyeHeight() { return this.crouching ? CONFIG.player.crouchEyeHeight : CONFIG.player.eyeHeight; }

  look(dx, dy) {
    this.yaw -= dx * CONFIG.player.lookSensitivity;
    this.pitch -= dy * CONFIG.player.lookSensitivity;
    if (this.pitch > CONFIG.player.pitchLimit) this.pitch = CONFIG.player.pitchLimit;
    if (this.pitch < -CONFIG.player.pitchLimit) this.pitch = -CONFIG.player.pitchLimit;
  }

  /**
   * @param {{x:number,y:number}} axis  -1..1, from Input.moveAxis(); y is forward-negative
   * @param {number[][]} blockers       every rect that stops a person, this step
   */
  step(stepMs, axis, blockers, { onIce = false } = {}) {
    const dt = stepMs / 1000;
    const base = this.crouching ? CONFIG.player.crouchSpeed
      : this.sprinting ? CONFIG.player.sprintSpeed : CONFIG.player.walkSpeed;
    const target = base * this.speedFactor(onIce);

    /* Camera-relative: forward is -y on the input axis, which is the same convention every
     * other project on this machine uses. Ice reduces the accel, not the top speed — you
     * still get there, you just cannot change your mind. */
    const fwd = -axis.y, right = axis.x;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = fwd * -sin + right * cos;
    const wz = fwd * -cos - right * sin;

    const accel = CONFIG.player.accel * (onIce ? 0.28 : 1);
    const fric = CONFIG.player.friction * (onIce ? 0.18 : 1);
    this.vx += (wx * target - this.vx) * Math.min(1, accel * dt);
    this.vz += (wz * target - this.vz) * Math.min(1, accel * dt);
    if (wx === 0 && wz === 0) {
      const drop = fric * dt;
      const sp = Math.hypot(this.vx, this.vz);
      const ns = Math.max(0, sp - drop * Math.max(sp, 0.6));
      if (sp > 1e-5) { this.vx *= ns / sp; this.vz *= ns / sp; }
      if (Math.hypot(this.vx, this.vz) < 0.02) { this.vx = 0; this.vz = 0; }
    }

    const before = { x: this.x, z: this.z };
    const r = moveWithWalls(this.x, this.z, this.vx * dt, this.vz * dt, CONFIG.player.radius, blockers);
    this.x = r.x; this.z = r.z;
    if (r.hitX) this.vx = 0;
    if (r.hitZ) this.vz = 0;

    /* Numerical escape happens: a door closing on a standing player, a barrier deployed
     * under someone's feet. Push out rather than trapping them inside geometry. */
    const p = pushOutOfRects(this.x, this.z, CONFIG.player.radius, blockers);
    this.x = p.x; this.z = p.z;

    this.distanceWalked += dist(before.x, before.z, this.x, this.z);
  }

  /**
   * Stress — GDD §9.4. Restrained by construction: it can only ever change breathing,
   * steadiness and callout delay, and this function is the only thing that moves it.
   */
  stepStress(stepMs, { lightLevel, anomalyDistance, anomalyLoose }) {
    const perMin = (v) => (v / 60000) * stepMs;
    let d = 0;
    const dark = lightLevel < 0.2;
    if (dark) d += perMin(CONFIG.stress.darknessPerMinute);
    if (anomalyLoose && anomalyDistance <= CONFIG.stress.proximityRadiusM) {
      d += perMin(CONFIG.stress.proximityPerMinute * (1 - anomalyDistance / CONFIG.stress.proximityRadiusM));
    }
    if (this.injured) d += perMin(CONFIG.stress.injuryPerMinute);
    if (!dark && !(anomalyLoose && anomalyDistance <= CONFIG.stress.proximityRadiusM)) {
      d += perMin(CONFIG.stress.reliefPerMinute);
    }
    this.stress = Math.max(0, Math.min(CONFIG.stress.max, this.stress + d));
    return this.stress;
  }

  /** 0..1, used by the renderer for breath and sway. Never gates information. */
  get stressNorm() { return this.stress / CONFIG.stress.max; }
}
