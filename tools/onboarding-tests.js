/* Onboarding — GDD §18.6, and the one sentence that makes it hard.
 *
 *     "Tutorials teach the reasoning pattern, not the solution to later anomalies."
 *
 * That rules out almost every tutorial this kind of game ships. A tutorial that says "a
 * sustained gradient above 40°C stops it" has handed over the answer to the first incident
 * and taught a NUMBER where the game is about a METHOD — and §7.4 asks for confidence rather
 * than checklist completion, so the second incident finds a squad that memorised a threshold
 * instead of learning to look.
 *
 * What this suite holds:
 *   · that the competency document teaches no figure, enforced by the loader
 *   · that every competency is a VERB the operative performs, watched on the bus
 *   · that certification is earned by DOING and never by acknowledging
 *   · that it gates nothing, because §12.1 says progression grants options and never power
 *   · that a real driven mission earns them, so the events named are events that happen
 */

import { lines, counts, ok, eq, note, emit, run, heading } from './harness.js';
import { loadOnboarding, validateOnboarding, Certification } from '../src/sim/certification.js';
import { loadContent } from '../src/sim/content.js';
import { Game, RECOMMENDED_MANIFEST, EVENTS } from '../src/game.js';
import { SLOTS } from '../src/config.js';

/* ── A. the document ──────────────────────────────────────────────────────── */
async function sectionA(doc) {
  heading('A. the competency document, and what it is forbidden to say');

  ok('A1 it loads and validates', !!doc && (doc.competencies || []).length > 0);
  note(`${doc.competencies.length} competencies across ${doc.layers.length} layers`);

  /* Every competency names an event the engine actually emits. A competency watching for an
   * event nothing fires is a competency nobody can ever earn. */
  const unknown = doc.competencies.filter((c) => !Object.values(EVENTS).includes(c.event));
  eq(`A2 every competency watches an event the engine emits${unknown.length ? ` — ${unknown.map((c) => `${c.id}/${c.event}`).join(', ')}` : ''}`,
    unknown.length, 0);

  /**
   * ⚠ AND NONE OF THEM TEACHES A FIGURE. This is the assertion the whole file is about. A
   * digit followed by a unit — 40C, 1.5m, 46dB, 30s — is exactly the shape of the thing
   * §18.6 forbids, because it is an ANSWER rather than a method.
   */
  const prose = doc.competencies.map((c) => `${c.displayName} ${c.why}`).join(' ');
  const figure = prose.match(/\b\d+(\.\d+)?\s*(°?[CF]\b|m\b|s\b|dB\b|%)/i);
  ok(`A3 no competency teaches a threshold, a distance or a duration${figure ? ` — "${figure[0]}"` : ''}`,
    !figure);
  /* And the loader refuses one that does, so this cannot be undone by editing the file. */
  let refused = false;
  try {
    validateOnboarding({
      layers: [{ id: 'x' }],
      competencies: [{
        id: 'bad', layer: 'x', event: 'DEPLOYED', requires: { count: 1 },
        displayName: 'Build the fence', why: 'A sustained gradient above 40C stops it.',
      }],
    });
  } catch { refused = true; }
  ok('A4 and the loader refuses a document that does, so A3 is enforced rather than observed', refused);

  /* ⚠ NOR DOES ANY OF THEM NAME AN ANOMALY. "not the solution to LATER ANOMALIES" — a
   * competency that mentions the draught is a competency that stops being true at the second
   * incident, and there are eight. */
  const named = ['draught', 'figure', 'tally', 'caller', 'passenger', 'lodger', 'graybox', 'stillwater']
    .filter((n) => new RegExp(`\\b${n}\\b`, 'i').test(prose));
  eq(`A5 and none of them names an anomaly${named.length ? ` — ${named.join(', ')}` : ''}`, named.length, 0);

  /* ⚠ AND NOTHING GATES. `blocking` must not become a field here. */
  const gates = doc.competencies.filter((c) => c.blocking || c.gates || c.required === true);
  eq('A6 no competency claims to gate anything, because §12.1 grants options and never power',
    gates.length, 0);
  emit();
}

/* ── B. earned by doing ───────────────────────────────────────────────────── */
function sectionB(doc) {
  heading('B. certification counts what happened, and nothing else');

  const cert = new Certification(doc);
  eq('B1 nothing is certified before anything has been done', cert.encode().length, 0);

  const deploy = doc.competencies.find((c) => c.event === 'DEPLOYED');
  for (let i = 0; i < deploy.requires.count; i++) cert.record('DEPLOYED');
  ok('B2 the authored number of occurrences earns it', cert.has(deploy.id));

  /* One short of the requirement earns nothing — the count is a count. */
  const two = doc.competencies.find((c) => c.requires.count >= 2 && c.event !== 'DEPLOYED');
  const c2 = new Certification(doc);
  for (let i = 0; i < two.requires.count - 1; i++) c2.record(two.event);
  ok('B3 one short of the requirement earns nothing', !c2.has(two.id), `${two.id} needs ${two.requires.count}`);
  c2.record(two.event);
  ok('B4 and the last one earns it', c2.has(two.id));

  /* ⚠ AND THERE IS NO ACKNOWLEDGEMENT PATH. A player who clicked through a panel has
   * demonstrated nothing, so there is deliberately no method that marks a competency done. */
  /* Getters are excluded: `complete` is a question the object answers about itself, not a
   * lever. What must not exist is a CALLABLE that awards a competency. */
  const proto = Object.getPrototypeOf(cert);
  const shortcuts = Object.getOwnPropertyNames(proto).filter((k) => {
    const d = Object.getOwnPropertyDescriptor(proto, k);
    return typeof d.value === 'function' && /^(acknowledge|skip|complete|grant|award|markDone|certify)$/i.test(k);
  });
  eq(`B5 there is no way to acknowledge a competency into existence${shortcuts.length ? ` — ${shortcuts.join(', ')}` : ''}`,
    shortcuts.length, 0);

  /* Each is announced exactly once. */
  const fresh1 = cert.drain();
  ok('B6 a newly earned competency is reported once', fresh1.includes(deploy.id));
  eq('B7 and not again on the next drain', cert.drain().length, 0);
  emit();
}

/* ── C. a driven mission earns them ───────────────────────────────────────── */
async function sectionC(doc, content) {
  heading('C. an operation played through the real verbs earns the certificate');

  /**
   * ⚠ THE POINT OF THIS SECTION IS THAT THE EVENTS ARE REACHABLE. A competency list that
   * names events nothing fires would pass every assertion above and certify nobody, for
   * ever, with no error anywhere. So this plays an operation and counts.
   */
  const g = new Game(content, { seed: 'certify' });
  const cert = new Certification(doc);
  cert.watch(g.bus);
  g.commitLoadout(RECOMMENDED_MANIFEST);
  const p = g.player;

  p.x = g.site.cache.x; p.z = g.site.cache.z;
  g.skipMs(60);
  g.takeFromCache('thermal-imager');
  g.takeFromCache('floodlight-tripod');
  const imagerSlot = SLOTS.findIndex((s) => p.slots.get(s.id) === 'thermal-imager');
  const tripodSlot = SLOTS.findIndex((s) => p.slots.get(s.id) === 'floodlight-tripod');
  if (imagerSlot >= 0) g.selectSlot('p1', imagerSlot);
  if (tripodSlot >= 0) g.selectSlot('p1', tripodSlot);

  /* Leave the command point, which is what ends Arrival. */
  g.setCommand('p1', { axis: { x: 0, y: 1 }, sprint: true, crouch: false });
  for (let i = 0; i < 300; i++) g.skipMs(16);
  g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });

  /* Deploy and recover. `deployHeld` refuses with a sentence rather than throwing — no room
   * to set it down, nothing in hand, too close to a fixture — so the refusal is read and
   * another spot is tried. A test that ignores a refusal measures the refusal. */
  const tSlot = SLOTS.findIndex((s) => p.slots.get(s.id) === 'floodlight-tripod');
  if (tSlot >= 0) g.selectSlot('p1', tSlot);
  let refusal = null;
  for (const [dx, dz] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [3, 3]]) {
    p.x = g.site.cache.x + dx; p.z = g.site.cache.z + dz; p.yaw = 0;
    g.skipMs(60);
    refusal = g.deployHeld();
    if (g.deployables.list.length) break;
  }
  note(`deploy: ${g.deployables.list.length ? 'placed' : `refused — ${refusal}`}`);
  const dep = g.deployables.list[0];
  if (dep) {
    p.x = dep.x; p.z = dep.z;
    g.skipMs(60);
    const act = g.contextAction();
    if (act && act.kind === 'retrieve') g.doInteract();
    else note(`retrieve: offered ${act ? act.kind : 'nothing'}`);
  }

  /* A breaker. */
  const sw = [...g.site.circuits.values()][0];
  if (sw) { p.x = sw.switchX; p.z = sw.switchZ; g.skipMs(60); const a = g.contextAction(); if (a && a.kind === 'circuit') g.doInteract(); }

  /* Two observations, off the floor. */
  const sources = (content.map.evidenceSources || []).filter((s) => !(s.requiresEquipment || []).length).slice(0, 2);
  for (const s of sources) {
    p.x = s.at[0]; p.z = s.at[1];
    g.skipMs(60);
    const a = g.contextAction();
    if (a && a.kind === 'evidence') g.doInteract();
  }

  /* A view, revised, then a plan. */
  const claims = g.ledger.claims;
  g.setClaim(claims[0].id, 'supported');
  g.setClaim(claims[0].id, 'excluded');
  g.setClaim(claims[1].id, 'supported');
  g.commitProcedure({ target: 'a', state: 'b', trigger: 'c', transfer: 'd', maintained: [], abort: 'e' });

  const rows = cert.rows();
  for (const r of rows) note(`  ${r.displayName}: ${r.earned} of ${r.total}`);
  const missed = doc.competencies.filter((c) => !cert.has(c.id));
  eq(`C1 one played operation demonstrates every competency${missed.length ? ` — missed ${missed.map((c) => c.id).join(', ')}` : ''}`,
    missed.length, 0);
  ok('C2 and the certificate reads complete', cert.complete);
  note(cert.summary());

  /* It survives a round trip through a profile, because only ids are stored. */
  const restored = new Certification(doc, cert.encode());
  ok('C3 and it survives a profile round trip, because only ids are stored', restored.complete);
  cert.detach();
  emit();
}

/* ── D. it gates nothing ──────────────────────────────────────────────────── */
async function sectionD(doc, content) {
  heading('D. an uncertified squad can still deploy');

  /**
   * §12.1: progression grants OPTIONS, CONTEXT and EFFICIENCY — never power, and never
   * permission. A certificate that locked the mission board would be the base charging a
   * player for a lesson they may not need, and §18.6's third layer is a difficulty preset
   * rather than a gate. Asserted rather than assumed, because "just make it required" is
   * the single most natural change anybody will ever propose to this file.
   */
  const g = new Game(content, { seed: 'ungated' });
  const cert = new Certification(doc);
  eq('D1 nothing is certified', cert.encode().length, 0);
  const ok1 = g.commitLoadout(RECOMMENDED_MANIFEST);
  ok('D2 and the operation still commits its loadout', ok1 !== false && g.mission.phase !== 'Loadout');
  g.skipMs(500);
  ok('D3 and still runs', g.clock.simTimeMs > 0);

  /* And nothing in the module can be asked whether a thing is allowed. */
  const src = await (await fetch('/src/sim/certification.js')).text();
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('D4 and the module exposes no permission question at all',
    !/canDeploy|isAllowed|blocked|permit/i.test(code));
  emit();
}

/* ── run ──────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    const doc = await loadOnboarding();
    const content = await loadContent();
    await run('A', () => sectionA(doc));
    await run('B', () => sectionB(doc));
    await run('C', () => sectionC(doc, content));
    await run('D', () => sectionD(doc, content));
    emit();
  } catch (e) {
    lines.push(`FAIL  the onboarding suite itself threw: ${e && e.stack ? e.stack : e}`);
    counts.fails++;
    emit();
  }
})();
