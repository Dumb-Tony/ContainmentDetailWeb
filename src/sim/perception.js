/* Who can see what — GDD §8.6 ("an SCP whose movement or threat depends on perception"),
 * §11.2 ("observation relays and blind-spot management"), §8.3 (the `observe` verb).
 *
 * This is the second thing the game can measure, alongside the heat field, and it exists
 * so that a second anomaly can be a genuinely different PROCEDURE rather than the same
 * procedure with different numbers. Heat is a field you build walls out of; observation is
 * a resource you have to keep pointed at something while you do other work. §26.2 asks the
 * vertical slice for three packages testing distinct procedure families, and two families
 * cannot come out of one measurable quantity.
 *
 * A VIEWER IS ANYTHING WITH A CONE. An operative is a viewer whose cone is where they are
 * facing; a deployed remote camera is a viewer that does not get bored, does not need to
 * be anywhere in particular, and runs out of battery. That equivalence is the whole design
 * — GDD §11.2 warns that "no player should be assigned to stare at an unchanging screen
 * for long periods", and a camera you can leave behind is the answer to it.
 *
 * ⚠ FAIR UNDER LATENCY (§8.2). Coverage is judged on the HOST and travels in the snapshot
 * like everything else. It must never be decided on an exact frame: the anomaly's release
 * trigger carries a sustain, so a client whose camera feed is 80ms stale cannot lose the
 * operation to a dropped packet.
 */

import { dist, segmentHitsRect } from './geometry.js';

/**
 * Is a point inside this viewer's cone, in range, and not behind a wall?
 *
 * @param {{x,z,yaw,fovRad,rangeM}} v
 * @param {number[][]} blockers  rects that stop sight. Sight and MOVEMENT block differently:
 *   pass `site.blockingRects()` here, because steel racking you cannot walk through is also
 *   racking you cannot see through, even though the draught walks straight past it.
 */
export function sees(v, x, z, blockers) {
  const d = dist(v.x, v.z, x, z);
  if (d > v.rangeM) return false;
  if (d < 0.35) return true;                    // standing on it counts, cone or not

  /* Bearing to the point against the viewer's facing. The game's forward convention is
   * (-sin yaw, -cos yaw) — the same one the camera and the movement code use. Deriving it
   * differently here would put every cone in the game a quarter turn out. */
  const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
  const nx = (x - v.x) / d, nz = (z - v.z) / d;
  const cos = fx * nx + fz * nz;
  if (cos < Math.cos(v.fovRad / 2)) return false;

  for (const r of blockers) if (segmentHitsRect(r, v.x, v.z, x, z)) return false;
  return true;
}

/**
 * @returns {{observed: boolean, by: string[], count: number}}
 *
 * `by` is returned rather than just a boolean because the HUD has to be able to say WHICH
 * camera is holding it. "Coverage lost" with no idea which lane went dark is not a warning
 * a squad can act on, and §18.1 wants the game to distinguish observed fact from inference.
 */
export function observedBy(x, z, viewers, blockers) {
  const by = [];
  for (const v of viewers) if (sees(v, x, z, blockers)) by.push(v.id);
  return { observed: by.length > 0, by, count: by.length };
}

/** An operative's own cone. Narrower than their render FOV on purpose: a thing is only
 *  "watched" if it is somewhere near the middle of your view, not merely on screen. */
export function operativeViewer(p, { fovRad = 1.15, rangeM = 14 } = {}) {
  return { id: p.id, kind: 'operative', x: p.x, z: p.z, yaw: p.yaw, fovRad, rangeM };
}

/** A deployed remote camera. Wide, patient, and only as good as its battery. */
export function cameraViewer(d, { fovRad = 1.4, rangeM = 11 } = {}) {
  return { id: d.uid, kind: 'camera', x: d.x, z: d.z, yaw: d.yaw, fovRad, rangeM };
}
