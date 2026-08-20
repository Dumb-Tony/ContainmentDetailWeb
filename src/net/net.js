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

import { MSG, ACT, PROTOCOL_VERSION, MAX_SQUAD, encodeCommand, decodeCommand, encodeSnapshot, applySnapshot } from './protocol.js';
import { PHASE } from '../sim/mission.js';

/* Signalling only: the broker introduces two browsers and then gets out of the way — no
 * game traffic passes through it. It is the one network host this build contacts, and the
 * suite's source-hygiene check (section K) knows about this file by name for that reason. */
const PEER_OPTS = { host: '0.peerjs.com', port: 443, secure: true, debug: 0 };
const ROOM_PREFIX = 'cdw-';

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
        deliver(() => { if (target.open && target.onMessage) target.onMessage(JSON.parse(wire)); }, latencyMs);
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
  constructor(game, { snapshotHz = 12 } = {}) {
    this.game = game;
    this.role = ROLE.SOLO;
    this.code = null;
    this.status = 'not connected';
    this.snapshotEveryMs = 1000 / snapshotHz;
    this._sinceSnapMs = 0;
    this.onStatus = null;
    this.onRoster = null;
    this.peer = null;

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
    this._say('hosting');
    return this;
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

  _hostOnMessage(link, m) {
    if (m.t === MSG.HELLO) return this._hostHello(link, m);

    const found = this._seatOf(link);
    if (!found) return;                       // talking before saying hello
    const { id } = found;

    if (m.t === MSG.CMD) {
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
    if (m.t === MSG.BYE) { this._seatLeft(link, true); }
  }

  _hostHello(link, m) {
    if (m.v !== PROTOCOL_VERSION) {
      link.send({ t: MSG.REFUSE, why: `Protocol ${m.v} against ${PROTOCOL_VERSION}. Somebody needs to reload.` });
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
        this._say(`${p.name} reconnected`);
        this._roster();
        return;
      }
    }

    /* GDD §11.5: joining in progress is allowed BEFORE the containment commitment. After
     * that the squad has a plan running and a new pair of hands arriving mid-procedure is
     * a liability, not a reinforcement. */
    if (this.game.mission.atLeast(PHASE.PROCEDURE_COMMITTED)) {
      link.send({ t: MSG.REFUSE, why: 'The squad has committed to a procedure. Join the next operation.' });
      return;
    }
    if (this.game.players.length >= MAX_SQUAD) {
      link.send({ t: MSG.REFUSE, why: `Squad is full (${MAX_SQUAD}).` });
      return;
    }

    const p = this.game.addPlayer((m.name || '').trim().slice(0, 14) || `Operative ${this.game.players.length + 1}`);
    p.remote = true;
    const token = `${p.id}-${randCode(() => (this.game.rng.float()))}`;
    this.seats.set(p.id, { link, token });
    link.send(this._welcome(p.id, token));
    this._say(`${p.name} joined`);
    this._roster();
  }

  _welcome(id, token) {
    return {
      t: MSG.WELCOME, v: PROTOCOL_VERSION, id, token,
      seed: this.game.seedLabel,
      map: this.game.site.id,
      snap: encodeSnapshot(this.game),
    };
  }

  /**
   * A discrete request. EVERY one goes through the same validated entry point the host's
   * own keyboard uses — there is no client-only path into the simulation, which is the
   * whole of §20.9 in one sentence.
   */
  _hostAct(id, m) {
    this.actsReceived++;
    const g = this.game;
    let err = null;
    switch (m.k) {
      case ACT.INTERACT: err = g.doInteract(id); break;
      case ACT.USE: err = g.useHeld(id); break;
      case ACT.IMAGER: err = g.toggleImager(id); break;
      case ACT.SLOT: { const p = g.playerById(id); if (p) p.selectSlot(m.n | 0); break; }
      case ACT.TAKE: err = g.takeFromCache(String(m.id || ''), id); break;
      case ACT.RETURN: err = g.returnToCache(id); break;
      case ACT.PROCEDURE: err = g.commitProcedure(m.card || {}); break;
      case ACT.ABORT: g.abortProcedure(); break;
      case ACT.CLAIM: g.ledger.setClaim(String(m.id || ''), m.v || null); break;
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
    /* Custody is the one thing that cannot wait for them to come back. */
    if (p.hands === 'reinforced-transit-case') {
      this.game._putDownCase(p);
      this.game.notice(`${p.name}'s radio went out. The case is on the floor where they stood.`);
    } else {
      this.game.notice(`${p.name}'s radio went out. Their slot is being held.`);
    }
    this._say(`${p.name} dropped`);
    this._roster();
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
    }
    this._say('a seat opened');
    this._roster();
  }

  /* ── client ───────────────────────────────────────────────────────────── */

  join(link, { name = 'Operative', token = null } = {}) {
    this.role = ROLE.CLIENT;
    this.link = link;
    link.onMessage = (m) => this._clientOnMessage(m);
    link.onClose = () => this._say('disconnected');
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
    if (m.t === MSG.REFUSE) { this._say(m.why || 'refused'); return; }
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
    this.link.send({ t: MSG.ACT, n: ++this._actSeq, k: kind, ...extra });
    return true;
  }

  /* ── the pump ─────────────────────────────────────────────────────────── */

  /**
   * Once per rendered frame from main.js.
   * @param {number} dtMs  real frame time
   * @param {object} cmd   THIS machine's local command for this frame
   */
  pump(dtMs, cmd) {
    if (this.role === ROLE.HOST) {
      this._sinceSnapMs += dtMs;
      if (this._sinceSnapMs < this.snapshotEveryMs) return;
      this._sinceSnapMs = 0;
      const snap = encodeSnapshot(this.game);
      for (const seat of this.seats.values()) if (seat.link.open) seat.link.send(snap);
      return;
    }
    if (this.role === ROLE.CLIENT && this.link && this.link.open && cmd) {
      this.link.send(encodeCommand(cmd));
    }
  }

  leave() {
    try {
      if (this.role === ROLE.CLIENT && this.link && this.link.open) {
        this.link.send({ t: MSG.BYE });
        this.link.close();
      }
      for (const seat of this.seats.values()) if (seat.link.open) seat.link.close();
    } catch { /* going away anyway */ }
    try { if (this.peer) this.peer.destroy(); } catch { /* ditto */ }
    this.seats.clear();
    this.link = null; this.peer = null;
    this.role = ROLE.SOLO;
    this.localPlayerId = 'p1';
    this._say('not connected');
  }

  /* ── PeerJS, the real transport ───────────────────────────────────────── */

  /** Open a room. Returns the code immediately; operatives may connect much later. */
  hostPeer(rand = Math.random) {
    const Peer = globalThis.Peer;
    if (!Peer) { this._say('peerjs did not load'); return null; }
    this.host();
    this.code = randCode(rand);
    this._say('opening room…');
    const peer = new Peer(ROOM_PREFIX + this.code, PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => this._say(`room ${this.code} — waiting`));
    peer.on('connection', (conn) => {
      const link = wrapConn(conn);
      conn.on('open', () => this.accept(link));
      conn.on('data', (d) => link.onMessage && link.onMessage(d));
      conn.on('close', () => { link.open = false; if (link.onClose) link.onClose(); });
    });
    peer.on('error', (e) => {
      this._say(e && e.type === 'unavailable-id' ? 'code taken — host again' : `error: ${e && e.type}`);
    });
    return this.code;
  }

  joinPeer(code, name) {
    const Peer = globalThis.Peer;
    if (!Peer) { this._say('peerjs did not load'); return false; }
    this.code = (code || '').trim().toUpperCase();
    if (this.code.length < 4) { this._say('enter the room code'); return false; }
    this._say('connecting…');
    const peer = new Peer(PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => {
      const conn = peer.connect(ROOM_PREFIX + this.code, { reliable: true });
      const link = wrapConn(conn);
      conn.on('open', () => this.join(link, { name }));
      conn.on('data', (d) => link.onMessage && link.onMessage(d));
      conn.on('close', () => { link.open = false; if (link.onClose) link.onClose(); });
      conn.on('error', () => this._say('could not reach that room'));
    });
    peer.on('error', (e) => {
      this._say(e && e.type === 'peer-unavailable' ? 'no room with that code' : `error: ${e && e.type}`);
    });
    return true;
  }
}

export { MSG, ACT, PROTOCOL_VERSION, MAX_SQUAD };
