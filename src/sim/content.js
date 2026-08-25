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

import { SENSES, EFFECT_VERBS, FIELD_KINDS, HUNT_KINDS, BLOCK_KINDS, isSense, isPerformed } from './senses.js';
import { EARNED_OBSERVATIONS, isEarnedObservation } from './evidence.js';
import { varyContent } from './variation.js';

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
  /* The distributed set (GDD §26.2). Refusals here are the ones that would otherwise be
   * discovered by a squad twenty minutes into an operation that cannot be finished. */
  const sites = doc.instanceSites || [];
  if (sites.length) {
    const ids = new Set();
    let anomalous = 0;
    for (const s of sites) {
      if (!Array.isArray(s.at) || s.at.length !== 2) p.push(`instance site ${s.id || '?'} has no [x,z]`);
      if (s.anomalous === undefined) p.push(`instance site ${s.id || '?'} does not say whether it is one of them`);
      if (s.id && ids.has(s.id)) p.push(`two instance sites share the id ${s.id}`);
      if (s.id) ids.add(s.id);
      if (s.anomalous) anomalous++;
    }
    if (!anomalous) p.push('instanceSites contains no anomalous object, so the operation cannot be completed');
    /* ⚠ MORE CANDIDATES THAN OBJECTS, or there is nothing to verify. A set where every
     * candidate is real is a fetch quest: you take everything you see and you cannot be
     * wrong, which deletes the half of the procedure family §26.2 actually names. */
    if (anomalous >= sites.length) {
      p.push(`every one of the ${sites.length} instance sites is anomalous — nothing to verify, so this is a fetch quest and not a containment`);
    }
  }
  return p;
}

function validateAnomaly(doc, itemIds) {
  const p = [];
  for (const k of ['id', 'states', 'triggers', 'capabilities', 'constraints', 'evidenceRules', 'claims', 'containment']) {
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

  /* ⚠ AND NO DEAD ENDS. Reachability was checked from the first state onward and nothing
   * checked the other direction, so a state could be entered and never left — which is not
   * a theoretical gap: the tally anomaly shipped with `adulterated` as a trap, and one
   * mundane object logged into the case made the operation permanently uncompletable even
   * after the case was emptied and refilled correctly. GDD §14.4 forbids generating
   * unwinnable states and this is the authoring-time half of that.
   *
   * A state of the `contained` kind is allowed to be terminal — that is what contained
   * means. Everything else must have a way out. */
  for (const s of doc.states || []) {
    if (s.kind === 'contained') continue;
    const out = (doc.triggers || []).some((t) => (t.from === s.id || t.from === '*') && t.to !== s.id);
    if (!out) p.push(`state ${s.id} is a dead end — it can be entered and never left, and it is not a contained state`);
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
  if (doc.presence && doc.presence.hunts !== undefined && !HUNT_KINDS.includes(doc.presence.hunts)) {
    p.push(`presence.hunts "${doc.presence.hunts}" is not one of ${HUNT_KINDS.join(', ')} — sensing a thing and walking toward it are different questions, and both are closed vocabularies`);
  }
  for (const b of (doc.presence && doc.presence.blockedBy) || []) {
    if (!BLOCK_KINDS.includes(b)) {
      p.push(`presence.blockedBy names "${b}", which is not one of ${BLOCK_KINDS.join(', ')}`);
    }
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
  const evidenceIds = new Set((doc.evidenceRules || []).map((e) => e.id));
  for (const e of doc.evidenceRules || []) {
    if (!e.rawObservation) p.push(`evidence ${e.id}: no rawObservation. GDD §7.2 — the ledger records the raw fact, never the interpretation`);
    for (const req of e.requiredEquipment || []) {
      if (!itemIds.has(req)) p.push(`evidence ${e.id}: requires item ${req}, which does not exist`);
    }
    /* ⚠ AN EARNED OBSERVATION NAMES AN OPERATOR THE ENGINE OWNS, and the same closed-
     * vocabulary rule applies to it as to a sense: content supplies the quantities and
     * cannot invent the way they are measured. An unknown observation name would be an
     * evidence rule that silently never fires — a rule with no way to learn it, dressed
     * as one that has two. */
    const w = e.earnedBy;
    if (!w) continue;
    if (!isEarnedObservation(w.observation)) {
      p.push(`evidence ${e.id}: earnedBy.observation "${w.observation}" is not in the closed vocabulary (${Object.keys(EARNED_OBSERVATIONS).join(', ')})`);
      continue;
    }
    for (const [key, kind] of Object.entries(EARNED_OBSERVATIONS[w.observation].params)) {
      const optional = key.endsWith('?');
      const name = optional ? key.slice(0, -1) : key;
      const v = w[name];
      if (v === undefined) { if (!optional) p.push(`evidence ${e.id}: earnedBy is missing ${name}`); continue; }
      if (kind === 'item' && !itemIds.has(v)) p.push(`evidence ${e.id}: earnedBy names item ${v}, which does not exist`);
      if (kind === 'metres' && !(typeof v === 'number' && v > 0)) p.push(`evidence ${e.id}: earnedBy.${name} must be a positive number of metres`);
      if (kind === 'seconds' && !(typeof v === 'number' && v >= 0)) p.push(`evidence ${e.id}: earnedBy.${name} must be a number of seconds, zero or more`);
      if (kind === 'count' && !(Number.isInteger(v) && v >= 1)) p.push(`evidence ${e.id}: earnedBy.${name} must be a whole number of one or more`);
    }
  }

  /* ⚠ THE BOARD BELONGS TO THE ANOMALY, AND THIS IS WHERE THAT IS ENFORCED.
   *
   * The hypothesis board was a frozen array of seven claims in src/sim/evidence.js written
   * for the graybox draught, and every incident got it. Twelve of the fourteen evidence
   * ids in `pinfold-lodger` were on no claim at all; the two that were on one were there
   * because they happened to be spelled the same as the draught's, which attached four of
   * the DRAUGHT's claims to observations about something else. A board that says nothing
   * is a gap. A board that says something false about the floor under your feet is worse,
   * and neither the loader nor the tablet had any way to notice.
   *
   * So a claim naming an evidence id this anomaly does not define is a refusal, exactly as
   * a trigger naming a state that does not exist already is. It is the same defect: a
   * reference to something that is not there. */
  const claimIds = new Set();
  if (doc.claims !== undefined && !Array.isArray(doc.claims)) p.push('claims must be an array');
  else if (Array.isArray(doc.claims) && doc.claims.length === 0) {
    p.push('claims[] is empty — there is nothing for the squad to be right or wrong about');
  }
  for (const c of doc.claims || []) {
    const at = `claim ${c.id || '(no id)'}`;
    if (!c.id) p.push(`${at}: no id`);
    if (claimIds.has(c.id)) p.push(`${at}: duplicate id`);
    claimIds.add(c.id);
    if (!c.text) p.push(`${at}: no text — the board shows this to the player`);
    if (!c.dimension) p.push(`${at}: no dimension`);
    if (typeof c.truth !== 'boolean') p.push(`${at}: truth must be true or false. It is what the site did, and the debrief marks the squad against it`);
    if (!Array.isArray(c.supportedBy) || c.supportedBy.length === 0) {
      p.push(`${at}: supportedBy is empty — a claim no observation bears on can never move off "no support"`);
    }
    for (const id of c.supportedBy || []) {
      if (!evidenceIds.has(id)) p.push(`${at}: names evidence ${id}, which this anomaly does not define`);
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
  incident = 'cold-storage-draught',
  itemsPath = '../../content/equipment/items.json',
  /**
   * GDD §14.4's scenario seed. `null` means the authored default — every incident that
   * predates variation loads exactly as it did, and an incident with no `variation` block
   * varies in nothing whatever seed it is given.
   *
   * ⚠ A VARIATION THAT MAKES THE OPERATION UNWINNABLE IS A REFUSAL, not a warning. §14.4
   * says randomisation must not generate unwinnable states, and the only way to keep that
   * promise is to check each one before anybody deploys into it — a seed that removes the
   * last discovery path for a rule arrives one time in fifty and is impossible to
   * reconstruct from a bug report.
   */
  seed = null,
} = {}) {
  const incidentPath = `../../content/incidents/${incident}.json`;
  const pack = await fetchJson(incidentPath);

  for (const k of ['id', 'anomaly', 'map']) {
    if (!pack[k]) throw new ContentError(incidentPath, [`missing ${k}`]);
  }

  const mapPath = `../../content/maps/${pack.map}.json`;
  const anomalyPath = `../../content/anomalies/${pack.anomaly}.json`;
  const [items, map, anomaly] = await Promise.all([
    fetchJson(itemsPath), fetchJson(mapPath), fetchJson(anomalyPath),
  ]);

  let problems = validateItems(items);
  if (problems.length) throw new ContentError(itemsPath, problems);

  const itemIds = new Set(items.items.map((i) => i.id));

  problems = validateAnomaly(anomaly, itemIds);
  if (problems.length) throw new ContentError(anomalyPath, problems);

  const evidenceIds = new Set(anomaly.evidenceRules.map((e) => e.id));

  /**
   * ⚠ THE INCIDENT IS AUTHORITATIVE OVER THE MAP, AND THIS IS WHERE THAT IS DECIDED.
   *
   * A map may ship a default `anomalySpawn` and `evidenceSources` — the incident it was
   * authored around — because a map with nothing in it is hard to test. But the moment two
   * incidents share a floor those belong to the incident, not the geometry: they are what
   * happened here, and a different thing happened here last week. GDD §15.1 lists "compatible
   * map zones and anchors" and "evidence set and witness variants" as parts of the Incident
   * Package for exactly this reason.
   *
   * So the map's copies are merged UNDER the incident's, and every surviving evidence source
   * is then validated against THIS anomaly's rules. A source left over from another incident
   * naming an evidence id this anomaly does not define is a refusal, not a silent skip.
   */
  const bound = {
    ...map,
    anomalySpawn: pack.anomalySpawn || map.anomalySpawn,
    evidenceSources: pack.evidenceSources || map.evidenceSources || [],
    /* Where the objects were left is what happened here, so it belongs to the incident and
     * never to the geometry. A map carries none. */
    instanceSites: pack.instanceSites || [],
  };

  problems = validateMap(bound, itemIds, evidenceIds);
  if (problems.length) throw new ContentError(`${incidentPath} + ${mapPath}`, problems);

  const itemsById = new Map(items.items.map((i) => [i.id, Object.freeze(i)]));
  const loaded = { items, map: bound, anomaly, incident: pack, itemsById };
  if (seed === null) return loaded;

  /* §14.4. Applied AFTER validation, and then re-validated: a variation may only move
   * things the map already validated, so what has to be checked again is what the
   * variation itself could have broken. */
  const { pack: varied, problems: vp } = varyContent(loaded, seed);
  if (vp.length) throw new ContentError(`${incidentPath} @ seed "${seed}"`, vp);
  const remap = validateMap(varied.map, itemIds, evidenceIds);
  if (remap.length) throw new ContentError(`${incidentPath} @ seed "${seed}" + ${mapPath}`, remap);
  return varied;
}

/** Every incident the build ships, for the mission board. Content, not code. */
export const INCIDENTS = Object.freeze(['cold-storage-draught', 'cold-storage-figure', 'ashlar-gallery-draught', 'cold-storage-tally', 'blackthorn-caller', 'cold-storage-passenger', 'ashlar-flat-lodger', 'harrowbank-ballast', 'cold-storage-toll', 'blackthorn-generator']);

export { ContentError };
