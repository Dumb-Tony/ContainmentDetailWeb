/* The accessibility baseline — GDD §19.
 *
 * §19 opens with the sentence that decides this file's shape: "Accessibility is part of
 * system design, particularly because perception is a core mechanic." In a game whose
 * whole loop is *notice a thing, work out the rule, build a procedure out of it*, an
 * option that hides a cue is an option that removes the game. So nothing here is allowed
 * to change WHAT the site does. Every option changes the CHANNEL the site speaks on.
 *
 * TWO OBJECTS, ONE FILE, AND THE SPLIT IS LOAD-BEARING:
 *
 *   `Settings`      a plain model. No DOM, no clock, no audio graph. It validates, clamps,
 *                   derives, serialises. The headless suite drives it directly.
 *   `SettingsPanel` the screen. Reads the model, writes the model, renders nothing the
 *                   model does not already know. Same shape as Panels (show/hide/isOpen).
 *
 * A settings screen that owned its own values would put half the accessibility contract
 * behind a DOM the test harness cannot reach, and §19 is exactly the part of the design
 * that must not be assertable only by looking at it.
 *
 * ── AND IT IS THE SCREEN THAT MOST HAS TO BE READABLE (GDD §23 Milestone 5) ───
 *
 * A settings panel a player cannot read is an accessibility feature they cannot reach, so
 * this is the one screen where an untranslated label removes a promise §19.1 makes rather
 * than merely looking untidy. Every label, blurb, option word, key name and refusal is a
 * message; the SCHEMA carries only structure.
 *
 * ⚠ A CHOICE FIELD'S VALUES ARE IDS. 'hold', 'largest', 'minimap', 'reduced' are compared
 * against, saved to localStorage and read by the renderer; they are not display text. Each
 * choice field names an `optionsKey` and the label for a value is `<optionsKey>.<value>` —
 * the same id-and-label split `phase`, `pressure` and `grade` make.
 *
 * ── §19.2 SELF-CHECK: WHICH OPTION COVERS WHICH OF THIS BUILD'S CUES ──────────
 *
 * §19.2 forbids a required anomaly rule from depending SOLELY on fine colour
 * discrimination, stereo hearing, microphone use, small or fast text, flashing imagery, or
 * unavoidable disorientation. Every cue the cold-storage incident currently uses, and the
 * option that gives it a second channel. A new anomaly's author should be able to add a
 * row here; if they cannot, the cue is not shippable.
 *
 *   the draught's whistle, and its pitch by state ....... captions.enabled (WHISTLE_SHARPENS,
 *                                                         WHISTLE_DROPS, FLUTTER_BEGINS,
 *                                                         NOTE_SUSTAINS, DRAUGHT_STILLS)
 *   which direction the whistle is coming from .......... captions.direction — the build
 *                                                         synthesises in mono, so no rule
 *                                                         depends on stereo hearing at all
 *   the 40C contour on the thermal imager ............... vision.palette + vision.shapes;
 *                                                         the bezel already prints the
 *                                                         threshold and the word "white"
 *   frost bloom and the halted frost edge ............... assists.evidenceLegibility,
 *                                                         vision.uiScale
 *   the case heater cycling every twenty seconds ........ captions (HEATER_CYCLE) and the
 *                                                         objective line's own countdown
 *   the imager's rising contact tone .................... captions (IMAGER_CONTACT) + bezel
 *   a chill contact ..................................... captions (CONTACT) + the condition
 *                                                         chips, which carry text and bars
 *   a dead battery ...................................... captions (BATTERY_DEAD) + the slot
 *                                                         readout in minutes
 *   incident pressure ................................... already a WORD, never a colour
 *                                                         alone (§5.4, hud.js)
 *   custody verified / lost ............................. captions + objective text
 *
 * Nothing in the build reads a microphone: multiplayer is a PeerJS data channel and voice
 * is out of scope for the slice. Nothing flashes; safety.photosensitive is the promise that
 * nothing will, and it clamps the three effects that could become one.
 */

import { CONFIG } from '../config.js';
import { BUSES } from '../audio/audio.js';
import {
  DEFAULT_HOLD_MODES, HOLD_MODE, HOLDABLE, DEFAULT_BINDINGS,
  sanitiseBindings, sanitiseHoldModes,
} from '../core/input.js';
import { escapeHtml } from './hud.js';
import { t as msg } from '../core/i18n.js';

export const SETTINGS_KEY = 'cd.settings.v1';
export const SETTINGS_VERSION = 1;

/* ── colour-vision presets, GDD §19.1 ─────────────────────────────────────────
 *
 * Five sets of CSS custom properties, using the names index.html already declares, so
 * adopting a preset is one write to document.documentElement and every existing rule in
 * the stylesheet follows. Nothing needs a second class name.
 *
 * ⚠ ONLY THE SIGNAL COLOURS MOVE. --bg/--panel/--line are furniture and stay put; --amber,
 * --red, --cyan, --green and --hot are the five that carry meaning in §18.5's interaction
 * language, and they are the five that have to stay separable. The furniture only changes
 * under high contrast, which is a different axis and composes on top (see cssVars).
 *
 * ⚠ A palette is NEVER the whole answer. §18.5 ends "these treatments must function without
 * colour", so every one of these five roles also has a glyph in SHAPES below, and the rule
 * for new UI is: colour AND shape AND text, never colour alone. The palettes exist so the
 * colour channel is useful too — not so it can be the only one.
 *
 * ⚠ `label` IS A GETTER, and the preset's KEY is its id. The id is written into a save file
 * and compared against; the label is read off the message table at the moment it is drawn,
 * so a consumer that asks the preset for its name and the panel that renders the `<option>`
 * cannot come back with two different words.
 */
export const PALETTES = Object.freeze({
  default: Object.freeze({
    get label() { return msg('settings.palette.default'); },
    vars: Object.freeze({
      '--amber': '#e5a13a', '--red': '#e0503f', '--cyan': '#5fd0d8',
      '--green': '#5fbe86', '--hot': '#fff4d8',
    }),
  }),
  /* Deuteranopia and protanopia both lose the red-green axis; the blue-yellow axis is
   * intact, so the five roles are pulled onto it. Values are the Okabe-Ito set, which is
   * the one with published separation figures rather than the one that looked right. */
  deuteranopia: Object.freeze({
    get label() { return msg('settings.palette.deuteranopia'); },
    vars: Object.freeze({
      '--amber': '#f0e442', '--red': '#ff6f4d', '--cyan': '#56b4e9',
      '--green': '#0072b2', '--hot': '#fff4d8',
    }),
  }),
  /* ⚠ Protanopia is NOT deuteranopia with a different label. A protanope loses red
   * LUMINANCE as well as hue, so the vermillion that reads as a bright hazard to a
   * deuteranope reads as a dark smudge — which is the worst possible treatment for the
   * one colour that means "immediate hazard". Hazard therefore goes magenta here: it keeps
   * a blue component, so it stays bright. */
  protanopia: Object.freeze({
    get label() { return msg('settings.palette.protanopia'); },
    vars: Object.freeze({
      '--amber': '#f0e442', '--red': '#e26fb4', '--cyan': '#56b4e9',
      '--green': '#0072b2', '--hot': '#fff4d8',
    }),
  }),
  /* Tritanopia is the other way round: the red-green axis survives and blue-yellow does
   * not, so red and green stay exactly as authored and the instrument cyan moves to violet
   * where it cannot be confused with the powered-circuit green. */
  tritanopia: Object.freeze({
    get label() { return msg('settings.palette.tritanopia'); },
    vars: Object.freeze({
      '--amber': '#ff9d00', '--red': '#e0503f', '--cyan': '#b06fe0',
      '--green': '#5fbe86', '--hot': '#ffffff',
    }),
  }),
  highContrast: Object.freeze({
    get label() { return msg('settings.palette.highContrast'); },
    vars: Object.freeze({
      '--amber': '#ffc247', '--red': '#ff6f5e', '--cyan': '#66e6ee',
      '--green': '#66e39a', '--hot': '#ffffff',
    }),
  }),
});

/* The furniture overlay for high-contrast mode. Composes ON TOP of whichever colour-vision
 * preset is selected, because the two needs are independent: a deuteranope in a bright room
 * wants both, and forcing them to choose is the bug. */
export const CONTRAST_VARS = Object.freeze({
  '--bg': '#000000', '--panel': '#080b0f', '--panel2': '#10151c', '--line': '#5a6a78',
  '--ink': '#ffffff', '--dim': '#cfd8e0', '--faint': '#9aa8b4',
});

/* GDD §18.5's interaction language as glyphs, so every treatment survives with the colour
 * removed. Five roles, five outlines that differ in SILHOUETTE and not merely in fill —
 * a filled circle and a filled square are one bad monitor away from being the same mark.
 * A silhouette is not language and is not localised. */
export const SHAPES = Object.freeze({
  ordinary: '□',      // white outline: ordinary interactable
  instrument: '◇',    // cyan brackets: instrument target or data source
  degraded: '△',      // amber pulse: degraded or uncertain state
  hazard: '✕',        // red segmented border: immediate hazard / failed condition
  custody: '▤',       // striped seal: custody-critical object
});

/* ── the model ────────────────────────────────────────────────────────────── */

/** Deep-frozen defaults. FOV comes from config.js so the menu and the renderer cannot
 *  disagree about what "normal" is. */
export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,

  input: Object.freeze({
    bindings: Object.freeze({}),          // empty means "the shipped table" — see bindings()
    holdModes: Object.freeze({ ...DEFAULT_HOLD_MODES }),
  }),

  /* §19.1: "subtitles with speaker, direction, size, opacity, and non-speech captions". */
  captions: Object.freeze({
    enabled: true,
    speaker: true,
    direction: true,
    nonSpeech: true,
    size: 15,            // px, before uiScale
    opacity: 0.9,
    maxLines: 3,
    holdMs: 4200,
  }),

  vision: Object.freeze({
    palette: 'default',
    highContrast: false,
    shapes: true,        // icon/shape redundancy on top of colour
    uiScale: 1.0,
  }),

  /* §19.1: adjustable FOV, shake, bob, blur, grain, distortion. All except fov are 0..1
   * INTENSITY MULTIPLIERS on the effect the renderer already wants to apply, so a renderer
   * reads one number and never branches on a setting name. */
  camera: Object.freeze({
    fov: CONFIG.render.fov,
    shake: 1,
    headBob: 1,
    motionBlur: 1,
    filmGrain: 1,
    distortion: 1,
  }),

  volume: Object.freeze({ master: 1, voice: 1, anomaly: 1, instruments: 1, ambience: 1, music: 1 }),

  /* §19.1's difficulty assists. Deliberately three levers and no "easy mode": §7.4 says
   * confidence rather than checklist completion, and an assist that answered the question
   * would delete the game rather than open it. `procedureTiming` widens the WINDOW to act;
   * it never widens the rule. */
  assists: Object.freeze({
    procedureTiming: 1.0,          // 1.0-2.0 multiplier on sustain/grace windows
    evidenceLegibility: 'standard',// standard | large | largest
    navigationAids: 'off',         // off | compass | minimap  (§18.2 permits it here only)
  }),

  safety: Object.freeze({
    photosensitive: false,
    contentWarnings: true,
    gore: 'standard',              // none | reduced | standard
  }),
});

/* The schema is the single description of every field: it validates the model AND builds
 * the panel. Two lists would drift, and the one that drifts is always the validator.
 *
 * ⚠ IT CARRIES NO PROSE. A group's name and blurb are `settings.group.<id>` and
 * `settings.blurb.<id>`; a field's label is `settings.field.<path>`, keyed by the same
 * dotted path the validator already uses, so there is exactly one place a field is named
 * and it is the place a translator opens. `groupLabel`, `groupBlurb` and `fieldLabel`
 * below are the accessors, exported because the pause screen will want two of them. */
export const SETTINGS_SCHEMA = Object.freeze([
  {
    id: 'controls',
    fields: [
      { path: 'input.holdModes.sprint', kind: 'choice', optionsKey: 'settings.opt.holdMode', options: [HOLD_MODE.HOLD, HOLD_MODE.TOGGLE] },
      { path: 'input.holdModes.crouch', kind: 'choice', optionsKey: 'settings.opt.holdMode', options: [HOLD_MODE.HOLD, HOLD_MODE.TOGGLE] },
      { path: 'input.holdModes.imager', kind: 'choice', optionsKey: 'settings.opt.holdMode', options: [HOLD_MODE.HOLD, HOLD_MODE.TOGGLE] },
    ],
  },
  {
    id: 'captions',
    fields: [
      { path: 'captions.enabled', kind: 'toggle' },
      { path: 'captions.nonSpeech', kind: 'toggle' },
      { path: 'captions.speaker', kind: 'toggle' },
      { path: 'captions.direction', kind: 'toggle' },
      { path: 'captions.size', kind: 'range', min: 11, max: 28, step: 1, unit: 'px' },
      { path: 'captions.opacity', kind: 'range', min: 0.2, max: 1, step: 0.05 },
      { path: 'captions.maxLines', kind: 'range', min: 1, max: 5, step: 1 },
      { path: 'captions.holdMs', kind: 'range', min: 1500, max: 12000, step: 100, unit: 'ms' },
    ],
  },
  {
    id: 'vision',
    fields: [
      { path: 'vision.palette', kind: 'choice', optionsKey: 'settings.palette', options: Object.keys(PALETTES) },
      { path: 'vision.highContrast', kind: 'toggle' },
      { path: 'vision.shapes', kind: 'toggle' },
      { path: 'vision.uiScale', kind: 'range', min: 0.8, max: 2.0, step: 0.05, unit: '×' },
    ],
  },
  {
    id: 'camera',
    fields: [
      { path: 'camera.fov', kind: 'range', min: 60, max: 110, step: 1, unit: '°' },
      { path: 'camera.shake', kind: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'camera.headBob', kind: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'camera.motionBlur', kind: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'camera.filmGrain', kind: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'camera.distortion', kind: 'range', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    id: 'audio',
    fields: [
      { path: 'volume.master', kind: 'range', min: 0, max: 1, step: 0.02 },
      { path: 'volume.voice', kind: 'range', min: 0, max: 1, step: 0.02 },
      { path: 'volume.anomaly', kind: 'range', min: 0, max: 1, step: 0.02 },
      { path: 'volume.instruments', kind: 'range', min: 0, max: 1, step: 0.02 },
      { path: 'volume.ambience', kind: 'range', min: 0, max: 1, step: 0.02 },
      { path: 'volume.music', kind: 'range', min: 0, max: 1, step: 0.02 },
    ],
  },
  {
    id: 'assists',
    fields: [
      { path: 'assists.procedureTiming', kind: 'range', min: 1, max: 2, step: 0.1, unit: '×' },
      { path: 'assists.evidenceLegibility', kind: 'choice', optionsKey: 'settings.opt.legibility', options: ['standard', 'large', 'largest'] },
      { path: 'assists.navigationAids', kind: 'choice', optionsKey: 'settings.opt.navigation', options: ['off', 'compass', 'minimap'] },
    ],
  },
  {
    id: 'safety',
    fields: [
      { path: 'safety.photosensitive', kind: 'toggle' },
      { path: 'safety.contentWarnings', kind: 'toggle' },
      { path: 'safety.gore', kind: 'choice', optionsKey: 'settings.opt.gore', options: ['none', 'reduced', 'standard'] },
    ],
  },
]);

/** The name of a schema group, its explanation, and the name of one field. */
export const groupLabel = (id) => msg(`settings.group.${id}`);
export const groupBlurb = (id) => msg(`settings.blurb.${id}`);
export const fieldLabel = (path) => msg(`settings.field.${path}`);

const FIELD_BY_PATH = new Map();
for (const group of SETTINGS_SCHEMA) for (const f of group.fields) FIELD_BY_PATH.set(f.path, f);

/** The schema entry for a dotted path, or null. Exported because the panel is not the only
 *  thing that will want to render a setting — the pause screen will want two of them. */
export function fieldFor(path) { return FIELD_BY_PATH.get(path) || null; }

/* ── persistence ──────────────────────────────────────────────────────────────
 *
 * Probe pattern copied from SmallTownEmergencyServices\src\core\persistence.js
 * (Dev\INDEX.md → "Storage probe"). ⚠ Testing `typeof localStorage` is not enough: a
 * locked-down profile, private mode, and a headless harness with storage partitioned off
 * all expose the object and THROW ON WRITE. The probe writes and removes a key, so the
 * only way to know it works is the only thing that proves it. A refused profile degrades
 * to no-save; it never degrades to a crash on the settings screen.
 */
export function probeStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__cd_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}

/** True when this profile can actually keep settings. The panel says so out loud rather
 *  than silently discarding every change the player makes. */
export function canPersist() { return probeStorage() !== null; }

export function saveSettings(plain) {
  const s = probeStorage();
  if (!s) return false;
  try { s.setItem(SETTINGS_KEY, JSON.stringify({ ...plain, version: SETTINGS_VERSION })); return true; }
  catch { return false; }
}

/**
 * ⚠ THE SAVE THAT COULD NOT BE READ WAS THROWN AWAY WITHOUT A WORD, and `progression.js`
 * spent this week learning why that is not acceptable. One slot; the newest unreadable
 * settings blob wins. Never read on the load path — it exists so a bug report can carry the
 * file that broke the boot.
 */
export const SETTINGS_QUARANTINE_KEY = 'cd.settings.unreadable';

export function loadSettings() {
  const s = probeStorage();
  if (!s) return null;
  let raw;
  try { raw = s.getItem(SETTINGS_KEY); } catch { return null; }
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { _quarantine(s, raw); return null; }
  const clean = migrateSettings(parsed);
  if (!clean) _quarantine(s, raw);
  return clean;
}

function _quarantine(s, raw) {
  try {
    if (typeof raw === 'string' && raw.length <= 512 * 1024) s.setItem(SETTINGS_QUARANTINE_KEY, raw);
  } catch { /* the profile refused the write; the original is still where it was */ }
}

/** The quarantined copy, for a rescue tool or a bug report. Never read on the load path. */
export function quarantinedSettings() {
  const s = probeStorage();
  if (!s) return null;
  try { return s.getItem(SETTINGS_QUARANTINE_KEY); } catch { return null; }
}

export function clearSettings() {
  const s = probeStorage();
  if (!s) return false;
  try { s.removeItem(SETTINGS_KEY); return true; } catch { return false; }
}

/**
 * ⚠ `__proto__` IS AN OWN PROPERTY AFTER `JSON.parse`, AND `setPath` WALKED INTO IT.
 *
 * This is the same defect `progression.js` was hardened against this week and it was worse
 * here, because it did not stop at the profile. `JSON.parse('{"__proto__":{"x":1}}')`
 * produces an object whose OWN keys include `__proto__`, so `patch`'s `Object.entries` walk
 * handed it over, built the path `__proto__.x`, and `setPath` did:
 *
 *     cur = this.values['__proto__']      // → Object.prototype, an object, so it descends
 *     cur['x'] = 1                        // → Object.prototype.x = 1
 *
 * — global prototype pollution of the whole page, on boot, from one word in localStorage.
 * And localStorage on GitHub Pages is keyed to the ORIGIN, which for `<user>.github.io` is
 * shared by every project that user has ever published. It is not a same-page-only reach.
 *
 * ⚠ THE OTHER HALF IS THAT AN UNREADABLE SAVE MUST NOT THROW ON BOOT. `Settings.restore()`
 * is called before anything is on screen, and `_recompute` reads `v.safety.photosensitive`
 * and `volumes()` does `name in this.values.volume` — so a blob with `"safety": null` or
 * `"volume": "x"` was a TypeError with no game behind it. A damaged save degrades to the
 * defaults, keeps a copy, and says which fields it refused.
 *
 * @returns {object|null} a save this build will apply, or null
 */
export function migrateSettings(data, refused = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.version !== SETTINGS_VERSION) return null;
  return sanitiseSettings(data, refused);
}

/** Keys that are never a settings path, whatever they are spelled as. */
const POISON_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * Rebuild a save from the shape this build has, dropping anything else.
 *
 * The whitelist is the DEFAULTS' own top-level keys: a group the defaults do not have is a
 * group nothing reads, and a group of the wrong type is one that crashes the first consumer
 * to touch it. `input.bindings` is opaque to the schema and goes through `sanitiseBindings`,
 * which is the validator `input.js` already exports and which `Settings.bindings()` was
 * never routed through.
 *
 * @param refused  optional array; every dropped key is pushed onto it, for the suite and
 *   for anyone who wants to tell a player what happened to their settings.
 */
export function sanitiseSettings(data, refused = null) {
  const note = (k, why) => { if (refused && refused.length < 40) refused.push(`${k}: ${why}`); };
  const out = { version: SETTINGS_VERSION };
  for (const key of Object.keys(data)) {
    if (key === 'version') continue;
    if (POISON_KEYS.includes(key)) { note(key, 'reserved key'); continue; }
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) { note(key, 'not a settings group'); continue; }
    const v = data[key];
    const want = DEFAULT_SETTINGS[key];
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof want !== 'object') {
      note(key, `is ${Array.isArray(v) ? 'an array' : v === null ? 'null' : typeof v}, not a group`);
      continue;
    }
    const group = {};
    for (const leaf of Object.keys(v)) {
      if (POISON_KEYS.includes(leaf)) { note(`${key}.${leaf}`, 'reserved key'); continue; }
      if (!Object.prototype.hasOwnProperty.call(want, leaf)) { note(`${key}.${leaf}`, 'not a field'); continue; }
      group[leaf] = v[leaf];
    }
    if (key === 'input') {
      /* Two opaque sub-tables, both with a validator already written for them next door and
       * neither of which the load path had ever been routed through. ⚠ EMPTY STILL MEANS
       * "THE SHIPPED TABLE" — see `bindings()` — so an empty table stays empty rather than
       * being expanded into a copy of the defaults that would then never follow them. */
      const b = group.bindings;
      group.bindings = (b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length)
        ? sanitiseBindings(b) : {};
      group.holdModes = sanitiseHoldModes(group.holdModes);
    }
    out[key] = group;
  }
  return out;
}

/* ── value plumbing ───────────────────────────────────────────────────────── */

/* ⚠ `out['__proto__'] = x` ON A PLAIN OBJECT DOES NOT CREATE A KEY — it calls the accessor
 * and replaces the object's prototype. `JSON.parse` puts `__proto__` in `Object.entries`,
 * so a copy of a save file was where that happened. Skipped, not copied. */
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) { if (!POISON_KEYS.includes(k)) out[k] = clone(x); }
    return out;
  }
  return v;
}

function getPath(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * ⚠ THIS FUNCTION IS WHERE THE PROTOTYPE POLLUTION HAPPENED, so the refusal lives here as
 * well as in `sanitiseSettings`. `Settings` is a public class: `new Settings(obj)` and
 * `patch(obj)` are both reachable without going near the load path, and a guard that is
 * only on the load path is a guard somebody routes around next month. `__proto__` as an
 * intermediate key made the walk DESCEND INTO `Object.prototype` and the last assignment
 * landed on it. Refused, and the write does not happen at all.
 */
function setPath(obj, path, value) {
  const keys = path.split('.');
  if (keys.some((k) => POISON_KEYS.includes(k))) return obj;
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null || Array.isArray(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

/** Snap a range value to its step, so a slider reports 0.85 and never 0.8500000000000001.
 *  ⚠ The rounding is done in step units and then multiplied back; rounding the value
 *  directly leaves float dust that makes two equal settings compare unequal. */
function quantise(v, min, max, step) {
  const clamped = Math.min(max, Math.max(min, v));
  if (!step) return clamped;
  const snapped = Math.round((clamped - min) / step) * step + min;
  const dp = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(dp));
}

/** Validate one value against its schema entry. Unknown paths pass through untouched, so
 *  a field that exists in the model but not yet in the schema is not silently deleted. */
export function coerce(path, value) {
  const f = FIELD_BY_PATH.get(path);
  if (!f) return { ok: true, value };
  if (f.kind === 'toggle') return { ok: true, value: !!value };
  if (f.kind === 'choice') {
    return f.options.includes(value) ? { ok: true, value } : { ok: false, reason: 'not-an-option' };
  }
  if (f.kind === 'range') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, reason: 'not-a-number' };
    return { ok: true, value: quantise(n, f.min, f.max, f.step) };
  }
  return { ok: true, value };
}

export class Settings {
  constructor(initial = null) {
    this.values = clone(DEFAULT_SETTINGS);
    /** Fired as (path, value, settings) after any accepted change. main.js hangs the
     *  audio buses, the renderer and the document's CSS variables off this one hook. */
    this.onChange = null;
    if (initial) this.patch(initial, { silent: true });
    this._recompute();
  }

  /** Load from storage if there is anything there; otherwise stay at the defaults. */
  static restore() {
    const raw = loadSettings();
    return new Settings(raw);
  }

  get(path) { return getPath(this.values, path); }

  /**
   * Write one value. Returns the coercion result, so a caller can tell "clamped to 2.0"
   * from "refused because that is not an option".
   */
  set(path, value, { silent = false } = {}) {
    const res = coerce(path, value);
    if (!res.ok) return res;
    setPath(this.values, path, res.value);
    this._recompute();
    if (!silent && this.onChange) this.onChange(path, res.value, this);
    return res;
  }

  /** Merge a nested object. Every leaf goes through set(), so a save file cannot smuggle
   *  an out-of-range field of view past the validator. */
  patch(obj, { silent = false } = {}) {
    const walk = (node, prefix) => {
      for (const [k, v] of Object.entries(node || {})) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (path === 'version') continue;
        /* input.bindings is opaque data owned by Input, not a schema field — it is copied
         * wholesale rather than walked, or every key code would be treated as a setting. */
        if (path === 'input.bindings') { setPath(this.values, path, clone(v) || {}); continue; }
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
        else this.set(path, v, { silent: true });
      }
    };
    walk(obj, '');
    this._recompute();
    if (!silent && this.onChange) this.onChange(null, null, this);
    return this;
  }

  /** Reset one schema group, or everything when called with no argument. */
  reset(groupId = null) {
    if (!groupId) {
      this.values = clone(DEFAULT_SETTINGS);
    } else {
      const group = SETTINGS_SCHEMA.find((g) => g.id === groupId);
      if (!group) return this;
      for (const f of group.fields) setPath(this.values, f.path, clone(getPath(DEFAULT_SETTINGS, f.path)));
      if (groupId === 'controls') this.values.input.bindings = {};
    }
    this._recompute();
    if (this.onChange) this.onChange(null, null, this);
    return this;
  }

  toJSON() { return clone({ ...this.values, version: SETTINGS_VERSION }); }

  static fromJSON(raw) { return new Settings(migrateSettings(raw)); }

  /** @returns {boolean} false when the profile refuses storage — say so in the UI. */
  save() { return saveSettings(this.toJSON()); }

  /* ── derived views ──────────────────────────────────────────────────────── */

  /**
   * The settings AFTER the safety clamps, which is what every consumer should read.
   *
   * ⚠ Photosensitivity-safe mode does not overwrite the player's sliders — it caps what is
   * applied. Turn it off again and the numbers the player chose are still there. A mode
   * that zeroed the stored values would quietly destroy a camera setup the player spent
   * five minutes on, and they would have no way to know it had happened.
   */
  get effective() { return this._effective; }

  /**
   * ⚠ THIS THREW ON BOOT FOR A SAVE THAT SAID `"safety": null`.
   *
   * `Settings.restore()` runs before anything is on screen and this is the first thing it
   * calls, so `v.safety.photosensitive` on a group that is not a group was a TypeError with
   * no game behind it — a blank page from one word in localStorage, and localStorage on
   * `<user>.github.io` is shared with every other project that user has published. The load
   * path refuses that shape now; this holds the line for `new Settings(anything)`, which is
   * public and does not go through it.
   */
  _recompute() {
    const v = this.values;
    const grp = (k) => (v[k] && typeof v[k] === 'object' && !Array.isArray(v[k]) ? v[k] : (v[k] = clone(DEFAULT_SETTINGS[k])));
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k !== 'version') grp(k);
    const safe = v.safety.photosensitive;
    const cam = { ...v.camera };
    if (safe) {
      /* The three that could become a flash or a rapid contrast change. FOV, bob and blur
       * are disorientation, not photosensitivity, and are left to the player. */
      cam.shake = Math.min(cam.shake, 0.25);
      cam.filmGrain = Math.min(cam.filmGrain, 0.35);
      cam.distortion = Math.min(cam.distortion, 0.25);
    }
    this._effective = Object.freeze({
      camera: Object.freeze(cam),
      /** Renderers and the HUD ask this before any strobe, alarm flash, or hard cut. */
      allowFlashes: !safe,
      captions: Object.freeze({ ...v.captions }),
      vision: Object.freeze({ ...v.vision }),
      assists: Object.freeze({ ...v.assists }),
      safety: Object.freeze({ ...v.safety }),
      volume: Object.freeze({ ...v.volume }),
      shapes: v.vision.shapes ? SHAPES : Object.freeze({ ordinary: '', instrument: '', degraded: '', hazard: '', custody: '' }),
    });
  }

  /** The gain map audio.setVolumes() wants. Keys are validated against BUSES so a renamed
   *  bus fails here, in one place, instead of silently doing nothing. */
  volumes() {
    const out = {};
    for (const name of BUSES) if (name in this.values.volume) out[name] = this.values.volume[name];
    return out;
  }

  holdModes() { return sanitiseHoldModes(this.values.input && this.values.input.holdModes); }

  /**
   * The saved binding table, or the shipped one when the player has never rebound.
   *
   * ⚠ IT WENT TO `new Input(...)` UNVALIDATED. `input.js` exports `sanitiseBindings` and
   * documents it as taking "a save file, a network payload"; the only caller was
   * `Input.fromJSON`, which the boot path does not use — `main.js` does
   * `new Input(window, settings.bindings(), …)`, and `Input.setBindings` goes straight to
   * `Array.from(codes)`. So `{"sprint": null}` in localStorage was `Array.from(null)`, a
   * TypeError, before the first frame. The validator existed; nothing on the boot path had
   * been pointed at it.
   */
  bindings() {
    const b = this.values.input && this.values.input.bindings;
    return b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length
      ? sanitiseBindings(b) : clone(DEFAULT_BINDINGS);
  }

  setBindings(table) {
    this.values.input.bindings = clone(table) || {};
    if (this.onChange) this.onChange('input.bindings', this.values.input.bindings, this);
    return this;
  }

  /**
   * Every CSS custom property the page should adopt. PLAIN OBJECT, NO DOM — this is the
   * half the headless suite can assert. `applyCssVars` is the two-line sink.
   *
   * Composition order is deliberate: the colour-vision preset supplies the five signal
   * hues, then high contrast overlays the furniture. Reversing it would let the contrast
   * overlay stomp a preset the player chose for a reason.
   */
  cssVars() {
    const v = this.values;
    const preset = PALETTES[v.vision.palette] || PALETTES.default;
    const evidence = { standard: 1, large: 1.15, largest: 1.32 }[v.assists.evidenceLegibility] || 1;
    const out = { ...preset.vars };
    if (v.vision.highContrast) Object.assign(out, CONTRAST_VARS);
    out['--cd-ui-scale'] = String(v.vision.uiScale);
    out['--cd-caption-size'] = `${v.captions.size}px`;
    out['--cd-caption-opacity'] = String(v.captions.opacity);
    out['--cd-evidence-scale'] = String(evidence);
    return out;
  }

  /** DOM sink. Guarded, so calling it in a headless test with no document is a no-op
   *  rather than the reason the suite cannot import this file. */
  applyCssVars(el) {
    if (!el || !el.style || typeof el.style.setProperty !== 'function') return false;
    for (const [k, val] of Object.entries(this.cssVars())) el.style.setProperty(k, val);
    if (el.classList) {
      el.classList.toggle('cd-shapes', !!this.values.vision.shapes);
      el.classList.toggle('cd-contrast', !!this.values.vision.highContrast);
      el.classList.toggle('cd-no-flash', !this._effective.allowFlashes);
    }
    return true;
  }
}

/* ── the screen ───────────────────────────────────────────────────────────── */

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

/**
 * Key codes whose cap carries a GLYPH rather than a word. These are not localised and must
 * not be: ↑ and ; and ` are the same mark on every keyboard in the world, and a translated
 * arrow is a worse arrow.
 *
 * ⚠ THE NAMED KEYS ARE THE OPPOSITE CASE and they used to be in this same table. A German
 * keyboard says Strg and Umschalt, a French one says Entrée; a rebinding list that insists
 * on Ctrl and Shift is telling that player to look for a key that is not on their keyboard.
 * Those live in the message table under `settings.key.<Code>` and are resolved below.
 */
const KEY_GLYPHS = Object.freeze({
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
});

/** Codes whose label is a WORD, and therefore a message. Listed so an unknown code can
 *  still fall through to printing itself, which is ugly and honest. */
const NAMED_KEYS = Object.freeze([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'Space', 'Tab', 'Enter', 'Backspace', 'CapsLock',
]);

/**
 * Human name for a key code. Anything unlisted prints its own code, which is ugly and
 * honest — a player who rebound to IntlBackslash should see IntlBackslash, not a guess,
 * and the same goes for the gamepad codes in DEFAULT_BINDINGS.
 */
export function keyLabel(code) {
  if (!code) return msg('settings.key.none');
  if (KEY_GLYPHS[code]) return KEY_GLYPHS[code];
  if (NAMED_KEYS.includes(code)) return msg(`settings.key.${code}`);
  /**
   * ⚠ THE PAD CODES PRINTED THEMSELVES, AND THEY ARE ONE VENDOR'S SILKSCREEN.
   *
   * Sixteen of them — `PadA`, `PadLB`, `PadRT`, `PadBack` — fell through to `return code`
   * along with `IntlBackslash`, and the argument for that fallback ("a player who rebound
   * to IntlBackslash should see IntlBackslash, not a guess") does not carry here. A key
   * code IS what is printed on the key. **A PlayStation pad has no A button and no LB**,
   * and a DualSense player reading "Sprint · PadLB" is being told to press something that
   * is not on the device in their hands.
   *
   * The ids stay as they are: they are compared against, they are written into a save, and
   * they are the same id-and-label split the palette presets above make. What changes is
   * the word — and the word comes from the layout these indices actually belong to. The
   * W3C Standard Gamepad names POSITIONS, not letters: index 0 is the bottom face button on
   * every pad ever made, whether that button says A, ✕ or B. So the labels say where the
   * button is, which is true everywhere, instead of what one manufacturer wrote on it.
   *
   * `settings.key.pad.<code>` and not a table here, because these are WORDS.
   */
  if (code.startsWith('Pad')) return msg(`settings.key.pad.${code}`);
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return msg('settings.key.numpad', { key: code.slice(6) });
  return code;
}

/**
 * The ORDER the controls list uses. The wording is `settings.action.<id>`.
 *
 * ⚠ `comms` WAS MISSING FROM THIS LIST while being present in DEFAULT_BINDINGS, so the ping
 * wheel was bound to Z and could not be rebound — and §19.1 opens the controls group with
 * "every action can be moved". A list that decides which actions are rebindable by omission
 * is a list that silently removes one.
 */
const ACTION_ORDER = Object.freeze([
  'moveUp', 'moveDown', 'moveLeft', 'moveRight',
  'sprint', 'crouch',
  'interact', 'use', 'imager', 'tablet', 'comms', 'abort', 'settings',
  'slot1', 'slot2', 'slot3', 'slot4', 'slot5',
]);

/** The name of a bindable action. Unknown ids print themselves rather than nothing. */
export const actionLabel = (action) => (ACTION_ORDER.includes(action) ? msg(`settings.action.${action}`) : action);

/**
 * The settings screen. Same contract as Panels — `show()`, `hide()`, `isOpen` — and the
 * same `.cd-panel` markup, so it inherits the house look from index.html without a second
 * stylesheet.
 *
 * @param {HTMLElement} root      where the panel mounts (document.body, as Panels does)
 * @param {Settings} settings     the model. The panel owns none of these values.
 * @param {object} opts           {input, onClose, onChange}
 */
export class SettingsPanel {
  constructor(root, settings, { input = null, onClose = null, onChange = null } = {}) {
    this.settings = settings;
    this.input = input;
    this.onClose = onClose || (() => {});
    this.onChange = onChange || (() => {});
    this.node = el('div', 'cd-panel cd-settings', root);
    this.node.style.display = 'none';
    this.open = null;
    this.tab = 'controls';
    /** Which action is waiting for a keystroke, or null. */
    this.awaiting = null;
    this.flash = '';       // the one-line result of the last rebind attempt
  }

  get isOpen() { return this.open !== null; }

  show(tab = this.tab) {
    this.open = 'settings';
    this.tab = tab;
    this._render();
    return this;
  }

  hide() {
    /* ⚠ Leaving a capture armed would eat the next keystroke in the GAME. Cancel first,
     * always, including on the path where the player closes the panel with the mouse. */
    if (this.input) this.input.cancelCapture();
    this.awaiting = null;
    this.open = null;
    this.node.style.display = 'none';
    this.onClose();
    return this;
  }

  _shell(title, sub, body, footer) {
    this.node.style.display = 'flex';
    this.node.innerHTML = `
      <div class="sheet">
        <header><h1>${title}</h1><p>${sub}</p></header>
        <div class="body">${body}</div>
        <footer>${footer}</footer>
      </div>`;
  }

  _render() {
    const nav = SETTINGS_SCHEMA.map((g) =>
      `<button data-tab="${g.id}" class="${g.id === this.tab ? 'on' : ''}">${escapeHtml(groupLabel(g.id))}</button>`).join('');
    const group = SETTINGS_SCHEMA.find((g) => g.id === this.tab) || SETTINGS_SCHEMA[0];

    const body = `<div class="pad">
      <p class="small">${escapeHtml(groupBlurb(group.id))}</p>
      <div class="setgrid">${group.fields.map((f) => this._field(f)).join('')}</div>
      ${this.tab === 'controls' ? this._bindings() : ''}
      ${this.tab === 'vision' ? this._swatches() : ''}
      ${this.flash ? `<p class="setflash">${escapeHtml(this.flash)}</p>` : ''}
    </div>`;

    const persist = canPersist()
      ? `<span class="waiting">${msg('settings.savedHere')}</span>`
      : `<span class="waiting">${msg('settings.noStorage')}</span>`;

    /* ⚠ THE GROUP NAME KEEPS ITS OWN CASE. This read `Reset ${group.label.toLowerCase()}`,
     * and lower-casing a translated noun is wrong in German (every noun is capitalised) and
     * dangerous in Turkish (I lower-cases to a dotless ı). The message carries the sentence
     * and the label arrives as the table spells it. */
    this._shell(msg('settings.title'), msg('settings.sub'),
      `<nav class="tabs">${nav}</nav>${body}`,
      `${persist}<button class="ghost" data-reset>${
        escapeHtml(msg('settings.reset', { group: groupLabel(group.id) }))
      }</button><button class="go" data-close>${msg('settings.close')}</button>`);

    this._wire(group);
  }

  _field(f) {
    const v = this.settings.get(f.path);
    const id = f.path.replace(/\./g, '-');
    const label = fieldLabel(f.path);
    if (f.kind === 'toggle') {
      return `<label class="setrow chk" for="${id}">
        <input type="checkbox" id="${id}" data-path="${f.path}" ${v ? 'checked' : ''}>
        <span>${escapeHtml(label)}</span></label>`;
    }
    if (f.kind === 'choice') {
      const opts = f.options.map((o) => {
        const text = f.optionsKey ? msg(`${f.optionsKey}.${o}`) : o;
        return `<option value="${escapeHtml(o)}" ${v === o ? 'selected' : ''}>${escapeHtml(text)}</option>`;
      }).join('');
      return `<label class="setrow" for="${id}"><span>${escapeHtml(label)}</span>
        <select id="${id}" data-path="${f.path}">${opts}</select></label>`;
    }
    const shown = `${v}${f.unit || ''}`;
    return `<label class="setrow" for="${id}"><span>${escapeHtml(label)}</span>
      <input type="range" id="${id}" data-path="${f.path}" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}">
      <b class="setval" data-val="${f.path}">${escapeHtml(shown)}</b></label>`;
  }

  /* The remapping list. Reads the live Input, not the saved copy, so what is on screen is
   * what the keyboard will actually do. */
  _bindings() {
    if (!this.input) return `<p class="small">${msg('settings.bindings.noInput')}</p>`;
    const rows = ACTION_ORDER
      .filter((a) => a in this.input.bindings)
      .map((action) => {
        const codes = this.input.bindingFor(action);
        const keys = codes.length
          ? codes.map((c) => `<kbd>${escapeHtml(keyLabel(c))}</kbd>`).join(' ')
          : `<em class="unbound">${msg('settings.bindings.unbound')}</em>`;
        const waiting = this.awaiting === action;
        return `<tr class="${waiting ? 'awaiting' : ''}">
          <td class="name"><b>${escapeHtml(actionLabel(action))}</b></td>
          <td class="keys">${waiting ? `<em class="press">${msg('settings.bindings.awaiting')}</em>` : keys}</td>
          <td class="qty"><button data-bind="${action}">${
  waiting ? msg('settings.bindings.cancel') : msg('settings.bindings.change')}</button></td>
        </tr>`;
      }).join('');
    return `<h2>${msg('settings.bindings.head')}</h2>
      <table class="items binds"><tbody>${rows}</tbody></table>
      <p class="small">${msg('settings.bindings.note')}</p>`;
  }

  /* Colour is never the only channel, so the preview shows the glyph beside the swatch —
   * it is also the fastest way for a player to check that the preset actually helps. */
  _swatches() {
    const roles = [
      ['--green', 'ordinary'],
      ['--cyan', 'instrument'],
      ['--amber', 'degraded'],
      ['--red', 'hazard'],
      ['--hot', 'custody'],
    ];
    const vars = this.settings.cssVars();
    const cells = roles.map(([varName, shapeKey]) =>
      `<li><i style="background:${escapeHtml(vars[varName] || '')}"></i>
        <b>${escapeHtml(SHAPES[shapeKey])}</b><span>${escapeHtml(msg(`settings.swatch.${shapeKey}`))}</span></li>`).join('');
    return `<h2>${msg('settings.swatch.head')}</h2><ul class="swatches">${cells}</ul>`;
  }

  _wire(group) {
    const q = (s) => this.node.querySelector(s);
    this.node.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
      if (this.input) this.input.cancelCapture();
      this.awaiting = null; this.flash = '';
      this.show(b.dataset.tab);
    });
    q('[data-close]').onclick = () => this.hide();
    q('[data-reset]').onclick = () => {
      this.settings.reset(group.id);
      if (group.id === 'controls' && this.input) {
        this.input.resetBindings();
        this.input.setHoldModes(this.settings.holdModes());
      }
      this.flash = msg('settings.flash.groupReset', { group: groupLabel(group.id) });
      this._commit();
    };

    /* Ranges write on `input` so the number under the thumb follows the drag, but they do
     * NOT re-render the panel — rebuilding the DOM mid-drag drops the pointer capture and
     * the slider stops following the mouse. Only the readout is touched. */
    this.node.querySelectorAll('input[type=range]').forEach((r) => {
      r.oninput = () => {
        const path = r.dataset.path;
        const res = this.settings.set(path, r.value);
        const f = fieldFor(path);
        const out = this.node.querySelector(`[data-val="${path}"]`);
        if (out && res.ok) out.textContent = `${res.value}${(f && f.unit) || ''}`;
        this.onChange(path, res.value, this.settings);
      };
      r.onchange = () => this._persist();
    });
    this.node.querySelectorAll('input[type=checkbox]').forEach((c) => c.onchange = () => {
      this.settings.set(c.dataset.path, c.checked);
      this.onChange(c.dataset.path, c.checked, this.settings);
      this._commit();
    });
    this.node.querySelectorAll('select[data-path]').forEach((s) => s.onchange = () => {
      const path = s.dataset.path;
      this.settings.set(path, s.value);
      /* Hold/toggle is resolved inside Input, so the model change has to reach it. */
      if (path.startsWith('input.holdModes.') && this.input) {
        this.input.setHoldMode(path.split('.').pop(), s.value);
      }
      this.onChange(path, s.value, this.settings);
      this._commit();
    });

    this.node.querySelectorAll('[data-bind]').forEach((b) => b.onclick = () => {
      const action = b.dataset.bind;
      if (!this.input) return;
      if (this.awaiting === action) { this.input.cancelCapture(); this.awaiting = null; this.flash = ''; this._render(); return; }
      this.awaiting = action;
      this.flash = '';
      this._render();
      this.input.captureNext((code, reserved) => {
        this.awaiting = null;
        if (reserved) {
          this.flash = msg('settings.flash.reserved', { key: keyLabel(code) });
          this._render();
          return;
        }
        const res = this.input.rebind(action, code);
        /* ⚠ `refused: ${res.reason}` PRINTED A MACHINE WORD AT A PERSON — 'bad-code',
         * 'unknown-action'. The reason is an id and stays one; the sentence is keyed by it,
         * so each refusal is a whole message rather than a colon and a token. */
        if (!res.ok) this.flash = msg(`settings.flash.refused.${res.reason}`, { key: keyLabel(code) });
        else if (res.displaced.length) {
          this.flash = msg('settings.flash.displaced', {
            key: keyLabel(code),
            actions: res.displaced.map((a) => actionLabel(a)).join(', '),
          });
        } else this.flash = msg('settings.flash.bound', { key: keyLabel(code), action: actionLabel(action) });
        this.settings.setBindings(this.input.bindingsToJSON());
        this._commit();
      });
    });
  }

  /** Re-render and write through. The panel is cheap to rebuild — it is a form, not a
   *  60Hz HUD — so there is no diffing here and no signature cache. */
  _commit() {
    this._persist();
    this._render();
  }

  _persist() {
    this.settings.save();
    this.onChange(null, null, this.settings);
  }
}
