/* Plane geometry on the XZ floor. Pure functions, no engine, no state.
 *
 * The whole simulation is 2D. Height exists for the renderer and for nothing else — the
 * draught is a floor-level mass, the operative is a capsule, and nothing in this game
 * jumps. Keeping the sim planar is what lets the entire rule layer be tested headless.
 *
 * A rect is [minX, minZ, maxX, maxZ] because that is the shape the map content already
 * uses (`statics`, `doors[].aabb`, `rooms[].rect`). One representation, no conversions.
 */

export const rect = (minX, minZ, maxX, maxZ) => [minX, minZ, maxX, maxZ];

export function rectContains(r, x, z) {
  return x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];
}

export function rectsOverlap(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/** Does a circle of radius `rad` centred at (x,z) touch the rect? */
export function circleHitsRect(r, x, z, rad) {
  const cx = Math.max(r[0], Math.min(x, r[2]));
  const cz = Math.max(r[1], Math.min(z, r[3]));
  const dx = x - cx, dz = z - cz;
  return dx * dx + dz * dz < rad * rad;
}

export function dist(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export function dist2(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  return dx * dx + dz * dz;
}

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Move `v` toward `target` by at most `maxStep`, never overshooting. */
export function approach(v, target, maxStep) {
  if (v < target) return Math.min(v + maxStep, target);
  if (v > target) return Math.max(v - maxStep, target);
  return target;
}

/** Segment (ax,az)-(bx,bz) against an axis-aligned rect — slab method, returns bool. */
export function segmentHitsRect(r, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  let t0 = 0, t1 = 1;

  for (const [p, q] of [[-dx, ax - r[0]], [dx, r[2] - ax], [-dz, az - r[1]], [dz, r[3] - az]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

/**
 * Axis-separated resolution of a circle against a list of blocking rects.
 *
 * Copied in spirit from AirportBaggageCrew\src\systems\physics.js `moveWithWalls` — the
 * point of separating the axes is that a body sliding along a wall keeps its tangential
 * speed instead of sticking. Name kept so the lineage stays greppable (Dev\INDEX.md).
 *
 * @returns {{x:number, z:number, hitX:boolean, hitZ:boolean}}
 */
export function moveWithWalls(x, z, dx, dz, radius, rects) {
  let nx = x + dx, nz = z;
  let hitX = false, hitZ = false;

  for (const r of rects) {
    if (circleHitsRect(r, nx, nz, radius)) { nx = x; hitX = true; break; }
  }
  nz = z + dz;
  for (const r of rects) {
    if (circleHitsRect(r, nx, nz, radius)) { nz = z; hitZ = true; break; }
  }
  return { x: nx, z: nz, hitX, hitZ };
}

/** Push a point out of any rect it has ended up inside, along the shallowest axis. */
export function pushOutOfRects(x, z, radius, rects) {
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const r of rects) {
      if (!circleHitsRect(r, x, z, radius)) continue;
      const left = x - (r[0] - radius), right = (r[2] + radius) - x;
      const down = z - (r[1] - radius), up = (r[3] + radius) - z;
      const m = Math.min(left, right, down, up);
      if (m === left) x = r[0] - radius;
      else if (m === right) x = r[2] + radius;
      else if (m === down) z = r[1] - radius;
      else z = r[3] + radius;
      moved = true;
    }
    if (!moved) break;
  }
  return { x, z };
}
