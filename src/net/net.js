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
    this.link = null;
    this.localPlayerId = 'p1';
    /** Handed back by the host so a dropped operative can reclaim their own slot. */
    this.token = null;
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
    this.seats.delete(seatId);
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
    if (m.t === MSG.HELLO) return this._hostHello(link, m);

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
      const name = String(m.n || '').trim().slice(0, 14);
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
      this._refuse(link, `Protocol ${m.v} against ${PROTOCOL_VERSION}. Somebody needs to reload.`);
      return;
    }

    /**
     * ⚠ THE BLOCK IS CHECKED BEFORE THE RESUME TOKEN, and that order is the whole of it.
     * A removed operative holds a perfectly valid resume token for the seat they were
     * thrown out of — it is the same token the host issued them — so checking the token
     * first hands a griefer their seat straight back, kit and all, and the host's removal
     * becomes a two-second inconvenience.
     */
    const blocked = this.lobby.blockedReason(m.token);
    if (blocked) {
      this._refuse(link, `You were removed from this session. ${blocked}.`);
      return;
    }

    /* A resume token buys back the exact operative, with their kit — GDD §11.5,
     * "reconnect restores character state and inventory". The slot was held open. */
    if (m.token) {
      for (const [id, seat] of this.seats) {
        if (seat.token !== m.token) continue;
        const p = this.game.playerById(id);
        if (!p) break;
        seat.link = link;
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

    const p = this.game.addPlayer((m.name || '').trim().slice(0, 14) || `Operative ${this.game.players.length + 1}`);
    p.remote = true;
    const token = `${p.id}-${randCode(() => (this.game.rng.float()))}`;
    this.seats.set(p.id, { link, token, lastAct: 0 });
    link.send(this._welcome(p.id, token));
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
    const n = Number(m.sq);
    if (seat && Number.isFinite(n)) {
      if (n <= seat.lastAct) { this.actsDropped = (this.actsDropped || 0) + 1; return; }
      seat.lastAct = n;
    }
    this.actsReceived++;
    const g = this.game;
    let err = null;
    switch (m.k) {
      case ACT.INTERACT: err = g.doInteract(id); break;
      case ACT.USE: err = g.useHeld(id); break;
      case ACT.IMAGER: err = g.toggleImager(id); break;
      case ACT.SLOT: g.selectSlot(id, m.n | 0); break;
      case ACT.TAKE: err = g.takeFromCache(String(m.id || ''), id); break;
      case ACT.RETURN: err = g.returnToCache(id); break;
      case ACT.PROCEDURE: err = g.commitProcedure(m.card || {}); break;
      case ACT.ABORT: g.abortProcedure(); break;
      case ACT.CLAIM: g.setClaim(String(m.id || ''), m.v || null, id); break;
      /* `id` is the seat this link is in, never a field the client sent — so a client
       * cannot put a callout on the board under somebody else's name. The refusal that
       * comes back goes to this one operative, not to the squad feed. */
      case ACT.PING: err = g.ping(id, m.p, (m.x || 0) / 100, (m.z || 0) / 100); break;
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
      this.seats.delete(c.id);
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
      this.seats.delete(found.id);
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
    link.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, name, token: token || this.token });
    return this;
  }

  _clientOnMessage(m) {
    if (m.t === MSG.WELCOME) {
      this.localPlayerId = m.id;
      this.game.localId = m.id;      // the renderer and the HUD follow this seat
      this.token = m.token;
      if (m.snap) { applySnapshot(this.game, m.snap, { localId: this.localPlayerId }); this.lastSnapshot = m.snap; }
      this._say('connected');
      this._roster();
      return;
    }
    if (m.t === MSG.REFUSE) { this.refusedWhy = m.why || 'refused'; this._say(this.refusedWhy); return; }
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
      this.removedWhy = REMOVAL_REASONS[m.why] || REMOVAL_REASONS[DEFAULT_REASON];
      this._say(`Removed from the session: ${this.removedWhy}.`);
      this.game.noticeLocal(`You were removed from the session. ${this.removedWhy}.`);
      return;
    }
    if (m.t === MSG.LOBBY) {
      applyLobby(this.lobby, m);
      if (this.onLobby) this.onLobby(this.lobby, this);
      return;
    }
    if (m.t === MSG.EVENT) { this.game.noticeLocal(m.text); return; }
    if (m.t === MSG.SNAP) {
      this.snapsReceived++;
      this.lastSnapshot = m;
      applySnapshot(this.game, m, { localId: this.localPlayerId });
      this._roster();
    }
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
    this.seats.clear();
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
   */
  joinPeer(codeOrName, name) {
    const Peer = globalThis.Peer;
    if (!Peer) { this._say('peerjs did not load'); return false; }
    const typed = String(codeOrName || '').trim();
    if (typed.length < 3) { this._say('enter the room code or name'); return false; }
    const asCode = /^[A-Za-z0-9]{4,6}$/.test(typed) ? roomIdForCode(typed) : null;
    const id = asCode || roomIdFor(typed);
    if (!id) { this._say('that room name has nothing in it'); return false; }
    this.code = asCode ? typed.toUpperCase() : '';
    this.roomName = asCode ? '' : roomSlug(typed);

    this._say('connecting…');
    const peer = new Peer(PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => {
      const conn = peer.connect(id, { reliable: true });
      const link = wrapConn(conn);
      conn.on('open', () => this.join(link, { name }));
      conn.on('data', (d) => link.onMessage && link.onMessage(d));
      conn.on('close', () => { link.open = false; if (link.onClose) link.onClose(); });
      conn.on('error', () => this._say('could not reach that room'));
    });
    peer.on('error', (e) => {
      this._say(e && e.type === 'peer-unavailable' ? 'nobody is holding that room' : `error: ${e && e.type}`);
    });
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
      conn.on('data', (m) => {
        /* ⚠ EVERYTHING ARRIVING HERE IS FROM A STRANGER. `SessionDirectory.advertise`
         * rebuilds the row from a whitelist and clamps every field; this handler must not
         * be tempted to do anything cleverer than hand it over. */
        try {
          if (!m || typeof m !== 'object') return;
          if (m.t === MSG.ADVERT) dir.advertise(m.e, this.now());
          else if (m.t === MSG.UNADVERT) dir.withdraw(m.code);
          else if (m.t === MSG.LIST) conn.send({ t: MSG.ROOMS, r: dir.encode(this.now()) });
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
        if (!m || m.t !== MSG.ROOMS) return;
        const now = this.now();
        const dir = new SessionDirectory();
        for (const e of Array.isArray(m.r) ? m.r : []) dir.advertise(e, now - (Number(e.ageMs) || 0));
        this.rooms = dir.list(now);
        cb(this.rooms, null);
        try { conn.close(); } catch { /* gone */ }
      });
      conn.on('error', () => cb([], 'nobody is holding the session list right now'));
    };
    if (peer.open) ask(); else peer.on('open', ask);
  }
}

export { MSG, ACT, LACT, PROTOCOL_VERSION, MAX_SQUAD };
export { Lobby, SessionDirectory, LOBBY_PHASE, VISIBILITY, LOG_KIND, REMOVAL_REASONS, roomIdFor, roomSlug };
