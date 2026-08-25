/* Transport and session — GDD §11 and §20.3.
 *
 * Copied in shape from SmallTownEmergencyServices `src/net/net.js` (Dev/INDEX.md →
 * Multiplayer), which took it from Chameleon's `mpHost`/`mpJoin`. Names kept so the
 * lineage stays greppable. Generalised here from one partner to a squad of five, and
 * given the three things GDD §11.5 asks for that a two-player session never needed:
 * a join-in-progress gate, a reserved slot on a drop, and a resume token.
 *
 * THE AUTHORITY RULE, stated once. The host's simulation is the mission (§20.3). A client
 * sends intent and draws snapshots; it never steps the world, so it cannot disagree about
 * whether custody was established. That costs the client a frame of input lag and buys the
 * one thing co-op cannot do without: five people who are definitely in the same building.
 *
 * ⚠ THIS FILE IS THE ONLY PLACE `Peer` IS TOUCHED. Everything above it talks to a Link —
 * `send`, `onMessage`, `onOpen`, `onClose`, `close` — which is thin enough to swap for a
 * loopback pair, and that is how the suite drives a whole three-operative session with no
 * WebRTC and no broker in sight.
 */

import {
  MSG, ACT, LACT, PROTOCOL_VERSION, MAX_SQUAD,
  encodeCommand, decodeCommand, encodeSnapshot, encodeFullSnapshot, applySnapshot, encodeLobby, applyLobby,
  safeId, safeLine,
} from './protocol.js';
import {
  Lobby, SessionDirectory, LOBBY_PHASE, VISIBILITY, LOG_KIND, REMOVAL_REASONS,
  DEFAULT_REASON, ROOM_PREFIX, roomIdFor, roomIdForCode, roomSlug,
} from './lobby.js';
import { PHASE } from '../sim/mission.js';
import { CONFIG } from '../config.js';

/* Signalling only: the broker introduces two browsers and then gets out of the way — no
 * game traffic passes through it. It is the one network host this build contacts, and the
 * suite's source-hygiene check (section K) knows about this file by name for that reason. */
const PEER_OPTS = { host: '0.peerjs.com', port: 443, secure: true, debug: 0 };

/**
 * The well-known id of the volunteer directory (see the header of `lobby.js` for what that
 * is and what it is not). Versioned, so a protocol change does not have to argue with the
 * tabs still holding the old one.
 *
 * ⚠ It is a peer id on a broker shared with the entire internet, claimed by whichever
 * player's browser gets there first. It is not a service, it has no operator, and it is
 * gone the moment that tab closes. Everything downstream of it treats what it says as a
 * report rather than as a fact.
 */
const DIRECTORY_ID = `${ROOM_PREFIX}directory-1`;

/** How often a listed room re-announces itself, in frames' worth of milliseconds. */
const ADVERT_EVERY_MS = 20000;

/**
 * How much discrete action a seat may spend, and how fast it comes back.
 *
 * ⚠ THESE TWO NUMBERS ARE THE ONLY THING BETWEEN A MODIFIED CLIENT AND THE HOST'S FRAME
 * BUDGET, so both ends of the range matter. `ACT_BURST` has to clear anything a person can
 * do in one breath — a slot change, an interact, a use, and the four the tablet fires when
 * a procedure is committed — or the game refuses a real player. `ACT_PER_SEC` has to sit
 * well under a send loop, which is 60 Hz, or the limit is decoration. Twelve a second is
 * four times the fastest anybody has been measured playing and a fifth of the wire.
 */
export const ACT_BURST = 30;
export const ACT_PER_SEC = 12;

/** A centimetre field off the wire. ⚠ NOT `(m.x || 0) / 100` — see `_hostRead`: JSON has no
 *  NaN, and `null / 100` is 0, so the coercing form accepts a field the sender could not
 *  encode and turns it into a real coordinate of zero. */
function num100(v) { return typeof v === 'number' && Number.isFinite(v) ? v / 100 : 0; }

/**
 * The procedure card, rebuilt from a whitelist.
 *
 * Five fields of prose the squad picked off the planner, plus the list they promised to
 * maintain. `commitProcedure` spread whatever object arrived and stored it on the mission;
 * a card is not a place for a client to park data, and every one of these strings is
 * printed on the tablet.
 */
function procedureCard(card) {
  const c = card && typeof card === 'object' && !Array.isArray(card) ? card : {};
  const one = (v) => safeLine(v, 160);
  return {
    target: one(c.target), state: one(c.state), trigger: one(c.trigger),
    transfer: one(c.transfer), abort: one(c.abort),
    maintained: (Array.isArray(c.maintained) ? c.maintained : []).slice(0, 12).map(one).filter(Boolean),
  };
}

/** Five characters, none of them ones that get misheard over a radio. */
export function randCode(rand = Math.random) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += A[Math.floor(rand() * A.length)];
  return c;
}

/* ── links ────────────────────────────────────────────────────────────────── */

/**
 * Two endpoints wired to each other, in process. `send` JSON round-trips, so a test
 * cannot accidentally pass a live object reference across the link and prove nothing.
 */
export function loopbackPair({ latencyMs = 0, schedule = null } = {}) {
  const deliver = schedule || ((fn) => fn());

  function makeEndpoint() {
    return {
      open: true, onMessage: null, onOpen: null, onClose: null, sent: 0, bytes: 0,
      send(msg) {
        if (!this.open || !this._peer.open) return false;
        const wire = JSON.stringify(msg);
        this.sent++;
        this.bytes += wire.length;
        const target = this._peer;
        /* ⚠ The schedule is handed the SIZE as well as the delay. Without it a wire model
         * can be lossy, late and jittery but never NARROW — and "how many seats before
         * this stops being fair" is a bandwidth question, not a latency one. Third
         * argument rather than a new option so every existing schedule (`(fn, ms) => …`)
         * keeps working unchanged. */
        deliver(() => { if (target.open && target.onMessage) target.onMessage(JSON.parse(wire)); }, latencyMs, wire.length);
        return true;
      },
      close() {
        if (!this.open) return;
        this.open = false;
        if (this.onClose) this.onClose();
        if (this._peer.open && this._peer.onClose) this._peer.onClose();
      },
    };
  }

  const a = makeEndpoint(), b = makeEndpoint();
  a._peer = b; b._peer = a;
  return [a, b];
}

function wrapConn(conn) {
  return {
    open: true, onMessage: null, onOpen: null, onClose: null,
    send(msg) { try { conn.send(msg); return true; } catch { return false; } },
    close() { this.open = false; try { conn.close(); } catch { /* already gone */ } },
  };
}

/* ── the session ──────────────────────────────────────────────────────────── */

export const ROLE = Object.freeze({ SOLO: 'solo', HOST: 'host', CLIENT: 'client' });

/**
 * Owns the role, the links, and the pumping. It does NOT own the simulation: on the host
 * `game.js` still steps the world, and on a client nothing steps at all.
 */
export class NetSession {
  /**
   * @param opts.now  the clock the LOBBY is timed against. Defaults to simulation time,
   *   which is right for a session already running and wrong for a lobby: the mission
   *   clock is paused behind an open panel, so a token bucket refilling on it never
   *   refills and a seat that spent its budget would be muted for the rest of the room.
   *   `main.js` injects wall time. ⚠ It is injected rather than read because section K5
   *   forbids every file but the boot loop from touching the wall clock, and because a
   *   staleness rule you cannot pin to a fixed instant is a rule you cannot test.
   */
  constructor(game, { snapshotHz = 12, now = null } = {}) {
    this.game = game;
    this.role = ROLE.SOLO;
    this.code = null;
    this.status = 'not connected';
    this.snapshotEveryMs = 1000 / snapshotHz;
    this._sinceSnapMs = 0;
    this.onStatus = null;
    this.onRoster = null;
    this.onLobby = null;
    this.peer = null;
    this.now = now || (() => this.game.clock.simTimeMs);

    /** The room before the operation (GDD §11.4). Host-authoritative; a client's copy is
     *  overwritten by every broadcast — see `applyLobby`. */
    this.lobby = new Lobby({ maxSeats: MAX_SQUAD });
    /** Set only on the browser that is currently HOLDING the volunteer directory. */
    this.directory = null;
    /** The rows a joiner last got back from a directory, with their ages. Never trusted. */
    this.rooms = [];
    this.roomName = '';
    this.visibility = VISIBILITY.PRIVATE;

    /**
     * ⚠ TWO STICKY FIELDS THAT A LATER MESSAGE MAY NOT ERASE.
     *
     * `refusedWhy` is why the host would not seat us; `removedWhy` is why the host threw
     * us out. Both are followed immediately by the link closing, and `onClose` used to be
     * the last thing to write to `status` — so the one sentence explaining what happened
     * was reliably replaced by "disconnected" a few milliseconds later. Same defect as
     * `applySnapshot` eating every REFUSAL, one layer out: a message about YOU cannot live
     * in a structure the host replaces wholesale, and it cannot live anywhere a hangup
     * handler writes to either.
     */
    this.refusedWhy = null;
    this.removedWhy = null;
    this._advertAtMs = -1e9;

    /** host: playerId -> {link, token}. client: the single link to the host. */
    this.seats = new Map();
    /** seatId -> {tokens, atMs}. The mission-action budget; see `_chargeAct`. */
    this._actBudget = new Map();
    this.link = null;
    this.localPlayerId = 'p1';
    /** Handed back by the host so a dropped operative can reclaim their own slot. */
    this.token = null;
    /**
     * Fired once per WELCOME, on the client. This is the moment the host has handed back a
     * seat and a resume token, and the ONE place a screen with a storage can be told to
     * remember them — `src/ui/lobby.js` wires it and keeps the blob in sessionStorage.
     * A dedicated hook rather than a ride on `onStatus`, because main.js reassigns the
     * shared three after the screen is built and a piggyback would be silently clobbered.
     */
    this.onWelcome = null;
    /** The token this client OFFERED in its hello, which is not `this.token` — that one is
     *  only written by a WELCOME. Needed to tell "the host refused my resume" from "the
     *  host refused me", because only the first should burn the stored blob. */
    this._offeredToken = null;
    /** Set when a REFUSE arrives on a hello that carried a token: the resume is dead and
     *  whoever stored it should forget it. Sticky, like the two reasons above. */
    this.tokenRefused = false;
    /**
     * ⚠ A JOIN THAT IS STILL IN FLIGHT AND A JOIN THAT DIED ARE TWO STATES, AND `status`
     * WAS CARRYING BOTH AS PROSE. The screen needs them structurally: while `joinAttempt`
     * is set the join column stays up saying "asking"; when it becomes `joinFailed` the
     * screen says in words that nobody answered and offers hosting instead. Without these,
     * a dead room left the lobby showing a DISABLED host panel with the failed code
     * rendered as if it were your own room — measured before this existed: `joinPeer` set
     * `this.code` optimistically, `committed` read it, and the join controls vanished on
     * the first click, permanently.
     */
    this.joinAttempt = null;
    this.joinFailed = null;
    this.lastSnapshot = null;
    this.snapsReceived = 0;
    this.cmdsReceived = 0;
    this.actsReceived = 0;
    this.actsRefused = 0;
    this._actSeq = 0;
    /** Lobby-scoped traffic, counted separately because it is the thing a griefer can
     *  cheaply multiply and the thing the load test needs a number for. */
    this.lactsReceived = 0;
    this.lactsDropped = 0;
    this.lobbyBroadcasts = 0;
    /** Messages the host could not read at all. §20.9: never trust client claims — and
     *  never let one throw out of the inbox and take the session with it. */
    this.malformed = 0;
    /**
     * ⚠ AND THE SAME COUNTER FOR THE OTHER DIRECTION, WHICH DID NOT EXIST.
     *
     * The header of this file says the host's inbox is "the one function in this build a
     * stranger can call". That was never true. A PRIVATE room is a code somebody read
     * aloud, but a NAMED room is a word on a broker shared with the whole internet and a
     * LISTED one is advertised to anybody who asks — so in two of the three shapes this
     * build ships, THE HOST IS A STRANGER, and `_clientOnMessage` is the function they
     * reach. It was the only inbox with no wrapper, no counter and no validation.
     */
    this.hostMalformed = 0;
    /** Snapshots and lobby broadcasts this end refused outright, with the last reason. */
    this.framesRefused = 0;
    this.lastRefusal = null;
    /** ACTs dropped for spending the seat's budget. See `_hostAct`. */
    this.actsFlooded = 0;
  }

  get online() { return this.role !== ROLE.SOLO; }
  get squadSize() { return this.game.players.length; }

  _say(status) {
    this.status = status;
    if (this.onStatus) this.onStatus(status, this);
  }

  _roster() {
    if (this.onRoster) this.onRoster(this.game.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })));
  }

  /* ── host ─────────────────────────────────────────────────────────────── */

  /** Become the host. Idempotent; clients are attached one at a time by `accept`. */
  host() {
    this.role = ROLE.HOST;
    this.localPlayerId = 'p1';
    this.game.localId = 'p1';
    /* Seat one exists the moment there is a host — a lobby of one is a solo operation
     * that has not been told it is alone yet, and the host must be able to say ready
     * exactly like everybody else or `squadReady` means "everybody but me". */
    const me = this.game.playerById('p1');
    if (!this.lobby.seatOf('p1')) {
      this.lobby.take('p1', { callsign: me ? me.name : 'Operative', host: true, atMs: this.now() });
    }
    this._say('hosting');
    return this;
  }

  /* ── the lobby, host side ─────────────────────────────────────────────── */

  /** Announce the room's identity. Nothing here reaches the broker; `hostPeer` does that. */
  setRoom({ roomName = null, code = null, visibility = null } = {}) {
    if (roomName !== null) { this.roomName = roomSlug(roomName); this.lobby.roomName = this.roomName; }
    if (code !== null) { this.code = code; this.lobby.code = code; }
    if (visibility !== null) { this.visibility = visibility; this.lobby.visibility = visibility; }
    this._broadcastLobby();
    return this;
  }

  /** Which operation the squad is going to. Clears every ready — see `Lobby.setOperation`. */
  selectOperation(op) {
    if (this.role === ROLE.CLIENT) return false;
    const changed = this.lobby.setOperation(op, this.now());
    this._broadcastLobby();
    return changed;
  }

  /**
   * Change the local operative's callsign. On a client it is a REQUEST — the host owns the
   * roster, and a client that renamed itself locally would be renamed back by the next
   * broadcast, which is the `applyLobby` hazard in its mildest form.
   */
  setCallsign(name) {
    const clean = String(name || '').trim().slice(0, 14) || 'Operative';
    if (this.role === ROLE.CLIENT) return this.askCallsign(clean);
    const me = this.game.playerById(this.localPlayerId);
    if (me) me.name = clean;
    this.lobby.setCallsign(this.localPlayerId, clean);
    this._roster();
    this._broadcastLobby();
    return true;
  }

  /** The host's own ready, and a client's once the host has applied it. */
  setReady(seatId, ready) {
    if (this.role === ROLE.CLIENT) return this.askReady(ready);
    const changed = this.lobby.setReady(seatId, ready, this.now());
    if (changed) this._broadcastLobby();
    return changed;
  }

  /** The squad took the card. The lobby closes; the JOIN gate does not (§11.5). */
  deployLobby() {
    if (this.role === ROLE.CLIENT) return false;
    const ok = this.lobby.deploy(this.now());
    if (ok) this._broadcastLobby();
    return ok;
  }

  /**
   * ⚠ REMOVAL IS AUTHORITATIVE AND IT IS THE HOST'S SIMULATION THAT MAKES IT SO. There is
   * no vote, no acknowledgement from the removed client, and nothing the client can send
   * that undoes it: the seat is gone from `game.players` on the machine that runs the
   * mission, so a modified client that ignores the KICK is a modified client talking to
   * nobody. §11.7 asks for "vote-to-remove with abuse protection" in PUBLIC matchmaking;
   * this is a peer-hosted session where the host's machine IS the server, and pretending a
   * vote binds them would be the UI claiming more than it delivers (§18.1).
   *
   * ⚠ AND NOTHING THEY WERE CARRYING LEAVES WITH THEM. `game.removePlayer` puts their kit
   * back at the vehicle and — the case that matters — puts a SEALED TRANSIT CASE down
   * where they stood rather than into a crate at the far end of the floor. That is the
   * same rule `_seatDropped` obeys for a lost radio, and it has to be the same rule here:
   * an operation nobody can finish because the host removed the person holding custody is
   * a worse outcome than the griefing (§11.7, "recovery of deliberately discarded unique
   * items"; §24, "recoverable unique items").
   *
   * @returns {object|null} the removal record, or null if there is no such seat
   */
  removeSeat(seatId, reason = DEFAULT_REASON) {
    if (this.role !== ROLE.HOST) return null;
    const seat = this.seats.get(seatId);
    const p = this.game.playerById(seatId);
    if (!p || seatId === 'p1') return null;

    const atMs = this.now();
    const rec = this.lobby.remove(seatId, { reason, token: seat ? seat.token : null, atMs });
    if (!rec) return null;

    /* Tell them BEFORE hanging up, and tell them with an id rather than a sentence — the
     * reason is a closed vocabulary both ends already have (§21.2, §11.3). */
    if (seat && seat.link && seat.link.open) {
      seat.link.send({ t: MSG.KICK, why: rec.reason });
      seat.link.close();
    }
    this.seats.delete(seatId); this._actBudget.delete(seatId);
    /* The order matters: the kit comes off the operative while they are still on the
     * roster, because `removePlayer` is the only thing that knows how to put it down. */
    this.game.removePlayer(seatId);
    this.game.notice(`${rec.callsign} was removed from the squad. Their kit is recoverable.`);
    this._say(`${rec.callsign} removed`);
    this._roster();
    this._broadcastLobby();
    return rec;
  }

  /**
   * Undo a removal. See `Lobby.readmit`: it clears the block, it does not rewind. They
   * still have to reconnect, they come back to a fresh seat, and the kit that went back to
   * the vehicle stays at the vehicle.
   */
  readmitSeat(token) {
    if (this.role !== ROLE.HOST) return null;
    return this.lobby.readmit(token, this.now());
  }

  /**
   * The room, as one message to everybody in it. Sent on CHANGE rather than on a timer:
   * a lobby moves at the speed of people clicking, and putting it on the snapshot cadence
   * would multiply the cheapest state in the game by the fastest rate in it.
   */
  _broadcastLobby() {
    if (this.role !== ROLE.HOST) return 0;
    const msg = encodeLobby(this.lobby);
    let n = 0;
    for (const seat of this.seats.values()) if (seat.link && seat.link.open) { seat.link.send(msg); n++; }
    this.lobbyBroadcasts += n;
    if (this.onLobby) this.onLobby(this.lobby, this);
    return n;
  }

  /**
   * Attach one client's link. The seat is not allocated until their HELLO arrives, because
   * only then do we know whether they are new or coming back.
   */
  accept(link) {
    if (this.role !== ROLE.HOST) this.host();
    link.onMessage = (m) => this._hostOnMessage(link, m);
    link.onClose = () => this._seatDropped(link);
    return link;
  }

  _seatOf(link) {
    for (const [id, seat] of this.seats) if (seat.link === link) return { id, seat };
    return null;
  }

  /**
   * ⚠ THE HOST'S INBOX IS THE ONE FUNCTION IN THIS BUILD A STRANGER CAN CALL.
   *
   * It is wrapped, and every field it reads is range-checked, for a reason recorded in
   * Dev\INDEX.md against the same function in SmallTownEmergencyServices: a malformed
   * `{t:'cmd'}` with no fields threw straight out of the handler and took the host's whole
   * shift with it. `decodeCommand` reads `m.a[0]` — one client sending `{t:'cmd'}` and
   * nothing else is a one-line denial of service against four other people's evening, and
   * §11.7's anti-griefing list is exactly about that class of thing.
   *
   * A message that cannot be read is COUNTED and logged against the seat, not silently
   * swallowed: "what did they do" is the question the moderation record exists to answer,
   * and "sent 4,000 things I could not parse" is an answer.
   */
  _hostOnMessage(link, m) {
    try {
      this._hostRead(link, m);
    } catch (e) {
      this.malformed++;
      const found = this._seatOf(link);
      if (found) this.lobby.record(LOG_KIND.MALFORMED, this.lobby.seatOf(found.id) || { seatId: found.id }, this.now());
    }
  }

  _hostRead(link, m) {
    if (!m || typeof m !== 'object') { this.malformed++; return; }
    if (m.t === MSG.HELLO) {
      /**
       * ⚠ ONE CONNECTION COULD TAKE THE WHOLE SQUAD.
       *
       * Nothing checked whether this link already held a seat, and `_hostHello` allocates
       * unconditionally — so a modified client that sent HELLO five times got five
       * operatives, five sets of kit and every remaining slot, from one data channel. The
       * board then said "full" and no real person could join, which is §11.7's anti-griefing
       * list in one line of somebody else's JavaScript. It was invisible because the honest
       * client sends exactly one and `_seatOf` returns the FIRST match, so even the host's
       * own roster read as if one person had joined.
       *
       * ⚠ AND THE RESUME PATH STILL WORKS, because a resume arrives on a link that does NOT
       * yet hold a seat — that is what makes it a reconnect. The guard is on the link, not
       * on the token.
       */
      if (this._seatOf(link)) {
        this.malformed++;
        this.lobby.record(LOG_KIND.MALFORMED, this.lobby.seatOf(this._seatOf(link).id) || {}, this.now());
        return;
      }
      return this._hostHello(link, m);
    }

    const found = this._seatOf(link);
    if (!found) return;                       // talking before saying hello
    const { id } = found;

    if (m.t === MSG.CMD) {
      /**
       * Shape first. `decodeCommand` indexes `m.a`, so an absent axis is a thrown
       * exception rather than a zero, and a non-numeric yaw poisons the operative's
       * position for the rest of the mission on every machine.
       *
       * ⚠ `typeof x === 'number'`, NOT `Number.isFinite(+x)`. JSON has no NaN, so a NaN
       * yaw arrives as `null` — and `+null` is 0, which is finite, which means the
       * coercing version accepts it and quietly turns a garbage field into a real
       * heading of zero. `null`, `''` and `[]` all coerce to 0 the same way. A field the
       * sender could not encode is a field this end must refuse, not repair.
       */
      const num = (x) => typeof x === 'number' && Number.isFinite(x);
      if (!Array.isArray(m.a) || m.a.length < 2
        || !num(m.a[0]) || !num(m.a[1]) || !num(m.y) || !num(m.p)) {
        this.malformed++;
        this.lobby.record(LOG_KIND.MALFORMED, this.lobby.seatOf(id) || { seatId: id }, this.now());
        return;
      }
      this.cmdsReceived++;
      const cmd = decodeCommand(m);
      const p = this.game.playerById(id);
      /* Look is the client's to own — it is pure presentation until it is not, and the
       * host needs it to resolve their reach and their deploy direction. Position is NOT:
       * the host integrates that from the axis, so a modified client cannot walk through
       * a wall by asserting it is already on the other side (§20.9). */
      if (p) { p.yaw = cmd.yaw; p.pitch = cmd.pitch; }
      this.game.setCommand(id, cmd);
      return;
    }

    if (m.t === MSG.ACT) { this._hostAct(id, m); return; }
    if (m.t === MSG.LACT) { this._hostLobbyAct(id, m); return; }
    if (m.t === MSG.BYE) { this._seatLeft(link, true); }
  }

  /**
   * A lobby-scoped request. Nothing on this path can reach the simulation — that is the
   * point of it being a separate message kind — so the worst a client can do here is make
   * the host rebroadcast a roster, which is why it is the one path with a budget.
   */
  _hostLobbyAct(id, m) {
    const atMs = this.now();
    if (!this.lobby.charge(id, atMs)) {
      this.lactsDropped++;
      this.lobby.noteFlood(id, atMs);
      return;
    }
    this.lactsReceived++;
    let changed = false;
    if (m.k === LACT.READY) {
      changed = this.lobby.setReady(id, !!m.v, atMs);
    } else if (m.k === LACT.CALLSIGN) {
      /* The callsign is the one free-text field a player owns, and it is theirs to change
       * until the squad deploys. It is clamped here and NEVER put on the analytics bus —
       * §21.2, and `tools/m0-tests.js` AN5 fails the build if it ever is. */
      const name = safeLine(m.n, 14).trim();
      const p = this.game.playerById(id);
      if (name && p && this.lobby.phase !== LOBBY_PHASE.DEPLOYED) {
        p.name = name;
        this.lobby.setCallsign(id, name);
        changed = true;
        this._roster();
      }
    }
    if (changed) this._broadcastLobby();
  }

  /**
   * ⚠ A REFUSAL MUST HANG UP, AND THE REASON MUST SURVIVE THE HANGUP.
   *
   * Left open, a refused peer sits there believing it is connected and keeps sending sixty
   * command frames a second at a host that will never read one of them. Closing the link
   * then fires the client's disconnect handler, which is the last thing to write to
   * `status` — so "the squad has committed to a procedure" becomes "disconnected" a few
   * milliseconds later and the player is told nothing at all. Both halves are recorded in
   * Dev\INDEX.md against the same pair of functions in SmallTownEmergencyServices.
   *
   * The fix is on the client: `refusedWhy` is sticky and `onClose` reads it rather than
   * overwriting it. This end just has to say it and then go away.
   */
  _refuse(link, why, seatLike = null) {
    link.send({ t: MSG.REFUSE, why });
    if (seatLike) this.lobby.record(LOG_KIND.REFUSED, seatLike, this.now());
    link.close();
  }

  _hostHello(link, m) {
    if (m.v !== PROTOCOL_VERSION) {
      /* ⚠ THE VERSION IS ECHOED BACK INTO A SENTENCE THE OTHER END PRINTS. It is whatever
       * they sent, so it is clamped before it goes anywhere near their screen — a refusal
       * is the one message a peer is guaranteed to read, which makes it the one place a
       * host would hand an attacker's own payload back to them at full length. */
      this._refuse(link, `Protocol ${safeLine(String(m.v), 24)} against ${PROTOCOL_VERSION}. Somebody needs to reload.`);
      return;
    }
    /* A resume token is a Map key here and a string this host issued. Anything else is not
     * one, and is treated as absent rather than looked up. */
    const token = typeof m.token === 'string' && m.token.length <= 64 ? m.token : null;

    /**
     * ⚠ THE BLOCK IS CHECKED BEFORE THE RESUME TOKEN, and that order is the whole of it.
     * A removed operative holds a perfectly valid resume token for the seat they were
     * thrown out of — it is the same token the host issued them — so checking the token
     * first hands a griefer their seat straight back, kit and all, and the host's removal
     * becomes a two-second inconvenience.
     */
    const blocked = this.lobby.blockedReason(token);
    if (blocked) {
      this._refuse(link, `You were removed from this session. ${blocked}.`);
      return;
    }

    /* A resume token buys back the exact operative, with their kit — GDD §11.5,
     * "reconnect restores character state and inventory". The slot was held open. */
    if (token) {
      for (const [id, seat] of this.seats) {
        if (seat.token !== token) continue;
        const p = this.game.playerById(id);
        if (!p) break;
        /* ⚠ THE OLD LINK IS HUNG UP, AND ONLY AFTER THE SEAT HAS MOVED. A duplicated tab
         * copies the original's sessionStorage, so two windows can offer the SAME token —
         * and before this, both believed they held the seat while the host only wrote to
         * the newer link, and the older one could re-hello the seat straight back.
         * Reassign FIRST, then close: `_seatDropped` looks a seat up by link identity, so
         * once `seat.link` is the new one the old link's close handler finds nothing and
         * cannot mark the freshly resumed operative as dropped. */
        const prev = seat.link;
        seat.link = link;
        /* The seat is no longer a candidate for `_reclaimHeldSeats`, and it must not look
         * like one: `droppedAtMs` is the sweep's whole evidence. */
        delete seat.droppedAtMs;
        /**
         * ⚠ A RELOADED CLIENT COUNTS ITS ACTIONS FROM ONE AGAIN. The replay guard is a
         * per-seat high-water mark, so leaving the old one in place silently dropped every
         * ACT a resumed operative sent until they had clicked past their whole previous
         * session — a seat that looks fine and does nothing. Stale retransmits die with
         * the old link; the guard restarts with it.
         */
        seat.lastAct = 0;
        if (prev && prev !== link && prev.open) prev.close();
        p.connected = true;
        p.remote = true;
        link.send(this._welcome(id, seat.token));
        this.lobby.take(id, { callsign: p.name, atMs: this.now() });
        this._say(`${p.name} reconnected`);
        this._roster();
        this._broadcastLobby();
        return;
      }
    }

    /* GDD §11.5: joining in progress is allowed BEFORE the containment commitment. After
     * that the squad has a plan running and a new pair of hands arriving mid-procedure is
     * a liability, not a reinforcement. */
    if (this.game.mission.atLeast(PHASE.PROCEDURE_COMMITTED)) {
      this._refuse(link, 'The squad has committed to a procedure. Join the next operation.');
      return;
    }
    if (this.game.players.length >= MAX_SQUAD) {
      /**
       * ⚠ A HELD SEAT IS RELEASED ONLY WHEN SOMEBODY ELSE WANTS IT.
       *
       * §11.5 wants a drop to hold the slot, and the obvious implementation holds it until
       * the session ends — which is a squad of five with two dead laptops that can never
       * refill, for the rest of the operation, with the board saying "full". A drop is not
       * a departure and it is not a permanent claim either.
       *
       * Expiring on a TIMER would be the other mistake: it would take a dropped
       * operative's kit off the floor in a room where nothing was waiting for it, and a
       * squad of two would lose a seat it was not competing for. So the sweep runs HERE,
       * at the only moment the answer matters, and only far enough to make room for the
       * one person asking.
       */
      const reclaimed = this._reclaimHeldSeats(1);
      if (!reclaimed) {
        this._refuse(link, `Squad is full (${MAX_SQUAD}).`);
        return;
      }
    }

    /* ⚠ THE CALLSIGN IS THE ONE FREE-TEXT FIELD IN THIS BUILD AND IT ARRIVES FROM A
     * STRANGER. Fourteen characters, no control characters, and — this is the part that
     * matters — it is not the only defence: it lands on `p.name`, which travels in every
     * snapshot to every other machine, so hud.js, panels.js, lobby.js and the comms feed
     * all escape it on the way to the DOM. Clamping is not sanitising and this line is not
     * pretending to be. */
    const p = this.game.addPlayer(safeLine(m.name, 14).trim() || `Operative ${this.game.players.length + 1}`);
    p.remote = true;
    const issued = `${p.id}-${randCode(() => (this.game.rng.float()))}`;
    this.seats.set(p.id, { link, token: issued, lastAct: 0 });
    link.send(this._welcome(p.id, issued));
    this.lobby.take(p.id, { callsign: p.name, atMs: this.now() });
    this._say(`${p.name} joined`);
    this._roster();
    this._broadcastLobby();
  }

  _welcome(id, token) {
    return {
      t: MSG.WELCOME, v: PROTOCOL_VERSION, id, token,
      seed: this.game.seedLabel,
      map: this.game.site.id,
      /* A joiner has no prior state to keep, so every optional field is forced on. See
       * `encodeFullSnapshot`: for everyone else absent means unchanged; for them it would
       * mean unknown. */
      snap: encodeFullSnapshot(this.game),
    };
  }

  /**
   * The ACT budget: a token bucket per seat, kept here rather than on the Lobby because a
   * mission action is not a lobby action and sharing one bucket would let a squad that
   * changed its mind about ready starve itself of the ability to open a door.
   *
   * ⚠ IT IS KEYED ON THE SEAT, WHICH IS THE LINK'S. Nothing a client sends decides which
   * bucket it spends, so a seat cannot exhaust another seat's budget — the same property
   * that makes `_hostAct` unable to act for somebody else.
   *
   * @returns {boolean} true if the action may proceed
   */
  _chargeAct(seatId) {
    const atMs = this.now();
    let b = this._actBudget.get(seatId);
    if (!b) { b = { tokens: ACT_BURST, atMs }; this._actBudget.set(seatId, b); }
    b.tokens = Math.min(ACT_BURST, b.tokens + (Math.max(0, atMs - b.atMs) / 1000) * ACT_PER_SEC);
    b.atMs = atMs;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    /* Back above half means the burst is over, so the NEXT one is a second event on the
     * record rather than being swallowed by the first. A flag that is set and never cleared
     * is a log that reports one flood per session however many there were. */
    if (b.tokens > ACT_BURST / 2) b.logged = false;
    return true;
  }

  /**
   * A discrete request. EVERY one goes through the same validated entry point the host's
   * own keyboard uses — there is no client-only path into the simulation, which is the
   * whole of §20.9 in one sentence.
   */
  _hostAct(id, m) {
    /**
     * ⚠ THE SEQUENCE NUMBER WAS SENT AND NEVER READ, which made every action replayable.
     *
     * `act()` has always stamped `n: ++this._actSeq` and the host has always ignored it. On
     * a reliable ordered data channel that costs nothing and looks harmless — which is why
     * it survived. It is not harmless: a duplicated ACT takes a second item out of cargo, a
     * reordered one applies a stale intent after a newer one, and §20.9 says never trust
     * client claims. A field that is sent and unread is the same defect as a config value
     * nothing reads, one layer further out.
     *
     * Strictly increasing per seat. An action arriving with a sequence we have already
     * passed is a duplicate or a stale retransmit, and dropping it is the only safe answer:
     * applying it would be acting on an intent the operative has already moved on from.
     */
    const seat = this.seats.get(id);
    /**
     * ⚠ AND THE GUARD WAS OPT-IN FOR THE ATTACKER. `Number(undefined)` is NaN, so
     * `Number.isFinite(n)` was false and the whole replay check was SKIPPED for any message
     * that simply left `sq` out — which is one deleted field away from the exact defect the
     * comment above describes. A well-formed client always sends it (`act()` stamps it on
     * every message), so requiring it costs nothing and closes the hole.
     */
    const n = typeof m.sq === 'number' && Number.isFinite(m.sq) ? m.sq : null;
    if (n === null) { this.actsDropped = (this.actsDropped || 0) + 1; return; }
    if (seat) {
      if (n <= seat.lastAct) { this.actsDropped = (this.actsDropped || 0) + 1; return; }
      seat.lastAct = n;
    }

    /**
     * ⚠ THE BUDGET COVERED THE CHEAP PATH AND NOT THE EXPENSIVE ONE.
     *
     * `_hostLobbyAct` was rate-limited because "a client that holds the ready key down can
     * make the host rebroadcast the roster as fast as its send loop runs". Every word of
     * that applies harder here: `doInteract` walks the floor's blocking rects, `PROCEDURE`
     * allocates a card and moves the mission phase, and `ABORT` moves it back — none of
     * which had any limit at all, so the griefing this session's moderation work exists to
     * stop was available at sixty hertz to any modified client. §20.9 says "rate-limit
     * interaction and chat events" and only the second half was done.
     *
     * A SEPARATE bucket from the lobby's, and a much wider one: a lobby action is a person
     * clicking and an ACT is a person playing, so the limit has to sit above the fastest
     * anybody plays and below the slowest thing a send loop can do. Charged on the SEAT,
     * which is the link's, so nothing here can be spent on somebody else's behalf.
     */
    if (!this._chargeAct(id)) {
      this.actsFlooded++;
      /* ⚠ ONE LOG ENTRY PER BURST, NOT ONE PER MESSAGE. Four hundred messages is one event —
       * "they flooded" — and a moderation record with four hundred identical lines in it has
       * rolled every other thing that seat did off the end of the log, which is the one
       * question the record exists to answer. `Lobby.noteFlood` cannot be reused here: it
       * reads the LOBBY's bucket, and a seat that floods ACTs may never have sent a lobby
       * message at all, so it had nothing to read and said nothing. */
      const b = this._actBudget.get(id);
      if (b && !b.logged) {
        b.logged = true;
        this.lobby.record(LOG_KIND.FLOOD, this.lobby.seatOf(id) || { seatId: id }, this.now());
      }
      return;
    }
    this.actsReceived++;
    const g = this.game;
    let err = null;
    switch (m.k) {
      case ACT.INTERACT: err = g.doInteract(id); break;
      case ACT.USE: err = g.useHeld(id); break;
      case ACT.IMAGER: err = g.toggleImager(id); break;
      case ACT.SLOT: g.selectSlot(id, typeof m.n === 'number' && Number.isFinite(m.n) ? (m.n | 0) : 0); break;
      case ACT.TAKE: err = g.takeFromCache(safeId(m.id, 48) || '', id); break;
      case ACT.RETURN: err = g.returnToCache(id); break;
      /* ⚠ THE CARD IS FIVE FIELDS OF PROSE THE SQUAD TYPED, NOT AN ARBITRARY OBJECT.
       * `commitProcedure({ ...card })` spread whatever arrived — which is not prototype
       * pollution (spread defines, it does not assign) but is an unbounded object stored on
       * the mission, graded, and printed on the tablet. Rebuilt from a whitelist. */
      case ACT.PROCEDURE: err = g.commitProcedure(procedureCard(m.card)); break;
      case ACT.ABORT: g.abortProcedure(); break;
      /* A claim state is one of two words or nothing. It rides the snapshot to every other
       * client, so an unconstrained value here is a field one client writes into four. */
      case ACT.CLAIM: g.setClaim(safeId(m.id, 64) || '', m.v === 'believed' || m.v === 'excluded' ? m.v : null, id); break;
      /* `id` is the seat this link is in, never a field the client sent — so a client
       * cannot put a callout on the board under somebody else's name. The refusal that
       * comes back goes to this one operative, not to the squad feed. */
      case ACT.PING: err = g.ping(id, safeId(m.p, 48) || '', num100(m.x), num100(m.z)); break;
      default: err = 'unknown action'; break;
    }
    if (err && err !== 'OPEN_CACHE') {
      this.actsRefused++;
      const seat = this.seats.get(id);
      if (seat && seat.link.open) seat.link.send({ t: MSG.EVENT, text: String(err) });
    }
  }

  /**
   * A link died. GDD §11.5: the character enters safe autopilot, drops critical carried
   * objects only when necessary, and RESERVES THEIR SLOT. They are still on the roster,
   * still a warm body the draught can smell, and their kit is still theirs.
   */
  _seatDropped(link) {
    const found = this._seatOf(link);
    if (!found) return;
    const p = this.game.playerById(found.id);
    if (!p) return;
    p.connected = false;
    this.game.setCommand(found.id, null);      // safe autopilot: they stand still
    /* Their markers go with the radio. A call is a claim about right now by somebody who
     * is looking at it, and neither half is true any more. */
    this.game.comms.retire(found.id);
    /* ⚠ And whatever they were holding goes on the floor where they stood. Same rule
     * §11.5 forces on custody of the case: an object that left the world with somebody's
     * laptop is an operation nobody can finish. */
    this.game.instances.releaseHeldBy(found.id, p.x, p.z);
    /* Custody is the one thing that cannot wait for them to come back. */
    if (p.hands === 'reinforced-transit-case') {
      this.game._putDownCase(p);
      this.game.notice(`${p.name}'s radio went out. The case is on the floor where they stood.`);
    } else {
      this.game.notice(`${p.name}'s radio went out. Their slot is being held.`);
    }
    /* When the radio went out, so a seat that is genuinely gone can be told from one that
     * blinked. See `_reclaimHeldSeats`. */
    found.seat.droppedAtMs = this.now();
    this.lobby.setConnected(found.id, false, this.now());
    this._say(`${p.name} dropped`);
    this._roster();
    this._broadcastLobby();
  }

  /**
   * Free up to `want` seats whose operative has been gone longer than the hold.
   *
   * Oldest drop first, because the person who has been away longest is the least likely to
   * be coming back — and because "we took the seat of whoever left most recently" is the
   * rule that punishes the reconnect it is supposed to protect.
   *
   * Returns how many were freed. Everything the seat was holding is already on the floor:
   * `_seatDropped` put the case down and released the instances at the moment the radio
   * went out, so releasing the seat here loses nothing that was not already lost.
   *
   * @param {number} want   how many seats the caller needs
   * @returns {number}      how many it got
   */
  _reclaimHeldSeats(want = 1) {
    const now = this.now();
    const hold = CONFIG.net.seatHoldMs;
    const candidates = [];
    for (const [id, seat] of this.seats) {
      const p = this.game.playerById(id);
      if (!p || p.connected) continue;
      const since = seat.droppedAtMs;
      if (since === undefined || now - since < hold) continue;
      candidates.push({ id, since });
    }
    candidates.sort((a, b) => a.since - b.since);
    let freed = 0;
    for (const c of candidates) {
      if (freed >= want) break;
      const p = this.game.playerById(c.id);
      const away = Math.round((now - c.since) / 60000);
      this.game.notice(`${p.name} has been off the air for ${away} minutes. Their seat has gone to somebody who is here.`);
      this.seats.delete(c.id); this._actBudget.delete(c.id);
      this.lobby.release(c.id, now);
      this.game.removePlayer(c.id);
      freed++;
    }
    if (freed) { this._roster(); this._broadcastLobby(); }
    return freed;
  }

  /** A deliberate goodbye, rather than a drop: the seat is released and the kit returned. */
  _seatLeft(link, andRemove) {
    const found = this._seatOf(link);
    if (!found) return;
    const p = this.game.playerById(found.id);
    if (andRemove && p) {
      this.game.notice(`${p.name} signed off. Their kit is back at the vehicle.`);
      this.game.removePlayer(found.id);
      this.seats.delete(found.id); this._actBudget.delete(found.id);
      this.lobby.release(found.id, this.now(), LOG_KIND.LEFT);
    }
    this._say('a seat opened');
    this._roster();
    this._broadcastLobby();
  }

  /* ── client ───────────────────────────────────────────────────────────── */

  join(link, { name = 'Operative', token = null } = {}) {
    this.role = ROLE.CLIENT;
    this.link = link;
    this.refusedWhy = null;
    this.removedWhy = null;
    this.joinAttempt = null;             // the link opened; the attempt is over
    this.joinFailed = null;
    this.tokenRefused = false;
    this._offeredToken = token || this.token || null;
    link.onMessage = (m) => this._clientOnMessage(m);
    /* ⚠ `onClose` MUST NOT OVERWRITE A REASON. A refusal and a removal are both followed
     * immediately by a hangup, and whichever of the two messages arrives is the only
     * explanation the player will ever get — so this reads the sticky field rather than
     * writing over it. Which of the two orderings the wire delivers is not this end's
     * business, and on a real connection it is not predictable either. */
    link.onClose = () => this._say(
      this.removedWhy ? `Removed from the session: ${this.removedWhy}.`
        : this.refusedWhy || 'disconnected',
    );
    /* Say "joining" BEFORE the hello goes out. A reply can arrive inside send() — it
     * always does over a loopback link, and can over a fast connection — and setting the
     * status afterwards then overwrites "connected" with "joining" and leaves the player
     * staring at a lie. (Recorded against the same line in SmallTownEmergencyServices.) */
    this._say('joining');
    link.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, name, token: this._offeredToken });
    return this;
  }

  /**
   * ⚠ THE CLIENT'S INBOX IS THE OTHER FUNCTION A STRANGER CAN CALL, AND IT HAD NO WRAPPER.
   *
   * `_hostOnMessage` has been wrapped since the first version of this file, with a long
   * comment about a malformed `{t:'cmd'}` taking a host's whole shift down. The mirror
   * image was never written, because the header of this file assumes the host is somebody
   * you know. In a PRIVATE room that is true. In a NAMED room the host is whoever claimed
   * a word on a broker shared with the internet, and in a LISTED one they are a row on a
   * directory a joiner was handed by a third stranger — so in two of the three shapes this
   * build ships, the host is exactly as unknown as the client.
   *
   * One message was enough: `ix: [1]` made `instances.decode` destructure a number and
   * throw straight out of PeerJS's data handler. Same one-line denial of service, aimed
   * the other way.
   */
  _clientOnMessage(m) {
    try {
      this._clientRead(m);
    } catch (e) {
      this.hostMalformed++;
    }
  }

  _clientRead(m) {
    if (!m || typeof m !== 'object') { this.hostMalformed++; return; }
    if (m.t === MSG.WELCOME) {
      /* ⚠ THE SEAT ID IS A KEY. `game.localId` decides whose eyes the renderer is behind
       * and is compared against every seat in the roster; a free string here is a client
       * that renders nobody. An id or the welcome is not one. */
      const id = safeId(m.id, 16);
      if (!id) { this.hostMalformed++; return; }
      this.localPlayerId = id;
      this.game.localId = id;        // the renderer and the HUD follow this seat
      this.token = typeof m.token === 'string' ? m.token.slice(0, 64) : null;
      if (m.snap) {
        if (applySnapshot(this.game, m.snap, { localId: this.localPlayerId })) this.lastSnapshot = m.snap;
        else this._refuseFrame('the welcome carried a snapshot this build will not apply');
      }
      this._say('connected');
      this._roster();
      /* The seat and the token are now real. See the field's comment: the screen keeps
       * them, this file has no storage and wants none. */
      if (this.onWelcome) this.onWelcome(this);
      return;
    }
    /* A refusal is free text the host wrote, printed on the lobby screen. Clamped here so a
     * hostile host cannot hand a client a megabyte of "reason"; escaped there, because this
     * file cannot see the DOM and that one cannot see the wire. */
    if (m.t === MSG.REFUSE) {
      this.refusedWhy = safeLine(m.why, 200) || 'refused';
      /* A hello that offered a token and got a refusal is a token the host would not
       * honour — blocked, or issued by a session that no longer exists. The blob keeping
       * it should be burned, and the storage lives on the screen, so this end just says
       * so structurally. (A refusal with NO token offered says nothing about tokens.) */
      if (this._offeredToken) this.tokenRefused = true;
      this._say(this.refusedWhy);
      return;
    }
    /**
     * ⚠ THE REMOVAL NOTICE IS THIS FEATURE'S VERSION OF THE DESTROYED REFUSAL.
     *
     * It lands on `this`, not on `this.lobby`, and that is deliberate: `applyLobby`
     * replaces the client's seat map wholesale from the host's broadcast, so a reason
     * stored there would be erased by whichever broadcast was already in flight when the
     * host removed us — and there is no later broadcast to put it back, because the link
     * is closing. Reading it immediately would always work. That is exactly the shape of
     * the `notices` bug this project shipped, and the only defence is to keep the message
     * out of the structure that gets replaced.
     */
    if (m.t === MSG.KICK) {
      /* ⚠ `REMOVAL_REASONS[m.why]` IS NOT A MEMBERSHIP TEST — the same defect as
       * `PHRASES[phrase]` in the comms board. `REMOVAL_REASONS['constructor']` is the
       * Object constructor, which is truthy, so `{t:'kick', why:'constructor'}` put a
       * function through a template literal and printed its source at the player. A closed
       * vocabulary has to be asked whether it OWNS the key. */
      this.removedWhy = (typeof m.why === 'string' && Object.prototype.hasOwnProperty.call(REMOVAL_REASONS, m.why)
        ? REMOVAL_REASONS[m.why] : REMOVAL_REASONS[DEFAULT_REASON]);
      this._say(`Removed from the session: ${this.removedWhy}.`);
      this.game.noticeLocal(`You were removed from the session. ${this.removedWhy}.`);
      return;
    }
    if (m.t === MSG.LOBBY) {
      if (!applyLobby(this.lobby, m)) { this._refuseFrame('a lobby broadcast this build will not apply'); return; }
      if (this.onLobby) this.onLobby(this.lobby, this);
      return;
    }
    if (m.t === MSG.EVENT) {
      const text = safeLine(m.text, 200);
      if (text) this.game.noticeLocal(text);
      return;
    }
    if (m.t === MSG.SNAP) {
      /**
       * ⚠ A REFUSED FRAME IS NOT A DROPPED ONE, AND `lastSnapshot` IS THE DIFFERENCE.
       *
       * `lastSnapshot` was written before the frame was applied, so a snapshot this end
       * refused would still have been the thing the session reported as its state. A frame
       * that was not applied did not happen; the client keeps the last one that did, which
       * is one frame stale and correct, rather than a Game half-written from a hostile one.
       */
      if (!applySnapshot(this.game, m, { localId: this.localPlayerId })) {
        this._refuseFrame('a snapshot this build will not apply');
        return;
      }
      this.snapsReceived++;
      this.lastSnapshot = m;
      this._roster();
    }
  }

  /** Count and remember a frame this end would not take. Never a notice: a client under a
   *  hostile host would otherwise have its own feed filled by the attacker. */
  _refuseFrame(why) {
    this.framesRefused++;
    this.lastRefusal = why;
  }

  /** Queue a discrete request. Reliable and ordered, so it needs no retry of its own. */
  act(kind, extra = {}) {
    if (this.role !== ROLE.CLIENT || !this.link || !this.link.open) return false;
    this.link.send({ t: MSG.ACT, sq: ++this._actSeq, k: kind, ...extra });
    return true;
  }

  /**
   * A lobby request. Deliberately UNSEQUENCED and deliberately not applied locally.
   *
   * ⚠ A CLIENT NEVER WRITES ITS OWN READY FLAG. An optimistic local toggle would look
   * instant and be correct for exactly as long as it took the next lobby broadcast to
   * arrive, at which point `applyLobby` would replace the seat map and flip the button
   * back — the same "read it immediately and it is there" failure as the destroyed
   * refusals, in a control the player is actively looking at. So this asks, and the host's
   * echo is the only thing that moves the switch.
   */
  lobbyAsk(kind, extra = {}) {
    if (this.role !== ROLE.CLIENT || !this.link || !this.link.open) return false;
    this.link.send({ t: MSG.LACT, k: kind, ...extra });
    return true;
  }

  askReady(ready) { return this.lobbyAsk(LACT.READY, { v: ready ? 1 : 0 }); }
  askCallsign(name) { return this.lobbyAsk(LACT.CALLSIGN, { n: String(name || '').slice(0, 14) }); }

  /* ── the pump ─────────────────────────────────────────────────────────── */

  /**
   * Once per rendered frame from main.js.
   * @param {number} dtMs  real frame time
   * @param {object} cmd   THIS machine's local command for this frame
   */
  pump(dtMs, cmd) {
    if (this.role === ROLE.HOST) {
      /* A listed room re-announces itself so the directory can tell "still here" from
       * "the tab closed twenty minutes ago". A heartbeat is the only liveness signal a
       * list of self-reported rows can carry, which is why every row prints its age. */
      if (this.visibility === VISIBILITY.LISTED && this.now() - this._advertAtMs > ADVERT_EVERY_MS) {
        this.advertise();
      }
      this._sinceSnapMs += dtMs;
      if (this._sinceSnapMs < this.snapshotEveryMs) return;
      this._sinceSnapMs = 0;
      const snap = encodeSnapshot(this.game);
      for (const seat of this.seats.values()) if (seat.link.open) seat.link.send(snap);
      /* Remember what went out, so the next frame can leave it out. See `encodeSnapshot`. */
      if (snap.rs !== undefined) this.game._sentResult = snap.rs;
      /**
       * §21.2's "match reconnect and network quality", reported as FACTS rather than as a
       * grade: how many seats, how many are answering, how much has been refused and how
       * much dropped as stale.
       *
       * ⚠ It is derived from what the host has actually seen, and it carries no names and
       * no free text — §21.2 ends "do not record raw voice, free-text chat, or unnecessary
       * personal data", and a callsign is personal data a player typed. Seat IDS are
       * positional and mean nothing outside the session.
       */
      this.game.bus.emit('LINK_QUALITY', {
        seats: this.seats.size,
        connected: this.game.players.filter((p) => p.connected).length,
        acts: this.actsReceived,
        refused: this.actsRefused,
        stale: this.actsDropped || 0,
      }, this.game.clock.simTimeMs);
      return;
    }
    if (this.role === ROLE.CLIENT && this.link && this.link.open && cmd) {
      this.link.send(encodeCommand(cmd));
    }
  }

  leave() {
    /* ⚠ TAKE THE ROOM OFF THE LIST ON THE WAY OUT. Without this the only thing that ever
     * removes a row is it going stale, so a directory a squad passes through fills with
     * rooms that closed minutes ago and the honest "said so 2 min ago" label does all the
     * work. A message the code can receive and nothing ever sends is the same defect as a
     * config value nothing reads. */
    try {
      const code = this.lobby.code || this.lobby.roomName;
      if (this.directory) this.directory.withdraw(code);
      else if (this._dirConn && this._dirConn.open) this._dirConn.send({ t: MSG.UNADVERT, code });
    } catch { /* the list is somebody else's tab; it will go stale on its own */ }
    try {
      if (this.role === ROLE.CLIENT && this.link && this.link.open) {
        this.link.send({ t: MSG.BYE });
        this.link.close();
      }
      for (const seat of this.seats.values()) if (seat.link.open) seat.link.close();
    } catch { /* going away anyway */ }
    try { if (this.peer) this.peer.destroy(); } catch { /* ditto */ }
    /* ⚠ And the directory tab goes with it. A browser that stays the directory after its
     * own session ended is a browser silently serving strangers a list it no longer has
     * any reason to hold — and the id stays claimed, so the next host who WOULD have held
     * it cannot. Hand it back. */
    try { if (this._dirPeer) this._dirPeer.destroy(); } catch { /* ditto */ }
    try { if (this._dirConn) this._dirConn.close(); } catch { /* ditto */ }
    this.seats.clear(); this._actBudget.clear();
    this.joinAttempt = null; this.joinFailed = null;
    this.tokenRefused = false; this._offeredToken = null;
    this.link = null; this.peer = null;
    this._dirPeer = null; this._dirConn = null;
    this.directory = null;
    this.rooms = [];
    this.lobby = new Lobby({ maxSeats: MAX_SQUAD });
    this.role = ROLE.SOLO;
    this.localPlayerId = 'p1';
    this._say('not connected');
  }

  /* ── PeerJS, the real transport ───────────────────────────────────────── */

  /**
   * Open a room.
   *
   * Three shapes, and which one you get is decided entirely by what the host asked for
   * (see the header of `lobby.js` for what each can and cannot do):
   *   · no room name         → `cdw-<CODE>`, a random five characters. What shipped.
   *   · a room name          → `cdw-r-<slug>`, deterministic on every machine.
   *   · a room name + listed → the same, plus an advertisement to the volunteer directory.
   *
   * Returns the code or the room name immediately; operatives may connect much later.
   */
  hostPeer(opts = {}) {
    /* Tolerates the old `hostPeer(rand)` call — `src/ui/panels.js` still makes it. */
    const o = typeof opts === 'function' ? { rand: opts } : (opts || {});
    const rand = o.rand || Math.random;
    const Peer = globalThis.Peer;
    if (!Peer) { this._say('peerjs did not load'); return null; }
    this.host();

    const named = roomSlug(o.roomName || '');
    const id = named ? roomIdFor(named) : null;
    this.roomName = named;
    this.code = named ? '' : randCode(rand);
    this.visibility = o.visibility
      || (named ? VISIBILITY.NAMED : VISIBILITY.PRIVATE);
    this.lobby.roomName = this.roomName;
    this.lobby.code = this.code;
    this.lobby.visibility = this.visibility;

    this._say('opening room…');
    const peer = new Peer(id || (ROOM_PREFIX + this.code), PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => {
      this._say(named ? `room "${named}" — waiting` : `room ${this.code} — waiting`);
      if (this.visibility === VISIBILITY.LISTED) this.advertise();
    });
    peer.on('connection', (conn) => {
      const link = wrapConn(conn);
      conn.on('open', () => this.accept(link));
      conn.on('data', (d) => link.onMessage && link.onMessage(d));
      conn.on('close', () => { link.open = false; if (link.onClose) link.onClose(); });
    });
    peer.on('error', (e) => {
      /* ⚠ "Taken" means something DIFFERENT for a name than for a code, and saying the
       * same sentence for both would be a lie about which one the player controls. A
       * collided code is bad luck and hosting again fixes it; a collided NAME means
       * somebody else — possibly not even playing this game — is sitting on that word on
       * a broker shared with the whole internet, and hosting again will collide forever. */
      if (e && e.type === 'unavailable-id') {
        this._say(named
          ? `"${named}" is already in use on the broker. Pick a longer or stranger name.`
          : 'code taken — host again');
      } else this._say(`error: ${e && e.type}`);
    });
    return named || this.code;
  }

  /**
   * Join a room by CODE or by NAME. A five-character code is tried as a code; anything
   * else is tried as a room name, which is what lets a squad meet on a word.
   *
   * `token` is a resume token this machine stored from an earlier WELCOME in the same
   * room — the invite-link joiner who reloaded, back into THEIR seat. It rides the same
   * hello; the host decides what it is worth.
   *
   * ⚠ A DEAD ROOM USED TO BRICK THE SCREEN. `this.code` was set optimistically before
   * anybody answered, the lobby's `committed` check read it, and a failed join therefore
   * left the page showing a disabled host panel with the failed code rendered as if it
   * were your own room — no join field, no retry, until a reload. The failure now CLEANS
   * UP: the aspirational identity comes back off, the Peer is destroyed rather than
   * leaked, and what remains is `joinFailed`, which the screen turns into words and a
   * host-your-own button.
   */
  joinPeer(codeOrName, name, { token = null } = {}) {
    const Peer = globalThis.Peer;
    if (!Peer) { this._say('peerjs did not load'); return false; }
    const typed = String(codeOrName || '').trim();
    if (typed.length < 3) { this._say('enter the room code or name'); return false; }
    const asCode = /^[A-Za-z0-9]{4,6}$/.test(typed) ? roomIdForCode(typed) : null;
    const id = asCode || roomIdFor(typed);
    if (!id) { this._say('that room name has nothing in it'); return false; }
    this.code = asCode ? typed.toUpperCase() : '';
    this.roomName = asCode ? '' : roomSlug(typed);
    this.joinFailed = null;
    this.joinAttempt = { target: asCode ? typed.toUpperCase() : roomSlug(typed), atMs: this.now() };

    let failed = false;
    const fail = (why) => {
      /* Once seated, a late broker error is noise, not a failure — and fail() must be
       * idempotent because a data-channel error and a peer error can both fire for one
       * dead room. */
      if (failed || this.role === ROLE.CLIENT) return;
      failed = true;
      this.joinFailed = { target: this.joinAttempt ? this.joinAttempt.target : typed.toUpperCase(), why };
      this.joinAttempt = null;
      this.code = null;
      this.roomName = '';
      if (this.peer === peer) this.peer = null;
      try { peer.destroy(); } catch { /* gone */ }
      this._say(why);
    };

    this._say('connecting…');
    const peer = new Peer(PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => {
      const conn = peer.connect(id, { reliable: true });
      const link = wrapConn(conn);
      conn.on('open', () => this.join(link, { name, token }));
      conn.on('data', (d) => link.onMessage && link.onMessage(d));
      conn.on('close', () => { link.open = false; if (link.onClose) link.onClose(); });
      conn.on('error', () => fail('could not reach that room'));
    });
    peer.on('error', (e) => {
      fail(e && e.type === 'peer-unavailable' ? 'nobody is holding that room' : `error: ${e && e.type}`);
    });
    return true;
  }

  /**
   * The screen's give-up, for the failure the broker never reports: a host whose tab is
   * registered but gone, or an ICE path that will never come up — the connection neither
   * opens nor errors, and "connecting…" would sit there for ever. Wall time lives on the
   * screen (K5), so the DEADLINE is the caller's; this end only knows how to stop
   * honestly, with the same cleanup a broker refusal gets.
   *
   * @returns {boolean} true if there was an attempt to abandon
   */
  abandonJoin(why = 'nobody answered') {
    if (this.role === ROLE.CLIENT || !this.joinAttempt) return false;
    this.joinFailed = { target: this.joinAttempt.target, why };
    this.joinAttempt = null;
    this.code = null;
    this.roomName = '';
    const peer = this.peer;
    this.peer = null;
    try { if (peer) peer.destroy(); } catch { /* gone */ }
    this._say(why);
    return true;
  }

  /* ── the volunteer directory, over the broker ─────────────────────────── */

  /**
   * Is anybody actually there? A room id either answers or it does not, and that is a
   * FACT rather than a report — which is why the screen's "recent operations" list probes
   * rather than believing its own history, and why a directory row can be checked before
   * a player is sent at it.
   *
   * The probe is a real connection attempt and then a hangup, so it costs the host one
   * refused data channel. That is the honest price of the only reliable liveness test the
   * broker offers.
   */
  probeRoom(codeOrName, cb) {
    const Peer = globalThis.Peer;
    if (!Peer) { cb(false, 'peerjs did not load'); return () => {}; }
    const typed = String(codeOrName || '').trim();
    const id = (/^[A-Za-z0-9]{4,6}$/.test(typed) ? roomIdForCode(typed) : null) || roomIdFor(typed);
    if (!id) { cb(false, 'nothing to probe'); return () => {}; }
    let done = false;
    const finish = (live, why) => { if (done) return; done = true; try { peer.destroy(); } catch { /* gone */ } cb(live, why); };
    const peer = new Peer(PEER_OPTS);
    peer.on('open', () => {
      const conn = peer.connect(id, { reliable: true });
      conn.on('open', () => { try { conn.close(); } catch { /* gone */ } finish(true, 'answered'); });
      conn.on('error', () => finish(false, 'no answer'));
    });
    peer.on('error', (e) => finish(false, e && e.type === 'peer-unavailable' ? 'nobody is holding that room' : `error: ${e && e.type}`));
    return () => finish(false, 'cancelled');
  }

  /**
   * Put this room on the volunteer directory, becoming the directory if nobody is.
   *
   * ⚠ WHAT THE PLAYER IS PROMISED HERE IS SMALL AND THE UI SAYS SO. The list is held in
   * one player's browser; it dies with their tab; every row is an unverified claim by
   * whoever sent it. This function's whole job is to be the least dishonest thing that can
   * be built on a broker that will not enumerate peers.
   */
  advertise() {
    const Peer = globalThis.Peer;
    if (!Peer || this.role !== ROLE.HOST) return false;
    this._advertAtMs = this.now();
    if (this.directory) { this.directory.advertise(this.lobby.describe(this._advertAtMs), this._advertAtMs); return true; }
    if (this._dirConn && this._dirConn.open) {
      this._dirConn.send({ t: MSG.ADVERT, e: this.lobby.describe(this._advertAtMs) });
      return true;
    }
    const peer = this.peer;
    if (!peer || !peer.open) return false;
    const conn = peer.connect(DIRECTORY_ID, { reliable: true });
    this._dirConn = conn;
    conn.on('open', () => { conn.send({ t: MSG.ADVERT, e: this.lobby.describe(this.now()) }); });
    conn.on('error', () => { this._dirConn = null; this._becomeDirectory(); });
    conn.on('close', () => { this._dirConn = null; });
    return true;
  }

  /**
   * Nobody is holding the directory, so hold it. A SECOND Peer object, because this
   * browser is already claiming its own room id and one connection cannot be two ids.
   */
  _becomeDirectory() {
    const Peer = globalThis.Peer;
    if (!Peer || this._dirPeer) return false;
    const dir = new SessionDirectory();
    const peer = new Peer(DIRECTORY_ID, PEER_OPTS);
    this._dirPeer = peer;
    peer.on('open', () => {
      this.directory = dir;
      dir.advertise(this.lobby.describe(this.now()), this.now());
      this._say('holding the session list for other hosts');
    });
    peer.on('connection', (conn) => {
      /**
       * ⚠ A WITHDRAWAL IS A DELETE, AND IT WAS UNAUTHENTICATED.
       *
       * `dir.withdraw(m.code)` removed whatever row the sender named. Every code and room
       * name on the directory is printed on the browse screen of everybody who asks, so a
       * stranger could read the list and then send one `unadv` per row and empty it — a
       * silent denial of service against every host on the list, from one connection, with
       * nothing in the design to notice.
       *
       * An advertisement cannot be authenticated on this transport and the UI already says
       * so: every row is an unverified claim, and a host that overwrites another host's row
       * is an accepted and stated limit. A DELETE is different, because it is the one
       * operation that costs somebody else something, so it is scoped to the connection
       * that made the claim. A host reconnecting simply advertises again.
       */
      const mine = new Set();
      conn.on('data', (m) => {
        /* ⚠ EVERYTHING ARRIVING HERE IS FROM A STRANGER. `SessionDirectory.advertise`
         * rebuilds the row from a whitelist and clamps every field; this handler must not
         * be tempted to do anything cleverer than hand it over. */
        try {
          if (!m || typeof m !== 'object') return;
          if (m.t === MSG.ADVERT) {
            const entry = dir.advertise(m.e, this.now());
            if (entry) mine.add(entry.code || `R:${entry.room}`);
          } else if (m.t === MSG.UNADVERT) {
            const code = typeof m.code === 'string' ? m.code : '';
            const key = code.trim().toUpperCase();
            if (mine.has(key) || mine.has(`R:${roomSlug(code)}`)) { dir.withdraw(code); mine.delete(key); }
          } else if (m.t === MSG.LIST) conn.send({ t: MSG.ROOMS, r: dir.encode(this.now()) });
        } catch { /* a stranger's message is not this session's problem */ }
      });
    });
    peer.on('error', () => {
      /* Somebody beat us to it between the failed connect and the claim. Fine — try them. */
      this._dirPeer = null;
      this.directory = null;
    });
    return true;
  }

  /**
   * Ask the directory what it has. `cb(rows, note)` — `note` is the sentence the screen
   * prints when there is nothing to show, because "no rooms" and "no directory" are
   * different facts and §18.1 does not let them share a line.
   */
  browse(cb) {
    const Peer = globalThis.Peer;
    if (!Peer) { cb([], 'peerjs did not load'); return; }
    if (this.directory) { cb(this.directory.list(this.now()), null); return; }
    const peer = this.peer && this.peer.open ? this.peer : new Peer(PEER_OPTS);
    const ask = () => {
      const conn = peer.connect(DIRECTORY_ID, { reliable: true });
      conn.on('open', () => conn.send({ t: MSG.LIST }));
      conn.on('data', (m) => {
        /* ⚠ THE DIRECTORY IS A THIRD STRANGER AND ITS REPLY IS NOT TRUSTED EITHER. A row of
         * `null` made `Number(e.ageMs)` throw out of PeerJS's data handler, and a NEGATIVE
         * age dated a row into the future, where `list()` clamps it to zero and it reads as
         * the freshest room on the page. Both are one field on a message the joiner asked
         * for and did not choose the answer to. */
        try {
          if (!m || m.t !== MSG.ROOMS) return;
          const now = this.now();
          const dir = new SessionDirectory();
          for (const e of (Array.isArray(m.r) ? m.r : []).slice(0, 200)) {
            if (!e || typeof e !== 'object') continue;
            const age = typeof e.ageMs === 'number' && Number.isFinite(e.ageMs) ? Math.max(0, e.ageMs) : 0;
            dir.advertise(e, now - age);
          }
          this.rooms = dir.list(now);
          cb(this.rooms, null);
          try { conn.close(); } catch { /* gone */ }
        } catch { /* a stranger's list is not this session's problem */ }
      });
      conn.on('error', () => cb([], 'nobody is holding the session list right now'));
    };
    if (peer.open) ask(); else peer.on('open', ask);
  }
}

export { MSG, ACT, LACT, PROTOCOL_VERSION, MAX_SQUAD };
export { Lobby, SessionDirectory, LOBBY_PHASE, VISIBILITY, LOG_KIND, REMOVAL_REASONS, roomIdFor, roomSlug };
