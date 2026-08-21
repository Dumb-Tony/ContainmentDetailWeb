/* The campaign: clearance, standing, knowledge, sidegrades, injury and the profile that
 * survives a mission — GDD §12, and the state the Foundation site (§13) is a view onto.
 *
 * ⚠ PROGRESSION GRANTS OPTIONS, CONTEXT AND EFFICIENCY. NEVER DAMAGE, NEVER IMMUNITY (§12.1).
 * That constraint is enforced here rather than remembered: `MODIFIABLE_FIELDS` is a
 * whitelist of the equipment fields an upgrade may touch, and there is no field on it for
 * health, armour, resistance, damage or contact tolerance. An upgrade that wanted to make
 * an operative harder to hurt has nowhere to write the number. `validateSidegrades()`
 * asserts the rest: every upgrade names at least one gain AND at least one loss, so a new
 * tier cannot make the old tool irrelevant (§10.1, §12.4).
 *
 * THREE TRACKS, ONE PROFILE (§12.1). Site clearance is milestone-based and DERIVED — there
 * is deliberately no `spendClearance()` in this file, because §12.2 says clearance is not
 * a spendable currency and the cheapest way to keep that true is to give it no spender.
 * Department standing gates PRICE, never access (§12.3: "standing creates choices, not
 * permanent faction exclusion") — a department you have annoyed sells to you at a worse
 * rate and never closes its counter. Research knowledge unlocks context and prototypes.
 *
 * NO DEBT SPIRAL (§12.6), as an arithmetic invariant rather than an intention: a completed
 * operation's requisition delta is clamped to at least `OPERATING_STIPEND`, so no run of
 * disasters can leave the site unable to fund the next one. Losses are real — forgone
 * earnings, replacement costs eating the earned part, lost standing — but the floor holds.
 * `earningsFor()` is pure and returns its own lines, so the suite can assert the invariant
 * directly instead of inferring it from a profile that has already been mutated.
 *
 * ⚠ NOTHING HERE READS WALL-CLOCK TIME. Injury recovery is counted in OPERATIONS, never in
 * seconds — §12.5 forbids real-time waiting, and tools\m0-tests.js section K forbids the
 * clock. The two rules happen to want the same thing.
 *
 * The economy constants are exported rather than buried so a balance pass can find them
 * (§21.3 wants balance changes to be evidence-led, which needs the numbers to be findable).
 */

import { ContentError } from './content.js';

export const PROGRESSION_VERSION = 1;
export const SAVE_KEY = 'cd.profile.v1';

/* ── §12.2 resources ──────────────────────────────────────────────────────────
 * Four, and no more. §12.2: "Avoid multiple premium-like currencies and randomized loot."
 * Two are spendable, one is a relationship, one is a milestone. Nothing in this file
 * awards a random item, and nothing rolls for a drop. */
export const RESOURCES = Object.freeze([
  { id: 'requisition', name: 'Requisition', spendable: true,
    what: 'Routine equipment, consumables, repairs and facility improvements.' },
  { id: 'research', name: 'Research data', spendable: true,
    what: 'Verified evidence and samples, spent on analytical unlocks and prototypes.' },
  { id: 'standing', name: 'Department standing', spendable: false,
    what: 'Earned by behaviour a department values. Changes what things cost you, never whether you may have them.' },
  { id: 'clearance', name: 'Clearance', spendable: false,
    what: 'Milestone access to rooms, operations and institutional authority. It cannot be bought.' },
]);

/* ── §12.3 the departments ────────────────────────────────────────────────────
 * `rewards` and `values` are the GDD table. `dimensions` and `behaviours` are how this
 * file turns a debrief into standing, and the base screen prints them so a player can
 * read WHY Logistics is unhappy instead of guessing at a hidden meter. */
export const DEPARTMENTS = Object.freeze([
  { id: 'research', name: 'Research',
    rewards: 'Better analysis, experimental sensors',
    values: 'High-integrity evidence and samples',
    watches: 'Evidence quality, research completion, rules read correctly' },
  { id: 'engineering', name: 'Engineering',
    rewards: 'Modular tools, lighter equipment',
    values: 'Device recovery and field telemetry',
    watches: 'Infrastructure damage, equipment stewardship, circuits restored' },
  { id: 'medical', name: 'Medical',
    rewards: 'Treatment and exposure countermeasures',
    values: 'Personnel and civilian survival',
    watches: 'Personnel survival, casualties recovered, field treatment' },
  { id: 'security', name: 'Security',
    rewards: 'Defensive equipment and transport armour',
    values: 'Controlled threat response',
    watches: 'Containment integrity, contacts taken, squad conduct' },
  { id: 'ethics', name: 'Ethics Committee',
    rewards: 'Intelligence, waivers, public-risk tools',
    values: 'Proportional force and civilian care',
    watches: 'Civilian outcome, secrecy, aborting rather than pressing on' },
  { id: 'logistics', name: 'Logistics',
    rewards: 'Cargo, maintenance, deployment options',
    values: 'Equipment stewardship and efficient operations',
    watches: 'Equipment stewardship, time to stabilisation' },
]);

export const DEPARTMENT_IDS = Object.freeze(DEPARTMENTS.map((d) => d.id));

/** Standing bounds. The floor exists so a bad run is recoverable; §12.3 forbids exclusion,
 *  so the floor is a PRICE, not a door. At -20 every counter still sells. */
export const STANDING_FLOOR = -20;
export const STANDING_CEILING = 100;

/* Cost multipliers, not access gates. A department that likes you does you favours; one
 * that does not charges the full institutional rate and takes its time. */
export const STANDING_TIERS = Object.freeze([
  { min: -20, name: 'Obstructive', priceMultiplier: 1.40, note: 'Every request goes through review.' },
  { min: -4, name: 'Cool', priceMultiplier: 1.15, note: 'Requests are honoured, slowly.' },
  { min: 10, name: 'Working', priceMultiplier: 1.00, note: 'Standard institutional rate.' },
  { min: 30, name: 'Trusted', priceMultiplier: 0.85, note: 'Your requests skip the queue.' },
  { min: 60, name: 'Sponsor', priceMultiplier: 0.70, note: 'They are funding you on purpose.' },
]);

export function standingTier(value) {
  let t = STANDING_TIERS[0];
  for (const tier of STANDING_TIERS) if (value >= tier.min) t = tier;
  return t;
}

/* ── §12.1 site clearance ─────────────────────────────────────────────────────
 * Milestone-based. Derived from facts the campaign already records, so it cannot drift
 * away from what the player has actually done and cannot be bought by accident. */
export const CLEARANCE_TIERS = Object.freeze([
  { level: 0, name: 'Provisional', requires: {},
    grants: 'Operations room and the logistics counter. Nothing else is signed off yet.' },
  /* ⚠ The containment corridor opens at Level 1, on the FIRST closed operation, and not at
   * Level 2 where the institutional fiction would prefer it. A tester who establishes
   * custody has to be able to go and look at what they caught in the same session — GDD
   * §26.2 lists the containment wing result display as a slice system, and a display
   * nobody reaches is not one. Level 2 gates the corridor's UPGRADES instead. */
  { level: 1, name: 'Level 1 — Site', requires: { operations: 1 },
    grants: 'Archive terminal, research station, and the containment observation corridor.' },
  { level: 2, name: 'Level 2 — Regional', requires: { operations: 3, custodies: 1 },
    grants: 'Specialised storage and perimeter monitoring may be requisitioned.' },
  { level: 3, name: 'Level 3 — Sector', requires: { operations: 6, custodies: 3, research: 400 },
    grants: 'Prototype requests, and contracts the region does not advertise.' },
]);

export function clearanceFor(profile) {
  const facts = {
    operations: profile.operationsCompleted || 0,
    custodies: profile.custodiesVerified || 0,
    research: profile.researchTotalEarned || 0,
  };
  let level = 0;
  for (const t of CLEARANCE_TIERS) {
    const r = t.requires || {};
    const met = (r.operations === undefined || facts.operations >= r.operations)
      && (r.custodies === undefined || facts.custodies >= r.custodies)
      && (r.research === undefined || facts.research >= r.research);
    if (met) level = Math.max(level, t.level);
  }
  return level;
}

export function clearanceTier(level) {
  return CLEARANCE_TIERS.find((t) => t.level === level) || CLEARANCE_TIERS[0];
}

/* ── §12.4 sidegrades ─────────────────────────────────────────────────────────
 * The eight axes are the GDD's, verbatim. Every upgrade must move at least one axis in
 * each direction; `validateSidegrades()` fails the build otherwise, which is the only
 * reliable way to keep "none is universally superior" true a year from now.
 *
 * ⚠ MODIFIABLE_FIELDS IS THE §12.1 GUARANTEE IN CODE. `live` fields are ones the running
 * simulation already reads out of content/equipment/items.json. `pending` fields are ones
 * a future loadout screen will read; nothing consumes them yet, and saying so here is
 * cheaper than discovering it in a playtest. Anything not on this list is DROPPED by
 * `applyModifiers` — including, deliberately, any field that would express damage, armour
 * or immunity. There is no way to author one. */
export const SIDEGRADE_AXES = Object.freeze([
  'range', 'precision', 'portability', 'battery endurance',
  'durability', 'remote operation', 'environmental resistance', 'data logging',
]);

export const MODIFIABLE_FIELDS = Object.freeze({
  cargoVolume: 'live',
  batteryMinutes: 'live',
  bulk: 'live',
  heatOutputCelsius: 'live',
  heatFalloffMetres: 'live',
  feedRadiusMetres: 'live',
  barrierWidthMetres: 'live',
  imagerFovDeg: 'pending',
  imagerRangeM: 'pending',
  sensorLaneM: 'pending',
  remoteOperable: 'pending',
  logsToArchive: 'pending',
  ruggedised: 'pending',
  environmentalSealC: 'pending',
});

/* ⚠ `pending` fields are always authored as `set`, never `add`. The base item does not
 * carry them, so an `add` would start from zero and produce a variant with an imager
 * range of minus eight metres. Absolute values for fields that do not exist yet. */
export const UPGRADES = Object.freeze([
  {
    id: 'imager-headmount', family: 'thermal-imager', name: 'Head-mounted imager',
    department: 'engineering', costRequisition: 220, costResearch: 0,
    gains: ['portability', 'battery endurance'], losses: ['range', 'precision'],
    blurb: 'Both hands back. You see less of the room and you see it worse, and you can carry the case while you do it.',
    modifiers: { set: { bulk: 'compact', imagerFovDeg: 38, imagerRangeM: 12 }, add: { batteryMinutes: 5 } },
  },
  {
    id: 'imager-mast', family: 'thermal-imager', name: 'Long-range thermal scanner',
    department: 'research', costRequisition: 260, costResearch: 60,
    gains: ['range', 'precision'], losses: ['portability', 'battery endurance'],
    blurb: 'Reads an aisle end to end from the stair head. It is a long item and it eats its cells.',
    modifiers: { set: { bulk: 'long', imagerFovDeg: 30, imagerRangeM: 34 }, add: { cargoVolume: 1, batteryMinutes: -4 } },
  },
  {
    id: 'imager-relay', family: 'thermal-imager', name: 'Remote thermal relay',
    department: 'engineering', costRequisition: 300, costResearch: 90,
    gains: ['remote operation', 'data logging'], losses: ['portability', 'battery endurance'],
    blurb: 'Watches a lane nobody is standing in and files every frame. Heavier, and it dies sooner.',
    modifiers: { set: { remoteOperable: true, logsToArchive: true, imagerRangeM: 18 }, add: { cargoVolume: 1, batteryMinutes: -3 } },
    economy: { researchBonusPct: 6 },
  },
  {
    id: 'tripod-lowdraw', family: 'floodlight-tripod', name: 'Low-draw floodlight',
    department: 'logistics', costRequisition: 180, costResearch: 0,
    gains: ['battery endurance', 'durability'], losses: ['range'],
    blurb: 'Runs most of an operation on one charge. Its 40C contour is visibly smaller, and the aisles did not get narrower.',
    modifiers: { set: { ruggedised: true }, add: { batteryMinutes: 4.5, heatOutputCelsius: -9, heatFalloffMetres: -0.35 } },
  },
  {
    id: 'tripod-widefield', family: 'floodlight-tripod', name: 'Wide-field floodlight',
    department: 'engineering', costRequisition: 240, costResearch: 0,
    gains: ['range', 'environmental resistance'], losses: ['portability', 'battery endurance'],
    blurb: 'One unit can span a 4.2m aisle. You will carry fewer of them and change cells sooner.',
    modifiers: { set: { environmentalSealC: -20 }, add: { heatFalloffMetres: 0.6, heatOutputCelsius: 6, cargoVolume: 1, batteryMinutes: -1.8 } },
  },
  {
    id: 'case-logger', family: 'reinforced-transit-case', name: 'Instrumented transit case',
    department: 'research', costRequisition: 210, costResearch: 80,
    gains: ['data logging', 'precision'], losses: ['battery endurance'],
    blurb: 'Logs interior conditions through the hold, which is most of what Research wanted from the operation. The sensor bus is drawn off the same cells as the heater.',
    modifiers: { set: { logsToArchive: true }, add: { batteryMinutes: -2.5 } },
    economy: { researchBonusPct: 10 },
  },
  {
    id: 'barrier-composite', family: 'portable-barrier', name: 'Composite barrier panel',
    department: 'engineering', costRequisition: 200, costResearch: 0,
    gains: ['durability', 'environmental resistance'], losses: ['portability'],
    blurb: 'Wider panel, survives being dragged. It takes the volume of something else you wanted.',
    modifiers: { set: { ruggedised: true }, add: { barrierWidthMetres: 0.5, cargoVolume: 1 } },
  },
  {
    id: 'pack-fastfeed', family: 'power-pack', name: 'Distribution power pack',
    department: 'engineering', costRequisition: 190, costResearch: 0,
    gains: ['range'], losses: ['battery endurance'],
    blurb: 'Feeds a wider ring of emitters for a shorter time. A fence that holds while you seal, and not much longer.',
    modifiers: { add: { feedRadiusMetres: 1.6, batteryMinutes: -2.5 } },
  },
  {
    id: 'sensor-net', family: 'motion-sensor', name: 'Networked lane sensor',
    department: 'security', costRequisition: 170, costResearch: 0,
    gains: ['remote operation', 'range'], losses: ['battery endurance', 'portability'],
    blurb: 'Covers a whole aisle and reports to the command point. Still reports motion, not identity.',
    modifiers: { set: { remoteOperable: true, sensorLaneM: 14 }, add: { batteryMinutes: -5, cargoVolume: 1 } },
  },
  {
    id: 'sample-kit-assay', family: 'sample-kit', name: 'Field assay kit',
    department: 'research', costRequisition: 150, costResearch: 40,
    gains: ['data logging', 'precision'], losses: ['portability'],
    blurb: 'Grades the sample on the floor instead of at the bench, so a bad sample is known while there is still time to take another.',
    modifiers: { set: { logsToArchive: true }, add: { cargoVolume: 1 } },
    economy: { researchBonusPct: 8 },
  },
  {
    id: 'trauma-kit-sealed', family: 'trauma-kit', name: 'Sealed trauma pouch',
    department: 'medical', costRequisition: 140, costResearch: 0,
    gains: ['portability', 'durability'], losses: ['data logging'],
    blurb: 'Survives a contaminated floor and rides on a belt loop. It records nothing, so Medical learns nothing from the exposure it treats.',
    modifiers: { set: { ruggedised: true, logsToArchive: false } },
    economy: { researchBonusPct: -5 },
  },
]);

export const UPGRADES_BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

export function upgradesFor(itemId) { return UPGRADES.filter((u) => u.family === itemId); }

/**
 * Structural check on the sidegrade table. Returns a list of problems; empty means the
 * §12.4 / §10.1 contract holds. The suite should assert this is empty — a design rule
 * nobody tests is a design rule that lasts one content pass.
 */
export function validateSidegrades() {
  const p = [];
  const seen = new Set();
  for (const u of UPGRADES) {
    const at = `upgrade ${u.id || '(no id)'}`;
    if (!u.id) p.push(`${at}: no id`);
    if (seen.has(u.id)) p.push(`${at}: duplicate id`);
    seen.add(u.id);
    if (!u.family) p.push(`${at}: names no equipment family`);
    if (!DEPARTMENT_IDS.includes(u.department)) p.push(`${at}: department ${u.department} is not one of the six`);
    if (!(u.gains || []).length) p.push(`${at}: no gain — every sidegrade must be worth fitting`);
    if (!(u.losses || []).length) p.push(`${at}: no loss. GDD §10.1 — a new tier must not make the old tool irrelevant`);
    for (const a of [...(u.gains || []), ...(u.losses || [])]) {
      if (!SIDEGRADE_AXES.includes(a)) p.push(`${at}: axis "${a}" is not one of the eight in §12.4`);
    }
    for (const g of u.gains || []) {
      if ((u.losses || []).includes(g)) p.push(`${at}: axis "${g}" is listed as both a gain and a loss`);
    }
    const m = u.modifiers || {};
    for (const group of ['add', 'mul', 'set']) {
      for (const k of Object.keys(m[group] || {})) {
        if (!(k in MODIFIABLE_FIELDS)) p.push(`${at}: modifies "${k}", which is not a modifiable field`);
        if (group === 'add' && MODIFIABLE_FIELDS[k] === 'pending') {
          p.push(`${at}: adds to "${k}", a field no base item authors — pending fields must be set, not added`);
        }
      }
    }
    if (typeof u.costRequisition !== 'number' || u.costRequisition <= 0) p.push(`${at}: costRequisition must be positive`);
  }
  return p;
}

/** Sum a list of modifier blocks. Sets are last-wins, adds sum, multipliers compound. */
export function mergeModifiers(list) {
  const out = { add: {}, mul: {}, set: {} };
  for (const m of list || []) {
    if (!m) continue;
    for (const [k, v] of Object.entries(m.set || {})) out.set[k] = v;
    for (const [k, v] of Object.entries(m.add || {})) out.add[k] = (out.add[k] || 0) + Number(v);
    for (const [k, v] of Object.entries(m.mul || {})) out.mul[k] = (out.mul[k] || 1) * Number(v);
  }
  return out;
}

/**
 * Return a COPY of an items.json entry with the fitted variant's modifiers applied.
 * Order is set, then add, then multiply, so a variant can replace a value outright and
 * a second modifier can still scale it.
 *
 * ⚠ It never mutates the argument. content.js freezes every item, and a loadout screen
 * that mutated one would poison every later mission in the session.
 */
export function applyModifiers(item, mods) {
  const m = mergeModifiers(Array.isArray(mods) ? mods : [mods]);
  const out = { ...item };
  const allowed = (k) => Object.prototype.hasOwnProperty.call(MODIFIABLE_FIELDS, k);
  for (const [k, v] of Object.entries(m.set)) if (allowed(k)) out[k] = v;
  for (const [k, v] of Object.entries(m.add)) if (allowed(k)) out[k] = Number(out[k] || 0) + v;
  for (const [k, v] of Object.entries(m.mul)) if (allowed(k)) out[k] = Number(out[k] || 0) * v;
  /* Floors, because the content validator will reject the result otherwise: cargoVolume
   * must stay a positive number and a battery that reads 0 minutes is a dead item. */
  if (typeof out.cargoVolume === 'number') out.cargoVolume = Math.max(1, Math.round(out.cargoVolume));
  if (typeof out.batteryMinutes === 'number') out.batteryMinutes = Math.max(0.5, Math.round(out.batteryMinutes * 10) / 10);
  if (typeof out.heatOutputCelsius === 'number') out.heatOutputCelsius = Math.round(out.heatOutputCelsius * 10) / 10;
  if (typeof out.heatFalloffMetres === 'number') out.heatFalloffMetres = Math.max(0.4, Math.round(out.heatFalloffMetres * 100) / 100);
  return out;
}

/* ── §12.5 injury and recovery ────────────────────────────────────────────────
 * ⚠ TEMPORARY EFFECTS, MEASURED IN OPERATIONS. Two rules, both from §12.5: a player can
 * ALWAYS field a character, and nothing waits on a real-time clock. So an injury never
 * removes an operative from the roster — it rides along as a handling penalty until it
 * expires, and treatment buys the penalty off early with requisition and site capacity.
 *
 * ⚠ None of these effects makes an operative easier to hurt. Reduced carrying tolerance
 * and slower stabilisation are CAPABILITY, not fragility (§12.1). */
export const INJURY_EFFECTS = Object.freeze([
  { id: 'strain', name: 'Reduced carrying tolerance', operations: 2,
    effect: { cargoVolume: -1 },
    note: 'Cracked ribs from a fall on the stair. They can deploy; they cannot take the long items.' },
  { id: 'exposure', name: 'Slower stabilisation', operations: 2,
    effect: { stabiliseFactor: 1.35 },
    note: 'Cold injury. Treating them in the field takes half again as long as it should.' },
  { id: 'fatigue', name: 'Post-critical fatigue', operations: 3,
    effect: { cargoVolume: -1, stabiliseFactor: 1.2 },
    note: 'Came out on a stretcher. Cleared to deploy, and everyone can see they should not be carrying the case.' },
]);

export const INJURY_BY_ID = new Map(INJURY_EFFECTS.map((i) => [i.id, i]));

/* §12.5: "Treatment uses time, site capacity, or medical resources." All three are here.
 * Capacity is beds — one, until the isolation bay is built (content/site.json). */
export const TREATMENTS = Object.freeze([
  { id: 'observation-rest', name: 'Rest and observation', costRequisition: 0, clears: 1, capacity: 0,
    note: 'Costs a slot in the rotation rather than money. One operation of the effect, gone.' },
  { id: 'infirmary-course', name: 'Infirmary course', costRequisition: 70, clears: 3, capacity: 1,
    note: 'Occupies a bed and a budget line. Clears the condition outright.' },
]);

export const TREATMENTS_BY_ID = new Map(TREATMENTS.map((t) => [t.id, t]));

/* ── the economy ──────────────────────────────────────────────────────────────
 * §12.6's floor, and the numbers that hang off it. */
export const OPERATING_STIPEND = 60;
export const STARTING_REQUISITION = 340;
export const REPLACEMENT_PER_ITEM = 26;
/** What it costs to put a squad on the floor at all, win or lose (GDD 12.6). Set above
 *  the operating grant so a deployment that achieves nothing is a net loss. */
export const DEPLOYMENT_COST = 210;
export const RESEARCH_PER_RULE_READ = 12;
export const MIN_RESEARCH_WITH_OBSERVATIONS = 12;
export const TIME_TARGET_MINUTES = 22;

/** A small institutional bonus for the overall word (§6.4). It is a BONUS, never a
 *  multiplier: a multiplier would double-count the dimensions that produced the word. */
export const OVERALL_BONUS = Object.freeze({
  exemplary: { requisition: 80, research: 20 },
  controlled: { requisition: 40, research: 10 },
  costly: { requisition: 15, research: 5 },
  compromised: { requisition: 0, research: 0 },
  failed: { requisition: 0, research: 0 },
});

/**
 * ⚠ THE DIMENSION NAMES ARE NORMALISED, NOT MATCHED. mission.grade() reports "Time to
 * stabilisation" and GDD §6.4 writes "Time to stabilization"; both must key the same row
 * or a spelling pass silently zeroes a dimension's pay. Letters only, and z folded to s.
 */
const dimKey = (name) => String(name || '').toLowerCase().replace(/[^a-z]/g, '').replace(/z/g, 's');
/* ⚠ Letters only, for the same reason. grade() emits "Not applicable" with a space in it,
 * and a table keyed on the trimmed string alone missed that row entirely — which LOOKED
 * correct, because the row pays nothing, and would have gone on looking correct until
 * somebody authored a civilian dimension that paid something. */
const wordKey = (word) => String(word === undefined || word === null ? '' : word).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What each graded dimension is worth. `req` requisition, `res` research data, `st`
 * standing deltas by department.
 *
 * ⚠ AN UNKNOWN WORD PAYS NOTHING RATHER THAN THROWING. grade() is allowed to grow a new
 * word (and does: "Squad conduct" only appears when there was a rescue or somebody was
 * left behind, and "Time to stabilisation" reports a MEASUREMENT rather than a verdict).
 * A table that threw on an unrecognised word would turn a content change into a crash on
 * the debrief screen, which is the worst possible place for one.
 */
export const DIMENSION_YIELD = Object.freeze({
  containmentintegrity: {
    established: { req: 140, res: 45, st: { research: 3, security: 3, logistics: 1 } },
    unverified: { req: 55, res: 25, st: { research: 1 } },
    none: { req: 0, res: 8, st: { security: -2 } },
  },
  personnelsurvival: {
    intact: { req: 40, res: 0, st: { medical: 4, ethics: 2, security: 1 } },
    injured: { req: 15, res: 5, st: { medical: 1 } },
    critical: { req: 0, res: 8, st: { medical: -2, ethics: -1 } },
    /* ⚠ A fatality still yields research. The incident report on how somebody died is the
     * most expensive data the Foundation ever buys, and §12.6 forbids a total loss. */
    lost: { req: 0, res: 10, st: { medical: -5, ethics: -4, security: -2 } },
  },
  squadconduct: {
    sound: { req: 15, res: 0, st: { security: 2, medical: 1 } },
    incomplete: { req: 0, res: 0, st: { medical: -3, ethics: -3 } },
  },
  civilianoutcome: {
    /* ⚠ "Not applicable" pays nothing in either direction. The slice's floor was cleared
     * before deployment, and paying Ethics for civilians who were never there would price
     * an empty building as a rescue. */
    notapplicable: { req: 0, res: 0, st: {} },
    protected: { req: 20, res: 0, st: { ethics: 4, medical: 2 } },
    harmed: { req: 0, res: 0, st: { ethics: -6, medical: -3 } },
  },
  evidencequality: {
    high: { req: 0, res: 60, st: { research: 4 } },
    serviceable: { req: 0, res: 30, st: { research: 2 } },
    thin: { req: 0, res: 10, st: { research: -1 } },
  },
  secrecyandexposure: {
    held: { req: 25, res: 0, st: { ethics: 1, security: 1 } },
    strained: { req: 5, res: 0, st: {} },
    breached: { req: 0, res: 0, st: { ethics: -4, security: -3 } },
  },
  equipmentstewardship: {
    complete: { req: 60, res: 0, st: { logistics: 4, engineering: 2 } },
    partial: { req: 20, res: 0, st: { logistics: 1 } },
    poor: { req: 0, res: 0, st: { logistics: -3, engineering: -1 } },
  },
  infrastructuredamage: {
    none: { req: 30, res: 0, st: { engineering: 3, logistics: 1 } },
    minor: { req: 10, res: 0, st: { engineering: 1 } },
    major: { req: 0, res: 0, st: { engineering: -3, logistics: -2 } },
  },
  researchcompletion: {
    substantial: { req: 0, res: 55, st: { research: 3, engineering: 1 } },
    partial: { req: 0, res: 25, st: { research: 1 } },
    minimal: { req: 0, res: 8, st: {} },
  },
});

/* Behaviours, not outcomes — §12.3 says standing is "earned through behavior aligned with
 * departmental priorities", and an economy that only reads the final grade cannot see the
 * difference between a squad that dragged a casualty out and one that got lucky. Every row
 * is capped so no single behaviour can be farmed. */
const BEHAVIOUR_YIELD = Object.freeze([
  { tally: 'rescues', per: { medical: 2, security: 1 }, cap: 6,
    label: 'Casualties recovered under pressure' },
  { tally: 'treatments', per: { medical: 1 }, cap: 3,
    label: 'Stabilised in the field' },
  { tally: 'circuitsRestored', per: { engineering: 2 }, cap: 4,
    label: 'Site systems restored' },
  { tally: 'deployablesPlaced', per: { engineering: 1 }, cap: 3,
    label: 'Field telemetry returned' },
  { tally: 'contacts', per: { security: -1 }, cap: 4,
    label: 'Contacts taken' },
  { tally: 'custodyLosses', per: { security: -2, research: -1 }, cap: 4,
    label: 'Custody lost and re-established' },
]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function emptyStanding() {
  const s = {};
  for (const id of DEPARTMENT_IDS) s[id] = 0;
  return s;
}

/** Site upgrade effects, and their defaults. Unknown keys are dropped by `validateSite`. */
export const DEFAULT_EFFECTS = Object.freeze({
  cargoVolumeBudget: 0,            // §13.3 additional vehicle bay
  containmentCells: 0,             // §13.3 specialised storage
  historyKept: 12,                 // §13.3 expanded archives
  researchBonusPct: 0,
  standingGainPct: 0,
  replacementCostPct: 0,
  requisitionPerOperation: 0,
  treatmentCapacity: 1,            // §13.3 better medical isolation
  treatmentCostPct: 0,
  maintenanceIntervalOperations: 0, // §13.3 stronger perimeter monitoring
  equipmentBatteryBonusMinutes: 0, // §13.3 backup power
});

export const EFFECT_KEYS = Object.freeze(Object.keys(DEFAULT_EFFECTS));

/**
 * Turn a debrief into earnings. PURE: it reads, it does not write, and it never touches
 * the profile. Everything the base screen prints and everything the suite asserts comes
 * out of here, so there is one implementation of the economy and no second one hiding in
 * the panel.
 *
 * Expected `result` — exactly what src/sim/mission.js `grade()` returns:
 *   {
 *     overall: 'Exemplary'|'Controlled'|'Costly'|'Compromised'|'Failed',
 *     dims: [ { name: string, word: string, why: string }, ... ],   // 9 or 10 of them
 *     claims: { correct, wrong, unmarked, total },
 *     failReason?: string|null                                      // added by endMission
 *   }
 *
 * Expected `mission` — the Mission instance, or any object with the same read-only shape.
 * Optional; without it the tally-driven lines are simply absent:
 *   { tally: { rescues, treatments, circuitsRestored, deployablesPlaced, deployablesLost,
 *              contacts, custodyLosses, peakPressure, timeInBreachMs }, abortCount }
 *
 * `opts`: { effects, itemsLost, observations, minutes } — all optional overrides.
 */
export function earningsFor(result, mission = null, opts = {}) {
  const effects = { ...DEFAULT_EFFECTS, ...(opts.effects || {}) };
  const tally = (mission && mission.tally) || {};
  const claims = (result && result.claims) || { correct: 0, wrong: 0, unmarked: 0, total: 0 };
  const dims = (result && Array.isArray(result.dims)) ? result.dims : [];
  const standing = emptyStanding();
  const lines = [];
  let requisition = 0;
  let research = 0;

  const credit = (label, detail, y) => {
    const req = y.req || 0;
    const res = y.res || 0;
    requisition += req;
    research += res;
    for (const [dept, v] of Object.entries(y.st || {})) {
      if (standing[dept] === undefined) continue;
      standing[dept] += v;
    }
    lines.push({ label, detail, requisition: req, research: res, standing: { ...(y.st || {}) } });
  };

  /* The grant covers a deployment's routine cost. It is deliberately smaller than what a
   * closed operation earns and smaller than what a lost one costs, so it softens a bad
   * run without ever making one worth having. */
  credit('Operating grant', 'Paid on every operation the site closes, whatever it cost.',
    { req: OPERATING_STIPEND + effects.requisitionPerOperation });

  /* Deploying is not free. §12.6 lists lost consumables as one of the things that keeps
   * stakes real when an operation fails, and a squad that walks back in with everything
   * still in the van has spent nothing at all. */
  credit('Deployment cost', 'Consumables, transport and the van, spent whether or not it worked.',
    { req: -DEPLOYMENT_COST });

  for (const d of dims) {
    const key = dimKey(d && d.name);
    /* Time to stabilisation reports a measurement, not a verdict, so it cannot live in
     * the word table. Under the target the operation cost less to run; over it, or never
     * stabilised at all, it simply pays nothing. */
    if (key === 'timetostabilisation') {
      const mins = Number(String((d && d.word) || '').replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(mins) || mins <= 0) continue;
      if (mins <= TIME_TARGET_MINUTES) {
        const under = Math.min(TIME_TARGET_MINUTES, TIME_TARGET_MINUTES - mins);
        credit(d.name, `${mins.toFixed(1)} min against a ${TIME_TARGET_MINUTES} min window.`,
          { req: Math.round(under * 3), st: { logistics: 2 } });
      } else {
        credit(d.name, `${mins.toFixed(1)} min against a ${TIME_TARGET_MINUTES} min window. Overrun.`,
          { st: { logistics: -1 } });
      }
      continue;
    }
    const table = DIMENSION_YIELD[key];
    if (!table) continue;
    const y = table[wordKey(d.word)];
    if (!y) continue;
    credit(d.name, (d && d.why) || d.word, y);
  }

  /* Rules read correctly are the research track's real income (§12.1: research knowledge
   * unlocks insight). ⚠ Rules read WRONGLY cost nothing. §7.4 asks for confidence rather
   * than checklist completion, and an economy that fined a wrong mark would teach players
   * to leave the board blank — which is the one behaviour the board exists to prevent. */
  if (claims.correct > 0) {
    credit('Rules read correctly',
      `${claims.correct} of ${claims.total} claims marked as the site behaved. ${claims.wrong} misread, at no cost.`,
      { res: RESEARCH_PER_RULE_READ * claims.correct, st: { research: Math.min(4, claims.correct) } });
  }

  for (const b of BEHAVIOUR_YIELD) {
    const n = Math.min(b.cap, Math.max(0, Number(tally[b.tally]) || 0));
    if (!n) continue;
    const st = {};
    for (const [dept, v] of Object.entries(b.per)) st[dept] = v * n;
    credit(b.label, `${n}${n === b.cap ? ' (capped)' : ''}`, { st });
  }

  /* Backing off and re-planning is the §5.4 relief move, and §12.3 has Ethics valuing
   * proportional force. Aborting is therefore worth something, twice, and then nothing —
   * enough to make it a real option, not enough to make it a loop. */
  const aborts = Math.min(2, Math.max(0, Number(mission && mission.abortCount) || 0));
  if (aborts) {
    credit('Aborted and re-planned', `${aborts} procedure${aborts === 1 ? '' : 's'} withdrawn rather than pressed.`,
      { st: { ethics: aborts } });
  }

  const bonus = OVERALL_BONUS[wordKey(result && result.overall)] || { requisition: 0, research: 0 };
  if (bonus.requisition || bonus.research) {
    credit(`Assessment: ${result.overall}`, 'Institutional bonus on the overall word.',
      { req: bonus.requisition, res: bonus.research });
  }

  /* §12.6's stakes: gear that did not come back is bought again out of this operation's
   * money. ⚠ The stewardship dimension's `why` line carries these numbers as PROSE. Do
   * not parse it — the tally is the source of truth and the sentence is for the player. */
  const itemsLost = opts.itemsLost !== undefined ? opts.itemsLost : (Number(tally.deployablesLost) || 0);
  let replacement = 0;
  if (itemsLost > 0) {
    replacement = Math.round(REPLACEMENT_PER_ITEM * itemsLost * (1 + effects.replacementCostPct / 100));
    lines.push({
      label: 'Equipment replacement',
      detail: `${itemsLost} issued item${itemsLost === 1 ? '' : 's'} written off and reordered.`,
      requisition: -replacement, research: 0, standing: {},
    });
    requisition -= replacement;
  }

  if (effects.researchBonusPct) {
    const uplift = Math.round(research * (effects.researchBonusPct / 100));
    if (uplift) {
      lines.push({
        label: 'Analysis capacity',
        detail: `Site and fitted logging equipment add ${effects.researchBonusPct}% to the analytical yield.`,
        requisition: 0, research: uplift, standing: {},
      });
      research += uplift;
    }
  }

  if (effects.standingGainPct) {
    for (const id of DEPARTMENT_IDS) {
      if (standing[id] > 0) standing[id] = Math.round(standing[id] * (1 + effects.standingGainPct / 100));
    }
  }

  /* ⚠ THE FLOORS, AND THE ONE THAT WAS IN THE WRONG PLACE. §12.6 asks for two things:
   * "no debt spiral should make recovery impossible", and "failed missions provide
   * reduced but meaningful research for valid observations".
   *
   * The requisition floor used to clamp THIS DELTA to the operating stipend, which quietly
   * made failure profitable: six consecutive total losses took the site from 340 to 1630,
   * gaining 215 every time, because the dimensions that pay regardless of outcome —
   * secrecy held, no infrastructure damage, no civilians present — plus a guaranteed
   * stipend always outran the replacement costs. An economy where losing everything pays
   * better than not deploying has no stakes at all, and §12.6 is explicit that failure
   * must still cost consumables, gear and standing.
   *
   * A delta may now go NEGATIVE. The protection against ruin belongs on the BALANCE, not
   * on the operation — see `applyDebrief`, which never lets the site fall below what it
   * takes to deploy again. That is what "no debt spiral" actually asks for.
   *
   * Research keeps its floor here, because it is a floor on KNOWLEDGE rather than on
   * money: an operation where the squad genuinely observed something has to teach them
   * something, however badly it ended. */
  const observed = (Number(opts.observations) || 0) + claims.correct + claims.wrong;
  const floored = { requisition: false, research: false };
  if (observed > 0 && research < MIN_RESEARCH_WITH_OBSERVATIONS) {
    research = MIN_RESEARCH_WITH_OBSERVATIONS;
    floored.research = true;
  }
  for (const id of DEPARTMENT_IDS) standing[id] = Math.round(standing[id]);

  return {
    requisition: Math.round(requisition),
    research: Math.round(research),
    standing,
    lines,
    replacement,
    floored,
    overall: (result && result.overall) || 'Unassessed',
  };
}

/* ── persistence ──────────────────────────────────────────────────────────────
 * The pattern is copied from Dev\SmallTownEmergencyServices\src\core\persistence.js
 * (Dev\INDEX.md → Save/load): probe first, migrate on read, sanitise every field, and
 * degrade to no-save rather than throwing. A save that throws is worse than no save at
 * all — the mission must still start on a locked-down profile, in private browsing, and
 * in the headless harness, none of which are allowed to break the game. */

export function storage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__cd_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }   // private mode, headless harness, or a locked-down profile
}

export function defaultProfile() {
  return {
    version: PROGRESSION_VERSION,
    siteId: 'regional-site-19',
    operationsCompleted: 0,
    custodiesVerified: 0,
    requisition: STARTING_REQUISITION,
    research: 0,
    /* Cumulative, never spent — clearance is a milestone and it reads THIS, not the
     * balance, so buying a prototype cannot cost you a clearance level. */
    researchTotalEarned: 0,
    requisitionTotalEarned: 0,
    clearance: 0,
    standing: emptyStanding(),
    knowledge: {},          // anomalyId -> { observations, rulesRead, rulesMisread, insights[] }
    upgrades: [],           // owned upgrade ids
    fitted: {},             // itemId -> upgrade id. One variant per family, on purpose.
    siteUpgrades: [],       // owned site upgrade ids
    roster: [{ id: 'p1', name: 'Operative 1', operations: 0, condition: null, commendations: [] }],
    containment: [],        // one entry per anomaly in custody, with operational history
    history: [],            // one entry per closed operation, newest last
  };
}

function sanitiseStanding(obj) {
  const out = emptyStanding();
  if (!obj || typeof obj !== 'object') return out;
  for (const id of DEPARTMENT_IDS) {
    const v = Number(obj[id]);
    out[id] = Number.isFinite(v) ? clamp(Math.round(v), STANDING_FLOOR, STANDING_CEILING) : 0;
  }
  return out;
}

function sanitiseKnowledge(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [id, rec] of Object.entries(obj)) {
    if (!rec || typeof rec !== 'object') continue;
    out[id] = {
      observations: Math.max(0, Math.floor(Number(rec.observations) || 0)),
      rulesRead: Math.max(0, Math.floor(Number(rec.rulesRead) || 0)),
      rulesMisread: Math.max(0, Math.floor(Number(rec.rulesMisread) || 0)),
      operations: Math.max(0, Math.floor(Number(rec.operations) || 0)),
      insights: Array.isArray(rec.insights) ? rec.insights.filter((s) => typeof s === 'string').slice(0, 40) : [],
    };
  }
  return out;
}

function sanitiseRoster(arr) {
  const base = defaultProfile().roster;
  if (!Array.isArray(arr) || !arr.length) return base;
  const out = [];
  for (const r of arr.slice(0, 5)) {
    if (!r || typeof r !== 'object' || !r.id) continue;
    let condition = null;
    if (r.condition && INJURY_BY_ID.has(r.condition.id)) {
      condition = {
        id: r.condition.id,
        operationsRemaining: clamp(Math.floor(Number(r.condition.operationsRemaining) || 0), 0, 6),
        /* ⚠ Carried across a save on purpose. Without it, reloading the page frees every
         * isolation bed and a second treatment can be bought in the same rotation. */
        treatedThisRotation: !!r.condition.treatedThisRotation,
      };
      if (condition.operationsRemaining <= 0) condition = null;
    }
    out.push({
      id: String(r.id).slice(0, 12),
      name: String(r.name || 'Operative').slice(0, 14),
      operations: Math.max(0, Math.floor(Number(r.operations) || 0)),
      condition,
      commendations: Array.isArray(r.commendations) ? r.commendations.filter((s) => typeof s === 'string').slice(0, 8) : [],
    });
  }
  return out.length ? out : base;
}

function sanitiseContainment(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const c of arr.slice(0, 12)) {
    if (!c || typeof c !== 'object' || !c.anomalyId) continue;
    out.push({
      anomalyId: String(c.anomalyId).slice(0, 48),
      designation: String(c.designation || c.anomalyId).slice(0, 48),
      cellId: c.cellId ? String(c.cellId).slice(0, 24) : null,
      custody: c.custody === 'verified' ? 'verified' : 'unverified',
      sinceOperation: Math.max(0, Math.floor(Number(c.sinceOperation) || 0)),
      lastCheckedOperation: Math.max(0, Math.floor(Number(c.lastCheckedOperation) || 0)),
      history: Array.isArray(c.history) ? c.history.filter((s) => typeof s === 'string').slice(-8) : [],
      maintenance: Array.isArray(c.maintenance) ? c.maintenance.filter((s) => typeof s === 'string').slice(-4) : [],
    });
  }
  return out;
}

function sanitiseHistory(arr, keep) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const h of arr) {
    if (!h || typeof h !== 'object') continue;
    out.push({
      operation: Math.max(0, Math.floor(Number(h.operation) || 0)),
      operationId: h.operationId ? String(h.operationId).slice(0, 48) : null,
      mapId: h.mapId ? String(h.mapId).slice(0, 48) : null,
      anomalyId: h.anomalyId ? String(h.anomalyId).slice(0, 48) : null,
      overall: String(h.overall || 'Unassessed').slice(0, 24),
      failReason: h.failReason ? String(h.failReason).slice(0, 200) : null,
      requisition: Math.round(Number(h.requisition) || 0),
      research: Math.round(Number(h.research) || 0),
      minutes: Number.isFinite(Number(h.minutes)) ? Number(h.minutes) : null,
      dims: Array.isArray(h.dims)
        ? h.dims.slice(0, 12).map((d) => ({ name: String(d.name || '').slice(0, 40), word: String(d.word || '').slice(0, 24) }))
        : [],
      /* ⚠ AND THE SANITISER HAS TO KNOW ABOUT IT, or the night survives exactly until the
       * save is reloaded. Everything this function does not name is dropped, deliberately —
       * that is what makes a save from a future version safe — so a new field added to the
       * record and not added here is a field that works all session and is gone tomorrow,
       * which is the hardest kind of loss to notice. */
      scenario: h.scenario && typeof h.scenario === 'object' ? {
        seed: h.scenario.seed ? String(h.scenario.seed).slice(0, 48) : null,
        weather: h.scenario.weather ? String(h.scenario.weather).slice(0, 32) : null,
        time: h.scenario.time ? String(h.scenario.time).slice(0, 24) : null,
        faulted: Array.isArray(h.scenario.faulted) ? h.scenario.faulted.slice(0, 4).map((x) => String(x).slice(0, 40)) : [],
        shut: Array.isArray(h.scenario.shut) ? h.scenario.shut.slice(0, 4).map((x) => String(x).slice(0, 40)) : [],
      } : null,
    });
  }
  return out.slice(-Math.max(1, keep));
}

/** Future versions land here. An unknown or damaged save falls back to a fresh profile
 *  rather than half-applying itself. */
export function migrate(data) {
  if (!data || typeof data !== 'object') return defaultProfile();
  if (data.version !== PROGRESSION_VERSION) return defaultProfile();

  const base = defaultProfile();
  const upgrades = Array.isArray(data.upgrades) ? data.upgrades.filter((id) => UPGRADES_BY_ID.has(id)) : [];
  const fitted = {};
  if (data.fitted && typeof data.fitted === 'object') {
    for (const [itemId, upId] of Object.entries(data.fitted)) {
      const up = UPGRADES_BY_ID.get(upId);
      /* Only a variant that is OWNED and belongs to that family survives a load. A save
       * edited by hand cannot fit a scanner to a trauma kit. */
      if (up && up.family === itemId && upgrades.includes(upId)) fitted[itemId] = upId;
    }
  }
  const profile = {
    version: PROGRESSION_VERSION,
    siteId: String(data.siteId || base.siteId).slice(0, 48),
    operationsCompleted: Math.max(0, Math.floor(Number(data.operationsCompleted) || 0)),
    custodiesVerified: Math.max(0, Math.floor(Number(data.custodiesVerified) || 0)),
    requisition: Math.max(0, Math.round(Number(data.requisition) || 0)),
    research: Math.max(0, Math.round(Number(data.research) || 0)),
    researchTotalEarned: Math.max(0, Math.round(Number(data.researchTotalEarned) || 0)),
    requisitionTotalEarned: Math.max(0, Math.round(Number(data.requisitionTotalEarned) || 0)),
    clearance: 0,
    standing: sanitiseStanding(data.standing),
    knowledge: sanitiseKnowledge(data.knowledge),
    upgrades,
    fitted,
    siteUpgrades: Array.isArray(data.siteUpgrades)
      ? data.siteUpgrades.filter((s) => typeof s === 'string').slice(0, 24) : [],
    roster: sanitiseRoster(data.roster),
    containment: sanitiseContainment(data.containment),
    history: sanitiseHistory(data.history, 24),
  };
  /* Clearance is DERIVED, always. A save claiming Level 3 with no operations behind it
   * gets Provisional, because the milestone is the fact and not the number. */
  profile.clearance = clearanceFor(profile);
  return profile;
}

export function loadProfile() {
  const s = storage();
  if (!s) return defaultProfile();
  let raw;
  try { raw = s.getItem(SAVE_KEY); } catch { return defaultProfile(); }
  if (!raw) return defaultProfile();
  let data;
  try { data = JSON.parse(raw); } catch { return defaultProfile(); }
  return migrate(data);
}

export function saveProfile(profile) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(SAVE_KEY, JSON.stringify({ ...profile, version: PROGRESSION_VERSION }));
    return true;
  } catch { return false; }   // quota, or a profile that went read-only mid-session
}

export function clearSave() {
  const s = storage();
  if (!s) return false;
  try { s.removeItem(SAVE_KEY); return true; } catch { return false; }
}

/* ── content/site.json ────────────────────────────────────────────────────────
 * Validated in the same spirit as src/sim/content.js: a site file that names an effect no
 * system reads, or gates a room behind a clearance level that does not exist, REFUSES to
 * load. A base whose upgrades quietly do nothing is worse than a base that will not open. */

export function validateSite(doc) {
  const p = [];
  if (!doc || typeof doc !== 'object') return ['not an object'];
  for (const k of ['id', 'displayName', 'rooms', 'operations', 'containmentWing']) {
    if (doc[k] === undefined) p.push(`missing ${k}`);
  }
  const roomIds = new Set();
  const upgradeIds = new Set();
  const maxClearance = Math.max(...CLEARANCE_TIERS.map((t) => t.level));
  for (const r of doc.rooms || []) {
    const at = `room ${r.id || '(no id)'}`;
    if (!r.id) p.push(`${at}: no id`);
    if (roomIds.has(r.id)) p.push(`${at}: duplicate id`);
    roomIds.add(r.id);
    if (!r.name) p.push(`${at}: no name`);
    if (!r.purpose) p.push(`${at}: no purpose line — every room must say what it is for (§13.2)`);
    if (!Array.isArray(r.allows) || !r.allows.length) p.push(`${at}: allows[] is empty — a room that lets the player do nothing is not a room`);
    if (r.clearanceRequired !== undefined && (r.clearanceRequired < 0 || r.clearanceRequired > maxClearance)) {
      p.push(`${at}: clearanceRequired ${r.clearanceRequired} is outside the ${maxClearance}-tier ladder`);
    }
    for (const u of r.upgrades || []) {
      const uat = `${at} upgrade ${u.id || '(no id)'}`;
      if (!u.id) p.push(`${uat}: no id`);
      if (upgradeIds.has(u.id)) p.push(`${uat}: duplicate id`);
      upgradeIds.add(u.id);
      if (!u.name) p.push(`${uat}: no name`);
      if (typeof u.costRequisition !== 'number' || u.costRequisition <= 0) p.push(`${uat}: costRequisition must be positive`);
      if (u.department && !DEPARTMENT_IDS.includes(u.department)) p.push(`${uat}: department ${u.department} is not one of the six`);
      const eff = u.effect || {};
      if (!Object.keys(eff).length) p.push(`${uat}: no effect — §13.3 says upgrades VISIBLY add capability`);
      for (const k of Object.keys(eff)) {
        if (!EFFECT_KEYS.includes(k)) p.push(`${uat}: effect "${k}" is not one any system reads`);
      }
      if (u.requiresUpgrade && !upgradeIds.has(u.requiresUpgrade)) {
        p.push(`${uat}: requires ${u.requiresUpgrade}, which is not declared before it`);
      }
    }
  }
  for (const o of doc.operations || []) {
    const at = `operation ${o.id || '(no id)'}`;
    if (!o.id) p.push(`${at}: no id`);
    if (!o.mapId) p.push(`${at}: names no map`);
    if (!o.anomalyId) p.push(`${at}: names no anomaly`);
    if (!o.mandate) p.push(`${at}: no mandate`);
    if (o.clearanceRequired !== undefined && o.clearanceRequired > maxClearance) {
      p.push(`${at}: clearanceRequired ${o.clearanceRequired} can never be reached`);
    }
  }
  const wing = doc.containmentWing;
  if (wing) {
    if (!Array.isArray(wing.cells) || !wing.cells.length) p.push('containmentWing: no cells');
    for (const c of wing.cells || []) {
      if (!c.id) p.push('containmentWing: a cell has no id');
      if (!c.holding) p.push(`containmentWing cell ${c.id}: no holding description`);
    }
  }
  for (const d of doc.dossiers || []) {
    const at = `dossier ${d.anomalyId || '(no anomaly)'}`;
    if (!d.anomalyId) p.push(`${at}: names no anomaly`);
    if (!d.designation) p.push(`${at}: no designation`);
    for (const i of d.insights || []) {
      if (!i.id) p.push(`${at}: an insight has no id`);
      if (!i.text) p.push(`${at} insight ${i.id}: no text`);
      if (!i.requires || typeof i.requires !== 'object') p.push(`${at} insight ${i.id}: no requires{}`);
    }
  }
  return p;
}

/** Fetch and validate the site. Same URL discipline as content.js: relative to this
 *  module, so the build works at the site root and under /ContainmentDetailWeb/ alike. */
export async function loadSite(path = '../../content/site.json') {
  const res = await fetch(new URL(path, import.meta.url).href, { cache: 'no-store' });
  if (!res.ok) throw new ContentError(path, [`HTTP ${res.status} ${res.statusText}`]);
  let doc;
  try { doc = await res.json(); } catch (e) { throw new ContentError(path, [`not valid JSON (${e.message})`]); }
  const problems = validateSite(doc);
  if (problems.length) throw new ContentError(path, problems);
  return doc;
}

/* ── the campaign object ──────────────────────────────────────────────────── */

export class Progression {
  /**
   * @param {object} opts
   *   profile   an existing profile object (it is migrated and sanitised), else localStorage
   *   site      the content/site.json document, if the caller has it
   *   autosave  false in tests, so a headless run cannot write over a real campaign
   */
  constructor({ profile = null, site = null, autosave = true } = {}) {
    this.profile = profile ? migrate(profile) : loadProfile();
    this.site = site || null;
    this.autosave = autosave;
    /* ⚠ MISSION_ENDED CAN ARRIVE TWICE. endMission() guards itself, but the bus is public
     * and a reconnecting client applies a snapshot that already carries a result. Paying
     * the same debrief twice is the kind of bug that only shows up as an unexplained pile
     * of requisition, so the result object itself is the receipt. */
    this._applied = new WeakMap();
  }

  get clearance() { return clearanceFor(this.profile); }
  get clearanceTier() { return clearanceTier(this.clearance); }
  get nextOperationNumber() { return this.profile.operationsCompleted + 1; }

  save() { return this.autosave ? saveProfile(this.profile) : false; }

  reset() {
    this.profile = defaultProfile();
    this.save();
    return this.profile;
  }

  /* ── standing, prices and effects ─────────────────────────────────────── */

  standing(deptId) { return this.profile.standing[deptId] || 0; }

  tierFor(deptId) { return standingTier(this.standing(deptId)); }

  /** Standing changes what a department charges, never whether it will sell (§12.3). */
  priceOf(upgrade) {
    const base = upgrade.costRequisition || 0;
    const mult = upgrade.department ? this.tierFor(upgrade.department).priceMultiplier : 1;
    return Math.round(base * mult);
  }

  /** Every site upgrade the profile owns, merged, plus the economy blocks of fitted gear. */
  effects() {
    const out = { ...DEFAULT_EFFECTS };
    const rooms = (this.site && this.site.rooms) || [];
    for (const room of rooms) {
      for (const u of room.upgrades || []) {
        if (!this.profile.siteUpgrades.includes(u.id)) continue;
        for (const [k, v] of Object.entries(u.effect || {})) {
          if (!EFFECT_KEYS.includes(k)) continue;
          out[k] = typeof v === 'number' ? out[k] + v : v;
        }
      }
    }
    for (const upId of Object.values(this.profile.fitted)) {
      const up = UPGRADES_BY_ID.get(upId);
      for (const [k, v] of Object.entries((up && up.economy) || {})) {
        if (EFFECT_KEYS.includes(k)) out[k] += v;
      }
    }
    return out;
  }

  /* ── equipment ────────────────────────────────────────────────────────── */

  owns(upgradeId) { return this.profile.upgrades.includes(upgradeId); }

  fittedFor(itemId) { return this.profile.fitted[itemId] || null; }

  /** The merged modifier block for one item id — what a loadout screen applies. */
  modifiersFor(itemId) {
    const upId = this.fittedFor(itemId);
    const up = upId && UPGRADES_BY_ID.get(upId);
    const mods = [];
    if (up) mods.push(up.modifiers);
    const battery = this.effects().equipmentBatteryBonusMinutes;
    /* §13.3 backup power: the site charges cells properly overnight. It is efficiency —
     * every item gains the same minute — and it is not a sidegrade, so it stacks. */
    if (battery) mods.push({ add: { batteryMinutes: battery } });
    return mergeModifiers(mods);
  }

  /** A copy of an items.json entry as the site would actually issue it. */
  itemAsIssued(item) {
    if (!item || !item.id) return item;
    return applyModifiers(item, this.modifiersFor(item.id));
  }

  buyUpgrade(upgradeId) {
    const up = UPGRADES_BY_ID.get(upgradeId);
    if (!up) return 'No such upgrade.';
    if (this.owns(upgradeId)) return 'Already requisitioned.';
    const price = this.priceOf(up);
    if (this.profile.requisition < price) return `Requisition short by ${price - this.profile.requisition}.`;
    if ((up.costResearch || 0) > this.profile.research) {
      return `Research data short by ${up.costResearch - this.profile.research}.`;
    }
    this.profile.requisition -= price;
    this.profile.research -= (up.costResearch || 0);
    this.profile.upgrades.push(upgradeId);
    /* Fitted on arrival, because an unfitted variant sitting in a locker is a click that
     * teaches the player nothing. They can swap back at any time, for free. */
    this.profile.fitted[up.family] = upgradeId;
    this.save();
    return null;
  }

  /**
   * ⚠ ONE VARIANT PER FAMILY, AND THE BASE TOOL IS ALWAYS AN OPTION. This is the whole
   * mechanism behind §10.1: you cannot bolt three sidegrades onto one imager and end up
   * with a strictly better imager. Passing null refits the standard item.
   */
  fitUpgrade(itemId, upgradeId) {
    if (upgradeId === null) { delete this.profile.fitted[itemId]; this.save(); return null; }
    const up = UPGRADES_BY_ID.get(upgradeId);
    if (!up) return 'No such upgrade.';
    if (up.family !== itemId) return `${up.name} does not fit a ${itemId}.`;
    if (!this.owns(upgradeId)) return 'Not requisitioned yet.';
    this.profile.fitted[itemId] = upgradeId;
    this.save();
    return null;
  }

  /* ── the site itself (§13.3) ──────────────────────────────────────────── */

  siteUpgradeById(id) {
    for (const room of (this.site && this.site.rooms) || []) {
      for (const u of room.upgrades || []) if (u.id === id) return { room, upgrade: u };
    }
    return null;
  }

  buySiteUpgrade(id) {
    const found = this.siteUpgradeById(id);
    if (!found) return 'No such site upgrade.';
    const { upgrade: u } = found;
    if (this.profile.siteUpgrades.includes(id)) return 'Already built.';
    if (u.requiresUpgrade && !this.profile.siteUpgrades.includes(u.requiresUpgrade)) {
      return 'Depends on work that has not been done.';
    }
    if ((u.clearanceRequired || 0) > this.clearance) return `Requires ${clearanceTier(u.clearanceRequired).name}.`;
    const price = this.priceOf(u);
    if (this.profile.requisition < price) return `Requisition short by ${price - this.profile.requisition}.`;
    if ((u.costResearch || 0) > this.profile.research) return `Research data short by ${u.costResearch - this.profile.research}.`;
    this.profile.requisition -= price;
    this.profile.research -= (u.costResearch || 0);
    this.profile.siteUpgrades.push(id);
    this.save();
    return null;
  }

  roomOpen(room) { return (room.clearanceRequired || 0) <= this.clearance; }

  /** Cells the wing has, including any specialised storage that has been built. */
  cells() {
    const wing = (this.site && this.site.containmentWing) || { cells: [] };
    const extra = this.effects().containmentCells;
    const cells = (wing.cells || []).slice();
    for (let i = 0; i < extra; i++) {
      cells.push({
        id: `overflow-${i + 1}`,
        label: `Specialised storage ${i + 1}`,
        holding: 'Built out of the requisition budget. Climate and sensor ports on the same bus as the main run.',
      });
    }
    return cells;
  }

  /* ── §12.5 personnel ──────────────────────────────────────────────────── */

  /** Everyone. Injured operatives are on this list, because §12.5 says a player can
   *  always field a character — an injury is a handicap, never a bench. */
  fieldable() { return this.profile.roster.slice(); }

  conditionOf(operativeId) {
    const op = this.profile.roster.find((r) => r.id === operativeId);
    if (!op || !op.condition) return null;
    const eff = INJURY_BY_ID.get(op.condition.id);
    if (!eff) return null;
    return { ...eff, operationsRemaining: op.condition.operationsRemaining };
  }

  /** The loadout modifiers a squad carries into the field because of injuries. */
  squadHandicap(ids = null) {
    const out = { cargoVolume: 0, stabiliseFactor: 1 };
    for (const op of this.profile.roster) {
      if (ids && !ids.includes(op.id)) continue;
      const c = this.conditionOf(op.id);
      if (!c) continue;
      out.cargoVolume += c.effect.cargoVolume || 0;
      out.stabiliseFactor = Math.max(out.stabiliseFactor, c.effect.stabiliseFactor || 1);
    }
    return out;
  }

  treatmentCapacity() { return this.effects().treatmentCapacity; }

  /**
   * Treat an operative. Costs requisition and a bed; never costs real time, and is never
   * required — an untreated operative deploys with the effect and it expires on its own.
   */
  treat(operativeId, treatmentId) {
    const op = this.profile.roster.find((r) => r.id === operativeId);
    if (!op) return 'No such operative.';
    if (!op.condition) return 'Nothing to treat.';
    const t = TREATMENTS_BY_ID.get(treatmentId);
    if (!t) return 'No such treatment.';
    const beds = this.treatmentCapacity();
    const inUse = this.profile.roster.filter((r) => r.condition && r.condition.treatedThisRotation).length;
    if (t.capacity > 0 && inUse + t.capacity > beds) return `The site has ${beds} isolation bed${beds === 1 ? '' : 's'} and ${inUse} in use.`;
    const price = Math.round(t.costRequisition * (1 + this.effects().treatmentCostPct / 100));
    if (this.profile.requisition < price) return `Requisition short by ${price - this.profile.requisition}.`;
    this.profile.requisition -= price;
    op.condition.operationsRemaining -= t.clears;
    if (op.condition.operationsRemaining <= 0) op.condition = null;
    else op.condition.treatedThisRotation = true;
    this.save();
    return null;
  }

  /* ── §12.1 research knowledge ─────────────────────────────────────────── */

  knowledgeFor(anomalyId) {
    return this.profile.knowledge[anomalyId]
      || { observations: 0, rulesRead: 0, rulesMisread: 0, operations: 0, insights: [] };
  }

  dossierFor(anomalyId) {
    return ((this.site && this.site.dossiers) || []).find((d) => d.anomalyId === anomalyId) || null;
  }

  /**
   * Which authored insights the profile has earned. ⚠ An insight grants CONTEXT ONLY —
   * a line the briefing did not previously carry. It never changes a number the anomaly
   * obeys, which is what keeps §12.1's "does not turn horror into immunity" true even
   * after a player has run the same incident six times.
   */
  insightsFor(anomalyId) {
    const d = this.dossierFor(anomalyId);
    if (!d) return [];
    const k = this.knowledgeFor(anomalyId);
    return (d.insights || []).map((i) => {
      const r = i.requires || {};
      const met = (r.rules === undefined || k.rulesRead >= r.rules)
        && (r.operations === undefined || k.operations >= r.operations)
        && (r.research === undefined || this.profile.researchTotalEarned >= r.research);
      return { ...i, unlocked: met };
    });
  }

  /* ── the debrief ──────────────────────────────────────────────────────── */

  /**
   * Fold one closed operation into the campaign.
   *
   * @param {object} result   mission.grade()'s return, plus endMission's `failReason`.
   *                          See earningsFor() above for the exact shape.
   * @param {object} mission  the Mission instance (optional; used for the tally).
   * @param {object} opts     { mapId, anomalyId, operationId, custody, extracted,
   *                            minutes, observations, squad, itemsLost }
   * @returns {object} { earnings, clearance:{from,to,gained}, insights[], injuries[],
   *                     recovered[], containment, maintenance[], history, saved }
   */
  applyDebrief(result, mission = null, opts = {}) {
    if (this._applied.has(result)) return this._applied.get(result);

    const p = this.profile;
    const effects = this.effects();
    const custody = opts.custody
      || (dimWord(result, 'Containment integrity') === 'Established' ? 'verified' : 'none');
    const minutes = opts.minutes !== undefined ? opts.minutes : minutesFrom(result);
    const earnings = earningsFor(result, mission, {
      effects,
      itemsLost: opts.itemsLost,
      observations: opts.observations,
    });

    const clearanceBefore = clearanceFor(p);

    p.operationsCompleted += 1;
    /* ⚠ THIS IS WHERE "no debt spiral" LIVES — on the balance, not on the operation.
     * A bad operation is allowed to cost more than it earned; what it may never do is
     * leave the site unable to fund the next one. Floored at the cost of deploying, so
     * there is always exactly one more attempt in the account, which is the recovery
     * §12.6 promises and nothing more comfortable than that. */
    p.requisition = Math.max(DEPLOYMENT_COST, p.requisition + earnings.requisition);
    p.research = Math.max(0, p.research + earnings.research);
    p.requisitionTotalEarned += Math.max(0, earnings.requisition);
    p.researchTotalEarned += Math.max(0, earnings.research);
    for (const id of DEPARTMENT_IDS) {
      p.standing[id] = clamp(p.standing[id] + (earnings.standing[id] || 0), STANDING_FLOOR, STANDING_CEILING);
    }
    if (custody === 'verified') p.custodiesVerified += 1;

    /* Knowledge, per anomaly. The observation count is what the ledger logged; the rule
     * counts are what the player actually read off the board. */
    const anomalyId = opts.anomalyId || (this.site && this.site.operations && this.site.operations[0] && this.site.operations[0].anomalyId) || 'unknown';
    const claims = (result && result.claims) || { correct: 0, wrong: 0 };
    const k = { ...this.knowledgeFor(anomalyId) };
    k.observations += Number(opts.observations) || 0;
    k.rulesRead = Math.max(k.rulesRead, claims.correct || 0);
    k.rulesMisread += claims.wrong || 0;
    k.operations += 1;
    p.knowledge[anomalyId] = k;

    const insightsBefore = new Set(k.insights);
    const gainedInsights = [];
    for (const i of this.insightsFor(anomalyId)) {
      if (!i.unlocked || insightsBefore.has(i.id)) continue;
      k.insights.push(i.id);
      gainedInsights.push(i);
    }

    /* §12.5. Existing conditions age off FIRST, then this operation's injuries land — so
     * an injury taken today is not also served a day of its own sentence, and a bed booked
     * last rotation is free again. ⚠ This tick is the entire recovery clock: it counts
     * OPERATIONS, and there is deliberately no other way for a condition to expire. */
    const recovered = this._ageConditions();
    const injuries = this._applyInjuries(result, opts.squad);

    /* Existing custody ages by one operation, which is where §13.4's base incidents come
     * from: a note, never a chore, and never something that destroys progress. */
    const maintenance = this._ageContainment(effects);

    const containment = custody === 'verified'
      ? this._recordCapture(anomalyId, result, minutes)
      : null;

    const history = {
      operation: p.operationsCompleted,
      operationId: opts.operationId || null,
      mapId: opts.mapId || null,
      anomalyId,
      overall: (result && result.overall) || 'Unassessed',
      failReason: (result && result.failReason) || null,
      requisition: earnings.requisition,
      research: earnings.research,
      minutes,
      dims: ((result && result.dims) || []).map((d) => ({ name: d.name, word: String(d.word) })),
      /**
       * WHICH NIGHT THIS WAS (GDD §14.4).
       *
       * ⚠ Without it the archive cannot compare two operations on the same floor, and §13's
       * whole reason for keeping a history is that it should be comparable. "The cold store,
       * Costly" twice over is two identical lines describing a hard frost with a jammed
       * freight door and a still night with everything open — and a squad reading their own
       * record would conclude the floor is simply like that, which is the one thing
       * controlled variation exists to stop them believing.
       */
      scenario: opts.scenario || null,
    };
    p.history.push(history);
    p.history = p.history.slice(-Math.max(1, effects.historyKept));

    p.clearance = clearanceFor(p);

    const applied = {
      earnings,
      clearance: { from: clearanceBefore, to: p.clearance, gained: p.clearance > clearanceBefore },
      insights: gainedInsights,
      injuries,
      recovered,
      containment,
      maintenance,
      history,
      saved: this.save(),
    };
    this._applied.set(result, applied);
    return applied;
  }

  /** One operation of every standing condition, served. Returns who came off the list. */
  _ageConditions() {
    const recovered = [];
    for (const op of this.profile.roster) {
      if (!op.condition) continue;
      op.condition.treatedThisRotation = false;   // the bed is free again
      op.condition.operationsRemaining -= 1;
      if (op.condition.operationsRemaining <= 0) {
        recovered.push({ operativeId: op.id, name: op.name, effect: INJURY_BY_ID.get(op.condition.id) || null });
        op.condition = null;
      }
    }
    return recovered;
  }

  _applyInjuries(result, squad) {
    const applied = [];
    const assign = (operative, effectId) => {
      const eff = INJURY_BY_ID.get(effectId);
      if (!eff || !operative) return;
      const existing = operative.condition && INJURY_BY_ID.get(operative.condition.id);
      /* The worse condition wins, and it does not stack. Two operations in a row of the
       * same injury should not accumulate into a character nobody can field. */
      if (existing && existing.operations >= eff.operations && operative.condition.operationsRemaining >= eff.operations) return;
      operative.condition = { id: eff.id, operationsRemaining: eff.operations };
      applied.push({ operativeId: operative.id, name: operative.name, effect: eff });
    };

    if (Array.isArray(squad) && squad.length) {
      for (const s of squad) {
        const op = this.profile.roster.find((r) => r.id === s.id)
          || this._ensureOperative(s.id, s.name);
        op.operations += 1;
        if (!s.alive) continue;                       // §9.5 handles the roster consequence
        if (s.downed) assign(op, 'fatigue');
        else if (s.injured) assign(op, s.conditions && s.conditions.exposure && s.conditions.exposure.severity > 0 ? 'exposure' : 'strain');
      }
      return applied;
    }

    const word = dimWord(result, 'Personnel survival');
    const first = this.profile.roster[0];
    if (first) first.operations += 1;
    if (word === 'Critical') assign(first, 'fatigue');
    else if (word === 'Injured') assign(first, 'strain');
    return applied;
  }

  _ensureOperative(id, name) {
    let op = this.profile.roster.find((r) => r.id === id);
    if (op) return op;
    op = { id: String(id).slice(0, 12), name: String(name || id).slice(0, 14), operations: 0, condition: null, commendations: [] };
    this.profile.roster.push(op);
    return op;
  }

  /**
   * §13.4 base incidents, in their smallest honest form: a note against a cell when a
   * hold has run long enough to need a check. ⚠ It never becomes a chore and it never
   * destroys progress — the wing reports, and the player may read it or not.
   */
  _ageContainment(effects) {
    const notes = [];
    const wing = (this.site && this.site.containmentWing) || {};
    const interval = Math.max(1, (wing.maintenanceIntervalOperations || 3) + effects.maintenanceIntervalOperations);
    for (const entry of this.profile.containment) {
      const since = this.profile.operationsCompleted - entry.lastCheckedOperation;
      if (since < interval) continue;
      entry.lastCheckedOperation = this.profile.operationsCompleted;
      const template = (wing.maintenanceNotes || [])[entry.maintenance.length % Math.max(1, (wing.maintenanceNotes || []).length)]
        || 'Scheduled check due. Sensor log reviewed, no change recorded.';
      const note = `Operation ${this.profile.operationsCompleted}: ${template}`;
      entry.maintenance.push(note);
      entry.maintenance = entry.maintenance.slice(-4);
      notes.push({ anomalyId: entry.anomalyId, note });
    }
    return notes;
  }

  /**
   * ⚠ OPERATIONAL HISTORY, NOT TROPHY FRAMING (§13.2). The entry records where it came
   * from, what holding it costs and what it has done since — never a rank, a rarity, a
   * count of how many you own, or a word like "captured" used as a score. The wording of
   * these lines is content (content/site.json) precisely so it can be reviewed as writing.
   */
  _recordCapture(anomalyId, result, minutes) {
    const dossier = this.dossierFor(anomalyId);
    const existing = this.profile.containment.find((c) => c.anomalyId === anomalyId);
    const opN = this.profile.operationsCompleted;
    const line = `Operation ${opN}: custody verified${minutes ? ` at ${Number(minutes).toFixed(1)} min` : ''}. Transferred under ${(dossier && dossier.holding) || 'standard escort'}.`;
    if (existing) {
      existing.history.push(line);
      existing.history = existing.history.slice(-8);
      existing.custody = 'verified';
      existing.lastCheckedOperation = opN;
      return existing;
    }
    const cells = this.cells();
    const taken = new Set(this.profile.containment.map((c) => c.cellId));
    const cell = cells.find((c) => !taken.has(c.id)) || null;
    const entry = {
      anomalyId,
      designation: (dossier && dossier.designation) || anomalyId,
      cellId: cell ? cell.id : null,
      custody: 'verified',
      sinceOperation: opN,
      lastCheckedOperation: opN,
      history: [line],
      maintenance: [],
    };
    this.profile.containment.push(entry);
    return entry;
  }
}

/* ── small readers over grade()'s output ──────────────────────────────────── */

/** The word grade() gave a named dimension, or null. Normalised, so a spelling pass on
 *  the dimension names does not silently break every reader. */
export function dimWord(result, name) {
  const want = dimKey(name);
  for (const d of (result && result.dims) || []) if (dimKey(d.name) === want) return d.word;
  return null;
}

/** Minutes, read off the time dimension. It is authored as "12.4 min", so it is parsed
 *  as a measurement rather than looked up as a verdict. */
export function minutesFrom(result) {
  const w = dimWord(result, 'Time to stabilisation');
  const n = Number(String(w || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}
