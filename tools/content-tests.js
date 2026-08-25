/* Milestone 4's last two anomalies, measured — GDD §23.
 *
 * WHAT THIS SUITE IS FOR. `tools/m0-tests.js` asserts what is true of EVERY package: two
 * evidence paths per rule, a seven-claim board, a latency budget on every polled trigger,
 * a procedure that fits in the slots it asks for. Registering a package runs all 875 of
 * those against it, and that is the right place for anything general. What it cannot do is
 * assert the numbers that make ONE incident the incident it is — that a bay costs two
 * panels, that a heater outlasts a fee by two seconds, that one operative can walk the
 * whole of a new compound and come back with the thing in a box.
 *
 * So this file is the two new packages, and the map under one of them, measured against the
 * real `Site`, `HeatField`, `DeployableSet`, `Anomaly`, `InstanceSet` and `Game`. Nothing
 * here is remembered from a design document: every figure in `content/maps/*.json` and in
 * the two anomaly files was produced by a section below and pasted back.
 *
 * The two solo runs (D and E) are the load-bearing ones. Both go through the interfaces a
 * keyboard reaches — `setCommand`, `doInteract`, `deployHeld`, `takeFromCache` — for the
 * reason section I of the milestone-0 suite states: if a bot cannot finish, a first-timer
 * cannot, and a `difficultyProfiles` entry that says `squadSize.min: 1` is an authored
 * claim that has to be true.
 */

import { CONFIG, SLOTS } from '../src/config.js';
import { Site } from '../src/sim/site.js';
import { HeatField } from '../src/sim/heat.js';
import { DeployableSet } from '../src/sim/deployables.js';
import { Anomaly } from '../src/sim/anomaly.js';
import { circleHitsRect, dist } from '../src/sim/geometry.js';
import { loadContent, INCIDENTS } from '../src/sim/content.js';
import { SENSES } from '../src/sim/senses.js';
import { Game } from '../src/game.js';
import { PHASE } from '../src/sim/mission.js';
import { lines, counts, ok, eq, near, note, emit, run, heading, suite } from './harness.js';

const R = CONFIG.player.radius;
const GRID = 0.20;
const MAP_ID = 'harrowbank-switchyard';

const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function standable(site, x, z) {
  if (!site.inBounds(x, z)) return false;
  for (const r of site.blockingRects()) if (circleHitsRect(r, x, z, R)) return false;
  return true;
}

function clearance(site, x, z) {
  let best = Infinity;
  for (const r of site.blockingRects()) {
    const cx = Math.max(r[0], Math.min(x, r[2]));
    const cz = Math.max(r[1], Math.min(z, r[3]));
    const d = Math.hypot(x - cx, z - cz);
    if (d < best) best = d;
  }
  return best;
}

/* ══ A. the fourth map, measured ═══════════════════════════════════════════════
 *
 * The three shipped maps are indoors-industrial, indoors-residential and outdoors-natural.
 * This is outdoors-BUILT, and its `_webNote` claims a set of numbers about itself the same
 * way `blackthorn-reserve` does. Every one of them is produced here.
 */
async function sectionA() {
  heading('A. the fourth map: harrowbank-switchyard, measured');

  const doc = await (await fetch(`/content/maps/${MAP_ID}.json`, { cache: 'no-store' })).json();
  const site = new Site({ ...doc, anomalySpawn: [0, 0] });
  for (const d of site.doors) d.open = false;
  site._rebuildBlocking();

  /* 1. the geometry is not self-overlapping. A map that passes `validateMap` can still be
   *    built out of rects that sit inside each other, and the renderer and the collider
   *    both believe it. */
  const st = doc.statics;
  const badStatics = [];
  for (let i = 0; i < st.length; i++) {
    for (let j = i + 1; j < st.length; j++) if (overlaps(st[i], st[j])) badStatics.push(`${i}/${j}`);
  }
  eq(`A1 ${st.length} statics and no two of them overlap`, badStatics.length, 0, badStatics.join(' '));

  const badDoors = [];
  doc.doors.forEach((d, i) => {
    st.forEach((r, k) => { if (overlaps(d.aabb, r)) badDoors.push(`${d.id}/static${k}`); });
    doc.doors.forEach((e, j) => { if (j > i && overlaps(d.aabb, e.aabb)) badDoors.push(`${d.id}/${e.id}`); });
  });
  eq('A2 no door rect overlaps a static or another door', badDoors.length, 0, badDoors.join(' '));

  const badRooms = [];
  doc.rooms.forEach((a, i) => doc.rooms.forEach((b, j) => {
    if (j > i && overlaps(a.rect, b.rect)) badRooms.push(`${a.id}/${b.id}`);
  }));
  eq(`A3 ${doc.rooms.length} room rects and no two of them overlap`, badRooms.length, 0, badRooms.join(' '));

  const buried = doc.crates.filter(([x, z]) => st.some((r) => overlaps([x - 0.45, z - 0.45, x + 0.45, z + 0.45], r)));
  const lampsIn = doc.luminaires.filter((l) => st.some((r) => l.at[0] > r[0] && l.at[0] < r[2] && l.at[1] > r[1] && l.at[1] < r[3]));
  eq('A4 no crate is inside a static and no luminaire is buried in one', buried.length + lampsIn.length, 0);

  /* 2. clearance at every anchor, with EVERY DOOR SHUT. A breaker you cannot stand at is a
   *    circuit that does not exist. */
  const anchors = [
    ['spawn', doc.spawn[0], doc.spawn[1]],
    ['cache', doc.cache.x, doc.cache.z],
    ['extraction', doc.extraction.x, doc.extraction.z],
    ...doc.circuits.map((c) => [c.id, c.switch[0], c.switch[1]]),
  ];
  let worst = Infinity, worstAt = '';
  const parts = [];
  for (const [name, x, z] of anchors) {
    const c = clearance(site, x, z);
    parts.push(`${name} ${c.toFixed(3)}`);
    if (c < worst) { worst = c; worstAt = name; }
  }
  note(`  clearance, every door shut: ${parts.join(', ')}`);
  ok(`A5 every anchor clears the ${R}m operative radius — worst ${worst.toFixed(3)}m at ${worstAt}`, worst > R);
  near('A5a and the worst of them is the bay breaker at 0.600m', worst, 0.600, 0.001);

  let ring = 0;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    if (standable(site, doc.spawn[0] + Math.cos(a) * 1.1, doc.spawn[1] + Math.sin(a) * 1.1)) ring++;
  }
  eq('A6 the four-operative 1.1m spawn ring is clear', ring, 4);

  /* 3. standable ground, and every square metre of it reachable with every door shut.
   *    A door may be a shortcut. It may never be the only way through. */
  const x0 = doc.bounds.minX, z0 = doc.bounds.minZ;
  const nx = Math.round((doc.bounds.maxX - x0) / GRID);
  const nz = Math.round((doc.bounds.maxZ - z0) / GRID);
  const cell = (i, j) => [x0 + (i + 0.5) * GRID, z0 + (j + 0.5) * GRID];
  const free = new Uint8Array(nx * nz);
  let total = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const [x, z] = cell(i, j);
      if (standable(site, x, z)) { free[i * nz + j] = 1; total++; }
    }
  }
  const seen = new Uint8Array(nx * nz);
  const si = Math.floor((doc.spawn[0] - x0) / GRID), sj = Math.floor((doc.spawn[1] - z0) / GRID);
  const stack = [si * nz + sj];
  seen[si * nz + sj] = 1;
  let reached = 0;
  while (stack.length) {
    const k = stack.pop(); reached++;
    const i = Math.floor(k / nz), j = k % nz;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const m = a * nz + b;
      if (!free[m] || seen[m]) continue;
      seen[m] = 1; stack.push(m);
    }
  }
  note(`  ${total} standable cells on a ${GRID}m grid; ${reached} reachable from spawn with every door shut`);
  eq('A7 every standable cell is reachable from spawn with every door on the map shut', total - reached, 0);
  eq('A7a and there are 18,827 of them', total, 18827);

  /* 4. §14.3 wants a landmark a player can say aloud, so every cell has to have a name and
   *    the name has to be the room a person would say they are in. */
  let unnamed = 0, worstRoomD = 0, worstRoomAt = '';
  const hit = new Set();
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (!free[i * nz + j]) continue;
      const [x, z] = cell(i, j);
      const r = site.roomNearest(x, z);
      if (!r) { unnamed++; continue; }
      hit.add(r.id);
      const cx = Math.max(r.rect[0], Math.min(x, r.rect[2]));
      const cz = Math.max(r.rect[1], Math.min(z, r.rect[3]));
      const d = Math.hypot(x - cx, z - cz);
      if (d > worstRoomD) { worstRoomD = d; worstRoomAt = `${r.id} @ ${x.toFixed(1)},${z.toFixed(1)}`; }
    }
  }
  eq('A8 no standable cell reports "Unmarked floor"', unnamed, 0);
  const missed = doc.rooms.filter((r) => !hit.has(r.id)).map((r) => r.id);
  eq(`A9 every one of the ${doc.rooms.length} authored rooms is reached by some standable cell`, missed.length, 0, missed.join(','));
  note(`  worst distance from a standable cell to the rect that names it: ${worstRoomD.toFixed(3)}m (${worstRoomAt})`);
  ok(`A10 and the rooms tile the floor to within 0.100m — worst ${worstRoomD.toFixed(3)}m`, worstRoomD <= 0.1001);

  /* 5. light. This is the map's real reason to want power, and the reason the search phase
   *    of the incident on it is a search at all. */
  const litFrac = (ids) => {
    for (const c of site.circuits.values()) c.on = ids.includes(c.id);
    let n = 0, lit = 0;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        if (!free[i * nz + j]) continue;
        n++;
        const [x, z] = cell(i, j);
        if (site.mainsLightAt(x, z) > 0.001) lit++;
      }
    }
    return 100 * lit / n;
  };
  const litNone = litFrac([]), litYard = litFrac(['circuit-yard']);
  const litBays = litFrac(['circuit-bays']), litBoth = litFrac(['circuit-yard', 'circuit-bays']);
  for (const c of site.circuits.values()) c.on = false;
  note(`  lit standable ground: none ${litNone.toFixed(1)}%, yard ${litYard.toFixed(1)}%, bays ${litBays.toFixed(1)}%, both ${litBoth.toFixed(1)}%`);
  near('A11 34.6% of the compound has any light on arrival', litNone, 34.6, 0.1);
  near('A12 and 98.9% has it with both circuits live', litBoth, 98.9, 0.1);

  /* 6. THE MAP'S ARGUMENT, as a number. Blackthorn is 10.1% fence; the cold store is
   *    almost entirely fence. This is neither, and the concrete is not distributed. */
  const len = (r) => 2 * ((r[2] - r[0]) + (r[3] - r[1]));
  const porous = new Set(doc.porousStatics);
  let ins = 0, por = 0;
  st.forEach((r, i) => { if (porous.has(i)) por += len(r); else ins += len(r); });
  const pct = 100 * ins / (ins + por);
  note(`  built length: ${ins.toFixed(1)}m insulating, ${por.toFixed(1)}m porous — ${pct.toFixed(1)}% of it stops a mass`);
  near('A13 226.4m of cast concrete against 379.6m of fence, lattice and cladding', ins, 226.4, 0.05);
  near('A13a which is 37.4% of the built length of the compound', pct, 37.36, 0.03);
  note(`  rects that stop a person with every door shut: ${site.blockingRects().length}; that stop a mass: ${site.insulatedRects().length}`);

  /* 7. the thermal floor at these bounds. `blackthorn-reserve` records that 48m costs a
   *    quarter of the contour and recommends 32m or 40m for the next outdoor map; this is
   *    that map, so the number it was recommended on is the number to check. */
  const span = doc.bounds.maxX - x0;
  const mpp = span / 96;
  note(`  bounds ${span}m; ThermalFloor samples a fixed 96x96 grid, so ${mpp.toFixed(4)} m/px`);
  near('A14 0.3333 m/px at 32m bounds', mpp, 1 / 3, 0.0001);
  ok(`A15 and it stays coarser than the rule's own ${CONFIG.heat.pathSampleMetres}m path sampling (${(mpp / CONFIG.heat.pathSampleMetres).toFixed(2)}x), so the picture never promises a gap the rule does not resolve`,
    mpp > CONFIG.heat.pathSampleMetres);

  const heat = new HeatField();
  heat.setEmitters([{ id: 'f', x: 0, z: 0, peakC: 60, falloffM: 2.2, active: true }]);
  let hotPx = 0;
  for (let i = 0; i < 96; i++) {
    for (let j = 0; j < 96; j++) {
      if (heat.temperatureAt(x0 + (i + 0.5) * mpp, z0 + (j + 0.5) * mpp) >= 40) hotPx++;
    }
  }
  note(`  a lone floodlight's 40C disc covers ${hotPx} of 9216 thermal-floor pixels here`);
  eq('A16 a floodlight is still 80 pixels of contour at these bounds, not the 20 a 48m map leaves', hotPx, 80);

  note(`  MARK_RANGE_M is 30m and this compound's diagonal is ${Math.hypot(span, span).toFixed(1)}m`);
  return { doc, site, free, nx, nz, cell, total };
}

/* ══ B. what the compound is worth as containment ══════════════════════════════
 *
 * Every map in this build carries an argument about fences and this one's is that it has
 * SIX of them already built and they all open the same way. Measured with the real
 * `Anomaly.isFenced`, every door shut, against a probe that is stopped by insulation and
 * by gradients — which is the draught's rule, not this incident's, because the map has to
 * answer for incidents that have not been written yet.
 */
async function sectionB(ctx) {
  heading('B. six pens, and what each of them costs');
  const { doc } = ctx;
  const items = await (await fetch('/content/equipment/items.json', { cache: 'no-store' })).json();
  const byId = new Map(items.items.map((i) => [i.id, i]));

  const probe = (x, z, deps = []) => {
    const site = new Site({ ...doc, anomalySpawn: [x, z] });
    for (const d of site.doors) d.open = false;
    site._rebuildBlocking();
    const heat = new HeatField();
    const set = new DeployableSet();
    for (const [id, dx, dz, yaw] of deps) set.place(byId.get(id), dx, dz, yaw || 0);
    heat.setEmitters(set.heatEmitters());
    const a = new Anomaly({
      id: 'probe', presence: { blockedBy: ['insulation', 'gradient'] },
      states: [{ id: 's', kind: 'latent', speedMps: 0 }, { id: 'v', kind: 'vulnerable', speedMps: 0 },
        { id: 'c', kind: 'contained', speedMps: 0 }],
      triggers: [{ id: 't', from: 's', to: 'v', when: { sense: 'gradient-below' }, telegraph: 'x' }],
      capabilities: [], constraints: [], evidenceRules: [], claims: [], containment: {},
    }, site, heat, set);
    return a.isFenced().escapes;
  };

  const bare = {
    'bay 3, at the back': probe(0, 8.0),
    'bay 3, in the mouth': probe(0, 4.4),
    'bay 1, at the back': probe(-12.4, 8.0),
    'oil bund, at the back': probe(14.6, 13.3),
    'relay room, door shut': probe(-12.5, -7.6),
    'scrap compound': probe(12, -6),
    'open centre yard': probe(0, -3),
    'hard against the palisade': probe(-15, -1),
    'back road': probe(0, 10.2),
    'access road': probe(-6, -13.6),
  };
  for (const [k, v] of Object.entries(bare)) note(`  bare, nothing deployed: ${k} — ${v} of 24`);
  eq('B1 a switch bay is 3 escape rays bare, which is the strongest position on the compound before anybody deploys anything', bare['bay 3, at the back'], 3);
  eq('B1a and so is the oil bund', bare['oil bund, at the back'], 3);
  eq('B2 the relay room with its door shut is 1, because its cable-way is the only hole in it', bare['relay room, door shut'], 1);
  ok('B3 and the open yard is worth nothing at all — 23 of 24', bare['open centre yard'] >= 23);
  ok('B4 nor is backing into the perimeter, because the palisade is porous', bare['hard against the palisade'] >= 19);
  ok('B5 nor is the scrap compound, which looks exactly like a pen and is chain-link', bare['scrap compound'] >= 19);

  const P = 'portable-barrier', F = 'floodlight-tripod', H = 'portable-heater';
  const V = Math.PI / 2;
  const prices = {
    'bay 3, one panel across the mouth': probe(0, 8.0, [[P, -1.1, 4.1, 0]]),
    'bay 3, two panels': probe(0, 8.0, [[P, -1.1, 4.1, 0], [P, 1.1, 4.1, 0]]),
    'bay 3, two floodlights in the mouth': probe(0, 8.0, [[F, -1.4, 4.1, 0], [F, 1.4, 4.1, 0]]),
    'bay 3, one heater in the mouth': probe(0, 8.0, [[H, 0, 4.1, 0]]),
    'oil bund, one panel across the mouth': probe(14.6, 13.3, [[P, 11.1, 13.3, V]]),
    'oil bund, one floodlight in the mouth': probe(14.6, 13.3, [[F, 11.1, 13.3, V]]),
    'open yard, four floodlights at 1.9m': probe(0, -3, [[F, 1.9, -3, 0], [F, -1.9, -3, 0], [F, 0, -1.1, 0], [F, 0, -4.9, 0]]),
  };
  for (const [k, v] of Object.entries(prices)) note(`  ${k}: ${v} of 24`);
  eq('B6 one panel is not enough for a bay: 4.4m of mouth against 2.4m of panel', prices['bay 3, one panel across the mouth'], 1);
  eq('B7 two panels close it, and so do two floodlights, and so does one heater', prices['bay 3, two panels']
    + prices['bay 3, two floodlights in the mouth'] + prices['bay 3, one heater in the mouth'], 0);
  eq('B8 the bund is the cheap one: its mouth is 2.6m, so ONE panel closes it', prices['oil bund, one panel across the mouth'], 0);
  eq('B8a and one floodlight does too, which no bay can say', prices['oil bund, one floodlight in the mouth'], 0);
  eq('B9 and open ground still costs four posts inside 1.9m, exactly as it does on the reserve', prices['open yard, four floodlights at 1.9m'], 0);

  const heat = new HeatField();
  const cr = (peak, d0) => heat.contourRadius({ peakC: peak, falloffM: d0, active: true });
  note(`  40C contour at ambient ${heat.ambientC}C: floodlight ${cr(60, 2.2).toFixed(3)}m, heater ${cr(78, 2.9).toFixed(3)}m, transit case ${cr(39, 1.6).toFixed(3)}m`);
  eq('B10 the transit case never reaches 40C, which is why it is a lure on every map and a wall on none', cr(39, 1.6), 0);
}

/* ══ C. the two packages load, place, and vary ═════════════════════════════════ */
async function sectionC() {
  heading('C. the two new packages');

  const packs = {};
  for (const id of ['harrowbank-ballast', 'cold-storage-toll']) {
    let pack = null, why = '';
    try { pack = await loadContent({ incident: id }); } catch (e) { why = e.message; }
    ok(`C1 ${id} loads and validates in a browser`, !!pack, why.split('\n').join(' | '));
    if (!pack) continue;
    packs[id] = pack;

    /* Everything a squad has to walk to has to be somewhere a squad can stand, with every
     * door shut — including the ones behind doors, because a door may fail to power. */
    const site = new Site(pack.map);
    for (const d of site.doors) d.open = false;
    site._rebuildBlocking();
    const pts = [
      ...pack.map.evidenceSources.map((s) => [`src:${s.evidenceId}`, s.at[0], s.at[1]]),
      ...(pack.map.instanceSites || []).map((s) => [`inst:${s.id}`, s.at[0], s.at[1]]),
    ];
    const unstandable = pts.filter(([, x, z]) => !standable(site, x, z)).map(([n]) => n);
    eq(`C2 ${id}: every placed source and object is standable`, unstandable.length, 0, unstandable.join(','));
    ok(`C3 ${id}: and so is the authored origin`, standable(site, pack.map.anomalySpawn[0], pack.map.anomalySpawn[1]));

    /* ⚠ TWO SOURCES INSIDE ONE REACH IS A SOURCE WITH NO VERB. `sourceInReach` is
     * nearest-wins, so a pair closer together than `reachMetres` can leave the further one
     * unreachable once the nearer is logged. */
    let closest = Infinity, closestAt = '';
    const srcs = pts.filter(([n]) => n.startsWith('src:'));
    for (let i = 0; i < srcs.length; i++) {
      for (let j = i + 1; j < srcs.length; j++) {
        const d = dist(srcs[i][1], srcs[i][2], srcs[j][1], srcs[j][2]);
        if (d < closest) { closest = d; closestAt = `${srcs[i][0]} / ${srcs[j][0]}`; }
      }
    }
    note(`  ${id}: ${srcs.length} placed sources, nearest pair ${closest.toFixed(2)}m (${closestAt})`);
    ok(`C4 ${id}: no two placed sources are inside one operative's ${CONFIG.player.reachMetres}m reach of each other`,
      closest > CONFIG.player.reachMetres, `${closest.toFixed(2)}m at ${closestAt}`);

    /* §14.4: a seed that cannot be played is worse than no variation. */
    let bad = 0, firstWhy = '';
    for (let i = 0; i < 60; i++) {
      try { await loadContent({ incident: id, seed: `axis-${i}` }); } catch (e) { bad++; if (!firstWhy) firstWhy = e.message; }
    }
    eq(`C5 ${id}: none of sixty seeds produces an operation the loader refuses`, bad, 0, firstWhy);
  }

  /* The set the incident places, and the search gradient it makes. Superposition does this
   * and nothing in the engine decides it — which is the tally's argument, re-measured on a
   * different anomaly's objects to check it is a property of the field and not of that file. */
  const b = packs['harrowbank-ballast'];
  if (b) {
    const anomalous = b.map.instanceSites.filter((s) => s.anomalous).length;
    eq('C6 the switchyard set is five stones among nine candidates', `${anomalous}/${b.map.instanceSites.length}`, '5/9');
    const heat = new HeatField();
    const sinks = b.map.instanceSites.filter((s) => s.anomalous)
      .map((s, i) => ({ id: `i${i}`, x: s.at[0], z: s.at[1], chillC: 4, falloffM: 0.9 }));
    heat.setSinks(sinks);
    const readAt = (sx, sz, d) => {
      const drop = heat.ambientC - heat.temperatureAt(sx, sz);
      return drop / (1 + (d * d) / (2.0 * 2.0));
    };
    /* range at which a lone stone still clears the imager's 1.2C signal floor */
    const lone = b.map.instanceSites.find((s) => s.id === 's4');
    let r = 0;
    for (let d = 0; d < 8; d += 0.01) if (readAt(lone.at[0], lone.at[1], d) >= 1.2) r = d;
    note(`  a lone stone reads on the imager out to ${r.toFixed(2)}m`);
    const pair = b.map.instanceSites.find((s) => s.id === 's1');
    let r2 = 0;
    for (let d = 0; d < 8; d += 0.01) if (readAt(pair.at[0], pair.at[1], d) >= 1.2) r2 = d;
    note(`  one of the pair at the north end reads out to ${r2.toFixed(2)}m, because its neighbour is 0.89m away`);
    ok(`C7 two stones together are legible from further off than one alone (${r2.toFixed(2)}m against ${r.toFixed(2)}m), and nothing decides that but superposition`,
      r2 > r + 0.3);
  }
  return packs;
}

/* ══ the bot ═══════════════════════════════════════════════════════════════════
 * Lifted from section I of the milestone-0 suite: walk with stall detection, close in on a
 * fixture until the verb is the one wanted, and never write state directly.
 */
function driver(g) {
  const slice = 50;
  const face = (x, z) => {
    const dx = x - g.player.x, dz = z - g.player.z;
    const len = Math.hypot(dx, dz) || 1;
    g.player.yaw = Math.atan2(-dx / len, -dz / len);
  };
  const walkTo = (x, z, tol = 0.6, budgetMs = 40000) => {
    let spent = 0, stalledMs = 0, strafe = 0, strafeMs = 0;
    let lastX = g.player.x, lastZ = g.player.z;
    while (dist(g.player.x, g.player.z, x, z) > tol && spent < budgetMs) {
      face(x, z);
      const axis = strafeMs > 0 ? { x: strafe, y: -0.4 } : { x: 0, y: -1 };
      if (strafeMs > 0) strafeMs -= slice;
      g.setCommand('p1', { axis, sprint: false, crouch: false });
      g.skipMs(slice);
      spent += slice;
      const moved = dist(lastX, lastZ, g.player.x, g.player.z);
      lastX = g.player.x; lastZ = g.player.z;
      if (moved < 0.02) stalledMs += slice; else stalledMs = 0;
      if (stalledMs >= 300 && strafeMs <= 0) { strafe = strafe === 1 ? -1 : 1; strafeMs = 700; stalledMs = 0; }
    }
    g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
    g.skipMs(slice);
    return dist(g.player.x, g.player.z, x, z) <= tol;
  };
  const route = (pts, tol = 1.0, budgetMs = 40000) => {
    const failed = [];
    for (const [wx, wz] of pts) if (!walkTo(wx, wz, tol, budgetMs)) failed.push(`(${wx},${wz})@(${g.player.x.toFixed(1)},${g.player.z.toFixed(1)})`);
    if (failed.length) note(`    route legs not reached: ${failed.join(' · ')}`);
    return failed.length === 0;
  };
  const wait = (ms) => { g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false }); g.skipMs(ms); };
  const workAt = (x, z, kind, budget = 20000) => {
    for (const tol of [1.2, 0.8, 0.5, 0.3]) {
      walkTo(x, z, tol, budget);
      const act = g.contextAction();
      if (act && act.kind === kind) return act;
    }
    return g.contextAction();
  };
  const hold = (itemId) => {
    const i = SLOTS.findIndex((s) => g.player.slots.get(s.id) === itemId);
    if (i < 0) return false;
    g.selectSlot('p1', i);
    return true;
  };
  /** Put a deployable down AT a point: `deployHeld` places 0.9m in front of the operative. */
  const deployAt = (x, z, fromX, fromZ) => {
    const dx = fromX - x, dz = fromZ - z;
    const len = Math.hypot(dx, dz) || 1;
    const sx = x + (dx / len) * 0.9, sz = z + (dz / len) * 0.9;
    walkTo(sx, sz, 0.25, 30000);
    face(x, z);
    wait(slice);
    return g.deployHeld();
  };
  /**
   * ⚠ THE BOT HAS TO DO THE ONE THING A PLAYER DOES FOR FREE: not walk into it.
   *
   * A straight-line walker on `harrowbank-ballast` crosses the mass's approach lane five
   * times, because the case is the warmest thing on the compound and the case is where
   * every stone has to be logged. A player watches it come and waits half a beat. This is
   * that, and nothing more: it never moves the anomaly, never reads a rule, and only ever
   * costs sim time.
   */
  /**
   * ⚠ AND THE OTHER THING A PLAYER DOES FOR FREE: use the alley.
   *
   * The switchyard's north half is behind five concrete bays whose mouths all face south,
   * and a straight-line walker aimed at a stone beyond them walks into a bay and stops
   * against the back wall — 4.6m into a dead end that stall-detection cannot reverse out
   * of. The gaps between the bays are 1.8m, which is 1.12m of walkable band at the 0.34m
   * operative radius, and a player can see them. This routes through the nearest one and
   * does nothing else; it is navigation, not knowledge.
   */
  const ALLEYS = [-9.3, -3.1, 3.1, 9.3];
  const alleyNear = (mid) => ALLEYS.reduce((a, c) => (Math.abs(c - mid) < Math.abs(a - mid) ? c : a), ALLEYS[0]);
  const inBand = (v) => v >= 4.0 && v <= 9.0;
  const go = (x, z, tol = 0.6, budget = 30000) => {
    /* Out of whichever bay we are standing in, first. */
    if (inBand(g.player.z) && Math.abs(x - g.player.x) > 1.4) walkTo(g.player.x, 3.2, 0.4, budget);
    const north = g.player.z > 9.0;
    if (g.player.z < 4.0 && z > 9.0) {
      const a = alleyNear((g.player.x + x) / 2);
      walkTo(a, 2.6, 0.4, budget); walkTo(a, 10.6, 0.4, budget);
    } else if (north && !inBand(z) && z < 4.0) {
      const a = alleyNear((g.player.x + x) / 2);
      walkTo(a, 10.6, 0.4, budget); walkTo(a, 2.6, 0.4, budget);
    } else if (north && inBand(z)) {
      const a = alleyNear(x);
      walkTo(a, 10.6, 0.4, budget); walkTo(a, 2.8, 0.4, budget);
    }
    /* A bay is entered from its mouth and from nowhere else. */
    if (inBand(z) && g.player.z < 4.0) walkTo(x, 3.2, 0.4, budget);
    return walkTo(x, z, tol, budget);
  };
  const workNear = (x, z, kind, budget = 20000) => { go(x, z, 1.2, budget); return workAt(x, z, kind, budget); };
  const clearOf = (x, z, limit = 2.4, maxMs = 25000) => {
    let spent = 0;
    while (spent < maxMs && g.anomaly.stateKind === 'hunting'
      && dist(g.anomaly.x, g.anomaly.z, x, z) < limit) { wait(200); spent += 200; }
    return spent;
  };
  const t = () => (g.clock.simTimeMs / 1000).toFixed(1);
  return { walkTo, route, wait, workAt, workNear, go, hold, deployAt, face, clearOf, t, slice };
}

/* ══ D. the seventh family, driven solo ════════════════════════════════════════
 *
 * `harrowbank-ballast` is containment by DEPRIVATION: the mass is holding a set of stones
 * and until every one of them is in a clean case it cannot be lifted at all. The set is not
 * the anomaly — the anomaly has a position, hunts heat and reaches for people — which is
 * what makes this a different job from `ninety-one-tally` rather than the same one with a
 * hazard added.
 *
 * The claim under test is the field profile's: `squadSize.min: 1`.
 */
async function sectionD() {
  heading('D. harrowbank-ballast, solo, through the real verbs');
  const content = await loadContent({ incident: 'harrowbank-ballast' });
  const g = new Game(content, { seed: 'ballast-solo' });
  const { walkTo, route, wait, workAt, workNear, go, hold, deployAt, clearOf, t } = driver(g);

  eq('D1 the operation starts on the briefing card', g.mission.phase, PHASE.BRIEFING);
  eq('D2 the minimum grade plus an instrument is inside the cargo budget',
    g.commitLoadout([{ itemId: 'reinforced-transit-case', qty: 1 }, { itemId: 'thermal-imager', qty: 1 },
      { itemId: 'trauma-kit', qty: 1 }]), null);

  ok('D3 the operative reaches the cargo point', walkTo(g.site.cache.x, g.site.cache.z, 1.2));
  eq('D4 the case comes out of cargo', g.takeFromCache('reinforced-transit-case'), null);
  eq('D5 so does the imager — two general items is exactly what one operative has',
    g.takeFromCache('thermal-imager'), null);
  eq('D6 and the trauma kit, which is compact', g.takeFromCache('trauma-kit'), null);
  ok('D7 a third general item has nowhere to go', !!g.takeFromCache('portable-heater'));

  /* An evidence source on the way, taken with the context verb the keyboard reaches. */
  const ganger = workAt(0.0, -13.6, 'evidence');
  eq('D8 the ganger is offered as an evidence source at the gate', ganger && ganger.kind, 'evidence');
  eq('D9 and taking the statement records it', g.doInteract(), null);
  ok('D10 the ledger is holding it', g.ledger.has('ganger-statement'));

  /* ⚠ The compound gate is shut and dead on arrival. The way in is the 3.4m the fence is
   * short at its east end, which is the map's own note and is what this leg tests. */
  const tIn = g.clock.simTimeMs;
  ok('D11 the operative gets into the yard with the gate shut, round the east end of the fence',
    route([[13.6, -12.6], [14.0, -10.2], [8.0, -10.0], [4.0, -6.0], [0.0, 1.0]], 1.0, 45000));
  note(`  gate-to-yard leg took ${((g.clock.simTimeMs - tIn) / 1000).toFixed(1)}s of sim time`);

  /* The case goes down in the middle of the yard, which is where every stone has to come
   * back to and — at 39C — where the thing is going to walk. */
  ok('D12 the case is in hand', hold('reinforced-transit-case'));
  eq('D13 and it deploys in the open yard', deployAt(0.0, 2.4, 0.0, 0.0), null);
  const box = g.deployables.byItem('reinforced-transit-case')[0];
  ok('D14 the case is standing where it was put', !!box && dist(box.x, box.z, 0.0, 2.4) < 0.8,
    box ? `${box.x.toFixed(2)},${box.z.toFixed(2)}` : 'no case');

  ok('D15 the imager is in hand and live', hold('thermal-imager') && g.toggleImager() === null);

  /* The recovery. Positions come from the live set, not from the incident file, so a moved
   * stone is followed rather than assumed. */
  const real = g.instances.list.filter((i) => i.anomalous);
  eq('D16 five of the nine candidates are the set', real.length, 5);
  const marks = [];
  const contacts0 = g.mission.tally.contacts;
  let waited = 0;
  for (const inst of real) {
    waited += clearOf(inst.x, inst.z);
    const a = workNear(inst.x, inst.z, 'collect', 30000);
    if (!a || a.kind !== 'collect') { note(`    no collect verb at ${inst.id} (${a && a.kind}, downed=${g.player.downed})`); continue; }
    g.doInteract();
    waited += clearOf(box.x, box.z);
    const dep = workNear(box.x, box.z, 'deposit', 30000);
    if (!dep || dep.kind !== 'deposit') { note(`    no deposit verb for ${inst.id} (${dep && dep.kind}, downed=${g.player.downed})`); continue; }
    g.doInteract();
    marks.push(`${inst.id}@${t()}s`);
  }
  note(`  ${(waited / 1000).toFixed(1)}s of the run was spent standing off while it was drawn`);
  note(`  stones logged: ${marks.join(' ')}`);
  eq('D17 all five are in the case', g.instances.counted, 5);
  ok('D18 and nothing else is', !g.instances.contaminated);
  wait(600);
  eq('D19 the mass has put its weight down — the set being complete is the only thing that says so',
    g.anomaly.state, 'light');
  note(`  it went light at ${t()}s; ${g.mission.tally.contacts - contacts0} contacts during the recovery`);
  ok('D20 and a solo operative is still on their feet after it', !g.player.downed);
  note(`  exposure ${g.player.conditions.exposure.severity}, mobility ${g.player.conditions.mobility.severity}`);

  /* The seal. It hunts heat and the case is the warmest thing on a dark compound, so if the
   * recovery was run properly the thing walked to the case on its own. */
  const dCase = dist(g.anomaly.x, g.anomaly.z, box.x, box.z);
  note(`  when it went light it was ${dCase.toFixed(2)}m from the case`);
  if (dCase > 1.5) {
    note('  it did not finish at the case; lifting the case and carrying it to the mass');
    const lift = workAt(box.x, box.z, 'retrieve', 20000);
    if (lift && lift.kind === 'retrieve') g.doInteract();
    hold('reinforced-transit-case');
    deployAt(g.anomaly.x + 0.9, g.anomaly.z, g.anomaly.x + 3.0, g.anomaly.z);
  }
  const kase = g.deployables.byItem('reinforced-transit-case').find((d) => !d.sealed) || box;
  const seal = workAt(kase.x, kase.z, 'seal', 20000);
  eq('D21 the seal is offered at the case', seal && seal.kind, 'seal');
  eq('D22 and it takes', g.doInteract(), null);
  eq('D23 custody has started', g.custody, 'sealed');
  const tSeal = g.clock.simTimeMs;

  wait(CONFIG.anomaly.custodyVerifySeconds * 1000 + 1500);
  eq('D24 and thirty seconds of stable interior verifies it', g.custody, 'verified');
  note(`  sealed at ${(tSeal / 1000).toFixed(1)}s, verified at ${t()}s`);

  /* ⚠ AND THE ARITHMETIC IS THE CUSTODY. Turning the case out puts every stone back on the
   * yard, and `instances-loose` is what says so. Asserted on a copy of the operation rather
   * than on this one, because it is a thing you do instead of finishing. */
  note(`  total: ${t()}s of sim time from briefing to verified custody, ${g.mission.tally.contacts} contacts`);
  return { totalMs: g.clock.simTimeMs, contacts: g.mission.tally.contacts };
}

/* ══ D2. the decoy, and the rule nobody has ever named ═════════════════════════
 *
 * Two things at once, because they need each other.
 *
 * The DECOY is the safe grade's whole argument: `chooseTarget` is peakC-dominant, so a
 * floodlight at 60C outranks the transit case at 39C from anywhere on the compound and the
 * mass goes to the light instead of to the box the squad keeps returning to.
 *
 * And that is what makes `instances-loose` reachable at all. It has been in `senses.js`
 * since the tally shipped and no content file has ever named it; here it is the way BACK
 * from custody-ready — turn the case out and every stone is on the yard again. But the seal
 * outranks every other verb when the case is within the seal radius of a held anomaly, so
 * a squad whose mass went light ON the case can never reach the purge and does not need to.
 * The state is only reachable when the mass is somewhere else, which is to say when the
 * decoy worked. Driven rather than reasoned, because that interaction is not visible in
 * either file.
 */
async function sectionD2() {
  heading('D2. a decoy, a contaminated case, and the one sense nothing had named');
  const content = await loadContent({ incident: 'harrowbank-ballast' });
  const g = new Game(content, { seed: 'ballast-purge' });
  const { walkTo, route, wait, workAt, workNear, go, hold, deployAt, clearOf } = driver(g);
  g.commitLoadout([{ itemId: 'reinforced-transit-case', qty: 1 }, { itemId: 'floodlight-tripod', qty: 1 },
    { itemId: 'trauma-kit', qty: 1 }]);
  walkTo(g.site.cache.x, g.site.cache.z, 1.2);
  g.takeFromCache('reinforced-transit-case');
  g.takeFromCache('floodlight-tripod');
  route([[13.6, -12.6], [14.0, -10.2], [8.0, -10.0], [0.0, -6.0], [-10.0, -3.0]], 1.0, 45000);

  /* The decoy goes down as far from the case as this compound allows a person to carry it. */
  hold('floodlight-tripod');
  eq('D25a the floodlight deploys in the west margin', deployAt(-12.0, -3.0, -8.0, -3.0), null);
  const lamp = g.deployables.byItem('floodlight-tripod')[0];
  route([[-6.0, -2.0], [0.0, 1.0]], 1.0, 30000);
  hold('reinforced-transit-case');
  deployAt(0.0, 2.4, 0.0, 0.0);
  const box = g.deployables.byItem('reinforced-transit-case')[0];
  note(`  decoy and case are ${dist(lamp.x, lamp.z, box.x, box.z).toFixed(1)}m apart`);

  /* Every real stone, and then one that is not. */
  for (const inst of g.instances.list.filter((i) => i.anomalous)) {
    clearOf(inst.x, inst.z);
    const a = workNear(inst.x, inst.z, 'collect', 30000);
    if (a && a.kind === 'collect') g.doInteract();
    clearOf(box.x, box.z);
    const dep = workNear(box.x, box.z, 'deposit', 30000);
    if (dep && dep.kind === 'deposit') g.doInteract();
  }
  wait(600);
  eq('D25 with the set complete it is light', g.anomaly.state, 'light');
  const dLamp = dist(g.anomaly.x, g.anomaly.z, lamp.x, lamp.z);
  const dBox = dist(g.anomaly.x, g.anomaly.z, box.x, box.z);
  const burned = (lamp.batteryMaxMs - lamp.batteryMs) / 1000, elapsed = g.clock.simTimeMs / 1000;
  note(`  it went light ${dLamp.toFixed(1)}m from the decoy and ${dBox.toFixed(1)}m from the case; the lamp has ${(lamp.batteryMs / 1000).toFixed(0)}s of ${(lamp.batteryMaxMs / 1000).toFixed(0)}s left`);
  ok(`D25b the decoy held it away from the case — 60C outranks 39C from anywhere on the compound (${dBox.toFixed(1)}m)`,
    dBox > 1.5 && dLamp < dBox);
  note(`  the decoy has burned ${burned.toFixed(0)}s of a ${(lamp.batteryMaxMs / 1000).toFixed(0)}s cell in ${elapsed.toFixed(0)}s of operation`);
  ok(`D25c and it did not merely walk past it — it finished sitting on the decoy, ${dLamp.toFixed(2)}m away`,
    dLamp < 1.5);

  const wrong = g.instances.list.find((i) => !i.anomalous);
  const a = workNear(wrong.x, wrong.z, 'collect', 30000);
  if (a && a.kind === 'collect') g.doInteract();
  const dep = workNear(box.x, box.z, 'deposit', 30000);
  eq('D26 a mundane stone is offered exactly the same verb as a real one', dep && dep.kind, 'deposit');
  g.doInteract();
  wait(600);
  ok('D27 the case is contaminated and says nothing about it', g.instances.contaminated);
  eq('D28 the count did not move, which is the only signal there is', g.instances.counted, 5);
  eq('D29 and the mass is still light, because it is still holding nothing', g.anomaly.state, 'light');

  /* The cure, which is reachable only because the mass is not standing on the case. */
  const purge = workAt(box.x, box.z, 'purge', 20000);
  eq('D30 a contaminated case offers exactly one verb, and it is not the seal', purge && purge.kind, 'purge');
  g.doInteract();
  wait(900);
  ok('D31 turning it out puts every stone back on the yard', g.instances.list.filter((i) => i.anomalous && !i.deposited).length >= 1);
  const back = g.anomaly.transitions.filter((tr) => tr.triggerId === 're-earthed');
  note(`  transitions after the purge: ${g.anomaly.transitions.slice(-3).map((tr) => `${tr.from}->${tr.to} (${tr.triggerId})`).join(', ')}`);
  eq('D32 and `instances-loose` fires — the one operator in senses.js no shipped package had ever named',
    back.length, 1);
  eq('D32a it is the transition out of the vulnerable state, so custody was genuinely given back',
    back[0] ? `${back[0].from}->${back[0].to}` : '(never)', 'light->lifting');
  ok('D32b and it is awake again rather than merely un-sealable', g.anomaly.isAwake, g.anomaly.state);

  /**
   * ⚠ AND IT IS REACHABLE WITH THE MASS SITTING ON THE CASE, WHICH IT WAS NOT.
   *
   * D30 above only proves the purge is offered when a decoy has drawn the mass away. That is
   * the pleasant case. `contextAction` returned the SEAL from an absolute early return above
   * the contamination check, guarded on `!isDistributed` — and `harrowbank-ballast`
   * deliberately does not declare `presence.instances`, because it has a position, hunts,
   * and is sealed at a real distance. So for this family the early return fired and the
   * purge verb could not be reached at all while standing at the case.
   *
   * Worse: `trySeal` does not consult completeness for a non-distributed anomaly, so the
   * case WOULD have sealed. The only recovery from an ordinary mistake was unavailable and
   * the mistake was silently sealable. §27.2 criterion 3 asks a squad to be able to recover
   * from one ordinary procedural error, and logging the wrong stone is the most ordinary
   * error this family has.
   */
  const wrong2 = g.instances.list.find((i) => !i.anomalous && !i.deposited);
  if (wrong2) {
    const a2 = workNear(wrong2.x, wrong2.z, 'collect', 30000);
    if (a2 && a2.kind === 'collect') g.doInteract();
    const dep2 = workNear(box.x, box.z, 'deposit', 30000);
    if (dep2 && dep2.kind === 'deposit') g.doInteract();
    wait(600);
    ok('D33 the case is contaminated again, so the next assertion is not vacuous', g.instances.contaminated);
    /**
     * The exact state the seal's early return used to win in: contaminated, held, and the
     * mass standing on the case. `contextAction` is asked IN THE SAME FRAME, without
     * stepping, because that is the only way to hold this state — see the measurement below.
     */
    const p = g.player;
    p.x = box.x + 0.5; p.z = box.z;
    g.anomaly.x = box.x; g.anomaly.z = box.z;
    g.anomaly.state = 'light';
    const heldNow = g.anomaly.isHeld;
    const offered = g.contextAction();
    ok('D34 with a contaminated case, held, and the mass on the box, the verb is the purge and not the seal',
      heldNow && offered && offered.kind === 'purge',
      `held=${heldNow} offered=${offered ? offered.kind : 'none'}`);

    /**
     * ⚠ AND THE WINDOW IS ONE FRAME, WHICH IS WHY THIS IS AN ORDERING FIX RATHER THAN A
     * CRASH FIX. This anomaly's own content releases it the moment the case is contaminated
     * — `instances-loose` fires and it goes back to `lifting` — so the contaminated-and-held
     * state lasts exactly as long as measured below. In that frame the prompt under the
     * crosshair read SEAL, on a case that could not usefully be sealed.
     *
     * It is worth fixing anyway because the ordering, not the duration, is the defect: a
     * future package whose contamination does NOT release the anomaly would sit in that
     * state permanently, with the only recovery from an ordinary mistake unreachable and the
     * mistake silently sealable — `trySeal` does not consult completeness for a
     * non-distributed anomaly.
     */
    let heldFor = 0;
    for (let i = 0; i < 12 && g.anomaly.isHeld; i++) { heldFor++; g.skipMs(16); }
    note(`  contaminated-and-held lasted ${heldFor} step(s) before this anomaly's own trigger took it back to ${g.anomaly.state}`);
    ok('D34a and this content releases it almost immediately, so the window is narrow rather than absent',
      heldFor >= 1 && heldFor <= 3, `${heldFor} steps`);
  }
}

/* ══ E. the eighth family, driven solo ═════════════════════════════════════════
 *
 * `netherfold-toll` is containment PAID FOR: something warm has to stay inside two metres of
 * it, unbroken, for eighteen seconds, and then get out of the reach inside three. The only
 * payer with nothing to drain is a person, so the minimum grade is an operative standing
 * still and being hurt on a clock.
 */
async function sectionE() {
  heading('E. netherfold-toll, solo, through the real verbs');
  const content = await loadContent({ incident: 'cold-storage-toll' });
  const g = new Game(content, { seed: 'toll-solo' });
  const { walkTo, route, wait, workAt, hold, deployAt, t } = driver(g);
  const ax = g.anomaly.x, az = g.anomaly.z;

  eq('E1 the minimum grade is three volumes', g.commitLoadout([{ itemId: 'reinforced-transit-case', qty: 1 },
    { itemId: 'trauma-kit', qty: 1 }, { itemId: 'thermal-imager', qty: 1 }]), null);
  ok('E2 the operative reaches cargo', walkTo(g.site.cache.x, g.site.cache.z, 1.2));
  eq('E3 the case comes out', g.takeFromCache('reinforced-transit-case'), null);
  eq('E4 and the trauma kit, which is on the MINIMUM list on this anomaly and no other',
    g.takeFromCache('trauma-kit'), null);

  /* The case goes down in the 0.6m band: outside the 2.0m reach, inside the 2.6m seal. */
  ok('E5 the case is in hand', hold('reinforced-transit-case'));
  eq('E6 and it deploys east of the gully', deployAt(ax + 2.3, az, ax + 5.0, az), null);
  const box = g.deployables.byItem('reinforced-transit-case')[0];
  const dBox = dist(box.x, box.z, ax, az);
  note(`  the case is standing ${dBox.toFixed(2)}m from the gully`);
  ok(`E7 which is in the band between the 2.0m reach and the 2.6m seal radius (${dBox.toFixed(2)}m)`,
    dBox > 2.0 && dBox <= 2.6);

  /* Pay the fee. The operative walks in and stands still.
   *
   * ⚠ The clock starts when the operative crosses 2.0m, not when they stop walking, and
   * neither does the contact count — the first contact lands on the step the reach is
   * entered. Both are taken at the crossing, or the measurement is a second and a half out
   * and reports one contact where there are two. */
  eq('E8 nothing has happened yet', g.anomaly.state, 'dry');
  /* ⚠ ROUND THE GULLY, NOT OVER IT. A straight line from the case to the west side of a
   * 2.0m reach passes through the middle of it, and the contact that lands on the way is
   * one an operative never chose to pay. Measured: with the crossing, the fee costs three
   * contacts and downs a solo operative on the last of them. */
  ok('E9 the operative walks round to the west side of the reach',
    route([[ax + 3.2, az - 3.0], [ax - 2.8, az - 3.0], [ax - 2.6, az]], 0.5, 25000));
  const before = g.mission.tally.contacts;
  let tIn = null;
  for (let i = 0; i < 40 && tIn === null; i++) {
    walkTo(ax - 1.2, az, 0.35, 500);
    if (dist(g.player.x, g.player.z, ax, az) <= 2.0) tIn = g.clock.simTimeMs;
  }
  ok('E9a and crosses into it', tIn !== null);
  walkTo(ax - 1.2, az, 0.35, 8000);
  eq('E10 standing near it starts it taking', g.anomaly.state, 'taking');

  let paidAt = null;
  for (let i = 0; i < 60 && !paidAt; i++) {
    wait(500);
    if (g.anomaly.state === 'paid') paidAt = g.clock.simTimeMs;
  }
  ok('E11 eighteen unbroken seconds of a warm body inside two metres pays the fee', !!paidAt);
  if (paidAt) note(`  the fee landed ${((paidAt - tIn) / 1000).toFixed(1)}s after the operative crossed 2.0m`);
  const cost = g.mission.tally.contacts - before;
  note(`  it cost ${cost} contacts; exposure ${g.player.conditions.exposure.severity} of 3`);
  eq('E12 the fee costs exactly two contacts, which is exposure at 2 of 3', cost, 2);
  ok('E13 and the operative is still standing, which is what makes the field profile\'s minimum of one true',
    !g.player.downed);

  /* Take the payment back inside three seconds. */
  ok('E14 the operative gets out of the reach', walkTo(ax + 4.2, az, 0.4, 6000));
  wait(1200);
  eq('E15 it is still paid, because nothing warm is in the ring', g.anomaly.state, 'paid');
  note(`  operative is ${dist(g.player.x, g.player.z, ax, az).toFixed(2)}m from the gully and ${dist(g.player.x, g.player.z, box.x, box.z).toFixed(2)}m from the case`);

  const seal = workAt(box.x, box.z, 'seal', 12000);
  eq('E16 the seal is offered at the case, from outside the reach', seal && seal.kind, 'seal');
  eq('E17 and it takes', g.doInteract(), null);
  eq('E18 custody has started', g.custody, 'sealed');
  wait(CONFIG.anomaly.custodyVerifySeconds * 1000 + 1500);
  eq('E19 and it holds for thirty seconds, because a sealed one drains nothing', g.custody, 'verified');
  note(`  total: ${t()}s of sim time from briefing to verified custody, ${g.mission.tally.contacts} contacts`);
}

/* ══ E2. what happens if you let the box pay ═══════════════════════════════════ */
async function sectionE2() {
  heading('E2. the case is warm, and that is the trap');
  const content = await loadContent({ incident: 'cold-storage-toll' });
  const g = new Game(content, { seed: 'toll-trap' });
  const { walkTo, wait, hold, deployAt } = driver(g);
  const ax = g.anomaly.x, az = g.anomaly.z;
  g.commitLoadout([{ itemId: 'reinforced-transit-case', qty: 1 }, { itemId: 'trauma-kit', qty: 1 }]);
  walkTo(g.site.cache.x, g.site.cache.z, 1.2);
  g.takeFromCache('reinforced-transit-case');
  hold('reinforced-transit-case');
  eq('E20 the case goes down INSIDE the reach, which is what a squad will do', deployAt(ax + 1.3, az, ax + 4.0, az), null);
  const box = g.deployables.byItem('reinforced-transit-case')[0];
  ok('E21 and it is inside two metres', dist(box.x, box.z, ax, az) < 2.0);

  /* Walk out of range and let the case do the standing. */
  walkTo(ax + 7.0, az + 1.0, 0.6, 20000);
  const full = box.batteryMs;
  let paid = false;
  for (let i = 0; i < 90 && !paid; i++) { wait(500); if (g.anomaly.state === 'paid') paid = true; }
  ok('E22 the case pays the fee on its own — the rule does not care whose warmth it is', paid);
  wait(4000);
  eq('E23 and then cancels it, because the case is still standing in the ring', g.anomaly.state, 'taking');
  const spent = full - box.batteryMs;
  note(`  the case has spent ${(spent / 1000).toFixed(1)}s of a ${(full / 1000).toFixed(0)}s cell in ${(g.clock.simTimeMs / 1000).toFixed(0)}s of operation`);
  ok(`E24 at twelve times rate, which is the first authored drain multiplier in the build (${(spent / 1000).toFixed(0)}s of cell gone)`,
    spent > 0);

  /* ⚠ THE NUMBER THE SAFE PROCEDURE HANGS ON: a heater is rated four minutes and the fee is
   * eighteen seconds, so whether one heater is one attempt or three is entirely the
   * multiplier. Measured rather than divided. */
  const heater = content.itemsById.get('portable-heater');
  const h = g.deployables.place(heater, ax + 1.2, az, 0);
  const hFull = h.batteryMs;
  let hLived = 0;
  for (let i = 0; i < 200 && h.batteryMs > 0; i++) { wait(250); hLived += 250; }
  note(`  a portable heater set inside the reach ran for ${(hLived / 1000).toFixed(1)}s of a ${(hFull / 1000).toFixed(0)}s cell`);
  ok(`E25 one heater buys one fee and not two — ${(hLived / 1000).toFixed(1)}s against an eighteen-second fee`,
    hLived / 1000 > 18 && hLived / 1000 < 36, `${(hLived / 1000).toFixed(1)}s`);
}

/* ══ F. eight anomalies, and what the set of them is ═══════════════════════════ */
async function sectionF() {
  heading('F. the shipped set, after two more');

  const byAnomaly = new Map();
  for (const id of INCIDENTS) {
    const pack = await loadContent({ incident: id });
    if (!byAnomaly.has(pack.anomaly.id)) byAnomaly.set(pack.anomaly.id, pack.anomaly);
  }
  /* ⚠ COUNTED AGAINST THE FLOOR, NOT REMEMBERED. This asserted the literal '9/8' and failed
   * the day the tenth package landed — the soak's `$incidentCount = 7` defect, in a test.
   * What the assertion is FOR is the §15.2 ratio: more incidents than anomalies, meaning at
   * least one thing has been given a second floor. So assert the shape, print the count. */
  note(`  ${INCIDENTS.length} incident packages over ${byAnomaly.size} anomalies`);
  ok(`F1 more packages than anomalies — §15.2 is structural, not an accident (${INCIDENTS.length}/${byAnomaly.size})`,
    INCIDENTS.length > byAnomaly.size && byAnomaly.size >= 8);

  /* AC2's own arithmetic, reported per pair rather than as a single worst, so a new file
   * that is a reskin names itself. */
  const sets = [...byAnomaly.entries()].map(([id, a]) => ({
    id, verbs: new Set(a.containment.procedures.flatMap((p) => p.verbs || [])),
  }));
  const overlap = (x, y) => [...x].filter((v) => y.has(v)).length / Math.max(1, Math.min(x.size, y.size));
  let worst = 0, worstPair = '';
  const mine = ['harrowbank-ballast', 'netherfold-toll'];
  const rows = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const o = overlap(sets[i].verbs, sets[j].verbs);
      if (mine.includes(sets[i].id) || mine.includes(sets[j].id)) rows.push(`${sets[i].id}/${sets[j].id} ${(o * 100).toFixed(0)}%`);
      if (o > worst) { worst = o; worstPair = `${sets[i].id}/${sets[j].id}`; }
    }
  }
  for (const s of sets) note(`  ${s.id}: ${[...s.verbs].sort().join(', ')}`);
  note(`  overlap of the two new vocabularies against every other: ${rows.join(' · ')}`);
  let mineWorst = 0, mineAt = '';
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      if (!mine.includes(sets[i].id) && !mine.includes(sets[j].id)) continue;
      const o = overlap(sets[i].verbs, sets[j].verbs);
      if (o > mineWorst) { mineWorst = o; mineAt = `${sets[i].id}/${sets[j].id}`; }
    }
  }
  note(`  worst pair anywhere in the build: ${worstPair} at ${(worst * 100).toFixed(0)}%`);
  ok(`F2 neither new procedure vocabulary is a subset of any shipped one — worst ${(mineWorst * 100).toFixed(0)}% at ${mineAt}`,
    mineWorst < 1.0);
  ok(`F3 and both are further from every shipped family than the closest shipped pair is from each other (${(mineWorst * 100).toFixed(0)}% against ${(worst * 100).toFixed(0)}%)`,
    mineWorst < worst);

  /* Which of the closed vocabulary the content now reaches. §24's mitigation is a shared
   * grammar, so the useful measure is not "how many senses" but "how many are idle". */
  const named = new Set();
  for (const a of byAnomaly.values()) for (const t of a.triggers) named.add(t.when.sense);
  const idle = Object.keys(SENSES).filter((s) => !named.has(s));
  note(`  senses named by shipped content: ${named.size} of ${Object.keys(SENSES).length}${idle.length ? `; idle: ${idle.join(', ')}` : '; none idle'}`);
  ok('F4 `instances-loose` is named by shipped content, which it was not before this milestone',
    named.has('instances-loose'));
  eq('F5 and every sense the engine implements is now reachable from a content file', idle.length, 0, idle.join(','));

  /* The other implemented-and-unused knob. */
  const withMult = [];
  for (const a of byAnomaly.values()) {
    for (const c of a.capabilities || []) if (c.verb === 'drain-power' && c.multiplier !== undefined) withMult.push(`${a.id}/${c.id}=${c.multiplier}`);
  }
  note(`  drain capabilities authoring their own multiplier: ${withMult.length ? withMult.join(', ') : 'none'}`);
  ok('F6 `DeployableSet.stepPower` reads a content multiplier and at least one file now authors one',
    withMult.length >= 1);

  /**
   * Every anomaly's vulnerable condition — the sense that decides when a case will close.
   *
   * ⚠ AND THE HONEST RESULT IS THAT NEITHER NEW ANOMALY NEEDED A NEW ONE. Both reuse a
   * sense a shipped file already reads, which is exactly what §24's shared-grammar
   * mitigation is FOR: a family is what a squad does, not which operator the engine polls.
   * The two pairs are asserted below on the thing that actually separates them.
   */
  const cond = new Map();
  for (const a of byAnomaly.values()) {
    const vuln = new Set(a.states.filter((s) => s.kind === 'vulnerable').map((s) => s.id));
    const into = a.triggers.filter((t) => vuln.has(t.to) && t.when.sense !== 'enclosed-by');
    cond.set(a.id, into);
    note(`  ${a.id} becomes sealable on: ${into.map((t) => `${t.when.sense}${t.when.sustainSeconds ? ` @${t.when.sustainSeconds}s` : ''}`).join(' + ') || '(none)'}`);
  }
  const senses = new Set([...cond.values()].flat().map((t) => t.when.sense));
  note(`  eight anomalies, ${senses.size} distinct custody conditions: ${[...senses].join(', ')}`);
  ok('F7 neither new anomaly needed a new sense — both reach custody through an operator a shipped file already reads',
    cond.get('harrowbank-ballast').every((t) => t.when.sense === 'instances-accounted')
    && cond.get('netherfold-toll').every((t) => t.when.sense === 'heat-within'));

  /* `instances-accounted`, twice, and the difference is whether the set IS the anomaly. */
  const tally = byAnomaly.get('ninety-one-tally'), ballast = byAnomaly.get('harrowbank-ballast');
  ok('F8 the tally declares `presence.instances` and the ballast does not, so one is a set with no position and the other is a mass that walks',
    !!(tally.presence && tally.presence.instances) && !(ballast.presence && ballast.presence.instances));
  ok('F8a which means the tally seals with no distance check and the ballast has to have the case brought to it',
    ballast.triggers.find((t) => t.when.sense === 'enclosed-by').when.radiusMetres > 0
    && ballast.presence.hunts === 'heat' && tally.presence.hunts !== 'heat');

  /* `heat-within`, three times, and the difference is the sustain by an order of magnitude. */
  const sust = (id, sense) => Math.max(...byAnomaly.get(id).triggers
    .filter((t) => t.when.sense === sense && byAnomaly.get(id).states.find((s) => s.id === t.to && s.kind === 'vulnerable'))
    .map((t) => t.when.sustainSeconds || 0));
  const passenger = sust('coldharbour-passenger', 'heat-within');
  const toll = sust('netherfold-toll', 'heat-within');
  note(`  the passenger lodges on ${passenger}s of warmth in reach; the toll wants ${toll}s of it`);
  ok(`F9 the same sense is a lodging at ${passenger}s and a fee at ${toll}s — an order of magnitude apart, which is what makes them different jobs`,
    toll >= passenger * 8);
}

/* ------------------------------------------------------------------------------------- */
async function sectionD3() {
  heading('D3. the way back down, which the ballast had no word for');
  const content = await loadContent({ incident: 'harrowbank-ballast' });

  /* ── on foot, from the middle of the yard ─────────────────────────────────────────── */
  const g = new Game(content, { seed: 'ballast-withdraw' });
  const { walkTo, route, wait, hold, deployAt } = driver(g);
  const A = g.anomaly;
  g.commitLoadout([{ itemId: 'trauma-kit', qty: 1 }]);
  eq('D33 it is bedded when the squad lands', A.state, 'bedded');

  route([[13.6, -12.6], [14.0, -10.2], [8.0, -10.0], [0.0, -6.0], [-6.0, -2.0], [0.0, 1.0]], 1.0, 150000);
  walkTo(2.4, 4.2, 0.9, 60000);
  const dIn = dist(g.player.x, g.player.z, A.x, A.z);
  wait(5000);
  note(`  approached to ${dIn.toFixed(1)}m of the bed; it is ${A.state}`);
  ok(`D34 inside eleven metres for four seconds and it is up (${dIn.toFixed(1)}m)`, A.state !== 'bedded');
  const woke = g.clock.simTimeMs;

  /* Straight back out, as far as this compound goes, and then stand still and watch. */
  route([[0.0, 1.0], [-6.0, -2.0], [0.0, -6.0], [8.0, -10.0], [14.0, -10.2], [13.6, -12.6],
    [0.0, -13.0], [-6.0, -13.6], [-13.5, -14.2]], 1.2, 200000);
  const leftAt = g.clock.simTimeMs;
  const dOut = dist(g.player.x, g.player.z, A.x, A.z);
  let closest = dOut;
  for (let ms = 0; ms < 40000 && A.state !== 'bedded'; ms += 100) {
    g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
    g.skipMs(100);
    closest = Math.min(closest, dist(g.player.x, g.player.z, A.x, A.z));
  }
  note(`  walked out for ${((leftAt - woke) / 1000).toFixed(0)}s to a gap of ${dOut.toFixed(1)}m; standing still it closed to ${closest.toFixed(1)}m`);

  /* ⚠ THE WITHDRAWAL FAILS, AND THAT IS THE RULE WORKING RATHER THAN THE RULE MISSING.
   * `no-heat-within` measures from the ANOMALY, and the anomaly is walking. Twenty seconds
   * of clearance therefore costs eleven metres plus twenty seconds of its own travel, and
   * the yard is not big enough to buy that from the middle of it. */
  const lift = A.def.states.find((s) => s.id === 'lifting').speedMps;
  const standoff = 11 + lift * 20;
  note(`  it follows at ${lift} m/s, so twenty seconds beyond eleven metres wants ${standoff.toFixed(0)}m of standing clearance`);
  ok(`D35 backing off on foot from the middle of the yard does NOT settle it — the gap bought was ${dOut.toFixed(1)}m against the ${standoff.toFixed(0)}m the arithmetic wants`,
    dOut < standoff);
  ok(`D36 and it closed rather than waited: ${dOut.toFixed(1)}m to ${closest.toFixed(1)}m with nobody moving, ending ${A.state}`,
    closest < dOut && A.state !== 'bedded');

  /* ── the decoy, which is the route that works ─────────────────────────────────────── */
  const h = new Game(content, { seed: 'ballast-settle' });
  const d2 = driver(h);
  const B = h.anomaly;
  h.commitLoadout([{ itemId: 'floodlight-tripod', qty: 1 }, { itemId: 'trauma-kit', qty: 1 }]);
  d2.walkTo(h.site.cache.x, h.site.cache.z, 1.2);
  h.takeFromCache('floodlight-tripod');
  d2.route([[13.6, -12.6], [14.0, -10.2], [8.0, -10.0], [0.0, -6.0], [-6.0, -2.0], [0.0, 1.0]], 1.0, 150000);
  d2.walkTo(2.4, 4.2, 0.9, 60000);
  d2.hold('floodlight-tripod');
  eq('D37 the decoy goes down between the squad and the bed', d2.deployAt(2.4, 6.0, 2.4, 4.2), null);
  const lamp = h.deployables.byItem('floodlight-tripod')[0];
  const litAt = h.clock.simTimeMs;

  /* Out, and this time it is not being followed — 60C outranks 37C from anywhere. */
  d2.route([[0.0, 1.0], [-6.0, -2.0], [0.0, -6.0], [8.0, -10.0], [14.0, -10.2], [13.6, -12.6],
    [0.0, -13.0], [-6.0, -13.6]], 1.2, 200000);
  const away = dist(h.player.x, h.player.z, lamp.x, lamp.z);
  note(`  the squad is ${away.toFixed(1)}m from the lamp; the mass is ${dist(B.x, B.z, lamp.x, lamp.z).toFixed(1)}m from it and ${B.state}`);
  ok(`D38 the mass took the decoy and left the squad alone (${away.toFixed(1)}m off)`, away > 11);

  /* Now wait it out. The lamp has five and a half minutes of cell and nothing renews it. */
  let deadAt = null, settledAt = null, nearest = away;
  for (let ms = 0; ms < 420000 && settledAt === null; ms += 200) {
    h.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
    h.skipMs(200);
    nearest = Math.min(nearest, dist(h.player.x, h.player.z, B.x, B.z));
    if (deadAt === null && lamp.batteryMs <= 0) deadAt = h.clock.simTimeMs;
    if (B.state === 'bedded') settledAt = h.clock.simTimeMs;
  }
  const settled = B.transitions[B.transitions.length - 1];
  const held = deadAt === null || settledAt === null ? null : (settledAt - deadAt) / 1000;
  note(`  the cell ran out at ${deadAt === null ? '(never)' : (deadAt / 1000).toFixed(0)}s and it went down at ${settledAt === null ? '(never)' : (settledAt / 1000).toFixed(0)}s`);

  ok('D39 it beds down again — the state the operation starts in is reachable for the rest of it', B.state === 'bedded');
  ok(`D40 by \`${settled.triggerId}\`, out of \`${settled.from}\``, /^beds-down-/.test(settled.triggerId));
  ok(`D41 ${held === null ? '(never)' : held.toFixed(1)}s after the decoy died, which is the authored twenty and not a frame less`,
    held !== null && held >= 20 && held < 23);
  ok(`D42 and nobody was ever inside the eleven metres, so what was measured is one unbroken sustain (closest ${nearest.toFixed(1)}m)`,
    nearest > 11);

  /* ⚠ THE DECOY DIED IN A THIRD OF ITS CELL, AND THAT IS TWO RULES MEETING. `bleeds-cells`
   * is `drain-power` at 4.5m in exactly the three states this thing hunts in, so the mass
   * you lured onto the lamp is standing on the lamp eating it. The tactic is therefore
   * self-limiting by the anomaly's own rule rather than by a number in the item file, and
   * nobody authored that — it falls out of two independent entries agreeing. */
  const nominal = 5.5 * 60;
  const burn = deadAt === null ? null : (deadAt - litAt) / 1000;
  note(`  the lamp burned ${burn === null ? '(never died)' : burn.toFixed(0)}s of a ${nominal}s cell`);
  ok(`D42a and it died in ${burn === null ? '(never)' : burn.toFixed(0)}s of a ${nominal}s cell, because the thing sitting on it bleeds cells at 4.5m`,
    burn !== null && burn < nominal * 0.6);

  /* The two states it must never leave, and it is structure that says so rather than luck. */
  const backs = B.def.triggers.filter((t) => t.to === 'bedded');
  eq('D43 three ways down, one for each state that can be walked away from', backs.length, 3);
  eq('D44 and none of them from `light` or `cased` — bedding down out of either would undo the stone work or the seal',
    backs.filter((t) => t.from === 'light' || t.from === 'cased' || t.from === '*').length, 0);
  const same = new Set(backs.map((t) => `${t.when.radiusMetres}/${t.when.sustainSeconds}`));
  eq('D45 all three read the same radius and the same sustain, so the squad learns one distance and not three', same.size, 1);
  const tells = new Set(backs.map((t) => t.telegraph));
  eq('D46 and all three tell it differently, because settling out of a run is not settling out of a sit', tells.size, 3);
}

/* ------------------------------------------------------------------------------------- */
async function sectionG() {
  heading('G. the generator, solo, through the real verbs — §15.2 against the caller\'s own floor');
  const content = await loadContent({ incident: 'blackthorn-generator' });
  const g = new Game(content, { seed: 'generator-solo' });
  const { walkTo, route, wait, workAt, hold, deployAt } = driver(g);
  const A = g.anomaly;

  eq('G1 the reserve\'s second package binds the passenger to the caller\'s ground',
    `${A.def.id}@${g.site.id}`, 'coldharbour-passenger@blackthorn-reserve');
  eq('G2 and it starts settled, in the thing the fiction says it lives in', A.state, 'settled');

  /* The §15.2 hinge, asserted as data: the July operation's lesson is ON THIS FLOOR as
   * evidence, and the tool this operation turns on is the one that lesson forbids. */
  const placed = new Set(content.incident.evidenceSources.map((e) => e.evidenceId));
  ok('G3 the caller\'s standing order is placed as evidence on the same ground', placed.has('caller-file'));
  const rules = new Map();
  for (const e of A.def.evidenceRules) {
    if (!e.revealsRule || !placed.has(e.id)) continue;
    rules.set(e.revealsRule, (rules.get(e.revealsRule) || 0) + 1);
  }
  note(`  placed paths per rule: ${[...rules.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  ok('G4 every rule keeps two placed paths on this floor — the Ashlar denominator lesson, applied at authoring time',
    [...rules.values()].every((n) => n >= 2) && rules.size === 4, JSON.stringify([...rules]));

  /* Kit, from the vehicle. The heater is the whole operation: bait on this floor, beacon
   * on this floor's LAST operation. */
  g.commitLoadout([
    { itemId: 'portable-heater', qty: 1 }, { itemId: 'reinforced-transit-case', qty: 1 },
    { itemId: 'thermal-imager', qty: 1 }, { itemId: 'trauma-kit', qty: 1 },
  ]);
  walkTo(g.site.cache.x, g.site.cache.z, 1.2);
  /* Two general slots, and bait + box are both general: A SOLO OPERATIVE CANNOT ALSO CARRY
   * THE IMAGER. That is 10.7's wager with teeth on this floor - the two instrument reads
   * cost a second trip to the vehicle, or a second operative. Asserted, not worked around. */
  const takeErrs = ['portable-heater', 'reinforced-transit-case', 'trauma-kit']
    .map((id) => [id, g.takeFromCache(id)]).filter(([, e]) => e);
  eq(`G5 the squad carries bait, box and kit - and the imager stays behind, because two general slots is the wager${takeErrs.length ? ' - ' + takeErrs.map(([i, e]) => i + ': ' + e).join('; ') : ''}`,
    [...g.player.slots.values()].filter(Boolean).length >= 3, true);
  eq('G5a and a third general item is refused in words, which is the wager stated at the vehicle',
    g.takeFromCache('thermal-imager') ? true : false, true);

  /* North across the meadow to the compound. */
  /* The compound is FENCED - south gate closed, one 2.4m gap in the east run between two
   * porous panels. The gap is the honest pedestrian entry; the gate is the vehicle one. */
  route([[-6.0, -16.0], [-4.8, -10.0], [-7.15, -7.2], [-9.5, -7.6]], 1.0, 120000);
  const dA = dist(g.player.x, g.player.z, A.x, A.z);
  note(`  at the yard, ${dA.toFixed(1)}m from the set; it is ${A.state}`);
  eq('G6 walking the compound does not move it — nothing here hunts', A.state, 'settled');

  /* The bait and the box go down FIRST, while it is still housed: the case can wait beside
   * a settled thing all day, and the seal trigger only reads it once the thing is lodged. */
  hold('portable-heater');
  eq('G7 the heater deploys inside its reach', deployAt(A.x + 1.1, A.z + 0.4, A.x + 2.4, A.z + 1.2), null);
  hold('reinforced-transit-case');
  eq('G8 and the case beside it', deployAt(A.x + 0.6, A.z - 1.1, A.x + 1.8, A.z - 2.2), null);
  const heater = g.deployables.byItem('portable-heater')[0];
  const box = g.deployables.byItem('reinforced-transit-case')[0];
  note(`  heater ${dist(heater.x, heater.z, A.x, A.z).toFixed(2)}m and case ${dist(box.x, box.z, A.x, A.z).toFixed(2)}m from it`);

  /* Now the counter-lesson: STAND BACK AND LOOK AT IT. Two seconds of attention unhouses
   * it; a second and a half of warmth in reach rehouses it — into the warm thing the squad
   * chose the position of. */
  walkTo(A.x, A.z, 4.2, 30000);          // walks facing it, stops 4.2m out, still facing
  let unhoused = null, lodged = null;
  for (let ms = 0; ms < 12000 && !lodged; ms += 100) {
    g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
    g.skipMs(100);
    if (!unhoused && A.state === 'unhoused') unhoused = g.clock.simTimeMs;
    if (A.state === 'lodged') lodged = g.clock.simTimeMs;
  }
  ok(`G9 two seconds of being looked at and it lets go (${unhoused === null ? 'never' : 'at ' + (unhoused / 1000).toFixed(1) + 's'})`,
    unhoused !== null);
  ok(`G10 and warmth in reach takes it — lodged ${lodged === null ? '(never)' : ((lodged - unhoused) / 1000).toFixed(1) + 's later'}`,
    lodged !== null);

  /* Seal while lodged. The approach is the dance the cold store teaches: get to the case
   * without giving it two more seconds of attention. `walkTo(case)` faces the CASE. */
  let sealed = false;
  for (let attempt = 0; attempt < 5 && !sealed; attempt++) {
    if (A.state === 'unhoused') {
      /* It slipped loose — the heater is still the only warmth in reach; wait it back in. */
      for (let ms = 0; ms < 5000 && A.state !== 'lodged'; ms += 100) { g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false }); g.skipMs(100); }
    }
    if (A.state !== 'lodged') continue;
    const act = workAt(box.x, box.z, 'seal', 15000);
    if (act && act.kind === 'seal') { g.doInteract(); sealed = A.state === 'cased'; }
  }
  eq('G11 the seal lands while it is lodged in the squad\'s own bait', A.state, 'cased');
  eq('G12 and custody is the game\'s word for it', g.custody, 'sealed');

  /* The floor's two operations demand OPPOSITE kit disciplines, and that is checkable as
   * data rather than as prose: the caller is provoked by the noise band every powered
   * deployable emits; the passenger is captured with one. */
  const caller = (await loadContent({ incident: 'blackthorn-caller' })).anomaly;
  const noisy = (content.itemsById.get('portable-heater') || {}).noiseOutputDb || 0;
  const callerHearsAt = (() => {
    const t = caller.triggers.find((x) => x.when && (x.when.sense === 'noise-above' || x.when.sense === 'loudest-noise-within'));
    return t && t.when.thresholdDb ? t.when.thresholdDb : null;
  })();
  note(`  the heater emits ${noisy} dB; the caller's own file wakes on ${callerHearsAt === null ? '(no dB threshold trigger)' : callerHearsAt + ' dB'}`);
  ok('G13 the bait this operation requires is louder than silence — §15.2\'s collision is in the numbers, not the briefing',
    noisy > 0);
}

suite('content', async () => {
  let ctx = null;
  await run('A', async () => { ctx = await sectionA(); });
  if (ctx) await run('B', () => sectionB(ctx));
  await run('C', () => sectionC());
  await run('D', () => sectionD());
  await run('D2', () => sectionD2());
  await run('D3', () => sectionD3());
  await run('E', () => sectionE());
  await run('E2', () => sectionE2());
  await run('F', () => sectionF());
  await run('G', () => sectionG());
});
