/* Telemetry — GDD §21, and the prohibition at the end of §21.2.
 *
 * The events all fired and nothing collected them. §21.1 lists seven questions telemetry
 * "should answer"; §21.3 gives six balance targets; §23 Milestone 5 asks for external
 * balance and onboarding tests, which cannot be run at all unless somebody can take
 * something away from a session. Every §26.4 criterion about players reads OPEN and would
 * still read OPEN after a hundred playtests, because a facilitator watching over a shoulder
 * is not data and a bus log that dies with the tab is not either.
 *
 * What this suite is really about is the LAST LINE of §21.2: no free text, no personal data.
 * A telemetry file is exactly where that gets quietly lost — it is the one place in a build
 * whose whole job is to write things down. So the assertions below do not read the code's
 * intentions. They play a session with a deliberately distinctive callsign and then grep the
 * produced record for it.
 */

import { lines, counts, ok, eq, note, emit, run, heading } from './harness.js';
import { loadContent, INCIDENTS } from '../src/sim/content.js';
import { Game, RECOMMENDED_MANIFEST, EVENTS } from '../src/game.js';
import { PHASE } from '../src/sim/mission.js';
import { sessionRecord, sessionRecordText, RECORDED } from '../src/sim/telemetry.js';
import { SLOTS } from '../src/config.js';

const CALLSIGN = 'Zzz Personal Data Vasquez';

/** One driven operation, far enough to have something to report. */
async function drive(content, seed = 'telemetry') {
  const g = new Game(content, { seed });
  const mate = g.addPlayer(CALLSIGN);
  g.commitLoadout(RECOMMENDED_MANIFEST);
  const p = g.player;

  p.x = g.site.cache.x; p.z = g.site.cache.z;
  g.skipMs(60);
  g.takeFromCache('thermal-imager');
  g.takeFromCache('floodlight-tripod');
  const imagerSlot = SLOTS.findIndex((s) => p.slots.get(s.id) === 'thermal-imager');
  if (imagerSlot >= 0) { g.selectSlot('p1', (imagerSlot + 1) % SLOTS.length); g.selectSlot('p1', imagerSlot); }

  g.setCommand('p1', { axis: { x: 0, y: 1 }, sprint: true, crouch: false });
  for (let i = 0; i < 240; i++) g.skipMs(16);
  g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });

  const tSlot = SLOTS.findIndex((s) => p.slots.get(s.id) === 'floodlight-tripod');
  if (tSlot >= 0) g.selectSlot('p1', tSlot);
  for (const [dx, dz] of [[0, 0], [2, 0], [-2, 0], [0, 2], [3, 3]]) {
    p.x = g.site.cache.x + dx; p.z = g.site.cache.z + dz; p.yaw = 0;
    g.skipMs(60);
    g.deployHeld();
    if (g.deployables.list.length) break;
  }
  const dep = g.deployables.list[0];
  if (dep) { p.x = dep.x; p.z = dep.z; g.skipMs(60); const a = g.contextAction(); if (a && a.kind === 'retrieve') g.doInteract(); }

  for (const s of (content.map.evidenceSources || []).filter((s2) => !(s2.requiresEquipment || []).length).slice(0, 2)) {
    p.x = s.at[0]; p.z = s.at[1];
    g.skipMs(60);
    const a = g.contextAction();
    if (a && a.kind === 'evidence') g.doInteract();
  }

  const claims = g.ledger.claims;
  g.setClaim(claims[0].id, 'supported');
  g.setClaim(claims[0].id, 'excluded');
  const card = { target: 'a', state: 'b', trigger: 'c', transfer: 'd', maintained: [], abort: 'e' };
  g.commitProcedure(card);
  g.commitProcedure({ ...card, target: 'a2' });

  /* A casualty, so the record has one. */
  mate.x = p.x; mate.z = p.z;
  mate.applyCondition('exposure', 'serious');
  mate.applyCondition('exposure', 'serious');
  g.skipMs(300);
  return g;
}

/* ── A. §21.2's prohibition ───────────────────────────────────────────────── */
async function sectionA(content) {
  heading('A. no free text and no personal data, checked by looking rather than by trusting');

  const g = await drive(content);
  const text = sessionRecordText(g, { build: 'test', locale: 'en-GB' });

  /**
   * ⚠ THE ASSERTION IS A GREP OVER THE PRODUCT, NOT A REVIEW OF THE CODE. A field list can
   * be right and a nested object can still carry a name; the only check that cannot be
   * fooled by a refactor is looking at what came out.
   */
  ok('A1 the operative is on the roster under a distinctive name, so this is not vacuous',
    g.players.some((p) => p.name === CALLSIGN));
  ok(`A2 and no callsign appears anywhere in the record`,
    !text.includes(CALLSIGN) && !text.includes('Vasquez'), text.slice(0, 200));
  ok('A3 nor the default callsign the game invents for operative one',
    !/Operative\s\d/.test(text));

  /* Notices are prose written for a player; the bus does not even keep them. */
  ok('A4 and no notice text, which is the other prose in the build',
    !text.includes('is down') && !text.includes('contact.'), text.slice(0, 160));

  const rec = sessionRecord(g);
  const kinds = new Set(rec.events.map((e) => e.t));
  const stray = [...kinds].filter((k) => !RECORDED.includes(k));
  eq(`A5 only events on the recorded list appear${stray.length ? ` — ${stray.join(', ')}` : ''}`, stray.length, 0);
  note(`${rec.events.length} events, ${kinds.size} distinct kinds`);

  /* Every value is a scalar: an object is where a name hides. */
  const nested = rec.events.filter((e) => Object.values(e).some((v) => v !== null && typeof v === 'object'));
  eq('A6 no event carries a nested object, because an object is where a name hides', nested.length, 0);
  emit();
}

/* ── B. it answers the questions §21.1 actually asks ──────────────────────── */
async function sectionB(content) {
  heading('B. the four questions §21.1 asks that a record CAN answer');

  const g = await drive(content, 'telemetry-b');
  const r = sessionRecord(g, { build: 'b' });

  ok('B1 "how long does each part take" — the phase spans come from the mission log',
    Array.isArray(r.phases) && r.phases.length > 0, `${r.phases.length} spans`);
  ok('B2 and they are contiguous, so a share of mission time means something',
    r.phases.every((s, i) => i === 0 || s.fromMs >= r.phases[i - 1].toMs - 1));
  note(`phases: ${r.phases.map((s) => `${s.phase} ${(s.toMs - s.fromMs) / 1000 | 0}s`).join(' · ')}`);

  ok('B3 "which evidence is found or misunderstood" — logged against available, and claims scored',
    r.evidence.available > 0 && r.evidence.logged >= 0
    && typeof r.evidence.claimsCorrect === 'number');
  note(`evidence ${r.evidence.logged}/${r.evidence.available}, claims ${r.evidence.claimsCorrect} right / ${r.evidence.claimsWrong} wrong`);

  ok('B4 "how often do teams revise a procedure" — the revision is counted',
    r.procedure.committed && r.procedure.revisions >= 1,
    `committed=${r.procedure.committed} revisions=${r.procedure.revisions}`);

  /**
   * §21.1's "which role lacks meaningful work" is answered by a count PER SEAT, and a seat
   * with none is the answer rather than a missing row — so a zero must be present.
   */
  const seats = Object.keys(r.perSeatContributions);
  eq('B5 "which role lacks meaningful work" — every seat has a row, including the idle one',
    seats.length, g.players.length);
  ok('B6 and the seats are seats rather than people', seats.every((s) => /^p\d+$/.test(s)), seats.join());
  note(`contributions per seat: ${seats.map((s) => `${s}:${r.perSeatContributions[s]}`).join(' ')}`);

  /* §21.3's one arithmetic target. */
  ok('B7 §21.3\'s containment share is reported as a fraction rather than as two numbers',
    r.containmentShare >= 0 && r.containmentShare <= 1);
  note(`containment share ${(r.containmentShare * 100).toFixed(1)}% of ${(r.durationMs / 1000).toFixed(0)}s`);

  /**
   * ⚠ AND THE RECORD SAYS WHAT IT CANNOT ANSWER. Three of §21.1's seven are about what
   * people thought. A record that quietly omitted them would read, to somebody totalling up
   * a playtest, as though the set were complete.
   */
  ok('B8 and the record names the questions it cannot answer, in the record',
    Array.isArray(r.unanswerable) && r.unanswerable.length === 3, JSON.stringify(r.unanswerable).slice(0, 80));
  emit();
}

/* ── C. it works on every shipped package ─────────────────────────────────── */
async function sectionC() {
  heading('C. a record can be taken from every incident in the build');

  const rows = [];
  for (const id of INCIDENTS) {
    const pack = await loadContent({ incident: id });
    const g = new Game(pack, { seed: 'per-incident' });
    g.commitLoadout(RECOMMENDED_MANIFEST);
    g.skipMs(4000);
    const r = sessionRecord(g, { build: 'c' });
    rows.push(`${id}:${r.events.length}`);
    ok(`C-${id} produces a record naming its own incident, anomaly and map`,
      r.incident === id && r.anomaly === pack.anomaly.id && r.map === pack.map.id,
      `${r.incident}/${r.anomaly}/${r.map}`);
  }
  note(`events at four seconds, per incident: ${rows.join(' ')}`);

  /* ⚠ AND IT IS NOT A REPORTER. The build contacts exactly one network host — the signalling
   * broker — and `assets/lib/NOTICE.md` says so. A telemetry endpoint would make that false,
   * so this file may not contain one. Checked by reading it. */
  const src = await (await fetch('/src/sim/telemetry.js')).text();
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok('C1 telemetry.js contains no fetch, no XHR, no beacon and no WebSocket',
    !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|navigator\.connection/.test(code));
  ok('C2 and no hostname at all, so the one-network-host claim in NOTICE.md stays true',
    !/https?:\/\/|\.com|\.org|\.net\b/.test(code));
  emit();
}

/* ── run ──────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    const content = await loadContent();
    await run('A', () => sectionA(content));
    await run('B', () => sectionB(content));
    await run('C', () => sectionC());
    emit();
  } catch (e) {
    lines.push(`FAIL  the telemetry suite itself threw: ${e && e.stack ? e.stack : e}`);
    counts.fails++;
    emit();
  }
})();
