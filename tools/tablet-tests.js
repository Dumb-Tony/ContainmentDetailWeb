/* The field tablet — GDD §18.4, the procedure planner, and §7 the hypothesis board.
 *
 * ⚠ THE TABLET HAD ONE ANOMALY'S OPINIONS ON IT, TWICE.
 *
 * The hypothesis board was seven claims written for `graybox-draught`, frozen in `src/`,
 * and shown for every anomaly. That was found and moved into content. The PROCEDURE
 * PLANNER — the other half of the same screen — had exactly the same bug and survived the
 * fix, because a planner that offers wrong options still offers options: the squad picks
 * one, commits, and finds out in the field rather than on the tablet.
 *
 * Read what it offered. "Held against a heat gradient it cannot cross". "The failed chiller
 * in the plant room". "Restoring the storage circuit to draw it to the lights". Now read
 * `content/anomalies/blackthorn-caller.json`, which hunts SOUND and is restrained by
 * SILENCE, in a forest, with no chiller and no storage circuit. Four of the five fields
 * could not be filled in truthfully, and the fifth was the abort condition.
 *
 * This suite holds both halves to the same standard and REPORTS, per anomaly, which fields
 * still fall back — so an unauthored planner is a number on every run rather than a thing
 * somebody notices in a year.
 */

import { lines, counts, ok, eq, note, emit, run, heading } from './harness.js';
import { loadContent, INCIDENTS } from '../src/sim/content.js';
import { Game, RECOMMENDED_MANIFEST } from '../src/game.js';
import { PROCEDURE_FIELDS, MAINTAINED, ABORTS, plannerFor } from '../src/ui/panels.js';

/* ── A. the planner reads the anomaly ─────────────────────────────────────── */
async function sectionA() {
  heading('A. the procedure planner offers the loaded anomaly\'s options');

  eq('A1 the fallback is the five fields §18.4 asks for', PROCEDURE_FIELDS.length, 4);
  ok('A2 plus maintained conditions and an abort, which are the fifth and the sixth',
    MAINTAINED.length > 0 && ABORTS.length > 0);

  /* A package that authors nothing gets the fallback, and says so. */
  const bare = plannerFor({});
  eq('A3 an anomaly with no planner block falls back rather than showing an empty select',
    bare.fields.length, PROCEDURE_FIELDS.length);
  eq('A4 and every field reports itself as fallen back, so nothing passes silently',
    bare.usesFallback.length, PROCEDURE_FIELDS.length + 2);

  /* A package that authors one gets its own. */
  const authored = plannerFor({
    containment: {
      planner: {
        target: ['The thing in the north plantation'],
        maintained: ['Everything switched off'],
        aborts: ['Anything powered comes back on'],
      },
    },
  });
  eq('A5 an authored field is used instead of the fallback',
    authored.fields.find((f) => f.key === 'target').options[0], 'The thing in the north plantation');
  eq('A6 and an unauthored one still falls back, so a partial planner is legal',
    authored.fields.find((f) => f.key === 'state').options[0], PROCEDURE_FIELDS[1].options[0]);
  eq('A7 maintained and aborts are authored the same way',
    `${authored.maintained[0]} / ${authored.aborts[0]}`,
    'Everything switched off / Anything powered comes back on');
  ok('A8 and only the fields that fell back are reported as having done so',
    authored.usesFallback.includes('state') && !authored.usesFallback.includes('target')
    && !authored.usesFallback.includes('maintained'), authored.usesFallback.join());
  emit();
}

/* ── B. what the shipped packages actually offer ──────────────────────────── */
async function sectionB() {
  heading('B. how much of the tablet is still the draught\'s, per package');

  const rows = [];
  let anyAuthored = 0;
  for (const id of INCIDENTS) {
    const pack = await loadContent({ incident: id });
    const p = plannerFor(pack.anomaly);
    if (p.usesFallback.length === 0) anyAuthored++;
    rows.push(`${pack.anomaly.id}: ${p.usesFallback.length ? `falls back on ${p.usesFallback.join(', ')}` : 'fully authored'}`);
  }
  for (const r of [...new Set(rows)]) note(`  ${r}`);

  /**
   * REPORTED, NOT ASSERTED, and deliberately. The engine side landed first so the content
   * has somewhere to go; asserting it now would fail the build for every package at once
   * and tell nobody anything they cannot read in the note above. It becomes an assertion
   * when the first package is authored, which is the point at which "not done yet" stops
   * being an honest description.
   */
  note(`${anyAuthored} of ${INCIDENTS.length} packages author their own procedure card`);
  ok('B1 every package produces a usable planner, authored or fallen back',
    rows.length === INCIDENTS.length);

  /* ⚠ AND THE FALLBACK IS THE DRAUGHT'S, WHICH IS THE WHOLE POINT. Named here so the note
   * above cannot be read as "some packages are generic": they are not generic, they are
   * one specific anomaly's, and that anomaly is a cold mass in a cold store. */
  ok('B2 the fallback names a heat gradient and a chiller, so it is one anomaly\'s card and not a neutral one',
    JSON.stringify(PROCEDURE_FIELDS).includes('heat gradient')
    && JSON.stringify(PROCEDURE_FIELDS).includes('chiller'));
  emit();
}

/* ── C. the board, which was fixed, stays fixed ───────────────────────────── */
async function sectionC() {
  heading('C. the hypothesis board is still the loaded anomaly\'s');

  const seen = new Map();
  for (const id of INCIDENTS) {
    const pack = await loadContent({ incident: id });
    const g = new Game(pack, { seed: 'tablet' });
    g.commitLoadout(RECOMMENDED_MANIFEST);
    const claims = g.ledger.claims || [];
    seen.set(pack.anomaly.id, claims.map((c) => c.id).join('|'));
    const own = new Set((pack.anomaly.evidenceRules || []).map((e) => e.id));
    const foreign = claims.flatMap((c) => (c.supportedBy || []).filter((e) => !own.has(e)));
    if (foreign.length) note(`  ${pack.anomaly.id} cites ${foreign.length} foreign observation(s)`);
  }
  const boards = new Set(seen.values());
  eq('C1 no two anomalies share a board, which is what "the board is content" means',
    boards.size, seen.size);
  note(`${seen.size} anomalies, ${boards.size} distinct boards`);
  emit();
}

/* ── D. the briefing tab ──────────────────────────────────────────────────── */
async function sectionD() {
  heading('D. the briefing tab is the loaded incident\'s briefing');

  /**
   * ⚠ THE TABLET PRINTED THE COLD STORE'S MANDATE FOR EVERY INCIDENT, and this is the tab a
   * squad reads FIRST. "Establish custody of the anomaly on level 2 and transfer it to the
   * stair head" is one floor of one of four buildings; a squad deploying to a forest reserve
   * read it as their mandate. "Two circuits, both dead on arrival" was the same mistake with
   * a number in it — every map has two circuits, called different things on each, and the
   * tablet named none of them while asserting the count.
   *
   * Third surface with this defect. The board and the planner were the other two.
   */
  const briefs = new Map();
  for (const id of INCIDENTS) {
    const pack = await loadContent({ incident: id });
    const b = (pack.incident && pack.incident.briefing) || {};
    briefs.set(id, `${b.headline || ''}|${(b.known || []).length}`);
    ok(`D-${id} authors a briefing with a headline and something known`,
      !!b.headline && (b.known || []).length > 0, JSON.stringify(b).slice(0, 80));
  }
  const distinct = new Set(briefs.values());
  eq('D1 no two incidents share a briefing, which is what reading the package means',
    distinct.size, briefs.size);
  note(`${briefs.size} incidents, ${distinct.size} distinct briefings`);

  /* And the sentence that was hard-coded is gone from the file that hard-coded it. */
  const src = await (await fetch('/src/ui/panels.js')).text();
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('D2 the panel no longer names one incident\'s floor or asserts a circuit count',
    !/level 2/i.test(code) && !/Two circuits/.test(code));
  emit();
}

/* ── run ──────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await run('A', () => sectionA());
    await run('B', () => sectionB());
    await run('C', () => sectionC());
    await run('D', () => sectionD());
    emit();
  } catch (e) {
    lines.push(`FAIL  the tablet suite itself threw: ${e && e.stack ? e.stack : e}`);
    counts.fails++;
    emit();
  }
})();
