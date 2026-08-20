/* The content loader — GDD §20.6, §20.8 step 2.
 *
 * It REFUSES. A content file that is missing a field, names a state no trigger can reach,
 * or points an item id at nothing does not load with a warning and a default; it throws,
 * and the page shows why. The reason is GDD §14.4: "randomization must not generate
 * unwinnable states" — the same applies to authoring. A mission that boots with a broken
 * anomaly definition is a mission whose rules cannot be learned, which is the one failure
 * this design cannot survive.
 *
 * Paths resolve against this module's own URL, not against the document, so the build
 * works unchanged at the site root during development and under /ContainmentDetailWeb/
 * on Pages.
 */

import { SENSES, EFFECT_VERBS, FIELD_KINDS, isSense, isPerformed } from './senses.js';

const url = (p) => new URL(p, import.meta.url).href;

class ContentError extends Error {
  constructor(file, problems) {
    super(`${file}: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n  - ${problems.join('\n  - ')}`);
    this.name = 'ContentError';
    this.file = file;
    this.problems = problems;
  }
}

async function fetchJson(path) {
  const res = await fetch(url(path), { cache: 'no-store' });
  if (!res.ok) throw new ContentError(path, [`HTTP ${res.status} ${res.statusText}`]);
  try {
    return await res.json();
  } catch (e) {
    throw new ContentError(path, [`not valid JSON (${e.message})`]);
  }
}

/* ── validators ──────────────────────────────────────────────────────────────
 * Each returns a list of problems. They check STRUCTURE and REFERENTIAL INTEGRITY —
 * "this trigger names a state that does not exist" — not taste. A designer is allowed
 * to author a bad-feeling number; they are not allowed to author a dangling reference. */

function validateItems(doc) {
  const p = [];
  if (!Array.isArray(doc.items) || doc.items.length === 0) p.push('items[] missing or empty');
  if (typeof doc.cargoVolumeBudget !== 'number') p.push('cargoVolumeBudget must be a number');
  const seen = new Set();
  for (const it of doc.items || []) {
    const at = `item ${it.id || '(no id)'}`;
    if (!it.id) p.push(`${at}: no id`);
    if (seen.has(it.id)) p.push(`${at}: duplicate id`);
    seen.add(it.id);
    if (!it.displayName) p.push(`${at}: no displayName`);
    if (!['compact', 'general', 'long'].includes(it.bulk)) p.push(`${at}: bulk must be compact|general|long, got ${it.bulk}`);
    if (typeof it.cargoVolume !== 'number' || it.cargoVolume <= 0) p.push(`${at}: cargoVolume must be a positive number`);
    if (it.heatOutputCelsius !== undefined && typeof it.heatFalloffMetres !== 'number') {
      p.push(`${at}: a heat emitter must also author heatFalloffMetres — the 40C contour radius is content, not a constant`);
    }
  }
  return p;
}

function validateMap(doc, itemIds, evidenceIds) {
  const p = [];
  for (const k of ['id', 'bounds', 'spawn', 'extraction', 'anomalySpawn', 'cache', 'statics']) {
    if (doc[k] === undefined) p.push(`missing ${k}`);
  }
  if (doc.bounds && !(doc.bounds.minX < doc.bounds.maxX && doc.bounds.minZ < doc.bounds.maxZ)) {
    p.push('bounds are inside out');
  }
  for (const r of doc.statics || []) {
    if (!Array.isArray(r) || r.length !== 4) { p.push(`static ${JSON.stringify(r)} is not [minX,minZ,maxX,maxZ]`); continue; }
    if (r[0] >= r[2] || r[1] >= r[3]) p.push(`static ${JSON.stringify(r)} is inside out`);
  }
  for (const i of doc.porousStatics || []) {
    if (!Number.isInteger(i) || i < 0 || i >= (doc.statics || []).length) {
      p.push(`porousStatics names index ${i}, which is not a static in this map`);
    }
  }
  const circuitIds = new Set((doc.circuits || []).map((c) => c.id));
  for (const d of doc.doors || []) {
    if (d.circuitId && !circuitIds.has(d.circuitId)) p.push(`door ${d.id} names circuit ${d.circuitId}, which does not exist`);
  }
  for (const l of doc.luminaires || []) {
    if (l.circuitId && !circuitIds.has(l.circuitId)) p.push(`luminaire at ${JSON.stringify(l.at)} names circuit ${l.circuitId}, which does not exist`);
  }
  for (const e of doc.evidenceSources || []) {
    if (!evidenceIds.has(e.evidenceId)) p.push(`evidence source names ${e.evidenceId}, which the anomaly file does not define`);
    for (const req of e.requiresEquipment || []) {
      if (!itemIds.has(req)) p.push(`evidence source ${e.evidenceId} requires item ${req}, which does not exist`);
    }
  }
  return p;
}

function validateAnomaly(doc, itemIds) {
  const p = [];
  for (const k of ['id', 'states', 'triggers', 'capabilities', 'constraints', 'evidenceRules', 'containment']) {
    if (doc[k] === undefined) p.push(`missing ${k}`);
  }
  const stateIds = new Set((doc.states || []).map((s) => s.id));

  for (const t of doc.triggers || []) {
    if (t.from !== '*' && !stateIds.has(t.from)) p.push(`trigger ${t.id}: from-state ${t.from} does not exist`);
    if (!stateIds.has(t.to)) p.push(`trigger ${t.id}: to-state ${t.to} does not exist`);
    if (!t.telegraph) p.push(`trigger ${t.id}: no telegraph. GDD §5.4 — the director may choose timing, never invent an untelegraphed power`);
    if (t.when && t.when.itemId && !itemIds.has(t.when.itemId)) p.push(`trigger ${t.id}: names item ${t.when.itemId}, which does not exist`);
  }

  /* Every non-initial state must be reachable, or a rule has been authored that the
   * player can never observe — which fails Pillar 1's design test outright. */
  const reachable = new Set([doc.states[0] && doc.states[0].id]);
  for (let i = 0; i < (doc.states || []).length + 1; i++) {
    for (const t of doc.triggers || []) {
      if (t.from === '*' || reachable.has(t.from)) reachable.add(t.to);
    }
  }
  for (const s of doc.states || []) {
    if (!reachable.has(s.id)) p.push(`state ${s.id} is unreachable — no trigger arrives at it`);
  }

  /* ⚠ THE VOCABULARIES ARE CLOSED, AND THIS IS WHERE THAT IS ENFORCED. A trigger naming a
   * sense the engine does not implement, or a capability naming a verb it cannot dispatch,
   * is not a warning and not an inert no-op — it is a rule the player can never learn, and
   * the whole design rests on rules being learnable (Pillar 1). Refuse it at load. */
  for (const t of doc.triggers || []) {
    const s = t.when && t.when.sense;
    if (!s) p.push(`trigger ${t.id}: no sense named`);
    else if (!isSense(s)) {
      p.push(`trigger ${t.id}: sense "${s}" is not in the closed vocabulary (${Object.keys(SENSES).join(', ')})`);
    }
  }
  const performed = (doc.triggers || []).filter((t) => t.when && isPerformed(t.when.sense));
  if (performed.length > 1) {
    p.push(`${performed.length} performed triggers (${performed.map((t) => t.id).join(', ')}) — an anomaly has exactly one custody move`);
  }

  const kinds = new Set(['latent', 'active', 'hunting', 'vulnerable', 'contained']);
  for (const s of doc.states || []) {
    if (!kinds.has(s.kind)) p.push(`state ${s.id}: kind "${s.kind}" is not one of ${[...kinds].join(', ')}`);
  }
  if (!(doc.states || []).some((s) => s.kind === 'contained')) p.push('no state of kind `contained` — there is nothing to win');
  if (!(doc.states || []).some((s) => s.kind === 'vulnerable')) {
    p.push('no state of kind `vulnerable` — nothing can ever be sealed');
  }

  if (doc.presence && doc.presence.field && !FIELD_KINDS.includes(doc.presence.field.kind)) {
    p.push(`presence.field.kind "${doc.presence.field.kind}" is not one of ${FIELD_KINDS.join(', ')}`);
  }

  for (const c of doc.capabilities || []) {
    if (!EFFECT_VERBS.includes(c.verb)) {
      p.push(`capability ${c.id}: verb "${c.verb}" is not in the closed vocabulary (${EFFECT_VERBS.join(', ')})`);
    }
    for (const st of c.availableInStates || []) {
      if (!stateIds.has(st)) p.push(`capability ${c.id}: available in ${st}, which does not exist`);
    }
  }
  for (const c of doc.constraints || []) {
    for (const req of c.requiredEquipment || []) {
      if (!itemIds.has(req)) p.push(`constraint ${c.id}: requires item ${req}, which does not exist`);
    }
  }
  for (const e of doc.evidenceRules || []) {
    if (!e.rawObservation) p.push(`evidence ${e.id}: no rawObservation. GDD §7.2 — the ledger records the raw fact, never the interpretation`);
    for (const req of e.requiredEquipment || []) {
      if (!itemIds.has(req)) p.push(`evidence ${e.id}: requires item ${req}, which does not exist`);
    }
  }
  for (const proc of (doc.containment && doc.containment.procedures) || []) {
    for (const req of proc.requiredEquipment || []) {
      if (!itemIds.has(req)) p.push(`procedure ${proc.id}: requires item ${req}, which does not exist`);
    }
    if ((proc.verbs || []).length < 3) p.push(`procedure ${proc.id}: fewer than three verbs. GDD §8.3 asks for three to six`);
  }
  return p;
}

/**
 * Load and validate every content file the mission needs.
 * @returns {Promise<{items:object, map:object, anomaly:object, itemsById:Map}>}
 */
export async function loadContent({
  itemsPath = '../../content/equipment/items.json',
  mapPath = '../../content/maps/cold-storage-l2.json',
  anomalyPath = '../../content/anomalies/graybox-draught.json',
} = {}) {
  const [items, map, anomaly] = await Promise.all([
    fetchJson(itemsPath), fetchJson(mapPath), fetchJson(anomalyPath),
  ]);

  let problems = validateItems(items);
  if (problems.length) throw new ContentError(itemsPath, problems);

  const itemIds = new Set(items.items.map((i) => i.id));

  problems = validateAnomaly(anomaly, itemIds);
  if (problems.length) throw new ContentError(anomalyPath, problems);

  const evidenceIds = new Set(anomaly.evidenceRules.map((e) => e.id));
  problems = validateMap(map, itemIds, evidenceIds);
  if (problems.length) throw new ContentError(mapPath, problems);

  const itemsById = new Map(items.items.map((i) => [i.id, Object.freeze(i)]));
  return { items, map, anomaly, itemsById };
}

export { ContentError };
