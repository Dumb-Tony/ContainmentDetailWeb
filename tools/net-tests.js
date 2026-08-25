/* Milestone 4 — the session lobby, moderation, and what the wire will actually carry.
 *
 * GDD §23's Milestone 4 asks for "hosted sessions, reconnect, profiles, and matchmaking".
 * Reconnect and profiles shipped; hosted sessions and matchmaking did not, and §24 lists
 * "players grief mission-critical procedures" as a HIGH risk whose mitigation is "server
 * validation, recoverable unique items, action logs, moderation, and public-lobby
 * controls" — where the last two did not exist at all.
 *
 * This suite is written against the two claims that are easy to make and hard to keep:
 *
 *   1. THE UI MAY NOT CLAIM MORE THAN THE TRANSPORT DELIVERS (§18.1). There is no game
 *      server. Everything discovery does here is one of three things — a deterministic
 *      rendezvous id, a list held in a stranger's browser, or the joiner's own memory —
 *      and sections O and T are about making the difference between them structural
 *      rather than a promise in a comment.
 *
 *   2. A REMOVAL MUST NOT DESTROY ANYTHING. §11.7 wants "recovery of deliberately
 *      discarded unique items" and §11.5 already forces a dropped operative to put custody
 *      down rather than take it offline. Section P asserts the moderation path obeys the
 *      same rule, because a host who can delete the transit case is a worse griefer than
 *      the one they removed.
 *
 * Section R prints MEASURED numbers rather than asserting remembered ones, in the manner
 * of m0-tests sections C and E: how many bytes a snapshot is, per seat, at what rate, and
 * where a narrow wire stops keeping up. Section T is the honest ledger of what none of
 * this proves.
 */

import { lines, counts, ok, eq, near, note, emit, run, heading, suite } from './harness.js';

import { CONFIG } from '../src/config.js';
import { loadContent } from '../src/sim/content.js';
import { Game, RECOMMENDED_MANIFEST, EVENTS } from '../src/game.js';
import { PHASE } from '../src/sim/mission.js';
import { NetSession, loopbackPair, ROLE } from '../src/net/net.js';
import {
  MSG, ACT, LACT, PROTOCOL_VERSION, MAX_SQUAD,
  encodeSnapshot, encodeCommand, encodeLobby, applyLobby, applySnapshot,
} from '../src/net/protocol.js';
import {
  Lobby, SessionDirectory, LOBBY_PHASE, VISIBILITY, LOG_KIND, LOG_WORDS, REMOVAL_REASONS,
  DEFAULT_REASON, ADVERT_FIELDS, roomIdFor, roomIdForCode, roomSlug, nameExposure,
} from '../src/net/lobby.js';
import {
  ago, loadRecent, rememberRoom, LobbyScreen,
  loadResume, saveResume, clearResume, RESUME_KEY,
} from '../src/ui/lobby.js';

/* ── rigging ─────────────────────────────────────────────────────────────────
 * A session with a controllable clock. The lobby is timed against WALL time in the shipped
 * build (`main.js` injects it) because the mission clock is paused behind an open panel —
 * so every test here injects a clock it can move by hand, which is the whole reason the
 * clock is injected rather than read.
 */
function rig(content, { seed = 'lobby', hz = 12 } = {}) {
  const clock = { ms: 0 };
  const g = new Game(content, { seed });
  const n = new NetSession(g, { snapshotHz: hz, now: () => clock.ms });
  return { g, n, clock, tick: (ms) => { clock.ms += ms; } };
}

function mkClient(content, { seed = 'lobby-c' } = {}) {
  const clock = { ms: 0 };
  const g = new Game(content, { seed });
  const n = new NetSession(g, { now: () => clock.ms });
  return { g, n, clock };
}

/** Seat a client on a host and return both halves plus the two endpoints. */
function seatOn(host, client, name, opts = {}) {
  const [hl, cl] = loopbackPair(opts);
  host.n.accept(hl);
  client.n.join(cl, { name });
  return { hl, cl };
}

/* ── N. the lobby's own state ────────────────────────────────────────────── */
async function sectionN(content) {
  heading('N. who is in the room, in which seat, going where');

  const host = rig(content);
  host.n.host();
  eq('N1 a host has one seat the moment they are a host', host.n.lobby.size, 1);
  ok('N2 and it is theirs, and it is marked as the host\'s',
    host.n.lobby.seatOf('p1') && host.n.lobby.seatOf('p1').host === true);

  const c1 = mkClient(content);
  seatOn(host, c1, 'Vasquez');
  eq('N3 a joiner takes a lobby seat as well as a place on the roster', host.n.lobby.size, 2);
  eq('N4 under the callsign they asked for', host.n.lobby.seatOf('p2').callsign, 'Vasquez');
  eq('N5 the client is told about the room without having to ask for it', c1.n.lobby.size, 2);
  eq('N6 and its copy names the same seats', [...c1.n.lobby.seats.keys()].join(), 'p1,p2');
  eq('N7 including which one is the host\'s', c1.n.lobby.seatOf('p1').host, true);

  /* ── ready ── */
  ok('N8 a squad with no operation is not ready, whatever anybody says',
    (host.n.setReady('p1', true), c1.n.askReady(true), host.n.lobby.squadReady === false));
  host.n.selectOperation({ id: 'op-cold-storage-2', label: 'Cold storage, level 2', incident: 'cold-storage-draught' });
  ok('N9 choosing an operation does not by itself make a squad ready', !host.n.lobby.squadReady);
  host.n.setReady('p1', true);
  ok('N10 nor does the host alone, while somebody else is on the radio', !host.n.lobby.squadReady);
  c1.n.askReady(true);
  ok('N11 every connected seat saying ready is what makes it ready', host.n.lobby.squadReady);
  eq('N12 and the lobby says so in its own phase', host.n.lobby.phase, LOBBY_PHASE.READY);
  eq('N13 which the client is told about too', c1.n.lobby.phase, LOBBY_PHASE.READY);

  /**
   * ⚠ CHANGING THE OPERATION CLEARS EVERY READY. A ready is a statement about a specific
   * job, and a host who can swap the job under a squad that has already agreed has a
   * griefing tool rather than a lobby — the squad arrives at a loadout screen for a
   * mission nobody said yes to.
   */
  host.n.selectOperation({ id: 'op-cold-storage-figure', label: 'Cold storage, aisle B', incident: 'cold-storage-figure' });
  ok('N14 changing the operation clears every ready', !host.n.lobby.squadReady
    && [...host.n.lobby.seats.values()].every((s) => !s.ready));
  eq('N15 and the client sees its own switch go back off', c1.n.lobby.seatOf('p2').ready, false);
  ok('N16 re-selecting the SAME operation is not a change and clears nothing',
    (host.n.setReady('p1', true),
    host.n.selectOperation({ id: 'op-cold-storage-figure', label: 'Cold storage, aisle B' }),
    host.n.lobby.seatOf('p1').ready === true));

  /* ── a radio that dies ── */
  c1.n.askReady(true);
  ok('N17 the squad is ready again, so the next assertion is not vacuous', host.n.lobby.squadReady);
  const drop = mkClient(content, { seed: 'drop' });
  const dl = seatOn(host, drop, 'Drake');
  drop.n.askReady(true);
  eq('N18 a third seat joins the room', host.n.lobby.size, 3);
  dl.hl.close();
  eq('N19 a seat that loses the radio keeps its row (§11.5)', host.n.lobby.size, 3);
  eq('N20 marked off the radio', host.n.lobby.seatOf('p3').connected, false);
  /* ⚠ AND LOSES ITS READY WITH IT. "Ready" was a statement about being at the keyboard.
   * A lobby that counts a disconnected seat as ready deploys one operative short and the
   * squad finds out on the floor. */
  eq('N21 and loses its ready, because ready meant "I am at the keyboard"',
    host.n.lobby.seatOf('p3').ready, false);
  ok('N22 the squad is still ready, because readiness is about who is ON the radio',
    host.n.lobby.squadReady);

  /* ── deploy ── */
  ok('N23 the squad takes the operation', host.n.deployLobby());
  eq('N24 and the lobby closes behind them', host.n.lobby.phase, LOBBY_PHASE.DEPLOYED);
  ok('N25 but the JOIN gate does not — §11.5 keeps it open until the procedure commits',
    !host.g.mission.atLeast(PHASE.PROCEDURE_COMMITTED));
  const late = mkClient(content, { seed: 'late' });
  seatOn(host, late, 'Late');
  ok('N26 so somebody can still join a deployed lobby', late.n.localPlayerId !== 'p1'
    && !!host.g.playerById(late.n.localPlayerId), late.n.status);

  /* ── the broadcast cadence ── */
  const before = host.n.lobbyBroadcasts;
  host.g.commitLoadout(RECOMMENDED_MANIFEST);
  for (let i = 0; i < 120; i++) host.n.pump(16.7, null);
  eq('N27 a lobby is broadcast on CHANGE and never on the snapshot cadence',
    host.n.lobbyBroadcasts - before, 0);
  ok('N28 while snapshots went out over the same two seconds', host.n.seats.size > 0
    && [...host.n.seats.values()].some((s) => s.link.sent > 10));

  /**
   * ⚠ A CLIENT NEVER WRITES ITS OWN READY FLAG.
   *
   * An optimistic local toggle looks instant and is correct for exactly as long as it
   * takes the host's next broadcast to arrive, at which point `applyLobby` replaces the
   * seat map and the switch flips back under the player's finger. That is the same shape
   * as the destroyed-refusal bug this project already shipped, in a control the player is
   * actively looking at — so the client asks, and the host's echo is the only thing that
   * moves it. Asserted across a SLOW link, because over a synchronous loopback an
   * optimistic write and a correct one are indistinguishable.
   */
  const slowHost = rig(content, { seed: 'slow-h' });
  slowHost.n.host();
  slowHost.n.selectOperation({ id: 'op-1', label: 'Op' });
  const queue = [];
  const slowClient = mkClient(content, { seed: 'slow-c' });
  seatOn(slowHost, slowClient, 'Slow', { schedule: (fn) => queue.push(fn) });
  while (queue.length) queue.shift()();                 // let the handshake finish
  eq('N29 the slow client is seated, so the next assertion is about latency and not failure',
    slowClient.n.lobby.size, 2);
  slowClient.n.setReady(slowClient.n.localPlayerId, true);
  eq('N30 asking to be ready does NOT flip the client\'s own switch',
    slowClient.n.lobby.seatOf(slowClient.n.localPlayerId).ready, false);
  while (queue.length) queue.shift()();
  eq('N31 the host\'s echo is what flips it',
    slowClient.n.lobby.seatOf(slowClient.n.localPlayerId).ready, true);
  emit();
}

/* ── O. discovery, and exactly how much of it is real ────────────────────── */
async function sectionO() {
  heading('O. what a broker with no directory can honestly be asked');

  /* ── the rendezvous id ── */
  const ids = ['Night Shift', 'night-shift', '  NIGHT   SHIFT  ', 'Night, Shift!'].map(roomIdFor);
  note(`four spellings of one room name: ${[...new Set(ids)].join(' / ')}`);
  eq('O1 every plausible spelling of a room name reaches one id', new Set(ids).size, 1);
  eq('O2 and it is derived, not stored — the same word gives the same id on every machine',
    roomIdFor('night shift'), 'cdw-r-night-shift');
  eq('O3 a name that reduces to nothing is refused rather than becoming the prefix',
    roomIdFor('...'), null);
  eq('O4 and so is an empty one', roomIdFor(''), null);
  /* ⚠ A CODE AND A NAME MUST NOT SHARE A NAMESPACE, or a squad meeting on the word
   * "ABCDE" collides with whoever was randomly issued the code ABCDE. */
  ok('O5 a code and a room name spelled the same are different rooms',
    roomIdForCode('ABCDE') !== roomIdFor('ABCDE'), `${roomIdForCode('ABCDE')} vs ${roomIdFor('ABCDE')}`);
  ok('O6 a slug is capped, so a peer id cannot be made arbitrarily long',
    roomSlug('x'.repeat(200)).length <= 24, `${roomSlug('x'.repeat(200)).length}`);
  ok('O7 and never ends in a separator', !roomSlug('night shift ---').endsWith('-'));

  /**
   * §18.1: the UI distinguishes observed fact from interpretation. How guessable a name is
   * IS an interpretation, so it is a word rather than a score and the screen prints it
   * next to the field instead of silently accepting "cd" as a room name.
   */
  eq('O8 a short room name is called guessable, in words', nameExposure('op'), 'guessable');
  eq('O9 a common word is called shared', nameExposure('nightshift'), 'shared');
  eq('O10 and only a long name with a digit in it is called unlikely',
    nameExposure('nightshift-19b7'), 'unlikely');
  eq('O11 no name at all is its own case', nameExposure(''), 'none');

  /* ── the volunteer directory ──────────────────────────────────────────────
   * Everything arriving here comes from a machine nobody in this session has met. */
  const dir = new SessionDirectory({ staleMs: 30000, dropMs: 90000, max: 4 });
  const good = dir.advertise({ code: 'AB12C', label: 'Cold storage, level 2', seats: 2, max: 5, phase: 'forming' }, 1000);
  ok('O12 a well-formed advertisement is taken', !!good);
  eq('O13 and reduced to exactly the fields a listing is allowed to carry',
    Object.keys(good).sort().join(), ADVERT_FIELDS.slice().sort().join());

  /**
   * ⚠ THE ENTRY IS REBUILT FROM A WHITELIST, NEVER SPREAD. `{ ...raw }` is the line that
   * looks like tidying and is the line that lets a host put a callsign, a URL or a script
   * fragment into every joiner's directory. Six hostile fields, one at a time.
   */
  const nasty = dir.advertise({
    code: '<script>x</script>AB', label: 'Room' + String.fromCharCode(0, 27, 7) + 'with control chars' + '!'.repeat(80),
    seats: 99999, max: 400, phase: 'pwned',
    callsign: 'Vasquez', href: 'https://elsewhere.example', extra: { deep: true },
  }, 2000);
  note(`hostile advertisement came back as ${JSON.stringify(nasty)}`);
  ok('O14 a code is stripped to the characters a peer id can hold', /^[A-Z0-9-]*$/.test(nasty.code), nasty.code);
  ok('O15 a label is stripped of control characters', !(new RegExp('[\u0000-\u001f]')).test(nasty.label), JSON.stringify(nasty.label));
  ok('O16 and clamped to a length a row can print', nasty.label.length <= 40, `${nasty.label.length}`);
  ok('O17 a seat count cannot exceed the squad cap, whatever it claims',
    nasty.seats <= MAX_SQUAD && nasty.max <= MAX_SQUAD, `${nasty.seats}/${nasty.max}`);
  eq('O18 a phase outside the vocabulary falls back rather than being printed',
    nasty.phase, LOBBY_PHASE.FORMING);
  eq('O19 and a field the listing does not know about is DROPPED, not carried',
    [nasty.callsign, nasty.href, nasty.extra].filter((x) => x !== undefined).length, 0);
  eq('O20 a garbage advertisement with no code and no room is refused outright',
    dir.advertise({ label: 'nothing' }, 3000), null);
  eq('O21 and refusals are counted rather than silently swallowed', dir.rejected >= 1, true);

  /* ── age, staleness, and the cap ── */
  dir.advertise({ code: 'FRESH', seats: 1 }, 100000);
  const rows = dir.list(110000);
  const fresh = rows.find((r) => r.code === 'FRESH');
  const old = rows.find((r) => r.code === 'AB12C');
  eq('O22 a row carries how long ago it was said, not a verdict', fresh.ageMs, 10000);
  eq('O23 a recent row is not marked stale', fresh.stale, false);
  ok('O24 and one past the stale window IS, so the screen can say "may be gone"',
    !old || old.stale === true);
  eq('O25 a row past the drop window is forgotten entirely',
    dir.list(300000).some((r) => r.code === 'AB12C'), false);

  const capped = new SessionDirectory({ max: 3 });
  for (let i = 0; i < 10; i++) capped.advertise({ code: `R${i}`, seats: 1 }, 0);
  eq('O26 the directory is capped — one browser holding an unbounded list for strangers is a denial of service with no attacker',
    capped.size, 3);
  eq('O27 and the overflow is counted', capped.rejected, 7);

  /* ⚠ A host that leaves takes its row off the list. Without this the only thing that ever
   * removes a row is staleness, and a directory a squad passes through fills with rooms
   * that closed minutes ago — leaving the honest "said so 2 min ago" label doing all the
   * work. `NetSession.leave` sends this; a handler for a message nobody sends is the same
   * defect as a config value nothing reads. */
  const withdrawing = new SessionDirectory();
  withdrawing.advertise({ code: 'BYE01', seats: 1 }, 0);
  withdrawing.advertise({ code: '', room: 'night shift', seats: 1 }, 0);
  ok('O28 a host that signs off can withdraw its row by code', withdrawing.withdraw('BYE01'));
  ok('O29 and by room name', withdrawing.withdraw('Night Shift'));
  eq('O30 leaving the list empty rather than stale', withdrawing.size, 0);

  /* ── what a listing may never say ── */
  const lobby = new Lobby();
  lobby.code = 'AB12C';
  lobby.roomName = 'night-shift';
  lobby.take('p1', { callsign: 'Vasquez Personal Data', host: true, atMs: 0 });
  lobby.take('p2', { callsign: 'Drake', atMs: 0 });
  const advert = lobby.describe(5000);
  note(`the advertisement for a room of two: ${JSON.stringify(advert)}`);
  ok('O31 an advertisement carries the seat COUNT and not who is in the seats',
    advert.seats === 2 && !JSON.stringify(advert).includes('Vasquez') && !JSON.stringify(advert).includes('Drake'),
    JSON.stringify(advert));

  /* ── the mirror on the joiner's machine ── */
  const held = new SessionDirectory();
  held.advertise({ code: 'AB12C', seats: 2, label: 'Cold storage' }, 40000);
  const wire = held.encode(52000);
  eq('O32 what the directory sends carries each row\'s age rather than its timestamp', wire[0].ageMs, 12000);
  const mirror = new SessionDirectory();
  for (const e of wire) mirror.advertise(e, 900000 - e.ageMs);
  eq('O33 so a joiner whose clock is nothing like the holder\'s still ages the row correctly',
    mirror.list(900000)[0].ageMs, 12000);

  /* ── the joiner's own memory ── */
  const store = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  })();
  eq('O34 a machine that has joined nothing has an empty history', loadRecent(store).length, 0);
  rememberRoom(store, { code: 'AB12C', room: '', label: 'Cold storage, level 2' }, 1000);
  rememberRoom(store, { code: '', room: 'Night Shift', label: 'Aisle B' }, 2000);
  const recent = loadRecent(store);
  eq('O35 rooms you have been in are remembered on YOUR machine', recent.length, 2);
  eq('O36 newest first', recent[0].room, 'night-shift');
  rememberRoom(store, { code: 'AB12C', room: '', label: 'again' }, 3000);
  eq('O37 and re-joining one moves it rather than duplicating it', loadRecent(store).length, 2);
  ok('O38 the history is a list of ROOMS and holds nobody\'s callsign',
    !JSON.stringify(loadRecent(store)).toLowerCase().includes('vasquez'));
  for (let i = 0; i < 30; i++) rememberRoom(store, { code: `Z${i}`, room: '' }, 4000 + i);
  ok('O39 and it is bounded, because a history is not an archive', loadRecent(store).length <= 8,
    `${loadRecent(store).length}`);
  const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };
  eq('O40 a profile that refuses storage gets an empty list rather than a crash', loadRecent(broken).length, 0);
  ok('O41 and remembering into it does not throw either', Array.isArray(rememberRoom(broken, { code: 'X' }, 0)));

  eq('O42 ages are printed as words a person reads, not milliseconds', ago(41000), '41s ago');
  eq('O43 including the case the whole staleness story turns on', ago(0), 'just now');
  emit();
}

/* ── P. moderation, and the thing it must not destroy ────────────────────── */
async function sectionP(content) {
  heading('P. removing a seat, authoritatively, without losing anything');

  const host = rig(content, { seed: 'mod' });
  host.n.host();
  host.g.commitLoadout(RECOMMENDED_MANIFEST);
  host.n.selectOperation({ id: 'op-cold-storage-2', label: 'Cold storage, level 2' });

  const bad = mkClient(content, { seed: 'mod-c' });
  seatOn(host, bad, 'Griefer');
  const seatId = bad.n.localPlayerId;
  const token = host.n.seats.get(seatId).token;
  eq('P1 the seat exists before it is removed, so nothing below is vacuous', host.g.players.length, 2);

  /* Give them the two things that must survive: a tripod in a slot, and CUSTODY. */
  const p = host.g.playerById(seatId);
  p.take(content.itemsById.get('floodlight-tripod'));
  /* ⚠ Deliberately NOT past PROCEDURE_COMMITTED. The join gate shuts there (§11.5) and
   * P21 below is about the readmitted operative getting back IN, so a phase set for the
   * convenience of the custody fixture would make the readmit test measure the gate. */
  const kase = host.g.deployables.place(content.itemsById.get('reinforced-transit-case'), p.x, p.z, 0);
  kase.sealed = true;
  p.hands = 'reinforced-transit-case';
  host.g._carried.set(seatId, { sealed: true, custodyHeldMs: 5000, batteryMs: kase.batteryMs });
  host.g.deployables.remove(kase);
  const tripodsBefore = host.g.cache.get('floodlight-tripod') || 0;
  const whereTheyStood = { x: p.x, z: p.z };

  const rec = host.n.removeSeat(seatId, 'grief');
  ok('P2 the host can remove a seat', !!rec);
  eq('P3 and it is gone from the roster on the machine that runs the mission', host.g.players.length, 1);
  eq('P4 and out of the lobby', host.n.lobby.seatOf(seatId), null);
  eq('P5 the removed operative is told why, in words they can read',
    bad.n.removedWhy, REMOVAL_REASONS.grief);

  /**
   * ⚠ AND THE REASON SURVIVES THE HANGUP.
   *
   * A removal is followed immediately by the link closing, and `onClose` used to be the
   * last thing to write the status — so the one sentence explaining what just happened was
   * reliably replaced by "disconnected" a few milliseconds later. Same defect as
   * `applySnapshot` eating every REFUSAL, one layer out.
   */
  ok('P6 and survives the hangup that follows it', !/disconnect/i.test(bad.n.status), bad.n.status);
  ok('P7 the removed operative also gets it as a notice they can re-read',
    bad.g.recentNotices(9).some((n) => /removed/i.test(n.text)));

  /* ── nothing was destroyed ── */
  eq('P8 their kit went back to the vehicle rather than out of the world (§11.7)',
    (host.g.cache.get('floodlight-tripod') || 0), tripodsBefore + 1);
  const onFloor = host.g.deployables.byItem('reinforced-transit-case').filter((d) => d.sealed);
  ok('P9 and CUSTODY was put down rather than taken offline with them', onFloor.length === 1);
  ok('P10 on the floor where they stood, recoverable by anybody',
    onFloor.length === 1 && Math.hypot(onFloor[0].x - whereTheyStood.x, onFloor[0].z - whereTheyStood.z) < 0.6,
    onFloor.length ? `${onFloor[0].x.toFixed(2)},${onFloor[0].z.toFixed(2)} vs ${whereTheyStood.x.toFixed(2)},${whereTheyStood.z.toFixed(2)}` : 'no case');
  eq('P11 and the squad is told, because a case on the floor is everybody\'s problem',
    host.g.recentNotices(9).some((n) => /removed/i.test(n.text)), true);

  /**
   * ⚠ THE BLOCK IS CHECKED BEFORE THE RESUME TOKEN, and that order is the whole of it. A
   * removed operative holds a perfectly valid token for the seat they were thrown out of —
   * the host issued it — so checking the token first hands them their seat straight back,
   * kit and all, and a removal becomes a two-second inconvenience.
   */
  const returning = mkClient(content, { seed: 'return' });
  const [rh, rc] = loopbackPair();
  host.n.accept(rh);
  returning.n.join(rc, { name: 'Griefer', token });
  eq('P12 a removed operative cannot walk back in on their own resume token', host.g.players.length, 1);
  ok('P13 and is told why rather than being dropped silently', /removed/i.test(returning.n.status), returning.n.status);
  ok('P14 and that reason survives the hangup too', !/disconnect/i.test(returning.n.status), returning.n.status);

  eq('P15 a host cannot remove themselves', host.n.removeSeat('p1', 'grief'), null);
  eq('P16 nor a seat that does not exist', host.n.removeSeat('p9', 'grief'), null);

  /* ── the undo, and what it is not ── */
  const removals = host.n.lobby.removals();
  eq('P17 the host can see who is currently blocked', removals.length, 1);
  eq('P18 with the reason they chose', removals[0].reason, 'grief');
  const back = host.n.readmitSeat(removals[0].token);
  ok('P19 a removal can be undone', !!back);
  eq('P20 and the block is lifted', host.n.lobby.removals().length, 0);

  const again = mkClient(content, { seed: 'again' });
  const [ah, ac] = loopbackPair();
  host.n.accept(ah);
  again.n.join(ac, { name: 'Griefer', token });
  ok('P21 so they can reconnect', again.n.localPlayerId !== 'p1' && !!host.g.playerById(again.n.localPlayerId),
    again.n.status);
  /**
   * ⚠ READMISSION IS NOT A REWIND, AND THE UI SAYS SO. They come back through the ordinary
   * join path into a FRESH seat. The tripod went back to the vehicle when they were removed
   * and it is still at the vehicle; the case is still on the floor. Undoing the block is not
   * undoing the consequences, and a screen that implied otherwise would be claiming more
   * than the code delivers (§18.1).
   */
  eq('P22 but they come back with empty hands — readmission is not a rewind',
    host.g.playerById(again.n.localPlayerId).carrying('floodlight-tripod'), false);
  eq('P23 and the kit is still where the removal put it', (host.g.cache.get('floodlight-tripod') || 0), tripodsBefore + 1);
  ok('P24 while the removal itself is STILL on the record — a readmission is a second entry, never an erasure',
    host.n.lobby.log.some((e) => e.kind === LOG_KIND.REMOVED)
    && host.n.lobby.log.some((e) => e.kind === LOG_KIND.READMITTED));

  /* ── a removal reason is a closed vocabulary ── */
  const l = new Lobby();
  l.take('p1', { callsign: 'Host', host: true });
  l.take('p2', { callsign: 'Other' });
  const junk = l.remove('p2', { reason: 'you are <b>bad</b> and here is my opinion at length', token: 't' });
  eq('P25 a reason outside the vocabulary falls back rather than travelling as free text',
    junk.reason, DEFAULT_REASON);
  ok('P26 which is the whole point: the only thing that leaves the host\'s machine is an id both ends already have',
    Object.keys(REMOVAL_REASONS).includes(junk.reason));
  emit();
}

/* ── Q. the action record, and where it is allowed to live ───────────────── */
async function sectionQ(content) {
  heading('Q. an action log a host can read, that is not analytics');

  const host = rig(content, { seed: 'log' });
  host.n.host();
  host.g.commitLoadout(RECOMMENDED_MANIFEST);
  host.n.selectOperation({ id: 'op-1', label: 'Op' });

  const NAME = 'Zzz Vasquez';
  const c1 = mkClient(content, { seed: 'log-c' });
  const link = seatOn(host, c1, NAME);
  c1.n.askReady(true);
  host.clock.ms += 400;
  c1.n.askReady(false);
  host.clock.ms += 400;
  link.hl.close();

  const log = host.n.lobby.log;
  note(`${log.length} entries after one seat joined, readied, unreadied and dropped`);
  ok('Q1 the record has the seating', log.some((e) => e.kind === LOG_KIND.SEATED && e.callsign === NAME));
  ok('Q2 the ready and the change of mind', log.some((e) => e.kind === LOG_KIND.READY)
    && log.some((e) => e.kind === LOG_KIND.UNREADY));
  ok('Q3 and the lost radio', log.some((e) => e.kind === LOG_KIND.DROPPED));
  ok('Q4 every entry is stamped with the seat it belongs to',
    log.every((e) => e.seatId === null || typeof e.seatId === 'string'));
  ok('Q5 and numbered, so a host can tell two identical lines apart',
    log.every((e, i) => i === 0 || e.n > log[i - 1].n));
  eq('Q6 "what did THAT seat do" is one question the record answers',
    host.n.lobby.bySeat('p2').length >= 4, true);
  ok('Q7 every kind has a sentence the screen is allowed to print',
    log.every((e) => !!LOG_WORDS[e.kind]), log.map((e) => e.kind).join());

  /* ── closed, bounded, and honest about what it dropped ── */
  const l = new Lobby({ logSize: 5 });
  eq('Q8 a kind outside the vocabulary is refused rather than becoming free text',
    l.record('whatever the host felt like typing', { seatId: 'p2', callsign: 'X' }, 0), null);
  for (let i = 0; i < 20; i++) l.record(LOG_KIND.READY, { seatId: 'p2', callsign: 'X' }, i);
  eq('Q9 the record is bounded — §24 forbids an unbounded trace log', l.log.length, 5);
  eq('Q10 and says how many it dropped rather than silently forgetting', l.logDropped, 15);
  ok('Q11 a detail field is clamped, so no entry can carry a paragraph',
    l.record(LOG_KIND.REMOVED, { seatId: 'p2', callsign: 'X' }, 0, 'y'.repeat(500)).detail.length <= 32);

  /**
   * ⚠ WHERE THE RECORD IS NOT ALLOWED TO BE, which is the half a coverage test forgets.
   *
   * §24 asks for action logs as a moderation tool and §21.2 says "do not record raw voice,
   * free-text chat, or unnecessary personal data". Those are not in conflict — they are
   * about two different logs — and the mistake would be to satisfy them with one. So the
   * moderation record carries callsigns and NEVER leaves the host's memory, and the
   * analytics bus carries positional seat ids and NEVER carries a callsign.
   */
  const wire = JSON.stringify(encodeLobby(host.n.lobby));
  note(`a lobby broadcast for a squad of two is ${wire.length} bytes`);
  ok('Q12 the log is not in the lobby broadcast — no player receives the host\'s file on the others',
    !wire.includes('seated') && !wire.includes(LOG_KIND.REMOVED));
  ok('Q13 nor is the block list', !wire.includes('removed'));
  ok('Q14 nor is it in a snapshot', !JSON.stringify(encodeSnapshot(host.g)).includes('"kind"'));
  eq('Q15 a client\'s own copy of the lobby has an empty record after a broadcast',
    c1.n.lobby.log.length, 0);

  /**
   * The §21.2 assertion, driven through a whole lobby session rather than asserted about
   * an empty bus — m0-tests AN5 does the same for the mission, and this is the lobby's
   * half of it. The callsign is the only free text a player types in this build, and the
   * moderation path is the one that has most reason to shout it.
   *
   * ⚠ THE NAME REALLY IS IN THE GAME'S TEXT, which is what makes this worth asserting.
   * `removeSeat` puts "X was removed from the squad" on the SQUAD FEED, because a case on
   * the floor is everybody's problem and a feed line that names nobody helps nobody. The
   * feed is not the analytics log — `EVENTS.NOTICE` is on `bus.unlogged` — and Q19 is what
   * keeps those two facts from drifting apart.
   */
  const other = mkClient(content, { seed: 'log-c2' });
  seatOn(host, other, 'Drake Vasquez');
  host.n.removeSeat(other.n.localPlayerId, 'conduct');
  const dump = JSON.stringify(host.g.bus.log);
  note(`analytics bus after the lobby session: ${host.g.bus.log.length} entries, ${dump.length} bytes`);
  ok('Q16 the bus carried real events, so Q17 is not passing on an empty object',
    host.g.bus.log.length >= 3, `${host.g.bus.log.length} entries`);
  ok('Q17 no callsign reaches the analytics bus from anything the lobby does (§21.2)',
    !dump.includes(NAME) && !dump.includes('Vasquez'), dump.slice(0, 300));
  ok('Q18 while the moderation record has it, because "somebody did it" names nobody',
    JSON.stringify(host.n.lobby.log).includes(NAME));
  ok('Q19 and the squad feed has it too, which is where a name belongs',
    host.g.notices.some((n) => n.text.includes('Drake Vasquez')),
    host.g.notices.map((n) => n.text).join(' ~ ').slice(0, 200));
  emit();
}

/* ── R. the wire, measured ───────────────────────────────────────────────── */
async function sectionR(content) {
  heading('R. how many seats, how many bytes, at what rate');

  /* ── 1. what a snapshot costs, per seat and per deployable ── */
  const sizeWith = (players, deployables) => {
    const g = new Game(content, { seed: 'load' });
    g.commitLoadout(RECOMMENDED_MANIFEST);
    for (let i = 1; i < players; i++) g.addPlayer(`Operative ${i + 1}`);
    for (let i = 0; i < deployables; i++) {
      g.deployables.place(content.itemsById.get('floodlight-tripod'), 3 + (i % 6), 4 + Math.floor(i / 6), 0.5);
    }
    return JSON.stringify(encodeSnapshot(g)).length;
  };

  const base = sizeWith(1, 0);
  const five = sizeWith(5, 0);
  const perSeat = (five - base) / 4;
  const withDeps = sizeWith(5, 12);
  const perDep = (withDeps - five) / 12;
  note(`snapshot: ${base} B solo · ${five} B at five seats · ${withDeps} B at five seats and twelve deployables`);
  note(`marginal cost: ${perSeat.toFixed(0)} B per operative, ${perDep.toFixed(0)} B per deployable`);
  ok('R1 a snapshot for a solo operation is under two kilobytes', base < 2048, `${base} B`);
  ok('R2 an operative costs a couple of hundred bytes, not a couple of thousand',
    perSeat > 40 && perSeat < 600, `${perSeat.toFixed(0)} B`);
  ok('R3 and the cost per seat is FLAT — no field is quadratic in squad size',
    Math.abs((sizeWith(3, 0) - base) / 2 - perSeat) < perSeat * 0.15,
    `${((sizeWith(3, 0) - base) / 2).toFixed(0)} B at three vs ${perSeat.toFixed(0)} B at five`);

  /* ── 2. what actually crosses a link, over ten seconds of real pumping ── */
  const hz = CONFIG.net.snapshotHz;
  const host = rig(content, { seed: 'wire', hz });
  host.n.host();
  host.g.commitLoadout(RECOMMENDED_MANIFEST);
  const clients = [];
  for (let i = 0; i < MAX_SQUAD - 1; i++) {
    const c = mkClient(content, { seed: `wire-c${i}` });
    const ends = seatOn(host, c, `Op${i + 2}`);
    clients.push({ c, ...ends });
  }
  eq('R4 a full squad of five is seated over real links', host.g.players.length, MAX_SQUAD);

  const cmd = { axis: { x: 0.7, y: -0.7 }, yaw: 1.2, pitch: -0.1, sprint: true, crouch: false };
  const cmdBytes = JSON.stringify(encodeCommand(cmd)).length;
  for (const s of clients) { s.hl.sent = 0; s.hl.bytes = 0; s.cl.sent = 0; s.cl.bytes = 0; }
  const SECONDS = 10, FPS = 60;
  for (let f = 0; f < SECONDS * FPS; f++) {
    host.n.pump(1000 / FPS, null);
    for (const s of clients) s.c.n.pump(1000 / FPS, cmd);
  }
  const down = clients.reduce((a, s) => a + s.hl.bytes, 0) / SECONDS;
  const up = clients.reduce((a, s) => a + s.cl.bytes, 0) / SECONDS;
  const perClientDown = down / clients.length;
  const snaps = clients[0].hl.sent / SECONDS;
  note(`over ${SECONDS}s with ${MAX_SQUAD} seats: host sent ${(down / 1024).toFixed(1)} kB/s total`);
  note(`  = ${(perClientDown / 1024).toFixed(2)} kB/s to each client, at ${snaps.toFixed(1)} snapshots/s`);
  note(`  clients sent ${(up / 1024).toFixed(1)} kB/s back, ${cmdBytes} B per command at ${FPS} Hz`);
  near(`R5 snapshots go out at the configured rate`, snaps, hz, 1.5);
  ok('R6 the host\'s uplink at a full squad is a few tens of kB/s, not hundreds',
    down / 1024 < 120, `${(down / 1024).toFixed(1)} kB/s`);
  ok('R7 and a client\'s uplink is an order of magnitude smaller than the host\'s',
    up < down / 4, `${(up / 1024).toFixed(1)} vs ${(down / 1024).toFixed(1)} kB/s`);

  /**
   * WHERE IT STOPS BEING FAIR. The host sends the SAME snapshot to every seat, so its
   * uplink is exactly linear in seats — which means the honest way to answer "how many
   * seats" is arithmetic over a measured per-seat rate rather than a session nobody can
   * run. MAX_SQUAD is 5 and the join gate enforces it, so the rows past five are what the
   * cap is buying.
   */
  const equal = clients.every((s) => s.hl.bytes === clients[0].hl.bytes);
  ok('R8 every seat gets the identical snapshot, so the host\'s uplink is exactly linear in seats',
    equal, clients.map((s) => s.hl.bytes).join(' / '));
  /* MAX_SQUAD counts the HOST's own operative, so a full squad is MAX_SQUAD - 1 links. */
  const fullSquadKbit = perClientDown * (MAX_SQUAD - 1) * 8 / 1000;
  for (const [label, bytesPerSec] of [['a 1 Mbit/s household uplink', 1e6 / 8], ['a 5 Mbit/s uplink', 5e6 / 8]]) {
    note(`${label} carries ${Math.floor(bytesPerSec / perClientDown)} client links at ${(perClientDown / 1024).toFixed(2)} kB/s each (the cap is ${MAX_SQUAD - 1})`);
  }
  note(`a full squad of ${MAX_SQUAD} costs the HOST ${fullSquadKbit.toFixed(0)} kbit/s up, and each client ${(perClientDown * 8 / 1000).toFixed(0)} kbit/s down`);
  ok(`R9 a full squad costs the host about half a megabit up — that number, not the squad cap, is what limits seat count`,
    fullSquadKbit > 250 && fullSquadKbit < 900, `${fullSquadKbit.toFixed(0)} kbit/s`);

  /* ── 3. a NARROW wire, not just a slow one ────────────────────────────────
   * `loopbackPair`'s schedule is handed the byte count as well as the delay, which is what
   * lets a wire be narrow rather than merely late. Latency alone never produces the
   * failure this is looking for: a queue that grows every second until the client is
   * watching a mission that finished. */
  const narrowWire = (bytesPerSec) => {
    const q = [];
    let vt = 0, credit = 0, delivered = 0, queuedBytes = 0, peakLagMs = 0;
    return {
      schedule: (fn, ms, bytes) => { q.push({ fn, at: vt + (ms || 0), bytes: bytes || 0 }); queuedBytes += bytes || 0; },
      advance(ms) {
        vt += ms;
        credit += (ms / 1000) * bytesPerSec;
        while (q.length && q[0].at <= vt && credit >= q[0].bytes) {
          const item = q.shift();
          credit -= item.bytes;
          queuedBytes -= item.bytes;
          delivered++;
          peakLagMs = Math.max(peakLagMs, vt - item.at);
          item.fn();
        }
      },
      stats: () => ({ delivered, backlog: q.length, queuedBytes, peakLagMs }),
    };
  };

  for (const kbps of [2000, 512, 192]) {
    const w = narrowWire(kbps * 1000 / 8);
    const h = rig(content, { seed: `narrow-${kbps}`, hz });
    h.n.host();
    h.g.commitLoadout(RECOMMENDED_MANIFEST);
    const cs = [];
    for (let i = 0; i < MAX_SQUAD - 1; i++) {
      const c = mkClient(content, { seed: `narrow-c${i}-${kbps}` });
      cs.push(seatOn(h, c, `Op${i + 2}`, { schedule: w.schedule }));
    }
    for (let f = 0; f < 20 * FPS; f++) { h.n.pump(1000 / FPS, null); w.advance(1000 / FPS); }
    const s = w.stats();
    note(`${kbps} kbit/s, five seats, 20 s: ${s.delivered} delivered, ${s.backlog} still queued (${(s.queuedBytes / 1024).toFixed(1)} kB), worst lag ${s.peakLagMs.toFixed(0)} ms`);
    if (kbps === 2000) {
      ok('R10 at 2 Mbit/s a full squad keeps up — nothing is left in the queue',
        s.backlog === 0, `${s.backlog} queued`);
    }
    if (kbps === 512) {
      ok('R11 at 512 kbit/s it still keeps up, but the worst delivery is a tenth of a second late',
        s.backlog === 0 && s.peakLagMs > 30, `${s.backlog} queued, worst lag ${s.peakLagMs.toFixed(0)} ms`);
    }
    if (kbps === 192) {
      ok('R12 at 192 kbit/s it does not, and the backlog GROWS rather than settling — this is where a full squad stops being fair',
        s.backlog > 50, `${s.backlog} queued, worst lag ${s.peakLagMs.toFixed(0)} ms`);
    }
  }

  /* ── 4. what a griefer can make the lobby cost ── */
  const flood = rig(content, { seed: 'flood' });
  flood.n.host();
  flood.n.selectOperation({ id: 'op-1', label: 'Op' });
  const fc = mkClient(content, { seed: 'flood-c' });
  const fe = seatOn(flood, fc, 'Flood');
  const bcBefore = flood.n.lobbyBroadcasts;
  for (let i = 0; i < 500; i++) fe.cl.send({ t: MSG.LACT, k: LACT.READY, v: i % 2 });
  const applied = flood.n.lactsReceived;
  note(`500 ready-toggles in one frame: ${applied} applied, ${flood.n.lactsDropped} dropped, ${flood.n.lobbyBroadcasts - bcBefore} broadcasts`);
  ok('R13 a client cannot make the host rebroadcast the roster as fast as its send loop runs',
    flood.n.lactsDropped > 400, `${flood.n.lactsDropped} dropped`);
  ok('R14 the broadcasts it caused are bounded by the budget, not by the flood',
    flood.n.lobbyBroadcasts - bcBefore <= flood.n.lobby.floodBudget,
    `${flood.n.lobbyBroadcasts - bcBefore}`);
  emit();
}

/* ── S. the host's inbox, under a client that is not playing fair ────────── */
async function sectionS(content) {
  heading('S. §20.9 — never trust client claims, and never let one throw');

  const host = rig(content, { seed: 'hostile' });
  host.n.host();
  host.g.commitLoadout(RECOMMENDED_MANIFEST);
  const c = mkClient(content, { seed: 'hostile-c' });
  const { cl } = seatOn(host, c, 'Hostile');
  const seatId = c.n.localPlayerId;
  const before = { x: host.g.playerById(seatId).x, z: host.g.playerById(seatId).z };

  /**
   * ⚠ THIS IS A ONE-LINE DENIAL OF SERVICE AGAINST FOUR OTHER PEOPLE'S EVENING.
   *
   * `decodeCommand` reads `m.a[0]`, so a `{t:'cmd'}` with nothing else in it threw straight
   * out of the host's message handler. Recorded in Dev\INDEX.md against the same function
   * in SmallTownEmergencyServices, where it took a whole shift down.
   */
  cl.send({ t: MSG.CMD });
  ok('S1 a command with no axis does not throw out of the host\'s inbox', true);
  eq('S2 it is counted as malformed rather than silently dropped', host.n.malformed >= 1, true);
  ok('S3 and logged against the seat that sent it, which is what the record is for',
    host.n.lobby.bySeat(seatId).some((e) => e.kind === LOG_KIND.MALFORMED));

  /**
   * ⚠ JSON HAS NO NaN, so `{y: NaN}` arrives as `{y: null}` — and `+null` is 0, which is
   * finite. A validator written as `Number.isFinite(+m.y)` therefore ACCEPTS it and
   * quietly turns a garbage field into a real heading of zero, which is worse than
   * refusing it because nothing anywhere says it happened. `null`, `''` and `[]` all
   * coerce the same way. This assertion existed to catch a bad axis and caught a bad
   * VALIDATOR instead.
   */
  const cmdsBefore = host.n.cmdsReceived;
  cl.send({ t: MSG.CMD, a: ['x', null], y: 0, p: 0, f: 0 });
  cl.send({ t: MSG.CMD, a: [0, 0], y: NaN, p: 0, f: 0 });
  cl.send({ t: MSG.CMD, a: [0, 0], y: null, p: 0, f: 0 });
  cl.send({ t: MSG.CMD, a: [0, 0], y: 0, p: 'north', f: 0 });
  cl.send({ t: MSG.CMD, a: [0, 0], y: '', p: 0, f: 0 });
  eq('S4 a field JSON could not carry is refused rather than coerced to zero',
    host.n.cmdsReceived, cmdsBefore);
  const now = host.g.playerById(seatId);
  ok('S5 so the operative\'s position is still a number', Number.isFinite(now.x) && Number.isFinite(now.z)
    && Number.isFinite(now.yaw), `${now.x},${now.z},${now.yaw}`);
  near('S6 and they have not been teleported by a lie', now.x, before.x, 0.001);

  cl.send({ t: MSG.ACT, sq: 1, k: 'no such action' });
  cl.send({ t: 'nonsense' });
  cl.send(null);
  cl.send(42);
  ok('S7 nonsense of every shape leaves the host still running', host.n.role === ROLE.HOST
    && host.g.players.length === 2);
  host.n.pump(200, null);
  ok('S8 and still sending snapshots afterwards', c.n.snapsReceived > 0, `${c.n.snapsReceived}`);

  /* ── the refusal path ─────────────────────────────────────────────────────
   * ⚠ A REFUSAL MUST HANG UP. Left open, a refused peer sits there believing it is
   * connected and hammering a host that will never read a word from it. */
  let heard = '';
  const [sh, sc] = loopbackPair();
  host.n.accept(sh);
  sc.onMessage = (m) => { heard = m.why || m.t; };
  sc.send({ t: MSG.HELLO, v: PROTOCOL_VERSION + 99, name: 'Stale' });
  ok('S9 a protocol mismatch is refused in words', /reload/i.test(heard), heard);
  eq('S10 and the link is closed rather than left hammering the host', sh.open, false);

  /* Now the same thing with a client that is really joined, so the sticky field matters. */
  const v2 = mkClient(content, { seed: 'v2' });
  const [vh, vc] = loopbackPair();
  host.n.accept(vh);
  v2.n.join(vc, { name: 'Old build', token: null });
  vc.send({ t: MSG.HELLO, v: PROTOCOL_VERSION + 1, name: 'Old build' });
  ok('S11 the reason a version was refused survives the hangup that follows it',
    !/disconnect/i.test(v2.n.status), v2.n.status);

  /* ── the lobby budget ── */
  const l = new Lobby();
  l.take('p2', { callsign: 'Fast' });
  let allowed = 0;
  for (let i = 0; i < 40; i++) if (l.charge('p2', 0)) allowed++;
  eq('S12 a burst is allowed up to the budget and no further', allowed, l.floodBudget);
  ok('S13 going over it is logged once per burst, not once per message',
    (l.noteFlood('p2', 0), l.noteFlood('p2', 0), l.log.filter((e) => e.kind === LOG_KIND.FLOOD).length === 1));
  ok('S14 and the budget refills over time rather than muting the seat for the session',
    l.charge('p2', 3000), 'after three seconds');
  emit();
}

/* ── U. the shipped screen, in the shipped page ──────────────────────────── */
async function sectionU() {
  heading('U. the lobby the player actually gets');

  /**
   * ⚠ WAIT FOR BOOT. The harness injects this module straight after `main.js`, and
   * `boot()` is async — it fetches the incident package, the site and the profile before
   * it publishes `window.__CD`. A short suite finishes its own sections BEFORE boot
   * finishes, so reading the handle at the top gives `undefined` and every assertion about
   * the real page reports a failure about nothing. `m0-tests.js` gets away with reading it
   * directly only because six thousand lines of arithmetic run first.
   */
  await new Promise((resolve) => {
    if (window.__CD) { resolve(); return; }
    window.addEventListener('cd-ready', () => resolve(), { once: true });
    setTimeout(resolve, 5000);
  });

  const cd = window.__CD;
  ok('U1 main.js published the lobby on the debug handle', !!cd && !!cd.lobby,
    cd ? Object.keys(cd).join() : 'no __CD at all — boot never finished');
  if (!cd || !cd.lobby) { emit(); return; }
  const lobby = cd.lobby;

  ok('U2 the session\'s lobby clock is wall time, not the paused mission clock',
    cd.net.now() > 1e12, `${cd.net.now()}`);
  ok('U3 which is the whole reason it is injected — the mission clock is at zero behind the base screen',
    cd.game.clock.simTimeMs < cd.net.now());

  lobby.show((cd.site.operations || [])[0] || null);
  ok('U4 the lobby opens', lobby.isOpen);
  ok('U5 and hosting is what it becomes, so a solo player is a host with nobody connected',
    cd.net.role === 'host');
  const html = lobby.node.innerHTML;
  ok('U6 it renders a roster with the local operative in it', /class="roster seats"/.test(html));
  ok('U7 it offers all three ways to be found', /value="private"/.test(html)
    && /value="named"/.test(html) && /value="listed"/.test(html));

  /**
   * ⚠ EVERY PLAYER ARRIVES HERE AS A HOST OF AN EMPTY ROOM, because a solo operation is a
   * host with nobody connected. A left column that branched on `role === HOST` therefore
   * rendered the hosting controls for everybody and the JOIN controls for nobody — the one
   * defect that would have made the whole milestone unusable, and one no model test can
   * see because the model was right and the branch was wrong.
   */
  ok('U8 a player who has opened no room is offered BOTH halves — hosting and joining',
    /data-open/.test(html) && /data-dojoin/.test(html));
  eq('U9 with exactly one callsign field between them, not one per half',
    lobby.node.querySelectorAll('[data-name]').length, 1);

  /**
   * ⚠ §18.1: THE SCREEN MAY NOT CLAIM MORE THAN THE TRANSPORT DELIVERS. The shared list is
   * held in a stranger's browser and dies with their tab, and a page that showed it as a
   * server-backed room list would be lying in the most useful place. Asserted on the
   * rendered text rather than on an intention in a comment.
   */
  lobby.visibility = 'listed';
  lobby.render();
  const listed = lobby.node.textContent;
  ok('U10 choosing the shared list says there is no server', /no server/i.test(listed));
  ok('U11 and that it disappears when one player closes a tab', /disappears when they close/i.test(listed));
  ok('U12 and that its rows are unverified claims', /not checked by anybody/i.test(listed));
  ok('U13 and that no callsign goes on it', /No callsigns/i.test(listed));

  lobby.visibility = 'private';
  lobby.recent = [{ code: 'AB12C', room: '', label: 'Cold storage, level 2', atMs: cd.net.now() - 90000 }];
  lobby.rooms = [{ code: 'ZZ99Z', room: '', label: 'Aisle B', seats: 2, max: 5, ageMs: 61000, stale: true }];
  cd.net.role = 'client';                    // render the joiner's half
  lobby.render();
  const joinText = lobby.node.textContent;
  cd.net.role = 'host';
  ok('U14 a room in your own history says when YOU joined it, not that it is live',
    /joined .* ago/i.test(joinText), joinText.slice(0, 200));
  ok('U15 and says in words that it does not know whether anybody is there',
    /does not know whether/i.test(joinText));
  ok('U16 a stale directory row says "may be gone" rather than being quietly greyed out',
    /may be gone/i.test(joinText));
  ok('U17 and every row carries how long ago it was said', /said so .* ago/i.test(joinText));

  lobby.hide();
  ok('U18 and it closes without throwing', !lobby.isOpen);
  ok('U19 nothing on the page crashed on the way', !document.getElementById('err-banner').textContent);
  emit();
}

/* ── T. what none of this proves ─────────────────────────────────────────── */
async function sectionT() {
  heading('T. the honest limits of a loopback and a broker');

  /**
   * m0-tests records that the one real netcode bug this project shipped was found in two
   * browsers and not by the suite: `applySnapshot` replaced the client's notice list with
   * the host's, so every REFUSAL died about 80 ms after it arrived and reading it
   * immediately always worked. The question this section exists to answer is: what is this
   * feature's version of that?
   *
   * The answer is the same shape, and there are two of them. `applyLobby` replaces the
   * client's SEAT MAP wholesale — correct for a roster, and fatal for anything the client
   * owns that is stored beside it. So:
   *
   *   · the REMOVAL REASON is kept on the session, not on the lobby, and `onClose` reads it
   *     rather than writing over it (P5–P6, S11);
   *   · the client's own READY is never written locally, only echoed (N29–N31).
   *
   * Both are asserted, and both are asserted ACROSS A DELAYED LINK, because over a
   * synchronous loopback an optimistic write and a correct one produce the same answer.
   * That is the most a test in this process can do. What it still cannot do is below.
   */
  const dl = new Lobby();
  dl.take('p1', { callsign: 'Host', host: true });
  dl.take('p2', { callsign: 'Other' });
  const wire = encodeLobby(dl);
  const clientCopy = new Lobby();
  clientCopy.take('p2', { callsign: 'Other' });
  const ownedBefore = clientCopy.log.length;
  applyLobby(clientCopy, wire);
  ok('T1 a broadcast replaces the client\'s seat map wholesale, which is the hazard stated plainly',
    clientCopy.seats.size === 2 && clientCopy.seatOf('p1') !== null);
  ok('T2 so nothing the client owns may be stored in it — what is kept elsewhere survives',
    ownedBefore > 0 && clientCopy.log.length === ownedBefore,
    `${ownedBefore} entries before, ${clientCopy.log.length} after`);

  note('OPEN — five things this suite cannot decide, in the order they are likely to bite:');
  note('  1. THE DIRECTORY IS A STRANGER\'S TAB. Every directory test here drives');
  note('     SessionDirectory in process. Nothing proves that claiming a well-known peer id');
  note('     on a broker shared with the internet behaves as modelled: two hosts can race');
  note('     for it, the holder can vanish between the list and the join, and the id can be');
  note('     squatted by something that is not this game at all. Needs two real browsers.');
  note('  2. A ROOM NAME IS A GLOBAL NAMESPACE. `roomIdFor` is deterministic and tested;');
  note('     whether "night-shift" is FREE on 0.peerjs.com is not a question a test can');
  note('     answer, and the failure is silent — you reach somebody else\'s room, or theirs.');
  note('  3. THE PROBE IS THE ONLY FACT ON THE SCREEN AND IS UNTESTED HERE. `probeRoom`');
  note('     needs a broker. Its verdicts are what the two lists lean on, so a probe that');
  note('     answered "live" for a dead room would make the honest column the lying one.');
  note('  4. ORDERING BETWEEN A KICK AND AN IN-FLIGHT BROADCAST. The sticky-field fix is');
  note('     asserted over a queue this file controls. On a real DataConnection the close');
  note('     and the last message race, and PeerJS may drop a queued send on close entirely');
  note('     — in which case the removed player sees "disconnected" and no reason at all.');
  note('  5. TWO TABS IN A HIDDEN PANE ARE THROTTLED TO ~1 Hz (Dev\\INDEX.md, learned on');
  note('     this repo). Section R\'s rates are pumped by hand and are therefore a model of');
  note('     the wire, not a measurement of a browser. The BYTES are exact; the RATE is');
  note('     what the loop asks for, not what a background tab will deliver.');
  note('MEASURED here: every byte figure in section R. REASONED: the seat counts derived');
  note('  from those bytes against a household uplink, and the claim that 0.peerjs.com has');
  note('  peer discovery disabled — that is the documented default, not something this');
  note('  suite contacted a broker to confirm.');
  emit();
}


/* ── X. the debrief does not ride every snapshot for ever ────────────────── */
async function sectionX(content) {
  heading('X. the largest field on the wire is sent when it changes, and not otherwise');

  /**
   * ⚠ MEASURED BY tools/soak.ps1, AND IT IS A STEP RATHER THAN A LEAK, WHICH IS WHY NOTHING
   * CAUGHT IT. `game.result` is the whole graded debrief — ten dimensions, each with a name,
   * a word and a sentence of prose — and it was sent flat in every snapshot. The field goes
   * from 1 byte to about 1,430 the instant the mission ends and then repeats at 12 Hz for
   * the rest of the session: roughly 17 kB/s of identical bytes, on six of nine incidents,
   * after there is nothing left to play.
   *
   * A snapshot is still a FULL snapshot of everything a late or lossy client needs to
   * converge — that is the property that makes 30% packet loss survivable and it is not
   * being given up. The debrief is the one field that cannot go stale: once the mission has
   * ended nothing produces a different one.
   */
  const host = rig(content, { seed: 'debrief' });
  host.n.host();
  host.g.commitLoadout(RECOMMENDED_MANIFEST);
  const client = mkClient(content, { seed: 'debrief-c' });
  client.links = seatOn(host, client, 'Two');

  const before = JSON.stringify(encodeSnapshot(host.g)).length;
  host.g.endMission('measured', host.g.clock.simTimeMs);
  ok('X1 the mission produced a graded debrief', !!host.g.result, typeof host.g.result);

  const first = JSON.stringify(encodeSnapshot(host.g));
  ok('X2 the first snapshot after the debrief carries it', first.includes('"rs"'));
  const step = first.length - before;
  note(`the debrief adds ${step} bytes to the snapshot it lands on`);
  ok('X3 and it is the largest single field on the wire', step > 400, `${step} bytes`);

  /* Pump one frame so the host records what it sent, then look again. */
  host.n.pump(200);
  const second = JSON.stringify(encodeSnapshot(host.g));
  ok('X4 the next snapshot does not carry it again', !second.includes('"rs"'), second.slice(0, 80));
  const saved = (first.length - second.length) * 12;
  note(`${Math.round(saved / 1024)} kB/s of repetition removed, per client, at 12 Hz`);
  ok('X5 and the saving is the whole field, every second, for the rest of the session', saved > 4000);

  /* ⚠ ABSENT MEANS UNCHANGED, NOT NULL. The clearing bug is one character away: a client
   * that reads `snap.rs || null` loses the debrief on the very frame after it arrives. */
  const cg = client.g;
  applySnapshot(cg, JSON.parse(first));
  ok('X6 a client that receives it keeps it', !!cg.result);
  applySnapshot(cg, JSON.parse(second));
  ok('X7 and a later snapshot without the field does not clear it', !!cg.result);

  /**
   * ⚠ AND THE CASE THAT MATTERS IS A RESUME, NOT A JOIN. Nobody can JOIN after the debrief —
   * §11.5's gate shuts at PROCEDURE_COMMITTED and the mission has ended — so the only way
   * anybody arrives at a welcome with a debrief already on the host is a dropped operative
   * reconnecting into their held seat. Which is exactly the person the field is for: they
   * missed the frame it changed on, and there is never another one.
   *
   * Written this way after X8 failed against a join and the refusal was correct. A test that
   * was "fixed" by moving the mission back before the gate would have tested the gate.
   */
  const seatId = client.n.localPlayerId;
  const seatToken = host.n.seats.get(seatId).token;
  client.links ? client.links.hl.close() : null;
  const back = mkClient(content, { seed: 'debrief-back' });
  const [bh, bc] = loopbackPair();
  host.n.accept(bh);
  back.n.join(bc, { name: 'Two', token: seatToken });
  ok('X8 a dropped operative resuming after the debrief still gets it, because a welcome forces every field',
    !!back.g.result, back.n.refusedWhy || back.n.status);
  emit();
}

/* ── W. a held seat is not a permanent claim ─────────────────────────────── */
async function sectionW(content) {
  heading('W. a dropped seat is held, and held is not held for ever');

  /**
   * ⚠ HELD-FOR-EVER IS THE OTHER BUG. §11.5 wants a drop to hold the slot — "reconnect
   * restores character state and inventory" — and the obvious implementation holds it until
   * the session ends. That is a squad of five with two dead laptops that can never refill,
   * for the rest of the operation, with the board reading "full". A drop is not a departure
   * and it is not a permanent claim either.
   *
   * AND THE SWEEP RUNS ONLY WHEN SOMEBODY WANTS A SEAT. Expiring on a timer is the other
   * mistake: it would take a dropped operative's kit off the floor in a room where nothing
   * was waiting for it, and a squad of two would lose a seat it was not competing for.
   */
  /* rig() carries its own injected clock; tick() moves it. */
  const host = rig(content, { seed: 'hold' });
  host.tick(1000);
  host.n.host();
  host.g.commitLoadout(RECOMMENDED_MANIFEST);

  /* Fill the squad. */
  const joiners = [];
  while (host.g.players.length < MAX_SQUAD) {
    const c = mkClient(content, { seed: `hold-${host.g.players.length}` });
    c.links = seatOn(host, c, `Op${host.g.players.length}`);
    joiners.push(c);
  }
  eq('W1 the squad is full, so the next join has to compete for a seat', host.g.players.length, MAX_SQUAD);

  /* One drops. The seat is held. */
  const dropped = joiners[0];
  const droppedId = dropped.n.localPlayerId;
  dropped.links.hl.close();
  eq('W2 a drop holds the seat rather than freeing it', host.g.players.length, MAX_SQUAD);
  ok('W3 and the operative is marked off the air rather than removed',
    host.g.playerById(droppedId) && host.g.playerById(droppedId).connected === false);

  /* Somebody asks for a seat before the hold is up. */
  const early = mkClient(content, { seed: 'early' });
  seatOn(host, early, 'Early');
  eq('W4 a newcomer inside the hold window is refused, because the seat is still theirs',
    host.g.players.length, MAX_SQUAD);
  ok('W5 and told why', /full/i.test(early.n.refusedWhy || ''), early.n.refusedWhy);

  /* Nothing has been swept, because nobody wanted a seat badly enough yet. */
  host.tick(CONFIG.net.seatHoldMs + 1000);
  eq('W6 the hold expiring on its own frees nothing, because nothing was waiting for it',
    host.g.players.length, MAX_SQUAD);
  ok('W7 and the operative is still on the roster, with their kit where it fell',
    !!host.g.playerById(droppedId));

  /* Now somebody asks. */
  const late = mkClient(content, { seed: 'late' });
  seatOn(host, late, 'Late');
  eq('W8 a newcomer after the hold gets the seat', host.g.players.length, MAX_SQUAD);
  ok('W9 and it is the seat of the one who has been gone longest', !host.g.playerById(droppedId));
  ok('W10 and the new operative is really on the roster',
    !!host.g.playerById(late.n.localPlayerId), late.n.refusedWhy || 'seated');
  note(`seat hold is ${CONFIG.net.seatHoldMs / 60000} minutes`);

  /* ⚠ AND THE SQUAD IS TOLD. A seat changing hands silently is the version of this that
   * generates a bug report: the squad sees a name they do not recognise and no explanation
   * anywhere. §18.1 again. */
  const said = host.g.notices.map((n) => n.text).join(' | ');
  ok('W11 and the squad is told whose seat went and why', /off the air/i.test(said), said.slice(-160));
  emit();
}
/* ── V. the reload that gets you back into YOUR seat ─────────────────────── */
async function sectionV(content) {
  heading('V. a friend who drops mid-mission gets back into their seat, by name');

  /**
   * The two things that end real co-op playtests early: a reload that loses your seat, and
   * a joiner called "Operative". The host has held seats and honoured tokens since §11.5
   * shipped; what was missing was the CLIENT remembering anything across a reload. The
   * memory is one blob in sessionStorage — token, room, YOUR OWN callsign — written at
   * WELCOME by the lobby screen, and §21.2 is the constraint the storage tests below
   * enforce: no other player's typed name may ever be in it.
   */
  const mem = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      dump: () => JSON.stringify([...m.entries()]),
    };
  };

  const host = rig(content, { seed: 'resume-h' });
  host.n.host();
  host.g.commitLoadout(RECOMMENDED_MANIFEST);
  host.n.selectOperation({ id: 'op-1', label: 'Op' });

  /* A machine that saved a callsign once, joining the way `joinPeer` would: the room code
   * goes on the session BEFORE the hello, which is what joinPeer does and the loopback
   * skips. */
  const localStore = mem(), sessionStore = mem();
  localStore.setItem('cd.lobby.callsign', 'Vasquez');
  const c1 = mkClient(content, { seed: 'resume-c' });
  c1.clock.ms = 5000;
  const root1 = document.createElement('div');
  document.body.appendChild(root1);
  const screen1 = new LobbyScreen(root1, {
    net: c1.n, site: { operations: [] }, now: () => c1.clock.ms, storage: localStore, session: sessionStore,
  });
  c1.n.code = 'AB12C';
  seatOn(host, c1, screen1.callsign);
  const seatId = c1.n.localPlayerId;
  const issued = host.n.seats.get(seatId).token;

  const blob = loadResume(sessionStore);
  ok('V1 a WELCOME writes the seat to sessionStorage — token, room, own callsign', !!blob, sessionStore.dump().slice(0, 120));
  eq('V2 and the token is the one the host issued, verbatim', blob.token, issued);
  eq('V3 filed under the room it belongs to', blob.code, 'AB12C');
  eq('V4 with the callsign this machine typed', blob.callsign, 'Vasquez');

  /* Somebody ELSE with a distinctive name, so the privacy grep below has teeth. */
  const c2 = mkClient(content, { seed: 'resume-c2' });
  seatOn(host, c2, 'Zebulon Drake');
  ok('V5 the other operative really is on the host\'s roster, so V6 is not vacuous',
    JSON.stringify(encodeLobby(host.n.lobby)).includes('Zebulon'));
  ok('V6 and NO other player\'s callsign is in this machine\'s stored blob (§21.2)',
    !sessionStore.dump().includes('Zebulon') && !localStore.dump().includes('Zebulon'),
    sessionStore.dump().slice(0, 160));
  eq('V7 the blob\'s whole shape is five known fields — a roster cannot grow in it',
    Object.keys(loadResume(sessionStore)).sort().join(), 'atMs,callsign,code,room,token');

  /* Give the seat the things that must survive: kit in a slot, a position, and a spent
   * action budget. */
  const p = host.g.playerById(seatId);
  p.take(content.itemsById.get('floodlight-tripod'));
  p.x = 7.25; p.z = 4.5;
  for (let i = 0; i < 3; i++) c1.n.act(ACT.SLOT, { n: 1 });
  eq('V8 the seat has acted, so its replay guard is wound up', host.n.seats.get(seatId).lastAct, 3);

  /* The reload. The tab dies; the host holds the seat. */
  [...host.n.seats.values()].find((s) => s.token === issued).link.close();
  eq('V9 the drop holds the seat rather than freeing it', host.g.players.length, 3);
  eq('V10 marked off the radio', host.g.playerById(seatId).connected, false);

  /* A fresh page: new Game, new NetSession, new screen — SAME stores, which is all a
   * reload keeps. */
  const back = mkClient(content, { seed: 'resume-back' });
  const root2 = document.createElement('div');
  document.body.appendChild(root2);
  const screen2 = new LobbyScreen(root2, {
    net: back.n, site: { operations: [] }, now: () => back.clock.ms, storage: localStore, session: sessionStore,
  });
  ok('V11 the fresh screen finds the held seat in sessionStorage', !!screen2.resume
    && screen2.resume.token === issued);
  screen2.show(null, { joiner: true });
  const rejoinBtn = screen2.node.querySelector('[data-rejoin]');
  ok('V12 and opens offering "Rejoin as Vasquez" in words', !!rejoinBtn
    && /Rejoin as Vasquez/.test(screen2.node.textContent), screen2.node.textContent.slice(0, 120));
  ok('V13 as the PRIMARY action — before the blank join field, styled as the go button',
    !!rejoinBtn && rejoinBtn.className.includes('go')
    && screen2.node.innerHTML.indexOf('data-rejoin') < screen2.node.innerHTML.indexOf('data-dojoin'));

  /* The reconnect, through the REAL hello path, offering the stored token. */
  const [rh, rc] = loopbackPair();
  host.n.accept(rh);
  back.n.join(rc, { name: 'Somebody Else', token: screen2.resume.token });
  eq('V14 the host gives back the SAME seat', back.n.localPlayerId, seatId);
  eq('V15 no second operative was created for it', host.g.players.length, 3);
  eq('V16 and the seat is back on the radio', host.g.playerById(seatId).connected, true);
  near('V17 standing exactly where they dropped — x', host.g.playerById(seatId).x, 7.25, 0.001);
  near('V18 and z', host.g.playerById(seatId).z, 4.5, 0.001);
  ok('V19 with their kit still in the slot (§11.5: reconnect restores inventory)',
    host.g.playerById(seatId).carrying('floodlight-tripod'));
  ok('V20 and the welcome snapshot hands the same seat and kit to the client',
    back.g.playerById(seatId) && back.g.playerById(seatId).carrying('floodlight-tripod'),
    back.g.playerById(seatId) ? 'seat found, no tripod' : 'no seat');
  /* The LOCAL seat's position is deliberately not written by `applySnapshot` — it goes
   * through the shipped correction path, and a resume error is far past `snapErrorM`
   * (1.2 m), so one reconcile is a TELEPORT to the host's answer. Assert through the real
   * mechanism rather than around it. */
  back.g.reconcileLocal(seatId);
  near('V20b one reconcile later the client stands where the host says they are',
    back.g.playerById(seatId).x, 7.25, 0.02);
  eq('V21 identity is the token, not the typed name — the callsign is still Vasquez',
    host.n.lobby.seatOf(seatId).callsign, 'Vasquez');
  ok('V22 and the moderation record calls it a resume', host.n.lobby.bySeat(seatId)
    .some((e) => e.kind === LOG_KIND.RESUMED));

  /**
   * ⚠ THE REPLAY GUARD RESTARTS WITH THE LINK. A reloaded client counts its actions from
   * one again, and the guard held the OLD session's high-water mark — so every ACT a
   * resumed operative sent was silently dropped as a replay until they had clicked past
   * their whole previous session. The seat looked fine and did nothing.
   */
  const acts = host.n.actsReceived;
  back.n.act(ACT.SLOT, { n: 2 });
  eq('V23 the first action after a resume is APPLIED, not dropped as a replay',
    host.n.actsReceived, acts + 1);
  eq('V24 and it did the thing', host.g.playerById(seatId).heldSlot,
    [...host.g.playerById(seatId).slots.keys()][2]);

  /**
   * ⚠ A DUPLICATED TAB CARRIES A COPY OF sessionStorage, so two windows can offer the
   * SAME token. The seat must converge to exactly one of them: the newer link wins and
   * the older is hung up — not left believing it plays.
   */
  const dup = mkClient(content, { seed: 'resume-dup' });
  const [dh, dc] = loopbackPair();
  host.n.accept(dh);
  dup.n.join(dc, { name: 'Vasquez', token: issued });
  eq('V25 the duplicate resumes into the same seat', dup.n.localPlayerId, seatId);
  eq('V26 still with no second operative', host.g.players.length, 3);
  ok('V27 the host now writes to the newer link', host.n.seats.get(seatId).link === dh);
  /* ⚠ `rc.open` is the wrong fact to assert: a loopback endpoint's `open` flag is its
   * OWN; the far end learns through `onClose`, exactly like a real DataConnection whose
   * wrapper flips the flag in the 'close' handler. What the fix owns is the host-side
   * hangup and what the old tab HEARS. */
  eq('V28 and the older tab\'s host-side link was hung up rather than left half-believing', rh.open, false);
  ok('V28b and the older tab heard the hangup', /disconnect/i.test(back.n.status), back.n.status);

  /* ── the blocked resume, through the stored blob ── */
  host.n.removeSeat(seatId, 'grief');
  const blocked = mkClient(content, { seed: 'resume-blocked' });
  const root3 = document.createElement('div');
  document.body.appendChild(root3);
  const screen3 = new LobbyScreen(root3, {
    net: blocked.n, site: { operations: [] }, now: () => blocked.clock.ms, storage: localStore, session: sessionStore,
  });
  ok('V29 the blob is still on the machine after a removal, so the next assertion is real',
    !!screen3.resume && screen3.resume.token === issued);
  const [bh, bc] = loopbackPair();
  host.n.accept(bh);
  blocked.n.join(bc, { name: 'Vasquez', token: screen3.resume.token });
  ok('V30 a removed operative\'s stored token does not walk them back in',
    !host.g.players.some((q) => q.id === seatId) && blocked.n.role === ROLE.CLIENT);
  ok('V31 and they are told why, in words that survive the hangup',
    /removed/i.test(blocked.n.status), blocked.n.status);
  eq('V32 the session says structurally that the offered token was refused', blocked.n.tokenRefused, true);
  screen3.refresh();
  ok('V33 so the screen burns the blob — that seat is never offered again',
    screen3.resume === null && loadResume(sessionStore) === null,
    String(sessionStore.getItem(RESUME_KEY)));

  [root1, root2, root3].forEach((r) => r.remove());
  emit();
}

/* ── V2. the joiner has a name, and a dead room fails in words ───────────── */
async function sectionV2(content) {
  heading('V2. names that propagate, and invite links that fail honestly');

  /* ── the rename, through the host's validated LACT path ── */
  const hostR = rig(content, { seed: 'rename-h' });
  hostR.n.host();
  hostR.n.selectOperation({ id: 'op-1', label: 'Op' });
  const rn = mkClient(content, { seed: 'rename-c' });
  const rl = seatOn(hostR, rn, 'Operative');
  const rid = rn.n.localPlayerId;
  eq('V34 an invite-link joiner lands as the default until they pick a name',
    hostR.n.lobby.seatOf(rid).callsign, 'Operative');

  rn.n.setCallsign('Nyx Seven');
  eq('V35 a client rename reaches the host\'s roster', hostR.n.lobby.seatOf(rid).callsign, 'Nyx Seven');
  eq('V36 and the operative under it', hostR.g.playerById(rid).name, 'Nyx Seven');
  eq('V37 and the host\'s echo is what renames the client\'s own copy',
    rn.n.lobby.seatOf(rid).callsign, 'Nyx Seven');

  rl.cl.send({ t: MSG.LACT, k: LACT.CALLSIGN, n: 'Y'.repeat(99) });
  eq('V38 a raw ninety-nine-character rename is clamped by the HOST, not by the sender\'s manners',
    hostR.n.lobby.seatOf(rid).callsign.length, 14);

  hostR.n.setReady('p1', true);
  rn.n.askReady(true);
  ok('V39 the squad deploys, so the next refusal is about the phase', hostR.n.deployLobby());
  rn.n.setCallsign('Too Late');
  eq('V40 a rename after deploy is refused — the roster is settled once the card is taken',
    hostR.n.lobby.seatOf(rid).callsign, 'Y'.repeat(14));

  /* ── the once-only name prompt, and the dead room, on the shipped screen ──
   * `joinPeer` needs a Peer; FakePeer is lifted from security-tests section SE with its
   * name kept, per the house rule about copied code staying greppable. */
  const keepPeer = globalThis.Peer;
  const made = [];
  class FakePeer {
    constructor(id) { this.id = id; this.open = false; this._h = new Map(); made.push(this); }

    on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, []); this._h.get(ev).push(fn); return this; }

    fire(ev, arg) { for (const fn of (this._h.get(ev) || []).slice()) fn(arg); }

    destroy() { this.open = false; }
  }
  const mem = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  };

  try {
    globalThis.Peer = FakePeer;
    const jc = mkClient(content, { seed: 'dead-room' });
    const freshLocal = mem(), freshSession = mem();
    const rootJ = document.createElement('div');
    document.body.appendChild(rootJ);
    const screenJ = new LobbyScreen(rootJ, {
      net: jc.n, site: { operations: [] }, now: () => jc.clock.ms, storage: freshLocal, session: freshSession,
    });
    screenJ.show(null, { joiner: true });
    screenJ.autoJoin('QQ9ZZ');
    ok('V41 a machine that never saved a callsign is asked for one, inline, exactly then',
      screenJ.askName === true && !!screenJ.node.querySelector('[data-firstname]'));
    ok('V42 while the join goes ahead underneath — the prompt stalls nothing',
      !!jc.n.joinAttempt && jc.n.joinAttempt.target === 'QQ9ZZ');
    ok('V43 and the screen says it is asking, with the join button parked',
      /Asking/.test(screenJ.node.textContent) && screenJ.node.querySelector('[data-dojoin]').disabled === true);

    /* The broker answers: nobody holds that id. This is what a dead invite link IS. */
    made[made.length - 1].fire('error', { type: 'peer-unavailable' });
    ok('V44 the failure is structural — target and reason, not a status string to parse',
      !!jc.n.joinFailed && jc.n.joinFailed.target === 'QQ9ZZ'
      && /nobody is holding/i.test(jc.n.joinFailed.why), JSON.stringify(jc.n.joinFailed));
    ok('V45 and the aspirational room identity came back off the session — this is what used to brick the screen',
      jc.n.code === null && jc.n.roomName === '' && jc.n.peer === null && jc.n.joinAttempt === null);

    screenJ.refresh();
    const said = screenJ.node.textContent;
    ok('V46 the lobby says it in words: nobody is answering, the room may be over',
      /Nobody is answering on QQ9ZZ/.test(said) && /room may be over/.test(said), said.slice(0, 200));
    ok('V47 with the join controls BACK — a second try is a click, not a reload',
      !!screenJ.node.querySelector('[data-dojoin]') && screenJ.node.querySelector('[data-dojoin]').disabled === false);
    ok('V48 and the host-your-own path right there on the same screen',
      !!screenJ.node.querySelector('[data-hostnow]') && !!screenJ.node.querySelector('[data-open]')
      && screenJ.node.querySelector('[data-open]').disabled === false);

    /* The prompt is answered — once, for good. */
    const nameField = screenJ.node.querySelector('[data-firstname]');
    nameField.value = 'Nyx';
    screenJ.node.querySelector('[data-firstnamego]').click();
    eq('V49 answering saves the callsign on this machine', freshLocal.getItem('cd.lobby.callsign'), 'Nyx');
    ok('V50 and takes the prompt down', screenJ.askName === false && !screenJ.node.querySelector('[data-firstname]'));
    const rootJ2 = document.createElement('div');
    document.body.appendChild(rootJ2);
    const screenJ2 = new LobbyScreen(rootJ2, {
      net: jc.n, site: { operations: [] }, now: () => jc.clock.ms, storage: freshLocal, session: freshSession,
    });
    screenJ2.show(null, { joiner: true });
    screenJ2.autoJoin('QQ7XX');
    ok('V51 the question is asked ONCE per machine — a later auto-join with a saved name never asks',
      screenJ2.askName === false && !screenJ2.node.querySelector('[data-firstname]'));

    /* The failure the broker never reports: a registered host that will not answer. The
     * screen's deadline calls it, with the same cleanup and the same words. */
    ok('V52 a join that hangs can be abandoned', jc.n.abandonJoin('nobody answered on QQ7XX'));
    screenJ2.refresh();
    ok('V53 and reads the same on screen: nobody is answering', /Nobody is answering on QQ7XX/.test(screenJ2.node.textContent),
      screenJ2.node.textContent.slice(0, 160));

    /* ── autoJoin picks the token, and only for ITS room ── */
    const aj = mkClient(content, { seed: 'aj' });
    const ajSession = mem();
    saveResume(ajSession, { token: 'p2-TOK99', code: 'AB12C', room: '', callsign: 'Vasquez' }, 100);
    let saw = 'never called';
    aj.n.joinPeer = (code, name, opts) => { saw = opts ? opts.token : 'no opts'; return true; };
    const rootA = document.createElement('div');
    document.body.appendChild(rootA);
    const screenA = new LobbyScreen(rootA, {
      net: aj.n, site: { operations: [] }, now: () => 1000, storage: freshLocal, session: ajSession,
    });
    screenA.show(null, { joiner: true });
    screenA.autoJoin('ab12c');
    eq('V54 an invite link back into the SAME room offers the stored token — the reload IS the resume',
      saw, 'p2-TOK99');
    ok('V55 and does not nag a returning operative for a name', screenA.askName === false);
    screenA.autoJoin('ZZ88Z');
    eq('V56 while a DIFFERENT room gets a fresh hello and no token', saw, null);

    [rootJ, rootJ2, rootA].forEach((r) => r.remove());
  } finally {
    globalThis.Peer = keepPeer;
  }
  emit();
}

/* ── run ─────────────────────────────────────────────────────────────────── */
await suite('net-tests', async () => {
  const content = await loadContent({ incident: 'cold-storage-draught' });
  await run('N', () => sectionN(content));
  await run('O', () => sectionO());
  await run('P', () => sectionP(content));
  await run('Q', () => sectionQ(content));
  await run('R', () => sectionR(content));
  await run('S', () => sectionS(content));
  await run('U', () => sectionU());
  await run('T', () => sectionT());
  await run('W', () => sectionW(content));
  await run('X', () => sectionX(content));
  await run('V', () => sectionV(content));
  await run('V2', () => sectionV2(content));
});
