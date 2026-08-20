/* Presentation. Reads the simulation, owns nothing.
 *
 * TWO PASSES, ONE SCENE. The eye's view renders layer 0 with lights. The imager's view
 * renders layer 1 — the same structure, plus the thermal floor image, plus the draught
 * itself — through a NARROW camera into a small scissored rectangle. That narrowness is
 * the tool's documented cost (GDD §10.2: "Narrow view; vulnerable to environmental
 * noise"): you cannot watch the room and the screen at the same time, and the thing you
 * are hunting is only on the screen.
 *
 * ⚠ The imager pass must clear DEPTH but not colour, or the inset renders behind the
 * world it is drawn over. `autoClear = false` plus an explicit `clearDepth()` inside the
 * scissor is the whole of it.
 */

import { CONFIG } from '../config.js';
import { buildScene } from './scene.js';
import { ThermalFloor } from './thermalFloor.js';

export class Renderer {
  constructor(THREE, canvas, game) {
    this.THREE = THREE;
    this.game = game;
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio));
    this.renderer.autoClear = false;

    this.thermalFloor = new ThermalFloor(THREE, game.site.bounds);
    const built = buildScene(THREE, game.site, { thermalFloorTexture: this.thermalFloor.texture });
    Object.assign(this, built);

    this.camera = new THREE.PerspectiveCamera(CONFIG.render.fov, 1, CONFIG.render.near, CONFIG.render.far);
    this.camera.rotation.order = 'YXZ';
    this.camera.layers.set(0);

    this.thermalCam = new THREE.PerspectiveCamera(CONFIG.render.thermalFov, 1, CONFIG.render.near, CONFIG.render.far);
    this.thermalCam.rotation.order = 'YXZ';
    this.thermalCam.layers.set(1);

    /* The headlamp. No battery: darkness is a mechanic, but being unable to see your own
     * hands is not one, and a torch that dies mid-procedure would punish the wrong thing. */
    this.lamp = new THREE.SpotLight(0xffeedd, 1.35, 17, 0.62, 0.45, 1.4);
    this.lamp.position.set(0, 0, 0);
    this.lampTarget = new THREE.Object3D();
    this.scene.add(this.lamp, this.lampTarget);
    this.lamp.target = this.lampTarget;

    /* The draught. Layer 1 alone — it is not in the visible spectrum and the render graph
     * is what enforces that, not a flag. */
    const geo = new THREE.IcosahedronGeometry(0.78, 2);
    this.anomalyMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x2b0f4a }));
    this.anomalyMesh.layers.set(1);
    this.scene.add(this.anomalyMesh);
    this.anomalyHalo = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.18, 2),
      new THREE.MeshBasicMaterial({ color: 0x120a24, transparent: true, opacity: 0.55, side: THREE.BackSide }),
    );
    this.anomalyHalo.layers.set(1);
    this.scene.add(this.anomalyHalo);

    /* The imager screen's own black. Not the scene background — a screen that shared the
     * room's colour would have no edge, and the bezel is what tells you the view is narrow. */
    this._thermalBg = new THREE.Color(0x04060b);

    this._depMeshes = new Map();   // uid -> {group, light}
    this._iceMeshes = [];
    this._iceGeo = new THREE.CircleGeometry(1, 18);
    this._iceMat = new THREE.MeshBasicMaterial({ color: 0xbcd7e6, transparent: true, opacity: 0.4 });

    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.thermalCam.aspect = 1;
    this.thermalCam.updateProjectionMatrix();
    this.viewW = w; this.viewH = h;
  }

  /**
   * Where the imager screen sits — in CSS pixels, origin bottom-left.
   *
   * ⚠ CSS pixels, not device pixels. `WebGLRenderer.setViewport`/`setScissor` multiply by
   * the pixel ratio themselves; pre-multiplying puts the imager off-screen on any display
   * with dpr > 1, which is most of them, and it looks like the pass simply did not run.
   * Origin bottom-left is GL's convention, hence `1 - cy`.
   */
  imagerRect() {
    const r = CONFIG.render.imagerRect;
    const side = Math.round(Math.min(this.viewW, this.viewH) * r.h);
    const x = Math.round(this.viewW * r.cx - side / 2);
    const y = Math.round(this.viewH * (1 - r.cy) - side / 2);
    return { x, y, w: side, h: side };
  }

  /** CSS-pixel version of the same rectangle, for the HUD bezel. */
  imagerRectCss() {
    const r = CONFIG.render.imagerRect;
    const side = Math.min(this.viewW, this.viewH) * r.h;
    return { left: this.viewW * r.cx - side / 2, top: this.viewH * r.cy - side / 2, size: side };
  }

  _syncDeployables() {
    const THREE = this.THREE;
    const seen = new Set();
    for (const d of this.game.deployables.list) {
      seen.add(d.uid);
      let rec = this._depMeshes.get(d.uid);
      if (!rec) {
        const g = new THREE.Group();
        const col = d.itemId === 'floodlight-tripod' ? this.COL.tripod
          : d.itemId === 'reinforced-transit-case' ? this.COL.case
            : d.isBarrier ? this.COL.barrier
              : d.isPack ? this.COL.pack : 0x59606a;

        if (d.isBarrier) {
          const r = d.barrierRect();
          const panel = new THREE.Mesh(
            new THREE.BoxGeometry(Math.max(0.18, r[2] - r[0]), 1.9, Math.max(0.18, r[3] - r[1])),
            new THREE.MeshLambertMaterial({ color: col }),
          );
          panel.position.y = 0.95;
          g.add(panel);
        } else if (d.itemId === 'floodlight-tripod') {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), new THREE.MeshLambertMaterial({ color: col }));
          leg.position.y = 0.75; g.add(leg);
          const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.24, 0.2), new THREE.MeshLambertMaterial({ color: 0x8b8f96 }));
          head.position.y = 1.6; g.add(head);
        } else if (d.itemId === 'reinforced-transit-case') {
          const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.62, 0.66), new THREE.MeshLambertMaterial({ color: col }));
          box.position.y = 0.31; g.add(box);
          const band = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.07, 0.7), new THREE.MeshLambertMaterial({ color: 0x1d2126 }));
          band.position.y = 0.44; g.add(band);
        } else {
          const box = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.4, 0.3), new THREE.MeshLambertMaterial({ color: col }));
          box.position.y = 0.2; g.add(box);
          const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), new THREE.MeshLambertMaterial({ color: 0x777d85 }));
          stalk.position.y = 0.62; g.add(stalk);
        }
        g.traverse((o) => o.layers.enable(1));
        g.position.set(d.x, 0, d.z);
        g.rotation.y = d.yaw;
        this.scene.add(g);

        let light = null;
        if (d.itemId === 'floodlight-tripod' || d.itemId === 'portable-heater') {
          light = new THREE.PointLight(d.itemId === 'portable-heater' ? 0xff8a4a : 0xfff0d0, 0, 11, 1.5);
          light.position.set(d.x, 1.6, d.z);
          this.scene.add(light);
        }
        /* `lit` starts true to match the materials as authored, so the first sync is a
         * no-op rather than a brighten. */
        rec = { group: g, light, lit: true };
        this._depMeshes.set(d.uid, rec);
      }
      rec.group.position.set(d.x, 0, d.z);
      /* A dead unit goes dark and its head greys — the failure signal the content authored
       * for `fence-power` ("floodlight tripods dim in sequence as the pack sheds load").
       * Both channels, because the light going out is only visible if you were looking. */
      if (rec.light) rec.light.intensity = d.active ? 1.5 : 0;
      if (rec.lit !== d.active) {
        rec.lit = d.active;
        rec.group.traverse((o) => {
          if (o.material && o.material.color) o.material.color.multiplyScalar(d.active ? 1 / 0.55 : 0.55);
        });
      }
    }
    for (const [uid, rec] of this._depMeshes) {
      if (seen.has(uid)) continue;
      this.scene.remove(rec.group);
      if (rec.light) this.scene.remove(rec.light);
      this._depMeshes.delete(uid);
    }
  }

  _syncIce() {
    const patches = this.game.anomaly.icePatches;
    while (this._iceMeshes.length < patches.length) {
      const m = new this.THREE.Mesh(this._iceGeo, this._iceMat);
      m.rotation.x = -Math.PI / 2;
      m.layers.enable(1);
      this.scene.add(m);
      this._iceMeshes.push(m);
    }
    for (let i = 0; i < this._iceMeshes.length; i++) {
      const m = this._iceMeshes[i], p = patches[i];
      m.visible = !!p;
      if (p) { m.position.set(p.x, 0.02, p.z); m.scale.setScalar(p.r); }
    }
  }

  _syncLights() {
    for (const { light, def } of this.luminaireLights) {
      const on = def.emergency || (def.circuitId && this.game.site.circuitOn(def.circuitId));
      light.intensity = on ? (def.emergency ? 0.55 : 1.15) : 0;
    }
    for (const dr of this.game.site.doors) {
      const rec = this.doorMeshes.get(dr.id);
      if (rec) rec.mesh.position.y = dr.open ? rec.closedY + this.game.site.ceilingHeight : rec.closedY;
    }
  }

  render() {
    const g = this.game, THREE = this.THREE, p = g.player;
    const t = g.clock.simTimeMs;

    /* Camera. Stress adds a small breath sway — GDD §9.4 allows breathing and steadiness
     * and nothing more, so it is sub-degree and never moves the crosshair off a target. */
    const sway = p.stressNorm * 0.012;
    this.camera.position.set(p.x, p.eyeHeight() + Math.sin(t / 620) * sway, p.z);
    this.camera.rotation.y = p.yaw;
    this.camera.rotation.x = p.pitch + Math.sin(t / 830) * sway * 0.6;
    this.thermalCam.position.copy(this.camera.position);
    this.thermalCam.rotation.copy(this.camera.rotation);

    this.lamp.position.copy(this.camera.position);
    const fx = -Math.sin(p.yaw) * Math.cos(p.pitch);
    const fy = Math.sin(p.pitch);
    const fz = -Math.cos(p.yaw) * Math.cos(p.pitch);
    this.lampTarget.position.set(p.x + fx * 6, p.eyeHeight() + fy * 6, p.z + fz * 6);

    this._syncDeployables();
    this._syncLights();
    this._syncIce();

    const a = g.anomaly;
    const show = a.isLoose;
    this.anomalyMesh.visible = show;
    this.anomalyHalo.visible = show;
    if (show) {
      const pulse = 1 + Math.sin(t / 340) * 0.05 + (a.state === 'drawn' ? 0.12 : 0);
      this.anomalyMesh.position.set(a.x, 0.9, a.z);
      this.anomalyMesh.scale.setScalar(pulse);
      this.anomalyHalo.position.copy(this.anomalyMesh.position);
      this.anomalyHalo.scale.setScalar(pulse);
    }

    this.thermalFloor.update(g.heat, t);

    /* Pass 1: the eye. */
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.viewW, this.viewH);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    /* Pass 2: the imager, if it is switched on and in hand.
     *
     * The clear that empties this rectangle is the one `render()` performs because the
     * scene has a Color background — and gl.clear obeys the scissor box, so it wipes the
     * imager screen and nothing else. That is why the background is swapped rather than
     * nulled: with `autoClear = false` and no background there is no clear at all, and
     * the thermal image renders on top of whatever the eye drew a moment ago. */
    if (g.imagerOn) {
      const r = this.imagerRect();
      this.renderer.setScissorTest(true);
      this.renderer.setScissor(r.x, r.y, r.w, r.h);
      this.renderer.setViewport(r.x, r.y, r.w, r.h);
      const fog = this.scene.fog;
      const bg = this.scene.background;
      /* The imager does not see through fog: it measures. Restoring both afterwards
       * matters — a frame left with fog null renders the room at twice its real size. */
      this.scene.fog = null;
      this.scene.background = this._thermalBg;
      this.renderer.render(this.scene, this.thermalCam);
      this.scene.fog = fog;
      this.scene.background = bg;
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, this.viewW, this.viewH);
    }
  }
}
