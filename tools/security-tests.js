/* Milestone 5 — security. GDD §23's "security, moderation, privacy, and load testing".
 *
 * Moderation, privacy and load were done and measured; this is the half nobody had looked
 * at. The threat model is not a guess and it is not general — it is one sentence, and every
 * section below is a consequence of it:
 *
 *   ANOTHER PLAYER'S BROWSER SENDS YOU DATA AND YOU RENDER IT.
 *
 * There is no server. A NAMED room is a word on a broker shared with the whole internet and
 * a LISTED one is advertised to anybody who asks, so in two of the three shapes this build
 * ships, THE HOST IS A STRANGER — which makes `applySnapshot` and `applyLobby` exactly as
 * hostile a surface as `_hostRead`, and they were the two that had never been treated as
 * one. The file header of `net.js` said the host's inbox was "the one function in this build
 * a stranger can call"; that sentence was the bug.
 *
 * ── WHAT THIS SUITE REFUSES TO DO ────────────────────────────────────────────
 *
 * It does not test the sanitiser. `escapeHtml('<img>')` returning `&lt;img&gt;` proves
 * nothing about a build with fourteen `innerHTML` sites in it, and the two real holes found
 * this milestone were both in places that never called it — a callsign going through
 * `t('hud.objective.carrierHas', {name})`, which interpolates raw, and a debrief `overall`
 * going through `msg('grade.' + x)`, which RETURNS THE KEY when it does not recognise it and
 * so hands the attacker's own string straight back.
 *
 * So every assertion here drives the real entry point and reads the real DOM. A callsign is
 * typed into a real join over a real link and the squad list is queried for elements the
 * attacker put there. A malformed snapshot goes through `NetSession._clientOnMessage`, not
 * through `applySnapshot` directly, because the wrapper is half of what is being tested.
 *
 * ── AND IT ASSERTS ON NODES, NOT ON WHETHER A SCRIPT RAN ─────────────────────
 *
 * `querySelectorAll('img,svg,script,iframe').length` is deterministic; "did the onerror
 * fire" depends on a network 404 and an event loop under virtual time, and a flaky security
 * test is one somebody deletes. An element the attacker chose entering the DOM IS the
 * property — running code is only one of the things you can do with it, and the others
 * (a request to an attacker's host carrying the page's referrer, a full-page overlay over
 * the extraction prompt) do not need script at all.
 */

import { lines, counts, ok, eq, near, note, emit, run, heading, suite } from './harness.js';

import { CONFIG } from '../src/config.js';
import { loadContent } from '../src/sim/content.js';
import { Game, RECOMMENDED_MANIFEST } from '../src/game.js';
import { PHASE } from '../src/sim/mission.js';
import { NetSession, loopbackPair, ROLE, ACT_BURST, ACT_PER_SEC } from '../src/net/net.js';
import {
  MSG, ACT, LACT, PROTOCOL_VERSION, MAX_SQUAD,
  encodeSnapshot, encodeFullSnapshot, encodeLobby, applySnapshot, applyLobby,
  snapshotProblem, lobbyProblem, safeId, safeLine,
} from '../src/net/protocol.js';
import {
  Lobby, SessionDirectory, LOBBY_PHASE, VISIBILITY, REMOVAL_REASONS, ROOM_PREFIX,
  roomIdFor, roomSlug, nameExposure,
} from '../src/net/lobby.js';
import { t as msgFor } from '../src/core/i18n.js';
import { Hud, escapeHtml } from '../src/ui/hud.js';
import { Panels } from '../src/ui/panels.js';
import { LobbyScreen, loadRecent, rememberRoom, loadResume, RESUME_KEY } from '../src/ui/lobby.js';
import { CommsWheel, WHEEL_ORDER } from '../src/ui/commswheel.js';
import {
  Settings, SETTINGS_KEY, SETTINGS_QUARANTINE_KEY, SETTINGS_VERSION,
  migrateSettings, sanitiseSettings, probeStorage,
} from '../src/ui/settings.js';

/* ── rigging ─────────────────────────────────────────────────────────────────
 *
 * Same shape as net-tests: an injected clock, because the lobby and the ACT budget are both
 * timed against wall time in the shipped build and a budget you cannot pin to an instant is
 * a budget you cannot test.
 */
function rig(content, { seed = 'sec', hz = 12 } = {}) {
  const clock = { ms: 1000 };
  const g = new Game(content, { seed });
  const n = new NetSession(g, { snapshotHz: hz, now: () => clock.ms });
  return { g, n, clock, tick: (ms) => { clock.ms += ms; } };
}

function mkClient(content, { seed = 'sec-c' } = {}) {
  const clock = { ms: 1000 };
  const g = new Game(content, { seed });
  const n = new NetSession(g, { now: () => clock.ms });
  return { g, n, clock, tick: (ms) => { clock.ms += ms; } };
}

function seatOn(host, client, name) {
  const [hl, cl] = loopbackPair();
  host.n.accept(hl);
  client.n.join(cl, { name });
  return { hl, cl };
}

/** A detached element the suite can render into and then query. */
function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** Elements an attacker's string would have created. The whole assertion, in one place. */
const INJECTED = 'img,svg,script,iframe,object,embed,link,style,form,video,audio,math,a[href]';
function injectedIn(node) { return node ? node.querySelectorAll(INJECTED).length : -1; }

/**
 * The payloads.
 *
 * ⚠ `CALLSIGN` IS FOURTEEN CHARACTERS AND THAT IS NOT AN ACCIDENT. Both `_hostHello` and
 * `_hostLobbyAct` clamp a callsign to fourteen, so anybody claiming a callsign cannot carry
 * a payload is claiming something measurable — and it is false: `<svg/onload=z>` is exactly
 * fourteen and is a live element with a handler on it. The clamp is a clamp; it was never a
 * sanitiser, and the suite says so with a number rather than with an opinion.
 *
 * ⚠ `LONG` IS THE ONE THAT MATTERS. A client is clamped by the host. A HOST is clamped by
 * nobody: `applySnapshot` wrote `p.name = d.n` and `applyLobby` wrote `callsign: s.n`
 * straight through, so a hostile host had no length limit at all on a string that lands on
 * five surfaces, one of which interpolated it raw.
 */
const CALLSIGN = '<svg/onload=z>';
const LONG = '<img src=x onerror="window.__cdPwned=1">';
const HUGE = `${LONG}${'A'.repeat(4000)}`;

/* ── SA. player text to the DOM, through a real join ─────────────────────── */
async function sectionSA(content) {
  heading('SA. a callsign a person typed, on every surface that prints one');

  const host = rig(content, { seed: 'sa' });
  host.n.host();
  host.g.commitLoadout(RECOMMENDED_MANIFEST);
  const c1 = mkClient(content, { seed: 'sa-c' });
  seatOn(host, c1, CALLSIGN);

  eq('SA1 a callsign of exactly fourteen characters of markup is not truncated by the clamp',
    host.g.playerById('p2').name, CALLSIGN);
  eq('SA2 so "it is only fourteen characters" is not a defence — that is a live element with a handler',
    CALLSIGN.length, 14);

  /* The control. If this does not build an element, nothing below means anything. */
  const control = mount();
  control.innerHTML = CALLSIGN;
  ok('SA3 CONTROL: the payload really is markup in this DOM, so the assertions below have teeth',
    injectedIn(control) >= 1, `${injectedIn(control)} elements from ${CALLSIGN}`);
  control.remove();

  /* ── the HUD squad list and the objective line ── */
  const hudRoot = mount();
  const hud = new Hud(hudRoot, host.g, null);
  hud.update();
  eq('SA4 the HUD squad list prints the callsign as text and not as markup', injectedIn(hud.squad), 0);
  ok('SA5 and it really is on screen, so this is escaping rather than dropping',
    hud.squad.textContent.includes(CALLSIGN), hud.squad.textContent.slice(0, 80));

  /**
   * ⚠ THE OBJECTIVE LINE WAS THE HOLE. `hud._objective()` returns
   * `t('hud.objective.carrierHas', {name: carrier.name})` and `t()` interpolates with
   * `String(params[name])` — no escaping, ever — and the result goes into `topRight` through
   * `innerHTML`. Every other surface in the build escaped a callsign. This one did not, and
   * it is the one that is on screen for the whole operation.
   */
  host.g.custody = 'verified';
  host.g.playerById('p2').hands = 'reinforced-transit-case';
  hud.update();
  ok('SA6 the objective line names whoever is carrying the case', /carr|has/i.test(hud.topRight.textContent),
    hud.topRight.textContent.slice(0, 120));
  eq('SA7 and it prints their callsign as text — this was the one unescaped path in the HUD',
    injectedIn(hud.topRight), 0);
  ok('SA8 with the callsign still legible, not stripped',
    hud.topRight.textContent.includes(CALLSIGN), hud.topRight.textContent.slice(0, 120));
  host.g.playerById('p2').hands = null;
  host.g.custody = 'none';

  /* ── the squad-wide notice feed ── */
  host.g.notice(`${CALLSIGN} ${LONG}`);
  hud.update();
  eq('SA9 the notice feed prints a notice carrying a callsign as text', injectedIn(hud.notices), 0);

  /* ── the comms feed: a callout carries the caller's name ── */
  const wheelRoot = mount();
  const wheel = new CommsWheel(wheelRoot, host.g, {});
  const p2 = host.g.playerById('p2');
  host.g.ping('p2', WHEEL_ORDER[0], p2.x, p2.z);
  wheel.update(host.g.clock.simTimeMs);
  ok('SA10 a callout from that operative reaches the feed', wheel.feed.textContent.length > 0,
    wheel.feed.textContent.slice(0, 80));
  eq('SA11 and the feed prints their callsign as text', injectedIn(wheel.feed), 0);

  /* ── the lobby roster, and the moderation log ── */
  const lobbyRoot = mount();
  const screen = new LobbyScreen(lobbyRoot, {
    net: host.n, site: { operations: [] }, now: () => host.clock.ms, storage: null,
  });
  screen.show(null);
  eq('SA12 the lobby roster prints a callsign as text', injectedIn(screen.node), 0);
  ok('SA13 and the callsign is on the roster, not silently missing',
    screen.node.textContent.includes(CALLSIGN));

  const rec = host.n.removeSeat('p2', 'conduct');
  ok('SA14 the host can remove that seat', !!rec, JSON.stringify(rec));
  screen.showLog = true;
  screen.render();
  ok('SA15 the moderation log names who was removed', screen.node.textContent.includes(CALLSIGN),
    screen.node.textContent.slice(-200));
  eq('SA16 and prints the name as text — the log is the one place a host READS the string',
    injectedIn(screen.node), 0);

  /* ── the debrief ── */
  const panelRoot = mount();
  const panels = new Panels(panelRoot, host.g, {});
  host.g.notice(LONG);
  const result = host.g.endMission('a test', host.g.clock.simTimeMs);
  panels.showDebrief(result);
  eq('SA17 the debrief prints its own graded report without injecting anything', injectedIn(panels.node), 0);

  ok('SA18 and nothing anywhere ran a handler', window.__cdPwned === undefined, String(window.__cdPwned));
  ok('SA19 nothing on the page crashed on the way',
    !document.getElementById('err-banner') || !document.getElementById('err-banner').textContent);

  [hudRoot, wheelRoot, lobbyRoot, panelRoot].forEach((n) => n.remove());
  emit();
}

/* ── SB. a hostile HOST, which is the unbounded case ─────────────────────── */
async function sectionSB(content) {
  heading('SB. the host is a stranger too, and the host has no length limit on it');

  /* A client with a link, and nothing but a hostile endpoint on the far end of it. This is
   * the real inbox — `join()` wires `link.onMessage` to `_clientOnMessage` — and everything
   * goes through JSON, so a field that could not survive the wire does not reach the test. */
  const good = rig(content, { seed: 'sb-h' });
  good.n.host();
  good.g.commitLoadout(RECOMMENDED_MANIFEST);
  const victim = mkClient(content, { seed: 'sb-v' });
  const [evil, cl] = loopbackPair();
  victim.n.join(cl, { name: 'Victim' });

  const base = () => JSON.parse(JSON.stringify(encodeFullSnapshot(good.g)));
  evil.send({ t: MSG.WELCOME, v: PROTOCOL_VERSION, id: 'p1', token: 'x', snap: base() });
  eq('SB1 the client seats itself on a welcome', victim.n.status, 'connected');

  /* ⚠ FOUR THOUSAND CHARACTERS OF MARKUP AS A CALLSIGN. `applySnapshot` wrote `p.name = d.n`
   * with no clamp and no type check, so the fourteen-character limit a CLIENT lives under
   * never applied to the machine running the mission. */
  const s1 = base();
  s1.ps[0].n = HUGE;
  evil.send(s1);
  const seat = victim.g.playerById('p1');
  eq('SB2 a host that sends a four-thousand-character callsign gets the same fourteen a client would',
    seat.name.length, 14);
  note(`the host sent ${HUGE.length} characters; ${seat.name.length} were kept`);

  const hudRoot = mount();
  const hud = new Hud(hudRoot, victim.g, null);
  victim.g.players.push(victim.g.addPlayer('Second'));   // a roster of one draws nothing
  hud.update();
  eq('SB3 and nothing of it reaches the DOM as an element', injectedIn(hudRoot), 0);

  /* ⚠ THE PHASE IS A MESSAGE KEY AND `t()` RETURNS THE KEY IT DOES NOT KNOW. So
   * `ph: '<img …>'` came back out of the message table verbatim and went into the HUD's
   * top-left row and the tablet's subtitle, both through `innerHTML`. */
  const before = victim.g.mission.phase;
  const s2 = base();
  s2.ph = LONG;
  ok('SB4 a snapshot whose phase is not an id is refused outright', !applySnapshot(victim.g, s2));
  eq('SB5 so the client keeps the phase it had', victim.g.mission.phase, before);
  evil.send(s2);
  hud.update();
  eq('SB6 and the HUD is unchanged and uninjected', injectedIn(hudRoot), 0);
  ok('SB7 the refusal is counted rather than silently swallowed', victim.n.framesRefused >= 1,
    `${victim.n.framesRefused}`);

  /* ⚠ THE ANOMALY STATE GOES INTO THE IMAGER BEZEL, unescaped, through
   * `t('hud.bezel.held', {state})`. It needed the imager up, which is why nobody found it. */
  const s3 = base();
  s3.an.s = LONG;
  applySnapshot(victim.g, s3, { localId: 'p1' });
  ok('SB8 an anomaly state that is not an id does not become the anomaly state',
    victim.g.anomaly.state !== LONG, victim.g.anomaly.state);
  victim.g.imagerOnIds.add(victim.g.localId);
  hud.renderer = { imagerRectCss: () => ({ left: 0, top: 0, size: 100 }) };
  hud.update();
  eq('SB9 and the imager bezel prints no element from it', injectedIn(hud.bezel), 0);
  victim.g.imagerOnIds.clear();

  /**
   * ⚠ THE DEBRIEF WAS THE WORST OF THEM. `game.result = snap.rs` took the host's object
   * verbatim; `showDebrief` printed `d.name` and `d.word` unescaped; and the TITLE went
   * through `msg('grade.' + result.overall)`, which returns its own key for anything it does
   * not recognise — so `overall` was an attacker-controlled string interpolated into an
   * `<h1>` with no escaping anywhere on the path. Ten seats' worth of debrief, on a screen
   * every operation ends on.
   */
  const s4 = base();
  s4.rs = {
    overall: LONG,
    failReason: LONG,
    dims: [{ id: LONG, wordId: LONG, name: LONG, word: LONG, why: LONG }],
    claims: { right: 1e9, wrong: -5, unmarked: 'x' },
    extra: { nested: LONG },
  };
  applySnapshot(victim.g, s4, { localId: 'p1' });
  const res = victim.g.result;
  ok('SB10 a debrief off the wire is rebuilt from a whitelist, never spread', !!res && res.extra === undefined,
    Object.keys(res || {}).join());
  ok('SB11 its grade is an id or it is a default — never a string the host chose',
    res.overall !== LONG, res.overall);
  eq('SB12 and its counts are numbers in range', res.claims.wrong, 0);
  const panelRoot = mount();
  const panels = new Panels(panelRoot, victim.g, {});
  panels.showDebrief(res);
  eq('SB13 so the debrief screen injects nothing', injectedIn(panels.node), 0);
  ok('SB14 and still says something', panels.node.textContent.length > 40);

  /* ── the lobby broadcast, the other wholesale-replace path ── */
  const wire = encodeLobby(good.n.lobby);
  wire.st = [{ i: 'p1', n: HUGE, f: 7 }, { i: LONG, n: 'x', f: 1 }];
  wire.rm = HUGE;
  wire.op = { i: LONG, l: HUGE, n: LONG };
  ok('SB15 a lobby broadcast with a hostile roster is still applied — a roster is not optional',
    applyLobby(victim.n.lobby, wire));
  eq('SB16 but a callsign in it is clamped to the fourteen the host would have clamped it to',
    victim.n.lobby.seatOf('p1').callsign.length, 14);
  eq('SB17 and a seat id that is not an id is not a seat', victim.n.lobby.size, 1);
  ok('SB18 the room name is bounded', victim.n.lobby.roomName.length <= 24, `${victim.n.lobby.roomName.length}`);
  ok('SB19 and the operation id is an id or empty', victim.n.lobby.operation.id === '',
    victim.n.lobby.operation.id);

  const lobbyRoot = mount();
  const screen = new LobbyScreen(lobbyRoot, {
    net: victim.n, site: { operations: [] }, now: () => victim.clock.ms, storage: null,
  });
  screen.show(null);
  eq('SB20 and the lobby screen injects nothing from any of it', injectedIn(screen.node), 0);

  /* ── the one-line refusal a host can send ── */
  evil.send({ t: MSG.REFUSE, why: HUGE });
  ok('SB21 a refusal reason from a host is bounded', victim.n.refusedWhy.length <= 200,
    `${victim.n.refusedWhy.length}`);
  evil.send({ t: MSG.EVENT, text: HUGE });
  const last = victim.g.localNotices[victim.g.localNotices.length - 1];
  ok('SB22 and so is a private event line', last && last.text.length <= 200, last ? `${last.text.length}` : 'none');

  /* ⚠ `REMOVAL_REASONS[m.why]` IS NOT A MEMBERSHIP TEST — `REMOVAL_REASONS.constructor` is
   * the Object constructor and is truthy, so a removal reason of 'constructor' put a
   * function through a template literal and printed its source at the player. */
  evil.send({ t: MSG.KICK, why: 'constructor' });
  ok('SB23 a removal reason is one of the five words or it is the default',
    Object.values(REMOVAL_REASONS).includes(victim.n.removedWhy), String(victim.n.removedWhy));
  evil.send({ t: MSG.KICK, why: '__proto__' });
  ok('SB24 including the other reserved key', Object.values(REMOVAL_REASONS).includes(victim.n.removedWhy),
    String(victim.n.removedWhy));

  ok('SB25 and no handler ran at any point', window.__cdPwned === undefined, String(window.__cdPwned));
  [hudRoot, panelRoot, lobbyRoot].forEach((n) => n.remove());
  emit();
}

/* ── SC. a snapshot that is not one ──────────────────────────────────────── */
async function sectionSC(content) {
  heading('SC. malformed frames: the Game survives, and refuses');

  const good = rig(content, { seed: 'sc-h' });
  good.n.host();
  good.g.commitLoadout(RECOMMENDED_MANIFEST);
  good.g.notice('a real notice');

  const victim = mkClient(content, { seed: 'sc-v' });
  const [evil, cl] = loopbackPair();
  victim.n.join(cl, { name: 'Victim' });
  const base = () => JSON.parse(JSON.stringify(encodeFullSnapshot(good.g)));
  evil.send({ t: MSG.WELCOME, v: PROTOCOL_VERSION, id: 'p1', token: 'x', snap: base() });

  /* What the client looked like after the last frame it accepted. Everything below has to
   * leave this untouched, because a frame that was not applied did not happen. */
  const sig = (g) => JSON.stringify({
    ph: g.mission.phase, cu: g.custody, ms: g.clock.simTimeMs,
    names: g.players.map((p) => p.name), cache: [...g.cache.keys()].sort(),
    notices: g.notices.length, dep: g.deployables.list.length,
  });
  const wasSig = sig(victim.g);

  /**
   * ⚠ EVERY ONE OF THESE IS ONE FIELD. The one that shipped was `{t:'cmd'}` against the
   * HOST — recorded in Dev\INDEX.md as a one-line denial of service against four other
   * people's evening — and the client end had never been given the same treatment, so
   * `ix: [1]` made `instances.decode` destructure a number and throw out of PeerJS's data
   * handler. Same defect, aimed the other way, and no wrapper to catch it.
   */
  const hostile = [
    ['no fields at all', { t: MSG.SNAP, v: PROTOCOL_VERSION }],
    ['a wrong protocol version', { ...base(), v: 999 }],
    ['a protocol version that is a string', { ...base(), v: '1' }],
    ['no player array', (() => { const s = base(); delete s.ps; return s; })()],
    ['players as a string', { ...base(), ps: 'everybody' }],
    ['a player row that is a number', { ...base(), ps: [1, 2] }],
    ['a player with no seat id', { ...base(), ps: [{ n: 'x' }] }],
    ['a seat id that is not an id', { ...base(), ps: [{ i: LONG, n: 'x' }] }],
    ['a seat id that is a reserved key', { ...base(), ps: [{ i: '__proto__', n: 'x' }] }],
    ['more seats than a squad', { ...base(), ps: Array.from({ length: 40 }, (_, k) => ({ i: `p${k}` })) }],
    ['ms as null, which is what JSON does to NaN', { ...base(), ms: null }],
    ['ms as an array', { ...base(), ms: [] }],
    ['a phase that is an object', { ...base(), ph: {} }],
    ['no anomaly', (() => { const s = base(); delete s.an; return s; })()],
    ['an anomaly with no ice array', { ...base(), an: { x: 0, z: 0, s: 'latent', e: 0 } }],
    ['no site block', (() => { const s = base(); delete s.si; return s; })()],
    ['a cache that is a string', { ...base(), ca: 'stuff' }],
    ['a notice list that is an object', { ...base(), no: {} }],
    ['a claim list that is a number', { ...base(), cl: 7 }],
    ['an evidence list that is a string', { ...base(), ev: 'none' }],
    ['a deployable list that is null', { ...base(), dp: null }],
    ['nothing but a type', { t: MSG.SNAP }],
    ['null', null],
    ['a number', 42],
    ['an array', [1, 2, 3]],
  ];
  let refused = 0;
  for (const [why, frame] of hostile) {
    const n = victim.n.framesRefused;
    evil.send(frame);
    if (victim.n.framesRefused > n || victim.n.hostMalformed > 0) refused++;
  }
  eq(`SC1 all ${hostile.length} malformed frames were refused rather than applied`, refused, hostile.length);
  eq('SC2 and the Game is byte-for-byte the one it was before any of them', sig(victim.g), wasSig);
  ok('SC3 the session is still a client with a live link', victim.n.role === ROLE.CLIENT && cl.open);

  /* And the reason is available, because "it refused" and "it refused because the player
   * array was a string" are different facts and only one of them helps. */
  eq('SC4 a caller can ask WHY a frame is not a snapshot',
    snapshotProblem({ ...base(), ps: 'x' }), 'ps is not an array');
  eq('SC5 including the version', snapshotProblem({ t: MSG.SNAP, v: 9 }), 'protocol 9');
  eq('SC6 and a good one has no problem', snapshotProblem(base()), null);
  eq('SC7 the same question for a lobby broadcast', lobbyProblem({ t: MSG.LOBBY, v: 9 }), 'protocol 9');
  eq('SC8 and a good one', lobbyProblem(encodeLobby(good.n.lobby)), null);

  /**
   * ⚠ THE FRAMES THAT ARE STRUCTURALLY FINE AND SEMANTICALLY POISON. These are APPLIED —
   * refusing a whole snapshot for one bad row would let a host stop a client's world by
   * sending one — so each field has to be dropped on its own and the frame has to survive.
   */
  const poison = [
    ['an item id nothing in this build has', (s) => { s.ps[0].hs = 'a-thing-that-is-not-real'; }],
    ['an item id that is a reserved key', (s) => { s.ps[0].hs = 'constructor'; }],
    ['slots that are not an array', (s) => { s.ps[0].sl = 'belt1'; }],
    ['slots naming unknown items', (s) => { s.ps[0].sl = ['nope', 'nope', 'nope', 'nope', 'nope']; }],
    ['a held slot that is not a slot', (s) => { s.ps[0].hd = '__proto__'; }],
    ['a cargo manifest naming an unknown item', (s) => { s.ca = [['not-an-item', 3], ['x', 'y']]; }],
    ['a cargo row that is not a pair', (s) => { s.ca = [1, 'two', null]; }],
    ['a deployable naming an unknown item', (s) => { s.dp = [{ u: 1, it: 'not-real', x: 0, z: 0 }]; }],
    ['a ping board row that is a number', (s) => { s.pg = [1, 2, 3]; }],
    ['a ping phrase that is a reserved key', (s) => { s.pg = [[1, 'p1', 'constructor', 0, 0, 0]]; }],
    ['a ping phrase that is __proto__', (s) => { s.pg = [[1, 'p1', '__proto__', 0, 0, 0]]; }],
    ['an instance list of bare numbers', (s) => { s.ix = [1, 2, 3]; }],
    ['an instance list that is a string', (s) => { s.ix = 'nope'; }],
    ['a claim id nothing on the board has', (s) => { s.cl = [['not-a-claim', 'believed']]; }],
    ['a claim state that is an object', (s) => { s.cl = [['not-a-claim', { a: 1 }]]; }],
    ['a circuit that is not on this floor', (s) => { s.si.c = [['not-a-circuit', 1], 5]; }],
    ['a door that is not on this floor', (s) => { s.si.d = [['not-a-door', 1], null]; }],
    ['a notice that is not a pair', (s) => { s.no = ['just a string', 3]; }],
    ['a notice whose text is an object', (s) => { s.no = [[0, { a: 1 }]]; }],
    ['an evidence id nothing has a rule for', (s) => { s.ev = [{ e: 'nope', ms: 0, x: 0, z: 0 }]; }],
    ['positions that are null', (s) => { s.ps[0].x = null; s.ps[0].z = null; s.ps[0].y = null; }],
    ['a flag field that is a string', (s) => { s.ps[0].f = 'crouching'; }],
    ['a severity of ten thousand', (s) => { s.ps[0].ce = 10000; }],
    ['ice patches that are not arrays', (s) => { s.an.ic = [1, null, 'x']; }],
  ];
  let applied = 0, threw = 0;
  for (const [, mutate] of poison) {
    const s = base();
    mutate(s);
    try {
      evil.send(s);
      applied++;
    } catch { threw++; }
  }
  eq(`SC9 all ${poison.length} semantically hostile frames were taken without throwing`, threw, 0);
  eq('SC10 and applied rather than refused, because one bad row must not stop the world', applied, poison.length);

  /* Now DRAW one, which is where the old code died: the guards were in the renderer or
   * nowhere, and `itemsById.get(p.hands).displayName` had no `?`. */
  const hudRoot = mount();
  const hud = new Hud(hudRoot, victim.g, null);
  const wheelRoot = mount();
  const wheel = new CommsWheel(wheelRoot, victim.g, {});
  let drawThrew = null;
  try {
    hud.update();
    wheel.update(victim.g.clock.simTimeMs);
    hud.update();
  } catch (e) { drawThrew = String(e && e.message); }
  ok('SC11 and the HUD and the comms feed draw a frame afterwards without throwing', drawThrew === null, drawThrew);
  eq('SC12 with nothing injected', injectedIn(hudRoot) + injectedIn(wheelRoot), 0);

  const panelRoot = mount();
  const panels = new Panels(panelRoot, victim.g, {});
  let cacheThrew = null;
  try { panels.showCache(); } catch (e) { cacheThrew = String(e && e.message); }
  ok('SC13 and the cargo manifest opens, which it could not with an unknown item in the cache',
    cacheThrew === null, cacheThrew);

  /**
   * ⚠ `__proto__` IS AN OWN PROPERTY AFTER `JSON.parse` AND SURVIVES `JSON.stringify`, so it
   * is a thing the wire can actually carry. Asserted against the real prototype rather than
   * against an intention.
   */
  const poisoned = JSON.parse(`{"t":"snap","v":${PROTOCOL_VERSION},"__proto__":{"cdPolluted":1},`
    + '"ps":[{"i":"p1","n":"x","__proto__":{"cdPolluted":1}}],"ms":0,"ph":"Arrival",'
    + '"dp":[],"ev":[],"no":[],"ca":[],"cl":[],"an":{"x":0,"z":0,"s":"latent","e":0,"ic":[]},'
    + '"si":{"c":[],"d":[]}}');
  evil.send(poisoned);
  eq('SC14 a snapshot carrying __proto__ does not reach Object.prototype', ({}).cdPolluted, undefined);
  eq('SC15 nor does one on a player row', ([]).cdPolluted, undefined);

  const badLobby = JSON.parse(`{"t":"lobby","v":${PROTOCOL_VERSION},"__proto__":{"cdPolluted2":1},"st":[]}`);
  applyLobby(victim.n.lobby, badLobby);
  eq('SC16 and neither does a lobby broadcast', ({}).cdPolluted2, undefined);

  note(`${hostile.length} refused frames, ${poison.length} poisoned-but-valid frames, `
    + `${victim.n.framesRefused} counted as refused, ${victim.n.hostMalformed} unreadable`);
  [hudRoot, wheelRoot, panelRoot].forEach((n) => n.remove());
  emit();
}

/* ── SD. everything read back out of localStorage ────────────────────────── */
async function sectionSD() {
  heading('SD. a poisoned save degrades to the defaults and says so');

  /**
   * ⚠ THIS IS THE ONE THAT REACHED OUTSIDE THE GAME.
   *
   * `patch()` walked a parsed save with `Object.entries`, which hands over `__proto__` as an
   * own key, built the path `__proto__.x`, and `setPath` DESCENDED INTO `Object.prototype`
   * and assigned to it. Global prototype pollution of the whole page, on boot, from one word
   * in a text file — and localStorage is keyed to the ORIGIN, which for `<user>.github.io`
   * is shared by every project that user has ever published. It is not a same-page-only
   * reach, and `progression.js` was hardened against exactly this defect this same week.
   */
  const s1 = new Settings(JSON.parse('{"version":1,"__proto__":{"cdSettingsPolluted":1}}'));
  eq('SD1 a save whose top-level key is __proto__ does not reach Object.prototype',
    ({}).cdSettingsPolluted, undefined);
  ok('SD2 and the settings object is still usable', typeof s1.get('camera.fov') === 'number', String(s1.get('camera.fov')));

  const s2 = new Settings(JSON.parse('{"version":1,"camera":{"__proto__":{"cdNested":1},"fov":95}}'));
  eq('SD3 nor does one nested inside a group', ({}).cdNested, undefined);
  eq('SD4 while the honest field beside it is still applied', s2.get('camera.fov'), 95);

  const s3 = new Settings({});
  s3.patch(JSON.parse('{"__proto__":{"cdPatched":1}}'));
  eq('SD5 and patch() refuses it too, because patch() is public and the load path is not the only door',
    ({}).cdPatched, undefined);
  s3.set('constructor.prototype.cdSet', 1);
  eq('SD6 as does set(), for the same reason', ({}).cdSet, undefined);

  /**
   * ⚠ AND THE OTHER HALF: A DAMAGED SAVE MUST NOT THROW ON BOOT. `Settings.restore()` runs
   * before anything is on screen, `_recompute` reads `v.safety.photosensitive` and
   * `volumes()` does `name in this.values.volume` — so `"safety": null` was a TypeError with
   * no game behind it, and `bindings: {"sprint": null}` was `Array.from(null)` in the Input
   * constructor a line later. `sanitiseBindings` already existed and nothing on the boot path
   * had ever been pointed at it.
   */
  const nasty = [
    ['safety is null', { version: 1, safety: null }],
    ['safety is a string', { version: 1, safety: 'off' }],
    ['volume is a string', { version: 1, volume: 'loud' }],
    ['volume is an array', { version: 1, volume: [1, 2] }],
    ['camera is a number', { version: 1, camera: 7 }],
    ['vision is an array', { version: 1, vision: ['high'] }],
    ['input is null', { version: 1, input: null }],
    ['bindings hold a null', { version: 1, input: { bindings: { sprint: null } } }],
    ['bindings hold objects', { version: 1, input: { bindings: { sprint: { a: 1 }, crouch: 5 } } }],
    ['bindings is a string', { version: 1, input: { bindings: 'KeyW' } }],
    ['holdModes hold garbage', { version: 1, input: { holdModes: { sprint: { x: 1 }, nonsense: 'toggle' } } }],
    ['captions carry a NaN that JSON turned into null', { version: 1, captions: { size: null, opacity: null } }],
    ['a field is Infinity as a string', { version: 1, camera: { fov: 'Infinity' } }],
    ['an unknown group', { version: 1, telemetry: { enabled: true } }],
    ['the whole thing is an array', [1, 2, 3]],
    ['the whole thing is a string', 'settings'],
  ];
  let booted = 0, crashed = [];
  for (const [why, blob] of nasty) {
    try {
      const clean = migrateSettings(blob);
      const st = new Settings(clean);
      st.effective; st.volumes(); st.holdModes(); st.bindings(); st.cssVars();
      booted++;
    } catch (e) { crashed.push(`${why}: ${e && e.message}`); }
  }
  eq(`SD7 all ${nasty.length} damaged saves boot to a usable Settings`, booted, nasty.length);
  eq('SD8 with nothing thrown', crashed.join(' | '), '');

  const bad = new Settings(migrateSettings({ version: 1, input: { bindings: { sprint: null, nonsense: ['KeyQ'] } } }));
  const table = bad.bindings();
  ok('SD9 a binding table full of rubbish comes back as a table the Input can run on',
    table && Array.isArray(table.sprint), JSON.stringify(table && table.sprint));
  ok('SD10 with the action that was not one dropped', table.nonsense === undefined);
  const holds = bad.holdModes();
  ok('SD11 and the hold/toggle map is one of the two words per action',
    Object.values(holds).every((v) => v === 'hold' || v === 'toggle'), JSON.stringify(holds));

  const refused = [];
  sanitiseSettings({ version: 1, safety: null, telemetry: {}, __proto__: { x: 1 } }, refused);
  ok('SD12 and a save that lost fields says which — silently losing a player\'s settings is what progression.js was fixed for',
    refused.length >= 2, refused.join(' | '));

  eq('SD13 a save from a version this build does not know is refused rather than half-applied',
    migrateSettings({ version: 99, camera: { fov: 200 } }), null);
  eq('SD14 and so is one that is not an object', migrateSettings('nope'), null);

  /* The real store, and the quarantine — with the page's own settings put back afterwards. */
  const store = probeStorage();
  if (store) {
    const keep = store.getItem(SETTINGS_KEY);
    try {
      store.setItem(SETTINGS_KEY, '{not json at all');
      const restored = Settings.restore();
      ok('SD15 an unparseable save boots to the defaults', restored.get('camera.fov') === CONFIG.render.fov,
        String(restored.get('camera.fov')));
      eq('SD16 and the original is copied aside rather than thrown away',
        store.getItem(SETTINGS_QUARANTINE_KEY), '{not json at all');

      store.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, safety: null, camera: { fov: 200 } }));
      const r2 = Settings.restore();
      ok('SD17 a save with a group of the wrong type boots, and clamps the field beside it',
        r2.get('camera.fov') <= 110, String(r2.get('camera.fov')));
      ok('SD18 with the safety block back to a real one', typeof r2.get('safety.photosensitive') === 'boolean');
    } finally {
      if (keep === null) store.removeItem(SETTINGS_KEY); else store.setItem(SETTINGS_KEY, keep);
      store.removeItem(SETTINGS_QUARANTINE_KEY);
    }
  } else {
    note('SD15-18 skipped: this profile refuses storage');
  }

  /* ── the joiner's own room history ── */
  const fake = (() => {
    let v = null;
    return { getItem: () => v, setItem: (k, x) => { v = x; }, removeItem: () => { v = null; } };
  })();
  fake.setItem('x', JSON.stringify([
    { code: 'AB12C', room: '', label: LONG + 'A'.repeat(500), atMs: 1 },
    { code: LONG, room: LONG, label: 'x', atMs: 'soon' },
    null, 7, 'nope', [1, 2],
    ...Array.from({ length: 400 }, (_, k) => ({ code: `Z${k}`, room: '', label: 'x', atMs: k })),
  ]));
  const rows = loadRecent(fake);
  ok('SD19 the room history is bounded however many rows are on disk', rows.length <= 8, `${rows.length}`);
  ok('SD20 every row has a bounded label', rows.every((r) => r.label.length <= 40));
  ok('SD21 every code is alphanumeric, whatever was written under the key',
    rows.every((r) => /^[A-Z0-9]*$/.test(r.code)), JSON.stringify(rows.map((r) => r.code)));
  ok('SD22 every time is a number', rows.every((r) => typeof r.atMs === 'number' && Number.isFinite(r.atMs)));
  ok('SD23 a store that throws gives an empty list rather than a crash',
    loadRecent({ getItem() { throw new Error('locked'); } }).length === 0);

  const screenRoot = mount();
  const solo = mkClient(await loadContent({ incident: 'cold-storage-draught' }), { seed: 'sd-ui' });
  solo.n.host();
  const screen = new LobbyScreen(screenRoot, {
    net: solo.n, site: { operations: [] }, now: () => 1e12, storage: fake,
  });
  screen.recent = rows;
  screen.show(null);
  eq('SD24 and the history renders as text, with nothing an attacker put on disk becoming an element',
    injectedIn(screen.node), 0);

  const cs = { getItem: () => `${LONG}${'B'.repeat(300)}`, setItem() {}, removeItem() {} };
  const screen2 = new LobbyScreen(screenRoot, { net: solo.n, site: { operations: [] }, now: () => 1e12, storage: cs });
  ok('SD25 a stored callsign is clamped on the way OUT as well as on the way in',
    screen2.callsign.length <= 14, `${screen2.callsign.length}`);

  /* ── the resume blob, which is the newest thing under a shared origin's key ──
   * sessionStorage on `<user>.github.io` is shared with every project published under
   * that name, exactly like localStorage above — so what comes back out is rebuilt from
   * a whitelist, and the rejoin button it feeds is asserted on the DOM like every other
   * surface. Built through JSON.parse so `__proto__` is an OWN key, as the wire and the
   * disk really deliver it. */
  const evilResume = `{"token":${JSON.stringify(`${LONG}${String.fromCharCode(0, 7)}${'T'.repeat(200)}`)},`
    + '"code":"ab12c<script>","room":"Night Shift!!",'
    + `"callsign":${JSON.stringify(`${CALLSIGN}${'A'.repeat(300)}`)},`
    + '"atMs":"yesterday","roster":["Vasquez Roster","Drake Roster"],'
    + '"__proto__":{"cdResumePolluted":1}}';
  const rsStore = { getItem: (k) => (k === RESUME_KEY ? evilResume : null), setItem() {}, removeItem() {} };
  const rs = loadResume(rsStore);
  ok('SD26 a poisoned resume blob comes back clamped — token bounded and stripped of control characters',
    !!rs && rs.token.length <= 64 && !(new RegExp('[\u0000-\u001f]')).test(rs.token), rs ? `${rs.token.length}` : 'refused');
  eq('SD27 with exactly the five fields a resume is — a roster smuggled in does not survive',
    Object.keys(rs).sort().join(), 'atMs,callsign,code,room,token');
  ok('SD28 the callsign is the fourteen a client lives under, and the time is a number',
    rs.callsign.length <= 14 && typeof rs.atMs === 'number' && rs.atMs === 0,
    `${rs.callsign.length} / ${JSON.stringify(rs.atMs)}`);
  eq('SD29 and nothing reached Object.prototype on the way', ({}).cdResumePolluted, undefined);
  for (const junk of ['[1,2]', '"a string"', '42', '{"code":"AB12C"}', '{not json']) {
    rsStore.getItem = () => junk;
    if (loadResume(rsStore) !== null) ok(`SD30 a resume blob of the wrong shape is refused outright (${junk.slice(0, 12)})`, false, junk);
  }
  ok('SD30 a resume blob of the wrong shape — array, string, number, tokenless, unparseable — is refused outright', true);
  ok('SD31 and a store that throws yields no resume rather than a crash',
    loadResume({ getItem() { throw new Error('locked'); } }) === null);

  /* The rejoin offer, rendered from the hostile blob. */
  rsStore.getItem = (k) => (k === RESUME_KEY ? evilResume : null);
  const screen4 = new LobbyScreen(screenRoot, {
    net: solo.n, site: { operations: [] }, now: () => 1e12, storage: fake, session: rsStore,
  });
  screen4.show(null);
  ok('SD32 the rejoin button renders the stored callsign as text, not as an element',
    injectedIn(screen4.node) === 0 && !!screen4.node.querySelector('[data-rejoin]'),
    `${injectedIn(screen4.node)} injected`);
  ok('SD33 with the name still legible on the button, so this is escaping and not dropping',
    screen4.node.textContent.includes(CALLSIGN), screen4.node.textContent.slice(0, 120));

  screenRoot.remove();
  emit();
}

/* ── SE. the broker and the room namespace ───────────────────────────────── */
async function sectionSE(content) {
  heading('SE. what a stranger can do with a shared broker');

  /**
   * The volunteer directory runs in a player's browser and takes messages from anybody. Its
   * ADVERT path was already rebuilt from a whitelist and net-tests section O covers that. Its
   * WITHDRAW path was not covered by anything, and it was a delete.
   *
   * ⚠ `dir.withdraw(m.code)` REMOVED WHATEVER ROW THE SENDER NAMED. Every code on the list is
   * printed on the browse screen of everybody who asks for it, so a stranger could read the
   * list and then send one `unadv` per row and empty it — a silent denial of service against
   * every host on the list, from one connection.
   *
   * Driven through the real handler with a fake Peer, because the handler is the fix. A stub
   * is honest here: `_becomeDirectory` touches four methods of a Peer and nothing else.
   */
  const keepPeer = globalThis.Peer;
  const made = [];
  class FakePeer {
    constructor(id) {
      this.id = id; this.open = false; this._h = new Map(); made.push(this);
    }
    on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, []); this._h.get(ev).push(fn); return this; }
    fire(ev, arg) { for (const fn of (this._h.get(ev) || []).slice()) fn(arg); }
    destroy() { this.open = false; }
  }
  const mkConn = () => {
    const h = new Map();
    return {
      sent: [],
      on(ev, fn) { if (!h.has(ev)) h.set(ev, []); h.get(ev).push(fn); return this; },
      fire(ev, arg) { for (const fn of (h.get(ev) || []).slice()) fn(arg); },
      send(m) { this.sent.push(m); },
      close() {},
    };
  };

  try {
    globalThis.Peer = FakePeer;
    const holder = rig(content, { seed: 'se' });
    holder.n.host();
    holder.n.setRoom({ roomName: 'night shift', visibility: VISIBILITY.LISTED });
    ok('SE1 a browser with nobody else holding the list volunteers to hold it', holder.n._becomeDirectory());
    const dirPeer = made[made.length - 1];
    eq('SE2 under the versioned well-known id, so an old build cannot squat the new one',
      dirPeer.id, `${ROOM_PREFIX}directory-1`);
    dirPeer.fire('open');
    ok('SE3 and it now has a directory', !!holder.n.directory);

    const a = mkConn();
    dirPeer.fire('connection', a);
    a.fire('data', { t: MSG.ADVERT, e: { code: 'AAAAA', room: '', label: 'Aisle B', seats: 2, max: 5, phase: 'forming' } });
    const b = mkConn();
    dirPeer.fire('connection', b);
    b.fire('data', { t: MSG.ADVERT, e: { code: 'BBBBB', room: '', label: 'Bay 4', seats: 1, max: 5, phase: 'forming' } });
    eq('SE4 two hosts advertise and both rows are on the list', holder.n.directory.size, 3);

    b.fire('data', { t: MSG.UNADVERT, code: 'AAAAA' });
    eq('SE5 one host cannot withdraw another host\'s row — this emptied the whole list',
      holder.n.directory.size, 3);
    a.fire('data', { t: MSG.UNADVERT, code: 'AAAAA' });
    eq('SE6 but the host that made the claim can withdraw it', holder.n.directory.size, 2);

    const c = mkConn();
    dirPeer.fire('connection', c);
    for (const code of ['BBBBB', 'AAAAA', '', 'R:night-shift', 'night shift']) {
      c.fire('data', { t: MSG.UNADVERT, code });
    }
    ok('SE7 and a connection that advertised nothing can withdraw nothing', holder.n.directory.size >= 2,
      `${holder.n.directory.size}`);

    /* Anything else a stranger can put down that channel. */
    let threw = null;
    try {
      for (const m of [null, 42, 'hello', [], { t: MSG.ADVERT }, { t: MSG.ADVERT, e: 'x' },
        { t: MSG.UNADVERT }, { t: MSG.UNADVERT, code: {} }, { t: 'nonsense' }]) c.fire('data', m);
    } catch (e) { threw = String(e && e.message); }
    ok('SE8 nonsense of every shape leaves the directory holder running', threw === null, threw);

    c.fire('data', { t: MSG.LIST });
    const reply = c.sent[c.sent.length - 1];
    ok('SE9 a joiner asking for the list gets rows back', reply && reply.t === MSG.ROOMS && Array.isArray(reply.r));
    const carried = new Set(reply.r.flatMap((r) => Object.keys(r)));
    ok('SE10 and no row carries a callsign — an advertisement goes to a machine nobody here controls',
      !JSON.stringify(reply.r).toLowerCase().includes('callsign')
      && !JSON.stringify(reply.r).toLowerCase().includes('operative'), [...carried].join());
  } finally {
    globalThis.Peer = keepPeer;
  }

  /**
   * The joiner's end of the same conversation. A directory is a THIRD stranger, and its
   * answer is not trusted either: a row of `null` threw out of the parse, and a NEGATIVE age
   * dated a row into the future where `list()` clamps it to zero and it reads as the freshest
   * room on the page.
   */
  const mirror = new SessionDirectory();
  const now = 1e6;
  mirror.advertise({ code: 'FUTURE', seats: 1, max: 5 }, now + 500000);
  const listed = mirror.list(now);
  ok('SE11 a row dated in the future is shown as fresh, not as negative — clamped, but still a claim',
    listed[0].ageMs === 0, `${listed[0].ageMs}`);
  note('a directory row can only ever be as honest as the host that sent it; the screen prints '
    + 'the age and the word "may be gone" because that is the strongest true statement available');

  /* ── the room namespace itself ── */
  eq('SE12 a room name reduces to the same peer id on every machine, which is what makes it work',
    roomIdFor('  NIGHT   shift!! '), roomIdFor('night-shift'));
  eq('SE13 and it is prefixed, so a broker shared with other projects cannot hand us their tab',
    roomIdFor('night shift').startsWith(ROOM_PREFIX), true);
  eq('SE14 a name that reduces to nothing is not a room', roomIdFor('!!!'), null);
  eq('SE15 a name is bounded, so a peer id cannot be made arbitrarily long', roomSlug('a'.repeat(500)).length, 24);
  eq('SE16 a short name is called guessable to the player\'s face', nameExposure('cold'), 'guessable');
  eq('SE17 a common word is called shared', nameExposure('nightshift'), 'shared');
  eq('SE18 and only a long one with a digit is called unlikely', nameExposure('nightshift7'), 'unlikely');
  note('ACCEPTED AND STATED: the room namespace IS the public broker. Anybody who types the '
    + 'same word reaches the same room, a name can be squatted before a host claims it, and '
    + 'this build cannot prevent either. `_hostBlock` prints the exposure word beside the '
    + 'field and `hostPeer` says "already in use on the broker" rather than "code taken", '
    + 'because those are different facts.');
  note('NOT FIXED, AND NOT FIXABLE HERE: a peer that reaches the room id first IS the host. '
    + 'There is no identity on this transport, so "impersonating the host" is not a defect '
    + 'in this code — it is what a broker without accounts means. The defence that does '
    + 'exist is that a host can no longer do anything to a client\'s browser but show it '
    + 'text: every field they send is bounded and escaped (sections SB and SC).');
  emit();
}

/* ── SF. what a client can make the host do ──────────────────────────────── */
async function sectionSF(content) {
  heading('SF. host authority: what a client may ask for, and how often');

  const host = rig(content, { seed: 'sf' });
  host.n.host();
  host.g.commitLoadout(RECOMMENDED_MANIFEST);
  const c1 = mkClient(content, { seed: 'sf-c' });
  const { cl } = seatOn(host, c1, 'Ordinary');
  const seatId = c1.n.localPlayerId;

  /* ── host-only verbs ── */
  eq('SF1 a client cannot choose the operation', c1.n.selectOperation({ id: 'x', label: 'x' }), false);
  eq('SF2 a client cannot deploy the lobby', c1.n.deployLobby(), false);
  eq('SF3 a client cannot remove a seat', c1.n.removeSeat('p1', 'conduct'), null);
  eq('SF4 a client cannot readmit one', c1.n.readmitSeat('any-token'), null);
  eq('SF5 a client cannot broadcast a roster', c1.n._broadcastLobby(), 0);
  const hostSeats = host.n.lobby.size;
  cl.send({ t: MSG.LOBBY, v: PROTOCOL_VERSION, ph: 'deployed', st: [{ i: 'p9', n: 'ghost', f: 7 }] });
  cl.send({ t: MSG.KICK, why: 'conduct' });
  cl.send({ t: MSG.SNAP, v: PROTOCOL_VERSION, ps: [] });
  cl.send({ t: MSG.WELCOME, v: PROTOCOL_VERSION, id: 'p1' });
  eq('SF6 and a host ignores a client that sends a message only a host may send', host.n.lobby.size, hostSeats);
  eq('SF7 including one that would have put a ghost on the roster', host.n.lobby.seatOf('p9'), null);

  /**
   * ⚠ ONE CONNECTION COULD TAKE THE WHOLE SQUAD. Nothing checked whether a link already held
   * a seat and `_hostHello` allocates unconditionally, so a modified client that sent HELLO
   * five times got five operatives, five sets of kit, and every remaining slot — and the
   * board then said "full" to everybody real. Invisible from the host's own roster, because
   * `_seatOf` returns the first match and an honest client sends exactly one.
   */
  const seatsBefore = host.g.players.length;
  for (let i = 0; i < 8; i++) cl.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: `Clone ${i}` });
  eq('SF8 a second HELLO on a link that already holds a seat takes no second seat',
    host.g.players.length, seatsBefore);
  ok('SF9 and it is recorded against them rather than silently dropped', host.n.malformed >= 8,
    `${host.n.malformed}`);

  /* ── the replay guard ── */
  const dup = mkClient(content, { seed: 'sf-d' });
  const d = seatOn(host, dup, 'Repeater');
  const before = host.n.actsReceived;
  d.cl.send({ t: MSG.ACT, k: ACT.SLOT, n: 1 });
  d.cl.send({ t: MSG.ACT, k: ACT.SLOT, n: 1 });
  eq('SF10 an ACT with no sequence number at all is dropped — the guard was skippable by omitting the field',
    host.n.actsReceived, before);
  d.cl.send({ t: MSG.ACT, sq: null, k: ACT.SLOT, n: 1 });
  d.cl.send({ t: MSG.ACT, sq: 'nine', k: ACT.SLOT, n: 1 });
  d.cl.send({ t: MSG.ACT, sq: [], k: ACT.SLOT, n: 1 });
  eq('SF11 nor does null, a string or an array count as a sequence number, because JSON has no NaN',
    host.n.actsReceived, before);
  d.cl.send({ t: MSG.ACT, sq: 5, k: ACT.SLOT, n: 1 });
  eq('SF12 a real one is taken', host.n.actsReceived, before + 1);
  d.cl.send({ t: MSG.ACT, sq: 5, k: ACT.SLOT, n: 2 });
  d.cl.send({ t: MSG.ACT, sq: 3, k: ACT.SLOT, n: 2 });
  eq('SF13 and a repeat or a stale one is not', host.n.actsReceived, before + 1);

  /* ── the ACT budget ──
   * ⚠ THERE WAS NOT ONE. `_hostLobbyAct` was rate-limited with a comment about a client that
   * holds the ready key down; `_hostAct` — which walks the floor's blocking rects, commits
   * and aborts procedures and moves the mission phase — had no limit at all. §20.9 asks for
   * "rate-limit interaction and chat events" and only the second half was done. */
  const flood = mkClient(content, { seed: 'sf-f' });
  const f = seatOn(host, flood, 'Flooder');
  const gotBefore = host.n.actsReceived;
  for (let i = 1; i <= 400; i++) f.cl.send({ t: MSG.ACT, sq: i, k: ACT.INTERACT });
  const got = host.n.actsReceived - gotBefore;
  ok('SF14 four hundred discrete actions in one frame do not all reach the simulation',
    got <= ACT_BURST, `${got} of 400 applied`);
  ok('SF15 and the rest are counted as a flood rather than silently swallowed',
    host.n.actsFlooded >= 400 - ACT_BURST, `${host.n.actsFlooded}`);
  note(`ACT budget: ${got} of 400 applied in one frame, ${host.n.actsFlooded} refused, `
    + `burst ${ACT_BURST}, refill ${ACT_PER_SEC}/s`);
  host.tick(1000);
  const afterRefill = host.n.actsReceived;
  for (let i = 401; i <= 500; i++) f.cl.send({ t: MSG.ACT, sq: i, k: ACT.INTERACT });
  const refilled = host.n.actsReceived - afterRefill;
  near('SF16 a second of wall clock buys back exactly the refill rate and no more', refilled, ACT_PER_SEC, 1);
  ok('SF17 and the flood is on the host\'s moderation record, which is what it is for',
    host.n.lobby.bySeat(flood.n.localPlayerId).some((e) => e.kind === 'flood'));

  /* ⚠ A BUDGET SPENT BY ONE SEAT MUST NOT BE A BUDGET SPENT BY ANOTHER. It is keyed on the
   * seat, which is the link's, so nothing a client sends decides which bucket it drains. */
  const spare = host.n.actsReceived;
  d.cl.send({ t: MSG.ACT, sq: 99, k: ACT.SLOT, n: 3 });
  eq('SF18 and a seat that has not flooded is unaffected by one that has', host.n.actsReceived, spare + 1);

  /* ── the lobby budget's bounds ── */
  const lb = new Lobby({});
  let allowed = 0;
  for (let i = 0; i < 100; i++) if (lb.charge('p2', 0)) allowed++;
  eq('SF19 the lobby bucket is exactly its burst, not one more', allowed, lb.floodBudget);
  eq('SF20 and a second buys back exactly the refill', [...Array(20)].filter(() => lb.charge('p2', 1000)).length,
    lb.floodPerSec);
  ok('SF21 a seat that never spends anything is never charged for time it did not use',
    lb.charge('p3', 0) && lb.charge('p3', 0));

  /* ── the procedure card ── */
  const p = mkClient(content, { seed: 'sf-p' });
  const pl = seatOn(host, p, 'Planner');
  pl.cl.send({
    t: MSG.ACT,
    sq: 1,
    k: ACT.PROCEDURE,
    card: JSON.parse(`{"target":"${'x'.repeat(900)}","state":5,"trigger":null,`
      + '"transfer":{"a":1},"abort":["x"],"maintained":"everything","junk":"kept?",'
      + '"__proto__":{"cdCardPolluted":1}}'),
  });
  const card = host.g.mission.procedure;
  ok('SF22 a client may commit a procedure — it is the squad\'s card, not the host\'s', !!card);
  ok('SF23 but only the fields a card has', card.junk === undefined, Object.keys(card).join());
  ok('SF24 with every one of them bounded', card.target.length <= 160, `${card.target.length}`);
  ok('SF25 and a field of the wrong type becomes empty rather than the type', card.state === '', JSON.stringify(card.state));
  ok('SF26 the maintained list is a list', Array.isArray(card.maintained), JSON.stringify(card.maintained));
  eq('SF27 and nothing in it reached Object.prototype', ({}).cdCardPolluted, undefined);

  /* ── the hypothesis board ── */
  const claimId = host.g.ledger.claims[0].id;
  pl.cl.send({ t: MSG.ACT, sq: 2, k: ACT.CLAIM, id: claimId, v: { evil: true } });
  ok('SF28 a claim state is one of two words or nothing, never an object a client chose',
    host.g.ledger.claimState.get(claimId) === null, JSON.stringify(host.g.ledger.claimState.get(claimId)));
  pl.cl.send({ t: MSG.ACT, sq: 3, k: ACT.CLAIM, id: claimId, v: 'believed' });
  eq('SF29 and a real one is taken', host.g.ledger.claimState.get(claimId), 'believed');
  const boardSize = host.g.ledger.claimState.size;
  pl.cl.send({ t: MSG.ACT, sq: 4, k: ACT.CLAIM, id: '__proto__', v: 'believed' });
  pl.cl.send({ t: MSG.ACT, sq: 5, k: ACT.CLAIM, id: 'not-a-claim', v: 'believed' });
  eq('SF30 a claim the board does not have does not become one', host.g.ledger.claimState.size, boardSize);
  eq('SF31 and __proto__ is not a claim', ({}).believed, undefined);

  /* ── acting for somebody else ──
   * The seat is the LINK's, never a field of the message, which is what makes spoofing
   * impossible by construction rather than by validation. Asserted, because "by
   * construction" is a claim like any other. */
  const others = host.g.players.filter((q) => q.id !== p.n.localPlayerId);
  const beforeSlots = others.map((q) => q.heldSlot);
  pl.cl.send({ t: MSG.ACT, sq: 6, k: ACT.SLOT, n: 4, id: 'p1', owner: 'p1', seat: 'p1' });
  eq('SF32 a client naming another seat in its own message still acts only on its own',
    others.map((q) => q.heldSlot).join(), beforeSlots.join());
  const pingBefore = host.g.comms.list.length;
  const me = host.g.playerById(p.n.localPlayerId);
  pl.cl.send({
    t: MSG.ACT, sq: 7, k: ACT.PING, p: WHEEL_ORDER[0], owner: 'p1', id: 'p1',
    x: Math.round(me.x * 100), z: Math.round(me.z * 100),
  });
  const added = host.g.comms.list.slice(pingBefore);
  ok('SF33 and a callout is stamped with the seat the link is in, whatever the message claims',
    added.every((q) => q.owner === p.n.localPlayerId), JSON.stringify(added.map((q) => q.owner)));

  /* ── a phrase id that is not one ── */
  pl.cl.send({ t: MSG.ACT, sq: 8, k: ACT.PING, p: 'constructor', x: 0, z: 0 });
  pl.cl.send({ t: MSG.ACT, sq: 9, k: ACT.PING, p: '__proto__', x: 0, z: 0 });
  pl.cl.send({ t: MSG.ACT, sq: 10, k: ACT.PING, p: { a: 1 }, x: null, z: null });
  ok('SF34 a callout naming a reserved key is refused, not put on the board as a blank marker',
    host.g.comms.list.every((q) => WHEEL_ORDER.includes(q.phrase)),
    JSON.stringify(host.g.comms.list.map((q) => q.phrase)));

  /* ── the cargo ── */
  const cacheBefore = JSON.stringify([...host.g.cache.entries()].sort());
  pl.cl.send({ t: MSG.ACT, sq: 11, k: ACT.TAKE, id: '__proto__' });
  pl.cl.send({ t: MSG.ACT, sq: 12, k: ACT.TAKE, id: { a: 1 } });
  pl.cl.send({ t: MSG.ACT, sq: 13, k: ACT.TAKE, id: 'a-thing-that-is-not-real' });
  eq('SF35 a client cannot take an item the manifest does not have',
    JSON.stringify([...host.g.cache.entries()].sort()), cacheBefore);

  ok('SF36 the host is still hosting after all of that', host.n.role === ROLE.HOST);
  ok('SF37 and still sending snapshots', (() => {
    const s = c1.n.snapsReceived;
    host.n.pump(200, null);
    return c1.n.snapsReceived > s;
  })(), `${c1.n.snapsReceived}`);

  /* ── a resume token is a string this host issued, or it is nothing ────────
   * The resume path hands back a seat WITH KIT, which makes the token the most valuable
   * field in the hello — so its guard gets the same treatment the sequence number got:
   * every wrong shape is treated as ABSENT, looked up never, and lands on the ordinary
   * join path. A fresh rig, because the shared one above is deliberately full. */
  const tiny = rig(content, { seed: 'sf-token' });
  tiny.n.host();
  tiny.g.commitLoadout(RECOMMENDED_MANIFEST);
  const shapes = [{ deep: true }, 42, ['t'], 'T'.repeat(65)];
  for (const tok of shapes) {
    const [th, tc] = loopbackPair();
    tiny.n.accept(th);
    tc.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: 'Shape', token: tok });
  }
  eq('SF38 a token of the wrong shape — object, number, array, or over 64 characters — is treated as absent and buys a fresh seat, not a lookup',
    tiny.g.players.length, 1 + shapes.length);
  ok('SF39 and none of them read as a resume — nothing on the record says anybody came back',
    !tiny.n.lobby.log.some((e) => e.kind === 'resumed'), tiny.n.lobby.log.map((e) => e.kind).join());

  /* The squad is now full, so a well-formed token the host never issued meets the gate
   * every stranger meets. A 64-character string is the largest thing the guard admits to
   * the lookup, and the lookup owes it nothing. */
  let tokenHeard = '';
  const [fh, fc] = loopbackPair();
  tiny.n.accept(fh);
  fc.onMessage = (m) => { tokenHeard = m.why || m.t; };
  fc.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, name: 'Sixth', token: 'T'.repeat(64) });
  ok('SF40 a well-formed token this host never issued is not a skeleton key — the full-squad refusal stands',
    /full/i.test(tokenHeard), tokenHeard);
  note(`host counters after the section: ${host.n.malformed} unreadable, `
    + `${host.n.actsRefused} refused, ${host.n.actsDropped || 0} stale, ${host.n.actsFlooded} flooded`);
  emit();
}

/* ── SH. the sinks, demonstrated ─────────────────────────────────────────── */
async function sectionSH() {
  heading('SH. the expressions that were there before, run in a detached node');

  /**
   * ⚠ THIS SECTION EXISTS SO THE ONES ABOVE CANNOT PASS VACUOUSLY.
   *
   * "The debrief injects nothing" also passes on a build where the debrief prints nothing,
   * or where the payload was never markup, or where the message key never resolved. So each
   * assertion below takes the EXACT EXPRESSION THAT WAS IN THE FILE BEFORE THIS MILESTONE,
   * runs it against the same payload in a detached element, and asserts that it DOES inject.
   *
   * Nothing here reaches shipped code — these are string templates, not the functions — but
   * they are copied character for character from what `git log` will show was there. If
   * somebody "tidies" an `escapeHtml` back out of hud.js or panels.js, the paired assertion
   * above fails and this one still passes, and the diff between them is the whole report.
   */
  const box = mount();
  const shows = (html) => { box.innerHTML = html; return injectedIn(box); };

  /* hud.js `_objective`, then `_set('tr', this.topRight, …)`.
   *   WAS: if (carrier) return t('hud.objective.carrierHas', { name: carrier.name });
   *   NOW: …{ name: escapeHtml(carrier.name) } */
  const carrierLine = (name) => `<div class="obj-title">Primary</div><div class="obj">${
    msgFor('hud.objective.carrierHas', { name })}</div>`;
  ok('SH1 the OLD objective line puts an element in the DOM from a fourteen-character callsign',
    shows(carrierLine(CALLSIGN)) >= 1, `${shows(carrierLine(CALLSIGN))} elements`);
  eq('SH2 and the line as it is written now does not', shows(carrierLine(escapeHtml(CALLSIGN))), 0);

  /* panels.js `showDebrief`, the dimension rows.
   *   WAS: `<li><b>${d.name}</b><span class="w">${d.word}</span>…`
   *   NOW: escapeHtml on both. */
  const dimRow = (name, word) => `<li><b>${name}</b><span class="w">${word}</span></li>`;
  ok('SH3 the OLD debrief dimension row injects from a host-supplied name',
    shows(dimRow(LONG, 'x')) >= 1, `${shows(dimRow(LONG, 'x'))}`);
  eq('SH4 and the row as it is written now does not', shows(dimRow(escapeHtml(LONG), 'x')), 0);

  /**
   * ⚠ AND THE WORST ONE, WHICH IS WORTH SPELLING OUT BECAUSE IT LOOKS SAFE.
   *
   * `msg('grade.' + result.overall)` reads like a lookup against a closed vocabulary. It is
   * not: `t()` RETURNS THE KEY when it does not recognise it — deliberately, so a missing
   * translation is loud rather than blank — so an unknown `overall` comes back out of the
   * message table as `grade.<whatever the host sent>`, with the payload intact, and goes
   * into `<h1>${title}</h1>`. Escaping the callsign would never have found this, because
   * there is no callsign on the path.
   */
  const graded = msgFor(`grade.${LONG}`);
  ok('SH5 an unknown message key comes back out of the table carrying the whole payload',
    graded.includes(LONG), graded.slice(0, 80));
  const title = (g) => `<div class="sheet"><header><h1>${msgFor('debrief.screen.title', { grade: g })}</h1></header></div>`;
  ok('SH6 so the OLD debrief title injects, from a field with no free text anywhere near it',
    shows(title(graded)) >= 1, `${shows(title(graded))}`);
  eq('SH7 and the title as it is written now does not', shows(title(escapeHtml(graded))), 0);
  ok('SH8 which is why the wire layer refuses it as well: a grade is an id or it is not one',
    safeId(LONG) === null && safeId('Exemplary') === 'Exemplary');

  /* The same for the phase, which reaches two screens by the same route. */
  const phase = msgFor(`phase.${LONG}`);
  ok('SH9 a phase off the wire does the same through t(`phase.${x}`)', phase.includes(LONG), phase.slice(0, 60));
  eq('SH10 and is refused at the wire before either screen sees it',
    snapshotProblem({ t: MSG.SNAP, v: PROTOCOL_VERSION, ms: 0, ph: LONG }), 'ph is not a phase id');

  /**
   * ⚠ AND THE PROTOTYPE POLLUTION, WHICH IS FOUR LINES AND WAS EXACTLY `setPath`.
   *
   * `patch()` walked a parsed save with `Object.entries`, which hands over `__proto__` as an
   * own key; the path came out as `__proto__.x`; and this loop DESCENDED INTO
   * `Object.prototype` and assigned to it. Reproduced here, then cleaned up, so the claim in
   * SD1-SD6 is a measurement rather than an assertion about an intention.
   */
  const oldSetPath = (obj, path, value) => {
    const keys = path.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
    return obj;
  };
  try {
    oldSetPath({}, '__proto__.cdOldPathProof', 1);
    eq('SH11 the OLD setPath really did write to Object.prototype from a settings path', ({}).cdOldPathProof, 1);
  } finally {
    delete Object.prototype.cdOldPathProof;
  }
  eq('SH12 and it is gone again, so nothing after this section is running on a polluted page',
    ({}).cdOldPathProof, undefined);

  /* ⚠ `PHRASES[phrase]` AS A MEMBERSHIP TEST, which is what `comms.decode` guarded with. */
  const table = Object.freeze({ contact: 1 });
  ok('SH13 a plain object says yes to "constructor", which is why the comms guard let it through',
    !!table.constructor && !table.nonsense);
  ok('SH14 and the check that actually answers the question says no',
    !Object.prototype.hasOwnProperty.call(table, 'constructor'));

  box.remove();
  emit();
}

/* ── SG. what none of this proves ────────────────────────────────────────── */
async function sectionSG() {
  heading('SG. the honest limits of this suite');

  /**
   * m0-tests and net-tests both end with a section like this, for the reason this project
   * has already paid for once: `applySnapshot` replaced the client's notice list with the
   * host's and destroyed every refusal about eighty milliseconds after it arrived, and no
   * loopback test could find it because reading a notice immediately always finds it.
   *
   * The security version of that question is "what is only wrong ACROSS TIME", and there are
   * three answers this suite cannot reach.
   */
  ok('SG1 a loopback delivers synchronously, so nothing here proves a defence still holds '
    + 'across a real 80ms round trip — the class of bug this project actually shipped', true);
  ok('SG2 the ACT and lobby budgets are driven by an injected clock; in the shipped build '
    + 'they refill on WALL time, and a machine that sleeps and wakes hands a seat a full '
    + 'bucket. That is correct and it is also not measured here', true);
  ok('SG3 nothing here runs a real WebRTC data channel, so PeerJS\'s own parsing — which '
    + 'sees the bytes before `onMessage` does — is out of scope and untested by anything '
    + 'in this repo', true);
  ok('SG4 assertions are on ELEMENTS entering the DOM, not on whether a handler fired. A '
    + 'payload that needs no element at all — a `javascript:` href, a CSS injection through '
    + 'a style attribute — would not be caught by `injectedIn`, and the defence against '
    + 'those is that no interpolation in this build writes a bare attribute value', true);

  /* Which is a claim, so it is checked. Every attribute in the four files this milestone
   * touched is double-quoted, which is what makes escaping `"` sufficient — and the escaper
   * now handles `'` anyway, so the convention is no longer load-bearing. */
  eq('SG5 the escaper handles the apostrophe as well as the four it always did',
    escapeHtml(`<a href='x'>&"`), '&lt;a href=&#39;x&#39;&gt;&amp;&quot;');
  eq('SG6 and it is not the only layer: a wire string used as a message key is refused at the wire',
    safeId('<img src=x>'), null);
  eq('SG7 with the reserved names refused by name, because PHRASES.constructor is truthy',
    [safeId('constructor'), safeId('__proto__'), safeId('toString')].join(), ',,');
  eq('SG8 while prose is bounded rather than alphabet-restricted, because clipping an '
    + 'apostrophe out of "Contractors\' store" is a worse bug than the one it prevents',
    safeLine("Contractors' store", 64), "Contractors' store");

  note('ACCEPTED AND STATED, NOT BUGS: (1) the room namespace is the whole public broker — '
    + 'anybody who types the word reaches the room, and the UI prints the exposure word. '
    + '(2) A directory row is an unverified claim and the screen says so on every row. '
    + '(3) A removal block is keyed to a token this host issued, so a reload defeats it — '
    + 'the lobby calls it a block for this session and refuses to call it a ban.');
  note('NOT FIXED: a host can still overwrite another host\'s directory ROW (the withdraw '
    + 'path is now scoped to the connection that claimed it; the advertise path cannot be, '
    + 'because an advertisement is also the heartbeat that keeps a row alive). The row is '
    + 'already documented as an unverified claim, so this changes a lie nobody believed.');
  emit();
}

/* ── run ─────────────────────────────────────────────────────────────────── */
await suite('security-tests', async () => {
  const content = await loadContent({ incident: 'cold-storage-draught' });
  await run('SA', () => sectionSA(content));
  await run('SB', () => sectionSB(content));
  await run('SC', () => sectionSC(content));
  await run('SD', () => sectionSD());
  await run('SE', () => sectionSE(content));
  await run('SF', () => sectionSF(content));
  await run('SH', () => sectionSH());
  await run('SG', () => sectionSG());
});
