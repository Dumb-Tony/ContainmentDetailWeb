/* The wire format. PURE — no transport, no sockets, no browser, no Game.
 *
 * Copied in shape from SmallTownEmergencyServices `src/net/protocol.js` (Dev/INDEX.md →
 * Multiplayer), and generalised from a fixed pair to a squad of up to five, which is what
 * GDD §11.1 asks for.
 *
 * GDD §20.3 states the authority rule and this file obeys it: the host owns anomaly state,
 * evidence, inventory transfers, containment conditions and the outcome. So there are
 * exactly three kinds of message that carry the game:
 *
 *   client → host   CMD   one operative's intent for a frame — an axis and two flags.
 *                         The same object main.js builds from the keyboard, which is why
 *                         a remote operative is indistinguishable from a local one to the
 *                         simulation.
 *   client → host   ACT   a discrete request: interact, use, deploy, take from cargo,
 *                         commit a procedure. Sequence-numbered and reliable. The host
 *                         VALIDATES every one — §20.9, "never trust client claims".
 *   host → client   SNAP  what the floor looks like now. The client does not run the
 *                         simulation at all; it draws this.
 *
 * Keeping encode/decode here, with no dependency on the network, is what lets the suite
 * round-trip a live mission through it and drive a whole host+client squad over a
 * loopback link with no WebRTC in sight.
 */

export const MSG = Object.freeze({
  HELLO: 'hello',       // client → host, on connect (carries a resume token if any)
  WELCOME: 'welcome',   // host → client, "you are p3, here is the floor"
  REFUSE: 'refuse',     // host → client, with a reason a human can read
  CMD: 'cmd',
  ACT: 'act',
  SNAP: 'snap',
  EVENT: 'event',       // host → client, a notice line
  BYE: 'bye',

  /* ── the lobby, GDD §11.4 ───────────────────────────────────────────────
   * The room BEFORE the operation, which is a different thing from the mission and gets
   * its own messages rather than riding on SNAP. Two reasons, and the second is the one
   * that matters: a lobby changes at human pace and a snapshot goes up twelve times a
   * second, so folding the roster into SNAP would multiply the cheapest state in the game
   * by the most expensive rate in it; and a lobby message carries CALLSIGNS, which SNAP
   * also does — but SNAP is replaced wholesale on arrival and a lobby broadcast must be
   * able to arrive without destroying anything the client owns. See `applyLobby`. */
  LOBBY: 'lobby',       // host → clients, the whole room state
  LACT: 'lact',         // client → host, a lobby-scoped request (ready, callsign)
  KICK: 'kick',         // host → one client, "you were removed", with a reason ID

  /* ── the volunteer directory ────────────────────────────────────────────
   * Host → directory holder, and joiner ↔ directory holder. No game state ever crosses
   * these: an advertisement is what `Lobby.describe()` returns and nothing else. */
  ADVERT: 'adv',        // host → directory, "this room exists"
  UNADVERT: 'unadv',    // host → directory, "it does not any more"
  LIST: 'ls',           // joiner → directory, "what have you got"
  ROOMS: 'rooms',       // directory → joiner, the rows
});

/** What a client may ask the LOBBY for. Distinct from ACT, which reaches the simulation:
 *  nothing on this list touches the world, so nothing on it goes near `Game`. */
export const LACT = Object.freeze({
  READY: 'r',           // { v: 0|1 }
  CALLSIGN: 'n',        // { n: string }
});

export const PROTOCOL_VERSION = 1;

/** GDD §11.1: supported 1-5, authored centre 3-5. */
export const MAX_SQUAD = 5;

/** Discrete requests a client may make. Anything not on this list is dropped. */
export const ACT = Object.freeze({
  INTERACT: 'i', USE: 'u', IMAGER: 'm', SLOT: 's',
  TAKE: 't', RETURN: 'r', PROCEDURE: 'p', ABORT: 'a', CLAIM: 'c',
  /* A squad call — GDD �11.3. The client sends the phrase ID and where it aimed; it does
   * NOT send who it is, because the host stamps the seat the link is in. Spoofing another
   * operative's callout is therefore impossible by construction rather than by validation. */
  PING: 'g',
});

/* ── numbers ──────────────────────────────────────────────────────────────
 * Positions to the centimetre, angles to the milliradian. A 24 m floor needs four
 * digits; the float would have cost seventeen, and nothing in this game is decided on
 * sub-centimetre differences — the tightest test in it is a 1.5 m seal radius.
 */
const q = (v) => Math.round((v || 0) * 100);
const u = (v) => (v || 0) / 100;
const q3 = (v) => Math.round((v || 0) * 1000);
const u3 = (v) => (v || 0) / 1000;

/* ── commands ─────────────────────────────────────────────────────────────
 * Short keys because this goes up sixty times a second and there is no reason for it to
 * be readable on the wire; it is readable HERE.
 *
 * Yaw rides along because the host needs it: which way an operative faces decides where
 * a tripod lands and what their reach resolves to. Leaving it client-side and predicted
 * would mean the fence post appeared in a different place on each machine.
 */
export function encodeCommand(cmd) {
  return {
    t: MSG.CMD,
    a: [q3(cmd.axis ? cmd.axis.x : 0), q3(cmd.axis ? cmd.axis.y : 0)],
    y: q3(cmd.yaw), p: q3(cmd.pitch),
    f: (cmd.sprint ? 1 : 0) | (cmd.crouch ? 2 : 0),
  };
}

export function decodeCommand(m) {
  return {
    axis: { x: u3(m.a[0]), y: u3(m.a[1]) },
    yaw: u3(m.y), pitch: u3(m.p),
    sprint: !!(m.f & 1), crouch: !!(m.f & 2),
  };
}

/* ── snapshot ─────────────────────────────────────────────────────────────
 * Deliberately a FULL snapshot rather than a delta. Five operatives, a dozen deployables
 * and seven evidence entries, over a reliable ordered channel: at 12 Hz this is a few KB
 * a second, and delta compression would be a pile of state-tracking bugs bought with
 * bandwidth nobody here is short of.
 */
export function encodeSnapshot(game) {
  const a = game.anomaly;
  return {
    t: MSG.SNAP,
    v: PROTOCOL_VERSION,
    ms: Math.round(game.clock.simTimeMs),
    ph: game.mission.phase,
    pr: q3(game.mission.pressure),
    amb: q3(game.heat.ambientC),
    cu: game.custody,
    ex: game.extracted ? 1 : 0,

    ps: game.players.map((p) => ({
      i: p.id, n: p.name,
      x: q(p.x), z: q(p.z), y: q3(p.yaw), pt: q3(p.pitch),
      f: (p.crouching ? 1 : 0) | (p.sprinting ? 2 : 0) | (p.downed ? 4 : 0)
        | (p.alive ? 8 : 0) | (p.extracted ? 16 : 0) | (game.imagerOnIds.has(p.id) ? 32 : 0)
        | (p.connected ? 64 : 0),
      dm: Math.round(p.downedMs), db: p.draggedBy || 0,
      st: q3(p.stress),
      ce: p.conditions.exposure.severity, cE: p.conditions.exposure.stabilised ? 1 : 0,
      cm: p.conditions.mobility.severity, cM: p.conditions.mobility.stabilised ? 1 : 0,
      sl: SLOT_IDS.map((s) => p.slots.get(s) || 0),
      hs: p.hands || 0, hd: p.heldSlot,
    })),

    an: {
      x: q(a.x), z: q(a.z), s: a.state, e: a.escapes == null ? -1 : a.escapes,
      ic: a.icePatches.map((p) => [q(p.x), q(p.z), q(p.r)]),
    },

    dp: game.deployables.list.map((d) => ({
      u: d.uid, it: d.itemId, x: q(d.x), z: q(d.z), y: q3(d.yaw),
      b: Math.round(d.batteryMs), f: (d.on ? 1 : 0) | (d.sealed ? 2 : 0) | (d.fedByPack ? 4 : 0),
      ch: Math.round(d.custodyHeldMs),
    })),

    si: {
      c: Array.from(game.site.circuits.values()).map((c) => [c.id, c.on ? 1 : 0]),
      d: game.site.doors.map((d) => [d.id, d.open ? 1 : 0]),
    },

    ca: Array.from(game.cache.entries()),
    ib: Math.round(game.batteryFor('thermal-imager')),

    ev: game.ledger.entries.map((e) => ({
      s: e.seq, e: e.evidenceId, ms: Math.round(e.simTimeMs),
      x: q(e.x), z: q(e.z), r: e.room, so: e.source, ig: e.integrity, an: e.annotation,
    })),
    cl: Array.from(game.ledger.claimState.entries()).filter(([, v]) => v),

    no: game.notices.slice(-6).map((n) => [Math.round(n.atMs), n.text]),
    /* The ping board is HOST STATE and is replaced wholesale, which is right for it and
     * would be wrong for `notices`: a notice feed is a per-machine accumulation and a
     * board is a snapshot of what is currently on the floor. Neither the lifetime, the
     * kind, the text nor the owner's name travels — every one of those is derived from a
     * phrase id both ends already have. */
    pg: game.comms.encode(),
    /* The distributed set. `anomalous` does NOT travel — the client already has the
     * incident file, so sending the truth flag would be sending it a copy of something it
     * loaded at boot. What travels is where each object is and whose hands it is in. */
    ix: game.instances.encode(),
    rs: game.result || 0,
  };
}

const SLOT_IDS = ['belt1', 'belt2', 'gen1', 'gen2', 'long1'];

/**
 * Write a snapshot into a client's Game, in place.
 *
 * In place, and reusing entities where the ids match, because the renderer holds
 * references across frames — rebuilding the player array every 80 ms would make the
 * camera jump to a new object each time (the lesson recorded against
 * SmallTownEmergencyServices `applySnapshot`).
 */
export function applySnapshot(game, snap, { localId = null } = {}) {
  if (!snap || snap.v !== PROTOCOL_VERSION) return false;

  game.clock.simTimeMs = snap.ms;
  game.mission.phase = snap.ph;
  game.mission.pressure = u3(snap.pr);
  game.heat.ambientC = u3(snap.amb);
  game.custody = snap.cu;
  game.extracted = !!snap.ex;

  /* players */
  const seen = new Set();
  for (const d of snap.ps) {
    let p = game.playerById(d.i);
    if (!p) { p = game.addPlayer(d.n); p.id = d.i; }
    p.name = d.n;
    seen.add(d.i);
    /* The local operative's position is PREDICTED, not overwritten — see
     * `reconcileLocal`. Everything else about them still comes from the host. */
    if (d.i !== localId) {
      p.x = u(d.x); p.z = u(d.z); p.yaw = u3(d.y); p.pitch = u3(d.pt);
    } else {
      p.netX = u(d.x); p.netZ = u(d.z);
    }
    p.crouching = !!(d.f & 1); p.sprinting = !!(d.f & 2);
    p.downed = !!(d.f & 4); p.alive = !!(d.f & 8); p.extracted = !!(d.f & 16);
    p.connected = !!(d.f & 64);
    if (d.f & 32) game.imagerOnIds.add(d.i); else game.imagerOnIds.delete(d.i);
    p.downedMs = d.dm; p.draggedBy = d.db || null;
    p.stress = u3(d.st);
    p.conditions.exposure.severity = d.ce; p.conditions.exposure.stabilised = !!d.cE;
    p.conditions.mobility.severity = d.cm; p.conditions.mobility.stabilised = !!d.cM;
    SLOT_IDS.forEach((s, i) => p.slots.set(s, d.sl[i] || null));
    p.hands = d.hs || null; p.heldSlot = d.hd;
  }
  for (let i = game.players.length - 1; i >= 0; i--) {
    if (!seen.has(game.players[i].id)) game.players.splice(i, 1);
  }
  game.player = game.players[0] || game.player;

  /* anomaly */
  const a = game.anomaly;
  a.x = u(snap.an.x); a.z = u(snap.an.z); a.state = snap.an.s;
  a.escapes = snap.an.e < 0 ? undefined : snap.an.e;
  a.icePatches = snap.an.ic.map(([x, z, r]) => ({ x: u(x), z: u(z), r: u(r), atMs: 0 }));

  /* deployables — same identity trick, keyed on uid */
  const depSeen = new Set();
  for (const d of snap.dp) {
    let e = game.deployables.list.find((x) => x.uid === d.u);
    if (!e) {
      e = game.deployables.place(game.itemsById.get(d.it), u(d.x), u(d.z), u3(d.y));
      e.uid = d.u;
    }
    depSeen.add(d.u);
    e.x = u(d.x); e.z = u(d.z); e.yaw = u3(d.y);
    e.batteryMs = d.b; e.on = !!(d.f & 1); e.sealed = !!(d.f & 2); e.fedByPack = !!(d.f & 4);
    e.custodyHeldMs = d.ch;
  }
  for (let i = game.deployables.list.length - 1; i >= 0; i--) {
    if (!depSeen.has(game.deployables.list[i].uid)) game.deployables.list.splice(i, 1);
  }
  a.sealedIn = game.deployables.list.find((d) => d.sealed) || null;

  /* site */
  for (const [id, on] of snap.si.c) game.site.setCircuit(id, !!on);
  for (const [id, open] of snap.si.d) {
    const door = game.site.doors.find((x) => x.id === id);
    if (door) game.site.setDoorOpen(door, !!open);
  }

  game.cache = new Map(snap.ca);
  game.itemBattery.set('thermal-imager', snap.ib);

  /* the ledger is append-only, so only ever grows toward the host's copy */
  for (const e of snap.ev) {
    if (game.ledger.has(e.e)) continue;
    game.ledger.record(e.e, {
      simTimeMs: e.ms, x: u(e.x), z: u(e.z), room: e.r, source: e.so, integrity: e.ig,
    });
  }
  for (const [id] of game.ledger.claimState) game.ledger.claimState.set(id, null);
  for (const [id, v] of snap.cl) game.ledger.claimState.set(id, v);

  game.notices = snap.no.map(([atMs, text]) => ({ atMs, text }));
  game.comms.decode(snap.pg || []);
  game.instances.decode(snap.ix || []);
  game.result = snap.rs || null;
  return true;
}

/* ── the lobby, on the wire ───────────────────────────────────────────────
 * Written here rather than in `lobby.js` for the reason the header gives: this file is the
 * wire format and knows nothing about anything. It reads a Lobby by duck-typing — a
 * `seats` Map and six scalars — so `lobby.js` need not import this file's encoder and
 * there is no cycle between the model and the format.
 */

/**
 * What every client is told about the room.
 *
 * ⚠ WHAT IS DELIBERATELY ABSENT: the action log, and the block list. Both are the host's
 * moderation record, both carry callsigns, and neither is any of the other players'
 * business — a client that received the host's log would be receiving a file about the
 * people sitting next to it. `tools/net-tests.js` fails the build if either ever appears
 * here. See the long note on `Lobby.log`.
 */
export function encodeLobby(lobby) {
  return {
    t: MSG.LOBBY,
    v: PROTOCOL_VERSION,
    ph: lobby.phase,
    vs: lobby.visibility,
    rm: lobby.roomName || '',
    cd: lobby.code || '',
    mx: lobby.maxSeats,
    op: lobby.operation
      ? { i: lobby.operation.id || '', l: lobby.operation.label || '', n: lobby.operation.incident || '' }
      : null,
    st: [...lobby.seats.values()].map((s) => ({
      i: s.seatId,
      n: s.callsign,
      f: (s.ready ? 1 : 0) | (s.connected ? 2 : 0) | (s.host ? 4 : 0),
    })),
  };
}

/**
 * Write a lobby broadcast into a client's Lobby, in place.
 *
 * ⚠⚠ THE SEAT MAP IS REPLACED WHOLESALE, AND THAT IS THE DANGEROUS PART.
 *
 * It is correct for a roster: the host owns who is in the room, and a client that kept its
 * own idea of the seats would eventually disagree about who it is playing with. It is
 * catastrophic for anything the CLIENT owns, and this project has already paid for that
 * lesson once — `applySnapshot` replaced the client's notice list with the host's and
 * destroyed every REFUSAL about eighty milliseconds after it arrived, which no loopback
 * test could find because reading a notice immediately always finds it.
 *
 * The lobby's version of that bug is the REMOVAL NOTICE. A removed operative is told why
 * and then hung up on; if the reason lived on the seat map, the next broadcast would erase
 * it — except that there is no next broadcast, because the link just closed, so the reason
 * would instead be erased by the broadcast that was already in flight when the host
 * removed them. Which of those two happens depends on the wire. So the reason does NOT
 * live here: `NetSession.removedWhy` holds it, nothing in this function can reach it, and
 * `onClose` is written not to overwrite it.
 *
 * The same argument applies to the client's own READY flag, which is why a client never
 * sets it locally: it asks, and the host's echo is the answer. An optimistic local toggle
 * would be right for exactly as long as it took the next broadcast to arrive.
 */
export function applyLobby(lobby, m) {
  if (!m || m.t !== MSG.LOBBY || m.v !== PROTOCOL_VERSION) return false;
  lobby.phase = m.ph;
  lobby.visibility = m.vs;
  lobby.roomName = m.rm || '';
  lobby.code = m.cd || null;
  if (m.mx) lobby.maxSeats = m.mx;
  lobby.operation = m.op ? { id: m.op.i, label: m.op.l, incident: m.op.n } : null;
  lobby.seats.clear();
  for (const s of m.st || []) {
    lobby.seats.set(s.i, {
      seatId: s.i,
      callsign: s.n,
      ready: !!(s.f & 1),
      connected: !!(s.f & 2),
      host: !!(s.f & 4),
      sinceMs: 0,
    });
  }
  return true;
}
