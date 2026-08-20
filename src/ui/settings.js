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
import { DEFAULT_HOLD_MODES, HOLD_MODE, HOLDABLE, DEFAULT_BINDINGS } from '../core/input.js';
import { escapeHtml } from './hud.js';

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
 */
export const PALETTES = Object.freeze({
  default: Object.freeze({
    label: 'Default',
    vars: Object.freeze({
      '--amber': '#e5a13a', '--red': '#e0503f', '--cyan': '#5fd0d8',
      '--green': '#5fbe86', '--hot': '#fff4d8',
    }),
  }),
  /* Deuteranopia and protanopia both lose the red-green axis; the blue-yellow axis is
   * intact, so the five roles are pulled onto it. Values are the Okabe-Ito set, which is
   * the one with published separation figures rather than the one that looked right. */
  deuteranopia: Object.freeze({
    label: 'Deuteranopia (green-weak)',
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
    label: 'Protanopia (red-weak)',
    vars: Object.freeze({
      '--amber': '#f0e442', '--red': '#e26fb4', '--cyan': '#56b4e9',
      '--green': '#0072b2', '--hot': '#fff4d8',
    }),
  }),
  /* Tritanopia is the other way round: the red-green axis survives and blue-yellow does
   * not, so red and green stay exactly as authored and the instrument cyan moves to violet
   * where it cannot be confused with the powered-circuit green. */
  tritanopia: Object.freeze({
    label: 'Tritanopia (blue-weak)',
    vars: Object.freeze({
      '--amber': '#ff9d00', '--red': '#e0503f', '--cyan': '#b06fe0',
      '--green': '#5fbe86', '--hot': '#ffffff',
    }),
  }),
  highContrast: Object.freeze({
    label: 'High contrast',
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
 * a filled circle and a filled square are one bad monitor away from being the same mark. */
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
 * the panel. Two lists would drift, and the one that drifts is always the validator. */
export const SETTINGS_SCHEMA = Object.freeze([
  {
    id: 'controls', label: 'Controls',
    blurb: 'Every action can be moved. Keys the browser owns — Escape, F5, F12 — are refused, '
      + 'because a key that also reloads the page is not a binding.',
    fields: [
      { path: 'input.holdModes.sprint', label: 'Sprint', kind: 'choice', options: [HOLD_MODE.HOLD, HOLD_MODE.TOGGLE] },
      { path: 'input.holdModes.crouch', label: 'Crouch', kind: 'choice', options: [HOLD_MODE.HOLD, HOLD_MODE.TOGGLE] },
      { path: 'input.holdModes.imager', label: 'Thermal imager', kind: 'choice', options: [HOLD_MODE.HOLD, HOLD_MODE.TOGGLE] },
    ],
  },
  {
    id: 'captions', label: 'Captions',
    blurb: 'Every audio cue in the build has a written line (GDD §17.3). Non-speech captions '
      + 'are bracketed; direction is shown where the sound has one.',
    fields: [
      { path: 'captions.enabled', label: 'Captions', kind: 'toggle' },
      { path: 'captions.nonSpeech', label: 'Non-speech captions', kind: 'toggle' },
      { path: 'captions.speaker', label: 'Show speaker', kind: 'toggle' },
      { path: 'captions.direction', label: 'Show direction', kind: 'toggle' },
      { path: 'captions.size', label: 'Size', kind: 'range', min: 11, max: 28, step: 1, unit: 'px' },
      { path: 'captions.opacity', label: 'Background opacity', kind: 'range', min: 0.2, max: 1, step: 0.05 },
      { path: 'captions.maxLines', label: 'Lines on screen', kind: 'range', min: 1, max: 5, step: 1 },
      { path: 'captions.holdMs', label: 'Hold time', kind: 'range', min: 1500, max: 12000, step: 100, unit: 'ms' },
    ],
  },
  {
    id: 'vision', label: 'Vision',
    blurb: 'Colour presets change the five signal colours only. Shape redundancy is on by '
      + 'default and should stay on — §18.5 requires every treatment to work without colour.',
    fields: [
      { path: 'vision.palette', label: 'Colour vision', kind: 'choice', options: Object.keys(PALETTES), labels: PALETTES },
      { path: 'vision.highContrast', label: 'High contrast', kind: 'toggle' },
      { path: 'vision.shapes', label: 'Shape and icon redundancy', kind: 'toggle' },
      { path: 'vision.uiScale', label: 'UI scale', kind: 'range', min: 0.8, max: 2.0, step: 0.05, unit: '×' },
    ],
  },
  {
    id: 'camera', label: 'Camera',
    blurb: 'Field of view and five effect intensities. Photosensitivity-safe mode clamps '
      + 'shake, grain and distortion regardless of what is set here.',
    fields: [
      { path: 'camera.fov', label: 'Field of view', kind: 'range', min: 60, max: 110, step: 1, unit: '°' },
      { path: 'camera.shake', label: 'Camera shake', kind: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'camera.headBob', label: 'Head bob', kind: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'camera.motionBlur', label: 'Motion blur', kind: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'camera.filmGrain', label: 'Film grain', kind: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'camera.distortion', label: 'Lens distortion', kind: 'range', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    id: 'audio', label: 'Audio',
    blurb: 'Five separate buses. Turning anomaly cues down never removes information — the '
      + 'caption channel carries the same content.',
    fields: [
      { path: 'volume.master', label: 'Master', kind: 'range', min: 0, max: 1, step: 0.02 },
      { path: 'volume.voice', label: 'Voice', kind: 'range', min: 0, max: 1, step: 0.02 },
      { path: 'volume.anomaly', label: 'Anomaly cues', kind: 'range', min: 0, max: 1, step: 0.02 },
      { path: 'volume.instruments', label: 'Instruments', kind: 'range', min: 0, max: 1, step: 0.02 },
      { path: 'volume.ambience', label: 'Ambience', kind: 'range', min: 0, max: 1, step: 0.02 },
      { path: 'volume.music', label: 'Music', kind: 'range', min: 0, max: 1, step: 0.02 },
    ],
  },
  {
    id: 'assists', label: 'Assists',
    blurb: 'These widen the window to act and the size of what you read. None of them tells '
      + 'you what the anomaly is — that is the part the game is made of.',
    fields: [
      { path: 'assists.procedureTiming', label: 'Procedure timing', kind: 'range', min: 1, max: 2, step: 0.1, unit: '×' },
      { path: 'assists.evidenceLegibility', label: 'Evidence legibility', kind: 'choice', options: ['standard', 'large', 'largest'] },
      { path: 'assists.navigationAids', label: 'Navigation aid', kind: 'choice', options: ['off', 'compass', 'minimap'] },
    ],
  },
  {
    id: 'safety', label: 'Safety',
    blurb: 'Photosensitivity-safe mode suppresses flashes and rapid contrast changes. The '
      + 'slice contains no gore; the setting is here so content added later has a switch '
      + 'that already exists rather than one bolted on afterwards.',
    fields: [
      { path: 'safety.photosensitive', label: 'Photosensitivity-safe mode', kind: 'toggle' },
      { path: 'safety.contentWarnings', label: 'Content warnings', kind: 'toggle' },
      { path: 'safety.gore', label: 'Gore', kind: 'choice', options: ['none', 'reduced', 'standard'] },
    ],
  },
]);

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

export function loadSettings() {
  const s = probeStorage();
  if (!s) return null;
  let raw;
  try { raw = s.getItem(SETTINGS_KEY); } catch { return null; }
  if (!raw) return null;
  try { return migrateSettings(JSON.parse(raw)); } catch { return null; }
}

export function clearSettings() {
  const s = probeStorage();
  if (!s) return false;
  try { s.removeItem(SETTINGS_KEY); return true; } catch { return false; }
}

/** An unknown or damaged save falls back to the defaults rather than half-applying itself.
 *  Future versions get their branch here; version 1 simply is the shape. */
export function migrateSettings(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.version !== SETTINGS_VERSION) return null;
  return data;
}

/* ── value plumbing ───────────────────────────────────────────────────────── */

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
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

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
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

  _recompute() {
    const v = this.values;
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

  holdModes() { return { ...this.values.input.holdModes }; }

  /** The saved binding table, or the shipped one when the player has never rebound. */
  bindings() {
    const b = this.values.input.bindings;
    return b && Object.keys(b).length ? clone(b) : clone(DEFAULT_BINDINGS);
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

/** Human names for key codes. Anything unlisted prints its own code, which is ugly and
 *  honest — a player who rebound to IntlBackslash should see IntlBackslash, not a guess. */
const KEY_LABELS = Object.freeze({
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
  AltLeft: 'L Alt', AltRight: 'R Alt', Space: 'Space', Tab: 'Tab', Enter: 'Enter',
  Backspace: 'Backspace', CapsLock: 'Caps', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
});

export function keyLabel(code) {
  if (!code) return '—';
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/** The order and the wording the controls list uses. Actions the player never presses
 *  deliberately (there are none yet) would simply be left off. */
const ACTION_LABELS = Object.freeze({
  moveUp: 'Move forward', moveDown: 'Move back', moveLeft: 'Move left', moveRight: 'Move right',
  sprint: 'Sprint', crouch: 'Crouch',
  interact: 'Context verb', use: 'Use or deploy held item', imager: 'Thermal imager',
  tablet: 'Field tablet', abort: 'Abort procedure', settings: 'Settings',
  slot1: 'Slot 1', slot2: 'Slot 2', slot3: 'Slot 3', slot4: 'Slot 4', slot5: 'Slot 5',
});

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
      `<button data-tab="${g.id}" class="${g.id === this.tab ? 'on' : ''}">${g.label}</button>`).join('');
    const group = SETTINGS_SCHEMA.find((g) => g.id === this.tab) || SETTINGS_SCHEMA[0];

    const body = `<div class="pad">
      <p class="small">${escapeHtml(group.blurb)}</p>
      <div class="setgrid">${group.fields.map((f) => this._field(f)).join('')}</div>
      ${this.tab === 'controls' ? this._bindings() : ''}
      ${this.tab === 'vision' ? this._swatches() : ''}
      ${this.flash ? `<p class="setflash">${escapeHtml(this.flash)}</p>` : ''}
    </div>`;

    const persist = canPersist()
      ? '<span class="waiting">Saved to this browser.</span>'
      : '<span class="waiting">This browser refuses local storage — settings last until you close the tab.</span>';

    this._shell('Settings', 'Accessibility baseline — GDD §19',
      `<nav class="tabs">${nav}</nav>${body}`,
      `${persist}<button class="ghost" data-reset>Reset ${escapeHtml(group.label.toLowerCase())}</button><button class="go" data-close>Close</button>`);

    this._wire(group);
  }

  _field(f) {
    const v = this.settings.get(f.path);
    const id = f.path.replace(/\./g, '-');
    if (f.kind === 'toggle') {
      return `<label class="setrow chk" for="${id}">
        <input type="checkbox" id="${id}" data-path="${f.path}" ${v ? 'checked' : ''}>
        <span>${escapeHtml(f.label)}</span></label>`;
    }
    if (f.kind === 'choice') {
      const opts = f.options.map((o) => {
        const text = f.labels && f.labels[o] ? f.labels[o].label : o;
        return `<option value="${escapeHtml(o)}" ${v === o ? 'selected' : ''}>${escapeHtml(text)}</option>`;
      }).join('');
      return `<label class="setrow" for="${id}"><span>${escapeHtml(f.label)}</span>
        <select id="${id}" data-path="${f.path}">${opts}</select></label>`;
    }
    const shown = `${v}${f.unit || ''}`;
    return `<label class="setrow" for="${id}"><span>${escapeHtml(f.label)}</span>
      <input type="range" id="${id}" data-path="${f.path}" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}">
      <b class="setval" data-val="${f.path}">${escapeHtml(shown)}</b></label>`;
  }

  /* The remapping list. Reads the live Input, not the saved copy, so what is on screen is
   * what the keyboard will actually do. */
  _bindings() {
    if (!this.input) return '<p class="small">No input device attached.</p>';
    const rows = Object.keys(ACTION_LABELS)
      .filter((a) => a in this.input.bindings)
      .map((action) => {
        const codes = this.input.bindingFor(action);
        const keys = codes.length
          ? codes.map((c) => `<kbd>${escapeHtml(keyLabel(c))}</kbd>`).join(' ')
          : '<em class="unbound">unbound</em>';
        const waiting = this.awaiting === action;
        return `<tr class="${waiting ? 'awaiting' : ''}">
          <td class="name"><b>${escapeHtml(ACTION_LABELS[action])}</b></td>
          <td class="keys">${waiting ? '<em class="press">press a key…</em>' : keys}</td>
          <td class="qty"><button data-bind="${action}">${waiting ? 'Cancel' : 'Change'}</button></td>
        </tr>`;
      }).join('');
    return `<h2>Key bindings</h2>
      <table class="items binds"><tbody>${rows}</tbody></table>
      <p class="small">Binding a key that is already in use takes it off the other action and says so.</p>`;
  }

  /* Colour is never the only channel, so the preview shows the glyph beside the swatch —
   * it is also the fastest way for a player to check that the preset actually helps. */
  _swatches() {
    const roles = [
      ['--green', 'ordinary', 'Powered / nominal'],
      ['--cyan', 'instrument', 'Instrument target'],
      ['--amber', 'degraded', 'Degraded or uncertain'],
      ['--red', 'hazard', 'Immediate hazard'],
      ['--hot', 'custody', 'Custody-critical'],
    ];
    const vars = this.settings.cssVars();
    const cells = roles.map(([varName, shapeKey, label]) =>
      `<li><i style="background:${escapeHtml(vars[varName] || '')}"></i>
        <b>${escapeHtml(SHAPES[shapeKey])}</b><span>${escapeHtml(label)}</span></li>`).join('');
    return `<h2>Signal preview</h2><ul class="swatches">${cells}</ul>`;
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
      this.flash = `${group.label} reset.`;
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
          this.flash = `${keyLabel(code)} belongs to the browser and cannot be bound.`;
          this._render();
          return;
        }
        const res = this.input.rebind(action, code);
        if (!res.ok) this.flash = `${keyLabel(code)} refused: ${res.reason}.`;
        else if (res.displaced.length) {
          this.flash = `${keyLabel(code)} bound. It was taken off `
            + res.displaced.map((a) => ACTION_LABELS[a] || a).join(', ') + '.';
        } else this.flash = `${keyLabel(code)} bound to ${ACTION_LABELS[action] || action}.`;
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
