/* The world, built once from the same map record the simulation collides against.
 *
 * Every wall here comes out of `site.blockingRects()`. Nothing is authored twice, so the
 * visible surface and the collider cannot disagree — the failure mode recorded against
 * MoversFromHell `buildScene` in Dev\INDEX.md, where a wall drawn from one list and
 * collided from another quietly grew a gap.
 *
 * LAYERS ARE THE THERMAL TRICK. Layer 0 is what an eye sees. Layer 1 is what the imager
 * sees. Structure is on both; the draught is on layer 1 ALONE, which is the whole of
 * "invisible to the eye and to cameras in the visible spectrum, but thermal imaging
 * records it faithfully" — enforced by the render graph rather than by a visibility flag
 * somebody could forget to set.
 */

const L_WORLD = 0;
const L_THERMAL = 1;

/** Cold institutional palette. One light vector for the whole scene (the TowBros lesson). */
const COL = {
  floor: 0x2a2d31,
  panel: 0x3d4a48,
  panelEdge: 0x55635f,
  steel: 0x4a4f57,
  crate: 0x5b4a37,
  door: 0x6a5f4a,
  case: 0x8a6a2c,
  tripod: 0x2f3338,
  pack: 0x39424a,
  barrier: 0x7d7f6a,
  prop: 0x7a6f5c,
  extraction: 0x2f6f4a,
};

export function buildScene(THREE, site, { thermalFloorTexture }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070a);
  /* Exponential fog does most of the work of "a big dark cold room": it hides the far
   * wall without a hard clip plane, and it makes a headlamp feel like the only thing you
   * own. Density is tuned so a 24m floor reads as unknowable from its own doorway. */
  scene.fog = new THREE.FogExp2(0x05070a, 0.052);

  const b = site.bounds;
  const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
  const h = site.ceilingHeight;

  const mat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });

  /* THE IMAGER IS NOT A COLOUR FILTER. Structure is at ambient, so on a thermal screen it
   * is a silhouette and nothing else. Rendering the same lit Lambert materials through the
   * second camera produced a picture that looked exactly like the eye's view with the fog
   * off — the mass and the contours vanished into a normally-lit room. So every mesh gets
   * a second, unlit material, and the thermal pass swaps them in.
   *
   * Anything hot names its own thermal colour; everything else is cold structure. */
  const thermalSwap = [];
  const both = (o, thermalColor = 0x101c26) => {
    o.layers.enable(L_THERMAL);
    if (o.isMesh) {
      o.userData.thermalMat = new THREE.MeshBasicMaterial({ color: thermalColor });
      thermalSwap.push(o);
    }
    return o;
  };

  /* Floor. Two of them: the visible concrete, and a thermal-only plane carrying the
   * sampled temperature field. The second is why the imager is an instrument rather
   * than a colour filter — it is reading the same numbers the anomaly reads. */
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(COL.floor));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  scene.add(floor);

  const thermalFloorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ map: thermalFloorTexture }),
  );
  thermalFloorMesh.rotation.x = -Math.PI / 2;
  thermalFloorMesh.position.set((b.minX + b.maxX) / 2, 0.012, (b.minZ + b.maxZ) / 2);
  thermalFloorMesh.layers.set(L_THERMAL);
  scene.add(thermalFloorMesh);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0x1b1e22));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set((b.minX + b.maxX) / 2, h, (b.minZ + b.maxZ) / 2);
  scene.add(ceiling);

  /* Structure. Porous shelving is drawn as open racking so the map TELLS you it is not
   * insulation — the one visual cue that explains why the draught walks through it. */
  const porous = new Set(site.doc.porousStatics || []);
  site.statics.forEach((r, i) => {
    const sx = r[2] - r[0], sz = r[3] - r[1];
    const cx = (r[0] + r[2]) / 2, cz = (r[1] + r[3]) / 2;
    if (porous.has(i)) {
      /* Racking: four shelf decks on posts. Reads as steel, reads as see-through. */
      for (let k = 0; k < 4; k++) {
        const deck = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.07, sz), mat(COL.steel));
        deck.position.set(cx, 0.55 + k * 0.68, cz);
        scene.add(both(deck));
      }
      const long = sz > sx;
      const n = Math.max(2, Math.round((long ? sz : sx) / 2.2));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.6, 0.1), mat(COL.steel));
        post.position.set(long ? cx : r[0] + sx * t, 1.3, long ? r[1] + sz * t : cz);
        scene.add(both(post));
      }
    } else {
      const box = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), mat(COL.panel));
      box.position.set(cx, h / 2, cz);
      scene.add(both(box));
      /* A pale band at head height: cold-store panel joints, and a navigation landmark
       * that survives the dark better than a texture would. */
      const band = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.02, 0.06, sz + 0.02), mat(COL.panelEdge));
      band.position.set(cx, 1.7, cz);
      scene.add(both(band));
    }
  });

  for (const c of site.crates) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), mat(COL.crate));
    box.position.set(c.x, 0.45, c.z);
    scene.add(both(box));
  }

  /* Doors move, so they are kept by id and repositioned rather than rebuilt. */
  const doorMeshes = new Map();
  for (const dr of site.doors) {
    const r = dr.rect;
    const sx = r[2] - r[0], sz = r[3] - r[1];
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, h - 0.15, sz), mat(COL.door));
    m.position.set((r[0] + r[2]) / 2, (h - 0.15) / 2, (r[1] + r[3]) / 2);
    scene.add(both(m));
    doorMeshes.set(dr.id, { mesh: m, closedY: (h - 0.15) / 2 });
  }

  /* Fixed props: breakers, the cargo point, the stair, the evidence sources. Each is a
   * silhouette you can navigate by, because GDD §14.3 wants landmarks you can say aloud. */
  for (const c of site.circuits.values()) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.16), mat(0x8a8f57));
    box.position.set(c.switchX, 1.3, c.switchZ);
    scene.add(both(box));
  }

  const cache = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 1.1), mat(0x39424d));
  body.position.y = 0.45;
  cache.add(body);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.09, 1.2), mat(0x59636f));
  lid.position.y = 0.94;
  cache.add(lid);
  cache.position.set(site.cache.x, 0, site.cache.z);
  cache.traverse((o) => both(o, 0x16232e));
  scene.add(cache);

  const stair = new THREE.Mesh(
    new THREE.CylinderGeometry(site.extraction.radius, site.extraction.radius, 0.04, 24),
    new THREE.MeshBasicMaterial({ color: COL.extraction, transparent: true, opacity: 0.35 }),
  );
  stair.position.set(site.extraction.x, 0.02, site.extraction.z);
  scene.add(both(stair));
  for (let k = 0; k < 5; k++) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.34), mat(0x4b5158));
    st.position.set(site.extraction.x, 0.09 + k * 0.18, site.extraction.z - 0.9 + k * 0.34);
    scene.add(both(st));
  }

  for (const s of site.doc.evidenceSources || []) {
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.1, 0.22), mat(COL.prop));
    post.position.y = 0.55;
    g.add(post);
    const tag = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.03), mat(0xb9c2c8));
    tag.position.y = 1.16;
    g.add(tag);
    g.position.set(s.at[0], 0, s.at[1]);
    g.userData.evidenceId = s.evidenceId;
    g.traverse((o) => both(o, 0x1a2530));
    scene.add(g);
  }

  /* Lights. Deliberately few: GDD §16.6 caps dynamic lights, and darkness is a mechanic. */
  scene.add(new THREE.AmbientLight(0x35404a, 0.40));
  scene.add(new THREE.HemisphereLight(0x2a3a4c, 0x0d1014, 0.48));

  const luminaireLights = site.luminaires.map((l) => {
    const light = new THREE.PointLight(l.emergency ? 0xff9a5a : 0xcfe4ff, 0, l.emergency ? 7 : 9, 1.6);
    light.position.set(l.x, h - 0.25, l.z);
    scene.add(light);
    const fitting = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.16), mat(l.emergency ? 0x5a3a2a : 0x50565e));
    fitting.position.set(l.x, h - 0.16, l.z);
    scene.add(both(fitting));
    return { light, def: l };
  });

  /* NOTE the name: `thermalFloorMesh`, not `thermalFloor`. The renderer spreads this
   * object over itself, and a key called `thermalFloor` silently overwrote the
   * ThermalFloor INSTANCE with this mesh — the imager then rendered a texture that was
   * never updated again, and the only symptom was a floor image frozen at boot. */
  return { scene, doorMeshes, luminaireLights, thermalFloorMesh, thermalSwap, L_WORLD, L_THERMAL, COL };
}
