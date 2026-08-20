/* The imager's floor image — a sampled picture of the actual heat field.
 *
 * This is the one piece of UI in the game that is allowed to be authoritative, because it
 * is not a picture OF the rule, it is the rule sampled on a grid. The same `temperatureAt`
 * the anomaly's path test calls is what paints these pixels, so the imager cannot show a
 * fence that is not there, and it cannot hide a gap the draught can use.
 *
 * THE CONTOUR IS THE POINT. A smooth heat ramp is pretty and useless — a player cannot see
 * where 40C is on a gradient. So a hard band is drawn at the threshold itself, and that
 * bright line is what the squad is actually building when it sets tripods down. The lesson
 * is TowBros' terrain contours (Dev\INDEX.md): faint shading carries the gradient, one
 * heavy line is what the eye counts.
 *
 * ⚠ 96x96 over a 24m floor is 25cm per pixel. That is coarser than the simulation's
 * 18cm path sampling ON PURPOSE — the picture must never promise a gap finer than the
 * rule resolves, and being the coarser of the two is what guarantees it.
 */

import { CONFIG } from '../config.js';

const N = 96;

/** Cold→hot ramp. Sub-ambient goes violet-black so the draught reads as an absence. */
function ramp(out, i, c, ambient) {
  const th = CONFIG.heat.gradientThresholdC;

  /* The threshold band, drawn first so nothing overwrites it. */
  if (c >= th - 0.9 && c <= th + 0.9) {
    out[i] = 255; out[i + 1] = 255; out[i + 2] = 232; out[i + 3] = 255;
    return;
  }

  let r, g, b;
  if (c < ambient - 1) {
    /* Colder than the room: the mass itself. */
    const k = Math.max(0, Math.min(1, (ambient - c) / 24));
    r = 26 + k * 46; g = 8 + k * 4; b = 46 + k * 70;
  } else if (c < th) {
    const k = (c - (ambient - 1)) / (th - (ambient - 1));
    /* deep blue → teal → amber */
    if (k < 0.55) {
      const j = k / 0.55;
      r = 12 + j * 6; g = 26 + j * 96; b = 74 + j * 46;
    } else {
      const j = (k - 0.55) / 0.45;
      r = 18 + j * 200; g = 122 + j * 44; b = 120 - j * 96;
    }
  } else {
    const k = Math.min(1, (c - th) / 34);
    r = 255; g = 190 + k * 60; b = 40 + k * 170;
  }
  out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
}

export class ThermalFloor {
  constructor(THREE, bounds) {
    this.bounds = bounds;
    this.canvas = document.createElement('canvas');
    this.canvas.width = N; this.canvas.height = N;
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(N, N);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.lastUpdateMs = -1e9;
    this.updates = 0;
  }

  /** @param {HeatField} heat */
  update(heat, simTimeMs, everyMs = 100) {
    if (simTimeMs - this.lastUpdateMs < everyMs) return false;
    this.lastUpdateMs = simTimeMs;
    this.updates++;

    const b = this.bounds;
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    const data = this.image.data;
    const amb = heat.ambientC;

    for (let j = 0; j < N; j++) {
      /* The plane is rotated -90° about X, so its V axis runs from maxZ to minZ. Getting
       * this backwards mirrors the whole image and is invisible until a tripod appears on
       * the wrong side of the aisle. */
      const z = b.maxZ - ((j + 0.5) / N) * d;
      for (let i = 0; i < N; i++) {
        const x = b.minX + ((i + 0.5) / N) * w;
        ramp(data, (j * N + i) * 4, heat.temperatureAt(x, z), amb);
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
    this.texture.needsUpdate = true;
    return true;
  }
}

export { N as THERMAL_FLOOR_RESOLUTION };
