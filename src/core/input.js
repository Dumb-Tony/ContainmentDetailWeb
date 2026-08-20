/* Input abstraction — GDD §18.5, §19.1.
 *
 * Systems ask for ACTIONS ('sprint', 'imager', 'interact'), never for KeyW. The binding
 * table is data, so full remapping (GDD §19.1 "full remapping for keyboard/mouse") is a
 * data edit and not a code edit.
 *
 * Two query shapes, because gameplay needs both:
 *   isDown(action)     held this frame  — movement, sprint, crouch
 *   wasPressed(action) edge this step   — interact, use, imager, slot select
 * wasPressed is cleared by endStep(), which the fixed-step loop calls. That keeps input
 * edges aligned to simulation steps rather than to render frames.
 *
 * HOLD VERSUS TOGGLE IS RESOLVED HERE AND NOWHERE ELSE (GDD §19.1). A player who cannot
 * hold Shift for four minutes sets sprint to toggle; `isDown('sprint')` then means exactly
 * what it meant before, and player.js never learns the setting exists. The pattern is
 * copied from MoversFromHell\src\core\input.js (Dev\INDEX.md → "Action-based input"), with
 * one addition it did not need: this game consumes the imager as an EDGE, so hold mode for
 * an edge action has to synthesise the closing edge. See HOLDABLE below.
 */

/* ⚠ THIS TABLE IS THE ONE THE GAME RUNS ON. main.js used to carry a private copy of the
 * binding map, which meant a rebinding UI could edit a table the game never read. If you
 * add an action, add it here — there must be exactly one binding table in the build. */
export const DEFAULT_BINDINGS = Object.freeze({
  moveUp:    ['KeyW', 'ArrowUp'],
  moveDown:  ['KeyS', 'ArrowDown'],
  moveLeft:  ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  sprint:    ['ShiftLeft', 'ShiftRight', 'PadLS'],
  crouch:    ['ControlLeft', 'KeyC', 'PadB'],
  interact:  ['KeyF', 'PadA'],
  use:       ['KeyE', 'PadX'],
  imager:    ['KeyQ', 'PadLB'],
  tablet:    ['Tab', 'PadBack'],
  abort:     ['KeyR', 'PadY'],
  settings:  ['KeyO', 'PadStart'],
  comms:     ['KeyZ', 'PadRB'],
  slot1: ['Digit1', 'PadLeft'], slot2: ['Digit2', 'PadUp'], slot3: ['Digit3', 'PadRight'],
  slot4: ['Digit4', 'PadDown'], slot5: ['Digit5', 'PadRT'],
});

/* Codes the page must never swallow, and therefore must never be bindable.
 *
 * ⚠ Two different failures live in this list and both were worth a rule. Binding an action
 * to F5 or F12 gives the player a key that reloads the page or opens devtools *as well as*
 * firing the action, because preventDefault does not hold for the browser's own chrome.
 * Binding one to Escape is worse: Escape is how the user leaves pointer lock, the browser
 * reserves it unconditionally, and a game that appears to steal it looks broken. F1 is on
 * the list for a quieter reason: Chrome opens its help centre in a NEW TAB, which takes
 * focus off a game that has just lost pointer lock and cannot ask for it back.
 *
 * Modifier chords (Ctrl+W, Alt+F4) never reach us as a single `code`, so they need no
 * entry — a bare ControlLeft binding is safe and is in fact the default for crouch. */
export const RESERVED_CODES = Object.freeze([
  'Escape', 'F1', 'F5', 'F6', 'F10', 'F11', 'F12',
  'MetaLeft', 'MetaRight', 'ContextMenu', 'PrintScreen', 'ScrollLock', 'Pause',
]);

const RESERVED = new Set(RESERVED_CODES);

/** Is this code refused by the rebinder? Exported so the settings panel can grey it out. */
export function isReservedCode(code) { return RESERVED.has(code); }

export const HOLD_MODE = Object.freeze({ HOLD: 'hold', TOGGLE: 'toggle' });

/* Which actions offer a hold/toggle choice, and HOW THE GAME CONSUMES THEM. The second
 * half is the load-bearing part:
 *
 *   'sustained' — gameplay calls isDown(). In toggle mode the latch IS the held state.
 *   'edge'      — gameplay calls wasPressed() and flips its own state (game.toggleImager).
 *                 Toggle mode is therefore the natural one and needs no work. HOLD mode is
 *                 the one that needs help: the key going down gives one edge, and we
 *                 synthesise a second edge when it comes back up, so the thing the player
 *                 was holding switches off when they let go.
 *
 * ⚠ For an 'edge' action the input layer does not know the game's state, only that it
 * asked for a flip. If something else turns the imager off — a dead battery, a client
 * rejection — hold mode is momentarily inverted until the next press re-syncs it. That is
 * the price of not making the simulation aware of the accessibility setting, and it is
 * cheaper than the alternative. */
export const HOLDABLE = Object.freeze({
  sprint: 'sustained',
  crouch: 'sustained',
  imager: 'edge',
  comms: 'sustained',
});

/** GDD §19.1 defaults: nothing changes for a player who never opens the menu. */
export const DEFAULT_HOLD_MODES = Object.freeze({
  sprint: HOLD_MODE.HOLD,
  crouch: HOLD_MODE.HOLD,
  imager: HOLD_MODE.TOGGLE,
  comms: HOLD_MODE.HOLD,
});

/* ⚠ Object.freeze is SHALLOW. DEFAULT_BINDINGS' arrays are not frozen, so a rebind that
 * pushed into `this.bindings.sprint` would edit the defaults themselves and resetBindings()
 * would restore the corruption. Everything that leaves or enters the table is copied. */
function cloneBindings(src) {
  const out = {};
  for (const [action, codes] of Object.entries(src)) out[action] = Array.from(codes);
  return out;
}

/** Accepts anything (a save file, a network payload) and returns a table the Input can
 *  run on. Unknown actions and reserved or non-string codes are dropped rather than
 *  refused: a settings file from an older build must still boot the game. */
export function sanitiseBindings(raw, defaults = DEFAULT_BINDINGS) {
  const out = cloneBindings(defaults);
  if (!raw || typeof raw !== 'object') return out;
  for (const [action, codes] of Object.entries(raw)) {
    if (!(action in out)) continue;
    if (!Array.isArray(codes)) continue;
    const clean = codes.filter((c) => typeof c === 'string' && c.length > 0 && !RESERVED.has(c));
    /* An action bound to nothing is legal — the player may want the key back. */
    out[action] = Array.from(new Set(clean));
  }
  return out;
}

/** Same treatment for the hold/toggle map. */
export function sanitiseHoldModes(raw) {
  const out = { ...DEFAULT_HOLD_MODES };
  if (!raw || typeof raw !== 'object') return out;
  for (const [action, mode] of Object.entries(raw)) {
    if (!(action in HOLDABLE)) continue;
    if (mode !== HOLD_MODE.HOLD && mode !== HOLD_MODE.TOGGLE) continue;
    out[action] = mode;
  }
  return out;
}

/* ── the controller (GDD §19.1, §27.1) ────────────────────────────────────────
 *
 * §27.1's Definition of Done requires "keyboard/mouse and controller flows work", and
 * §19.1 asks for remapping. Both come almost free, because nothing above this file has
 * ever asked about a KEY — the whole build asks for ACTIONS. So a pad button is a synthetic
 * CODE fed through the same `_press`/`_release` the keyboard uses, and it inherits the
 * binding table, the conflict checker, hold-versus-toggle and the rebinding UI without any
 * of them learning that a gamepad exists.
 *
 * ⚠ THE STICKS ARE NOT BUTTONS. Movement and look are analog, and squashing them to four
 * digital directions would be the one part of controller support that actually matters
 * done badly: a stick that only ever means "full speed north-east" is worse than the
 * keyboard, not equal to it. `moveAxis()` returns the stick when it is out of the deadzone
 * and the keys otherwise, so a player can use both in the same session — or one hand on
 * each, which is a real accessibility configuration and costs nothing to allow.
 *
 * Names follow the W3C Standard Gamepad mapping, which is what a browser reports for
 * anything Xbox-shaped. A pad that reports `mapping: ''` is left alone rather than guessed
 * at: wrong buttons are worse than no buttons.
 */
export const PAD_BUTTONS = Object.freeze([
  'PadA', 'PadB', 'PadX', 'PadY', 'PadLB', 'PadRB', 'PadLT', 'PadRT',
  'PadBack', 'PadStart', 'PadLS', 'PadRS', 'PadUp', 'PadDown', 'PadLeft', 'PadRight',
]);

/** Trigger travel that counts as a press. Analog, so it needs a line drawn somewhere. */
const TRIGGER_PRESS = 0.55;
/** Radial deadzone. Per-axis deadzones make a stick feel square; this one does not. */
const STICK_DEADZONE = 0.22;

/**
 * Deadzone, then a squared response curve.
 *
 * The curve is not decoration: containment work is placing a tripod within a few
 * centimetres of a doorway, and a linear stick spends most of its travel on speeds nobody
 * needs. Squaring gives fine control near the centre and full speed at the edge, which is
 * what makes the last metre of a placement possible on a pad at all.
 */
function stickVector(x, y) {
  const mag = Math.hypot(x, y);
  if (mag < STICK_DEADZONE) return { x: 0, y: 0, mag: 0 };
  const scaled = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  const curved = scaled * scaled;
  return { x: (x / mag) * curved, y: (y / mag) * curved, mag: curved };
}

export class Input {
  constructor(target = window, bindings = DEFAULT_BINDINGS, holdModes = DEFAULT_HOLD_MODES) {
    this.target = target;
    this.holdModes = sanitiseHoldModes(holdModes);
    this.setBindings(bindings);

    this._down = new Set();      // codes physically held
    this._pressed = new Set();   // codes that went down since the last endStep()
    this._released = new Set();
    this._latched = new Set();   // ACTIONS held open by a 'sustained' toggle
    this._edges = new Set();     // ACTIONS given a synthetic edge this step ('edge' + hold)
    this._capture = null;        // set while the settings panel is listening for a key
    // `seen` stays false until the player actually moves the mouse, so keyboard-only
    // play aims by movement direction instead of at the top-left corner.
    this.pointer = { x: 0, y: 0, down: false, seen: false };
    this.pointerWorld = null;      // world-space aim, recomputed each frame by main.js
    this._bound = [];
    /** Fired when the window loses focus. main.js pauses on it — GDD §24.3. */
    this.onBlur = null;
    /** Fired after any rebind/reset, so the settings panel and the tablet's control list
     *  redraw from one source instead of each keeping their own idea of the keys. */
    this.onBindingsChanged = null;

    /* The pad. `null` until one is seen, so a keyboard-only session allocates nothing and
     * `padConnected` is a straight answer rather than a guess. */
    this.pad = { connected: false, id: '', move: { x: 0, y: 0 }, look: { x: 0, y: 0 } };
    this._padDown = new Set();
    /** Look sensitivity for the stick, in radians per second at full deflection. It is
     *  separate from the mouse's per-pixel figure because they are different quantities —
     *  a mouse delta is distance, a stick is a rate, and one number cannot be both. */
    this.padLookRate = 2.6;
  }

  setBindings(bindings) {
    this.bindings = cloneBindings(bindings);
    this._codeToActions = new Map();
    for (const [action, codes] of Object.entries(this.bindings)) {
      for (const code of codes) {
        if (!this._codeToActions.has(code)) this._codeToActions.set(code, []);
        this._codeToActions.get(code).push(action);
      }
    }
  }

  attach() {
    const add = (t, type, fn) => { t.addEventListener(type, fn); this._bound.push([t, type, fn]); };
    add(this.target, 'keydown', (e) => {
      /* Rebinding steals the whole keyboard for exactly one keystroke. It runs before the
       * binding lookup so that pressing the key you are about to bind does not also fire
       * the action it is currently bound to. */
      if (this._capture) {
        const cb = this._capture;
        this._capture = null;
        // ⚠ A reserved code is reported to the callback but NOT swallowed. F5 must reload
        // the page even while the player is staring at a "press a key" prompt.
        if (!RESERVED.has(e.code)) e.preventDefault();
        cb(e.code, RESERVED.has(e.code));
        return;
      }
      // Never swallow browser reload/devtools; do swallow the keys we bind, so Space does
      // not scroll the page and Tab does not walk the focus ring off the canvas.
      if (!RESERVED.has(e.code) && this._codeToActions.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this._press(e.code);
    });
    add(this.target, 'keyup', (e) => this._release(e.code));
    // A held key whose keyup lands outside the window would stick forever.
    add(this.target, 'blur', () => { this.clear(); if (this.onBlur) this.onBlur(); });
    return this;
  }

  detach() {
    for (const [t, type, fn] of this._bound) t.removeEventListener(type, fn);
    this._bound.length = 0;
  }

  /* ── rebinding, GDD §19.1 ─────────────────────────────────────────────────── */

  /**
   * Bind `code` to `action`.
   * @param {object} opts  replace:true swaps the whole action (the usual UI gesture);
   *                       false appends an alternate. exclusive:true takes the code off
   *                       every other action first.
   * @returns {{ok:boolean, reason?:string, displaced?:string[]}}
   */
  rebind(action, code, { replace = true, exclusive = true } = {}) {
    if (!(action in this.bindings)) return { ok: false, reason: 'unknown-action' };
    if (typeof code !== 'string' || !code) return { ok: false, reason: 'bad-code' };
    if (RESERVED.has(code)) return { ok: false, reason: 'reserved' };

    /* Two actions on one key is a silent conflict — the player presses E and two things
     * happen. The rebinder resolves it by taking the key off the loser and SAYING SO, so
     * the panel can show "this unbound Use". A conflict the UI hides is a bug report. */
    const displaced = [];
    if (exclusive) {
      for (const [other, codes] of Object.entries(this.bindings)) {
        if (other === action) continue;
        if (!codes.includes(code)) continue;
        this.bindings[other] = codes.filter((c) => c !== code);
        displaced.push(other);
      }
    }
    this.bindings[action] = replace ? [code] : Array.from(new Set([...this.bindings[action], code]));
    this._commit();
    return { ok: true, displaced };
  }

  /** Remove one code from one action. An action may legally end up bound to nothing. */
  unbind(action, code) {
    if (!(action in this.bindings)) return { ok: false, reason: 'unknown-action' };
    this.bindings[action] = this.bindings[action].filter((c) => c !== code);
    this._commit();
    return { ok: true };
  }

  /** Back to the shipped table. Latches go with it — see setHoldMode. */
  resetBindings() {
    this.setBindings(DEFAULT_BINDINGS);
    this.clearLatches();
    if (this.onBindingsChanged) this.onBindingsChanged(this.bindingsToJSON());
    return this.bindingsToJSON();
  }

  /** The codes bound to an action, newest first. Copy — the caller may not mutate ours. */
  bindingFor(action) { return Array.from(this.bindings[action] || []); }

  /** Which actions this code would fire. The panel shows it before committing a rebind. */
  conflictsFor(code) { return Array.from(this._codeToActions.get(code) || []); }

  /** Plain data, safe to hand to JSON.stringify and to localStorage. */
  bindingsToJSON() { return cloneBindings(this.bindings); }

  /** Load a saved table. Anything unrecognised falls back to the default for that action. */
  bindingsFromJSON(raw) {
    this.setBindings(sanitiseBindings(raw));
    this.clearLatches();
    if (this.onBindingsChanged) this.onBindingsChanged(this.bindingsToJSON());
    return this.bindingsToJSON();
  }

  /**
   * Listen for the next keystroke and hand it back, instead of firing an action with it.
   * The settings panel calls this on "press a key"; the input layer owns it because this
   * is the one place that already knows what preventDefault may and may not swallow.
   * @param {(code:string, reserved:boolean) => void} cb
   */
  captureNext(cb) { this._capture = cb; return this; }

  cancelCapture() { this._capture = null; }

  get isCapturing() { return this._capture !== null; }

  _commit() {
    this.setBindings(this.bindings);
    if (this.onBindingsChanged) this.onBindingsChanged(this.bindingsToJSON());
  }

  /* ── hold / toggle, GDD §19.1 ─────────────────────────────────────────────── */

  setHoldMode(action, mode) {
    if (!(action in HOLDABLE)) return { ok: false, reason: 'not-holdable' };
    if (mode !== HOLD_MODE.HOLD && mode !== HOLD_MODE.TOGGLE) return { ok: false, reason: 'bad-mode' };
    /* ⚠ Dropping the latch on the way out of toggle mode is not tidiness. A latched sprint
     * with no key held would otherwise survive into hold mode, and the player would be
     * sprinting with nothing they can release to stop it. */
    if (mode === HOLD_MODE.HOLD) this._latched.delete(action);
    this.holdModes[action] = mode;
    return { ok: true };
  }

  holdMode(action) { return this.holdModes[action] || HOLD_MODE.HOLD; }

  setHoldModes(raw) {
    const next = sanitiseHoldModes(raw);
    for (const action of Object.keys(HOLDABLE)) this.setHoldMode(action, next[action]);
    return this.holdModesToJSON();
  }

  holdModesToJSON() { return { ...this.holdModes }; }

  /** Drop every toggle latch. Called on rebinding and on restart, NOT on blur. */
  clearLatches() { this._latched.clear(); }

  /* ── the wire from a keyboard to an action ────────────────────────────────── */

  _press(code) {
    this._down.add(code);
    this._pressed.add(code);
    for (const action of this._codeToActions.get(code) || []) {
      if (HOLDABLE[action] !== 'sustained') continue;
      if (this.holdModes[action] !== HOLD_MODE.TOGGLE) continue;
      if (this._latched.has(action)) this._latched.delete(action);
      else this._latched.add(action);
    }
  }

  _release(code) {
    this._down.delete(code);
    this._released.add(code);
    for (const action of this._codeToActions.get(code) || []) {
      if (HOLDABLE[action] !== 'edge') continue;
      if (this.holdModes[action] !== HOLD_MODE.HOLD) continue;
      /* The closing edge. Tracked per ACTION and not per code, because a code shared by two
       * actions must not hand a synthetic edge to the one that never asked for it. */
      this._edges.add(action);
    }
  }

  isDown(action) {
    if (HOLDABLE[action] === 'sustained' && this.holdModes[action] === HOLD_MODE.TOGGLE) {
      return this._latched.has(action);   // in toggle mode the latch IS the state
    }
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this._down.has(c)) return true;
    return false;
  }

  wasPressed(action) {
    if (this._edges.has(action)) return true;
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  wasReleased(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this._released.has(c)) return true;
    return false;
  }

  /**
   * Poll the connected pad and turn it into presses, releases and stick vectors.
   *
   * Called once per FRAME from the boot loop, not per step: the Gamepad API is polled
   * rather than evented, and a pad read twice inside one frame reports the same buttons
   * both times — which would be indistinguishable from the player holding them, and would
   * be fine, but reading it once is cheaper and says what it means.
   *
   * @param {Array} pads  navigator.getGamepads(), passed in so this file never touches the
   *   browser and the suite can drive a synthetic pad through the same path the real one
   *   uses. Testing the simulation is not testing the game, and neither is testing a mock.
   */
  pollPads(pads) {
    const list = pads || [];
    let g = null;
    for (const p of list) {
      if (!p || !p.connected) continue;
      /* ⚠ A pad that does not report the standard mapping is IGNORED rather than guessed
       * at. Wrong buttons are worse than no buttons: a player whose fire button opens the
       * tablet has a broken game, and one with no pad support has a keyboard. */
      /* ⚠ `mapping` must BE 'standard', not merely fail to contradict it. The first version
       * read `p.mapping && p.mapping !== 'standard'`, which lets an EMPTY mapping through —
       * and empty is precisely what a browser reports when it could not work out what the
       * device is. That is the case the check exists for. */
      if (p.mapping !== 'standard') continue;
      g = p;
      break;
    }
    if (!g) {
      if (this.pad.connected) {
        /* Release everything it was holding, or an unplugged pad leaves the operative
         * sprinting into a wall for the rest of the operation. */
        for (const code of Array.from(this._padDown)) this._release(code);
        this._padDown.clear();
      }
      this.pad.connected = false;
      this.pad.id = '';
      this.pad.move = { x: 0, y: 0 };
      this.pad.look = { x: 0, y: 0 };
      return false;
    }

    this.pad.connected = true;
    this.pad.id = g.id || '';
    const btns = g.buttons || [];
    for (let i = 0; i < PAD_BUTTONS.length; i++) {
      const code = PAD_BUTTONS[i];
      const b = btns[i];
      const v = b == null ? 0 : (typeof b === 'number' ? b : (b.value !== undefined ? b.value : (b.pressed ? 1 : 0)));
      const down = typeof b === 'object' && b && b.pressed !== undefined && code !== 'PadLT' && code !== 'PadRT'
        ? !!b.pressed : v >= TRIGGER_PRESS;
      const was = this._padDown.has(code);
      if (down && !was) { this._padDown.add(code); this._press(code); }
      else if (!down && was) { this._padDown.delete(code); this._release(code); }
    }

    const ax = g.axes || [];
    /* Standard mapping: 0/1 left stick, 2/3 right. A pad missing axes reports zeros
     * rather than undefined arithmetic. */
    const mv = stickVector(ax[0] || 0, ax[1] || 0);
    const lk = stickVector(ax[2] || 0, ax[3] || 0);
    this.pad.move = { x: mv.x, y: mv.y };
    this.pad.look = { x: lk.x, y: lk.y };
    return true;
  }

  /**
   * How far to turn the head this frame, in radians, from the right stick.
   *
   * ⚠ RATE × TIME, not a raw delta. The mouse hands the game a distance the hand actually
   * moved; a stick hands it a position it is being held at, and treating that as a distance
   * makes the look speed a function of the frame rate — smooth on a 144Hz monitor, unusable
   * on a 30fps one. The two paths are different quantities and only one of them is allowed
   * near a delta.
   */
  padLook(dtMs) {
    if (!this.pad.connected) return { yaw: 0, pitch: 0 };
    const dt = Math.min(100, Math.max(0, dtMs)) / 1000;
    return {
      yaw: -this.pad.look.x * this.padLookRate * dt,
      pitch: this.pad.look.y * this.padLookRate * dt,
    };
  }

  /**
   * -1..1 on each axis. The stick when it is out of the deadzone, the keys otherwise.
   *
   * Deliberately not a sum: a player with a hand on each does not want a doubled vector,
   * and whichever they moved last is the one they meant.
   */
  moveAxis() {
    if (this.pad.connected && (this.pad.move.x || this.pad.move.y)) {
      return { x: this.pad.move.x, y: this.pad.move.y };
    }
    let x = (this.isDown('moveRight') ? 1 : 0) - (this.isDown('moveLeft') ? 1 : 0);
    let y = (this.isDown('moveDown') ? 1 : 0) - (this.isDown('moveUp') ? 1 : 0);
    if (x && y) { const inv = Math.SQRT1_2; x *= inv; y *= inv; }
    return { x, y };
  }

  /** Clear the per-step edge sets. Called once per fixed simulation step. */
  endStep() { this._pressed.clear(); this._released.clear(); this._edges.clear(); }

  /** Drop all held state (focus loss, restart).
   *  ⚠ Toggle latches deliberately SURVIVE this. Toggle mode exists so a player does not
   *  have to keep a key held; wiping the latch on every alt-tab would hand them back the
   *  problem the setting was there to solve. clearLatches() is the explicit way out. */
  clear() { this._down.clear(); this._pressed.clear(); this._released.clear(); this._edges.clear(); }

  /** Test hook: synthesise input without a real keyboard. Goes through the same
   *  press/release path as the listeners, so latches and synthetic edges are exercised. */
  _debugPress(code)   { this._press(code); }
  _debugRelease(code) { this._release(code); }
}
