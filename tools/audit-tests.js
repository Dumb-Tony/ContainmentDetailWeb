/* Milestone 6 — the crash boundary, the save, the licence, and the lists that grow.
 *
 * Four things the rest of the suite does not cover, because none of them is a rule:
 *
 *   A  what the page does when the game throws — GDD §18.1 does not allow the UI to
 *      misrepresent state, and a game that throws once per frame and keeps painting is the
 *      purest available violation of that
 *   B  what happens to a profile written by an older build, a truncated one, and one
 *      somebody edited. A profile is the only thing in this build a player can lose
 *   C  §25's licensing claims, checked by hashing the vendored files rather than by
 *      believing `assets/lib/NOTICE.md`
 *   D  the caps `tools/soak.ps1` relies on, asserted here so a regression fails in twelve
 *      seconds rather than in a thirty-minute soak
 *   E  that every word `mission.grade()` can emit has a row in the economy's yield table.
 *      This one found two live bugs the day it was written — see section E.
 *
 * Run it with:
 *   powershell -ExecutionPolicy Bypass -File tools/smoketest.ps1 -Tests tools/audit-tests.js -Port 8491
 */

import { lines, counts, ok, eq, near, note, emit, run, heading, suite } from './harness.js';

import {
  CrashBoundary, crashSignature, normaliseFrame, stackFrames, incidentRef, messageOf,
  buildId, deploymentOf, CRASH_LIMITS,
} from '../src/core/crash.js';

import {
  migrate, migrateWithReport, defaultProfile, PROGRESSION_VERSION, CEILINGS, MIGRATIONS,
  SAVE_KEY, QUARANTINE_KEY, loadProfileWithReport, saveProfile, storage,
  Progression, loadSite, reconcileProfile, DIMENSION_YIELD, DIMENSION_KEY_BY_ID,
  dimWordId, dimWord, minutesFrom, clearanceFor, STARTING_REQUISITION,
} from '../src/sim/progression.js';

import { loadContent, INCIDENTS } from '../src/sim/content.js';
import { Game, RECOMMENDED_MANIFEST } from '../src/game.js';
import { EventBus } from '../src/core/eventBus.js';
import { PHRASES } from '../src/sim/comms.js';

const url = (p) => new URL(`../${p}`, import.meta.url).href;
const fetchText = async (p) => {
  const r = await fetch(url(p), { cache: 'no-store' });
  return r.ok ? r.text() : '';
};

/* ══ A. the crash boundary ═════════════════════════════════════════════════════
 *
 * ⚠ WHAT WAS THERE BEFORE, AND WHY IT WAS NOT ENOUGH.
 *
 * `main.js` had eleven lines: keep the first message, tally the rest, paint it into
 * `#err-banner`. Every word of that is reasonable and none of it addresses the actual
 * failure, which is structural and lives in the first line of the loop:
 *
 *     function frame(now) { requestAnimationFrame(frame); … }
 *
 * The next frame is booked before anything can throw, so a throw does not stop the loop —
 * it repeats it, sixty times a second, forever. A throw before `renderer.render()` freezes
 * the canvas on its last good frame and the game looks hung. A throw AFTER it — in
 * `hud.update()`, `drawCaptions()` or the audio mix — leaves the world animating while
 * every number on the HUD stops, which is the one the player cannot detect. They read
 * "CUSTODY 00:12" off a display that stopped twenty seconds ago and act on it.
 *
 * The boundary's job is therefore not to report better. It is to DECIDE, and the decision
 * is that a game which cannot keep its promises stops.
 */
function sectionA() {
  heading('A. the crash boundary — one banner per bug, and a decision');

  /* A real detached Document, not a hand-rolled fake: `textContent`, `querySelector` and
   * element identity all behave exactly as they do on the page, so a test that passes here
   * is a test about the shipped code rather than about the mock. */
  const mkDoc = () => {
    const d = document.implementation.createHTMLDocument('crash');
    const b = d.createElement('div');
    b.id = 'err-banner';
    d.body.appendChild(b);
    return d;
  };
  const mkWin = () => {
    const listeners = [];
    return {
      listeners,
      navigator: {},
      location: { href: 'http://x/index.html?incident=cold-storage-tally&scenario=n7', reload() { this.reloaded = true; } },
      addEventListener: (t, fn, cap) => listeners.push([t, fn, !!cap]),
      removeEventListener: (t, fn) => { const i = listeners.findIndex((l) => l[1] === fn); if (i >= 0) listeners.splice(i, 1); },
      requestAnimationFrame: (cb) => { listeners.push(['raf', cb]); return listeners.length; },
    };
  };
  let clock = 1000;
  const mk = (over = {}) => new CrashBoundary({
    doc: mkDoc(), win: mkWin(), loc: mkWin().location,
    now: () => clock, build: 'testbuild',
    ...over,
  });

  /* ── stacks and signatures ── */
  eq('A1 a stack frame loses the origin, so the same bug on two ports is one bug',
    normaliseFrame('    at Game.step (http://127.0.0.1:8491/src/game.js:812:19)'),
    'Game.step (src/game.js:812:19)');
  eq('A2 and loses a GitHub Pages sub-path too, so local and published agree',
    normaliseFrame('    at Game.step (https://dumb-tony.github.io/ContainmentDetailWeb/src/game.js:812:19)'),
    'Game.step (src/game.js:812:19)');
  eq('A3 but keeps the line and column, which are what identify the site',
    normaliseFrame('    at f (http://h/src/a.js:9:4)').endsWith('a.js:9:4)'), true);

  const err = () => { const e = new Error('boom'); e.stack = 'Error: boom\n    at Game.step (http://a/src/game.js:1:1)\n    at frame (http://a/src/main.js:2:2)'; return e; };
  eq('A4 a Chrome stack reads as frames, and the message line is not one of them',
    stackFrames(err()).length, 2);
  eq('A5 a Firefox stack reads too',
    stackFrames({ stack: 'step@http://a/src/game.js:1:1\nframe@http://a/src/main.js:2:2' }).length, 2);

  /**
   * ⚠ THE MESSAGE IS NOT THE IDENTITY. `Player p4 is not on the roster` and `Player p2 is
   * not on the roster` are one bug thrown twice; keying on the message makes them two, and
   * a per-frame throw whose message embeds `simTimeMs` becomes ten thousand distinct
   * "bugs" and ten thousand banner rewrites. The stack is the identity.
   */
  const a = err(); a.message = 'Player p4 is not on the roster';
  const b = err(); b.message = 'Player p2 is not on the roster';
  eq('A6 two throws from one site with different messages have one signature',
    crashSignature(a), crashSignature(b));
  const c = err(); c.stack = 'Error: boom\n    at Anomaly.step (http://a/src/sim/anomaly.js:5:5)';
  ok('A7 and two throws with the same message from different sites do not',
    crashSignature(a) !== crashSignature(c));
  ok('A8 an error and a rejection from the same line are still told apart',
    crashSignature(a, 'error') !== crashSignature(a, 'rejection'));
  ok('A9 a thrown string with no stack still gets a signature rather than throwing',
    crashSignature('just a string').length > 0);
  eq('A10 and a thrown object is serialised rather than read as [object Object]',
    messageOf({ code: 7 }), '{"code":7}');

  eq('A11 the incident reference is stable for a signature, so two reports of one bug match',
    incidentRef(crashSignature(a)), incidentRef(crashSignature(b)));
  ok('A12 and differs between bugs', incidentRef(crashSignature(a)) !== incidentRef(crashSignature(c)));
  ok('A13 the reference is short enough for a player to read out', incidentRef('x').length <= 10);

  /* ── counting and deduplication ── */
  const cb = mk();
  for (let i = 0; i < 10000; i++) { clock += 16; cb.report(err(), 'error'); }
  eq('A14 ten thousand throws from one site produce ONE record, not ten thousand', cb.records.size, 1);
  eq('A15 and every one of them is counted', Array.from(cb.records.values())[0].count, 10000);
  note(`banner text after 10,000 identical throws: ${cb.text().split('\n').length} lines`);
  ok('A16 the banner stays a readable size under a per-frame throw', cb.text().split('\n').length < 25);

  /**
   * ⚠ THE OLD BANNER KEPT THE FIRST ERROR AND COUNTED THE REST, WHICH HIDES THE SECOND KIND.
   * If A happens once and B throws every frame, the banner shows A forever and "(+59,999
   * further errors)" — and B, the one that is actually running, is never named. Both are
   * reported now, first-seen first.
   */
  cb.report(c, 'error');
  eq('A17 a second kind of error gets its own record rather than a tally', cb.records.size, 2);
  ok('A18 and both appear in the report, the first one first',
    cb.summary().indexOf('Player p4') < cb.summary().indexOf('boom'),
    cb.summary().slice(0, 120));

  /* ── the decision ── */
  clock = 0;
  const halting = mk();
  halting.report(err(), 'error');
  ok('A19 one error does not stop the game — a resize race is not a reason to quit', !halting.halted);
  clock = 16; halting.report(err(), 'error');
  ok('A20 nor does a second', !halting.halted);
  clock = 33; halting.report(err(), 'error');
  ok('A21 the third identical throw stops it, because that is a loop and not a hiccup', halting.halted);
  note(`halted after ${halting.total} throws in ${halting.haltedBecause}`);
  eq('A22 and the loop is stopped inside the first tenth of a second, not after thirty of them',
    halting.records.values().next().value.lastAtMs <= 100, true);

  clock = 0;
  const distinct = mk();
  for (let i = 0; i < CRASH_LIMITS.totalLimit; i++) {
    const e = err(); e.stack = `Error: e${i}\n    at f${i} (http://a/src/x.js:${i}:1)`;
    distinct.report(e, 'error');
  }
  ok('A23 thirty DIFFERENT errors also stop it — a page producing thirty is not producing a playable thirty-first',
    distinct.halted);
  ok('A24 and the record list is capped, so an error storm cannot grow the page reporting it',
    distinct.records.size <= CRASH_LIMITS.maxRecords, `${distinct.records.size}`);
  ok('A25 while the total still counts every one of them',
    distinct.total === CRASH_LIMITS.totalLimit, `${distinct.total}`);
  ok('A26 and the report says how many it did not keep the detail of',
    /further error/.test(distinct.summary()), distinct.summary().slice(-140));

  /**
   * ⚠ A MISSING IMAGE IS NOT A REASON TO STOP A CONTAINMENT. Failed resource loads arrive
   * on the same `error` event with `e.target` set and no `e.error`. They are reported and
   * never halt, because `boot()` already refuses in its own words when the things that
   * matter — three.js, the content — do not load.
   */
  clock = 0;
  const res = mk();
  for (let i = 0; i < 50; i++) res.reportResource({ tagName: 'IMG', src: 'http://a/x.png' });
  ok('A27 fifty failed asset loads do not stop the game', !res.halted);
  eq('A28 and identical ones are recorded once', res.resourceFailures.length, 1);
  ok('A29 with the path, so somebody can go and look for it', /x\.png/.test(res.summary()));

  /* ── what the report says ── */
  clock = 500;
  const full = mk({ deployment: { incident: 'cold-storage-tally', scenario: 'n7', seed: 's1', href: '/index.html?incident=cold-storage-tally' } });
  full.report(err(), 'error');
  const s = full.summary();
  ok('A30 the report names the build', /build testbuild/.test(s), s.split('\n')[0]);
  ok('A31 and which incident the player was on', /incident cold-storage-tally/.test(s));
  ok('A32 and the exact URL, so the operation can be re-run', /index\.html\?incident=/.test(s));
  ok('A33 and an incident reference to quote', /\[CD-[0-9A-Z]{7}\]/.test(s), s);
  ok('A34 and the stack, repo-relative', /at Game\.step \(src\/game\.js/.test(s));

  const banner = full.paint();
  ok('A35 the banner is painted into #err-banner, reusing the styling index.html ships',
    banner && banner.id === 'err-banner');
  ok('A36 it is marked as an alert for a screen reader', banner.getAttribute('role') === 'alert');
  ok('A37 and carries the halted state as an attribute a test or a tool can read',
    banner.getAttribute('data-cd-halted') === '0' && banner.getAttribute('data-cd-errors') === '1');
  ok('A38 the running banner does not claim the game has stopped',
    !/has stopped/.test(banner.textContent), banner.textContent.slice(0, 80));
  full.halt('by hand');
  const halted = full.paint();
  ok('A39 and once it halts, the first line says so in a sentence a player can act on',
    /has stopped/.test(halted.textContent));
  ok('A40 telling them what to do about it', /Reload/.test(halted.textContent));
  ok('A41 and what is safe — §12.6 says no run is a total loss, so the player is told which part survived',
    /earned in previous operations is saved/.test(halted.textContent));
  ok('A42 redundant across shape as well as colour, per §18.1',
    halted.style.borderBottom.length > 0, halted.style.borderBottom);
  eq('A43 with a Reload and a Copy control rather than a wall of text',
    halted.querySelectorAll('button').length, 2);

  /**
   * ⚠ EVERY STRING GOES IN THROUGH textContent. The one place in this build guaranteed to
   * be handed hostile text is the thing that reports hostile text: an error message can
   * contain a callsign somebody typed. There is no innerHTML in crash.js and there must
   * not be one.
   */
  clock = 0;
  const nasty = mk();
  const x = new Error('<img src=x onerror="window.__pwned=1">');
  x.stack = 'Error: x\n    at f (http://a/src/x.js:1:1)';
  nasty.report(x, 'error');
  const nb = nasty.paint();
  eq('A44 an error message that is markup is rendered as text, not as markup',
    nb.querySelectorAll('img').length, 0);
  ok('A45 and the characters survive, so the developer can still read what was thrown',
    nb.textContent.includes('<img src=x'));

  /**
   * ⚠ AN EXCEPTION INSIDE AN ERROR HANDLER IS REPORTED TO window.onerror TOO, so a boundary
   * that throws while painting recurses until the stack ends and the last thing the page
   * does is die of its own crash reporter. Re-entry is a no-op.
   */
  clock = 0;
  const reentrant = mk();
  const orig = reentrant.paint.bind(reentrant);
  let depth = 0, maxDepth = 0;
  reentrant.paint = function reenter() {
    depth++; maxDepth = Math.max(maxDepth, depth);
    if (depth < 4) reentrant.report(err(), 'error');   // the handler throws into itself
    const r = orig();
    depth--;
    return r;
  };
  reentrant.report(err(), 'error');
  eq('A46 a boundary that re-enters itself does not recurse', maxDepth, 1);

  clock = 0;
  const broken = mk();
  broken.doc = { getElementById: () => { throw new Error('no DOM'); }, body: {}, createElement: () => { throw new Error('no DOM'); } };
  broken.report(err(), 'error');
  ok('A47 and a boundary whose own DOM is gone records the error rather than throwing',
    broken.total === 1);

  /* ── the wiring ── */
  const w = mkWin();
  const attached = new CrashBoundary({ doc: mkDoc(), win: w, loc: w.location, now: () => clock, build: 'b' });
  attached.attach({ haltFrameLoop: true });
  ok('A48 it listens for error in the CAPTURE phase, because a failed <script> does not bubble',
    w.listeners.some((l) => l[0] === 'error' && l[2] === true));
  ok('A49 and for unhandled rejections, which is how an async content load fails',
    w.listeners.some((l) => l[0] === 'unhandledrejection'));

  /**
   * ⚠ THIS IS HOW THE LOOP ACTUALLY STOPS. `frame()` books the next frame on its FIRST
   * line, so by the time anything throws the next one is already scheduled and no edit
   * inside the body can prevent it. The boundary wraps `requestAnimationFrame` at install
   * time and refuses new requests once halted, so the self-rescheduling loop runs once more
   * and then stops — with no change to `frame()` at all.
   */
  const before = w.requestAnimationFrame(() => {});
  ok('A50 requestAnimationFrame still works while the game is healthy', before !== 0);
  attached.halt('test');
  eq('A51 and returns 0 once halted, which is what stops a loop that reschedules itself', w.requestAnimationFrame(() => {}), 0);
  attached.restore();
  ok('A52 restore() puts the real requestAnimationFrame back, so the suite can undo it',
    w.requestAnimationFrame(() => {}) !== 0);

  eq('A53 the deployment is read off the URL the boot reads, so the report names the right operation',
    deploymentOf({ href: 'http://x/?incident=blackthorn-caller&seed=q' }).incident, 'blackthorn-caller');
  eq('A54 and defaults to the same incident main.js defaults to',
    deploymentOf({ href: 'http://x/' }).incident, 'cold-storage-draught');

  /**
   * ⚠ THERE IS NO BUILD STEP HERE — push IS the deploy — so the commit is not knowable
   * from inside the page unless the page is told. When nothing tells it, this says
   * `unstamped` rather than inventing a plausible number. A crash report naming the wrong
   * commit is worse than one admitting it does not know which.
   */
  const noMeta = document.implementation.createHTMLDocument('x');
  ok('A55 with no build stamp the report admits it rather than guessing',
    /^unstamped/.test(buildId(noMeta)), buildId(noMeta));
  const withMeta = document.implementation.createHTMLDocument('x');
  const meta = withMeta.createElement('meta');
  meta.setAttribute('name', 'cd-build'); meta.setAttribute('content', 'bedb3ca');
  withMeta.head.appendChild(meta);
  eq('A56 and reads the commit off <meta name="cd-build"> when index.html carries one',
    buildId(withMeta), 'bedb3ca');
  const placeholder = document.implementation.createHTMLDocument('x');
  const m2 = placeholder.createElement('meta');
  m2.setAttribute('name', 'cd-build'); m2.setAttribute('content', '$Format:%h$');
  placeholder.head.appendChild(m2);
  ok('A57 an unexpanded git placeholder is not mistaken for a commit',
    /^unstamped/.test(buildId(placeholder)), buildId(placeholder));

  note(`this page's build id: ${buildId(document)}`);
  emit();
}

/* ══ B. the save ═══════════════════════════════════════════════════════════════
 *
 * ⚠ A PROFILE IS THE ONLY THING IN THIS BUILD A PLAYER CAN LOSE, AND LOSING IT WAS SILENT.
 * `migrate` began
 *
 *     if (!data || typeof data !== 'object') return defaultProfile();
 *     if (data.version !== PROGRESSION_VERSION) return defaultProfile();
 *
 * so every save not written by this exact build was discarded whole, with no message, and
 * the first autosave then wrote over the evidence. `git log -p src/sim/progression.js` has
 * three commits and the shape changed in all three while the version stayed at 1, which is
 * the other half of the problem: the number carried no information, so there was nothing to
 * migrate FROM even if migrating had been attempted.
 */
async function sectionB() {
  heading('B. the save — every shape a profile can arrive in');

  eq('B1 the schema version has moved past 1, because three different shapes all claimed to be 1',
    PROGRESSION_VERSION >= 2, true);
  ok('B2 and there is an upgrade step for every version below the current one',
    MIGRATIONS.length >= PROGRESSION_VERSION - 1, `${MIGRATIONS.length} steps`);

  /* ── the shapes this file has actually had ────────────────────────────────
   * Reconstructed from the file's own history. All three wrote `version: 1`. */
  const v1_original = {
    version: 1, siteId: 'regional-site-19', operationsCompleted: 7, custodiesVerified: 2,
    requisition: 910, research: 220, researchTotalEarned: 460, requisitionTotalEarned: 1500,
    clearance: 2, standing: { research: 22, medical: -3 }, knowledge: { 'graybox-draught': { observations: 14, rulesRead: 5 } },
    upgrades: [], fitted: {}, siteUpgrades: [],
    roster: [{ id: 'p1', name: 'Vasquez', operations: 7, condition: null, commendations: ['steady'] }],
    /* 05c3f7d: containment entries had no cellId, cellRequirement or improvised */
    containment: [{ anomalyId: 'graybox-draught', designation: 'GB-04 (provisional)', custody: 'verified', sinceOperation: 3, lastCheckedOperation: 6, history: ['Operation 3: custody verified.'], maintenance: [] }],
    /* 05c3f7d: history rows had no scenario */
    history: [{ operation: 6, mapId: 'cold-storage-l2', anomalyId: 'graybox-draught', overall: 'Controlled', requisition: 210, research: 60 }],
  };
  const v1_withScenario = JSON.parse(JSON.stringify(v1_original));
  /* ea2ca74 */
  v1_withScenario.history[0].scenario = { seed: 'n3', weather: 'Steady rain', time: 'Night', faulted: ['c2'], shut: [] };
  const v1_withCell = JSON.parse(JSON.stringify(v1_withScenario));
  /* 2054db5 */
  v1_withCell.containment[0].cellId = 'cell-1';
  v1_withCell.containment[0].cellRequirement = 'thermal';
  v1_withCell.containment[0].improvised = true;

  for (const [name, shape] of [['05c3f7d original', v1_original], ['ea2ca74 + scenario', v1_withScenario], ['2054db5 + cell rating', v1_withCell]]) {
    const { profile, report } = migrateWithReport(shape);
    ok(`B3 a save in the ${name} shape survives — 7 operations and 910 requisition are still there`,
      profile.operationsCompleted === 7 && profile.requisition === 910,
      `ops ${profile.operationsCompleted}, req ${profile.requisition}`);
    eq(`B4 its containment entry survives the ${name} shape`, profile.containment.length, 1);
    ok(`B5 and the player is told the ${name} save was brought forward, rather than finding a blank campaign`,
      report.notices.some((n) => /older build/.test(n)), report.notices.join(' | '));
  }
  note(`v1 → v${PROGRESSION_VERSION}: outcome "${migrateWithReport(v1_original).report.outcome}"`);

  /**
   * ⚠ THE FIELDS 2054db5 ADDED WERE NOT IN THE SANITISER, ONE COMMIT AFTER THE COMMENT
   * WARNING ABOUT EXACTLY THAT. `cellRequirement` and `improvised` were written into the
   * entry by `_recordCapture` and dropped by `sanitiseContainment`, so `src/ui/base.js`
   * printed "— improvised" and "nothing rated thermal" for as long as the tab stayed open
   * and stopped the moment it was reloaded. §18.1 does not allow the UI to misrepresent
   * state, and a screen that tells the truth until you reload is the worst version of that.
   */
  const kept = migrate(v1_withCell);
  eq('B6 a capture placed in a cell it is not rated for is STILL improvised after a save', kept.containment[0].improvised, true);
  eq('B7 and still remembers what rating it needed', kept.containment[0].cellRequirement, 'thermal');
  const twice = migrate(JSON.parse(JSON.stringify(kept)));
  eq('B8 and after a second round-trip, because one round-trip proves nothing about the second',
    twice.containment[0].improvised, true);

  /* ── hostile and damaged ─────────────────────────────────────────────────── */
  const hostile = [
    ['null (a first run)', null, (p, r) => p.requisition === STARTING_REQUISITION && r.notices.length === 0],
    ['an array', [1, 2, 3], (p, r) => p.roster.length === 1 && r.outcome === 'repaired'],
    ['a string', 'not a profile', (p, r) => r.outcome === 'repaired'],
    ['version 99, from a newer build', { version: 99, requisition: 5000 }, (p, r) => r.outcome === 'refused' && p.requisition === STARTING_REQUISITION],
    ['no version at all', { requisition: 500, operationsCompleted: 3 }, (p) => p.requisition === 500 && p.operationsCompleted === 3],
    ['negative requisition', { version: PROGRESSION_VERSION, requisition: -500 }, (p) => p.requisition === 0],
    ['requisition 1e999 (Infinity)', JSON.parse('{"version":2,"requisition":1e999}'), (p) => Number.isFinite(p.requisition) && p.requisition === 0],
    ['requisition as an object', { version: PROGRESSION_VERSION, requisition: {} }, (p) => p.requisition === 0],
    ['clearance 1e9', { version: PROGRESSION_VERSION, clearance: 1e9 }, (p) => p.clearance === 0],
    ['operationsCompleted 1e9', { version: PROGRESSION_VERSION, operationsCompleted: 1e9 }, (p) => p.operationsCompleted <= CEILINGS.operations],
    ['standing at 1e9', { version: PROGRESSION_VERSION, standing: { research: 1e9 } }, (p) => p.standing.research === 100],
    ['a department that does not exist', { version: PROGRESSION_VERSION, standing: { xenobiology: 40 } }, (p) => p.standing.xenobiology === undefined],
    ['roster with two of one id', { version: PROGRESSION_VERSION, roster: [{ id: 'p1', name: 'A' }, { id: 'p1', name: 'B' }] }, (p) => p.roster.length === 1],
    ['roster as a string', { version: PROGRESSION_VERSION, roster: 'nope' }, (p) => p.roster.length === 1],
    ['an injury this build does not ship', { version: PROGRESSION_VERSION, roster: [{ id: 'p1', condition: { id: 'lycanthropy', operationsRemaining: 4 } }] }, (p) => p.roster[0].condition === null],
    ['an upgrade this build does not ship', { version: PROGRESSION_VERSION, upgrades: ['plasma-rifle'] }, (p) => p.upgrades.length === 0],
    ['one upgrade listed five hundred times', { version: PROGRESSION_VERSION, upgrades: new Array(500).fill('plasma-rifle') }, (p) => p.upgrades.length === 0],
    ['a scanner fitted to a trauma kit', { version: PROGRESSION_VERSION, fitted: { 'trauma-kit': 'imager-wide' } }, (p) => Object.keys(p.fitted).length === 0],
    ['a containment entry naming an anomaly that no longer ships', { version: PROGRESSION_VERSION, containment: [{ anomalyId: 'scp-9999', designation: 'X' }] }, (p) => p.containment.length === 1],
    ['two containment entries for one anomaly', { version: PROGRESSION_VERSION, containment: [{ anomalyId: 'a' }, { anomalyId: 'a' }] }, (p) => p.containment.length === 1],
    ['a containment history of ten thousand lines', { version: PROGRESSION_VERSION, containment: [{ anomalyId: 'a', history: new Array(10000).fill('x') }] }, (p) => p.containment[0].history.length === 8],
    ['a history of two hundred thousand operations', { version: PROGRESSION_VERSION, history: new Array(200000).fill(0).map((_, i) => ({ operation: i, overall: 'Costly' })) }, (p) => p.history.length === CEILINGS.historyEntries],
    ['knowledge of five thousand anomalies', { version: PROGRESSION_VERSION, knowledge: Object.fromEntries(new Array(5000).fill(0).map((_, i) => [`a${i}`, { observations: 1 }])) }, (p) => Object.keys(p.knowledge).length === CEILINGS.knowledgeEntries],
    ['knowledge with a __proto__ key', JSON.parse('{"version":2,"knowledge":{"__proto__":{"observations":9},"real":{"observations":3}}}'), (p) => p.knowledge.real && p.knowledge.real.observations === 3],
    ['a site upgrade nothing declares', { version: PROGRESSION_VERSION, siteUpgrades: ['warp-core'] }, (p) => p.siteUpgrades.length === 1],
    ['every field of the wrong type at once', { version: PROGRESSION_VERSION, siteId: 5, requisition: [], research: 'lots', standing: 7, knowledge: [], upgrades: {}, fitted: [], siteUpgrades: 3, roster: {}, containment: 'x', history: 9 }, (p) => p.roster.length === 1 && p.requisition === 0],
  ];

  let survived = 0;
  for (const [name, data, check] of hostile) {
    let profile = null, report = null, threw = null;
    try { ({ profile, report } = migrateWithReport(data)); } catch (e) { threw = e; }
    if (threw) { ok(`B9 ${name} degrades to a playable profile rather than throwing`, false, String(threw)); continue; }
    survived++;
    /* Every one of these must be PLAYABLE, not merely non-throwing: the base screen reads
     * roster[0], the economy reads requisition, and clearance gates the rooms. */
    const playable = profile && profile.roster.length >= 1 && Number.isFinite(profile.requisition)
      && profile.requisition >= 0 && Number.isFinite(profile.clearance) && Array.isArray(profile.history)
      && Array.isArray(profile.containment) && profile.knowledge && typeof profile.knowledge === 'object';
    ok(`B9 ${name} → a playable profile`, !!playable, JSON.stringify(profile && { req: profile.requisition, roster: profile.roster.length }));
    ok(`B10 ${name} → and the specific thing that should have happened, did`, !!check(profile, report),
      JSON.stringify({ req: profile.requisition, ops: profile.operationsCompleted, cont: profile.containment.length, cl: profile.clearance }));
    /* Silent is the failure mode this section exists to prevent. */
    if (data !== null) {
      ok(`B11 ${name} → and it was not silent`, report.dropped.length > 0 || report.notices.length > 0,
        `${report.dropped.length} dropped, ${report.notices.length} notices`);
    }
  }
  note(`${survived} of ${hostile.length} hostile profiles survived migration`);

  /**
   * ⚠ AND THE PROFILE HAS TO SURVIVE BEING SAVED AND READ BACK. `JSON.stringify(Infinity)`
   * is `null`, so a value that got through as Infinity would come back as 0 — infinite
   * requisition for one session and a wiped balance the next, which is worse than either.
   */
  const inf = migrate(JSON.parse('{"version":2,"requisition":1e999,"research":1e999}'));
  const roundTripped = migrate(JSON.parse(JSON.stringify(inf)));
  eq('B12 nothing survives a save as Infinity, because nothing gets that far', roundTripped.requisition, inf.requisition);

  /* ── clearance is derived, never claimed ─────────────────────────────────── */
  const liar = migrate({ version: PROGRESSION_VERSION, clearance: 3, operationsCompleted: 0, custodiesVerified: 0, researchTotalEarned: 0 });
  eq('B13 a save claiming Level 3 with nothing behind it gets Provisional', liar.clearance, 0);
  const earned = migrate({ version: PROGRESSION_VERSION, clearance: 0, operationsCompleted: 9, custodiesVerified: 4, researchTotalEarned: 900 });
  eq('B14 and a save claiming Level 0 with the record for Level 3 gets Level 3', earned.clearance, 3);
  eq('B15 clearanceFor and the migration agree', earned.clearance, clearanceFor(earned));

  /* ── what the site knows and migrate cannot ──────────────────────────────── */
  const site = await loadSite();
  const cellIds = ((site.containmentWing && site.containmentWing.cells) || []).map((c) => c.id);
  ok('B16 the site declares holding positions to reconcile against', cellIds.length > 0, cellIds.join());

  /**
   * ⚠ A DANGLING cellId MAKES A CAPTURE VANISH FROM THE ONE SCREEN THAT EXISTS TO SHOW IT.
   * `src/ui/base.js:_containment` walks the site's CELLS and looks each one up in the
   * profile, then appends the entries whose `cellId` is null as "unplaced". An entry naming
   * a cell that no longer exists matches NEITHER pass and renders nowhere — which is exactly
   * the §18.1 defect commit 2054db5 fixed for `cellId: null`, arriving through another door.
   */
  const dangling = migrate({
    version: PROGRESSION_VERSION,
    containment: [{ anomalyId: 'graybox-draught', designation: 'GB-04 (provisional)', cellId: 'cell-does-not-exist', custody: 'verified' }],
  });
  const rep = { outcome: 'loaded', fromVersion: 2, toVersion: 2, dropped: [], notices: [], preservedAs: null };
  reconcileProfile(dangling, { site, report: rep });
  eq('B17 an entry naming a holding position this site does not have becomes unplaced, so it stays visible',
    dangling.containment[0].cellId, null);
  ok('B18 and the player is told a position was lost rather than a capture', rep.notices.length > 0, rep.notices.join(' | '));

  const stillReal = migrate({ version: PROGRESSION_VERSION, containment: [{ anomalyId: 'graybox-draught', cellId: cellIds[0] }] });
  reconcileProfile(stillReal, { site });
  eq('B19 while a real holding position is left exactly where it was', stillReal.containment[0].cellId, cellIds[0]);

  const overflow = migrate({ version: PROGRESSION_VERSION, containment: [{ anomalyId: 'x', cellId: 'overflow-2' }] });
  reconcileProfile(overflow, { site });
  eq('B20 and a requisitioned overflow position is recognised rather than thrown away', overflow.containment[0].cellId, 'overflow-2');

  const gone = migrate({ version: PROGRESSION_VERSION, containment: [{ anomalyId: 'scp-9999', designation: 'Something' }] });
  const rep2 = { outcome: 'loaded', fromVersion: 2, toVersion: 2, dropped: [], notices: [], preservedAs: null };
  reconcileProfile(gone, { site, report: rep2 });
  eq('B21 an anomaly this build no longer ships is KEPT — a build dropping a dossier does not empty its cell',
    gone.containment.length, 1);
  eq('B22 and flagged, so the corridor can say what it is looking at', gone.containment[0].unknownAnomaly, true);

  const fakeUpgrade = migrate({ version: PROGRESSION_VERSION, siteUpgrades: ['warp-core'] });
  const rep3 = { outcome: 'loaded', fromVersion: 2, toVersion: 2, dropped: [], notices: [], preservedAs: null };
  reconcileProfile(fakeUpgrade, { site, report: rep3 });
  eq('B23 a site upgrade this build does not declare is removed, because it was granting nothing',
    fakeUpgrade.siteUpgrades.length, 0);
  ok('B24 and said so', rep3.notices.length > 0);

  /**
   * ⚠ AN UNREADABLE SAVE MUST NOT BE OVERWRITTEN BY THE ACT OF NOTICING IT IS BROKEN. The
   * old path returned a fresh profile from a parse failure and the first autosave wrote
   * over the damaged text, destroying a save a later build or a person with a text editor
   * could have salvaged.
   *
   * The real localStorage is used, and both keys are put back afterwards — a suite that
   * eats somebody's campaign to test that campaigns are not eaten would be quite something.
   */
  const s = storage();
  if (!s) {
    note('localStorage unavailable in this context — quarantine assertions skipped');
  } else {
    const savedProfile = s.getItem(SAVE_KEY);
    const savedQuarantine = s.getItem(QUARANTINE_KEY);
    try {
      s.removeItem(QUARANTINE_KEY);
      s.setItem(SAVE_KEY, '{"version":2,"requisition":700,"operationsCo');   // truncated
      const out = loadProfileWithReport();
      eq('B25 a truncated save loads as a fresh profile rather than as an exception', out.profile.requisition, STARTING_REQUISITION);
      eq('B26 and the damaged original is kept rather than deleted', s.getItem(QUARANTINE_KEY), '{"version":2,"requisition":700,"operationsCo');
      ok('B27 and the player is told the profile was damaged', out.report.notices.some((n) => /damaged/.test(n)), out.report.notices.join(' | '));

      s.removeItem(QUARANTINE_KEY);
      s.setItem(SAVE_KEY, JSON.stringify({ version: 999, requisition: 50000, operationsCompleted: 400 }));
      const future = loadProfileWithReport();
      eq('B28 a save from a NEWER build is not imported, because this build cannot know what its fields mean', future.report.outcome, 'refused');
      ok('B29 nor is it destroyed — it is copied aside so the newer build still has it',
        (s.getItem(QUARANTINE_KEY) || '').includes('"version":999'));
      ok('B30 and the player is told which build wrote it and what to do',
        future.report.notices.some((n) => /newer build/.test(n)), future.report.notices.join(' | '));
    } finally {
      if (savedProfile === null) s.removeItem(SAVE_KEY); else s.setItem(SAVE_KEY, savedProfile);
      if (savedQuarantine === null) s.removeItem(QUARANTINE_KEY); else s.setItem(QUARANTINE_KEY, savedQuarantine);
    }
    ok('B31 and the suite put the real profile back', s.getItem(SAVE_KEY) === savedProfile);
  }

  /* The report itself must not be written into the save — a report about the report,
   * growing by one layer every time the game is opened. */
  const pr = new Progression({ profile: v1_original, site, autosave: false });
  ok('B32 a Progression carries the migration report, so the base screen has something to print', !!pr.migration);
  ok('B33 the report names the version it came from and what it did', pr.migration.fromVersion === 1 && pr.migration.outcome === 'upgraded',
    `${pr.migration.outcome} from v${pr.migration.fromVersion}`);
  note(`v1 profile → ${pr.migration.outcome}: ${pr.migration.notices.length} player notice(s), ${pr.migration.dropped.length} dropped field(s)`);
  if (s) {
    const savedProfile = s.getItem(SAVE_KEY);
    try {
      /* Attached on purpose: this is the mistake the strip in `saveProfile` exists to stop,
       * and asserting against a profile that never had one would prove nothing. */
      saveProfile({ ...pr.profile, migration: pr.migration });
      const written = JSON.parse(s.getItem(SAVE_KEY));
      ok('B34 and a saved profile does not contain it, even when a caller attaches one', written.migration === undefined);
      eq('B35 while everything else was written', written.operationsCompleted, 7);
    } finally {
      if (savedProfile === null) s.removeItem(SAVE_KEY); else s.setItem(SAVE_KEY, savedProfile);
    }
  }
  emit();
}

/* ══ C. the licence claims, hashed ═════════════════════════════════════════════
 *
 * `tools/licence-audit.ps1` is the full audit and it walks the whole tree. This is the part
 * a browser can do, and it is worth doing HERE as well because the suite runs on every
 * change and nobody runs a PowerShell script on every change. Section K of m0-tests checks
 * the network rule over the module graph; hashes are what catch a vendored library edited
 * in place, and nothing checked them at all.
 */
async function sectionC() {
  heading('C. §25 — the licence claims, checked rather than believed');

  const notice = await fetchText('assets/lib/NOTICE.md');
  ok('C1 assets/lib/NOTICE.md exists and is reachable', notice.length > 0);
  const block = notice.match(/```audit\s*([\s\S]*?)```/);
  ok('C2 and carries a machine-readable audit block, so its claims can be checked rather than read', !!block);
  if (!block) { emit(); return; }

  const rows = block[1].split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const c = l.split(/\s*\|\s*/);
    return { path: c[0], licence: c[1], version: c[2], bytes: Number(c[3]), sha: (c[4] || '').toLowerCase(), modified: c[5] };
  });
  eq('C3 every row has six columns', rows.filter((r) => r.path && r.licence && r.version && r.sha).length, rows.length);
  note(`NOTICE.md declares ${rows.length} vendored file(s): ${rows.map((r) => r.path).join(', ')}`);

  for (const r of rows) {
    const res = await fetch(url(`assets/lib/${r.path}`), { cache: 'no-store' });
    ok(`C4 ${r.path} is where NOTICE.md says it is`, res.ok, `HTTP ${res.status}`);
    if (!res.ok) continue;
    const buf = await res.arrayBuffer();
    eq(`C5 ${r.path} is exactly the ${r.bytes} bytes NOTICE.md claims`, buf.byteLength, r.bytes);

    /**
     * ⚠ THE DIGEST IS THE ONLY CHECK THAT CATCHES A VENDORED LIBRARY EDITED IN PLACE. A
     * byte count catches a truncation and nothing else: a one-character change to a minified
     * file — a URL, a constant, a `Math.random` — keeps the length and changes everything.
     * NOTICE.md says "Modified: no" for both of these and this is what makes that a fact.
     */
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    eq(`C6 ${r.path} hashes to what NOTICE.md recorded — it has not been modified`, hex, r.sha);

    /* A directory called r128 proves nothing. The version has to be in the file. */
    const text = new TextDecoder().decode(buf);
    ok(`C7 ${r.path} contains the version string "${r.version}" NOTICE.md claims`, text.includes(`"${r.version}"`));
    ok(`C8 ${r.path} declares a licence`, !!r.licence && r.licence !== 'unknown', r.licence);
    eq(`C9 ${r.path} is recorded as unmodified, which C6 has just verified`, r.modified, 'no');
  }

  /**
   * ⚠ K6 CANNOT SEE assets/lib/**. It reads a hard-coded list of source files, so the
   * vendored library that actually dials the broker is not on it. Two shipped files name a
   * host, not one, and saying "exactly one" would be true of the list and false of the
   * build.
   */
  const netjs = await fetchText('src/net/net.js');
  ok('C10 src/net/net.js names the signalling broker', /0\.peerjs\.com/.test(netjs));
  const peer = await fetchText('assets/lib/peerjs-1.5.4/peerjs.min.js');
  ok('C11 and so does the vendored library that dials it — two shipped files, not one', /0\.peerjs\.com/.test(peer));

  /**
   * ⚠ A NAMESPACE URI IS NOT AN ENDPOINT. three.min.js contains
   * `document.createElementNS("http://www.w3.org/1999/xhtml", "canvas")` four times. It is
   * a name, not an address; nothing dereferences it. Counted rather than ignored, so the
   * exemption stays visible and a real host appearing beside it would still be caught.
   */
  const three = await fetchText('assets/lib/r128/three.min.js');
  const threeHosts = new Set((three.match(/https?:\/\/([a-z0-9.-]+)/gi) || []).map((h) => h.replace(/^https?:\/\//i, '')));
  note(`hosts named inside three.min.js: ${[...threeHosts].join(', ') || 'none'}`);
  eq('C12 three.js names exactly one host and it is the XHTML namespace, which is a name and not an address',
    [...threeHosts].join(','), 'www.w3.org');
  eq('C13 and every occurrence of it is a createElementNS call rather than a request',
    (three.match(/www\.w3\.org/g) || []).length,
    (three.match(/createElementNS\("http:\/\/www\.w3\.org/g) || []).length);

  /* ── §25.3 and §25.6, over the content ── */
  const anomalyFiles = ['blackthorn-caller', 'coldharbour-passenger', 'graybox-draught', 'ninety-one-tally', 'pinfold-lodger', 'stillwater-figure'];
  let withRecord = 0, explained = 0; const bare = [];
  for (const a of anomalyFiles) {
    const raw = await fetchText(`content/anomalies/${a}.json`);
    if (!raw) continue;
    const doc = JSON.parse(raw);
    if (doc.licensingRecordId) withRecord++;
    else if (doc._licensingNote) explained++;
    else bare.push(a);
  }
  note(`anomalies: ${withRecord} with a licensing record, ${explained} original and say so, ${bare.length} silent`);
  /**
   * ⚠ A BARE null AND A MISSING FIELD ARE INDISTINGUISHABLE, and that is the whole problem.
   * `null` can mean "we checked, it is original, here is why" or "nobody has looked at this
   * one" — and §25.3 makes the record a prerequisite for implementation, so the difference
   * is the difference between clearing the gate and not. Four of the six resolve it in one
   * sentence. See docs/licensing-audit.md, findings 1 and 2.
   */
  eq(`C14 every anomaly says where it came from${bare.length
    ? ` — ${bare.join(', ')} carry a bare null. FIX: add the "_licensingNote" line the other four already carry,`
      + ' verbatim, next to "licensingRecordId". One line per file. See docs/licensing-audit.md findings 1-2'
    : ''}`, bare.length, 0);

  const site = await fetchText('content/site.json');
  const designations = (site.match(/"designation"\s*:\s*"([^"]*)"/g) || []).map((m) => m.split('"')[3]);
  note(`designations in site.json: ${designations.join(', ')}`);
  eq('C15 every designation is marked provisional, because §25.3 assigns a final one only after a record exists',
    designations.filter((d) => /provisional/i.test(d)).length, designations.length);

  let scpStrings = 0;
  for (const p of ['content/site.json', ...anomalyFiles.map((a) => `content/anomalies/${a}.json`)]) {
    scpStrings += ((await fetchText(p)).match(/\bSCP[\s-]?\d{2,4}\b/gi) || []).length;
  }
  eq('C16 no content file claims an SCP designation, in a build whose every licensing record is null', scpStrings, 0);

  /* ── §23 Milestone 5, the part that is not netcode: nothing leaves ────────────
   *
   * ⚠ A CRASH REPORTER IS THE MOST NATURAL PLACE IN A CODEBASE TO ADD AN EXFILTRATION PATH,
   * and it is the one place nobody looks, because everybody agrees crash reports are
   * useful. `assets/lib/NOTICE.md` claims this build reaches exactly one host; a crash
   * boundary that posted a stack somewhere would make that claim false, and the stack it
   * posted would contain whatever the player typed. So it is asserted, by name, over the
   * one file most likely to grow the habit.
   */
  const crashSrc = await fetchText('src/core/crash.js');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const crashCode = strip(crashSrc);
  ok('C17 the crash boundary makes no request of any kind — it is not a reporter, it is a banner',
    !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+Image\s*\(/.test(crashCode));
  ok('C18 and builds its banner with textContent, never innerHTML — the one thing guaranteed to be handed hostile text',
    !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(crashCode));

  const uiFiles = ['src/ui/hud.js', 'src/ui/panels.js', 'src/ui/base.js', 'src/ui/settings.js', 'src/ui/commswheel.js'];
  const beacons = [];
  for (const f of [...uiFiles, 'src/game.js', 'src/sim/progression.js', 'src/core/i18n.js']) {
    const t = strip(await fetchText(f));
    if (/sendBeacon|new\s+WebSocket|\bfetch\s*\(\s*['"`]https?:/.test(t)) beacons.push(f);
  }
  eq(`C19 nothing outside src/net sends anything anywhere${beacons.length ? ` — ${beacons.join(', ')}` : ''}`, beacons.length, 0);

  /**
   * ⚠ §21.2 FORBIDS FREE TEXT IN THE DURABLE LOG, and the only free text in this game is a
   * callsign somebody typed. `NOTICE` carries prose written for a player — "Vasquez is
   * down. Somebody get to them." — so it is dispatched to the audio cue and the HUD and
   * kept out of `bus.log` by `unlogged`. That registration is one line in game.js and
   * deleting it would put player-typed names into a durable record with nothing failing.
   */
  const gameSrc = strip(await fetchText('src/game.js'));
  ok('C20 the NOTICE event is registered as unlogged, so player-typed names never reach the durable log',
    /unlogged\.add\(EVENTS\.NOTICE\)/.test(gameSrc));
  const probe = new Game(await loadContent({ incident: 'cold-storage-draught' }), { seed: 'privacy' });
  probe.notice('Vasquez is down. Somebody get to them.');
  eq('C21 and a notice really does not appear in it', probe.bus.log.filter((e) => e.type === 'NOTICE').length, 0);
  ok('C22 while still reaching the listeners that have to show it', probe.notices.length === 1);
  emit();
}

/* ══ D. the lists that grow ════════════════════════════════════════════════════
 *
 * ⚠ A LEAK IN THIS BUILD LOOKS LIKE A LIST NOBODY PRUNES, and there is precedent: the comms
 * board grew a row per call for a whole operation because `encode()` sent `this.list` raw
 * and nothing expired it, so every snapshot carried every call the squad had ever made.
 *
 * `tools/soak.ps1` measures growth over thirty simulated minutes and is the real instrument.
 * These are the same caps asserted directly, so a regression fails in twelve seconds rather
 * than in half an hour — and so that the soak's `knownCaps` table cannot drift away from
 * what the code does.
 */
async function sectionD() {
  heading('D. the caps the soak relies on');

  const pack = await loadContent({ incident: 'cold-storage-draught' });
  const game = new Game(pack, { seed: 'audit-growth' });
  game.commitLoadout(RECOMMENDED_MANIFEST);
  for (let i = 1; i < 5; i++) game.addPlayer(`Op ${i + 1}`);

  for (let i = 0; i < 5000; i++) game.notice(`squad line ${i}`);
  eq('D1 the squad notice feed is bounded — five thousand lines leave forty', game.notices.length, 40);
  for (let i = 0; i < 5000; i++) game.noticeLocal(`refusal ${i}`);
  eq('D2 and the private feed at twenty', game.localNotices.length, 20);

  const bus = new EventBus({ logSize: 256 });
  for (let i = 0; i < 100000; i++) bus.emit('NOTICE', { i }, i);
  eq('D3 the event bus log is a ring — a hundred thousand events leave 256', bus.log.length, 256);
  eq('D4 and it still knows how many it saw', bus.emitted, 100000);

  /**
   * ⚠ THIS IS THE ONE THAT SHIPPED BROKEN. The board caps per operative and EVICTS rather
   * than refusing, so five operatives calling for an hour leave fifteen rows and not three
   * thousand — and `encode()` sends what the board holds, so the wire is bounded by the
   * same number. Asserted through `encode()` and not through `list`, because `list` was
   * never the thing that was wrong.
   */
  /* ⚠ Through the BOARD, not through `game.ping`. `requestPing` runs the world checks
   * first — "you cannot see that from here" — so most calls from a bot standing at spawn
   * are refused, and a board that stays at three because the calls never landed proves
   * nothing about the cap. `evidence` is the one phrase declared `unique: false`, so it is
   * also the only one that can stack and therefore the only one that can test eviction. */
  eq('D5 the evidence call is the one phrase that may be repeated, so it is the one that tests the cap',
    PHRASES.evidence.unique, false);
  let t = 0;
  for (let i = 0; i < 3000; i++) {
    t += 800;
    const p = game.players[i % game.players.length];
    game.comms.add(p.id, 'evidence', { x: p.x + i * 0.01, z: p.z, atMs: t });
  }
  const cap = game.comms.maxPerPlayer * game.players.length;
  eq('D6 three thousand squad calls leave exactly three per operative — the cap EVICTS, it does not refuse',
    game.comms.list.length, cap);
  eq('D7 and the WIRE carries exactly what the board holds, which is the bug that shipped',
    game.comms.encode().length, game.comms.list.length);
  note(`after 3,000 calls from ${game.players.length} operatives: board ${game.comms.list.length}, wire rows ${game.comms.encode().length}, cap ${cap}`);
  eq('D8 and it is the OLDEST that goes, so an operative is never punished for their newest call',
    game.comms.list[game.comms.list.length - 1].id, 3000);
  ok('D9 the rate-limiter map is keyed by operative, so it is bounded by the roster',
    game.comms._lastAt.size <= game.players.length, `${game.comms._lastAt.size}`);

  ok('D10 the ice patch list is capped at forty in the code that appends to it',
    /icePatches\.length > 40/.test(await fetchText('src/sim/anomaly.js')));

  /**
   * ⚠ AND THIS ONE IS NOT CAPPED, DELIBERATELY OR OTHERWISE. `anomaly.transitions` is
   * commented "append-only, for the debrief" and `src/ui/panels.js` renders every row of it
   * on the debrief screen. It is bounded in practice by how often a state machine can
   * change state, which is a content question rather than a code one — so this measures it
   * rather than asserting a number, and `tools/soak.ps1` watches it over thirty minutes.
   */
  const src = await fetchText('src/sim/anomaly.js');
  ok('D11 the transition log has no cap in the code — recorded as a measurement, not a complaint',
    !/transitions\.length\s*>\s*\d+/.test(src));
  /* Measured by `tools/soak.ps1` over thirty simulated minutes rather than here, because the
   * rate depends entirely on how often a given anomaly's state machine changes state and
   * this game has not been stepped. Blackthorn's caller ran at +0.40/minute and the
   * Coldharbour passenger at +0.30, which is about eighteen rows over a long session —
   * unbounded in principle and small in practice. `src/ui/panels.js` renders all of them. */
  note('anomaly.transitions is append-only; the soak measures the rate per incident');

  const snap = JSON.stringify((await import('../src/net/protocol.js')).encodeSnapshot(game));
  note(`snapshot size with ${game.players.length} operatives and a full board: ${snap.length} bytes`);
  ok('D12 a snapshot stays under 8 kB with a full squad and a full comms board',
    snap.length < 8192, `${snap.length} bytes`);
  emit();
}

/* ══ E. the debrief contract ═══════════════════════════════════════════════════
 *
 * ⚠ THIS SECTION FOUND TWO LIVE BUGS THE DAY IT WAS WRITTEN, and both were the same shape:
 * `mission.grade()` emits a word and `DIMENSION_YIELD` in progression.js looks it up, and
 * the two lists had drifted apart with nothing checking.
 *
 *   · `containmentintegrity.partial` did not exist. `grade()` reports `partial` AHEAD of
 *     everything else, so a distributed set sealed on an incomplete count graded Partial
 *     even with custody verified — and the highest-value dimension in the game paid zero
 *     requisition, zero research and zero standing for it.
 *   · `researchcompletion` had a row called `minimal` and `grade()` says `thin`, so the
 *     bottom tier of research completion paid nothing and `minimal` was unreachable.
 *
 * Neither threw, neither logged, and both look exactly like a design decision from the
 * outside: the operation simply pays less than you expected. The lookup is `if (!y)
 * continue`, which is the right behaviour for an unknown word and the reason a missing row
 * is invisible.
 */
async function sectionE() {
  heading('E. every word the debrief can say has a row in the table that pays for it');

  const mission = await fetchText('src/sim/mission.js');
  const code = mission.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  /* Every `add('<id>', …)` call, and the quoted words in its second argument — which is
   * either a literal word id or a ternary over several of them. Read out of the source, so
   * a new word added next month is checked the day it appears. */
  const emitted = new Map();
  const re = /add\(\s*'([a-z]+)'\s*,([\s\S]{0,260}?)(?:msg\(|plural\(|\n\s*\))/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const id = m[1];
    /* ⚠ A TERNARY CONDITION IS NOT A WORD ID, and the first version of this read
     * `custody === 'verified' ? 'established' : …` as emitting a word called `verified`
     * and reported two false positives against a table that was correct. Strip the
     * right-hand side of every string comparison before harvesting the literals; what is
     * left is the word slots. */
    const slots = m[2].replace(/[=!]==?\s*'[^']*'/g, '');
    const words = (slots.match(/'([A-Za-z][A-Za-z0-9]*)'/g) || []).map((w) => w.slice(1, -1));
    if (!emitted.has(id)) emitted.set(id, new Set());
    for (const w of words) emitted.get(id).add(w);
  }
  ok('E1 the grader\'s dimensions were readable out of mission.js', emitted.size >= 9, `${emitted.size} found`);
  note(`dimensions: ${[...emitted.keys()].join(', ')}`);

  const wordKey = (w) => String(w == null ? '' : w).toLowerCase().replace(/[^a-z0-9]/g, '');
  const unpaid = [];
  let checked = 0;
  for (const [id, words] of emitted) {
    const key = DIMENSION_KEY_BY_ID[id];
    ok(`E2 the dimension id "${id}" maps to a row in the yield table`, !!key, `no mapping for ${id}`);
    if (!key) continue;
    /* Time reports a measurement rather than a verdict and is handled separately. */
    if (key === 'timetostabilisation') continue;
    const table = DIMENSION_YIELD[key];
    ok(`E3 ${key} has a yield table`, !!table);
    if (!table) continue;
    for (const w of words) {
      checked++;
      if (!table[wordKey(w)]) unpaid.push(`${id}.${w} (table key ${key} has: ${Object.keys(table).join(', ')})`);
    }
  }
  note(`${checked} word ids checked against ${Object.keys(DIMENSION_YIELD).length} yield tables`);
  eq(`E4 every word the debrief can say is paid for${unpaid.length ? ` — ${unpaid.join(' ; ')}` : ''}`, unpaid.length, 0);

  /* ── the readers ── */
  const result = {
    overall: 'Controlled',
    dims: [
      { id: 'containment', wordId: 'established', name: 'Eindämmungsintegrität', word: 'Hergestellt', why: '' },
      { id: 'personnel', wordId: 'injured', name: 'Personalüberleben', word: 'Verletzt', why: '' },
      { id: 'time', wordId: 'minutes', name: 'Zeit', word: '12,4 min', value: 12.4, why: '' },
    ],
  };
  /**
   * ⚠ EVERY READER IN progression.js LOOKED A DIMENSION UP BY ITS ENGLISH DISPLAY NAME AND
   * COMPARED THE ANSWER TO AN ENGLISH DISPLAY WORD. `dimWord(result, 'Containment
   * integrity') === 'Established'` decided whether the site recorded a capture AT ALL, so
   * the first non-English locale would have stopped the containment corridor filling —
   * silently, with every assertion in the suite still green because the suite runs in
   * English. The dimensions above are deliberately German.
   */
  eq('E5 a dimension is found by its untranslated id, not by its display name', dimWordId(result, 'containment'), 'established');
  eq('E6 and the personnel word too', dimWordId(result, 'personnel'), 'injured');
  eq('E7 while the display word is still available for printing', dimWord(result, 'containment'), 'Hergestellt');
  /**
   * ⚠ AND minutesFrom PARSED DIGITS OUT OF A DISPLAY STRING. `"12.4 min"` with the
   * non-digits stripped is 12.4; `"12,4 min"` is 124. A nine-minute operation would have
   * been filed as taking an hour and a half.
   */
  eq('E8 the time dimension reads its number, not the digits in its label', minutesFrom(result), 12.4);
  eq('E9 and a decimal comma does not turn 12.4 minutes into 124',
    minutesFrom({ dims: [{ id: 'time', word: '12,4 min', value: 12.4 }] }), 12.4);
  eq('E10 while an old stored result with no value still parses, because the regex survives as a fallback',
    minutesFrom({ dims: [{ name: 'Time to stabilisation', word: '12.4 min' }] }), 12.4);
  eq('E11 a result with no time dimension reads null rather than NaN', minutesFrom({ dims: [] }), null);
  eq('E12 and an English result still reads the same as it always did',
    dimWordId({ dims: [{ name: 'Containment integrity', word: 'Established' }] }, 'Containment integrity'), 'established');
  emit();
}

/* ══ F. the §25.8 content lock, from inside a browser ══════════════════════════
 *
 * ⚠ THIS IS NOT A SECOND COPY OF tools/licence-audit.ps1, AND THE DIFFERENCE IS THE POINT.
 * The script walks the TREE — it is the only thing that can say "every file is accounted
 * for", because it can enumerate a directory. It cannot say whether a browser can read
 * them, and that is not a theoretical gap: PowerShell's ConvertFrom-Json accepts a raw
 * newline inside a JSON string and `JSON.parse` does not, so three content files in this
 * repository once passed a PowerShell check and were invalid in the browser that had to
 * load them. Only a browser parse counts, and this is the browser parse.
 *
 * So this section asserts the two halves the script structurally cannot:
 *
 *   · every content file the game can reach PARSES with JSON.parse, and declares its
 *     provenance in one of the three permitted shapes
 *   · the licence text really is beside the code and really is the MIT text, fetched over
 *     http exactly as a player's browser would fetch it
 *
 * The file list is DERIVED rather than typed: the incidents come from the loader's own
 * INCIDENTS export, and the maps and anomalies come from what those incidents name. Adding
 * an incident therefore extends this section automatically, which is the only version of a
 * hard-coded list worth having.
 */
async function sectionF() {
  heading('F. §25.8 content lock — every content file, parsed by a browser');

  const manifestRaw = await fetchText('content/provenance.json');
  ok('F1 content/provenance.json is served and reachable', manifestRaw.length > 0);
  let manifest = null;
  try { manifest = JSON.parse(manifestRaw); } catch (e) { ok('F2 and a BROWSER can parse it', false, String(e && e.message)); }
  if (!manifest) { emit(); return; }
  ok('F2 and a BROWSER can parse it', true);

  /* ── §25.3's twelve fields, in the file rather than in a paragraph ────────── */
  const FIELDS = [
    'designationAndArticleTitle', 'articleUrl', 'authorsAndAttributionSource', 'wikiBranch',
    'pageRevisionOrAccessDate', 'conceptsTextCharactersOrProceduresAdapted', 'changesMadeForTheGame',
    'requiredLicenceAndNotice', 'associatedAssetsAndTheirIndependentSources', 'internalContentOwner',
    'legalReviewStatus', 'inGameAndDistributionCreditLocation',
  ];
  const db = manifest.attributionDatabase || {};
  const dbFields = db.fields || [];
  eq('F3 the §25.3 attribution database names all twelve required fields', FIELDS.filter((f) => dbFields.includes(f)).length, FIELDS.length);
  eq('F4 and names no field §25.3 does not', dbFields.filter((f) => !FIELDS.includes(f)).length, 0);

  /* ── §25.8's gate ─────────────────────────────────────────────────────────── */
  const clauses = manifest.gate ? (manifest.gate.clauses || []) : [];
  eq('F5 §25.8 states seven clauses and seven are answered — a gate that quietly lost one would still pass', clauses.length, 7);
  eq('F6 every clause records a reason, because §25.8\'s last clause is that the status be RECORDED',
    clauses.filter((c) => c.clause && c.status && c.recorded).length, clauses.length);
  const open = clauses.filter((c) => c.status === 'open');
  eq(`F7 no clause is open${open.length ? ` — ${open.map((c) => c.clause).join(' · ')}` : ''}`, open.length, 0);
  note(`§25.8 gate: ${clauses.map((c) => c.status).join(', ')}`);

  /* ── the file list, derived ───────────────────────────────────────────────── */
  const covered = new Set((manifest.coverage || []).map((c) => c.path));
  const incidentDocs = [];
  for (const id of INCIDENTS) {
    const raw = await fetchText(`content/incidents/${id}.json`);
    ok(`F8 content/incidents/${id}.json is served`, raw.length > 0);
    try { incidentDocs.push({ path: `content/incidents/${id}.json`, doc: JSON.parse(raw) }); } catch (e) {
      ok(`F9 and a BROWSER can parse content/incidents/${id}.json`, false, String(e && e.message));
    }
  }
  const maps = new Set(incidentDocs.map((d) => d.doc.map).filter(Boolean));
  const anomalies = new Set(incidentDocs.map((d) => d.doc.anomaly).filter(Boolean));
  note(`derived from ${INCIDENTS.length} incidents: ${maps.size} map(s), ${anomalies.size} anomaly file(s)`);

  const paths = [
    'content/site.json', 'content/onboarding.json', 'content/provenance.json', 'content/equipment/items.json',
    ...[...maps].sort().map((m) => `content/maps/${m}.json`),
    ...[...anomalies].sort().map((a) => `content/anomalies/${a}.json`),
    ...incidentDocs.map((d) => d.path),
    ...covered,
  ];

  /**
   * ⚠ THREE SHAPES ARE ACCOUNTED FOR AND A FOURTH IS NOT, and the fourth is the whole
   * reason the field exists. A non-null record, or a null that says WHY in a sentence, or
   * coverage from the manifest for a file that cannot carry the declaration inline — those
   * are provenance. A bare `null` is not: it is indistinguishable from a field somebody
   * forgot, and §25.3 makes the record a prerequisite for implementation, so the difference
   * between those two readings is the difference between clearing the gate and not.
   */
  let withRecord = 0, explained = 0, byManifest = 0;
  const bare = [], unparseable = [], absent = [];
  for (const p of paths) {
    const raw = await fetchText(p);
    if (!raw) { unparseable.push(`${p} (not served)`); continue; }
    let doc = null;
    try { doc = JSON.parse(raw); } catch (e) { unparseable.push(`${p} (${e && e.message})`); continue; }
    const has = Object.prototype.hasOwnProperty.call(doc, 'licensingRecordId');
    if (has && doc.licensingRecordId !== null) withRecord++;
    else if (has && doc._licensingNote) explained++;
    else if (covered.has(p)) byManifest++;
    else if (has) bare.push(p);
    else absent.push(p);
  }
  eq(`F10 every content file the game can reach parses in a BROWSER${unparseable.length ? ` — ${unparseable.join(' · ')}` : ''}`,
    unparseable.length, 0);
  eq(`F11 none carries a bare null — a null that does not say why is a field somebody forgot${bare.length ? ` — ${bare.join(', ')}` : ''}`,
    bare.length, 0);
  eq(`F12 and none is silent about where its material came from${absent.length ? ` — ${absent.join(', ')}` : ''}`,
    absent.length, 0);
  note(`${paths.length} content files: ${withRecord} with a record, ${explained} original and say so, ${byManifest} covered by the manifest`);

  /* Coverage entries must not go stale: a file that has since grown an inline declaration
   * is stated in two places, and two statements of provenance is one more than can be kept
   * true. The manifest is for files that CANNOT carry it, not a second place to put it. */
  const redundant = [];
  for (const p of covered) {
    const raw = await fetchText(p);
    if (raw && /"licensingRecordId"/.test(raw)) redundant.push(p);
  }
  eq(`F13 no manifest coverage entry duplicates an inline declaration${redundant.length ? ` — ${redundant.join(', ')}` : ''}`, redundant.length, 0);

  /* Every non-null record must have a row. There are none of either today, and the
   * assertion is what makes the first one impossible to ship without twelve fields. */
  const rows = new Map((db.records || []).map((r) => [r.recordId, r]));
  const orphans = [];
  for (const p of paths) {
    const raw = await fetchText(p);
    if (!raw) continue;
    let doc = null; try { doc = JSON.parse(raw); } catch { continue; }
    if (doc.licensingRecordId && !rows.has(doc.licensingRecordId)) orphans.push(`${p} → ${doc.licensingRecordId}`);
  }
  eq(`F14 every licensing record claimed by a content file has a row in the §25.3 database${orphans.length ? ` — ${orphans.join(', ')}` : ''}`,
    orphans.length, 0);

  /* ── the licence text is where the code is ────────────────────────────────── */
  const notice = await fetchText('assets/lib/NOTICE.md');
  const block = notice.match(/```audit\s*([\s\S]*?)```/);
  const rowsN = block ? block[1].split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const c = l.split(/\s*\|\s*/);
    return { path: c[0], licence: c[1], version: c[2], copyright: c[6] };
  }) : [];
  eq('F15 every NOTICE.md row carries the seventh column, the copyright line', rowsN.filter((r) => r.copyright).length, rowsN.length);

  const MIT_GRANT = 'Permission is hereby granted, free of charge, to any person obtaining a copy';
  const MIT_INCLUDE = 'The above copyright notice and this permission notice shall be included in all';
  const MIT_ASIS = 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND';

  for (const r of rowsN) {
    const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '';
    const licPath = `assets/lib/${dir ? `${dir}/` : ''}LICENSE`;
    const lic = await fetchText(licPath);
    /**
     * ⚠ MIT IS NOT SATISFIED BY A TABLE. It requires the copyright notice and the permission
     * notice to accompany the software, and what this project distributes is the .js file
     * next to this LICENSE. A row in NOTICE.md is a RECORD of the licence, not a copy of
     * it, and the audit found exactly this gap: neither library shipped its licence text.
     */
    ok(`F16 ${licPath} is served — MIT requires the notice to travel with the code`, lic.length > 0);
    if (!lic) continue;
    ok(`F17 ${licPath} carries the MIT grant, the inclusion clause and the warranty disclaimer`,
      lic.includes(MIT_GRANT) && lic.includes(MIT_INCLUDE) && lic.includes(MIT_ASIS));

    const lib = await fetchText(`assets/lib/${r.path}`);
    const copyCount = (lib.match(/copyright/gi) || []).length;
    if (r.copyright === 'none-in-vendored-file') {
      /**
       * ⚠ THE RECORDED GAP IS ITSELF CHECKED, because "we could not find a copyright line"
       * is a claim like any other and a claim nobody re-measures is a claim that quietly
       * stops being true. An attribution audit that fabricates an attribution is worse than
       * one that reports a gap: the gap is a known unknown somebody can close, and the
       * fabrication is a false statement with a green tick beside it.
       */
      eq(`F18 ${r.path} really does carry no copyright notice, which is why none was invented for it`, copyCount, 0);
      ok(`F19 and ${licPath} says so in as many words rather than filling in a plausible name`,
        /UNKNOWN/.test(lic));
      note(`${r.path}: copyright UNKNOWN and recorded as such — ${lib.length} bytes, 0 occurrences of "copyright"`);
    } else {
      ok(`F20 ${r.path} contains verbatim the copyright line NOTICE.md claims — an attribution the software does not carry is one somebody wrote`,
        lib.includes(r.copyright), r.copyright);
      ok(`F21 and so does ${licPath}`, lic.includes(r.copyright));
    }
  }

  /* ── §25.4: the notice a player can actually reach ────────────────────────── */
  const site = JSON.parse(await fetchText('content/site.json'));
  const docs = (site.notices && site.notices.documents) || [];
  const want = ['credits', 'attribution', 'privacy', 'eula', 'support'];
  eq(`F22 §23 Milestone 6's five documents are content the game can render${docs.length ? '' : ' — content/site.json has no notices block'}`,
    want.filter((w) => docs.some((d) => d.id === w)).length, want.length);
  const thin = docs.filter((d) => !d.title || !d.summary || !(d.sections || []).length);
  eq(`F23 each has a title, a summary and at least one section${thin.length ? ` — ${thin.map((d) => d.id).join(', ')}` : ''}`, thin.length, 0);
  const badSection = [];
  for (const d of docs) {
    for (const s of d.sections || []) {
      const body = s.body || [], bullets = s.bullets || [];
      if (!s.heading || (!body.length && !bullets.length)) badSection.push(`${d.id}/${s.heading || '(no heading)'}`);
      if (body.some((b) => typeof b !== 'string') || bullets.some((b) => typeof b !== 'string')) badSection.push(`${d.id}: non-string body`);
    }
  }
  eq(`F24 every section is a heading over plain-text paragraphs or bullets${badSection.length ? ` — ${badSection.join(', ')}` : ''}`, badSection.length, 0);
  /**
   * ⚠ THESE DOCUMENTS MUST NOT CONTAIN MARKUP. Whatever renders them is expected to escape,
   * and a privacy statement that arrives with a stray tag in it is either broken text or a
   * hole, depending on where the text came from.
   */
  const markup = [];
  for (const d of docs) {
    const all = [d.title, d.summary, ...(d.sections || []).flatMap((s) => [s.heading, ...(s.body || []), ...(s.bullets || [])])];
    if (all.some((t) => /<[a-z/!]/i.test(String(t)))) markup.push(d.id);
  }
  eq(`F25 and carries no markup, because the screen escapes and a tag would be either broken text or a hole${markup.length ? ` — ${markup.join(', ')}` : ''}`,
    markup.length, 0);
  note(`notices: ${docs.map((d) => `${d.id}(${(d.sections || []).length})`).join(' ')}`);

  /* The privacy document makes claims. These are the ones this suite can check against the
   * shipped code, so the page cannot drift away from the build without something failing. */
  const privacy = docs.find((d) => d.id === 'privacy');
  const privacyText = privacy ? JSON.stringify(privacy) : '';
  const crashSrc = await fetchText('src/core/crash.js');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok('F26 the privacy page claims the crash banner makes no request, and the crash boundary makes none',
    /no network request/i.test(privacyText)
    && !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+Image\s*\(/.test(strip(crashSrc)));
  /**
   * ⚠ THE PAGE NAMES FOUR HOSTS AND THE BUILD REACHES FOUR HOSTS. NOTICE.md and README.md
   * both still say "exactly one network host", and that is true of `src/net/net.js` and not
   * true of a session: PEER_OPTS sets host, port, secure and debug and does NOT set
   * `config`, so PeerJS falls back to its own default ICE servers — a STUN server and two
   * TURN relays, all named in the vendored bytes. A privacy page that repeated the
   * one-host claim would be repeating a comment instead of describing the software.
   */
  const peer = await fetchText('assets/lib/peerjs-1.5.4/peerjs.min.js');
  const iceHosts = ['stun.l.google.com', 'eu-0.turn.peerjs.com', 'us-0.turn.peerjs.com'];
  const inLib = iceHosts.filter((h) => peer.includes(h));
  eq('F27 the networking library really does default to a STUN server and two TURN relays', inLib.length, iceHosts.length);
  const netjs = strip(await fetchText('src/net/net.js'));
  ok('F28 and PEER_OPTS does not override them, so a session reaches those hosts and not only the broker',
    /PEER_OPTS\s*=\s*\{[^}]*\}/.test(netjs) && !/PEER_OPTS\s*=\s*\{[^}]*config/.test(netjs));
  const named = iceHosts.filter((h) => privacyText.includes(h));
  eq(`F29 and the privacy page names all three rather than repeating "exactly one host"${named.length === 3 ? '' : ` — missing ${iceHosts.filter((h) => !named.includes(h)).join(', ')}`}`,
    named.length, iceHosts.length);
  emit();
}

/* ══ G. rollback, as a save-migration case ═════════════════════════════════════
 *
 * This repository is push-is-the-deploy: GitHub Pages serves `main` at root and there is no
 * build step, so a rollback is a revert and a push. That makes an OLDER BUILD READING A
 * NEWER PROFILE an ordinary operational event rather than an exotic one, and §23 Milestone 6
 * asks for the rollback plan to be REHEARSED rather than written down. Section B already
 * covers the refusal in the abstract; this covers what a rolled-back player's storage
 * actually does, because that is what the runbook in docs/day-one-operations.md turns on.
 *
 * ⚠ THE SEQUENCE IS QUARANTINE THEN OVERWRITE, AND THE SECOND HALF IS THE TRAP. The refused
 * save is copied aside — and then the very first autosave of the fresh session writes over
 * SAVE_KEY, because the quarantine went to a different key. So rolling FORWARD again does
 * not bring the campaign back on its own: by then it exists only in the quarantine slot,
 * which is a single slot with newest-wins. Nothing in the plan can be right if this is
 * assumed rather than measured.
 */
async function sectionG() {
  heading('G. rollback — what an older build does to a newer save');

  const s = storage();
  ok('G1 the harness has storage to test against', !!s);
  if (!s) { emit(); return; }

  const savedProfile = s.getItem(SAVE_KEY);
  const savedQuarantine = s.getItem(QUARANTINE_KEY);
  try {
    /* The realistic case is not version 999. It is exactly one ahead: the build that was
     * live ten minutes ago, before somebody reverted it. */
    const next = PROGRESSION_VERSION + 1;
    const campaign = {
      version: next, siteId: 'regional-site-19', operationsCompleted: 21, custodiesVerified: 6,
      requisition: 1480, research: 640, clearance: 3,
      roster: [{ id: 'p1', name: 'Vasquez', operations: 21 }],
      history: [{ operation: 21, mapId: 'blackthorn-reserve', anomalyId: 'blackthorn-caller', overall: 'Controlled' }],
    };
    const raw = JSON.stringify(campaign);
    s.removeItem(QUARANTINE_KEY);
    s.setItem(SAVE_KEY, raw);

    const out = loadProfileWithReport();
    eq(`G2 a profile from the build one version newer is REFUSED rather than read wrongly (v${next} vs v${PROGRESSION_VERSION})`,
      out.report.outcome, 'refused');
    eq('G3 and the session starts on a default profile rather than a half-read campaign',
      out.profile.requisition, STARTING_REQUISITION);
    eq('G4 21 operations do not survive into it', out.profile.operationsCompleted, 0);
    ok('G5 the player is TOLD, in a sentence naming both save formats',
      out.report.notices.some((n) => /newer build/i.test(n) && n.includes(String(next))),
      out.report.notices.join(' | '));
    ok('G6 and told that the campaign is still there and which build to open to get it back',
      out.report.notices.some((n) => /left exactly as it was|pick it up/i.test(n)));
    eq('G7 the refused save is copied aside BYTE FOR BYTE, not summarised', s.getItem(QUARANTINE_KEY), raw);

    /**
     * ⚠ AND THEN THE FIRST AUTOSAVE DESTROYS THE ORIGINAL. This is the fact the rollback
     * runbook is built around: a player who loads a rolled-back build and plays for one
     * minute no longer has their campaign at SAVE_KEY. Rolling the deploy forward again
     * does NOT restore it. If this assertion ever starts failing because somebody made the
     * load path non-destructive, that is good news and the runbook gets shorter.
     */
    saveProfile(out.profile);
    const afterSave = JSON.parse(s.getItem(SAVE_KEY));
    eq('G8 the first autosave of the fresh session overwrites the newer campaign at the save key', afterSave.operationsCompleted, 0);
    eq('G9 which is why the quarantine copy is the only thing left of it', s.getItem(QUARANTINE_KEY), raw);

    /**
     * The documented recovery, tested rather than asserted in prose: copy the quarantine
     * slot back over the save key once the newer build is live again. This is the exact
     * step docs/day-one-operations.md tells an operator to give a player, so it is the
     * exact step that has to work.
     */
    s.setItem(SAVE_KEY, s.getItem(QUARANTINE_KEY));
    const recovered = migrateWithReport(JSON.parse(s.getItem(SAVE_KEY)));
    eq('G10 restoring the quarantine copy under the NEWER build is still refused by THIS one, as it must be',
      recovered.report.outcome, 'refused');
    const asIfNewer = JSON.parse(raw);
    asIfNewer.version = PROGRESSION_VERSION;
    const backAgain = migrateWithReport(asIfNewer);
    eq('G11 and the same bytes under a build that understands them return the campaign intact — 21 operations',
      backAgain.profile.operationsCompleted, 21);
    eq('G12 with the requisition it had', backAgain.profile.requisition, 1480);

    /**
     * ⚠ ONE SLOT, NEWEST WINS. A second unreadable save at any point after the rescue
     * overwrites the rescued campaign, so "we quarantined it" is only true until the next
     * bad load. The runbook has to tell a player to export it, not to leave it there.
     */
    s.setItem(SAVE_KEY, '{"version":2,"requisition":700,"operationsCo');
    loadProfileWithReport();
    ok('G13 a second unreadable save overwrites the quarantine slot — the rescue is not durable',
      s.getItem(QUARANTINE_KEY) !== raw, `now: ${String(s.getItem(QUARANTINE_KEY)).slice(0, 40)}`);

    /* The other direction, which is what a roll-FORWARD looks like: an older save. */
    const old = migrateWithReport({ version: 1, operationsCompleted: 9, requisition: 700 });
    eq('G14 rolling forward is the safe direction — an older save is upgraded, not refused', old.report.outcome, 'upgraded');
    eq('G15 and keeps its 9 operations', old.profile.operationsCompleted, 9);
    ok('G16 while telling the player nothing was lost', old.report.notices.some((n) => /older build|nothing was lost/i.test(n)),
      old.report.notices.join(' | '));

    /**
     * ⚠ AND NOTHING PUTS ANY OF THOSE SENTENCES ON THE SCREEN. `Progression.migration`
     * carries the notice and no module under src/ui reads it, so today a rollback presents
     * as a campaign that is simply gone, with no explanation — which is precisely the §18.1
     * misrepresentation the progression module's own comment says must not happen. It is
     * measured here rather than asserted, because the fix belongs to the UI and the gap
     * belongs in the runbook either way.
     */
    const uiReads = [];
    for (const f of ['src/ui/base.js', 'src/ui/panels.js', 'src/ui/hud.js', 'src/ui/settings.js', 'src/main.js']) {
      if (/\bmigration\b/.test(await fetchText(f))) uiReads.push(f);
    }
    note(`migration notice: carried by Progression.migration, read by ${uiReads.length ? uiReads.join(', ') : 'NOTHING under src/ui — a rolled-back player is told nothing (see docs/day-one-operations.md)'}`);
  } finally {
    if (savedProfile === null) s.removeItem(SAVE_KEY); else s.setItem(SAVE_KEY, savedProfile);
    if (savedQuarantine === null) s.removeItem(QUARANTINE_KEY); else s.setItem(QUARANTINE_KEY, savedQuarantine);
  }
  ok('G17 and the suite put the player\'s real profile back', s.getItem(SAVE_KEY) === savedProfile);
  emit();
}

/* ══ drive ═════════════════════════════════════════════════════════════════════ */

await suite('audit', async () => {
  await run('A', () => sectionA());
  await run('B', () => sectionB());
  await run('C', () => sectionC());
  await run('D', () => sectionD());
  await run('E', () => sectionE());
  await run('F', () => sectionF());
  await run('G', () => sectionG());
});
void lines; void counts; void near;
