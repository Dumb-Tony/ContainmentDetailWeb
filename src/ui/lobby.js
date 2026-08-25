/* The session lobby — GDD §11.4, §11.7, §18.1, and §23's Milestone 4.
 *
 * The room BEFORE the operation card. Until now the only way into a co-op session was for
 * the host to read five characters aloud, which works and is the reason a squad that has
 * not already agreed to play cannot form at all.
 *
 * ⚠ THIS SCREEN MAY NOT CLAIM MORE THAN THE TRANSPORT DELIVERS (§18.1: "the game
 * distinguishes observed fact, system interpretation, and player theory"). There is no
 * game server. `src/net/lobby.js` sets out exactly what discovery a PeerJS broker can and
 * cannot support; the job HERE is to make sure every row on this page says which of the
 * three it is:
 *
 *   FACT        "this room answered a moment ago" — the result of a probe, which is a real
 *               connection attempt against a real peer id.
 *   REPORT      "a host said this room existed 41 seconds ago" — a directory row. Held in
 *               a stranger's browser, unverified, and stale by construction. Every one of
 *               those words appears on the row.
 *   MEMORY      "you joined this room on Tuesday" — the local list. It says nothing at all
 *               about whether anybody is there, which is why every row has a Check button.
 *
 * A listing that cannot say which of the three it is does not go on the page.
 *
 * ── WHERE THE WALL CLOCK LIVES ───────────────────────────────────────────────
 * Here, and in `main.js`. `src/net/**` is handed a `now()` and has no opinion about what
 * kind of time it is (section K5 forbids every file but the boot loop from reading it, and
 * an injected clock is the only kind a staleness test can pin down).
 *
 * ── WHAT IS NOT PERSISTED, AND WHY ───────────────────────────────────────────
 * The rooms you have joined are yours and go in localStorage. THE ACTION LOG DOES NOT, and
 * neither does the roster. §21.2 ends "do not record raw voice, free-text chat, or
 * unnecessary personal data", and a list of other people's typed callsigns sitting on disk
 * after the tab closed is the clearest example of that in the build. The host's moderation
 * record lives in memory on the host's machine for the length of the session and then it
 * is gone. See the long note on `Lobby.log`.
 */

import { escapeHtml } from './hud.js';
import {
  LOBBY_PHASE, VISIBILITY, REMOVAL_REASONS, DEFAULT_REASON, LOG_WORDS,
  roomSlug, nameExposure,
} from '../net/lobby.js';
import { ROLE, MAX_SQUAD } from '../net/net.js';
import { CONFIG } from '../config.js';

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

/** Where the joiner's own memory of rooms lives. Their machine, their rooms. */
const RECENT_KEY = 'cd.lobby.recent';
const CALLSIGN_KEY = 'cd.lobby.callsign';
/** The one seat this tab may walk back into. sessionStorage, never localStorage — see
 *  `loadResume`. Exported so the suite can grep the blob it writes. */
export const RESUME_KEY = 'cd.session.resume';
/** How long a join is allowed to sit at "asking" before the screen calls it dead. The
 *  broker reports an unclaimed id quickly; the case this covers is the one it never
 *  reports — a registered tab that will not answer. */
export const JOIN_TIMEOUT_MS = 12000;
const RECENT_MAX = 8;
/** Control characters, stripped from anything read off disk and put on the screen. Built
 *  from a string rather than written as a literal, so the source file stays text. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

/** A duration a person reads, rather than a number of milliseconds. */
export function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * The joiner's own history. A pure pair of functions over a storage-like object so the
 * suite can drive them with a fake and so a profile that refuses storage degrades to an
 * empty list rather than throwing (the same contract `Settings.restore` keeps).
 */
/**
 * ⚠ IT TRUSTED WHAT IT FOUND. This read the rows and handed them to the renderer as they
 * came — so a row's `label` could be any length and any type, and `rows` could be a list of
 * a hundred thousand of them. Every field IS escaped on the way to the DOM, so this was
 * never markup; it was an unbounded structure read off disk into a screen, and localStorage
 * on `<user>.github.io` is shared with every other project published under that name, so
 * "off disk" is not the same as "written by this game".
 *
 * Rebuilt from a whitelist rather than filtered, which is the rule
 * `SessionDirectory.advertise` already keeps for the same kind of data arriving the other
 * way. The row shape is three fields and a time; anything else in the file is not a room.
 */
export function loadRecent(store) {
  try {
    const raw = store && store.getItem(RECENT_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows.slice(0, RECENT_MAX * 4)) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const code = String(r.code == null ? '' : r.code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
      const room = roomSlug(r.room);
      if (!code && !room) continue;
      out.push({
        code,
        room,
        label: String(r.label == null ? '' : r.label).replace(CONTROL_CHARS, ' ').slice(0, 40),
        atMs: typeof r.atMs === 'number' && Number.isFinite(r.atMs) ? r.atMs : 0,
      });
      if (out.length >= RECENT_MAX) break;
    }
    return out;
  } catch { return []; }
}

export function rememberRoom(store, entry, atMs) {
  const rows = loadRecent(store);
  const key = (r) => `${r.code || ''}|${r.room || ''}`;
  const row = {
    code: entry.code || '',
    room: roomSlug(entry.room || ''),
    label: String(entry.label || '').slice(0, 40),
    /* ⚠ NO CALLSIGNS. This is a list of ROOMS, and the moment it grows a "who was there"
     * field it is a record of other people kept on a third party's disk. */
    atMs,
  };
  const next = [row, ...rows.filter((r) => key(r) !== key(row))].slice(0, RECENT_MAX);
  try { if (store) store.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* no storage, no memory */ }
  return next;
}

/* ── the seat this tab can walk back into ─────────────────────────────────── */

/**
 * The one thing this machine remembers about a live session: ITS OWN seat. The token the
 * host issued, which room it belongs to, and the player's OWN callsign for the button
 * label — never anybody else's anything. §21.2 ends "do not record … unnecessary personal
 * data", and a roster or token cache that grew a "who else was there" field would be
 * exactly that; the suite greps the written blob for other seats' callsigns.
 *
 * sessionStorage, not localStorage, and that is load-bearing twice over:
 *   · a resume token is a key back into a RUNNING mission. It has no business outliving
 *     the browsing session it was issued in — the host's seat map dies with the host's
 *     tab, so a token on disk overnight is a stale promise at best.
 *   · sessionStorage is per-tab, which is what keeps two of the same player's tabs from
 *     believing they are the same operative. (A DUPLICATED tab copies it; the host hangs
 *     up the older link when the copy resumes, so even that case converges to one seat.)
 *
 * Rebuilt from a whitelist on the way out, exactly like `loadRecent` above it: the origin
 * is shared with every other project on the same `<user>.github.io`, so "off disk" is not
 * the same as "written by this game".
 */
export function loadResume(store) {
  try {
    const raw = store && store.getItem(RESUME_KEY);
    if (typeof raw !== 'string' || !raw) return null;
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const token = typeof r.token === 'string' ? r.token.replace(CONTROL_CHARS, '').slice(0, 64) : '';
    const code = String(r.code == null ? '' : r.code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    const room = roomSlug(r.room);
    if (!token || (!code && !room)) return null;
    return {
      token,
      code,
      room,
      callsign: (typeof r.callsign === 'string' ? r.callsign.replace(CONTROL_CHARS, ' ').trim().slice(0, 14) : '') || 'Operative',
      atMs: typeof r.atMs === 'number' && Number.isFinite(r.atMs) ? r.atMs : 0,
    };
  } catch { return null; }
}

/** Write the seat. `callsign` is the LOCAL player's — the call sites only ever hand this
 *  the name this machine typed, and `loadResume` clamps whatever comes back. */
export function saveResume(store, entry, atMs) {
  const row = {
    token: String(entry.token || '').slice(0, 64),
    code: String(entry.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16),
    room: roomSlug(entry.room || ''),
    callsign: String(entry.callsign || '').trim().slice(0, 14) || 'Operative',
    atMs,
  };
  try { if (store) store.setItem(RESUME_KEY, JSON.stringify(row)); } catch { /* no storage, no resume */ }
  return row;
}

export function clearResume(store) {
  try {
    if (store && store.removeItem) store.removeItem(RESUME_KEY);
    else if (store) store.setItem(RESUME_KEY, '');
  } catch { /* fine */ }
}

/* ── the screen ───────────────────────────────────────────────────────────── */

export class LobbyScreen {
  /**
   * @param root         where the panel div is appended, exactly as Panels does
   * @param opts.net     the NetSession. The lobby never touches Game.
   * @param opts.site    the site document, for the operation list
   * @param opts.progression  for the operative's own profile line (§23: "profiles")
   * @param opts.now     wall clock, injected. See the header.
   * @param opts.storage localStorage-alike, injected for the same reason
   * @param opts.onDeploy called when the squad takes the card
   */
  constructor(root, { net, site = null, progression = null, now = null, storage = null, session = null, onDeploy, onClose } = {}) {
    this.net = net;
    this.site = site || { operations: [] };
    this.progression = progression;
    this.now = now || (() => 0);
    this.storage = storage !== null ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);
    /* The SESSION store, distinct from `storage` because the two hold different promises:
     * localStorage is "this machine remembers", sessionStorage is "this tab, this
     * sitting". The resume token lives in the second — see `loadResume` — and the getter
     * is guarded because a profile that blocks storage throws on the ACCESS, not on the
     * use. */
    this.session = session;
    if (this.session === null) {
      try { this.session = typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { this.session = null; }
    }
    this.onDeploy = onDeploy || (() => {});
    this.onClose = onClose || (() => {});

    this.node = el('div', 'cd-panel cd-lobby', root);
    this.node.style.display = 'none';
    this.open = null;
    this.tab = 'form';

    this.callsign = this._restoreCallsign();
    this.roomName = '';
    this.visibility = VISIBILITY.PRIVATE;
    this.joinField = '';
    this.recent = loadRecent(this.storage);
    /** roomKey -> 'checking' | 'answered' | 'no answer'. A FACT column; see the header. */
    this.probes = new Map();
    /** Rows the directory reported, and the sentence to print when there are none. */
    this.rooms = [];
    this.browseNote = null;
    this.browsing = false;
    /** One line, addressed to whoever just clicked. Never the squad feed. */
    this.notice = null;
    this.reason = DEFAULT_REASON;
    this.showLog = false;

    /** The seat this tab dropped out of, if any — the "Rejoin as …" offer. */
    this.resume = loadResume(this.session);
    /** True while the once-only callsign prompt is up. Set by `autoJoin` for a joiner who
     *  has never saved a name; cleared the moment any name is saved. */
    this.askName = false;
    /* Wired HERE, not in main.js: a WELCOME is the moment the host hands back a seat and
     * a token, and this screen is the one place with a storage to keep them. A dedicated
     * hook, because main.js reassigns onStatus/onRoster/onLobby after this constructor
     * runs and a piggyback on any of those would be silently clobbered. */
    this.net.onWelcome = () => this._storeResume();
  }

  get isOpen() { return this.open !== null; }

  /* ⚠ THE CALLSIGN IS CLAMPED ON THE WAY IN AND WAS NOT ON THE WAY OUT. `_saveCallsign`
   * trims to fourteen; this read whatever was under the key, which is not necessarily what
   * this game wrote — the origin is shared with every other project on the same
   * `<user>.github.io` — and then sent it over the wire and put it on the roster. */
  _restoreCallsign() {
    try {
      const raw = this.storage && this.storage.getItem(CALLSIGN_KEY);
      return (typeof raw === 'string' ? raw.replace(CONTROL_CHARS, ' ').trim().slice(0, 14) : '') || 'Operative';
    } catch { return 'Operative'; }
  }

  _saveCallsign(name) {
    this.callsign = String(name || '').trim().slice(0, 14) || 'Operative';
    try { if (this.storage) this.storage.setItem(CALLSIGN_KEY, this.callsign); } catch { /* fine */ }
    /* Saving a name — ANY name, including keeping the default — answers the once-only
     * question for good: `_hasSavedCallsign` reads the same key. */
    this.askName = false;
    /* Keep the rejoin label honest: a rename while seated updates the stored blob, still
     * with only THIS player's name in it. */
    if (this.resume && this.net.role === ROLE.CLIENT && this.net.token) this._storeResume();
    /* One call whichever role this machine is in — `NetSession.setCallsign` knows that a
     * client asks and a host decides, and the screen has no business knowing which. */
    this.net.setCallsign(this.callsign);
  }

  /** Has this machine EVER saved a callsign? The once-only prompt turns on this, so a
   *  player who chose to stay "Operative" is never asked twice. */
  _hasSavedCallsign() {
    try {
      const v = this.storage && this.storage.getItem(CALLSIGN_KEY);
      return typeof v === 'string' && v.trim().length > 0;
    } catch { return false; }
  }

  /** Write the seat this tab holds — token, room, OWN callsign — to sessionStorage. */
  _storeResume() {
    const net = this.net;
    if (net.role !== ROLE.CLIENT || !net.token || (!net.code && !net.roomName)) return;
    this.resume = saveResume(this.session, {
      token: net.token, code: net.code, room: net.roomName, callsign: this.callsign,
    }, this.now());
  }

  /**
   * Forget a resume the host has pronounced dead. Three verdicts count:
   *   · a KICK — the seat was taken away, and the block outlives the token;
   *   · a REFUSE on a hello that offered the token — blocked, or a session that no longer
   *     recognises it;
   *   · the broker reporting NOBODY holds the room id — the host's tab is gone, and the
   *     seat map (and every token in it) went with it.
   * A transient failure ("could not reach", a network error) is none of these and leaves
   * the blob alone: the seat may still be there when the wire comes back.
   */
  _sweepDeadResume() {
    if (!this.resume) return;
    const net = this.net;
    const jf = net.joinFailed;
    const dead = net.removedWhy || net.tokenRefused
      || (jf && /nobody is holding/i.test(jf.why || '')
        && (jf.target === this.resume.code || (this.resume.room && jf.target === this.resume.room)));
    if (dead) {
      clearResume(this.session);
      this.resume = null;
    }
  }

  /** @param op the operation card the base screen selected, or null */
  show(op = null, opts = {}) {
    this.open = 'lobby';
    /* Becoming the host is what CREATES the lobby's first seat, and the screen must not be
     * the thing that decides the role — it asks the session, which already knows.
     *
     * ⚠ UNLESS THEY ARRIVED ON AN INVITE LINK. A joiner who is made a host first opens an
     * empty room of their own for the moment before the join lands, and the playtest saw
     * the seam. A joiner is a joiner from the first frame. */
    if (!opts.joiner && this.net.role === ROLE.SOLO) this.net.host();
    if (op) this.net.selectOperation({ id: op.id, label: op.name || op.id, incident: op.incident || '' });
    this.net.lobby.setCallsign(this.net.localPlayerId, this.callsign);
    this.render();
  }

  hide() {
    if (!this.open) return;
    this.open = null;
    this.node.style.display = 'none';
    this.onClose();
  }

  /**
   * A friend arrived on an invite link (`?join=CODE` — see main.js's boot router). The
   * code goes into the field the way typing would put it there, and the join is sent once.
   * If the room is gone, the ordinary refusal path says so in the ordinary place — an
   * auto-join must fail exactly like a typed one, or the link teaches the wrong lesson.
   *
   * Two things ride along:
   *   · A RELOAD IS A RESUME. If this tab holds a token for the SAME room, it is offered
   *     with the hello and the host gives back the exact seat — kit, position, callsign.
   *     The invite link in the address bar is what makes this automatic: the reloaded URL
   *     still says `?join=CODE`, and the token in sessionStorage says which seat.
   *   · A FIRST-TIMER IS ASKED FOR A NAME, ONCE. A machine that has never saved a callsign
   *     is about to land on the roster as "Operative". The join is NOT stalled on the
   *     answer — they join with the default and the rename rides the host's existing
   *     validated LACT path the moment they type one. Asked once ever: any saved answer,
   *     including "stay Operative", is remembered.
   */
  autoJoin(code) {
    const typed = String(code || '').trim();
    this.joinField = typed;
    const r = this.resume;
    const resuming = !!(r && ((r.code && r.code === typed.toUpperCase())
      || (r.room && r.room === roomSlug(typed))));
    this.askName = !resuming && !this._hasSavedCallsign();
    this.render();
    this._join(typed, resuming ? { token: r.token } : {});
  }

  /** The link that IS the invite: this build, this incident, this scenario, this room.
   *  The incident and scenario ride along because the joiner's page builds its own world
   *  from ITS url before the first snapshot arrives — a joiner on the wrong floor is a
   *  version-skew bug wearing a convenience feature. */
  _inviteUrl() {
    const u = new URL(location.href);
    const keep = new URL(u.origin + u.pathname);
    for (const k of ['incident', 'scenario']) if (u.searchParams.get(k)) keep.searchParams.set(k, u.searchParams.get(k));
    keep.searchParams.set('join', this.net.code || '');
    return keep.toString();
  }

  /** Re-render in place. Wired to `net.onLobby`, `net.onStatus` and `net.onRoster`. */
  refresh() {
    /* Ungated on `open`: a KICK or a refused resume can land with the sheet closed, and a
     * dead token must be forgotten THEN — offering that seat again next boot would be the
     * screen promising what the host already refused. */
    this._sweepDeadResume();
    if (this.open) this.render();
  }

  /* ── rendering ─────────────────────────────────────────────────────────── */

  render() {
    const net = this.net;
    const lobby = net.lobby;

    /* ⚠ WHEN THE SQUAD DEPLOYS, THIS SCREEN IS OVER. The host's own deploy click closes
     * their copy; every OTHER seat's copy closed on nothing, so a joiner sat on "Waiting
     * for the host…" while the mission started behind the sheet. The lobby state already
     * says deployed — the screen just has to believe it. */
    if (this.open && lobby && lobby.phase === LOBBY_PHASE.DEPLOYED) { this.hide(); return; }

    const hosting = net.role === ROLE.HOST;
    const joined = net.role === ROLE.CLIENT;
    const ops = (this.site.operations || []).filter((o) => o.status !== 'locked');

    /**
     * ⚠ THE ROOM IS NOT OPEN YET, SO BOTH HALVES ARE.
     *
     * `show()` makes this machine a host, because a solo operation is a host with nobody
     * connected and the roster has to exist before anybody is on it. Branching the left
     * column on `role === HOST` therefore made the JOIN controls unreachable: every player
     * arrives here as a host of an empty room, so nobody could ever join one. The branch
     * belongs on whether a room has actually been OPENED — until then a player has not
     * said which of the two they are doing, and the screen must not decide for them.
     */
    /* A dead token must not be offered even when the render was reached directly. */
    this._sweepDeadResume();

    /* ⚠ A JOIN IN FLIGHT IS STILL THE JOINER'S SCREEN. `committed` reads `net.code`, and
     * `joinPeer` sets that optimistically — so the moment somebody clicked Join, the join
     * column vanished and the HOST panel appeared with the typed code rendered as if it
     * were their own room. On a dead room that state was permanent. The attempt now keeps
     * the join column up, and a failed attempt cleans `code` back off (see `joinPeer`). */
    const committed = !!(net.peer || net.code || net.roomName);
    const left = joined || net.joinAttempt ? this._joinBlock()
      : committed ? this._hostBlock(ops)
        : `${this._hostBlock(ops)}<h2 class="orjoin">or join somebody else's</h2>${this._joinBlock()}`;

    this.node.style.display = 'flex';
    this.node.innerHTML = `
      <div class="sheet">
        <header>
          <h1>Session lobby</h1>
          <p>${escapeHtml(this._subtitle())}</p>
        </header>
        <div class="body">
          <div class="cols">
            <section>${left}</section>
            <section>${this._roomBlock(lobby, hosting, joined)}</section>
          </div>
          ${hosting ? this._logBlock(lobby) : ''}
        </div>
        <footer>${this._footer(lobby, hosting, joined)}</footer>
      </div>`;
    this._wire(ops);
  }

  _subtitle() {
    const p = this.progression;
    const seats = this.net.lobby.size;
    const bits = [`${seats} of ${MAX_SQUAD} seats`];
    if (p && p.profile) {
      bits.push(`clearance ${p.clearance != null ? p.clearance : 0}`);
      bits.push(`${p.profile.operationsCompleted || 0} operations closed`);
    }
    return `Foundation regional response · ${bits.join(' · ')}`;
  }

  /* ── the host's half ───────────────────────────────────────────────────── */

  _hostBlock(ops) {
    const net = this.net;
    const opId = net.lobby.operation ? net.lobby.operation.id : '';
    const exposure = nameExposure(this.roomName);
    const EXPOSURE_WORDS = {
      none: 'A room with no name is reachable only by its five-character code.',
      guessable: 'Short names are guessed. Anybody who types this word reaches your squad.',
      shared: 'A word this common is shared with the whole broker. Expect strangers.',
      unlikely: 'Long enough, and with a digit in it, that a stranger is unlikely to type it.',
    };

    return `
      <h2>The operation</h2>
      <select class="wide" data-op>
        ${ops.map((o) => `<option value="${escapeHtml(o.id)}" ${o.id === opId ? 'selected' : ''}>${escapeHtml(o.name || o.id)}</option>`).join('')}
      </select>
      <p class="small">Changing the operation clears everybody's ready. A ready is a
         statement about a specific job.</p>

      <h2>How they find you</h2>
      <label class="lrow"><input type="radio" name="vis" value="${VISIBILITY.PRIVATE}" ${this.visibility === VISIBILITY.PRIVATE ? 'checked' : ''}>
        <span><b>Invite code</b> — five characters, read out or pasted. Nobody finds it who
        was not told it.</span></label>
      <label class="lrow"><input type="radio" name="vis" value="${VISIBILITY.NAMED}" ${this.visibility === VISIBILITY.NAMED ? 'checked' : ''}>
        <span><b>Room name</b> — a word your squad already agreed on. Both ends type it and
        neither has to read anything aloud.</span></label>
      <label class="lrow"><input type="radio" name="vis" value="${VISIBILITY.LISTED}" ${this.visibility === VISIBILITY.LISTED ? 'checked' : ''}>
        <span><b>Listed</b> — a room name, plus an entry on the shared list so a stranger
        can find you.</span></label>

      <div class="joiner">
        <input data-room placeholder="room name" maxlength="24" value="${escapeHtml(this.roomName)}"
          ${this.visibility === VISIBILITY.PRIVATE ? 'disabled' : ''}>
        <button data-open ${net.code || net.peer ? 'disabled' : ''}>Open the room</button>
      </div>
      <p class="small ${exposure === 'guessable' || exposure === 'shared' ? 'warn' : ''}">
        ${escapeHtml(EXPOSURE_WORDS[this.visibility === VISIBILITY.PRIVATE ? 'none' : exposure])}</p>
      ${net.code ? `<div class="code">${escapeHtml(net.code)}</div>` : ''}
      ${net.roomName ? `<div class="code">${escapeHtml(net.roomName)}</div>` : ''}
      ${net.code ? `
      <div class="joiner invite">
        <input data-invite readonly value="${escapeHtml(this._inviteUrl())}">
        <button data-copy>${this.copied ? 'Copied' : 'Copy invite link'}</button>
      </div>
      <p class="small">Send that link to a friend. It opens this build, puts the code in for
         them, and joins — one click from a chat message to a seat on this roster.</p>` : ''}

      ${this.visibility === VISIBILITY.LISTED ? `
        <p class="small caveat"><b>What the shared list actually is.</b> There is no server.
           One player's browser volunteers to hold the list; it disappears when they close
           the tab, and the next host to try starts an empty one. Every entry is a claim by
           whoever sent it — the label and the seat count are not checked by anybody. Your
           room's name, seat count and operation go on it. <b>No callsigns.</b></p>` : ''}`;
  }

  /* ── the joiner's half ─────────────────────────────────────────────────── */

  _joinBlock() {
    const net = this.net;
    const attempt = net.joinAttempt;
    const jf = net.joinFailed;

    /* The seat this tab dropped out of, offered FIRST — a reconnect is the most likely
     * reason anybody is back on this screen mid-evening, and hunting for the code they
     * already had is what ends playtests. */
    const r = this.resume;
    const rejoin = r && net.role !== ROLE.CLIENT && !attempt ? `
      <h2>Your held seat</h2>
      <div class="joiner">
        <button class="go" data-rejoin>Rejoin as ${escapeHtml(r.callsign)} — room ${escapeHtml(r.code || r.room)}</button>
        <button data-forget>Forget</button>
      </div>
      <p class="small">${this.now() - (r.atMs || 0) > CONFIG.net.seatHoldMs
    ? 'A dropped seat is held, but it has been a while — if the squad refilled it, you will come back to a fresh one.'
    : 'A radio that goes out keeps its seat. Rejoining puts you back where you dropped, kit and all.'}</p>` : '';

    /* ⚠ THE FAILURE, IN WORDS, WITH THE WAY OUT ON THE SAME SCREEN. Before this, a dead
     * room was a grey status line and a lobby with its join controls gone. */
    const failed = jf ? `
      <div class="deadroom">
        <p class="small warn"><b>Nobody is answering on ${escapeHtml(jf.target)}</b> — the
           room may be over. A room lives in its host's browser tab and ends with it.</p>
        <p class="small">Ask them for a fresh invite — or open a room of your own and send
           the invite the other way. Hosting controls are on this page${this.net.role === ROLE.CLIENT ? '' : ' above'},
           or use the shortcut:</p>
        <button data-hostnow>Open a room of your own</button>
      </div>` : '';

    return `
      ${rejoin}
      <h2>Join an operation</h2>
      <div class="joiner">
        <input data-join placeholder="code or room name" maxlength="24" value="${escapeHtml(this.joinField)}">
        <button data-dojoin ${attempt ? 'disabled' : ''}>${attempt ? 'Asking…' : 'Join'}</button>
      </div>
      ${attempt ? `<p class="small">Asking ${escapeHtml(attempt.target)} whether anybody is
         there. A room that never answers is called dead after ${Math.round(JOIN_TIMEOUT_MS / 1000)} seconds.</p>` : ''}
      ${failed}
      <p class="small">A five-character code is tried as a code. Anything else is tried as a
         room name.</p>

      <h2>Rooms you have been in</h2>
      ${this.recent.length ? `<ul class="rooms">${this.recent.map((r) => this._recentRow(r)).join('')}</ul>`
    : '<p class="small">Nothing yet. A room you join is remembered on this machine only.</p>'}
      <p class="small">This list is your own machine's memory. <b>It does not know whether
         anybody is there</b> — Check asks the room directly, which is the only answer that
         is worth anything.</p>

      <h2>The shared list</h2>
      <button data-browse ${this.browsing ? 'disabled' : ''}>${this.browsing ? 'Asking…' : 'Ask for the list'}</button>
      ${this.browseNote ? `<p class="small warn">${escapeHtml(this.browseNote)}</p>` : ''}
      ${this.rooms.length ? `<ul class="rooms">${this.rooms.map((r) => this._directoryRow(r)).join('')}</ul>` : ''}
      <p class="small caveat">Held in another player's browser, not on a server. Rows are
         what hosts said about themselves, and each one prints how long ago it said it.</p>`;
  }

  _roomKey(r) { return `${r.code || ''}|${r.room || ''}`; }

  _recentRow(r) {
    const key = this._roomKey(r);
    const probe = this.probes.get(key);
    return `<li>
      <b>${escapeHtml(r.room || r.code)}</b>
      <span class="lbl">${escapeHtml(r.label || 'operation not recorded')}</span>
      <span class="age">joined ${escapeHtml(ago(this.now() - (r.atMs || 0)))}</span>
      <span class="probe ${probe === 'answered' ? 'live' : probe ? 'dead' : ''}">${escapeHtml(probe || '')}</span>
      <button data-check="${escapeHtml(key)}">Check</button>
      <button data-goto="${escapeHtml(r.room || r.code)}">Join</button>
    </li>`;
  }

  _directoryRow(r) {
    const key = this._roomKey(r);
    const probe = this.probes.get(key);
    return `<li class="${r.stale ? 'stale' : ''}">
      <b>${escapeHtml(r.room || r.code)}</b>
      <span class="lbl">${escapeHtml(r.label || 'unnamed operation')}</span>
      <span class="age">${escapeHtml(r.seats)}/${escapeHtml(r.max)} · said so ${escapeHtml(ago(r.ageMs))}${r.stale ? ' — may be gone' : ''}</span>
      <span class="probe ${probe === 'answered' ? 'live' : probe ? 'dead' : ''}">${escapeHtml(probe || '')}</span>
      <button data-check="${escapeHtml(key)}">Check</button>
      <button data-goto="${escapeHtml(r.room || r.code)}">Join</button>
    </li>`;
  }

  /* ── the room ──────────────────────────────────────────────────────────── */

  _roomBlock(lobby, hosting, joined) {
    const meId = this.net.localPlayerId;
    const seats = [...lobby.seats.values()];
    const rows = seats.map((s) => {
      const you = s.seatId === meId;
      const cls = [s.connected ? '' : 'off', s.ready ? 'ready' : '', you ? 'you' : ''].filter(Boolean).join(' ');
      const state = !s.connected ? 'no radio' : s.ready ? 'ready' : 'not ready';
      return `<li class="${cls}">
        <b>${escapeHtml(s.callsign)}</b>
        <span class="seat">${escapeHtml(s.seatId)}${s.host ? ' · host' : ''}</span>
        <span class="state">${escapeHtml(state)}</span>
        ${hosting && !s.host ? `<button data-remove="${escapeHtml(s.seatId)}">Remove</button>` : ''}
      </li>`;
    }).join('');

    const removals = hosting ? lobby.removals() : [];

    /* The once-only name prompt, INLINE and never a modal: the auto-join is already on
     * its way and nothing here stalls it. Answering renames the seat in place through the
     * host's validated LACT path; declining saves the default so the question is never
     * asked again. */
    const namePrompt = this.askName ? `
      <div class="namep">
        <h2>What do you go by on the radio?</h2>
        <div class="joiner">
          <input data-firstname maxlength="14" placeholder="callsign">
          <button class="go" data-firstnamego>Use it</button>
          <button data-firstnameskip>Stay ${escapeHtml(this.callsign)}</button>
        </div>
        <p class="small">You are on the roster as ${escapeHtml(this.callsign)} until you
           pick one. Asked once; the answer is remembered on this machine only.</p>
      </div>` : '';

    return `
      ${namePrompt}
      <h2>Your callsign</h2>
      <p class="small">Called <input data-name value="${escapeHtml(this.callsign)}" maxlength="14" class="inline">
         on the radio. It is remembered on this machine and travels no further than the squad.</p>

      <h2>On the roster</h2>
      <ul class="roster seats">${rows || '<li class="small">Nobody yet.</li>'}</ul>
      <p class="small status">${escapeHtml(this.net.status)}</p>
      ${this.notice ? `<p class="small warn">${escapeHtml(this.notice)}</p>` : ''}
      ${this.net.removedWhy ? `<p class="small warn"><b>You were removed from this session.</b> ${escapeHtml(this.net.removedWhy)}.</p>` : ''}

      <h2>Ready</h2>
      <button class="wide ${this._meReady() ? 'go' : ''}" data-ready>
        ${this._meReady() ? 'Stand down from ready' : 'Report ready'}</button>
      <p class="small">The squad deploys when every operative still on the radio has said
         ready. A seat that loses its radio loses its ready with it.</p>

      ${hosting ? `
        <h2>Removing a seat</h2>
        <select data-reason>
          ${Object.entries(REMOVAL_REASONS).map(([id, text]) =>
    `<option value="${escapeHtml(id)}" ${id === this.reason ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}
        </select>
        <p class="small">A removal takes effect on this machine, which runs the mission, so
           there is nothing the removed operative's copy can do about it. Their kit goes
           back to the vehicle and anything they had custody of is put down where they
           stood — recoverable by anybody. Nothing is destroyed.</p>
        ${removals.length ? `
          <h2>Removed this session</h2>
          <ul class="rooms">${removals.map((r) => `<li>
            <b>${escapeHtml(r.callsign || r.seatId)}</b>
            <span class="lbl">${escapeHtml(REMOVAL_REASONS[r.reason] || '')}</span>
            <button data-readmit="${escapeHtml(r.token)}">Readmit</button></li>`).join('')}</ul>
          <p class="small"><b>Readmitting is not a rewind.</b> It lifts the block; they still
             have to reconnect, they come back to a fresh seat, and the kit that went back to
             the vehicle stays there. The removal stays on the record.</p>` : ''}
        <p class="small caveat">A block lasts for this session and is keyed to the token this
           host issued, so somebody who reloads can come back. Saying otherwise would be
           promising you a ban this build cannot enforce.</p>` : ''}

      ${joined ? `<p class="small">The host runs the mission. Joining stays open until the
         squad commits to a procedure.</p>` : ''}`;
  }

  _meReady() {
    const s = this.net.lobby.seatOf(this.net.localPlayerId);
    return !!(s && s.ready);
  }

  /* ── the action log ────────────────────────────────────────────────────── */

  _logBlock(lobby) {
    const entries = lobby.recent(30);
    return `<div class="pad logblock">
      <h2>Action record <button class="ghost" data-togglelog>${this.showLog ? 'hide' : 'show'}</button></h2>
      ${this.showLog ? `
        <ul class="log">
          ${entries.length ? entries.map((e) => `<li>
            <span class="n">#${e.n}</span>
            <b>${escapeHtml(e.callsign || e.seatId || '—')}</b>
            <span>${escapeHtml(LOG_WORDS[e.kind] || e.kind)}${e.detail ? ` (${escapeHtml(e.detail)})` : ''}</span>
          </li>`).join('') : '<li class="small">Nothing yet.</li>'}
        </ul>
        ${lobby.logDropped ? `<p class="small">${lobby.logDropped} older entries have rolled off.</p>` : ''}
        <p class="small caveat">This is a <b>moderation</b> record, not analytics. It exists
           on this machine, in memory, for as long as this tab is open. It is never sent to
           any other player, never written to disk, and never put on the event log the game
           collects — that one carries seat numbers and no names, because §21.2 says so.</p>`
    : '<p class="small">Who joined, who left, who was removed. Kept on this machine only.</p>'}
    </div>`;
  }

  /* ── the footer ────────────────────────────────────────────────────────── */

  _footer(lobby, hosting, joined) {
    const ready = lobby.squadReady;
    if (hosting) {
      return `<span class="waiting">${escapeHtml(ready
        ? 'Everybody on the radio has said ready.'
        : `Waiting on ${this._waitingOn(lobby)}.`)}</span>
        <button class="go" data-deploy ${ready ? '' : 'disabled'}>Take the operation</button>`;
    }
    if (joined) {
      return `<span class="waiting">${escapeHtml(ready
        ? 'Waiting for the host to take the operation…'
        : `Waiting on ${this._waitingOn(lobby)}.`)}</span>`;
    }
    return '<span class="waiting">Open a room, or join one.</span>';
  }

  _waitingOn(lobby) {
    const not = [...lobby.seats.values()].filter((s) => s.connected && !s.ready);
    if (!lobby.operation) return 'an operation to be chosen';
    if (!not.length) return 'a seat that is on the roster but off the radio';
    if (not.length === 1) return not[0].callsign;
    return `${not.length} operatives`;
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */

  _wire(ops) {
    const q = (s) => this.node.querySelector(s);
    const all = (s) => [...this.node.querySelectorAll(s)];
    const net = this.net;

    const nameField = q('[data-name]');
    if (nameField) nameField.onchange = () => { this._saveCallsign(nameField.value); this.render(); };

    const opSel = q('[data-op]');
    if (opSel) {
      opSel.onchange = () => {
        const op = ops.find((o) => o.id === opSel.value);
        if (op) net.selectOperation({ id: op.id, label: op.name || op.id, incident: op.incident || '' });
        this.render();
      };
    }

    all('input[name="vis"]').forEach((r) => {
      r.onchange = () => { this.visibility = r.value; this.render(); };
    });

    const roomField = q('[data-room]');
    if (roomField) roomField.oninput = () => { this.roomName = roomSlug(roomField.value); };

    const copyBtn = q('[data-copy]');
    if (copyBtn) {
      copyBtn.onclick = () => {
        const field = q('[data-invite]');
        const done = () => { this.copied = true; this.render(); setTimeout(() => { this.copied = false; this.refresh(); }, 1800); };
        /* Clipboard first; select-the-field when the browser refuses. A copy button that
         * can fail silently is worse than no button, because the paste that follows is an
         * old clipboard. */
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(field.value).then(done, () => { field.select(); });
        } else { field.select(); }
      };
    }

    const openBtn = q('[data-open]');
    if (openBtn) {
      openBtn.onclick = () => {
        if (this.visibility !== VISIBILITY.PRIVATE && !this.roomName) {
          this.notice = 'That room name has nothing in it once punctuation is taken out.';
          this.render();
          return;
        }
        net.hostPeer({ roomName: this.visibility === VISIBILITY.PRIVATE ? '' : this.roomName, visibility: this.visibility });
        this.render();
      };
    }

    const joinField = q('[data-join]');
    if (joinField) joinField.oninput = () => { this.joinField = joinField.value; };
    const joinBtn = q('[data-dojoin]');
    if (joinBtn) joinBtn.onclick = () => this._join(this.joinField);

    /* The held seat. Rejoining offers the stored token down the ordinary join path, so it
     * fails (and succeeds) exactly like a typed join. */
    const rejoinBtn = q('[data-rejoin]');
    if (rejoinBtn) {
      rejoinBtn.onclick = () => {
        const r = this.resume;
        if (r) this._join(r.code || r.room, { token: r.token });
      };
    }
    const forgetBtn = q('[data-forget]');
    if (forgetBtn) {
      forgetBtn.onclick = () => {
        clearResume(this.session);
        this.resume = null;
        this.render();
      };
    }

    /* The way out of a dead room: one click into hosting a fresh private one. */
    const hostNow = q('[data-hostnow]');
    if (hostNow) {
      hostNow.onclick = () => {
        this.net.joinFailed = null;
        this.net.hostPeer({});
        this.render();
      };
    }

    /* The once-only name prompt. Every exit saves, and saving is what stops the asking. */
    const firstName = q('[data-firstname]');
    const takeFirstName = () => {
      this._saveCallsign(firstName && firstName.value ? firstName.value : this.callsign);
      this.render();
    };
    const firstGo = q('[data-firstnamego]');
    if (firstGo) firstGo.onclick = takeFirstName;
    if (firstName) firstName.onkeydown = (e) => { if (e.key === 'Enter') takeFirstName(); };
    const firstSkip = q('[data-firstnameskip]');
    if (firstSkip) {
      firstSkip.onclick = () => {
        this._saveCallsign(this.callsign);
        this.render();
      };
    }

    all('[data-goto]').forEach((b) => { b.onclick = () => this._join(b.dataset.goto); });
    all('[data-check]').forEach((b) => { b.onclick = () => this._check(b.dataset.check); });

    const browseBtn = q('[data-browse]');
    if (browseBtn) {
      browseBtn.onclick = () => {
        this.browsing = true; this.browseNote = null; this.render();
        net.browse((rows, note) => {
          this.browsing = false;
          this.rooms = rows || [];
          this.browseNote = note || (rows && rows.length ? null : 'The list is there and it is empty.');
          this.refresh();
        });
      };
    }

    const readyBtn = q('[data-ready]');
    if (readyBtn) {
      readyBtn.onclick = () => {
        /* ⚠ ASK, NEVER ASSERT. A client that flipped its own ready would be right until the
         * next lobby broadcast replaced the seat map and flipped it back. See `applyLobby`. */
        net.setReady(net.localPlayerId, !this._meReady());
        this.render();
      };
    }

    const reasonSel = q('[data-reason]');
    if (reasonSel) reasonSel.onchange = () => { this.reason = reasonSel.value; };

    all('[data-remove]').forEach((b) => {
      b.onclick = () => {
        const rec = net.removeSeat(b.dataset.remove, this.reason);
        this.notice = rec
          ? `${rec.callsign} removed. Their kit is at the vehicle; anything they had custody of is on the floor where they stood.`
          : 'That seat is not one this host can remove.';
        this.render();
      };
    });

    all('[data-readmit]').forEach((b) => {
      b.onclick = () => {
        const rec = net.readmitSeat(b.dataset.readmit);
        this.notice = rec
          ? `${rec.callsign} may rejoin. They still have to reconnect, and they come back to an empty seat.`
          : 'That block has already been lifted.';
        this.render();
      };
    });

    const logBtn = q('[data-togglelog]');
    if (logBtn) logBtn.onclick = () => { this.showLog = !this.showLog; this.render(); };

    const dep = q('[data-deploy]');
    if (dep) {
      dep.onclick = () => {
        net.deployLobby();
        this._remember();
        this.open = null;
        this.node.style.display = 'none';
        this.onDeploy(net.lobby.operation);
      };
    }
  }

  _join(text, opts = {}) {
    const typed = String(text || '').trim();
    if (!typed) { this.notice = 'Type a code or a room name first.'; this.render(); return; }
    this.net.joinPeer(typed, this.callsign, { token: opts.token || null });
    this.joinField = typed;
    /* The failure the broker never reports: a registered host that will not answer. The
     * wall clock lives on this screen (see the header), so the deadline does too. The
     * attempt object's IDENTITY is the guard — if this attempt already ended, or a second
     * one started, the timer finds a different object and does nothing. */
    const stamp = this.net.joinAttempt;
    if (stamp) {
      setTimeout(() => {
        if (this.net.joinAttempt === stamp
          && this.net.abandonJoin(`nobody answered on ${typed.toUpperCase()}`)) this.refresh();
      }, JOIN_TIMEOUT_MS);
    }
    this.render();
  }

  /**
   * The only honest liveness test the broker offers: connect, and see whether anybody is
   * home. It costs the host one refused data channel and it answers a question no list
   * can — which is why both lists have this button and neither claims to know.
   */
  _check(key) {
    const [code, room] = String(key || '').split('|');
    const target = room || code;
    if (!target) return;
    this.probes.set(key, 'checking');
    this.refresh();
    this.net.probeRoom(target, (live) => {
      this.probes.set(key, live ? 'answered' : 'no answer');
      this.refresh();
    });
  }

  _remember() {
    const l = this.net.lobby;
    if (!l.code && !l.roomName) return;
    this.recent = rememberRoom(this.storage, {
      code: l.code, room: l.roomName, label: l.operation ? l.operation.label : '',
    }, this.now());
  }
}
