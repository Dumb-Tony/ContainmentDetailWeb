/* The site — map content turned into the queries the simulation actually asks.
 *
 * ONE RECORD, TWO CONSUMERS. The renderer builds its walls from `blockingRects()` and the
 * movement code collides against the same list, so the visible surface and the collider
 * can never disagree (the lesson recorded against MoversFromHell `buildScene` in
 * Dev\INDEX.md).
 *
 * ⚠ THE LOAD-BEARING ASYMMETRY: two different walls exist. `blockingRects()` is what stops
 * a person. `insulatedRects()` is what stops the draught, and it is a DIFFERENT LIST —
 * the anomaly's constraint file blocks it with closed-cell insulation only ("Portable
 * barrier panels work; sheet metal and plasterboard do not"), and the map marks its four
 * steel shelving runs as porous. The site being a cold store is why its own structure is
 * a fence at all, and why the two-step power puzzle is worth solving: a cold-store freight
 * door is insulation, so a closed powered door is a fence post and an open one is a hole.
 */

import { rectContains, circleHitsRect, dist } from './geometry.js';

export class Site {
  constructor(mapDoc) {
    this.doc = mapDoc;
    this.id = mapDoc.id;
    this.displayName = mapDoc.displayName || mapDoc.id;
    this.bounds = mapDoc.bounds;
    this.ceilingHeight = mapDoc.ceilingHeight || 3.2;
    this.spawn = { x: mapDoc.spawn[0], z: mapDoc.spawn[1], facing: mapDoc.spawnFacingRad || 0 };
    this.extraction = mapDoc.extraction;
    this.cache = mapDoc.cache;
    this.anomalySpawn = { x: mapDoc.anomalySpawn[0], z: mapDoc.anomalySpawn[1] };
    this.statics = mapDoc.statics.map((r) => r.slice());
    this.crates = (mapDoc.crates || []).map(([x, z]) => ({ x, z }));
    this.rooms = (mapDoc.rooms || []).map((r) => ({ ...r }));
    this.luminaires = (mapDoc.luminaires || []).map((l) => ({
      x: l.at[0], z: l.at[1], circuitId: l.circuitId || null, emergency: !!l.emergency,
    }));

    this.circuits = new Map();
    for (const c of mapDoc.circuits || []) {
      this.circuits.set(c.id, {
        id: c.id,
        displayName: c.displayName || c.id,
        switchX: c.switch[0], switchZ: c.switch[1],
        switchLabel: c.switchLabel || `${c.displayName || c.id} breaker`,
        on: !!c.initiallyOn,
      });
    }

    this.doors = (mapDoc.doors || []).map((d) => ({
      id: d.id,
      displayName: d.displayName || d.id,
      rect: d.aabb.slice(),
      circuitId: d.circuitId || null,
      open: !!d.initiallyOpen,
    }));

    /* Crates are 0.9m boxes; they are the only movable-looking things that still block. */
    this._crateRects = this.crates.map((c) => [c.x - 0.45, c.z - 0.45, c.x + 0.45, c.z + 0.45]);

    const porous = new Set(mapDoc.porousStatics || []);
    this._insulatedStatics = this.statics.filter((_, i) => !porous.has(i));
    this._rebuildBlocking();
  }

  _rebuildBlocking() {
    this._blocking = this.statics.concat(this._crateRects);
    this._insulated = this._insulatedStatics.slice();
    for (const d of this.doors) {
      if (!d.open) { this._blocking.push(d.rect); this._insulated.push(d.rect); }
    }
  }

  /** Everything that stops a person walking. Rebuilt only when a door changes. */
  blockingRects() { return this._blocking; }

  /** Everything that stops the draught: cold-store panel and closed freight doors.
   *  Steel shelving is absent from this list on purpose — it walks straight through. */
  insulatedRects() { return this._insulated; }

  /** Is a circuit energised? Unknown circuit ids read as dead, never as live. */
  circuitOn(id) { const c = this.circuits.get(id); return !!(c && c.on); }

  setCircuit(id, on) {
    const c = this.circuits.get(id);
    if (!c) return false;
    if (c.on === on) return false;
    c.on = on;
    /* A powered door does not open itself — it becomes openable. A door on a circuit that
     * just died stays where it is; the site does not slam doors at people. */
    return true;
  }

  circuitSwitchNear(x, z, reach) {
    for (const c of this.circuits.values()) {
      if (dist(x, z, c.switchX, c.switchZ) <= reach) return c;
    }
    return null;
  }

  doorNear(x, z, reach) {
    for (const d of this.doors) {
      if (circleHitsRect(d.rect, x, z, reach)) return d;
    }
    return null;
  }

  /** Doors need their circuit live. A dead door is a wall, and says so. */
  canOperateDoor(d) { return d.circuitId === null || this.circuitOn(d.circuitId); }

  setDoorOpen(d, open) {
    if (d.open === open) return false;
    d.open = open;
    this._rebuildBlocking();
    return true;
  }

  /** Mains illumination at a point, 0..1. Emergency luminaires need no circuit. */
  mainsLightAt(x, z) {
    let best = 0;
    for (const l of this.luminaires) {
      if (!l.emergency && (!l.circuitId || !this.circuitOn(l.circuitId))) continue;
      const d = dist(x, z, l.x, l.z);
      const reach = l.emergency ? 5.5 : 7.0;
      const v = Math.max(0, 1 - (d / reach) ** 2) * (l.emergency ? 0.45 : 1);
      if (v > best) best = v;
    }
    return Math.min(1, best);
  }

  roomAt(x, z) {
    for (const r of this.rooms) if (rectContains(r.rect, x, z)) return r;
    return null;
  }

  /**
   * Name for a callout. GDD §14.3 wants landmarks a player can say aloud — so this must
   * always answer, and the answer must be the room a person would say they are in.
   *
   * ⚠ ROOM RECTS DO NOT TILE THE FLOOR. They stop at the walls, which leaves a seam the
   * width of every doorway between them, and standing in a doorway is exactly when you
   * are most likely to be telling somebody where you are. Measured on the shipped map:
   * fifty standable cells fell in a seam and reported "Unmarked floor". Falling back to
   * the nearest rect costs one loop and cannot leave a gap anywhere, at any map.
   */
  roomNearest(x, z) {
    const inside = this.roomAt(x, z);
    if (inside) return inside;
    let best = null, bestD = Infinity;
    for (const r of this.rooms) {
      const cx = Math.max(r.rect[0], Math.min(x, r.rect[2]));
      const cz = Math.max(r.rect[1], Math.min(z, r.rect[3]));
      const d = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  roomNameAt(x, z) { const r = this.roomNearest(x, z); return r ? r.name : 'Unmarked floor'; }

  inExtraction(x, z) {
    return dist(x, z, this.extraction.x, this.extraction.z) <= this.extraction.radius;
  }

  inBounds(x, z) {
    const b = this.bounds;
    return x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;
  }
}
