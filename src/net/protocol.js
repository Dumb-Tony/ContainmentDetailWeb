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

/* ── what a stranger is allowed to put in your Game ───────────────────────────
 *
 * ⚠ EVERY FIELD BELOW THIS LINE ARRIVED FROM ANOTHER PERSON'S BROWSER. `applySnapshot`
 * and `applyLobby` are the two functions in this build that write a peer's JSON straight
 * into your state, and until this section existed they took the shape on trust: an absent
 * `ps` threw, a `hs` naming an item this build has never heard of crashed the HUD on the
 * next frame, an `s` on the anomaly went into `t('hud.bezel.held', {state})` and out
 * through `innerHTML`, and `ph` did the same through `t('phase.' + ph)`.
 *
 * The rule this section keeps, stated once:
 *
 *   A STRING THAT WILL BE USED AS A KEY IS AN ID; A STRING THAT WILL BE READ IS TEXT.
 *
 * `safeId` is for anything that gets looked up (`t('phase.' + x)`, `itemsById.get(x)`,
 * `PHRASES[x]`) — a closed charset, bounded, and never one of `Object.prototype`'s own
 * names, because `PHRASES['constructor']` is truthy and `PHRASES['nonsense']` is not, and
 * exactly one of those two crashes the comms feed on every frame for the rest of the
 * session. `safeLine` is for prose — it does not restrict the alphabet, because clipping
 * an apostrophe out of "Contractors' store" is a worse bug than the one it prevents; it
 * strips control characters and clamps the length, and the UI still escapes it.
 *
 * ⚠ NEITHER OF THESE REPLACES `escapeHtml`. They stop a hostile peer reaching a message
 * KEY or an object lookup; they are not an HTML sanitiser and must never be treated as
 * one. Both layers, always — this file cannot see the DOM and hud.js cannot see the wire.
 */

/** `Object.prototype`'s own names, plus the two that reach a constructor another way. A
 *  string on this list is never a valid id, whatever it is an id for. */
const POISON_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype', 'constructor']);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** Control characters, stripped from anything that will be shown to a person. */
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

/** @returns {string|null} the id, or null if this is not one. */
export function safeId(v, max = 48) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) return null;
  if (POISON_KEYS.has(v)) return null;
  return ID_RE.test(v) ? v : null;
}

/** @returns {string} bounded, printable, and never `undefined` — text, not an id. */
export function safeLine(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.replace(CONTROL_RE, ' ').slice(0, max);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** A number, clamped. ⚠ NOT `Number(v) || fb` — see the note on `_hostRead`: JSON has no
 *  NaN, so a field the sender could not encode arrives as `null`, and `+null` is 0. */
const real = (v, lo, hi, fb = 0) => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : fb);
const int = (v, lo, hi, fb = 0) => Math.round(real(v, lo, hi, fb));
const isArr = Array.isArray;
const isObj = (v) => !!v && typeof v === 'object' && !isArr(v);

/** Positions and angles, in the units the encoders above produce. One place, so a clamp
 *  cannot drift from the quantisation it is protecting. */
const CM = 1e6;            // ±10,000 m in centimetres — larger than any floor, finite
const MRAD = 1e7;
const MS = 1e12;           // ~31 years of simulation time

/**
 * Is this a snapshot at all?
 *
 * Exported so a suite can assert WHY one was refused rather than only that it was, and so
 * the reason can be counted on the receiving session. A snapshot whose skeleton is wrong
 * is refused WHOLESALE and nothing is written: a client that keeps its last good frame is
 * one frame stale, and a client half-written from a hostile frame is broken for good.
 *
 * @returns {string|null} the reason it is not, or null if it is
 */
export function snapshotProblem(snap) {
  if (!isObj(snap)) return 'not an object';
  if (snap.t !== undefined && snap.t !== MSG.SNAP) return 'not a snapshot';
  if (snap.v !== PROTOCOL_VERSION) return `protocol ${JSON.stringify(snap.v)}`;
  if (!isNum(snap.ms)) return 'ms is not a number';
  if (!safeId(snap.ph)) return 'ph is not a phase id';
  for (const k of ['ps', 'dp', 'ev', 'no', 'ca', 'cl']) if (!isArr(snap[k])) return `${k} is not an array`;
  if (!isObj(snap.an) || !isArr(snap.an.ic)) return 'an is not an anomaly';
  if (!isObj(snap.si) || !isArr(snap.si.c) || !isArr(snap.si.d)) return 'si is not a site';
  /* §11.1 supports one to five. A frame claiming more is not a squad, and applying it would
   * call `addPlayer` once per row, once per frame, for as long as the host cared to send. */
  if (snap.ps.length > MAX_SQUAD) return `${snap.ps.length} seats, past the squad of ${MAX_SQUAD}`;
  for (const d of snap.ps) if (!isObj(d) || !safeId(d.i, 16)) return 'a player row has no seat id';
  if (snap.dp.length > 256) return `${snap.dp.length} deployables`;
  return null;
}

/** The same question for a lobby broadcast. @returns {string|null} */
export function lobbyProblem(m) {
  if (!isObj(m)) return 'not an object';
  if (m.t !== MSG.LOBBY) return 'not a lobby broadcast';
  if (m.v !== PROTOCOL_VERSION) return `protocol ${JSON.stringify(m.v)}`;
  if (m.st !== undefined && !isArr(m.st)) return 'st is not an array';
  return null;
}

/**
 * The debrief, rebuilt from a whitelist.
 *
 * ⚠ `game.result = snap.rs` TOOK A STRANGER'S OBJECT VERBATIM and `panels.showDebrief`
 * printed `d.name` and `d.word` into `innerHTML` without escaping, and put `result.overall`
 * through `msg('grade.' + overall)` — which returns the KEY when it does not know it. So
 * `overall: '<img src=x onerror=…>'` came back out of the message table unchanged and went
 * into an `<h1>`. Rebuilt, never spread: the same rule `SessionDirectory.advertise` keeps
 * for exactly the same reason.
 */
function sanitiseResult(rs) {
  if (!isObj(rs)) return null;
  return {
    overall: safeId(rs.overall, 32) || 'Compromised',
    failReason: rs.failReason ? safeLine(rs.failReason, 200) : null,
    dims: (isArr(rs.dims) ? rs.dims : []).slice(0, 16).filter(isObj).map((d) => ({
      id: safeId(d.id, 48) || '',
      wordId: safeId(d.wordId, 48) || '',
      name: safeLine(d.name, 64),
      word: safeLine(d.word, 64),
      why: safeLine(d.why, 240),
      ...(isNum(d.value) ? { value: d.value } : {}),
    })),
    claims: isObj(rs.claims)
      ? { right: int(rs.claims.right, 0, 999), wrong: int(rs.claims.wrong, 0, 999), unmarked: int(rs.claims.unmarked, 0, 999) }
      : { right: 0, wrong: 0, unmarked: 0 },
  };
}

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
    /**
     * ⚠ THE DEBRIEF RODE EVERY SNAPSHOT, FOR EVER, UNCHANGED.
     *
     * `game.result` is the whole graded report — ten dimensions, each with a name, a word
     * and a sentence of prose — and it was sent flat in every snapshot. Measured by
     * `tools/soak.ps1`: the field steps from 1 byte to about 1,430 the instant the mission
     * ends and then repeats at 12 Hz for the rest of the session. About 17 kB/s of pure
     * repetition, on six of nine incidents, after there is nothing left to play.
     *
     * Not a leak — a step, and the largest field on the wire post-debrief. It is sent on the
     * frames where it CHANGED and skipped otherwise; a client that already has it keeps what
     * it has, because `applySnapshot` only overwrites when the field is present.
     *
     * A snapshot is still a FULL snapshot of everything a late or lossy client needs to
     * converge — that is the property 30% packet loss is survivable because of, and it is
     * not being given up here. The debrief is the one field that cannot go stale: once the
     * mission has ended nothing produces a different one, so a client that missed the frame
     * it changed on gets it from the next change, and there is never a next change.
     *
     * ⚠ WHICH IS WHY A JOINER STILL GETS IT. `_welcome` sends a full snapshot with `rs`
     * forced, so somebody arriving after the debrief is not looking at a blank screen.
     */
    ...(game.result && game.result !== game._sentResult ? { rs: game.result } : {}),
  };
}

/**
 * The same snapshot with every optional field forced on.
 *
 * For the one moment a client has NO prior state to keep: the welcome. Everything else can
 * rely on "absent means unchanged"; a joiner cannot, because for them absent means unknown.
 */
export function encodeFullSnapshot(game) {
  const s = encodeSnapshot(game);
  if (game.result) s.rs = game.result;
  return s;
}

const SLOT_IDS = ['belt1', 'belt2', 'gen1', 'gen2', 'long1'];

/**
 * Write a snapshot into a client's Game, in place.
 *
 * In place, and reusing entities where the ids match, because the renderer holds
 * references across frames — rebuilding the player array every 80 ms would make the
 * camera jump to a new object each time (the lesson recorded against
 * SmallTownEmergencyServices `applySnapshot`).
 *
 * ⚠ AND IT IS A FUNCTION A STRANGER CALLS. The header of `net.js` says the host's inbox is
 * "the one function in this build a stranger can call", and that was never true: in a
 * NAMED or LISTED room the HOST is a stranger too, and this is the function they reach.
 * Every field is checked; the skeleton is checked FIRST and the whole frame refused if it
 * is wrong, so a hostile snapshot cannot half-write a Game. See `snapshotProblem`.
 *
 * @returns {boolean} true if the frame was applied
 */
export function applySnapshot(game, snap, { localId = null } = {}) {
  if (snapshotProblem(snap)) return false;

  game.clock.simTimeMs = real(snap.ms, 0, MS, game.clock.simTimeMs);
  game.mission.phase = snap.ph;                       // already a safeId — see snapshotProblem
  game.mission.pressure = u3(real(snap.pr, 0, 1e6, 0));
  game.heat.ambientC = u3(real(snap.amb, -1e6, 1e6, 0));
  game.custody = safeId(snap.cu, 16) || 'none';
  game.extracted = !!snap.ex;

  /* players */
  const seen = new Set();
  for (const d of snap.ps) {
    /* ⚠ THE SEAT ID AND THE CALLSIGN ARE NOT THE SAME KIND OF STRING. The id is looked up,
     * so it is an id; the callsign is typed by a person, so it is text — clamped to the
     * same fourteen characters the host's own `_hostHello` clamps to, because a host that
     * sends more than it would accept is not a host this end has to believe. */
    const id = safeId(d.i, 16);
    const name = safeLine(d.n, 14) || 'Operative';
    let p = game.playerById(id);
    if (!p) { p = game.addPlayer(name); p.id = id; }
    p.name = name;
    seen.add(id);
    /* The local operative's position is PREDICTED, not overwritten — see
     * `reconcileLocal`. Everything else about them still comes from the host. */
    if (id !== localId) {
      p.x = u(real(d.x, -CM, CM, q(p.x))); p.z = u(real(d.z, -CM, CM, q(p.z)));
      p.yaw = u3(real(d.y, -MRAD, MRAD, q3(p.yaw))); p.pitch = u3(real(d.pt, -MRAD, MRAD, q3(p.pitch)));
    } else {
      p.netX = u(real(d.x, -CM, CM, q(p.x))); p.netZ = u(real(d.z, -CM, CM, q(p.z)));
    }
    const f = int(d.f, 0, 0xffff, 0);
    p.crouching = !!(f & 1); p.sprinting = !!(f & 2);
    p.downed = !!(f & 4); p.alive = !!(f & 8); p.extracted = !!(f & 16);
    p.connected = !!(f & 64);
    if (f & 32) game.imagerOnIds.add(id); else game.imagerOnIds.delete(id);
    p.downedMs = real(d.dm, 0, MS, 0); p.draggedBy = safeId(d.db, 16);
    p.stress = u3(real(d.st, 0, 1e6, 0));
    p.conditions.exposure.severity = int(d.ce, 0, 3, 0); p.conditions.exposure.stabilised = !!d.cE;
    p.conditions.mobility.severity = int(d.cm, 0, 3, 0); p.conditions.mobility.stabilised = !!d.cM;
    /* ⚠ AN ITEM ID THIS BUILD DOES NOT HAVE IS NOT AN ITEM. `hud.js` reads
     * `itemsById.get(p.hands).displayName` with no guard, so one unknown id in `hs` threw
     * out of the HUD on every frame for the rest of the session — a two-character denial
     * of service against a client, from the host. Filtered here rather than guarded there,
     * because the same lookup is made in four places and only one of them was guarded. */
    const slots = isArr(d.sl) ? d.sl : [];
    SLOT_IDS.forEach((s, i) => {
      const it = safeId(slots[i], 48);
      p.slots.set(s, it && game.itemsById.has(it) ? it : null);
    });
    const hands = safeId(d.hs, 48);
    p.hands = hands && game.itemsById.has(hands) ? hands : null;
    p.heldSlot = SLOT_IDS.includes(d.hd) ? d.hd : null;
  }
  for (let i = game.players.length - 1; i >= 0; i--) {
    if (!seen.has(game.players[i].id)) game.players.splice(i, 1);
  }
  game.player = game.players[0] || game.player;

  /* anomaly */
  const a = game.anomaly;
  a.x = u(real(snap.an.x, -CM, CM, q(a.x))); a.z = u(real(snap.an.z, -CM, CM, q(a.z)));
  /* ⚠ THE STATE IS A KEY. `hud.js` puts it through `t('hud.bezel.held', {state})` and out
   * through `innerHTML`, so a free string here is markup on four other machines the moment
   * anybody raises the imager. It is an id or it is the last one we had. */
  a.state = safeId(snap.an.s, 32) || a.state;
  const esc = int(snap.an.e, -1, 999, -1);
  a.escapes = esc < 0 ? undefined : esc;
  a.icePatches = snap.an.ic.slice(0, 64).filter(isArr).map(([x, z, r]) => ({
    x: u(real(x, -CM, CM, 0)), z: u(real(z, -CM, CM, 0)), r: u(real(r, 0, CM, 0)), atMs: 0,
  }));

  /* deployables — same identity trick, keyed on uid */
  const depSeen = new Set();
  for (const d of snap.dp) {
    if (!isObj(d)) continue;
    const uid = int(d.u, 0, 1e9, -1);
    const itemId = safeId(d.it, 48);
    /* An item this build does not have cannot be placed: `deployables.place(undefined, …)`
     * is a crash on the client, from one field of one row. */
    if (uid < 0 || !itemId || !game.itemsById.has(itemId)) continue;
    const x = u(real(d.x, -CM, CM, 0)), z = u(real(d.z, -CM, CM, 0)), yaw = u3(real(d.y, -MRAD, MRAD, 0));
    let e = game.deployables.list.find((v) => v.uid === uid);
    if (!e) {
      e = game.deployables.place(game.itemsById.get(itemId), x, z, yaw);
      e.uid = uid;
    }
    depSeen.add(uid);
    const f = int(d.f, 0, 0xffff, 0);
    e.x = x; e.z = z; e.yaw = yaw;
    e.batteryMs = real(d.b, 0, MS, 0); e.on = !!(f & 1); e.sealed = !!(f & 2); e.fedByPack = !!(f & 4);
    e.custodyHeldMs = real(d.ch, 0, MS, 0);
  }
  for (let i = game.deployables.list.length - 1; i >= 0; i--) {
    if (!depSeen.has(game.deployables.list[i].uid)) game.deployables.list.splice(i, 1);
  }
  a.sealedIn = game.deployables.list.find((d) => d.sealed) || null;

  /* site — the client already has the floor, so a circuit or a door it does not know is a
   * row from a different building and is dropped rather than invented. */
  for (const row of snap.si.c) {
    if (!isArr(row)) continue;
    const c = game.site.circuits.get(row[0]);
    if (c) game.site.setCircuit(row[0], !!row[1]);
  }
  for (const row of snap.si.d) {
    if (!isArr(row)) continue;
    const door = game.site.doors.find((x) => x.id === row[0]);
    if (door) game.site.setDoorOpen(door, !!row[1]);
  }

  /* ⚠ THE CARGO MANIFEST IS RENDERED BY ID. `panels._renderCache` reads
   * `itemsById.get(itemId).displayName`, so a cache key naming nothing crashes the manifest
   * screen — and `new Map(snap.ca)` accepted whatever was in the field, including a string,
   * which throws here instead. */
  const cache = new Map();
  for (const row of snap.ca.slice(0, 128)) {
    if (!isArr(row)) continue;
    const itemId = safeId(row[0], 48);
    if (itemId && game.itemsById.has(itemId)) cache.set(itemId, int(row[1], 0, 9999, 0));
  }
  game.cache = cache;
  game.itemBattery.set('thermal-imager', real(snap.ib, 0, MS, 0));

  /* the ledger is append-only, so only ever grows toward the host's copy. `record` already
   * refuses an id with no rule behind it; the prose fields are clamped because they are
   * printed, and `escapeHtml` on the tablet is the second half of that and not the first. */
  for (const e of snap.ev.slice(0, 256)) {
    if (!isObj(e)) continue;
    const evId = safeId(e.e, 64);
    if (!evId || game.ledger.has(evId)) continue;
    game.ledger.record(evId, {
      simTimeMs: real(e.ms, 0, MS, 0),
      x: u(real(e.x, -CM, CM, 0)), z: u(real(e.z, -CM, CM, 0)),
      room: safeLine(e.r, 64), source: safeLine(e.so, 64), integrity: safeLine(e.ig, 32),
    });
  }
  /* ⚠ ONLY CLAIMS THE BOARD ALREADY HAS. `claimState.set(id, v)` on a raw key let a host
   * grow an unbounded Map in a client that never reads a single one of the entries — the
   * board iterates `ledger.claims`, which is content. */
  for (const [id] of game.ledger.claimState) game.ledger.claimState.set(id, null);
  for (const row of snap.cl.slice(0, 128)) {
    if (!isArr(row) || !game.ledger.claimState.has(row[0])) continue;
    game.ledger.claimState.set(row[0], row[1] === 'believed' || row[1] === 'excluded' ? row[1] : null);
  }

  game.notices = snap.no.slice(-6).filter(isArr)
    .map(([atMs, text]) => ({ atMs: real(atMs, 0, MS, 0), text: safeLine(text, 200) }));
  /* ⚠ `PHRASES[phrase]` IS NOT A MEMBERSHIP TEST. `comms.decode` guards with it and
   * `PHRASES['constructor']` is truthy, so `pg: [[1,'p1','constructor',0,0,0]]` got past the
   * guard and then threw on `ANCHORS[undefined].placed` in the feed — every frame, for
   * ever. `safeId` refuses every own name of `Object.prototype`, which is the actual set. */
  game.comms.decode(snap.pg === undefined ? [] : (isArr(snap.pg) ? snap.pg : []).slice(0, 64)
    .filter((r) => isArr(r) && r.length >= 6 && safeId(r[2], 48) && safeId(r[1], 16))
    .map((r) => [int(r[0], 0, 1e9, 0), r[1], r[2], real(r[3], -CM, CM, 0), real(r[4], -CM, CM, 0), real(r[5], 0, MS, 0)]));
  game.instances.decode(isArr(snap.ix) ? snap.ix.slice(0, 128).filter(isArr) : []);
  /* ⚠ ABSENT MEANS UNCHANGED, NOT NULL. `snap.rs || null` would clear the debrief on the
   * very next frame after it arrived, because the field is only sent when it changes. The
   * one field in this function that is not a full overwrite, and the comment is here so
   * nobody tidies it back into the pattern the others follow. */
  if (snap.rs !== undefined) game.result = sanitiseResult(snap.rs);
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
 *
 * ⚠ AND EVERY FIELD OF IT IS THE HOST'S CLAIM. `callsign: s.n` was written straight
 * through — so a host could hand every client a megabyte of "callsign" for a seat that
 * does not exist, at whatever rate it liked, while its own `_hostHello` clamped its own
 * players to fourteen characters. A host that sends more than it would accept is not one
 * this end has to believe. Refused wholesale on a bad skeleton; see `lobbyProblem`.
 */
export function applyLobby(lobby, m) {
  if (lobbyProblem(m)) return false;
  lobby.phase = safeId(m.ph, 24) || lobby.phase;
  lobby.visibility = safeId(m.vs, 24) || lobby.visibility;
  lobby.roomName = safeLine(m.rm, 24);
  lobby.code = m.cd ? safeLine(m.cd, 16) : null;
  const mx = int(m.mx, 1, MAX_SQUAD, 0);
  if (mx) lobby.maxSeats = mx;
  lobby.operation = isObj(m.op)
    ? { id: safeId(m.op.i, 48) || '', label: safeLine(m.op.l, 64), incident: safeId(m.op.n, 48) || '' }
    : null;
  lobby.seats.clear();
  for (const s of (m.st || []).slice(0, MAX_SQUAD)) {
    if (!isObj(s)) continue;
    const seatId = safeId(s.i, 16);
    if (!seatId || lobby.seats.has(seatId)) continue;
    const f = int(s.f, 0, 0xffff, 0);
    lobby.seats.set(seatId, {
      seatId,
      callsign: safeLine(s.n, 14) || 'Operative',
      ready: !!(f & 1),
      connected: !!(f & 2),
      host: !!(f & 4),
      sinceMs: 0,
    });
  }
  return true;
}
