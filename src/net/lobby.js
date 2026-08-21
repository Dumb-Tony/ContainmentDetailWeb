/* The room before the operation — GDD §11.4 (matchmaking), §11.7 (anti-griefing), and
 * §23's Milestone 4 line "hosted sessions, reconnect, profiles, and matchmaking".
 *
 * PURE. No transport, no Peer, no DOM, and — deliberately — NO WALL CLOCK. Every method
 * that needs to know when something happened is handed `atMs` by its caller. That is not
 * ceremony: `tools/m0-tests.js` section K5 forbids every file but the boot loop from
 * reading `Date.now`, and a staleness rule you cannot pin to a fixed instant is a rule you
 * cannot test. The screen supplies wall time; the session supplies simulation time; this
 * file has an opinion about neither.
 *
 * ── WHAT DISCOVERY IS HONESTLY POSSIBLE ON THIS TRANSPORT ────────────────────
 *
 * There is no game server. PeerJS's broker introduces two browsers by peer id and then
 * carries nothing, and the public broker at 0.peerjs.com ships with `allow_discovery`
 * off, so its `/peers` endpoint — the thing `peer.listAllPeers()` calls — answers nothing.
 * Even switched on it would list every peer on a broker shared with the whole internet,
 * with no room name, no squad size and no way to tell one game's ids from another's.
 *
 * So there are exactly three honest answers, and this file models all three:
 *
 *   PRIVATE   a random five-character code, which is what shipped. The peer id is
 *             `cdw-<CODE>`. Nobody can find it who was not told it. Perfectly good, and
 *             it is the reason the milestone exists: somebody has to read it aloud.
 *
 *   NAMED     a room NAME both ends type. `roomIdFor('night shift')` is `cdw-r-night-shift`
 *             on every machine, so a squad that agreed on a word in a group chat last week
 *             can meet without anybody reading out a code. ⚠ THE NAMESPACE IS THE WHOLE
 *             PUBLIC BROKER: if another squad — or another game — has claimed that id, the
 *             host is told the name is taken, and a joiner typing a popular word reaches
 *             whoever got there first. Short common names are a bad idea and the UI says so.
 *
 *   LISTED    a volunteer DIRECTORY. One well-known peer id; whichever browser currently
 *             holds it collects advertisements from hosts and hands the list to joiners.
 *             This is real discovery — a joiner who was told nothing at all can find a
 *             room — and its limits are severe enough that the UI must state every one:
 *               · the directory lives in a player's browser and evaporates when they close
 *                 the tab. The next host to try claims the id and starts an empty list.
 *               · every entry is a CLAIM by a host. The label and the seat count are not
 *                 verified by anyone, so `SessionDirectory` clamps them and refuses fields
 *                 it does not recognise rather than trusting the shape.
 *               · an entry is only as fresh as its last heartbeat. `list()` returns an
 *                 `ageMs` and a `stale` flag for every row and the screen prints both,
 *                 because §18.1 requires the UI to distinguish observed fact from
 *                 interpretation and "these rooms exist" is an interpretation of "these
 *                 rooms said so forty seconds ago".
 *             The one thing a listing NEVER carries is a callsign. An advertisement goes
 *             to a stranger's browser; the roster is the host's business and stays there.
 *
 * A fourth mechanism needs no directory at all and is the most reliable of the lot: the
 * joiner's OWN machine remembers rooms it has been in, and a room can be PROBED — connect
 * to the id and see whether anybody answers. A probe result is a fact rather than a
 * report, which is why `src/ui/lobby.js` prefers it over anything on this page.
 */

import { MAX_SQUAD } from './protocol.js';

/** Prefix on every peer id this game claims, so a broker shared with other projects
 *  cannot hand us somebody else's tab. */
export const ROOM_PREFIX = 'cdw-';

export const LOBBY_PHASE = Object.freeze({
  /** Seats are filling. Anybody may join, leave, change their mind. */
  FORMING: 'forming',
  /** Every connected seat has said ready. The host may take the operation card. */
  READY: 'ready',
  /** The squad went to the loadout screen. The lobby is behind them. */
  DEPLOYED: 'deployed',
});

export const VISIBILITY = Object.freeze({
  PRIVATE: 'private',
  NAMED: 'named',
  LISTED: 'listed',
});

/**
 * ⚠ A CLOSED VOCABULARY, NOT A TEXT BOX.
 *
 * A removal reason is typed by one player and read by another, which makes a free-text
 * field the one place in this build where an abusive host gets a private channel to
 * somebody they have just thrown out. It is also the one piece of moderation data that
 * leaves the host's machine. Both problems disappear if the reason is an id both ends
 * already have — the same argument §11.3 makes for the phrase wheel, and the same one
 * §21.2 makes about free text.
 */
export const REMOVAL_REASONS = Object.freeze({
  grief: 'Interfering with the operation',
  inactive: 'Not taking part',
  conduct: 'Conduct',
  seat: 'Making room for somebody else',
  unstated: 'Removed by the host',
});

export const DEFAULT_REASON = 'unstated';

/**
 * What the host's action record can say. Closed, for the same reason as above and one
 * more: a log whose kinds are open grows a free-text `detail` on the first awkward case,
 * and then the moderation record is a chat transcript.
 */
export const LOG_KIND = Object.freeze({
  SEATED: 'seated',
  LEFT: 'left',
  DROPPED: 'dropped',
  RESUMED: 'resumed',
  READY: 'ready',
  UNREADY: 'unready',
  OPERATION: 'operation',
  REMOVED: 'removed',
  READMITTED: 'readmitted',
  REFUSED: 'refused',
  DEPLOYED: 'deployed',
  /** A message the host could not parse. Anti-grief evidence, §20.9. */
  MALFORMED: 'malformed',
  /** A seat that spent its lobby budget. One entry per burst, not one per message. */
  FLOOD: 'flood',
});

const LOG_KINDS = new Set(Object.values(LOG_KIND));

/** Human words for the log, so the screen prints no sentence this file has not approved. */
export const LOG_WORDS = Object.freeze({
  seated: 'took a seat',
  left: 'signed off',
  dropped: 'lost the radio',
  resumed: 'came back on the radio',
  ready: 'reported ready',
  unready: 'stood down from ready',
  operation: 'the operation changed',
  removed: 'was removed by the host',
  readmitted: 'was readmitted by the host',
  refused: 'was refused a seat',
  deployed: 'the squad deployed',
  malformed: 'sent something the host could not read',
  flood: 'sent more than the lobby will accept',
});

/* ── room names ───────────────────────────────────────────────────────────── */

/**
 * A human-typable room name, reduced to something a peer id can be. Lossy on purpose:
 * "Night Shift", "night-shift" and "  NIGHT   SHIFT  " must all reach the same room, or
 * the mechanism is a code with extra steps.
 */
export function roomSlug(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
}

/** The rendezvous peer id for a room name, or null if the name reduces to nothing. */
export function roomIdFor(name) {
  const s = roomSlug(name);
  return s ? `${ROOM_PREFIX}r-${s}` : null;
}

/** The rendezvous peer id for an invite code. Kept distinct from the name namespace, so
 *  a room called "ABCDE" and the code ABCDE are different rooms. */
export function roomIdForCode(code) {
  const c = String(code == null ? '' : code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c ? `${ROOM_PREFIX}${c}` : null;
}

/**
 * How guessable a room name is, as a word rather than a score. §18.1: the UI distinguishes
 * observed fact from interpretation, and this is an interpretation, so it says so by being
 * a plain adjective the screen prints next to the field.
 */
export function nameExposure(name) {
  const s = roomSlug(name);
  if (!s) return 'none';
  if (s.length < 6) return 'guessable';
  if (s.length < 10 || !/[0-9]/.test(s)) return 'shared';
  return 'unlikely';
}

/* ── the lobby ────────────────────────────────────────────────────────────── */

/**
 * Who is in the room, what seat they hold, which operation is selected, whether the squad
 * is ready — and, on the host only, what everybody has done.
 *
 * ⚠ THE HOST'S COPY IS THE ONLY ONE THAT DECIDES ANYTHING. A client keeps a Lobby too and
 * `applyLobby` overwrites its seats wholesale from the host's broadcast, which is right
 * for a roster and would be catastrophic for anything the client owns — see the header of
 * `src/net/protocol.js` and `Game.notice` vs `Game.noticeLocal`, which is the same lesson
 * this project has already paid for once.
 */
export class Lobby {
  constructor({ maxSeats = MAX_SQUAD, logSize = 160, hostSeat = 'p1' } = {}) {
    this.maxSeats = maxSeats;
    this.hostSeat = hostSeat;
    this.phase = LOBBY_PHASE.FORMING;
    this.visibility = VISIBILITY.PRIVATE;
    this.roomName = '';
    this.code = null;
    /** { id, label, incident } — whichever operation card the host has picked. */
    this.operation = null;

    /** seatId -> { seatId, callsign, ready, connected, host, sinceMs } */
    this.seats = new Map();

    /**
     * Resume token -> { seatId, callsign, reason, atMs }. Keyed on the TOKEN and not on
     * the callsign, because a callsign is typed on the joining machine and changing it is
     * a keystroke. A token is issued by this host and is the only identifier in the
     * session the removed player did not choose.
     *
     * ⚠ It is therefore a block for THIS SESSION, and the UI must not call it a ban. A
     * removed player who reloads gets a fresh token and can come back. Saying otherwise
     * would be the UI claiming more than it delivers (§18.1). The honest defence against
     * a determined returner is that the host can remove them again, and the log remembers.
     */
    this.removed = new Map();

    /**
     * ⚠ THE ACTION LOG LIVES HERE AND NOWHERE ELSE, and the reason is §21.2.
     *
     * §24 asks for "action logs" as a moderation tool. A moderation log is useless without
     * the callsign — "somebody unsealed the case" names nobody — and §21.2 ends "do not
     * record raw voice, free-text chat, or unnecessary personal data", where the callsign
     * is the only free text a player types in this whole build. Those two requirements are
     * not in conflict; they are about two different logs, and the mistake would be to
     * satisfy them with one.
     *
     * So the analytics bus (`game.bus`) keeps carrying POSITIONAL seat ids and no names —
     * `tools/m0-tests.js` AN5 fails the build if a callsign ever reaches it — and the
     * moderation record is this array. It is:
     *   · host-only. A client's Lobby has an empty one and `encodeLobby` does not carry it,
     *     so no player ever receives the host's record of another player.
     *   · in memory. Never localStorage: keeping other people's typed names on disk after
     *     the tab closes is the "unnecessary personal data" the same sentence forbids.
     *   · bounded, and it says how much it dropped rather than silently forgetting.
     *   · made of closed-vocabulary kinds, so it cannot become a chat transcript.
     */
    this.log = [];
    this.logSize = logSize;
    this.logDropped = 0;
    this._seq = 0;

    /** seatId -> { tokens, atMs }. A lobby-action budget; see `charge`. */
    this._budget = new Map();
    this.floodBudget = 12;
    this.floodPerSec = 4;
  }

  /* ── seats ──────────────────────────────────────────────────────────────── */

  get size() { return this.seats.size; }
  get connectedCount() { return [...this.seats.values()].filter((s) => s.connected).length; }
  get full() { return this.seats.size >= this.maxSeats; }
  seatOf(seatId) { return this.seats.get(seatId) || null; }

  /** Take or update a seat. Returns the seat record. */
  take(seatId, { callsign = 'Operative', atMs = 0, host = false, log = true } = {}) {
    const existing = this.seats.get(seatId);
    const seat = existing || { seatId, ready: false, connected: true, host, sinceMs: atMs };
    seat.callsign = String(callsign || 'Operative').slice(0, 14);
    seat.connected = true;
    seat.host = host || seat.host;
    this.seats.set(seatId, seat);
    if (log) this.record(existing ? LOG_KIND.RESUMED : LOG_KIND.SEATED, seat, atMs);
    this._settle();
    return seat;
  }

  /** They said goodbye, or the host removed them: the seat is gone, not held. */
  release(seatId, atMs = 0, kind = LOG_KIND.LEFT) {
    const seat = this.seats.get(seatId);
    if (!seat) return false;
    this.seats.delete(seatId);
    this._budget.delete(seatId);
    this.record(kind, seat, atMs);
    this._settle();
    return true;
  }

  /** The radio died. §11.5 holds the seat; the lobby marks it and keeps the row. */
  setConnected(seatId, connected, atMs = 0) {
    const seat = this.seats.get(seatId);
    if (!seat || seat.connected === connected) return false;
    seat.connected = connected;
    /* ⚠ A seat that loses the radio also loses its READY. It was a statement about being
     * at the keyboard, and they are not. A lobby that deploys because a disconnected seat
     * is still counted as ready is the lobby deploying one operative short. */
    if (!connected) seat.ready = false;
    this.record(connected ? LOG_KIND.RESUMED : LOG_KIND.DROPPED, seat, atMs);
    this._settle();
    return true;
  }

  setReady(seatId, ready, atMs = 0) {
    const seat = this.seats.get(seatId);
    if (!seat || !seat.connected) return false;
    if (seat.ready === !!ready) return false;
    seat.ready = !!ready;
    this.record(ready ? LOG_KIND.READY : LOG_KIND.UNREADY, seat, atMs);
    this._settle();
    return true;
  }

  setCallsign(seatId, callsign) {
    const seat = this.seats.get(seatId);
    if (!seat) return false;
    seat.callsign = String(callsign || 'Operative').slice(0, 14);
    return true;
  }

  /* ── the operation ──────────────────────────────────────────────────────── */

  /**
   * Which operation the squad is going to. Changing it CLEARS EVERY READY — a ready is a
   * statement about a specific job, and a host who can swap the job under a squad that has
   * already said yes has a griefing tool rather than a lobby.
   */
  setOperation(op, atMs = 0) {
    const next = op ? { id: String(op.id || ''), label: String(op.label || op.displayName || ''), incident: String(op.incident || '') } : null;
    const before = this.operation ? this.operation.id : null;
    if (before === (next ? next.id : null)) { this.operation = next; return false; }
    this.operation = next;
    for (const seat of this.seats.values()) seat.ready = false;
    this.record(LOG_KIND.OPERATION, { seatId: this.hostSeat, callsign: null }, atMs, next ? next.id : '');
    this._settle();
    return true;
  }

  /**
   * §18.1 again: this is the difference between "everyone has said yes" and "everyone is
   * here". A squad of one is ready when the host is ready — solo is a session with nobody
   * connected, not a broken lobby.
   */
  get squadReady() {
    if (this.seats.size === 0) return false;
    if (!this.operation) return false;
    const live = [...this.seats.values()].filter((s) => s.connected);
    return live.length > 0 && live.every((s) => s.ready);
  }

  _settle() {
    if (this.phase === LOBBY_PHASE.DEPLOYED) return;
    this.phase = this.squadReady ? LOBBY_PHASE.READY : LOBBY_PHASE.FORMING;
  }

  /** The squad took the card. Joining stays open until the procedure commits (§11.5) —
   *  this is the lobby closing, not the mission door. */
  deploy(atMs = 0) {
    if (this.phase === LOBBY_PHASE.DEPLOYED) return false;
    this.phase = LOBBY_PHASE.DEPLOYED;
    this.record(LOG_KIND.DEPLOYED, { seatId: this.hostSeat, callsign: null }, atMs);
    return true;
  }

  /* ── moderation ─────────────────────────────────────────────────────────── */

  /**
   * Remove a seat. THE LOBBY DOES NOT TOUCH THE SIMULATION — `NetSession.removeSeat` is
   * what puts their kit back at the vehicle and their custody on the floor, because that
   * is the game's business and this file has never heard of a transit case. What happens
   * here is the record and the block.
   *
   * @returns {object|null} the removal record, or null if there is no such seat
   */
  remove(seatId, { reason = DEFAULT_REASON, token = null, atMs = 0 } = {}) {
    const seat = this.seats.get(seatId);
    if (!seat) return null;
    if (seat.host) return null;                 // the host cannot remove themselves
    const why = REMOVAL_REASONS[reason] ? reason : DEFAULT_REASON;
    const rec = { seatId, callsign: seat.callsign, reason: why, token: token || null, atMs };
    this.seats.delete(seatId);
    this._budget.delete(seatId);
    if (token) this.removed.set(token, rec);
    this.record(LOG_KIND.REMOVED, seat, atMs, why);
    this._settle();
    return rec;
  }

  /**
   * Undo a removal.
   *
   * ⚠ IT IS NOT A REWIND, AND THE UI SAYS SO. Readmitting clears the block so the next
   * HELLO carrying that token is accepted; the operative still has to reconnect, and they
   * come back through the ordinary join path into a FRESH seat. Whatever they were
   * carrying went back to the vehicle when they were removed and any custody they held was
   * put down where they stood (§11.5), and none of that is undone by this. The removal
   * stays on the log — readmission is a second entry, never an erasure, because a
   * moderation record that can be edited by the person being moderated for is not one.
   */
  readmit(token, atMs = 0) {
    const rec = this.removed.get(token);
    if (!rec) return null;
    this.removed.delete(token);
    this.record(LOG_KIND.READMITTED, { seatId: rec.seatId, callsign: rec.callsign }, atMs, rec.reason);
    return rec;
  }

  /** Every removal still in force, newest first. What the host's "readmit" list reads. */
  removals() {
    return [...this.removed.entries()]
      .map(([token, rec]) => ({ ...rec, token }))
      .sort((a, b) => b.atMs - a.atMs);
  }

  /** @returns {string|null} why this token may not have a seat, or null if it may. */
  blockedReason(token) {
    if (!token) return null;
    const rec = this.removed.get(token);
    if (!rec) return null;
    return REMOVAL_REASONS[rec.reason] || REMOVAL_REASONS[DEFAULT_REASON];
  }

  /* ── the budget ─────────────────────────────────────────────────────────── */

  /**
   * A token bucket per seat over lobby-scoped messages. A client that holds the ready key
   * down, or a modified one that does not need to, can otherwise make the host rebroadcast
   * the roster to everybody as fast as its send loop runs — griefing that costs the
   * attacker one line of code and costs the squad the session (§11.7).
   *
   * @returns {boolean} true if the action may proceed
   */
  charge(seatId, atMs = 0, cost = 1) {
    let b = this._budget.get(seatId);
    if (!b) { b = { tokens: this.floodBudget, atMs }; this._budget.set(seatId, b); }
    const dt = Math.max(0, atMs - b.atMs);
    b.tokens = Math.min(this.floodBudget, b.tokens + (dt / 1000) * this.floodPerSec);
    b.atMs = atMs;
    if (b.tokens < cost) { b.flooding = true; return false; }
    b.tokens -= cost;
    b.flooding = false;
    return true;
  }

  /** True the first time a seat goes over budget in a burst, so the log gets one entry. */
  noteFlood(seatId, atMs = 0) {
    const b = this._budget.get(seatId);
    if (!b || b.logged) return false;
    b.logged = true;
    const seat = this.seats.get(seatId) || { seatId, callsign: null };
    this.record(LOG_KIND.FLOOD, seat, atMs);
    return true;
  }

  /* ── the record ─────────────────────────────────────────────────────────── */

  /**
   * One line of the host's action record. `kind` must be in the closed vocabulary or the
   * entry is refused — an unknown kind is a caller inventing a category, and this is the
   * one structure in the build where that would quietly become free text.
   */
  record(kind, seat, atMs = 0, detail = '') {
    if (!LOG_KINDS.has(kind)) return null;
    const entry = {
      n: ++this._seq,
      atMs,
      kind,
      seatId: seat && seat.seatId ? seat.seatId : null,
      callsign: seat && seat.callsign ? String(seat.callsign).slice(0, 14) : null,
      detail: detail ? String(detail).slice(0, 32) : '',
    };
    this.log.push(entry);
    while (this.log.length > this.logSize) { this.log.shift(); this.logDropped++; }
    return entry;
  }

  /** Newest first, which is the order a host reads it in. */
  recent(n = 20) { return this.log.slice(-n).reverse(); }

  /** Everything one seat did, for the case the log exists to serve: "what did THEY do". */
  bySeat(seatId) { return this.log.filter((e) => e.seatId === seatId); }

  /* ── the advertisement ──────────────────────────────────────────────────── */

  /**
   * What a stranger's browser is allowed to know about this room.
   *
   * ⚠ NO CALLSIGNS. A directory entry travels to a machine nobody in this squad controls
   * and sits in its memory alongside every other room's. The seat COUNT is what a joiner
   * needs to decide whether to knock; who is in the seats is the squad's business.
   */
  describe(atMs = 0) {
    return {
      code: this.code || '',
      room: this.roomName || '',
      label: this.operation ? this.operation.label : '',
      incident: this.operation ? this.operation.incident : '',
      seats: this.seats.size,
      max: this.maxSeats,
      phase: this.phase,
      atMs,
    };
  }
}

/* ── the volunteer directory ──────────────────────────────────────────────── */

/** Only these fields survive an advertisement. Anything else a peer sends is dropped. */
export const ADVERT_FIELDS = Object.freeze(['code', 'room', 'label', 'incident', 'seats', 'max', 'phase', 'atMs']);
/** Control characters, stripped from anything a stranger's browser will print. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

/**
 * The list of rooms, as a data structure. Held by whichever browser currently owns the
 * well-known directory peer id, and mirrored by every joiner that asks it for the list.
 *
 * PURE, so the same object is the authority on one machine and the cache on another, and
 * so the suite can drive every staleness and every hostile advertisement with no broker.
 */
export class SessionDirectory {
  /**
   * @param staleMs  past this, a row is shown but marked "may be gone"
   * @param dropMs   past this, a row is forgotten entirely
   * @param max      the cap. One browser is holding this list for strangers; a directory
   *                 that grows without bound is a denial-of-service with no attacker.
   */
  constructor({ staleMs = 45000, dropMs = 150000, max = 40 } = {}) {
    this.staleMs = staleMs;
    this.dropMs = dropMs;
    this.max = max;
    this.entries = new Map();        // code -> sanitised entry
    this.rejected = 0;
  }

  get size() { return this.entries.size; }

  /**
   * Take one advertisement. EVERY FIELD IS A CLAIM — this runs on a machine that has never
   * met the advertiser — so the entry is rebuilt from a whitelist rather than spread, text
   * is stripped of control characters and clamped, and numbers are coerced into range.
   *
   * @returns {object|null} the stored entry, or null if it was refused
   */
  advertise(raw, atMs = 0) {
    if (!raw || typeof raw !== 'object') { this.rejected++; return null; }
    const code = String(raw.code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
    const room = roomSlug(raw.room);
    if (!code && !room) { this.rejected++; return null; }
    const key = code || `R:${room}`;
    if (!this.entries.has(key) && this.entries.size >= this.max) { this.rejected++; return null; }
    const max = Math.max(1, Math.min(MAX_SQUAD, Number(raw.max) || MAX_SQUAD));
    const entry = {
      code,
      room,
      label: String(raw.label || '').replace(CONTROL_CHARS, '').slice(0, 40),
      incident: String(raw.incident || '').replace(/[^a-z0-9-]/gi, '').slice(0, 32),
      seats: Math.max(0, Math.min(max, Math.round(Number(raw.seats) || 0))),
      max,
      phase: Object.values(LOBBY_PHASE).includes(raw.phase) ? raw.phase : LOBBY_PHASE.FORMING,
      atMs,
    };
    /* ⚠ THE ENTRY IS REBUILT, NEVER SPREAD. `{ ...raw }` here is the first time a host can
     * put a callsign, a URL or a script fragment into every joiner's directory, and it is
     * the kind of line that looks like tidying. `ADVERT_FIELDS` is exported so the suite
     * can assert that what comes out has exactly these keys and no others. */
    this.entries.set(key, entry);
    return entry;
  }

  withdraw(code) {
    const key = String(code || '').trim().toUpperCase();
    return this.entries.delete(key) || this.entries.delete(`R:${roomSlug(code)}`);
  }

  prune(nowMs) {
    let n = 0;
    for (const [k, e] of this.entries) if (nowMs - e.atMs > this.dropMs) { this.entries.delete(k); n++; }
    return n;
  }

  /**
   * The rows, newest first, each carrying HOW OLD IT IS rather than a verdict. The screen
   * prints the age; §18.1 does not let a list of maybes look like a list of rooms.
   */
  list(nowMs = 0) {
    this.prune(nowMs);
    return [...this.entries.values()]
      .map((e) => ({ ...e, ageMs: Math.max(0, nowMs - e.atMs), stale: nowMs - e.atMs > this.staleMs }))
      .sort((a, b) => a.ageMs - b.ageMs);
  }

  /** What goes on the wire when a joiner asks. Same clamping, one array. */
  encode(nowMs = 0) { return this.list(nowMs).map(({ ageMs, stale, ...e }) => ({ ...e, ageMs })); }
}
