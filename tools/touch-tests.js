/* Touch controls — does a thumb reach the same game a keyboard reaches?
 *
 * The design under test (src/ui/touch.js + the pad-source seam in src/core/input.js) is
 * ONE claim: touch is not a second input system. The overlay reports a virtual
 * standard-mapping pad through `Input.pollPads`, so the stick rides `stickVector`'s
 * deadzone and squared curve, and every button rides the binding table, exactly as a
 * physical pad does. If that claim holds, then a full-forward thumb and a held W key
 * must produce IDENTICAL operative trajectories in the same seeded world — and section
 * TTF asserts exact equality of the two distances rather than approximate agreement,
 * because "same code path" is an equality claim, not a similarity claim.
 *
 * Everything upstream of the seam is driven with REAL PointerEvent dispatches at the
 * real overlay DOM (pointerType 'touch'), never by poking module internals: the events
 * are what a phone sends, and the assertions read what comes out of the real Input.
 *
 * Section letters are TT* — this repo assigns letter ranges with ports (Dev\INDEX.md,
 * the two-agents-picked-CE–CK lesson), and TT is claimed by this file alongside port
 * 8901.
 *
 * ⚠ The suite runs on a FINE-pointer desktop browser, which is itself the first test:
 * TTA asserts the module refuses to build there, and every later section must `force`
 * the overlay into existence. Geometry (TTG) is measured on the forced overlay — same
 * stylesheet the phone gets, since the harness page is a copy of index.html.
 */

import { lines, counts, ok, eq, near, note, emit, run, heading, suite } from './harness.js';
import { Input } from '../src/core/input.js';
import {
  TouchControls, coarseOnlyDevice, TOUCH_PAD_ID,
  SPRINT_ON, SPRINT_OFF, TAP_MS, TAP_SLOP_PX, LOOK_SCALE,
} from '../src/ui/touch.js';
import { loadContent } from '../src/sim/content.js';
import { Game, RECOMMENDED_MANIFEST } from '../src/game.js';
import { dist } from '../src/sim/geometry.js';

/* ── plumbing ─────────────────────────────────────────────────────────────── */

/** An Input with no window: pollPads/moveAxis need no listeners, and keeping the real
 *  page's Input out of it means the booted game and this suite cannot poll each other's
 *  state machines. */
const bareInput = () => new Input({ addEventListener() {}, removeEventListener() {} });

let PID = 100;
const pev = (el, type, id, x, y) => el.dispatchEvent(new PointerEvent(type, {
  pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
  bubbles: true, cancelable: true,
}));

/** Forced overlay on a bare Input. Callers MUST detach() — a leaked overlay would let a
 *  later section's querySelector find the wrong root. */
function mkTouch(opts = {}) {
  const input = bareInput();
  const tc = new TouchControls(input, { force: true, ...opts }).attach();
  return { input, tc };
}

/** Put a stick finger down at the zone's resting point and return the geometry. */
function stickDown(tc, id) {
  const zone = tc.root.querySelector('.cd-touch-stickzone');
  const r = zone.getBoundingClientRect();
  const ox = r.left + r.width * 0.5;
  const oy = r.top + r.height * 0.6;
  pev(zone, 'pointerdown', id, ox, oy);
  const R = tc.root.querySelector('.cd-touch-stick').offsetWidth / 2;
  return { zone, ox, oy, R };
}

/* ── TTA. the gate: a desktop is left pixel-identical ─────────────────────── */
async function sectionTTA() {
  heading('TTA. on a fine-pointer device the module builds nothing at all');

  eq('TTA1 this harness browser is not a coarse-only device (precondition for the rest)',
    coarseOnlyDevice(), false);
  eq('TTA2 before any attach, the page main.js booted contains zero touch nodes',
    document.querySelectorAll('.cd-touch').length, 0);

  const input = bareInput();
  const tc = new TouchControls(input).attach();   // no force: the shipped gate
  eq('TTA3 attach() on a fine-pointer device refuses', tc.enabled, false);
  eq('TTA4 and still no touch DOM exists', document.querySelectorAll('.cd-touch').length, 0);
  input.pollPads([]);
  eq('TTA5 and the Input reports no pad — pollPads with no sources is the code it always was',
    input.pad.connected, false);

  const forced = mkTouch();
  eq('TTA6 force builds exactly one overlay (the harness needs it; a phone gets it by the gate)',
    document.querySelectorAll('.cd-touch').length, 1);
  forced.input.pollPads([]);
  eq('TTA7 but before the first touch the source reports null — an untouched phone is a keyboard build',
    forced.input.pad.connected, false);
  forced.tc.detach();
  eq('TTA8 detach removes the overlay and the source',
    document.querySelectorAll('.cd-touch').length, 0);
  emit();
}

/* ── TTB. the stick is the pad's stick ────────────────────────────────────── */
async function sectionTTB() {
  heading('TTB. stick deflection reaches moveAxis through the pad deadzone and curve');

  const { input, tc } = mkTouch();
  const id = ++PID;
  const { zone, ox, oy, R } = stickDown(tc, id);
  note(`stick rim measured from the drawn base: R = ${R} px`);
  ok('TTB1 the floating stick has real size once shown', R >= 40);

  input.pollPads([]);
  eq('TTB2 a touch connects the virtual pad', input.pad.connected, true);
  eq('TTB3 and it identifies itself', input.pad.id, TOUCH_PAD_ID);

  /* Full deflection right: raw 1.0 -> curve((1-.22)/.78)^2 = 1 exactly. */
  pev(zone, 'pointermove', id, ox + R, oy);
  input.pollPads([]);
  near('TTB4 full deflection is full speed', input.moveAxis().x, 1, 1e-9);
  near('TTB5 and nothing leaks onto the other axis', input.moveAxis().y, 0, 1e-9);

  /* Inside the radial deadzone: raw .15 < .22 -> zero. */
  pev(zone, 'pointermove', id, ox + 0.15 * R, oy);
  input.pollPads([]);
  eq('TTB6 inside the 0.22 radial deadzone the axis is exactly zero', input.moveAxis().x, 0);

  /* Mid travel: raw .61 -> scaled (.61-.22)/.78 = .5 -> squared = .25. The tolerance
   * covers clientX landing on a device pixel. */
  pev(zone, 'pointermove', id, ox + 0.61 * R, oy);
  input.pollPads([]);
  near('TTB7 mid travel takes the squared response curve (raw .61 -> .25)',
    input.moveAxis().x, 0.25, 0.02);
  note(`measured mid-travel axis: ${input.moveAxis().x.toFixed(4)}`);

  /* Diagonal past the rim: clamped to the unit circle, then curved to magnitude 1. */
  pev(zone, 'pointermove', id, ox + R, oy - R);
  input.pollPads([]);
  const d = input.moveAxis();
  near('TTB8 an over-rim diagonal clamps to the unit circle: x', d.x, Math.SQRT1_2, 1e-3);
  near('TTB9 and y (screen-up is axis-negative, the pad convention)', d.y, -Math.SQRT1_2, 1e-3);

  pev(zone, 'pointerup', id, ox + R, oy - R);
  input.pollPads([]);
  eq('TTB10 lifting the thumb zeroes the axis', input.moveAxis().x, 0);
  eq('TTB11 and both of them', input.moveAxis().y, 0);
  tc.detach();
  emit();
}

/* ── TTC. sprint lives on the rim ─────────────────────────────────────────── */
async function sectionTTC() {
  heading('TTC. pushing the stick to its rim is sprint, with hysteresis');

  const { input, tc } = mkTouch();
  const id = ++PID;
  const { zone, ox, oy, R } = stickDown(tc, id);

  pev(zone, 'pointermove', id, ox, oy - 0.5 * R);
  input.pollPads([]);
  eq('TTC1 half deflection does not sprint', input.isDown('sprint'), false);

  pev(zone, 'pointermove', id, ox, oy - 0.95 * R);
  input.pollPads([]);
  eq(`TTC2 past the ${SPRINT_ON} rim it presses PadLS, the default sprint binding`,
    input.isDown('sprint'), true);

  /* Between OFF (.80) and ON (.92): the band exists so a held thumb does not flicker. */
  pev(zone, 'pointermove', id, ox, oy - 0.85 * R);
  input.pollPads([]);
  eq(`TTC3 easing back inside the ${SPRINT_OFF}-${SPRINT_ON} band keeps sprinting (hysteresis)`,
    input.isDown('sprint'), true);

  pev(zone, 'pointermove', id, ox, oy - 0.5 * R);
  input.pollPads([]);
  eq('TTC4 below the band it releases', input.isDown('sprint'), false);

  pev(zone, 'pointerup', id, ox, oy);
  input.pollPads([]);
  tc.detach();
  emit();
}

/* ── TTD. buttons are pad buttons, so they are the BINDING TABLE's ────────── */
async function sectionTTD() {
  heading('TTD. every button is a standard pad code through the real binding table');

  const { input, tc } = mkTouch();
  const btn = (k) => tc.root.querySelector(`.b-${k}`);
  const tapNow = (k) => { const id = ++PID; const e = btn(k); pev(e, 'pointerdown', id, 5, 5); pev(e, 'pointerup', id, 5, 5); };

  /* Held press: down, poll, read, up, poll. */
  const holdCheck = (k, action) => {
    const id = ++PID; const e = btn(k);
    pev(e, 'pointerdown', id, 5, 5);
    input.pollPads([]);
    const pressed = input.wasPressed(action);
    input.endStep();
    pev(e, 'pointerup', id, 5, 5);
    input.pollPads([]);
    input.endStep();
    return pressed;
  };
  eq('TTD1 USE fires the use action', holdCheck('use', 'use'), true);
  eq('TTD2 IMAGER fires imager', holdCheck('imager', 'imager'), true);
  eq('TTD3 CROUCH fires crouch', holdCheck('crouch', 'crouch'), true);
  eq('TTD4 ABORT fires abort', holdCheck('abort', 'abort'), true);
  eq('TTD5 TABLET fires tablet', holdCheck('tablet', 'tablet'), true);
  eq('TTD6 MENU fires settings', holdCheck('settings', 'settings'), true);
  eq('TTD7 slot buttons fire their slots', holdCheck('slot1', 'slot1') && holdCheck('slot4', 'slot4'), true);

  /* A tap that lands and lifts BETWEEN two polls must still arrive: the one-poll pulse. */
  tapNow('slot3');
  input.pollPads([]);
  eq('TTD8 a tap entirely between polls still lands (the pulse latch)', input.wasPressed('slot3'), true);
  input.endStep();
  input.pollPads([]);
  eq('TTD9 and it is released by the very next poll, so it is an edge and not a stuck key',
    input.isDown('slot3'), false);

  /* Comms is a HOLD: the wheel is open while the finger is down, exactly the Z key. */
  const cid = ++PID;
  pev(btn('comms'), 'pointerdown', cid, 5, 5);
  input.pollPads([]);
  eq('TTD10 comms is held while the finger is down', input.isDown('comms'), true);
  input.endStep();
  input.pollPads([]);
  eq('TTD11 and stays held across steps, which is what lets the wheel stay open',
    input.isDown('comms'), true);
  pev(btn('comms'), 'pointerup', cid, 5, 5);
  input.pollPads([]);
  eq('TTD12 lifting the finger releases it, which is what sends the callout', input.isDown('comms'), false);

  /* THE one-code-path proof by rebinding: move `interact` onto PadX and the USE button —
   * which is nothing but a PadX press — now fires interact instead. No touch-specific
   * routing exists to go stale. */
  const r = input.rebind('interact', 'PadX', { replace: true, exclusive: true });
  ok('TTD13 rebinding interact onto PadX succeeds and displaces use', r.ok && r.displaced.includes('use'));
  tapNow('use');
  input.pollPads([]);
  eq('TTD14 after the rebind the USE button fires interact — touch rides the binding table',
    input.wasPressed('interact'), true);
  eq('TTD15 and no longer fires use', input.wasPressed('use'), false);
  input.endStep();
  input.resetBindings();

  /* A real standard pad displaces the overlay, releasing anything touch held. */
  const hid = ++PID;
  pev(btn('comms'), 'pointerdown', hid, 5, 5);
  input.pollPads([]);
  eq('TTD16 (setup) comms held by touch', input.isDown('comms'), true);
  const realPad = { connected: true, mapping: 'standard', id: 'xpad-test', buttons: [], axes: [0, 0, 0, 0] };
  input.pollPads([realPad]);
  eq('TTD17 a connected REAL standard pad wins the slot', input.pad.id, 'xpad-test');
  eq('TTD18 and the touch-held comms was released, not left sprinting into a wall',
    input.isDown('comms'), false);
  input.pollPads([realPad]);
  eq('TTD19 the overlay hides itself while the pad is connected',
    tc.root.classList.contains('displaced'), true);
  input.pollPads([]);
  input.pollPads([]);
  const tid = ++PID;
  pev(btn('use'), 'pointerdown', tid, 5, 5);
  input.pollPads([]);
  eq('TTD20 pad gone, touch resumes', input.wasPressed('use'), true);
  pev(btn('use'), 'pointerup', tid, 5, 5);
  input.endStep();
  tc.detach();
  emit();
}

/* ── TTE. look is a delta, and a tap is not a look ────────────────────────── */
async function sectionTTE() {
  heading('TTE. drag looks, tap interacts, and neither ever does the other');

  const { input, tc } = mkTouch();
  const zone = tc.root.querySelector('.cd-touch-lookzone');
  const zr = zone.getBoundingClientRect();
  const x0 = zr.left + 60, y0 = zr.top + zr.height * 0.5;

  /* Deltas leave scaled by LOOK_SCALE, as mouse-count equivalents. 40 px and 10 px are
   * dispatched exactly, so the sums are exact. */
  const id = ++PID;
  pev(zone, 'pointerdown', id, x0, y0);
  pev(zone, 'pointermove', id, x0 + 25, y0 + 10);
  pev(zone, 'pointermove', id, x0 + 40, y0 + 10);
  const l1 = tc.drainLook();
  near(`TTE1 a 40 px drag drains as 40 x ${LOOK_SCALE} look-units in x`, l1.x, 40 * LOOK_SCALE, 1e-6);
  near('TTE2 and 10 x scale in y', l1.y, 10 * LOOK_SCALE, 1e-6);
  note(`drained look: x=${l1.x.toFixed(2)}, y=${l1.y.toFixed(2)} (scale ${LOOK_SCALE})`);
  const l2 = tc.drainLook();
  eq('TTE3 draining empties the accumulator', l2.x === 0 && l2.y === 0, true);

  pev(zone, 'pointerup', id, x0 + 40, y0 + 10);
  input.pollPads([]);
  eq(`TTE4 a drag that travelled ${Math.round(Math.hypot(40, 10))} px (> ${TAP_SLOP_PX}) is NOT an interact`,
    input.wasPressed('interact'), false);
  input.endStep();

  /* The onLook callback path — what main.js wires to player.look / commsWheel.aim. */
  let got = { x: 0, y: 0 };
  tc.onLook = (dx, dy) => { got = { x: got.x + dx, y: got.y + dy }; };
  const id2 = ++PID;
  pev(zone, 'pointerdown', id2, x0, y0);
  pev(zone, 'pointermove', id2, x0 - 20, y0);
  pev(zone, 'pointerup', id2, x0 - 20, y0);
  near('TTE5 with onLook wired the deltas go to the callback instead', got.x, -20 * LOOK_SCALE, 1e-6);
  const l3 = tc.drainLook();
  eq('TTE6 and not to the accumulator as well — one consumer, never both', l3.x, 0);
  input.pollPads([]);
  input.endStep();
  tc.onLook = null;

  /* A still tap is the context verb: PadA, the default `interact` binding. */
  const id3 = ++PID;
  pev(zone, 'pointerdown', id3, x0, y0);
  pev(zone, 'pointerup', id3, x0, y0);
  input.pollPads([]);
  eq(`TTE7 a still tap (< ${TAP_MS} ms, <= ${TAP_SLOP_PX} px) fires interact`,
    input.wasPressed('interact'), true);
  input.endStep();
  tc.detach();
  emit();
}

/* ── TTF. the same game: a thumb and a W key are indistinguishable ────────── */
async function sectionTTF(content) {
  heading('TTF. a full thumb and the keyboard drive identical operatives');

  /* ⚠ Two lessons from this section's own first runs, both now load-bearing:
   *   · a mission on the operation card does not walk — committing the loadout is what
   *     moves BRIEFING -> ARRIVAL (m0 I3/I4), and forgetting it measured a proud 0.000 m
   *     on BOTH sides of a passing equality
   *   · 4000 ms of forward walks INTO A WALL ~8.59 m from the spawn, and two runs pinned
   *     against the same wall converge on the same displacement no matter what their
   *     speeds were — a sprint-beats-walk assertion went green on wall geometry, not on
   *     sprint. 1500 ms keeps the fastest run in open floor (measured below the 8.59 m
   *     plateau), so every distance here is speed, not architecture. */
  const slice = 50, walkMs = 1500;
  const mkGame = (seed) => {
    const g = new Game(content, { seed });
    g.commitLoadout(RECOMMENDED_MANIFEST);
    return g;
  };
  const drive = (g, input, ms) => {
    for (let t = 0; t < ms; t += slice) {
      input.pollPads([]);
      g.setCommand('p1', { axis: input.moveAxis(), sprint: input.isDown('sprint'), crouch: false });
      g.skipMs(slice);
      input.endStep();
    }
  };

  /* Axis parity first, at the seam itself: a full-forward thumb and a held W produce the
   * SAME floats out of moveAxis. (Full deflection also engages rim-sprint by design, so
   * the axis is compared here and the trajectory is compared on the sprint pairing where
   * both sides sprint.) */
  const inK = bareInput();
  inK._debugPress('KeyW');
  const { input: inT, tc } = mkTouch();
  const id = ++PID;
  const { zone, ox, oy, R } = stickDown(tc, id);
  pev(zone, 'pointermove', id, ox, oy - R);   // raw (0,-1): exactly the W key's axis
  inT.pollPads([]);
  eq('TTF1 full-forward thumb x equals W x, exactly', inT.moveAxis().x, inK.moveAxis().x);
  eq('TTF2 and y', inT.moveAxis().y, inK.moveAxis().y);
  eq('TTF3 and the rim also means sprint, as documented', inT.isDown('sprint'), true);

  /* Diagonal parity — TO ONE ULP, not to the bit, and the gap is structural: the
   * keyboard multiplies by the constant Math.SQRT1_2 (…5476) while the stick divides by
   * its measured hypotenuse (…5475), and the two roundings differ in the last bit. A
   * real gamepad's diagonal differs from the keyboard's by the same last bit, so this IS
   * pad parity; asserting bit-identity here would assert something the pad never had. */
  const inKD = bareInput();
  inKD._debugPress('KeyW'); inKD._debugPress('KeyD');
  pev(zone, 'pointermove', id, ox + R, oy - R);
  inT.pollPads([]);
  near('TTF4 diagonal x agrees with W+D to one ULP (the two normalisations round the last bit apart)',
    inT.moveAxis().x, inKD.moveAxis().x, 1e-15);
  near('TTF5 and diagonal y', inT.moveAxis().y, inKD.moveAxis().y, 1e-15);
  pev(zone, 'pointermove', id, ox, oy - R);

  /* Trajectory parity: rim-thumb versus W+Shift, same content, same seed. If touch is
   * truly the same code path the trajectories are the same FLOATS — exact equality, not
   * a tolerance, because "same code path" is an equality claim. */
  const gKS = mkGame('touch-sprint');
  const inKS = bareInput();
  inKS._debugPress('KeyW'); inKS._debugPress('ShiftLeft');
  const ks0 = { x: gKS.player.x, z: gKS.player.z };
  drive(gKS, inKS, walkMs);
  const distKS = dist(ks0.x, ks0.z, gKS.player.x, gKS.player.z);

  const gTS = mkGame('touch-sprint');
  const ts0 = { x: gTS.player.x, z: gTS.player.z };
  drive(gTS, inT, walkMs);
  const distTS = dist(ts0.x, ts0.z, gTS.player.x, gTS.player.z);

  note(`sprint ${walkMs} ms: Shift ${distKS.toFixed(3)} m, stick rim ${distTS.toFixed(3)} m`);
  ok('TTF6 both operatives actually moved', distKS > 1 && distTS > 1, `K=${distKS}, T=${distTS}`);
  eq('TTF7 and the distances are IDENTICAL FLOATS — one code path, not two in agreement',
    distTS, distKS);

  /* Speed ordering in open floor: walk (keyboard W), sprint (above), and mid-stick. */
  const gK = mkGame('touch-sprint');
  const inW = bareInput();
  inW._debugPress('KeyW');
  const k0 = { x: gK.player.x, z: gK.player.z };
  drive(gK, inW, walkMs);
  const distK = dist(k0.x, k0.z, gK.player.x, gK.player.z);
  note(`walk ${distK.toFixed(3)} m in the same window`);
  ok('TTF8 sprint outruns walk by a real margin in open floor, so the rim threshold engages sprint',
    distKS > distK * 1.05, `sprint ${distKS} vs walk ${distK}`);

  const gH = mkGame('touch-sprint');
  const { input: inH, tc: tcH } = mkTouch();
  const id3 = ++PID;
  const h = stickDown(tcH, id3);
  pev(h.zone, 'pointermove', id3, h.ox, h.oy - 0.61 * h.R);  // curved ~ .25
  const h0 = { x: gH.player.x, z: gH.player.z };
  drive(gH, inH, walkMs);
  const distH = dist(h0.x, h0.z, gH.player.x, gH.player.z);
  note(`mid-stick walked ${distH.toFixed(3)} m against ${distK.toFixed(3)} m at full walk`);
  ok('TTF9 mid-stick is measurably slower than full stick — the stick is analog, not four keys',
    distH > 0.2 && distH < distK * 0.6, `H=${distH}, K=${distK}`);

  tc.detach(); tcH.detach();
  emit();
}

/* ── TTG. geometry: targets, scale, insets, and the phone stylesheet ──────── */
async function sectionTTG() {
  heading('TTG. touch targets measure what §19.1 and the 44 px rule require');

  const { input, tc } = mkTouch();
  const root = tc.root;
  const btns = Array.from(root.querySelectorAll('.cd-touch-btn'));
  eq('TTG1 twelve buttons render: 7 verbs and 5 slots', btns.length, 12);

  const rects = btns.map((b) => ({ k: b.dataset.k, r: b.getBoundingClientRect() }));
  const small = rects.filter(({ r }) => r.width < 44 || r.height < 44);
  eq(`TTG2 every button is >= 44 CSS px at --cd-ui-scale:1${small.length ? ` — ${small.map((s) => s.k).join(',')}` : ''}`,
    small.length, 0);
  note(`sizes: ${rects.map(({ k, r }) => `${k}=${Math.round(r.width)}`).join(' ')}`);

  /* Overlapping hit boxes silently answer as whichever was laid out first — the
   * BedroomRacers SLOP lesson. All 66 pairs are checked. */
  const overlaps = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      if (!(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)) {
        overlaps.push(`${rects[i].k}+${rects[j].k}`);
      }
    }
  }
  eq(`TTG3 no two buttons overlap${overlaps.length ? ` — ${overlaps.join(' ')}` : ''}`, overlaps.length, 0);

  const w = window.innerWidth, h = window.innerHeight;
  const out = rects.filter(({ r }) => r.left < 0 || r.top < 0 || r.right > w || r.bottom > h);
  eq('TTG4 every button sits inside the viewport (safe-area insets are 0 here and additive)',
    out.length, 0);

  const sz = root.querySelector('.cd-touch-stickzone').getBoundingClientRect();
  const lz = root.querySelector('.cd-touch-lookzone').getBoundingClientRect();
  near('TTG5 the stick zone is the left 46% of the screen', sz.width, w * 0.46, 1.5);
  eq('TTG6 anchored at the left edge', sz.left, 0);
  near('TTG7 the look zone is the remaining right half', lz.width, w * 0.54, 1.5);
  near('TTG8 and they tile the width between them with no dead seam', sz.width + lz.width, w, 2);

  eq('TTG9 the root ignores pointers (HUD stays visible through it)',
    getComputedStyle(root).pointerEvents, 'none');
  eq('TTG10 while the zones take them', getComputedStyle(root.querySelector('.cd-touch-lookzone')).pointerEvents, 'auto');

  /* §19.1: the whole layout multiplies by --cd-ui-scale. 64 x 1.25 = 80 exactly. */
  const use = root.querySelector('.b-use');
  const before = use.getBoundingClientRect().width;
  document.documentElement.style.setProperty('--cd-ui-scale', '1.25');
  const after = use.getBoundingClientRect().width;
  document.documentElement.style.removeProperty('--cd-ui-scale');
  near('TTG11 --cd-ui-scale 1.25 scales a button by exactly 1.25 (§19.1)', after / before, 1.25, 0.01);
  note(`b-use: ${before.toFixed(1)} px -> ${after.toFixed(1)} px under scale 1.25`);

  /* Labels resolve through the fallback until content/locales grows touch.* keys —
   * never the raw key at a player. */
  eq('TTG12 the USE label falls back to English while touch.use is unauthored',
    use.textContent, 'USE');

  /* The phone stylesheet is width-gated and this desktop run must not be inside it. */
  eq('TTG13 the <=760 px sheet layout is inactive at desktop width (pixel-identical desktop)',
    window.matchMedia('(max-width:760px)').matches, false);
  const probe = document.createElement('div');
  probe.className = 'cd-panel';
  document.body.appendChild(probe);
  eq('TTG14 a .cd-panel still carries its desktop 24 px padding',
    getComputedStyle(probe).paddingLeft, '24px');
  probe.remove();

  input.pollPads([]);
  tc.detach();
  eq('TTG15 detach leaves the document clean for whoever tests next',
    document.querySelectorAll('.cd-touch').length, 0);
  emit();
}

/* ── run ──────────────────────────────────────────────────────────────────── */
suite('touch', async () => {
  await run('TTA', () => sectionTTA());
  await run('TTB', () => sectionTTB());
  await run('TTC', () => sectionTTC());
  await run('TTD', () => sectionTTD());
  await run('TTE', () => sectionTTE());
  const content = await loadContent();
  await run('TTF', () => sectionTTF(content));
  await run('TTG', () => sectionTTG());
});
