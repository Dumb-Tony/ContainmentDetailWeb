/* Sound. Synthesised, no files, no external requests.
 *
 * THE SEAM THAT MAKES AUDIO TESTABLE: `mixFor(state)` is a PURE function from world state
 * to target loudnesses and pitches. Every oscillator sits behind it. That is what lets the
 * headless suite assert "the whistle sharpens when it locks on" and "the heater cycle is
 * audible while custody holds" on a machine with no sound card and no user gesture —
 * copied from SmallTownEmergencyServices\src\audio\audio.js (Dev\INDEX.md).
 *
 * The anomaly's audio vocabulary is the one the content file authored, state by state:
 * a steady draught with no direction (latent), direction and a faint whistle (aware), a
 * sustained note (drawn), a flutter (banked), a heater cycling every twenty seconds
 * (contained). Every one of them also has a visual channel, per GDD §17.3.
 *
 * ⚠ THE VOLUME SLIDERS DO NOT TOUCH mixFor, AND MUST NOT. GDD §19.1 wants five separate
 * sliders; the obvious implementation is to scale the mix, and it would destroy the seam —
 * `mixFor` would stop being a function of the world and start being a function of the
 * world plus a menu, and section J of the suite ("the same state gives the same mix")
 * would be asserting the settings screen. So the sliders are GAIN BUSES in the graph
 * below, downstream of everything mixFor decides. mixFor never learns they exist.
 *
 * CAPTIONS ARE THE SAME SHAPE. §17.3 requires a visual alternative for every critical audio
 * cue, and §19.2 forbids a required rule from depending on hearing at all. So the caption
 * table is keyed by the same simulation event names as CUES, and the continuous voices get
 * captions from `captionsForMixChange`, which is pure and compares two mixes. A player with
 * the sound off reads exactly what a player with headphones hears.
 */

import { CONFIG } from '../config.js';
import { t as msg } from '../core/i18n.js';

/**
 * Pure. Returns target values for the continuous voices, in 0..1 gains and Hz.
 * @param {object} s {anomalyState, distance, imagerOn, imagerLockMs, custodyHeldMs,
 *                    stressNorm, pressureStage, activeEmitters}
 */
export function mixFor(s) {
  const near = Math.max(0, 1 - s.distance / 18);

  /**
   * ⚠ THIS SWITCHED ON THE DRAUGHT'S FIVE STATE IDS.
   *
   * `latent`, `aware`, `drawn`, `banked`, `contained` are `graybox-draught`'s state names,
   * not the game's. Every other anomaly calls its states something else — `standing`,
   * `dispersed`, `casting`, `settled`, `unremarked` — so all five of them fell through the
   * `default:` and came out with whistle 0 at every distance in every state. FIVE OF SIX
   * ANOMALIES HAD NO VOICE AT ALL, and the one that did was the one the file was written
   * against, which is exactly why nobody heard it.
   *
   * `senses.js` states the rule this broke: the engine may not know an anomaly by name.
   * The abstraction already existed — every state declares a `kind` from a closed set, and
   * the draught's five map onto it one for one — so this reads the KIND and is
   * bit-identical for the draught while giving the other five a voice for the first time.
   */
  let whistle = 0, whistleHz = 0, drone = 0.12 + near * 0.2;
  switch (s.anomalyStateKind) {
    case 'latent': whistle = 0; whistleHz = 0; break;
    case 'active': whistle = 0.10 * near; whistleHz = 420; break;
    case 'hunting': whistle = 0.24 * near; whistleHz = 720; break;
    case 'vulnerable': whistle = 0.13 * near; whistleHz = 300; break;
    case 'contained': whistle = 0; whistleHz = 0; drone = 0.04; break;
    default: break;
  }
  /* Flutter is what a held anomaly sounds like: the note breaks up rather than dropping
   * out, so one you are holding never sounds like one you have contained. */
  const flutterHz = s.anomalyStateKind === 'vulnerable' ? 7 : 0;
  /* The case heater cycles every twenty seconds while custody holds (content, `contained`). */
  const heater = s.custodyHeldMs > 0 ? (Math.floor(s.custodyHeldMs / 20000) !== Math.floor((s.custodyHeldMs - 900) / 20000) ? 0.22 : 0) : 0;

  /* The imager's contact tone rises as the mass is held in view — the non-visual channel
   * for the presence cue (§17.3 requires one). */
  const imager = s.imagerOn ? 0.05 + Math.min(0.14, (s.imagerLockMs || 0) / 2000 * 0.14) : 0;
  const imagerHz = 620 + Math.min(1, (s.imagerLockMs || 0) / 2000) * 260;

  const breath = s.stressNorm > 0.4 ? (s.stressNorm - 0.4) * 0.3 : 0;
  const hum = s.activeEmitters > 0 ? Math.min(0.10, 0.035 * s.activeEmitters) : 0;

  return { drone, whistle, whistleHz, flutterHz, heater, imager, imagerHz, breath, hum };
}

/* ── the buses (GDD §19.1: separate sliders) ──────────────────────────────────
 *
 * Five named buses plus a master, matching §19.1's list word for word so a settings label
 * and a gain node cannot drift apart. Every voice and every cue names the bus it belongs
 * to; nothing connects to the master directly except the buses themselves.
 */
export const BUSES = Object.freeze(['master', 'voice', 'anomaly', 'instruments', 'ambience', 'music']);

/** 0..1 per bus. `music` exists with nothing on it yet — §17.5's sparse score connects
 *  here when it lands, and the slider is real from the day it does. */
export const DEFAULT_VOLUMES = Object.freeze({
  master: 1, voice: 1, anomaly: 1, instruments: 1, ambience: 1, music: 1,
});

/* Which bus each continuous voice sings on.
 * ⚠ `breath` is on `voice` rather than on its own channel. §19.1's slider is named "voice",
 * and the operative's own breathing is the only voice in the build until proximity chat
 * exists — a player who turns voice down to hear the room expects the panting to go with
 * it. `hum` is the squad's own powered kit, so it is an instrument, not ambience. */
export const VOICE_BUSES = Object.freeze({
  drone: 'ambience',
  whistle: 'anomaly',
  imager: 'instruments',
  hum: 'instruments',
  breath: 'voice',
});

/* ── §17.5, the score ─────────────────────────────────────────────────────────
 *
 * The `music` bus has existed with nothing on it since the graph was built, with a comment
 * saying so. §17.5 is one paragraph and every clause in it is a constraint:
 *
 *   "Music is SPARSE DURING INVESTIGATION. It responds to COMPREHENSION AND PROCEDURAL
 *    COMMITMENT rather than merely enemy proximity. Containment music SUPPORTS RHYTHM
 *    WITHOUT MASKING CALLOUTS. The base uses low, functional ambience and restrained
 *    motifs TIED TO SITE GROWTH."
 *
 * ⚠ "RATHER THAN MERELY ENEMY PROXIMITY" IS THE WHOLE DESIGN AND IT IS ALSO A TEST.
 *
 * Every horror game's score is a distance function, and writing one here would have been
 * two lines — `mixFor` already computes `near` on the line above. It would also have been
 * the exact thing the sentence forbids, and nothing would have caught it, because a score
 * that swells as the thing approaches sounds *correct*.
 *
 * So `scoreFor` takes no position and no anomaly state. It cannot: they are not in its
 * argument. What it reads is what the squad has WORKED OUT and what they have DECIDED to
 * do about it — the board, and the committed procedure — which are the two things this
 * game is actually about and the two things a proximity score would drown.
 *
 * The layers, and what each one is for:
 *
 *   bed        always, and almost inaudible. "Sparse during investigation" is a floor, not
 *              a silence: a room with no bed at all reads as a bug rather than as restraint.
 *   reading    COMPREHENSION. Rises with how much of the board the squad has taken a
 *              position on AND how much of that position is carried by evidence they hold.
 *              Both, multiplied — a board full of guesses is not comprehension, and a
 *              satchel full of unread evidence is not either.
 *   intent     PROCEDURAL COMMITMENT. Absent until a procedure is committed, and it does
 *              not fade back in on a revision: a revised plan gets a DIFFERENT interval,
 *              not a louder one, because the second plan is a second idea and not more of
 *              the first.
 *   custody    the containment rhythm, and the only layer with a pulse in it. Present only
 *              while custody is actually being held.
 *
 * ⚠ AND IT DUCKS. "Without masking callouts" is not a mixing note, it is a rule: a ping,
 * a caption or a squad call has to arrive over the top of whatever is playing. `duck` is
 * returned rather than folded into the gains so that the graph applies it in one place and
 * a test can assert the depth of it — a score that ducks by 5% is a score that says it
 * ducks.
 *
 * No captions. §17.3 requires a visual alternative for every critical audio CUE, and this
 * is deliberately not one: nothing here is a cue, nothing here carries information the
 * player cannot get from the board it is reading, and a caption saying "music swells" would
 * be noise in a channel reserved for the things that matter.
 */
export const SCORE_LAYERS = Object.freeze(['bed', 'reading', 'intent', 'custody']);

/** Hz for each layer. Low, and spaced by intervals rather than by octaves so two layers
 *  sounding together are a chord rather than a thicker version of one note. */
export const SCORE_VOICES = Object.freeze({
  bed: { type: 'sine', hz: 41 },
  reading: { type: 'sine', hz: 61.5 },      // a fifth above the bed
  intent: { type: 'triangle', hz: 82 },     // the octave; a revision retunes it, see below
  custody: { type: 'sine', hz: 55 },
});

/** How far under a live callout the whole bus goes. §19.2 forbids a required rule depending
 *  on hearing, so this is politeness rather than safety — but a squad call that arrives at
 *  the same loudness as the score is a call somebody misses. */
export const SCORE_DUCK = 0.35;

/**
 * Pure, and pointedly ignorant of where the anomaly is.
 *
 * @param {object} s {claimsTaken, claimsTotal, rulesSupported, rulesTotal, committed,
 *                    revisions, custodyHeldMs, inBase, siteUpgrades, callActive}
 * @returns {{bed:number, reading:number, intent:number, custody:number, duck:number,
 *            intentHz:number}}
 */
export function scoreFor(s = {}) {
  const frac = (a, b) => (b > 0 ? Math.max(0, Math.min(1, a / b)) : 0);

  /* THE BASE IS A DIFFERENT PIECE. "Low, functional ambience and restrained motifs tied to
   * site growth" — so between operations the only thing that moves is what the site has
   * become, and it moves slowly: a site with everything built is not four times as loud as
   * an empty one, it is a third louder. */
  if (s.inBase) {
    const grown = frac(s.siteUpgrades || 0, 8);
    return {
      bed: 0.05 + 0.017 * grown, reading: 0, intent: 0, custody: 0,
      duck: s.callActive ? SCORE_DUCK : 1, intentHz: SCORE_VOICES.intent.hz,
    };
  }

  const taken = frac(s.claimsTaken || 0, s.claimsTotal || 0);
  const supported = frac(s.rulesSupported || 0, s.rulesTotal || 0);

  return {
    /* Audible enough to be a floor, quiet enough that a squad talking over it never has to
     * raise their voice. */
    bed: 0.045,

    /* ⚠ THE PRODUCT, NOT THE SUM. A squad that has marked every claim on no evidence has
     * comprehension of zero and should hear nothing for it; so should one holding every
     * observation and committing to none. The score rewards the two together because the
     * game does. */
    reading: 0.115 * taken * supported,

    /* Nothing until they commit. `committed` is a boolean and not a ramp on purpose: a
     * procedure is a decision, and a decision does not fade in. */
    intent: s.committed ? 0.085 : 0,

    /* The rhythm layer, and the only one that gets anywhere near the others in level. It
     * arrives when custody does and it is the loudest thing in the score, because the
     * climax of this game is a box holding. */
    custody: (s.custodyHeldMs || 0) > 0 ? 0.14 : 0,

    duck: s.callActive ? SCORE_DUCK : 1,

    /* A REVISION RETUNES RATHER THAN REPEATS. Each revision drops the interval a whole tone,
     * bottoming out after four — so a squad on their third plan is listening to a different
     * chord than the one they committed to first, without the score getting louder or
     * telling them they were wrong. */
    intentHz: SCORE_VOICES.intent.hz * (1 - 0.06 * Math.min(4, s.revisions || 0)),
  };
}

/**
 * Read the score's inputs off a live Game. Separated from `scoreFor` so the pure function
 * stays drivable from a literal in the suite, which is the same split `mixFor` makes.
 */
export function scoreInputs(game, { inBase = false, siteUpgrades = 0, callActive = false } = {}) {
  const led = game.ledger;
  const claims = led ? led.claims : [];
  const state = led ? led.claimState : new Map();
  let taken = 0;
  for (const c of claims) if (state.get(c.id)) taken++;
  /* "Supported" is a rule with at least one observation logged against it — the squad's own
   * satchel, not the anomaly file's list of what exists to be found. */
  const found = new Set((led ? led.entries : []).map((e) => e.revealsRule || (led.rules.get(e.evidenceId) || {}).revealsRule).filter(Boolean));
  const all = new Set([...(led ? led.rules.values() : [])].map((r) => r.revealsRule).filter(Boolean));
  return {
    claimsTaken: taken, claimsTotal: claims.length,
    rulesSupported: found.size, rulesTotal: all.size,
    committed: !!(game.mission && game.mission.procedure),
    revisions: (game.mission && game.mission.procedureRevisions) || 0,
    /* `game.custody` is the three-word state — none | sealed | verified — and the rhythm
     * layer wants the two that mean a box is holding. Not a duration: the layer is on or
     * off, because custody is on or off and a score that faded up through the thirty
     * seconds would be counting down a clock the HUD already shows. */
    custodyHeldMs: game.custody && game.custody !== 'none' ? 1 : 0,
    inBase, siteUpgrades, callActive,
  };
}

/** One-shot cues, as a data table keyed by simulation event. A new event is a new row; an
 *  event with no row is silent rather than fatal. */
export const CUES = Object.freeze({
  CONTACT: { hz: 90, dur: 0.9, type: 'sawtooth', gain: 0.5, sweep: -40, bus: 'anomaly' },
  SEAL_ATTEMPT: { hz: 240, dur: 0.35, type: 'square', gain: 0.3, sweep: 120, bus: 'instruments' },
  CUSTODY_VERIFIED: { hz: 520, dur: 0.7, type: 'triangle', gain: 0.32, sweep: 180, bus: 'instruments' },
  CUSTODY_LOST: { hz: 300, dur: 1.1, type: 'sawtooth', gain: 0.4, sweep: -220, bus: 'anomaly' },
  DEPLOYED: { hz: 180, dur: 0.14, type: 'square', gain: 0.16, sweep: 0, bus: 'instruments' },
  RETRIEVED: { hz: 260, dur: 0.11, type: 'square', gain: 0.13, sweep: 0, bus: 'instruments' },
  CIRCUIT_CHANGED: { hz: 70, dur: 0.5, type: 'sawtooth', gain: 0.26, sweep: 30, bus: 'ambience' },
  DOOR_CHANGED: { hz: 120, dur: 0.4, type: 'triangle', gain: 0.2, sweep: -30, bus: 'ambience' },
  BATTERY_DEAD: { hz: 420, dur: 0.5, type: 'sine', gain: 0.24, sweep: -260, bus: 'instruments' },
  EVIDENCE_LOGGED: { hz: 880, dur: 0.09, type: 'sine', gain: 0.12, sweep: 0, bus: 'instruments' },
});

/* ── captions (GDD §17.3, §19.1, §19.2) ───────────────────────────────────────
 *
 * A parallel table, same keys as CUES so a cue without a line is a visible hole rather
 * than a quiet omission — `missingCaptions()` below is the check, and it is one line for
 * a future suite to assert.
 *
 * `kind` decides the rendering, not the wording:
 *   'nonspeech' — bracketed, because that is the convention every player already reads.
 *   'speech'    — attributed to a speaker, quoted.
 * `priority` 3 is "you must read this or you will lose the operation"; 1 is furniture. A
 * caption channel that is showing three lines drops the lowest priority first.
 * `directional` marks the lines where WHERE it came from is part of the information, so
 * the HUD can append a bearing when the caller supplies one — §19.2 forbids a rule that
 * depends on stereo hearing, and this is how that promise is kept.
 *
 * ⚠ THE KEY IS THE SIMULATION EVENT AND THE WORDS ARE `caption.<KEY>` IN content/locales.
 * §19.2 makes these the whole channel for a player who cannot hear, so a caption left in one
 * language is a required rule left in one language — and the milestone that keyed the HUD
 * would have skipped these entirely, because a caption table looks like data.
 *
 * `text` is an ACCESSOR, defined rather than spread: `{ ...row }` copies a getter's value at
 * module load, so a spread table would have frozen English at boot and gone on printing it
 * under every other locale with nothing failing. `formatCaption` reads `.text`, so one
 * accessor keeps the sound and its written line in the same language.
 */
const captioned = (key, row) => Object.freeze(Object.defineProperty({ ...row }, 'text', {
  get: () => msg(`caption.${key}`), enumerable: true,
}));

export const CAPTIONS = Object.freeze({
  CONTACT: captioned('CONTACT', { kind: 'nonspeech', priority: 3, directional: true }),
  SEAL_ATTEMPT: captioned('SEAL_ATTEMPT', { kind: 'nonspeech', priority: 2, directional: false }),
  CUSTODY_VERIFIED: captioned('CUSTODY_VERIFIED', { kind: 'nonspeech', priority: 3, directional: false }),
  CUSTODY_LOST: captioned('CUSTODY_LOST', { kind: 'nonspeech', priority: 3, directional: false }),
  DEPLOYED: captioned('DEPLOYED', { kind: 'nonspeech', priority: 1, directional: false }),
  RETRIEVED: captioned('RETRIEVED', { kind: 'nonspeech', priority: 1, directional: false }),
  CIRCUIT_CHANGED: captioned('CIRCUIT_CHANGED', { kind: 'nonspeech', priority: 2, directional: false }),
  DOOR_CHANGED: captioned('DOOR_CHANGED', { kind: 'nonspeech', priority: 2, directional: true }),
  BATTERY_DEAD: captioned('BATTERY_DEAD', { kind: 'nonspeech', priority: 3, directional: false }),
  EVIDENCE_LOGGED: captioned('EVIDENCE_LOGGED', { kind: 'nonspeech', priority: 1, directional: false }),

  /* The continuous voices. These come from captionsForMixChange, not from the event bus,
   * because they describe a sound that is ALREADY PLAYING rather than one that fired. The
   * wording is the content file's own `audioCue` text, so what the player reads and what
   * the anomaly document promises are the same sentence. */
  WHISTLE_SHARPENS: captioned('WHISTLE_SHARPENS', { kind: 'nonspeech', priority: 3, directional: true }),
  WHISTLE_DROPS: captioned('WHISTLE_DROPS', { kind: 'nonspeech', priority: 2, directional: true }),
  FLUTTER_BEGINS: captioned('FLUTTER_BEGINS', { kind: 'nonspeech', priority: 3, directional: true }),
  NOTE_SUSTAINS: captioned('NOTE_SUSTAINS', { kind: 'nonspeech', priority: 3, directional: true }),
  HEATER_CYCLE: captioned('HEATER_CYCLE', { kind: 'nonspeech', priority: 2, directional: false }),
  DRAUGHT_STILLS: captioned('DRAUGHT_STILLS', { kind: 'nonspeech', priority: 2, directional: false }),
  IMAGER_CONTACT: captioned('IMAGER_CONTACT', { kind: 'nonspeech', priority: 2, directional: false }),
  BREATH_HARD: captioned('BREATH_HARD', { kind: 'nonspeech', priority: 1, directional: false }),
});

/** Every cue that has no caption. §17.3 says there must be none; this is how a suite asks. */
export function missingCaptions() {
  return Object.keys(CUES).filter((k) => !CAPTIONS[k]);
}

/**
 * PURE. Which captions the change from one mix to the next earns.
 *
 * Written against deltas rather than against the anomaly state on purpose: the mix is the
 * only thing the player can actually hear, so a caption derived from it can never describe
 * a sound that is not playing. Thresholds are wide enough that a ramp does not stutter.
 *
 * @returns {string[]} caption keys, in the order they should be read
 */
export function captionsForMixChange(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  const up = next.whistleHz > prev.whistleHz + 40;
  const down = prev.whistleHz > next.whistleHz + 40 && next.whistleHz > 0;
  if (up) out.push('WHISTLE_SHARPENS');
  if (down) out.push('WHISTLE_DROPS');
  if (next.flutterHz > 0 && prev.flutterHz === 0) out.push('FLUTTER_BEGINS');
  if (next.flutterHz === 0 && prev.flutterHz > 0 && next.whistle > 0) out.push('NOTE_SUSTAINS');
  if (next.heater > 0 && prev.heater === 0) out.push('HEATER_CYCLE');
  /* Gone quiet AND gone cold-quiet: whistle off with the drone falling is the contained
   * signature, and it is the one moment where silence is the information. */
  if (prev.whistle > 0 && next.whistle === 0 && next.drone < prev.drone) out.push('DRAUGHT_STILLS');
  /* ⚠ NOT "the imager came on". The contact tone rises smoothly from 620Hz to 880Hz over
   * two seconds of held lock, so a frame-to-frame delta is about two hertz and no delta
   * threshold can see it. What the player is being told is that the lock COMPLETED, so the
   * test is a threshold crossing near the top of the ramp. */
  if (next.imager > 0 && prev.imagerHz < 820 && next.imagerHz >= 820) out.push('IMAGER_CONTACT');
  if (next.breath > 0 && prev.breath === 0) out.push('BREATH_HARD');
  return out;
}

/** Compass words, because a bearing in degrees is not a caption. The SET is closed and its
 *  members are ids the simulation produces (`bearingWord` returns them); the words are
 *  `direction.<id>`. A bearing the caller invents falls through and prints itself. */
const DIRECTIONS = Object.freeze(['ahead', 'behind', 'left', 'right', 'above', 'below']);
const directionWord = (d) => (DIRECTIONS.includes(d) ? msg(`direction.${d}`) : d);

/**
 * PURE. One caption row plus its context, rendered to the line the HUD prints.
 * @param {object} row  a CAPTIONS entry
 * @param {object} ctx  {speaker, direction, showSpeaker, showDirection, text}
 */
export function formatCaption(row, ctx = {}) {
  if (!row) return '';
  const body = ctx.text || row.text;
  const dir = ctx.showDirection !== false && row.directional && ctx.direction
    ? ` — ${directionWord(ctx.direction)}` : '';
  if (row.kind === 'speech') {
    const who = ctx.showSpeaker !== false && (ctx.speaker || row.speaker);
    return who ? `${who}: "${body}"${dir}` : `"${body}"${dir}`;
  }
  return `[${body}${dir}]`;
}

/**
 * The caption event stream. NO DOM, NO CLOCK — the HUD renders it and the caller supplies
 * simulation time, which is also what makes it drivable in the headless suite.
 *
 * ⚠ Time comes in, it is never read. audio.js is one of the two files section K5 exempts
 * from the wall-clock ban, and it stays that way by not needing the exemption: a caption
 * that expired according to Date.now() would expire while the game was paused.
 */
export class CaptionChannel {
  constructor({ maxLines = 3, holdMs = 4200, dedupeMs = 1200, logSize = 128 } = {}) {
    this.enabled = true;
    this.maxLines = maxLines;
    this.holdMs = holdMs;
    this.dedupeMs = dedupeMs;
    this.logSize = logSize;
    this.log = [];              // ring, newest last — the debrief can read it back
    this._lastAt = new Map();   // caption key -> simTimeMs it last fired
    /** Subscribe to get every accepted caption as it lands. */
    this.onCaption = null;
  }

  /**
   * Offer a caption. Returns the accepted record, or null when it was suppressed.
   * @param {string} key   a CAPTIONS key (usually the simulation event's own type)
   * @param {object} evt   {simTimeMs, direction, speaker, text}
   */
  push(key, evt = {}) {
    if (!this.enabled) return null;
    const row = CAPTIONS[key];
    if (!row) return null;                      // an event with no line is silent, not fatal
    const t = Number.isFinite(evt.simTimeMs) ? evt.simTimeMs : 0;
    /* The mix is sampled every frame, so without this a sharpening whistle would print
     * sixty identical lines a second. Dedupe by KEY, never by text. */
    const last = this._lastAt.get(key);
    if (last !== undefined && t - last < this.dedupeMs && t >= last) return null;
    this._lastAt.set(key, t);

    const rec = {
      key, at: t, priority: row.priority, kind: row.kind,
      text: formatCaption(row, evt), direction: evt.direction || null, speaker: evt.speaker || null,
    };
    this.log.push(rec);
    if (this.log.length > this.logSize) this.log.shift();
    if (this.onCaption) this.onCaption(rec);
    return rec;
  }

  /**
   * What should be on screen at `nowMs`. Oldest first, so the HUD can print them as a
   * stack that scrolls upward. Over-full drops the LOWEST priority, not the oldest: losing
   * "logged" to keep "custody lost" is the whole point of the priority column.
   */
  active(nowMs) {
    const live = this.log.filter((r) => nowMs - r.at < this.holdMs && nowMs >= r.at);
    if (live.length <= this.maxLines) return live;
    const keep = live.slice().sort((a, b) => (b.priority - a.priority) || (b.at - a.at)).slice(0, this.maxLines);
    const keepSet = new Set(keep);
    return live.filter((r) => keepSet.has(r));
  }

  clear() { this.log.length = 0; this._lastAt.clear(); }
}

export class Audio {
  constructor() {
    this.ctx = null;
    this.ok = false;
    this.voices = null;
    this.buses = null;
    /* Volumes are held here whether or not there is an AudioContext, so a player who sets
     * them on the title screen still gets them when the first click starts the graph. */
    this.volumes = { ...DEFAULT_VOLUMES };
    /** The visual channel. Lives here because it is fed by exactly the same table the
     *  oscillators are, and a caption that lived elsewhere would drift out of step. */
    this.captions = new CaptionChannel();
    this._lastMix = null;
  }

  /** Browsers refuse an AudioContext before a gesture; main.js calls this on first input. */
  start() {
    if (this.ok) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { this.ctx = new AC(); } catch { return false; }
    const master = this.ctx.createGain();
    master.gain.value = CONFIG.audio.masterGain * this.volumes.master;
    master.connect(this.ctx.destination);
    this.master = master;

    /* One gain node per §19.1 slider, between the voices and the master. Everything the
     * mix decides passes through exactly one of them. */
    this.buses = { master };
    for (const name of BUSES) {
      if (name === 'master') continue;
      const g = this.ctx.createGain();
      g.gain.value = this.volumes[name];
      g.connect(master);
      this.buses[name] = g;
    }

    const voice = (type, hz, gain, bus) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type; o.frequency.value = hz; g.gain.value = gain;
      o.connect(g); g.connect(this.buses[bus] || master); o.start();
      return { o, g };
    };
    this.voices = {
      drone: voice('sine', 58, 0, VOICE_BUSES.drone),
      whistle: voice('triangle', 420, 0, VOICE_BUSES.whistle),
      imager: voice('sine', 620, 0, VOICE_BUSES.imager),
      hum: voice('sawtooth', 110, 0, VOICE_BUSES.hum),
      breath: voice('sine', 180, 0, VOICE_BUSES.breath),
    };

    /* §17.5's score, on the bus that was built for it and has been silent since. Four
     * oscillators, all on `music`, all starting at zero — so a player who has learned
     * nothing and committed to nothing hears the bed and no more. */
    this.score = {};
    for (const name of SCORE_LAYERS) {
      const v = SCORE_VOICES[name];
      this.score[name] = voice(v.type, v.hz, 0, 'music');
    }
    this.ok = true;
    return true;
  }

  /**
   * Apply a score. Separate from `apply` because it moves on a different timescale: a mix
   * follows the world at 0.12 s and a score is allowed to take four seconds to notice
   * something, which is most of what makes it a score rather than an alarm.
   *
   * ⚠ THE DUCK IS APPLIED HERE, ONCE, TO EVERY LAYER — not folded into `scoreFor`'s gains.
   * A duck that lived in the pure function would be indistinguishable from a quiet score,
   * and "supports rhythm without masking callouts" is a claim about what happens WHEN
   * somebody speaks, which is a thing a test has to be able to see happening.
   */
  applyScore(sc, tSec = 4.0) {
    if (!this.ok || !this.score) return;
    const now = this.ctx.currentTime;
    const duck = typeof sc.duck === 'number' ? sc.duck : 1;
    for (const name of SCORE_LAYERS) {
      const v = this.score[name];
      if (!v) continue;
      /* The duck is fast in and slow out: a call has to cut through on the syllable, and
       * the score coming straight back up under the second half of a sentence is worse
       * than it never having ducked. */
      const target = Math.max(0, (sc[name] || 0)) * duck;
      const ramp = duck < 1 ? 0.08 : tSec;
      v.g.gain.cancelScheduledValues(now);
      v.g.gain.setTargetAtTime(target, now, Math.max(0.02, ramp / 3));
    }
    if (typeof sc.intentHz === 'number' && this.score.intent) {
      this.score.intent.o.frequency.setTargetAtTime(sc.intentHz, now, 1.2);
    }
  }

  /**
   * Set one or more bus volumes, 0..1. Partial objects are fine — the settings panel sends
   * one key at a time, and a save file sends all six.
   * ⚠ Ramped, not stepped. A slider dragged to zero with `.value =` clicks, and the click
   * is loudest at exactly the moment the player was trying to make it quieter.
   */
  setVolumes(v = {}) {
    for (const [name, raw] of Object.entries(v)) {
      if (!BUSES.includes(name)) continue;
      const val = Math.max(0, Math.min(1, Number(raw) || 0));
      this.volumes[name] = val;
      if (!this.ok) continue;
      const node = name === 'master' ? this.master : this.buses[name];
      const target = name === 'master' ? CONFIG.audio.masterGain * val : val;
      node.gain.setTargetAtTime(target, this.ctx.currentTime, 0.04);
    }
    return { ...this.volumes };
  }

  busGain(name) { return this.volumes[name]; }

  /** Apply a mix. Ramps rather than steps, so nothing clicks.
   *  ⚠ `simTimeMs` is the SIMULATION clock, not a frame count and not wall time. Captions
   *  expire on it, so a paused game holds its last line on screen instead of blanking it
   *  while the player is reading. Pass `game.clock.simTimeMs`. */
  apply(mix, tSec = 0.12, simTimeMs = 0) {
    /* Captions first, and outside the `ok` guard: a player with no sound card, a muted tab
     * or a headless harness must still be told what the room is doing (§17.3). */
    this.captionMix(mix, simTimeMs);
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    const set = (v, gain, hz) => {
      v.g.gain.setTargetAtTime(gain, t, tSec);
      if (hz) v.o.frequency.setTargetAtTime(hz, t, tSec);
    };
    /* Flutter is a gain wobble, not a second oscillator — one voice, one meaning. */
    const flutter = mix.flutterHz ? 0.55 + 0.45 * Math.sin(t * mix.flutterHz * Math.PI * 2) : 1;
    set(this.voices.drone, mix.drone);
    set(this.voices.whistle, mix.whistle * flutter, mix.whistleHz || undefined);
    set(this.voices.imager, mix.imager, mix.imagerHz);
    set(this.voices.hum, mix.hum);
    set(this.voices.breath, mix.breath);
  }

  /**
   * Caption the continuous voices by comparing this mix with the last one. Safe to call
   * every frame; the channel dedupes. Separate from apply() so a build with audio disabled
   * can still run the visual channel.
   * @param {object} mix   the value mixFor returned
   * @param {number} simTimeMs  the simulation clock, so captions expire on game time
   */
  captionMix(mix, simTimeMs = 0) {
    if (!mix) return [];
    const keys = captionsForMixChange(this._lastMix, mix);
    this._lastMix = mix;
    const out = [];
    for (const k of keys) {
      const rec = this.captions.push(k, { simTimeMs });
      if (rec) out.push(rec);
    }
    return out;
  }

  /**
   * Fire a one-shot cue and its caption.
   * @param {string} name  a CUES / CAPTIONS key — in practice the event's own `type`
   * @param {object} evt   the simulation event, for simTimeMs and direction
   */
  cue(name, evt = {}) {
    // The caption is not conditional on the audio graph existing. That is the point of it.
    this.captions.push(name, evt);
    if (!this.ok) return false;
    const c = CUES[name];
    if (!c) return false;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = c.type;
    o.frequency.setValueAtTime(c.hz, t);
    if (c.sweep) o.frequency.linearRampToValueAtTime(Math.max(30, c.hz + c.sweep), t + c.dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(c.gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + c.dur);
    o.connect(g); g.connect(this.buses[c.bus] || this.master);
    o.start(t); o.stop(t + c.dur + 0.02);
    return true;
  }
}
