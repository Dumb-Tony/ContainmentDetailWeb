/* Touch controls — GDD §19.1, §23 Milestone 5 ("playable on a phone").
 *
 * ⚠ NOT A SECOND CONTROL SCHEME. This is the lesson recorded in
 * BedroomRacers\src\systems\Touch.js, copied here because it is the whole design: the
 * touch layer produces THE SAME state the keyboard and the pad produce, and hands it to
 * the same Input the game already reads. Nothing in game.js, player.js or net can tell a
 * thumb from a W key, and no `if (touch)` exists below this file.
 *
 * How it enters: `Input.pollPads` already accepts virtual pad sources (core/input.js),
 * and this module registers one that reports a STANDARD-MAPPING pad —
 *
 *   · the on-screen stick is axes[0]/axes[1], so it inherits the radial deadzone and the
 *     squared response curve from `stickVector` BY CONSTRUCTION, not by a copy of them
 *   · every button is a standard pad button index, so it inherits the binding table, the
 *     conflict checker, hold-versus-toggle and the rebinding UI exactly the way a real
 *     pad does. Rebinding `interact` off PadA re-routes the touch tap too, because the
 *     touch tap IS a PadA press.
 *
 * The one thing that cannot ride the pad is LOOK. A pad's right stick is a RATE (a
 * position held); a drag is a DISTANCE (like a mouse delta), and input.js is explicit
 * that the two are different quantities. So drags leave here as deltas through `onLook`
 * (or `drainLook()`), and main.js feeds them to the same `player.look` / `commsWheel.aim`
 * the mouse feeds. Same path, correct quantity.
 *
 * ── the layout ────────────────────────────────────────────────────────────────
 *   left half     floating stick. Touch anywhere, the stick blooms under the thumb.
 *                 Pushed to ≥ 92% of its rim it also presses PadLS — which is the
 *                 default sprint binding — with hysteresis (releases below 80%) so the
 *                 edge does not flicker. Sprint therefore needs no button and no thumb.
 *   right half    drag to look. A short still tap (< 280 ms, < 12 px) is PadA, the
 *                 default `interact` binding — the context verb on the thing you face.
 *   right edge    USE (PadX), IMAGER (PadLB), CROUCH (PadB, momentary — set crouch to
 *                 toggle in settings for a latch; Input owns that, §19.1), COMMS
 *                 (PadRB, HELD; aim the wheel by dragging with a second finger).
 *   right column  ABORT (PadY), TABLET (PadBack), MENU (PadStart), below the HUD's
 *                 objective text.
 *   bottom row    slots 1–5 (PadLeft/Up/Right/Down/RT — the default slot bindings).
 *
 * Every target is ≥ 44 CSS px at --cd-ui-scale:1 and the whole layout multiplies by
 * --cd-ui-scale (§19.1); positions carry env(safe-area-inset-*) so nothing hides under
 * a notch or a home bar. tools/touch-tests.js measures all of this rather than trusting
 * this comment.
 *
 * ── when it exists at all ─────────────────────────────────────────────────────
 * Only on a device whose pointers are coarse AND not fine — the same predicate main.js
 * used for the "needs a keyboard" gate this module retires. On a desktop `attach()`
 * refuses, builds nothing, registers nothing: the desktop build is pixel-identical and
 * the suite asserts zero touch nodes. A real standard gamepad DISPLACES the overlay
 * (pollPads prefers real pads), and the overlay hides itself while one is connected —
 * wrong buttons are worse than no buttons, and a pad player has a pad.
 *
 * Labels resolve through i18n when the keys exist and fall back to built-in English
 * otherwise, so this file works before content/locales grows the `touch.*` keys and
 * self-heals the moment it does (a missing key must never be printed at a player).
 */

import { t } from '../core/i18n.js';

export const TOUCH_PAD_ID = 'cd-touch-virtual';

/* Stick feel. RAW deflection thresholds (0..1 of the rim), applied before input.js's own
 * deadzone/curve — these decide only when the sprint edge fires, never how movement
 * scales. ON at 92% with OFF at 80% is a 12% hysteresis band: measured on a 60 px rim
 * that is 7 px of slack, about the jitter of a held thumb. */
export const SPRINT_ON = 0.92;
export const SPRINT_OFF = 0.80;

/* A tap is short and still; anything longer or travelled is a look drag. 12 px is under
 * half the 25 px "intentional swipe" figure platform gesture recognisers use, so a lazy
 * tap still lands as a tap. */
export const TAP_MS = 280;
export const TAP_SLOP_PX = 12;

/* Drag-to-look gain, in mouse-counts per CSS px. The mouse path is radians-per-count
 * (CONFIG.player.lookSensitivity); a phone swipe is ~300 px where a mouse sweep is
 * ~800 px of desk, so raw 1:1 makes turning a two-swipe chore. 2.6 puts a full swipe at
 * roughly a quarter turn at the default sensitivity, and the player's sensitivity
 * setting still multiplies on top because the deltas enter the same `player.look`. */
export const LOOK_SCALE = 2.6;

/* W3C Standard Gamepad indices for the codes input.js maps them to. The names on the
 * left are the DEFAULT actions only — the binding table decides at runtime, which is
 * the point. Kept as one visible table so a wrong index is a review find, not a play
 * find. */
const BTN = Object.freeze({
  interact: 0,   // PadA
  crouch: 1,     // PadB
  use: 2,        // PadX
  abort: 3,      // PadY
  imager: 4,     // PadLB
  comms: 5,      // PadRB
  slot5: 7,      // PadRT (trigger: reported with value 1 so TRIGGER_PRESS is cleared)
  tablet: 8,     // PadBack
  settings: 9,   // PadStart
  sprint: 10,    // PadLS
  slot2: 12,     // PadUp
  slot4: 13,     // PadDown
  slot1: 14,     // PadLeft
  slot3: 15,     // PadRight
});

/* The buttons the overlay draws. `k` is the CSS hook and the test hook; `idx` is the
 * standard-mapping index above; `key` is the locale key with its English fallback beside
 * it. Slots are digits — a numeral is not prose and needs no translation. */
const BUTTONS = Object.freeze([
  { k: 'use', idx: BTN.use, key: 'touch.use', fb: 'USE' },
  { k: 'imager', idx: BTN.imager, key: 'touch.imager', fb: 'IMAGER' },
  { k: 'crouch', idx: BTN.crouch, key: 'touch.crouch', fb: 'CROUCH' },
  { k: 'comms', idx: BTN.comms, key: 'touch.comms', fb: 'COMMS' },
  { k: 'abort', idx: BTN.abort, key: 'touch.abort', fb: 'ABORT' },
  { k: 'tablet', idx: BTN.tablet, key: 'touch.tablet', fb: 'TABLET' },
  { k: 'settings', idx: BTN.settings, key: 'touch.settings', fb: 'MENU' },
  { k: 'slot1', idx: BTN.slot1, key: null, fb: '1' },
  { k: 'slot2', idx: BTN.slot2, key: null, fb: '2' },
  { k: 'slot3', idx: BTN.slot3, key: null, fb: '3' },
  { k: 'slot4', idx: BTN.slot4, key: null, fb: '4' },
  { k: 'slot5', idx: BTN.slot5, key: null, fb: '5' },
]);

/** A message when the table has it, the built-in fallback when it does not — never the
 *  raw key at a player. */
function label(key, fb) {
  if (!key) return fb;
  const s = t(key);
  return s === key ? fb : s;
}

/**
 * The gate. Coarse and NOT fine is a phone or a tablet; a desktop with a touchscreen
 * reports both and keeps the keyboard build (it has one). This is the same predicate
 * main.js's old "needs a keyboard and a mouse" notice used, so the population that saw
 * the apology is exactly the population that gets the controls.
 */
export function coarseOnlyDevice(win = (typeof window !== 'undefined' ? window : null)) {
  if (!win || !win.matchMedia) return false;
  return win.matchMedia('(pointer: coarse)').matches
    && !win.matchMedia('(pointer: fine)').matches;
}

export class TouchControls {
  /**
   * @param {Input} input  the game's one Input. This module registers a pad source on it
   *   and nothing else — all state flows out through pollPads.
   * @param {object} [opts]
   *   force       build even on a fine-pointer device (the test harness is one)
   *   doc         document to build into (tests pass their own)
   *   onActivate  fired once on the first touch — main.js starts audio here, because the
   *               overlay sits above the canvas and eats the click that used to do it
   *   onLook      (dx, dy) mouse-scale deltas per drag event; when unset they accumulate
   *               for drainLook() instead (the headless suite reads that path)
   *   lookScale   override LOOK_SCALE
   */
  constructor(input, opts = {}) {
    this.input = input;
    this.doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    this.force = !!opts.force;
    this.onActivate = opts.onActivate || null;
    this.onLook = opts.onLook || null;
    this.lookScale = opts.lookScale || LOOK_SCALE;

    /** Overlay built and pad source registered. False on every fine-pointer device. */
    this.enabled = false;
    /** A touch has actually happened. main.js's pause gate reads this: pointer lock
     *  does not exist on touch, so "the player is engaged" is a finger, not a lock. */
    this.active = false;

    this.root = null;
    this._zones = null;
    this._btnEls = new Map();     // idx -> element, for the .on class

    /* stick */
    this._stickId = null;
    this._stickOx = 0; this._stickOy = 0;   // floating origin, CSS px
    this._stickR = 56;                      // measured from the drawn base at touch time
    this._ax = 0; this._ay = 0;             // RAW -1..1; input.js applies deadzone+curve
    this._sprint = false;

    /* look */
    this._lookId = null;
    this._lastX = 0; this._lastY = 0;
    this._lookDX = 0; this._lookDY = 0;     // accumulator for drainLook()
    this._tapT0 = 0; this._tapTravel = 0;

    /* buttons. Held is by pointer so a slide-off releases; `pulse` keeps a press alive
     * until a poll has SEEN it — a tap between two polls must not vanish. `seen` is how
     * a poll marks a held button as delivered. */
    this._held = new Map();       // pointerId -> idx
    this._heldIdx = new Map();    // idx -> count of pointers holding it
    this._pulse = new Map();      // idx -> polls left to report pressed
    this._seen = new Set();

    this._displaced = false;      // a REAL standard pad owns the input this frame

    /* The 16 button slots, allocated once and mutated per snapshot — pollPads runs per
     * frame and this must not. Triggers carry value so TRIGGER_PRESS reads them. */
    this._btns = [];
    for (let i = 0; i < 16; i++) this._btns.push({ pressed: false, value: 0 });
    this._pad = {
      connected: true, mapping: 'standard', id: TOUCH_PAD_ID,
      axes: [0, 0, 0, 0], buttons: this._btns,
    };
    this._source = () => this._snapshot();
    this._bound = [];
  }

  /** Build the overlay and join the input, or refuse silently on a fine-pointer device. */
  attach() {
    if (this.enabled || !this.doc || !this.input) return this;
    if (!this.force && !coarseOnlyDevice(this.doc.defaultView)) return this;
    this._build();
    this.input.addPadSource(this._source);
    this.enabled = true;
    return this;
  }

  detach() {
    if (!this.enabled) return this;
    this.input.removePadSource(this._source);
    for (const [el, type, fn] of this._bound) el.removeEventListener(type, fn);
    this._bound.length = 0;
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null;
    this._zones = null;
    this._btnEls.clear();
    this.enabled = false;
    return this;
  }

  /** Deltas accumulated since the last call, already look-scaled. Used when no onLook
   *  callback is wired — which is how the suite reads the path headlessly. */
  drainLook() {
    const x = this._lookDX, y = this._lookDY;
    this._lookDX = 0; this._lookDY = 0;
    return { x, y };
  }

  /* ── the pad source ─────────────────────────────────────────────────────── */

  /**
   * Called by Input.pollPads every frame, real pads first — so a connected standard pad
   * wins the slot and this returns null while it does. Null is also the answer before
   * the first touch: a phone that has not been touched reports no pad, which keeps
   * `moveAxis()` on the keys and the desktop suite's world byte-identical.
   */
  _snapshot() {
    const cur = this.input.pad;
    const displaced = !!(cur && cur.connected && cur.id !== TOUCH_PAD_ID);
    if (displaced !== this._displaced) {
      this._displaced = displaced;
      if (this.root) this.root.classList.toggle('displaced', displaced);
      /* Fingers mid-gesture when the pad arrived would otherwise come back as stale
       * presses when it leaves. Drop them; the pointerups that follow find nothing. */
      if (displaced) {
        this._held.clear(); this._heldIdx.clear(); this._pulse.clear(); this._seen.clear();
        this._stickId = null; this._ax = 0; this._ay = 0; this._sprint = false;
        this._setStickVisual(false);
      }
    }
    if (displaced || !this.active) return null;

    this._pad.axes[0] = this._ax;
    this._pad.axes[1] = this._ay;
    for (let i = 0; i < 16; i++) {
      const held = (this._heldIdx.get(i) || 0) > 0;
      const pulsed = (this._pulse.get(i) || 0) > 0;
      let on = held || pulsed;
      if (i === BTN.sprint) on = on || this._sprint;
      this._btns[i].pressed = on;
      this._btns[i].value = on ? 1 : 0;
      if (held) this._seen.add(i);
      if (pulsed) {
        const left = this._pulse.get(i) - 1;
        if (left <= 0) this._pulse.delete(i); else this._pulse.set(i, left);
      }
    }
    return this._pad;
  }

  /* ── DOM ────────────────────────────────────────────────────────────────── */

  _build() {
    const d = this.doc;
    const root = d.createElement('div');
    root.className = 'cd-touch';

    const stickZone = d.createElement('div');
    stickZone.className = 'cd-touch-stickzone';
    const stickBase = d.createElement('div');
    stickBase.className = 'cd-touch-stick';
    const nub = d.createElement('div');
    nub.className = 'cd-touch-nub';
    stickBase.appendChild(nub);
    stickZone.appendChild(stickBase);

    const lookZone = d.createElement('div');
    lookZone.className = 'cd-touch-lookzone';

    root.appendChild(stickZone);
    root.appendChild(lookZone);

    for (const b of BUTTONS) {
      const el = d.createElement('div');
      el.className = `cd-touch-btn b-${b.k}`;
      el.dataset.k = b.k;
      el.setAttribute('role', 'button');
      const text = label(b.key, b.fb);
      el.textContent = text;
      el.setAttribute('aria-label', text);
      this._btnEls.set(b.idx, el);
      this._listenButton(el, b.idx);
      root.appendChild(el);
    }

    this._zones = { stickZone, stickBase, nub, lookZone };
    this._listenStick(stickZone);
    this._listenLook(lookZone);
    const add = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); this._bound.push([el, type, fn]); };
    /* Long-press context menus and text selection are browser chrome the game cannot
     * use; touch-action:none in the stylesheet handles scroll and double-tap zoom. */
    add(root, 'contextmenu', (e) => e.preventDefault());
    /* A backgrounded tab never delivers its pointerups. Same rule as the keyboard's
     * blur handler: drop everything held. */
    const w = d.defaultView;
    if (w) add(w, 'blur', () => this._releaseAll());

    d.body.appendChild(root);
    this.root = root;
  }

  _activate() {
    if (this.active) return;
    this.active = true;
    if (this.onActivate) { const cb = this.onActivate; this.onActivate = null; cb(); }
  }

  /* A finger, not a cursor. A mouse on a hybrid device must keep its desktop meaning —
   * the BedroomRacers overlay learned this the visible way. Pen counts as a finger. */
  _isTouch(e) { return e.pointerType !== 'mouse'; }

  _capture(el, e) {
    /* Synthetic events (the suite's) and already-lifted fingers both make this throw;
     * capture is an optimisation for fingers that wander off the element, not a
     * requirement, so a refusal is fine. */
    try { el.setPointerCapture(e.pointerId); } catch { /* no capture, still fine */ }
  }

  /* ── stick ──────────────────────────────────────────────────────────────── */

  _listenStick(zone) {
    const add = (type, fn) => { zone.addEventListener(type, fn, { passive: false }); this._bound.push([zone, type, fn]); };
    add('pointerdown', (e) => {
      if (!this._isTouch(e) || this._stickId !== null) return;
      this._activate();
      this._capture(zone, e);
      this._stickId = e.pointerId;
      this._stickOx = e.clientX; this._stickOy = e.clientY;
      this._setStickVisual(true, e.clientX, e.clientY);
      /* Measured AFTER showing: a display:none element has no width. Half the drawn
       * base is the rim the axes normalise against, so --cd-ui-scale scales the maths
       * with the picture. */
      const w = this._zones.stickBase.offsetWidth;
      this._stickR = (w > 0 ? w / 2 : 56);
      this._moveStick(e.clientX, e.clientY);
      e.preventDefault();
    });
    add('pointermove', (e) => {
      if (e.pointerId !== this._stickId) return;
      this._moveStick(e.clientX, e.clientY);
      e.preventDefault();
    });
    const up = (e) => {
      if (e.pointerId !== this._stickId) return;
      this._stickId = null;
      this._ax = 0; this._ay = 0;
      this._sprint = false;
      this._setStickVisual(false);
    };
    add('pointerup', up);
    add('pointercancel', up);
  }

  _moveStick(x, y) {
    const R = this._stickR || 56;
    let dx = (x - this._stickOx) / R;
    let dy = (y - this._stickOy) / R;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }
    this._ax = dx; this._ay = dy;
    /* The sprint edge, with hysteresis. RAW magnitude: the curve downstream would make
     * a threshold in curved units mean a different thumb distance than it says. */
    const m = Math.min(1, mag);
    if (!this._sprint && m >= SPRINT_ON) this._sprint = true;
    else if (this._sprint && m < SPRINT_OFF) this._sprint = false;
    if (this._zones) {
      const nx = Math.max(-1, Math.min(1, dx)) * R;
      const ny = Math.max(-1, Math.min(1, dy)) * R;
      this._zones.nub.style.transform = `translate(${nx.toFixed(1)}px, ${ny.toFixed(1)}px)`;
    }
  }

  _setStickVisual(on, x, y) {
    if (!this._zones) return;
    const b = this._zones.stickBase;
    if (on) {
      b.style.left = `${x}px`;
      b.style.top = `${y}px`;
      b.classList.add('on');
    } else {
      b.classList.remove('on');
      this._zones.nub.style.transform = 'translate(0px, 0px)';
    }
  }

  /* ── look, and the tap that is `interact` ───────────────────────────────── */

  _listenLook(zone) {
    const add = (type, fn) => { zone.addEventListener(type, fn, { passive: false }); this._bound.push([zone, type, fn]); };
    add('pointerdown', (e) => {
      if (!this._isTouch(e) || this._lookId !== null) return;
      this._activate();
      this._capture(zone, e);
      this._lookId = e.pointerId;
      this._lastX = e.clientX; this._lastY = e.clientY;
      /* ⚠ e.timeStamp, NEVER performance.now(). K5 forbids wall-clock reads outside the
       * boot loop, and the pointer stream already carries its own DOMHighResTimeStamp -
       * the tap-vs-drag question is a property of the GESTURE, so the gesture's clock is
       * the honest one. */
      this._tapT0 = e.timeStamp;
      this._tapTravel = 0;
      e.preventDefault();
    });
    add('pointermove', (e) => {
      if (e.pointerId !== this._lookId) return;
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      this._lastX = e.clientX; this._lastY = e.clientY;
      this._tapTravel += Math.hypot(dx, dy);
      const sx = dx * this.lookScale;
      const sy = dy * this.lookScale;
      if (this.onLook) this.onLook(sx, sy);
      else { this._lookDX += sx; this._lookDY += sy; }
      e.preventDefault();
    });
    const up = (e, cancelled) => {
      if (e.pointerId !== this._lookId) return;
      this._lookId = null;
      const dt = e.timeStamp - this._tapT0;
      /* Short and still: the context verb. Travelled or lingered: it was a look, and a
       * look must never ALSO interact — marking a fixture because you glanced past it
       * is the touch equivalent of the mis-click. */
      if (!cancelled && dt <= TAP_MS && this._tapTravel <= TAP_SLOP_PX) {
        this._pulseBtn(BTN.interact);
      }
    };
    add('pointerup', (e) => up(e, false));
    add('pointercancel', (e) => up(e, true));
  }

  /* ── buttons ────────────────────────────────────────────────────────────── */

  _listenButton(el, idx) {
    const add = (type, fn) => { el.addEventListener(type, fn, { passive: false }); this._bound.push([el, type, fn]); };
    add('pointerdown', (e) => {
      if (!this._isTouch(e)) return;
      this._activate();
      this._capture(el, e);
      this._held.set(e.pointerId, idx);
      this._heldIdx.set(idx, (this._heldIdx.get(idx) || 0) + 1);
      el.classList.add('on');
      e.preventDefault();
      e.stopPropagation();
    });
    const up = (e) => {
      const held = this._held.get(e.pointerId);
      if (held === undefined) return;
      this._held.delete(e.pointerId);
      const n = (this._heldIdx.get(held) || 1) - 1;
      if (n <= 0) this._heldIdx.delete(held); else this._heldIdx.set(held, n);
      /* A tap can land and lift entirely between two polls. If no poll saw the press,
       * leave a one-poll pulse behind so the edge still happens — a slot tap that
       * sometimes does nothing reads as a broken game, and it would be. */
      if (n <= 0 && !this._seen.has(held)) this._pulseBtn(held);
      if (n <= 0) this._seen.delete(held);
      const btnEl = this._btnEls.get(held);
      if (btnEl && n <= 0) btnEl.classList.remove('on');
    };
    add('pointerup', up);
    add('pointercancel', up);
  }

  /** Report `idx` pressed for exactly one poll (then released by its absence). */
  _pulseBtn(idx) {
    this._pulse.set(idx, Math.max(this._pulse.get(idx) || 0, 1));
  }

  _releaseAll() {
    this._held.clear(); this._heldIdx.clear(); this._seen.clear();
    this._stickId = null; this._lookId = null;
    this._ax = 0; this._ay = 0; this._sprint = false;
    this._setStickVisual(false);
    for (const el of this._btnEls.values()) el.classList.remove('on');
  }
}
