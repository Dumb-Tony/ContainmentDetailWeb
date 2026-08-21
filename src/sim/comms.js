/* Squad communication — GDD §11.3. §19.2 is the reason it looks like this.
 *
 * §11.3 asks for four channels: proximity voice, radio voice, a contextual ping wheel with
 * "danger, evidence, objective, move, watch, and help", and a quick phrase wheel. Voice is
 * the obvious one to build first and it is the wrong one. §19.2 states plainly that no
 * required rule may depend on microphone use or on stereo hearing, and a squad whose only
 * working channel is speech has already broken that — not as a setting, as a fact about
 * how the operation runs. So the PRIMARY channel is this one, and voice, when it lands, is
 * the layer on top of it. A player with no microphone, no voice, or no hearing runs an
 * entire operation through the wheel.
 *
 * It is also just better. The three things this game's loop actually forces a squad to say
 * — *the mass is over there*, *the post goes here*, *keep that lane in view* — are all
 * statements about a PLACE, and a marker on the floor beats "over there, no, the OTHER
 * one" even for five people on headsets.
 *
 * ── THE SAME RULE AS senses.js, FOR THE SAME REASON ──────────────────────────
 *
 * **The vocabulary is content; the engine dispatches on FIELDS, never on an id.** There is
 * no `if (phrase === 'help')` in this file or in ui/commswheel.js, and there must not be
 * one downstream either. A phrase entry names a kind, an anchor, a lifetime and whether it
 * supersedes its owner's previous copy; every rule below reads those four and nothing else.
 * That is what lets a second incident add "the door is jammed" without touching the ping
 * board, the wire format or the wheel — and it is what stops the phrase list turning into
 * a switch statement the way the anomaly triggers did before senses.js existed.
 *
 * `commsProblems()` is the validator. Like content.js it REFUSES rather than warns: a
 * phrase with no caption line is a phrase that does not exist for a player with the sound
 * off, and shipping one is exactly the §19.2 failure this file was written to prevent.
 *
 * NO DOM, NO RENDERER, NO CLOCK. Time comes in as `atMs`/`nowMs` — simulation time, the
 * same discipline as audio.js's CaptionChannel — so a ping does not expire while the game
 * is paused and the whole model is drivable headless.
 */

import { dist } from './geometry.js';
import { sees } from './perception.js';
import { t as msg } from '../core/i18n.js';

/* ── the six kinds (GDD §11.3, verbatim) ──────────────────────────────────────
 *
 * §11.3 names six and this table is those six. A kind is the ROLE a call plays, and it is
 * the only thing presentation is allowed to switch on — which is what keeps the wheel from
 * growing a branch per phrase.
 *
 * ⚠ THE GLYPH LIVES HERE, NEXT TO THE KIND, AND NOT IN THE UI. §18.5 ends "these
 * treatments must function without colour" and §19.2 forbids a required rule depending on
 * fine colour discrimination. A ping marker twenty metres across a dark floor has exactly
 * two channels — colour and silhouette — so the silhouette is not decoration and it is not
 * optional. Keeping it beside the kind means a new kind cannot ship without one, the same
 * trick audio.js uses to keep CUES and CAPTIONS from drifting apart.
 *
 * The six differ in OUTLINE, not in fill: triangle, ringed dot, star, arrow, diamond,
 * cross. §18.5's own standard — "a filled circle and a filled square are one bad monitor
 * away from being the same mark".
 *
 * ⚠ THE GLYPH IS NOT A MESSAGE AND THE LABEL IS. A silhouette is not language — ▼ means the
 * same thing to every player and a "translated" triangle is a worse triangle — so the glyph
 * stays here beside the kind. The label is a getter onto `comms.kind.<id>`, because the KEY
 * of this table is the id: it is compared against, it names a CSS class, and it is what a
 * phrase declares. The id stays the id; the word beside it comes from the table.
 */
export const PING_KINDS = Object.freeze({
  danger: { glyph: '▼', get label() { return msg('comms.kind.danger'); } },
  evidence: { glyph: '◉', get label() { return msg('comms.kind.evidence'); } },
  objective: { glyph: '★', get label() { return msg('comms.kind.objective'); } },
  move: { glyph: '➤', get label() { return msg('comms.kind.move'); } },
  watch: { glyph: '◇', get label() { return msg('comms.kind.watch'); } },
  help: { glyph: '✚', get label() { return msg('comms.kind.help'); } },
});

/* ── where a call lives ───────────────────────────────────────────────────────
 *
 * The second closed vocabulary, and the one that carries the actual mechanics. Three
 * answers to "what place is this call about", and every rule in the file dispatches on
 * these fields rather than on the anchor's name:
 *
 *   placed     does it put a marker in the world at all
 *   fromCaller is that marker the caller's own body
 *   follows    does it move when they do — a `help` call from an operative who is being
 *              dragged clear must track them, or the rescue party runs to a corpse-shaped
 *              hole in the floor where they used to be
 *   needsSight must the caller be able to SEE the place. Only a free point needs this;
 *              you can always see yourself, and a call with no place has nothing to check.
 *              This is §20.9's "validate distance, line of sight" and it is the whole of
 *              the anti-spoof story for placement.
 */
export const ANCHORS = Object.freeze({
  point: { placed: true, fromCaller: false, follows: false, needsSight: true },
  caller: { placed: true, fromCaller: true, follows: true, needsSight: false },
  none: { placed: false, fromCaller: false, follows: false, needsSight: false },
});

/* ── the phrases ──────────────────────────────────────────────────────────────
 *
 * Ten, and every one of them is something this game's loop MAKES a squad say. There are no
 * greetings, no acknowledgements and no jokes on this wheel: an emote is a thing you send
 * because you have a wheel, and a callout is a thing you send because the operation is
 * about to go wrong without it. The grounding for each is on its own line, and a phrase
 * that cannot be given one does not belong here.
 *
 * AUTHORING ORDER IS WHEEL ORDER. The wheel lays out `Object.keys(PHRASES)` clockwise from
 * twelve, so moving an entry in this file moves it under the player's thumb. Related calls
 * sit next to each other on purpose — the two danger calls are adjacent, the three
 * placement calls are adjacent — because a radial menu is learned as a direction long
 * before it is read as a word.
 *
 *   unique  a newer one from the same operative REPLACES their older one. True where the
 *           call is about a single moving fact (where it is, where I am, am I ready) and
 *           false where a squad legitimately wants several at once — a fence has four
 *           posts and two lanes need two watchers.
 *   lifeMs  how long the call stays true. Not a display convenience: a marker that outlives
 *           the fact it describes is worse than no marker, because the squad will act on
 *           it. `contact` is the short one for exactly that reason.
 */
export const PHRASES = Object.freeze({
  /* The imager is one narrow view (§10.2) held by one operative, and the mass reads at
   * ambient to everyone else. Whoever has the imager is the only person on the floor who
   * knows where the thing is, and §11.2's "split information" is only a design and not a
   * cruelty if there is a way to say it. Six seconds because it walks: a nine-second-old
   * contact marker is pointing at a place it has left. */
  contact: { kind: 'danger', anchor: 'point', unique: true, lifeMs: 6000 },

  /* The veto. §8.4 — containment integrity is lost by one operative throwing the wrong
   * circuit, closing the door the lure comes through, or lifting a case that has not held
   * its thirty seconds. The stop call has to arrive faster than the mistake, so it is a
   * hold key and a flick and not a sentence anybody types. */
  hold: { kind: 'danger', anchor: 'point', unique: true, lifeMs: 8000 },

  /* §7.1: a source needs the right instrument, and `requiresEquipment` means the operative
   * who finds it is routinely not the one who can log it. Ninety seconds because that is
   * how long it takes to walk back to the cargo point and return with the imager. */
  evidence: { kind: 'evidence', anchor: 'point', unique: false, lifeMs: 90000 },

  /* The one the whole containment turns on. A fence is four placements and a metre is the
   * difference between a closed lane and an open one (§8.3, the `contain` verb). Not
   * unique: four posts, four markers. A minute is the walk to cargo and back. */
  'set-up-here': { kind: 'objective', anchor: 'point', unique: false, lifeMs: 60000 },

  /* §9.2 — five slots and two hands, and the cargo cache is one point on the floor.
   * "I have run out of tripods and I am holding the lane" is a different message from
   * "put one here", and a squad that cannot tell them apart sends nobody. */
  'bring-kit': { kind: 'objective', anchor: 'point', unique: false, lifeMs: 60000 },

  /* §11.2 assigns tasks; §18.4's planner assigns positions. Without a claim call, two
   * operatives fetch the same heater and nobody watches the east lane. Unique because a
   * claim you have made twice is not a claim. */
  'on-it': { kind: 'objective', anchor: 'point', unique: true, lifeMs: 30000 },

  /* §11.2's "time-sensitive call-and-response sequences", which is the phase this build
   * actually reaches: the operative kneeling at the case cannot see whether the fence is
   * lit, and the operative at the switch cannot see the case. Ten seconds, because "in
   * position" stops being true the moment you move. */
  ready: { kind: 'move', anchor: 'none', unique: true, lifeMs: 10000 },

  /* Regroup, and the only call that is about a person rather than a place — so it tracks
   * them. §11.2's two-person medical and cargo actions are proximity checks
   * (`assistReachM`), and "come to me" is how a proximity check gets satisfied. */
  'on-me': { kind: 'move', anchor: 'caller', unique: true, lifeMs: 12000 },

  /* perception.js is the second measurable quantity in the game and the reason a second
   * anomaly can be a different procedure: `unobserved-for` releases what coverage holds.
   * Coverage is a JOB, jobs have to be assignable, and two lanes need two watchers — so
   * not unique, and long, because it is a standing order for the length of a procedure. */
  'watch-this': { kind: 'watch', anchor: 'point', unique: false, lifeMs: 120000 },

  /* §9.5: down is not dead, and there are ninety seconds. This is the call you make BEFORE
   * you go down — and the one call a downed operative may still make, which is what
   * `whileDowned` is for. Thirty seconds is the width of the floor at a run; ninety would
   * leave the marker up long after the rescue and teach the squad to ignore it. */
  help: { kind: 'help', anchor: 'caller', unique: true, lifeMs: 30000, whileDowned: true },
});

/* ── captions (GDD §17.3, §19.1, §19.2) ───────────────────────────────────────
 *
 * A parallel table keyed by phrase id, exactly the shape audio.js's CAPTIONS uses, so
 * `formatCaption` renders these without knowing they are not sounds and
 * `missingCommsCaptions()` below is the same one-line drift check as `missingCaptions()`.
 *
 * `kind: 'speech'` on every row, because that is what these are: somebody said something.
 * audio.js's formatter already renders a speech row as `Vasquez: "on me" — to your left`,
 * attribution and bearing included; it has simply had nothing to attribute until now.
 *
 * `directional` marks the rows where WHERE it came from is part of the information, which
 * here means every row that puts a marker anywhere. §19.2 forbids a required rule from
 * depending on stereo hearing, so the bearing is a WORD — and `commsProblems()` refuses a
 * table where the two disagree.
 *
 * `priority` follows audio.js's scale: 3 is "read this or lose the operation", 1 is
 * useful. The feed drops the lowest priority first when it is over-full, so a squad
 * cataloguing frost samples cannot bury a contact call.
 *
 * ⚠ THIS TEXT IS ALSO THE WHEEL LABEL. One string, so what the player picks and what the
 * squad reads are the same sentence — a wheel that says "danger" and sends "it is here"
 * is a small lie that costs a callout the first time somebody notices.
 *
 * ⚠ AND `text` IS A GETTER, WHILE THE KEY OF THE ROW IS THE PHRASE ID. The id travels over
 * the wire (net/protocol.js), is compared against here, and keys both tables; the WORDS are
 * `comms.phrase.<id>` in content/locales. A getter rather than a call at every use site
 * because this row is `formatCaption`'s shape and audio.js's formatter reads `.text` — one
 * accessor, so a caption a squad hears and a wedge a player picks cannot come back in two
 * different languages.
 *
 * A MISSING MESSAGE RESOLVES TO ITS OWN KEY rather than to an empty string (core/i18n.js
 * says why), so `!cap.text` can no longer see one. `commsProblems()` therefore refuses a
 * caption whose text IS a bare message key as well as one that has none.
 */
/**
 * ⚠ AND IT IS DEFINED WITH `defineProperty`, NOT SPREAD INTO A LITERAL. `{ ...row }` copies
 * a getter's VALUE at the moment it spreads, which is module load — so the table would have
 * frozen the English text at boot and gone on printing it under every other locale, with
 * nothing failing. The accessor has to survive into the frozen object.
 */
const withText = (id, row) => Object.freeze(Object.defineProperty({ ...row }, 'text', {
  get: () => msg(`comms.phrase.${id}`), enumerable: true,
}));
export const COMMS_CAPTIONS = Object.freeze({
  contact: withText('contact', { kind: 'speech', priority: 3, directional: true }),
  hold: withText('hold', { kind: 'speech', priority: 3, directional: true }),
  evidence: withText('evidence', { kind: 'speech', priority: 1, directional: true }),
  'set-up-here': withText('set-up-here', { kind: 'speech', priority: 2, directional: true }),
  'bring-kit': withText('bring-kit', { kind: 'speech', priority: 1, directional: true }),
  'on-it': withText('on-it', { kind: 'speech', priority: 1, directional: true }),
  ready: withText('ready', { kind: 'speech', priority: 2, directional: false }),
  'on-me': withText('on-me', { kind: 'speech', priority: 2, directional: true }),
  'watch-this': withText('watch-this', { kind: 'speech', priority: 2, directional: true }),
  help: withText('help', { kind: 'speech', priority: 3, directional: true }),
});

/* ── how far a call reaches ───────────────────────────────────────────────────
 *
 * §20.9: "validate distance, line of sight". Thirty metres is longer than the cold store's
 * longest aisle, so a marker never fails for a reason the player cannot see, and short
 * enough that nobody marks a room they have not entered.
 *
 * ⚠ THE CONE IS WIDE ON PURPOSE. A ping is aimed at the crosshair, so the cone is not the
 * gameplay constraint — range and line of sight are. What it is for is refusing a client
 * that claims a point behind its own back, and it has to stay loose enough to survive
 * §8.2's "fair under latency": the request arrives a frame or two after the aim it was
 * made with, and a tight cone would refuse honest calls made while turning.
 */
export const MARK_RANGE_M = 30;
export const MARK_CONE_RAD = 1.2;

/* ── validator ────────────────────────────────────────────────────────────────
 * Structure and referential integrity, in content.js's sense: it refuses a dangling
 * reference and an unshippable combination, and has no opinion about taste. */

/** @returns {string[]} problems. Empty means the tables are shippable. */
export function commsProblems(phrases = PHRASES, captions = COMMS_CAPTIONS) {
  const p = [];
  for (const [id, ph] of Object.entries(phrases)) {
    if (!PING_KINDS[ph.kind]) {
      p.push(`phrase ${id}: kind "${ph.kind}" is not one of ${Object.keys(PING_KINDS).join(', ')}`);
    }
    const anchor = ANCHORS[ph.anchor];
    if (!anchor) {
      p.push(`phrase ${id}: anchor "${ph.anchor}" is not one of ${Object.keys(ANCHORS).join(', ')}`);
    } else if (!anchor.placed && !ph.unique) {
      /* A call with no place of its own is a STATE, not a marker, and an operative cannot
       * be in two states. Two live copies of "in position" would mean the squad had to
       * guess which one was current. */
      p.push(`phrase ${id}: anchor "${ph.anchor}" has no place of its own, so it must be unique`);
    } else if (anchor.fromCaller && !ph.unique) {
      p.push(`phrase ${id}: anchored to the caller, who cannot be in two places, so it must be unique`);
    }
    if (!(ph.lifeMs > 0)) p.push(`phrase ${id}: lifeMs must be a positive number, got ${ph.lifeMs}`);
    if (typeof ph.unique !== 'boolean') p.push(`phrase ${id}: unique must be true or false`);

    const cap = captions[id];
    if (!cap) {
      p.push(`phrase ${id}: no caption line. §19.2 — a phrase a player with the sound off cannot read does not exist for them`);
      continue;
    }
    if (!cap.text) p.push(`phrase ${id}: caption has no text`);
    /* ⚠ A KEY THAT RESOLVES TO ITSELF IS NOT TEXT. `t()` returns the key when the message
     * table has no line for it, loudly and on purpose, so a phrase added without a message
     * would sail past the emptiness check above and put `comms.phrase.door-jammed` on five
     * people's screens. */
    else if (/^comms\.phrase\./.test(cap.text)) p.push(`phrase ${id}: caption text is an unresolved message key (${cap.text})`);
    if (cap.kind !== 'speech') p.push(`phrase ${id}: caption kind must be "speech" — somebody said this`);
    if (![1, 2, 3].includes(cap.priority)) p.push(`phrase ${id}: caption priority must be 1, 2 or 3, got ${cap.priority}`);
    if (anchor && !!cap.directional !== anchor.placed) {
      /* Either the bearing is information and there is a place to take it from, or there is
       * neither. A directional caption with nowhere to point prints a bearing to the
       * origin, which is a lie in compass form. */
      p.push(`phrase ${id}: caption.directional is ${!!cap.directional} but anchor "${ph.anchor}" is ${anchor.placed ? '' : 'not '}placed`);
    }
  }
  for (const id of Object.keys(captions)) {
    if (!phrases[id]) p.push(`caption ${id} has no phrase — the wheel would never send it`);
  }
  return p;
}

/** Every phrase with no caption line. The one-liner a suite asks, as audio.js does. */
export function missingCommsCaptions(phrases = PHRASES, captions = COMMS_CAPTIONS) {
  return Object.keys(phrases).filter((k) => !captions[k]);
}

export function isPhrase(id) { return Object.prototype.hasOwnProperty.call(PHRASES, id); }
export function phraseOf(ping) { return ping ? PHRASES[ping.phrase] || null : null; }
export function kindOf(ping) { const ph = phraseOf(ping); return ph ? PING_KINDS[ph.kind] : null; }
export function captionOf(ping) { return ping ? COMMS_CAPTIONS[ping.phrase] || null : null; }
export function expiresAt(ping) { const ph = phraseOf(ping); return ph ? ping.atMs + ph.lifeMs : ping.atMs; }

/** 0 at the moment it was called, 1 at the moment it dies. The UI's age ring reads this. */
export function ageFraction(ping, nowMs) {
  const ph = phraseOf(ping);
  if (!ph) return 1;
  return Math.max(0, Math.min(1, (nowMs - ping.atMs) / ph.lifeMs));
}

/* ── bearings ─────────────────────────────────────────────────────────────────
 *
 * §19.2 forbids a required rule depending on stereo hearing, and the build synthesises in
 * mono anyway, so direction is a WORD. These are the four words audio.js's DIRECTION_WORDS
 * already renders ('above'/'below' exist there too; the simulation is planar and never
 * produces them).
 *
 * ⚠ THE FORWARD CONVENTION IS (-sin yaw, -cos yaw), and it is the game's, taken from
 * perception.js `sees` — which records the same warning, because deriving it independently
 * puts every bearing in the file a quarter turn out and nothing else fails.
 */
export function bearingWord(viewer, x, z) {
  if (!viewer) return null;
  const dx = x - viewer.x, dz = z - viewer.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 0.5) return null;                     // standing on it; a bearing would be noise
  const fx = -Math.sin(viewer.yaw), fz = -Math.cos(viewer.yaw);
  const nx = dx / d, nz = dz / d;
  const forward = fx * nx + fz * nz;
  if (forward > 0.5) return 'ahead';
  if (forward < -0.5) return 'behind';
  /* Right is forward turned a quarter clockwise: (-fz, fx). At yaw 0 that is +X, which is
   * screen-right for a camera looking down -Z. */
  return (-fz * nx + fx * nz) > 0 ? 'right' : 'left';
}

/** Can this operative mark that spot? §20.9's distance and line-of-sight test, in one
 *  place so the host, the wheel's pre-check and the suite all ask the same question. */
export function canMark(caller, x, z, blockers = []) {
  if (!caller) return false;
  if (dist(caller.x, caller.z, x, z) > MARK_RANGE_M) return false;
  return sees({ x: caller.x, z: caller.z, yaw: caller.yaw, fovRad: MARK_CONE_RAD, rangeM: MARK_RANGE_M },
    x, z, blockers);
}

/* ── the board ────────────────────────────────────────────────────────────────
 *
 * Host state. Every rule that decides whether a call exists lives in `add`, because `add`
 * is the only door into the list — a second entry point is how a rate limit stops being a
 * rate limit.
 */
export class PingBoard {
  /**
   * @param {object} opts
   *   maxPerPlayer  live calls one operative may have up at once (GDD §11.7, §20.9).
   *   minGapMs      the rate limit. §20.9: "rate-limit interaction and chat events".
   */
  constructor({ maxPerPlayer = 3, minGapMs = 700 } = {}) {
    this.maxPerPlayer = maxPerPlayer;
    this.minGapMs = minGapMs;
    /** Oldest first. Small enough (5 operatives × 3) that nothing here needs an index. */
    this.list = [];
    this._seq = 0;
    this._lastAt = new Map();   // ownerId -> the simTimeMs of their last accepted call
  }

  /**
   * Put a call on the board. THE ONLY WAY IN.
   *
   * @param {string} ownerId  the operative, as decided by the caller. On the host this is
   *   the SEAT the message arrived on and never a field of the message — see the wiring
   *   note. Nothing in this file can be told who sent something.
   * @returns {{ok: true, ping: object} | {ok: false, why: string}}
   */
  add(ownerId, phraseId, { x = 0, z = 0, atMs = 0 } = {}) {
    const ph = PHRASES[phraseId];
    /* A phrase id the vocabulary does not contain is REFUSED, not passed through as an
     * inert marker with no words. An unknown id can only come from a modified client or a
     * version skew, and both deserve a sentence rather than a blank icon. */
    if (!ph) return { ok: false, why: msg('comms.refuse.notAPhrase') };
    if (!ownerId) return { ok: false, why: msg('comms.refuse.noCaller') };

    const last = this._lastAt.get(ownerId);
    if (last !== undefined && atMs >= last && atMs - last < this.minGapMs) {
      return { ok: false, why: msg('comms.refuse.tooSoon') };
    }

    /* Unique: the newer copy wins. Re-marking the mass as it walks should MOVE the marker,
     * not leave a trail of places it used to be. */
    if (ph.unique) {
      for (let i = this.list.length - 1; i >= 0; i--) {
        const q = this.list[i];
        if (q.owner === ownerId && q.phrase === phraseId) this.list.splice(i, 1);
      }
    }

    /* ⚠ THE CAP EVICTS, IT DOES NOT REFUSE. Refusing the newest call punishes an operative
     * for having just decided what matters most — which is precisely the moment the system
     * has to work. Dropping their oldest bounds the display exactly as well and costs them
     * the call they have already stopped caring about. */
    let mine = this.list.filter((q) => q.owner === ownerId).length;
    while (mine >= this.maxPerPlayer) {
      const i = this.list.findIndex((q) => q.owner === ownerId);
      if (i < 0) break;
      this.list.splice(i, 1);
      mine--;
    }

    const anchor = ANCHORS[ph.anchor];
    const ping = {
      id: ++this._seq,
      owner: ownerId,
      phrase: phraseId,
      x: anchor.placed ? x : 0,
      z: anchor.placed ? z : 0,
      atMs,
    };
    this.list.push(ping);
    this._lastAt.set(ownerId, atMs);
    return { ok: true, ping };
  }

  /**
   * What is on the board at `nowMs`, oldest first.
   *
   * @param {function} ownerAt  optional `(ownerId) => {x, z} | null`. A call anchored to a
   *   person is resolved through it every read, so a `help` marker follows a casualty
   *   being dragged clear. An owner it cannot resolve has left the roster entirely, and
   *   their marker goes with them rather than hanging over empty floor.
   */
  live(nowMs, ownerAt = null) {
    const out = [];
    for (const ping of this.list) {
      const ph = PHRASES[ping.phrase];
      if (!ph) continue;
      if (nowMs - ping.atMs >= ph.lifeMs) continue;
      if (!ANCHORS[ph.anchor].follows || !ownerAt) { out.push(ping); continue; }
      const at = ownerAt(ping.owner);
      if (!at) continue;
      out.push({ ...ping, x: at.x, z: at.z });
    }
    return out;
  }

  /** Everything one operative has up, expired or not. */
  forOwner(ownerId) { return this.list.filter((p) => p.owner === ownerId); }

  /**
   * Take an operative's calls off the board. GDD §11.5 reserves a dropped operative's SLOT
   * and their KIT; it does not preserve their statements. A marker reading "it is here"
   * from somebody whose radio went out two minutes ago is worse than nothing, because the
   * squad cannot ask them and will act on it anyway. The roster still shows them, with
   * their room and their distance (hud.js), so the fact that they are on the floor is not
   * lost — only their unverifiable claims about it are.
   *
   * Wired to a DROP and to a DEATH, and deliberately NOT to going down: §9.5's downed
   * operative is still on the floor with eyes, and their `help` marker is the single most
   * useful object in the room.
   */
  retire(ownerId) {
    const before = this.list.length;
    this.list = this.list.filter((p) => p.owner !== ownerId);
    this._lastAt.delete(ownerId);
    return before - this.list.length;
  }

  /** Drop what has expired. Housekeeping only — `live()` is what decides. */
  prune(nowMs) {
    const before = this.list.length;
    this.list = this.list.filter((p) => {
      const ph = PHRASES[p.phrase];
      return ph && nowMs - p.atMs < ph.lifeMs;
    });
    return before - this.list.length;
  }

  clear() { this.list.length = 0; this._lastAt.clear(); this._seq = 0; }

  /* ── the wire ───────────────────────────────────────────────────────────────
   *
   * Positions to the centimetre, matching protocol.js's rule for every other position in
   * the game. Fifteen rows at worst, so this is a rounding error next to the player array.
   *
   * ⚠ NEITHER THE LIFETIME NOR THE KIND NOR THE TEXT IS SENT. All three are derived from
   * the phrase id, and both ends already have the vocabulary — sending derived data is how
   * two copies of the same fact start disagreeing. The OWNER'S NAME is not sent either:
   * the client has the roster, and a name that travelled with the ping would keep saying
   * "Vasquez" after Vasquez had been renamed.
   *
   * ⚠ THE PHRASE TRAVELS AS ITS ID, NOT AS AN INDEX. An index is two bytes cheaper and
   * silently changes every live call's meaning the day somebody reorders the table — which
   * they will, because authoring order is wheel order and the wheel gets tuned.
   */
  encode() {
    return this.list.map((p) => [p.id, p.owner, p.phrase, Math.round(p.x * 100), Math.round(p.z * 100), Math.round(p.atMs)]);
  }

  /**
   * Replace the board from a snapshot, in place.
   *
   * ⚠ REUSING THE OBJECT WHERE THE ID MATCHES, for the reason `applySnapshot` records: the
   * presentation holds references across frames, and a marker rebuilt every 80 ms restarts
   * its own animation and never finishes fading in.
   *
   * The board IS host state and being replaced wholesale is correct for it — unlike
   * `notices`, it is not a per-machine accumulation. A refusal is the thing that must not
   * ride here, and it does not: refusals go back to one operative over MSG.EVENT and land
   * in `localNotices`.
   */
  decode(rows) {
    const by = new Map(this.list.map((p) => [p.id, p]));
    const next = [];
    for (const [id, owner, phrase, x, z, atMs] of rows || []) {
      if (!PHRASES[phrase]) continue;           // a phrase this build does not have: drop it
      const p = by.get(id) || { id, owner, phrase, x: 0, z: 0, atMs: 0 };
      p.owner = owner; p.phrase = phrase;
      p.x = x / 100; p.z = z / 100; p.atMs = atMs;
      next.push(p);
      if (id > this._seq) this._seq = id;
    }
    this.list = next;
    return this.list.length;
  }
}

/* ── the one entry point the game calls ───────────────────────────────────────
 *
 * Board rules and world rules in the order that produces the most useful refusal. The
 * world checks come first because "you cannot see that from here" tells an operative
 * something they can act on, and "give the last call a moment" does not; the rate limit
 * still cannot be bypassed, because it lives inside `add` and `add` is the only door.
 */

/**
 * @param {PingBoard} board
 * @param {object} caller  {id, x, z, yaw, alive, downed} — a Player, or anything shaped
 *   like one. Its ID is the owner; the request never carries one.
 * @param {string} phraseId
 * @param {{x, z}} aim  the point the caller is looking at. Ignored by anchors that have
 *   their own place.
 * @param {{atMs, blockers}} ctx  simulation time and the rects that stop sight.
 * @returns {{ok: true, ping} | {ok: false, why: string}}
 */
export function requestPing(board, caller, phraseId, aim = {}, ctx = {}) {
  const ph = PHRASES[phraseId];
  if (!ph) return { ok: false, why: msg('comms.refuse.notAPhrase') };
  if (!caller || !caller.id) return { ok: false, why: msg('comms.refuse.noCaller') };
  if (caller.alive === false) return { ok: false, why: msg('comms.refuse.offTheNet') };

  /* §9.5 again: down is not dead. A downed operative has one verb and this is the phrase
   * that carries it — `whileDowned` is a field, not a branch on the id, so a second
   * anomaly can add "I cannot move" without touching this line. */
  if (caller.downed && !ph.whileDowned) return { ok: false, why: msg('comms.refuse.downed') };

  const anchor = ANCHORS[ph.anchor];
  let x = 0, z = 0;
  if (anchor.fromCaller) {
    x = caller.x; z = caller.z;
  } else if (anchor.placed) {
    x = Number(aim.x) || 0; z = Number(aim.z) || 0;
    if (anchor.needsSight) {
      if (dist(caller.x, caller.z, x, z) > MARK_RANGE_M) return { ok: false, why: msg('comms.refuse.tooFar') };
      if (!canMark(caller, x, z, ctx.blockers || [])) return { ok: false, why: msg('comms.refuse.noSight') };
    }
  }

  return board.add(caller.id, phraseId, { x, z, atMs: ctx.atMs || 0 });
}
