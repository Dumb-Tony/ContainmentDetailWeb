/* Presentation. Reads the simulation, owns nothing.
 *
 * TWO PASSES, ONE SCENE. The eye's view renders layer 0 with lights. The imager's view
 * renders layer 1 — the same structure, plus the thermal floor image, plus the draught
 * itself — through a NARROW camera into a small scissored rectangle. That narrowness is
 * the tool's documented cost (GDD §10.2: "Narrow view; vulnerable to environmental
 * noise"): you cannot watch the room and the screen at the same time, and the thing you
 * are hunting is only on the screen.
 *
 * ⚠ The imager pass must clear DEPTH but not colour, or the inset renders behind the
 * world it is drawn over. `autoClear = false` plus an explicit `clearDepth()` inside the
 * scissor is the whole of it.
 *
 * THE SIX CAMERA SLIDERS LIVE HERE. `applySettings()` is the only door: it takes
 * `settings.effective` (post-photosensitivity-clamp) and resolves it into `this.cam`, and
 * everything below reads `this.cam` and never a setting name. §19.1 asks for adjustable
 * fov, shake, bob, blur, grain and distortion; §18.1 says the UI must not misrepresent
 * what the game does, so a slider that moved nothing was the same defect as a lying HUD.
 *
 * ZERO MEANS OFF, STRUCTURALLY, NOT NUMERICALLY. A player who zeroes these is usually
 * doing it for motion sickness or photosensitivity, and "nearly off" is a different
 * promise. So each zero removes its code path rather than scaling it to a small number:
 * shake 0 leaves `camera.rotation.x` bit-equal to `player.pitch`, headBob 0 leaves
 * `camera.position.y` bit-equal to `eyeHeight()`, and all three post values at 0 skip the
 * offscreen target entirely and render straight to the framebuffer, exactly as this file
 * did before the sliders were wired up.
 */

import { CONFIG } from '../config.js';
import { buildScene } from './scene.js';
import { ThermalFloor } from './thermalFloor.js';

/* The shipped camera settings. Deliberately a copy of `DEFAULT_SETTINGS.camera` rather
 * than an import of it: settings.js reaches ui/hud.js, which reaches src/sim, and the
 * renderer is not allowed to pull the rule layer into its module graph. Both tables take
 * `fov` from CONFIG so the one value that could actually disagree cannot. */
const DEFAULT_CAMERA = Object.freeze({
  fov: CONFIG.render.fov, shake: 1, headBob: 1, motionBlur: 1, filmGrain: 1, distortion: 1,
});

/* The slider ranges, from SETTINGS_SCHEMA. Clamped here as well as there because
 * `applySettings` must survive a settings file written by a future version — a fov of 400
 * should read as 110, not as a fisheye nobody can undo from inside the fisheye. */
const FOV_MIN = 60, FOV_MAX = 110;

const TAU = Math.PI * 2;

/* Camera shake, at slider 1. Amplitudes are radians of peak rotation; each jolt is a
 * decaying ring, `amp * exp(-elapsed/tau)`, and the three axes ring at incommensurate
 * frequencies so a hit reads as a shove rather than a pendulum.
 *
 * Sines rather than noise ON PURPOSE: a mission replays from its seed (rng.js), and a
 * shake driven by sim time is the same shake on every replay without spending a draw from
 * anybody's stream. Nothing here calls Math.random, and nothing here needs an Rng. */
const SHAKE = Object.freeze({
  contact: 0.028,   // 1.6° — the cold goes through you and your leg stops answering
  downed:  0.055,   // 3.2° — the floor arrives
  door:    0.006,   // 0.34° at the hinge, attenuated by distance: a motor, not an impact
  tremor:  0.0035,  // 0.20° — a sustained shiver while you are down and bleeding
  doorFalloffM2: 36,
  tauMs: Object.freeze({ contact: 220, downed: 620, door: 170 }),
  hz: Object.freeze([11.3, 7.7, 15.1]),      // yaw, pitch, roll
  axis: Object.freeze([0.70, 1.00, 0.55]),   // an impact pitches more than it yaws
  /* Below this a jolt is 0.006° and can be dropped. Without a floor `exp` never reaches
   * zero and the list grows for the whole mission. */
  floorRad: 1e-4,
});

/* Head bob, at slider 1. Phase advances with DISTANCE WALKED rather than with time — a
 * clock-driven bob keeps bobbing while you stand still, which is the version of this
 * effect everybody has played and nobody wants. One step is π of phase, so the vertical
 * rise (once per step) is sin(2θ) and the roll (once per stride) is sin(θ). */
const BOB = Object.freeze({
  stepM: 0.72,
  /* 40mm peak-to-peak at a 2.6 m/s walk, measured. GDD §16.1 asks for documentary
   * realism, and a head that travels a hand's width per step is a platformer. */
  riseM: 0.020,
  rollRad: 0.0075,   // 0.43°
  maxSpeedK: 1.4,    // a sprint bobs more than a walk, but not 1.7x more
});

/* ── the lens pass ────────────────────────────────────────────────────────
 *
 * There is no EffectComposer in this build and r128's is not vendored, so motion blur,
 * film grain and lens distortion are one hand-rolled full-screen quad over an offscreen
 * target. Two of the three are the real effect; the third is an approximation, and the
 * comment on `_renderPost` says which and why.
 *
 * The plane is already at ±1 in clip space, so the vertex shader ignores the matrices
 * entirely and there is no per-frame matrix work at all. */
const POST_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/* The accumulation pass: this frame, laid over the running average at alpha = 1 - retain.
 * The blend function is the accumulator; there is no history texture to sample. */
const POST_ACCUM_FRAG = `
uniform sampler2D tSrc;
uniform float uMix;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, uMix); }
`;

/* Distortion and grain, in one tap-set.
 *
 * ⚠ The warp pulls samples INWARD (`vUv - d*k`), never outward. Pushing them outward
 * reads as the same barrel on screen and puts the corner samples outside [0,1], which is
 * four black wedges or four smeared ones depending on the wrap mode.
 *
 * ⚠ Both terms carry a factor of `uDistort` and a factor of r², so at the crosshair
 * (r = 0) the shift is exactly zero at every setting. A lens option that could move an
 * aim point would be a difficulty option wearing an accessibility label.
 *
 * Grain is monochrome and additive — film grain is achromatic, and a per-channel version
 * costs three hashes to look like chroma noise instead. */
const POST_LENS_FRAG = `
uniform sampler2D tSrc;
uniform float uGrain;
uniform float uDistort;
uniform float uTime;
uniform float uAspect;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 d = vUv - 0.5;
  vec2 a = vec2(d.x * uAspect, d.y);
  float r2 = dot(a, a);
  float k  = uDistort * 0.055 * r2;
  float ca = uDistort * 0.0022 * r2;
  vec3 col = vec3(
    texture2D(tSrc, vUv - d * (k + ca)).r,
    texture2D(tSrc, vUv - d * k).g,
    texture2D(tSrc, vUv - d * (k - ca)).b
  );
  col += (hash(gl_FragCoord.xy + uTime * 91.7) - 0.5) * uGrain * 0.055;
  gl_FragColor = vec4(col, 1.0);
}
`;

/* Peak strength of each post effect at slider 1. GDD §16.2 asks for "minimal chromatic
 * aberration, film grain, or lens dirt; all can be disabled", so 1.0 is the shipped
 * restrained amount and not a showreel. `blurRetain` is the fraction of the previous
 * composite kept per 1/60s — see `_renderPost` for why the exponent is there. */
const POST = Object.freeze({ blurRetain: 0.55, dtClampMs: Object.freeze([4, 50]) });

/**
 * Does the content say the eye can see it?
 *
 * Exported and pure so the suite can drive it against every shipped anomaly without a
 * WebGL context — the decision is a content question and does not need a renderer to
 * answer. `perception.channels` is the anomaly's own declaration: `visible` means a person
 * looking at it sees something, and `instrument-only` is the word the draught and the
 * lodger use to say the opposite. An anomaly declaring neither is treated as invisible,
 * because a thing that appears when its file did not say it would is the worse surprise.
 */
export function anomalyIsVisible(def) {
  const ch = ((def && def.perception) || {}).channels;
  return Array.isArray(ch) && ch.includes('visible');
}

/**
 * Does the content say the IMAGER registers it?
 *
 * ⚠ THE BODY WAS ON THE THERMAL LAYER UNCONDITIONALLY, so `perception.channels` was being
 * obeyed for one camera and ignored for the other. `coldharbour-passenger` declares
 * `visible`, `physical-trace` and `recorded` — not `thermal`, not `instrumental` — and its
 * resting tell is *"Nothing. What it is on looks exactly like what it is on."* It showed up
 * on the imager as a floating cold mass anyway, which is the §18.1 failure that costs
 * somebody an operation: the instrument answered a question the content says it cannot.
 *
 * `thermal` and `instrument-only` are the two words that mean the imager. `instrumental` is
 * deliberately NOT one of them: it appears on three anomalies and the evidence sets it
 * labels are microphones, cell meters and cameras as well as imagers, so reading it as
 * "thermal" would be inventing a claim out of a broader word. A file that means the imager
 * has two ways to say so and both are honoured.
 */
export function anomalyOnThermal(def) {
  const ch = ((def && def.perception) || {}).channels;
  if (!Array.isArray(ch)) return false;
  return ch.includes('thermal') || ch.includes('instrument-only');
}

/**
 * What shape the thing is, which the content has been saying all along.
 *
 * ⚠ EVERY ANOMALY IN THE BUILD WAS THE SAME 0.78m PURPLE ICOSAHEDRON. Five of the eight
 * declare `visible` in `perception.channels`, so five of them were drawn to the naked eye,
 * identically — including `stillwater-figure`, whose resting `visualTell` reads *"A figure
 * at the limit of the light, facing away, at the wrong scale for the distance"* and whose
 * entire containment is a squad looking at it. §18.1 says the presentation may not
 * misrepresent the state; a figure drawn as a ball is not a stylisation, it is the wrong
 * answer to the only question that operation asks.
 *
 * The tells were already written and already specific — "a mass about a metre across", "a
 * hole in the floor holding its shape and its edge", "eleven brass tallies and five of them
 * are the set". So `presence.form` names which of six shapes, and `presence.spanMetres`
 * gives the size the file already states in prose. Nothing here is invented: every span
 * below is a number some anomaly's own `visualTell` says out loud.
 *
 * ⚠ `none` IS A FORM AND NOT AN OMISSION. `ninety-one-tally` has no body — the eleven discs
 * are the anomaly, and `_syncInstances` draws them. A ball hovering at the set's centroid
 * is a thing the player can walk up to that does not exist, which is the worst class of
 * §18.1 failure: not a missing cue but a false one.
 *
 * A file that names no form gets `mass`, the shape everything used to be, so a content
 * error degrades to the old behaviour rather than to an invisible anomaly.
 */
export const ANOMALY_FORMS = Object.freeze({
  /** A cold mass at floor level. The draught, and the lodger against its partition. */
  mass: { span: 1.56, y: 0.9, halo: 1.5, build: (T, r) => new T.IcosahedronGeometry(r, 2) },

  /** A person, at the limit of the light. Lathed rather than assembled: one mesh keeps the
   *  layer and pulse handling identical to every other form, and a rotationally symmetric
   *  profile is exactly right for a thing you only ever see as a silhouette. */
  figure: {
    span: 0.44,
    y: 0,
    halo: 0,
    build: (T) => new T.LatheGeometry([
      [0.001, 1.78], [0.10, 1.72], [0.11, 1.62], [0.06, 1.55], [0.22, 1.46],
      [0.20, 1.05], [0.16, 0.90], [0.19, 0.80], [0.14, 0.42], [0.12, 0.06], [0.001, 0.00],
    ].map(([x, y]) => new T.Vector2(x, y)), 18),
  },

  /** Down on the ground with its ballast round it. A dome, flattened in the geometry rather
   *  than by a scale, because the per-frame pulse is a uniform scale and would fight it. */
  bed: {
    span: 1.0,
    y: 0.0,
    halo: 1.35,
    build: (T, r) => {
      const g = new T.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
      g.scale(1, 0.62, 1);
      return g;
    },
  },

  /** A hole in the floor that holds its shape and its edge. No bloom: the edge IS the tell,
   *  and a halo would be the one thing the content says it does not have. */
  fixture: { span: 0.9, y: 0.04, halo: 0, build: (T, r) => new T.CylinderGeometry(r, r, 0.08, 24) },

  /** In the thing rather than beside it. Small, and about the height of what it rides in. */
  carried: { span: 0.35, y: 0.7, halo: 1.6, build: (T, r) => new T.IcosahedronGeometry(r, 1) },

  /** No body. The set is the anomaly. */
  none: null,
});

export function anomalyForm(def) {
  const p = (def && def.presence) || {};
  const key = Object.prototype.hasOwnProperty.call(ANOMALY_FORMS, p.form) ? p.form : 'mass';
  const spec = ANOMALY_FORMS[key];
  if (!spec) return { key, spec: null, span: 0 };
  const span = typeof p.spanMetres === 'number' && p.spanMetres > 0 ? p.spanMetres : spec.span;
  return { key, spec, span };
}

/**
 * What each piece of equipment looks like on the floor.
 *
 * ⚠ EVERY DEPLOYABLE WAS A NEAR-IDENTICAL SMALL BOX. The tripod and the case had rigs of
 * their own; the other six shared one crate-with-a-stalk, so a motion sensor, a camera, a
 * microphone, a power pack, a heater and a flashlight could not be told apart across an
 * aisle — and this game's whole loop is a squad calling out equipment across an aisle. The
 * standard is the one PING_KINDS (src/sim/comms.js) already holds itself to, §18.5:
 * silhouettes differ in OUTLINE, not just colour — "a filled circle and a filled square are
 * one bad monitor away from being the same mark", and a dark cold store at 20m through fog
 * is a bad monitor. So no two rigs here share a primitive recipe: an A-frame is a tripod, a
 * lidded box is the case, a post with a fan wedge is a sensor, a mast with a tilted wedge
 * and a lens is a camera, a dish on a stand is the microphone, a squat box with a carry
 * loop is the pack, a drum with a glowing band is the heater, a small lying cylinder is the
 * flashlight, and a wide thin panel on feet is the barrier.
 *
 * KEYED BY ITEM ID, WHICH IS THE ALLOWED KIND OF NAME. Section K greps forbid the renderer
 * knowing any ANOMALY by name, because anomalies are content and content is authoritative.
 * Items are the other case: `content/equipment/items.json` is the engine's own manifest —
 * game.js, deployables.js and the HUD all dispatch on these ids already — so a table keyed
 * on them is presentation reading the engine's vocabulary, not the renderer inventing a
 * rule about somebody's content. An item this table has never heard of falls back to the
 * crate-with-a-stalk everything used to be (`fallback` below), so a new manifest row
 * degrades to the old look rather than to nothing.
 *
 * Each entry's `parts(THREE, COL, dims)` runs ONCE per placed deployable and returns plain
 * descriptors — geometry, position, colour, and three flags:
 *
 *   basic   MeshBasicMaterial instead of Lambert: the part is a light source or a glowing
 *           face, and a glowing face shaded by a headlamp is a contradiction.
 *   glow    only exists while the unit is powered. `_syncDeployables` toggles `visible` on
 *           the state change — never rebuilds — which is the thermalSwap discipline:
 *           geometry is built once, per-frame work is flags and material fields.
 *   pulse   the eye-side opacity breathes while powered (the case's heater, the heater's
 *           element). Opacity writes only; no allocation, no geometry.
 *
 * THE IMAGER TELLS THE TRUTH ABOUT DEAD UNITS. The old per-item thermal colour was
 * constant, so a flat tripod still read white-hot on the instrument. Now `thermal` is the
 * cold silhouette every part starts from, `thermalHot` (per part) is what a POWERED unit's
 * hot parts read as, and the same state change that dims the eye-side materials swaps the
 * thermal colour — so a fence post that died is cold on the screen that exists to say so,
 * which is the failure signal `fence-power` authored ("tripods dim in sequence").
 *
 * The parameter is named THREE, deliberately: suite check K14 greps `THREE\.<Class>`
 * against the vendored r128 bundle, and a table that called it `T` would put every
 * geometry class here outside the check that exists because of CapsuleGeometry.
 */
const TRIPOD_TILT = 0.30;
export const DEPLOYABLE_FORMS = Object.freeze({
  /** Three splayed legs, a head, and the lit pane itself. Tall and empty in the middle —
   *  nothing else on the floor is an A-frame. */
  'floodlight-tripod': Object.freeze({
    thermal: 0x243040,
    parts: (THREE, COL) => {
      /* Legs in a mid steel, not COL.tripod's near-black: photographed at 8m under one
       * luminaire, near-black legs vanished and the A-frame — the outline that IS this
       * rig — read as two floating antennas. The head keeps the dark housing colour. */
      const legs = [0, 1, 2].map((k) => {
        const a = (k / 3) * TAU;
        return {
          geo: new THREE.CylinderGeometry(0.028, 0.028, 1.62, 6),
          at: [Math.sin(a) * 0.30, 0.76, Math.cos(a) * 0.30],
          rot: [TRIPOD_TILT * Math.cos(a), 0, -TRIPOD_TILT * Math.sin(a)],
          color: 0x555b64,
        };
      });
      return [
        ...legs,
        /* The housing warms while the lamp runs — a 60C fitting, not a 20C one. */
        { geo: new THREE.BoxGeometry(0.42, 0.26, 0.22), at: [0, 1.62, 0], color: 0x8b8f96, thermalHot: 0x9a6a38 },
        { geo: new THREE.PlaneGeometry(0.34, 0.20), at: [0, 1.62, -0.115], rot: [-0.25, Math.PI, 0], color: 0xfff6da, basic: true, glow: true, thermalHot: 0xfff2c8 },
      ];
    },
  }),

  /** A lidded box with a proud rim, and the 39C heater strips that make it the bait. */
  'reinforced-transit-case': Object.freeze({
    thermal: 0x1c2833,
    parts: (THREE, COL) => [
      { geo: new THREE.BoxGeometry(0.90, 0.54, 0.64), at: [0, 0.27, 0], color: COL.case, thermalHot: 0xd8903a },
      { geo: new THREE.BoxGeometry(0.94, 0.06, 0.68), at: [0, 0.52, 0], color: 0x1d2126 },
      { geo: new THREE.BoxGeometry(0.98, 0.10, 0.72), at: [0, 0.585, 0], color: 0x9d7b34, thermalHot: 0xd8903a },
      { geo: new THREE.PlaneGeometry(0.62, 0.09), at: [0, 0.30, -0.323], rot: [0, Math.PI, 0], color: 0xffb060, basic: true, glow: true, pulse: true, opacity: 0.95, thermalHot: 0xffc070 },
      { geo: new THREE.PlaneGeometry(0.62, 0.10), at: [0, 0.637, 0], rot: [-Math.PI / 2, 0, 0], color: 0xffb060, basic: true, glow: true, pulse: true, opacity: 0.95, thermalHot: 0xffc070 },
    ],
  }),

  /** A post and the fan wedge that watches the lane. The wedge's wide face points the way
   *  the instrument does, so the rig SHOWS its coverage the way the camera below shows its
   *  tilt. */
  'motion-sensor': Object.freeze({
    thermal: 0x1c2833,
    parts: (THREE) => [
      { geo: new THREE.CylinderGeometry(0.026, 0.026, 0.96, 6), at: [0, 0.48, 0], color: 0x777d85 },
      { geo: new THREE.ConeGeometry(0.17, 0.34, 4, 1), at: [0, 1.02, -0.14], rot: [Math.PI / 2, 0, Math.PI / 4], color: 0x59606a },
    ],
  }),

  /** A mast with a tilted wedge and a lens barrel: it looks DOWN its approach lane. */
  'remote-camera': Object.freeze({
    thermal: 0x1c2833,
    parts: (THREE) => [
      { geo: new THREE.CylinderGeometry(0.02, 0.02, 1.12, 6), at: [0, 0.56, 0], color: 0x777d85 },
      { geo: new THREE.BoxGeometry(0.20, 0.13, 0.26), at: [0, 1.16, -0.02], rot: [-0.42, 0, 0], color: 0x4c545e },
      { geo: new THREE.CylinderGeometry(0.045, 0.045, 0.14, 8), at: [0, 1.10, -0.16], rot: [-(Math.PI / 2) - 0.42, 0, 0], color: 0x394049 },
    ],
  }),

  /** A dish on a stand, with the receiver stick at its focus. DoubleSide because the
   *  whole point of a dish is its concave face — and the stick is there because a lit
   *  bowl photographs as a ball from most angles (measured, docs/m7-gear.png's first
   *  take): the element poking out of the middle is what says "dish" from ANY angle,
   *  the way the fan wedge says "sensor". Tilted a few degrees up so the rim reads as
   *  an ellipse rather than an outline circle. */
  'directional-microphone': Object.freeze({
    thermal: 0x1c2833,
    parts: (THREE) => [
      { geo: new THREE.CylinderGeometry(0.022, 0.022, 0.88, 6), at: [0, 0.44, 0], color: 0x777d85 },
      { geo: new THREE.SphereGeometry(0.20, 12, 6, 0, TAU, 0, 0.85), at: [0, 0.92, 0.06], rot: [Math.PI / 2 - 0.10, 0, 0], color: 0x8a8f96, double: true },
      { geo: new THREE.CylinderGeometry(0.013, 0.013, 0.24, 5), at: [0, 0.93, -0.10], rot: [Math.PI / 2 - 0.10, 0, 0], color: 0x30363d },
    ],
  }),

  /** A squat box with a carry loop. Mildly warm on the imager while it feeds — its cells
   *  and fan are working — and cold the moment it is not. */
  'power-pack': Object.freeze({
    thermal: 0x1c2833,
    parts: (THREE, COL) => [
      { geo: new THREE.BoxGeometry(0.52, 0.34, 0.42), at: [0, 0.17, 0], color: COL.pack, thermalHot: 0x50361f },
      /* The loop stands across the box (plane facing ±z), in a mid grey: edge-on and
       * near-black it disappeared, and the loop is the rig's whole outline claim. */
      { geo: new THREE.TorusGeometry(0.15, 0.034, 6, 12), at: [0, 0.40, 0], color: 0x3f474f },
    ],
  }),

  /** A drum with a glowing element band and a cap. The band is the 78C the item file
   *  states, so it is the one deployable whose glow is the melody rather than a lamp. */
  'portable-heater': Object.freeze({
    thermal: 0x1c2833,
    parts: (THREE) => [
      { geo: new THREE.CylinderGeometry(0.21, 0.21, 0.56, 12), at: [0, 0.28, 0], color: 0x714b33, thermalHot: 0xffb066 },
      { geo: new THREE.CylinderGeometry(0.215, 0.215, 0.14, 12, 1, true), at: [0, 0.30, 0], color: 0xff6a2e, basic: true, glow: true, pulse: true, opacity: 0.9, double: true, thermalHot: 0xffd08a },
      { geo: new THREE.ConeGeometry(0.17, 0.14, 10), at: [0, 0.70, 0], color: 0x3a3f45 },
    ],
  }),

  /** A hand torch, lying where it was set down. The lens face lights when it is on and its
   *  thermal stays COLD either way — an LED torch is the one emitter here whose light is
   *  not heat, which is the contrast the item file says the floor teaches. */
  flashlight: Object.freeze({
    thermal: 0x1c2833,
    parts: (THREE) => [
      { geo: new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), at: [0, 0.045, 0], rot: [0, 0, Math.PI / 2], color: 0x30353b },
      { geo: new THREE.CylinderGeometry(0.05, 0.042, 0.07, 8), at: [0.135, 0.05, 0], rot: [0, 0, Math.PI / 2], color: 0x3c424a },
      { geo: new THREE.PlaneGeometry(0.075, 0.075), at: [0.175, 0.05, 0], rot: [0, Math.PI / 2, 0], color: 0xfff6d8, basic: true, glow: true },
    ],
  }),

  /** The one rig sized by its INSTANCE rather than by its item: the sim's barrierRect is
   *  the collision truth, and a panel drawn any other width would disagree with the wall
   *  the draught actually cannot cross (the scene.js header's founding rule). Feet sit on
   *  the long axis, whichever axis that is. */
  'portable-barrier': Object.freeze({
    thermal: 0x22303e,
    parts: (THREE, COL, dims) => {
      const w = (dims && dims.w) || 2.4, d = (dims && dims.d) || 0.2;
      const feet = w >= d
        ? [{ geo: new THREE.BoxGeometry(0.26, 0.10, d + 0.36), at: [w / 2 - 0.2, 0.05, 0], color: 0x565845 },
          { geo: new THREE.BoxGeometry(0.26, 0.10, d + 0.36), at: [-(w / 2 - 0.2), 0.05, 0], color: 0x565845 }]
        : [{ geo: new THREE.BoxGeometry(w + 0.36, 0.10, 0.26), at: [0, 0.05, d / 2 - 0.2], color: 0x565845 },
          { geo: new THREE.BoxGeometry(w + 0.36, 0.10, 0.26), at: [0, 0.05, -(d / 2 - 0.2)], color: 0x565845 }];
      return [
        { geo: new THREE.BoxGeometry(w, 1.86, d), at: [0, 0.93, 0], color: COL.barrier },
        { geo: new THREE.BoxGeometry(w + 0.06, 0.07, d + 0.06), at: [0, 1.93, 0], color: 0x8d8f7a },
        ...feet,
      ];
    },
  }),

  /** The crate-with-a-stalk every deployable used to be, kept as the DOCUMENTED FALLBACK:
   *  an item id this table has never heard of still puts a visible, walk-uppable object on
   *  the floor, and its very genericness is the bug report. */
  fallback: Object.freeze({
    thermal: 0x1c2833,
    parts: (THREE) => [
      { geo: new THREE.BoxGeometry(0.36, 0.4, 0.3), at: [0, 0.2, 0], color: 0x59606a },
      { geo: new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), at: [0, 0.62, 0], color: 0x777d85 },
    ],
  }),
});

/** The rig for an item id, through the documented fallback. Exported pure, like
 *  `anomalyForm`: the suite drives it with a stub THREE and no WebGL context. */
export function deployableForm(itemId) {
  return Object.prototype.hasOwnProperty.call(DEPLOYABLE_FORMS, itemId)
    ? DEPLOYABLE_FORMS[itemId] : DEPLOYABLE_FORMS.fallback;
}

/**
 * A squadmate's body, and how it differs from the thing the squad is watching.
 *
 * The stillwater-figure is ANOMALY_FORMS.figure: 1.78m, unlit, facing away, still. A
 * teammate lathed from the SAME profile would be the §18.1 failure with the highest stakes
 * in the build — "which silhouette do I shoot a callout at" must never be a coin flip — so
 * every field here is a deliberate distance from that profile, asserted by the suite:
 *
 *   · 1.70m with a helmet bump and wider shoulders — different height, different posture;
 *   · a HEADLAMP: a lit face on the helmet and a visible beam cone. The figure is defined
 *     by being at the limit of the light; a mate is defined by bringing their own;
 *   · an armband in their seat's colour, on a MeshBasicMaterial so it reads in the dark.
 *     §19.2: the colour is the redundant channel (which mate), never the required one
 *     (that it IS a mate — the lamp and the profile carry that), and the HUD roster says
 *     the same thing in text.
 *
 * Five band colours for five seats (net/protocol.js MAX_SQUAD), chosen far apart in hue
 * AND in lightness so the common colour-vision confusions (§19.2 again) still get a
 * light/dark difference to hold on to.
 */
export const MATE_FORM = Object.freeze({
  /* Lathe profile, feet at y=0: boot, hip, chest, shoulder shelf, neck, helmet. */
  profile: Object.freeze([
    [0.001, 1.70], [0.10, 1.665], [0.115, 1.575], [0.105, 1.52], [0.065, 1.475],
    [0.24, 1.38], [0.22, 1.02], [0.19, 0.88], [0.21, 0.78], [0.15, 0.40],
    [0.13, 0.05], [0.001, 0.00],
  ]),
  bands: Object.freeze([0x9aa5b1, 0x3f8fd4, 0xd4a13f, 0x3fd4a5, 0xc65fd4]),
  lampColor: 0xffeedd,
});

/** Which band a seat wears. Seat ids are `p1`..`p5` (game.js `addPlayer`); anything else
 *  (a malformed snapshot, a future seat scheme) wears the first band rather than crashing
 *  a frame. */
export function mateBand(playerId) {
  const n = parseInt(String(playerId).slice(1), 10);
  const b = MATE_FORM.bands;
  return b[Number.isFinite(n) && n >= 1 ? (n - 1) % b.length : 0];
}

export class Renderer {
  constructor(THREE, canvas, game) {
    this.THREE = THREE;
    this.game = game;
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio));
    this.renderer.autoClear = false;

    this.thermalFloor = new ThermalFloor(THREE, game.site.bounds);
    const built = buildScene(THREE, game.site, { thermalFloorTexture: this.thermalFloor.texture });
    Object.assign(this, built);

    this.camera = new THREE.PerspectiveCamera(CONFIG.render.fov, 1, CONFIG.render.near, CONFIG.render.far);
    this.camera.rotation.order = 'YXZ';
    this.camera.layers.set(0);

    this.thermalCam = new THREE.PerspectiveCamera(CONFIG.render.thermalFov, 1, CONFIG.render.near, CONFIG.render.far);
    this.thermalCam.rotation.order = 'YXZ';
    this.thermalCam.layers.set(1);

    /* The headlamp. No battery: darkness is a mechanic, but being unable to see your own
     * hands is not one, and a torch that dies mid-procedure would punish the wrong thing. */
    this.lamp = new THREE.SpotLight(0xffeedd, 1.7, 21, 0.66, 0.42, 1.3);
    this.lamp.position.set(0, 0, 0);
    this.lampTarget = new THREE.Object3D();
    this.scene.add(this.lamp, this.lampTarget);
    this.lamp.target = this.lampTarget;
    /**
     * The anomaly's body.
     *
     * ⚠ THIS WAS LAYER 1 ALONE FOR EVERY ANOMALY, and the comment said "it is not in the
     * visible spectrum" — true of `graybox-draught`, which the file was written against,
     * and false of four of the six shipped now. The main camera is `layers.set(0)`, so
     * NOTHING was visible to the naked eye whatever its content said, including
     * `stillwater-figure`, whose entire containment is a squad looking at it. A rule you
     * cannot see the subject of is not observable (§8.2), and the file already answered
     * the question: `perception.channels` says which channels register it.
     *
     * `visible` means the eye sees it. The halo stays on layer 1 whatever happens: it is
     * the thermal bloom around a cold mass, not a thing in the room.
     */
    const form = anomalyForm(this.game && this.game.anomaly && this.game.anomaly.def);
    this._form = form;
    const geo = form.spec
      ? form.spec.build(THREE, form.span / 2)
      : new THREE.BufferGeometry();
    this.anomalyMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x2b0f4a }));
    const def = this.game && this.game.anomaly && this.game.anomaly.def;
    this.anomalyMesh.layers.disableAll();
    if (anomalyOnThermal(def)) this.anomalyMesh.layers.enable(1);
    if (anomalyIsVisible(def)) this.anomalyMesh.layers.enable(0);
    this.scene.add(this.anomalyMesh);
    this.anomalyHalo = new THREE.Mesh(
      form.spec && form.spec.halo
        ? new THREE.IcosahedronGeometry((form.span / 2) * form.spec.halo, 2)
        : new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x120a24, transparent: true, opacity: 0.55, side: THREE.BackSide }),
    );
    /* The halo is the thermal bloom around a cold mass, so it follows the body onto the
     * imager and never onto the eye — and if the imager cannot register the body, there is
     * nothing for it to bloom around. */
    this.anomalyHalo.layers.disableAll();
    if (anomalyOnThermal(def)) this.anomalyHalo.layers.enable(1);
    this.scene.add(this.anomalyHalo);

    /* The imager screen's own black. Not the scene background — a screen that shared the
     * room's colour would have no edge, and the bezel is what tells you the view is narrow. */
    this._thermalBg = new THREE.Color(0x04060b);

    /* Teammates. A body is a silhouette plus a headlamp, because in a dark cold store the
     * thing you actually track is somebody else's light — and on the imager they are the
     * second-warmest thing on the floor, which is exactly what makes standing next to the
     * bait a bad idea. */
    this._mateMeshes = new Map();  // playerId -> {group, lamp, beam}

    this._depMeshes = new Map();   // uid -> {group, light, lit, glows, pulses}
    this._iceMeshes = [];
    this._iceGeo = new THREE.CircleGeometry(1, 18);
    this._iceMat = new THREE.MeshBasicMaterial({ color: 0xbcd7e6, transparent: true, opacity: 0.4 });

    /* Camera motion state. `_lastT` is null rather than 0 so the first frame spends no
     * delta — bob phase is a distance integral and a 500-second first step would teleport
     * it. Everything here is driven off `game.clock.simTimeMs`; the renderer never reads a
     * wall clock (that rule is section K of the suite, and it is what lets a paused frame
     * be genuinely still rather than slowly crawling). */
    this._jolts = [];
    this._bobPhase = 0;
    this._lastT = null;

    this._rtScene = null;
    this._rtAccum = null;
    this._accumFresh = true;
    this._postScene = null;

    /* Shake listens to the same events the audio cues do, so a jolt and its thud cannot
     * disagree about when they happened. The renderer only LISTENS — it emits nothing and
     * decides nothing (GDD §21.5).
     *
     * Event names are literals, matching audio.js's cue table, because importing EVENTS
     * from game.js would drag src/sim into the renderer's module graph for three strings.
     * The suite cross-checks these keys against the real vocabulary, the same way it
     * checks audio.js's captions. */
    const bus = game.bus;
    bus.on('CONTACT', (e) => {
      if (!this._isMe(e.id)) return;
      this._jolt(SHAKE.contact, SHAKE.tauMs.contact, e.simTimeMs);
    });
    bus.on('OPERATIVE_DOWNED', (e) => {
      if (!this._isMe(e.id)) return;
      this._jolt(SHAKE.downed, SHAKE.tauMs.downed, e.simTimeMs);
    });
    bus.on('DOOR_CHANGED', (e) => {
      /* A cold-store door is a motor and a lot of mass. You feel it through the floor if
       * you are near it and not at all from across the bay, so the amplitude is the
       * inverse-square of the distance to the door mesh the scene already placed. */
      const rec = this.doorMeshes.get(e.id);
      const p = this.game.viewPlayer;
      if (!rec || !p) return;
      const dx = rec.mesh.position.x - p.x, dz = rec.mesh.position.z - p.z;
      this._jolt(SHAKE.door / (1 + (dx * dx + dz * dz) / SHAKE.doorFalloffM2), SHAKE.tauMs.door, e.simTimeMs);
    });

    /* Resolve the shipped defaults now, so a build whose boot loop forgets to call
     * applySettings still renders the same picture it always did. */
    this.applySettings(null);
    this.resize();
  }

  /**
   * The only door the six camera sliders come through.
   *
   * @param {object} effective `settings.effective` — already carrying the
   *   photosensitivity clamps, which is why nothing below re-checks safety.
   *
   * Idempotent and total: safe once, safe every frame, and safe with a partial or absent
   * object. A settings file from a future version must not brick the renderer, so every
   * field falls back to the shipped default and every value is clamped to its slider's
   * own range rather than trusted.
   */
  applySettings(effective) {
    const c = (effective && effective.camera) || DEFAULT_CAMERA;
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const unit = (v, d) => Math.max(0, Math.min(1, num(v, d)));

    this.cam = {
      fov: Math.max(FOV_MIN, Math.min(FOV_MAX, num(c.fov, DEFAULT_CAMERA.fov))),
      shake: unit(c.shake, DEFAULT_CAMERA.shake),
      headBob: unit(c.headBob, DEFAULT_CAMERA.headBob),
      motionBlur: unit(c.motionBlur, DEFAULT_CAMERA.motionBlur),
      filmGrain: unit(c.filmGrain, DEFAULT_CAMERA.filmGrain),
      distortion: unit(c.distortion, DEFAULT_CAMERA.distortion),
    };

    /* THE IMAGER KEEPS ITS OWN FOV, and this is the one call in the file worth arguing
     * about. The thermal camera is an instrument with a fixed lens, and its narrowness is
     * the tool's documented cost (GDD §10.2, and the paragraph at the top of this file):
     * you cannot watch the room and the screen at once. If it followed the eye, a player
     * who set 110° for comfort would get a 2.2x wider instrument than a player who set
     * 60° — an accessibility slider silently handing out an advantage, which is exactly
     * what settings.js's header forbids ("nothing here is allowed to change WHAT the site
     * does") and what §19.2 means by preserving the challenge of interpretation. So the
     * eye is the player's and the instrument is the instrument's.
     *
     * Guarded because updateProjectionMatrix is not free and this may be called per frame. */
    if (this.camera.fov !== this.cam.fov) {
      this.camera.fov = this.cam.fov;
      this.camera.updateProjectionMatrix();
    }
    return this.cam;
  }

  _isMe(id) {
    const p = this.game.viewPlayer;
    return !!p && p.id === id;
  }

  /** Queue a decaying ring. Amplitude is pre-shake: the slider is applied at read time so
   *  a player who turns shake down mid-jolt sees it stop, not fade at the old size. */
  _jolt(ampRad, tauMs, simTimeMs) {
    if (!(ampRad > SHAKE.floorRad)) return;
    this._jolts.push({ amp: ampRad, tauMs, t0: simTimeMs || 0 });
    /* Bounded, like the event log is. Eight overlapping jolts is already more than a
     * human reads as anything but one shove. */
    if (this._jolts.length > 8) this._jolts.shift();
  }

  /** Summed jolt rotation at sim time `t`, in radians, BEFORE the shake multiplier.
   *  Expired jolts are pruned here rather than on a timer — the renderer has no timer. */
  _jolted(t) {
    let yaw = 0, pitch = 0, roll = 0;
    for (let i = this._jolts.length - 1; i >= 0; i--) {
      const j = this._jolts[i];
      const e = (t - j.t0) / j.tauMs;
      const a = j.amp * Math.exp(-e);
      /* e < 0 is a clock that went backwards — a restart. Drop it rather than ring forever. */
      if (e < 0 || !(a > SHAKE.floorRad)) { this._jolts.splice(i, 1); continue; }
      const u = (t - j.t0) / 1000;
      yaw += a * SHAKE.axis[0] * Math.sin(u * SHAKE.hz[0] * TAU);
      pitch += a * SHAKE.axis[1] * Math.sin(u * SHAKE.hz[1] * TAU + 1.1);
      roll += a * SHAKE.axis[2] * Math.sin(u * SHAKE.hz[2] * TAU + 2.3);
    }
    return { yaw, pitch, roll };
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.thermalCam.aspect = 1;
    this.thermalCam.updateProjectionMatrix();
    this.viewW = w; this.viewH = h;
  }

  /**
   * Where the imager screen sits — in CSS pixels, origin bottom-left.
   *
   * ⚠ CSS pixels, not device pixels. `WebGLRenderer.setViewport`/`setScissor` multiply by
   * the pixel ratio themselves; pre-multiplying puts the imager off-screen on any display
   * with dpr > 1, which is most of them, and it looks like the pass simply did not run.
   * Origin bottom-left is GL's convention, hence `1 - cy`.
   */
  imagerRect() {
    const r = CONFIG.render.imagerRect;
    const side = Math.round(Math.min(this.viewW, this.viewH) * r.h);
    const x = Math.round(this.viewW * r.cx - side / 2);
    const y = Math.round(this.viewH * (1 - r.cy) - side / 2);
    return { x, y, w: side, h: side };
  }

  /** CSS-pixel version of the same rectangle, for the HUD bezel. */
  imagerRectCss() {
    const r = CONFIG.render.imagerRect;
    const side = Math.min(this.viewW, this.viewH) * r.h;
    return { left: this.viewW * r.cx - side / 2, top: this.viewH * r.cy - side / 2, size: side };
  }

  /**
   * The distributed set (GDD §26.2). Small objects on the floor, and the whole point of
   * them is that they are indistinguishable.
   *
   * ⚠ ONE MESH, ONE COLOUR, ONE SIZE, FOR ALL OF THEM. It would be trivial to tint the
   * real ones and it would delete the incident: the squad's job is to tell them apart with
   * an instrument, and a renderer that answered the question for free would make the
   * imager decoration. The eye view is deliberately unhelpful here.
   *
   * On the imager they are DARK — colder than the floor — and that is the only channel
   * that distinguishes them. It is not drawn from a per-object flag either: the thermal
   * floor already paints the field, and these sit on top of what it paints.
   */
  _syncInstances() {
    const THREE = this.THREE;
    const set = this.game.instances;
    if (!set || !set.candidates) return;
    if (!this._instMeshes) this._instMeshes = new Map();
    for (const inst of set.list) {
      let g = this._instMeshes.get(inst.id);
      if (!g) {
        g = new THREE.Group();
        const disc = new THREE.Mesh(
          new THREE.CylinderGeometry(0.075, 0.075, 0.022, 10),
          new THREE.MeshLambertMaterial({ color: 0xb08d4a }),
        );
        disc.position.y = 0.011;
        g.add(disc);
        g.traverse((o) => {
          o.layers.enable(1);
          if (!o.isMesh) return;
          o.userData.thermalMat = new THREE.MeshBasicMaterial({ color: 0x0a1420 });
          this.thermalSwap.push(o);
        });
        this.scene.add(g);
        this._instMeshes.set(inst.id, g);
      }
      /* Carried in the hands and deposited in the case are both "not on the floor", and
       * neither wants a disc lying at the operative's feet. */
      g.visible = inst.loose;
      if (inst.loose) g.position.set(inst.x, 0, inst.z);
    }
  }

  /** This instance's anomaly, through the pure reader above. */
  _anomalyIsVisible() {
    return anomalyIsVisible(this.game && this.game.anomaly && this.game.anomaly.def);
  }

  /**
   * @param {number} t sim time, for the powered-glow pulse. Everything here follows the
   * build-once rule at the head of DEPLOYABLE_FORMS: a rig is constructed on the frame its
   * deployable first exists and after that this loop only writes positions, intensities,
   * `visible` flags, opacities and material colours.
   */
  _syncDeployables(t) {
    const THREE = this.THREE;
    const seen = new Set();
    for (const d of this.game.deployables.list) {
      seen.add(d.uid);
      let rec = this._depMeshes.get(d.uid);
      if (!rec) {
        const g = new THREE.Group();
        const spec = deployableForm(d.itemId);
        /* Only the barrier reads its instance: the panel must be exactly the wall the sim
         * collides the draught against, never the item's nominal width. */
        let dims = null;
        if (d.isBarrier) {
          const r = d.barrierRect();
          dims = { w: Math.max(0.18, r[2] - r[0]), d: Math.max(0.18, r[3] - r[1]) };
        }
        const glows = [], pulses = [];
        for (const part of spec.parts(THREE, this.COL, dims)) {
          const opts = { color: part.color };
          if (part.opacity !== undefined) { opts.transparent = true; opts.opacity = part.opacity; }
          if (part.double || part.glow) opts.side = THREE.DoubleSide;
          const mesh = new THREE.Mesh(part.geo,
            part.basic ? new THREE.MeshBasicMaterial(opts) : new THREE.MeshLambertMaterial(opts));
          mesh.position.set(part.at[0], part.at[1], part.at[2]);
          if (part.rot) mesh.rotation.set(part.rot[0], part.rot[1], part.rot[2]);
          /* The thermal layer, part by part. `thermal` is the cold silhouette; a part with
           * a `thermalHot` swaps to it while the unit is powered (below), so the imager
           * never shows a dead unit warm. Built here rather than by a traverse because the
           * hot/cold pair is per-part information a traverse would have to rediscover. */
          mesh.layers.enable(1);
          mesh.userData.thermalMat = new THREE.MeshBasicMaterial({ color: part.thermalHot !== undefined ? part.thermalHot : spec.thermal });
          if (part.thermalHot !== undefined) {
            mesh.userData.thermalHot = part.thermalHot;
            mesh.userData.thermalCold = spec.thermal;
          }
          this.thermalSwap.push(mesh);
          if (part.glow) glows.push(mesh);
          if (part.pulse) pulses.push({ material: mesh.material, base: part.opacity !== undefined ? part.opacity : 1 });
          g.add(mesh);
        }
        g.position.set(d.x, 0, d.z);
        /* ⚠ NOT the barrier. `barrierRect()` is already a WORLD-axis-aligned answer (the
         * sim quarter-snaps the yaw and bakes it into the AABB), so the rig built from
         * those dims is already oriented — rotating the group by yaw on top of that drew
         * the panel CROSSWISE to its own collider at the ±90° snaps: a wall you walked
         * through beside a gap you could not. The visible surface and the collider come
         * from the same rect or they disagree (the scene.js founding rule). */
        g.rotation.y = d.isBarrier ? 0 : d.yaw;
        this.scene.add(g);

        let light = null;
        /* ⚠ THE ITEM DECIDES, NOT THIS LIST. `game.lightAt()` stopped naming items when
         * the floodlight's radius moved into items.json, and this did not — so a deployed
         * flashlight lit the simulation (it counts against `stepStress`'s darkness) and
         * cast nothing at all on screen. The two halves disagreed about whether a room was
         * dark, and only the invisible half was right. The heater keeps its glow through
         * `isEmitter` because heat is what it has instead of a light radius. */
        if (d.item.lightRadiusMetres || d.isEmitter) {
          const reach = d.item.lightRadiusMetres ? d.item.lightRadiusMetres * 1.7 : 11;
          light = new THREE.PointLight(d.itemId === 'portable-heater' ? 0xff8a4a : 0xfff0d0, 0, reach, 1.5);
          light.position.set(d.x, d.item.lightRadiusMetres && d.item.bulk !== 'long' ? 0.35 : 1.6, d.z);
          this.scene.add(light);
        }
        /* `lit` starts true to match the materials as authored, so the first sync is a
         * no-op rather than a brighten. */
        rec = { group: g, light, lit: true, glows, pulses };
        this._depMeshes.set(d.uid, rec);
      }
      rec.group.position.set(d.x, 0, d.z);
      /* A dead unit goes dark and greys, its glow faces vanish, and its hot parts go cold
       * on the imager — the failure signal the content authored for `fence-power`
       * ("floodlight tripods dim in sequence as the pack sheds load"), on every channel at
       * once, because the light going out is only visible if you were looking. */
      if (rec.light) rec.light.intensity = d.active ? 1.5 : 0;
      if (rec.lit !== d.active) {
        rec.lit = d.active;
        for (const m of rec.glows) m.visible = d.active;
        rec.group.traverse((o) => {
          if (!o.isMesh) return;
          if (o.userData.thermalHot !== undefined) {
            o.userData.thermalMat.color.setHex(d.active ? o.userData.thermalHot : o.userData.thermalCold);
          }
          if (o.material.color && !rec.glows.includes(o)) o.material.color.multiplyScalar(d.active ? 1 / 0.55 : 0.55);
        });
      }
      /* The powered breath — the case's §so-named "subtle emissive pulse", shared by the
       * heater element. Sub-Hz and shallow: a beacon strobe would out-shout the anomaly. */
      if (d.active && rec.pulses.length) {
        const k = 0.72 + 0.28 * Math.sin(t / 520);
        for (const p of rec.pulses) p.material.opacity = p.base * k;
      }
    }
    for (const [uid, rec] of this._depMeshes) {
      if (seen.has(uid)) continue;
      /* Drop it out of the swap list too, or a retrieved tripod leaves a dead mesh that
       * the thermal pass keeps reassigning materials to forever. */
      rec.group.traverse((o) => {
        const i = this.thermalSwap.indexOf(o);
        if (i >= 0) this.thermalSwap.splice(i, 1);
      });
      this.scene.remove(rec.group);
      if (rec.light) this.scene.remove(rec.light);
      this._depMeshes.delete(uid);
    }
  }

  _syncMates() {
    const THREE = this.THREE;
    const me = this.game.viewPlayer;
    const seen = new Set();
    for (const p of this.game.players) {
      if (p === me) continue;
      seen.add(p.id);
      let rec = this._mateMeshes.get(p.id);
      if (!rec) {
        const g = new THREE.Group();
        /**
         * A person, lathed like ANOMALY_FORMS.figure and deliberately NOT it — the whole
         * argument is on MATE_FORM. (The rig this replaced was a capsule-or-cylinder whose
         * feature test was `new THREE.CapsuleGeometry ? a : b`, which CONSTRUCTS before it
         * tests — `new` binds tighter than `?:` — and threw in the rAF loop on every frame
         * with a second operative in it, r128 having no CapsuleGeometry. Solo play never
         * reaches this line, so 805 assertions stayed green over a defect that broke the
         * whole of co-op rendering. Section K greps for the shape now, and the lathe needs
         * no feature test at all.)
         */
        const body = new THREE.Mesh(
          new THREE.LatheGeometry(MATE_FORM.profile.map(([x, y]) => new THREE.Vector2(x, y)), 14),
          new THREE.MeshLambertMaterial({ color: 0x3f4d5a }),
        );
        g.add(body);
        /* The armband. Basic, because its job is to say WHICH mate from across a dark
         * floor, and a Lambert band is black anywhere the viewer's own lamp is not. */
        const band = new THREE.Mesh(
          new THREE.CylinderGeometry(0.247, 0.247, 0.09, 12, 1, true),
          new THREE.MeshBasicMaterial({ color: mateBand(p.id), side: THREE.DoubleSide }),
        );
        band.position.y = 1.30;
        g.add(band);
        /* The headlamp's lit face, on the helmet, on the side the lamp light comes from. */
        const lampFace = new THREE.Mesh(
          new THREE.BoxGeometry(0.09, 0.05, 0.05),
          new THREE.MeshBasicMaterial({ color: MATE_FORM.lampColor }),
        );
        lampFace.position.set(0, 1.60, -0.10);
        g.add(lampFace);
        /* Warm on the imager — an operative is 37C and the second-brightest thing here.
         * Everything so far is body; the beam cone is added AFTER this traverse, because
         * a cone of lamplight must not exist on the thermal layer (light is not heat, the
         * flashlight rule again). */
        g.traverse((o) => {
          o.layers.enable(1);
          if (!o.isMesh) return;
          o.userData.thermalMat = new THREE.MeshBasicMaterial({ color: 0xc2703a });
          this.thermalSwap.push(o);
        });
        /* The beam: an open additive cone from the helmet down the facing, the thing you
         * actually track across a dark cold store. Layer 0 only, not in thermalSwap. */
        const beam = new THREE.Mesh(
          new THREE.ConeGeometry(0.34, 1.7, 12, 1, true),
          new THREE.MeshBasicMaterial({
            color: 0xffe8c2, transparent: true, opacity: 0.07,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
          }),
        );
        beam.position.set(0, 1.50, -0.80);
        beam.rotation.x = Math.PI / 2;
        g.add(beam);
        this.scene.add(g);
        const lamp = new THREE.PointLight(0xffeedd, 0.9, 7, 1.6);
        this.scene.add(lamp);
        rec = { group: g, lamp, beam };
        this._mateMeshes.set(p.id, rec);
      }
      /* Downed: pivoted at the feet onto their back, sunk a hand's width so the lathe's
       * shoulders read as lying on the concrete rather than balancing on it. */
      const y = p.downed ? -0.12 : 0;
      rec.group.position.set(p.x, y, p.z);
      rec.group.rotation.y = p.yaw;
      rec.group.rotation.x = p.downed ? Math.PI / 2.2 : 0;
      rec.lamp.position.set(p.x - Math.sin(p.yaw) * 0.4, p.downed ? 0.4 : 1.6, p.z - Math.cos(p.yaw) * 0.4);
      const lampOn = p.alive && p.connected;
      rec.lamp.intensity = lampOn ? 0.9 : 0.15;
      /* The beam follows the lamp's own state: a disconnected seat's operative stands
       * dark, which is also the honest render of "nobody is holding that torch". */
      rec.beam.visible = lampOn;
      rec.group.visible = p.alive;
    }
    for (const [id, rec] of this._mateMeshes) {
      if (seen.has(id)) continue;
      rec.group.traverse((o) => {
        const i = this.thermalSwap.indexOf(o);
        if (i >= 0) this.thermalSwap.splice(i, 1);
      });
      this.scene.remove(rec.group);
      this.scene.remove(rec.lamp);
      this._mateMeshes.delete(id);
    }
  }

  _syncIce() {
    const patches = this.game.anomaly.icePatches;
    while (this._iceMeshes.length < patches.length) {
      const m = new this.THREE.Mesh(this._iceGeo, this._iceMat);
      m.rotation.x = -Math.PI / 2;
      m.layers.enable(1);
      this.scene.add(m);
      this._iceMeshes.push(m);
    }
    for (let i = 0; i < this._iceMeshes.length; i++) {
      const m = this._iceMeshes[i], p = patches[i];
      m.visible = !!p;
      if (p) { m.position.set(p.x, 0.02, p.z); m.scale.setScalar(p.r); }
    }
  }

  _syncLights() {
    for (const rec of this.luminaireLights) {
      const { light, def } = rec;
      const on = def.emergency || (def.circuitId && this.game.site.circuitOn(def.circuitId));
      light.intensity = on ? (def.emergency ? 0.55 : 1.15) : 0;
      /* The fitting's lit diffuser (scene.js builds it dark). Without this, a live circuit
       * was only visible by what it did to the floor — you could stand under a working
       * luminaire and not be able to SAY it was working, which fails §8.2 for the one
       * system whose whole job is being pointed at ("get that circuit back up"). */
      if (rec.glow) rec.glow.visible = !!on;
    }
    for (const dr of this.game.site.doors) {
      const rec = this.doorMeshes.get(dr.id);
      /* ⚠ Lift an open door CLEAR of the ceiling, not level with it. At exactly the ceiling
       * height the door's underside and the ceiling plane are coplanar, and the z-fight
       * paints a gold stripe across the ceiling of the whole bay. */
      if (rec) rec.mesh.position.y = dr.open ? rec.closedY + this.game.site.ceilingHeight + 0.5 : rec.closedY;
    }
  }

  /** Swap every structural mesh to its unlit thermal material, and back. The list is built
   *  once at scene build time and appended to as deployables appear, so this is a walk of
   *  a flat array rather than a scene traversal at 60Hz. */
  _setThermalMaterials(on) {
    for (const m of this.thermalSwap) {
      if (!m.userData.thermalMat) continue;
      if (on) { m.userData.eyeMat = m.material; m.material = m.userData.thermalMat; }
      else if (m.userData.eyeMat) { m.material = m.userData.eyeMat; }
    }
  }

  /**
   * The offscreen target the world renders into when any post effect is on — or null when
   * none of them is, in which case the world goes straight to the framebuffer and this
   * whole file behaves exactly as it did before the sliders were wired.
   *
   * Sizing is checked every frame rather than hooked to resize(), because the drawing
   * buffer also changes when the window moves between displays of different pixel ratios,
   * and that fires no resize event.
   */
  _postTarget() {
    const on = this.cam.motionBlur > 0 || this.cam.filmGrain > 0 || this.cam.distortion > 0;
    if (!on) {
      if (this._rtScene) { this._rtScene.dispose(); this._rtScene = null; }
      if (this._rtAccum) { this._rtAccum.dispose(); this._rtAccum = null; }
      return null;
    }
    const THREE = this.THREE;
    if (!this._postScene) {
      const uni = { tSrc: { value: null } };
      this._accumMat = new THREE.ShaderMaterial({
        uniforms: { ...uni, uMix: { value: 1 } },
        vertexShader: POST_VERT,
        fragmentShader: POST_ACCUM_FRAG,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        /* ⚠ CustomBlending with the factors named, not NormalBlending. Which pair
         * NormalBlending resolves to depends on `material.premultipliedAlpha`, and this
         * pass is an accumulator whose whole behaviour is the blend function — a silently
         * different one is a picture that either never fades or never accumulates. */
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      this._lensMat = new THREE.ShaderMaterial({
        uniforms: {
          ...uni,
          uGrain: { value: 0 }, uDistort: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1 },
        },
        vertexShader: POST_VERT,
        fragmentShader: POST_LENS_FRAG,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
      });
      this._postScene = new THREE.Scene();
      this._postMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._lensMat);
      /* The vertex shader never builds a modelViewMatrix, so three's frustum test would
       * be culling against a box that has nothing to do with where this draws. */
      this._postMesh.frustumCulled = false;
      this._postScene.add(this._postMesh);
    }

    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.round(this.viewW * dpr));
    const h = Math.max(1, Math.round(this.viewH * dpr));
    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    /* ⚠ `antialias: true` on the WebGLRenderer buys multisampling for the DEFAULT
     * framebuffer and nothing else, so the moment the world renders into a plain target
     * every edge in the level goes jagged — and the shipped settings have the lens on, so
     * that would be the picture everybody sees. A multisample target keeps the edges;
     * WebGL1 has no such thing, so there the fallback is honest aliasing rather than a
     * broken context. The accumulator needs none of this: it only ever samples an
     * already-resolved texture. */
    const make = (depth) => (depth && this.renderer.capabilities.isWebGL2
      ? new THREE.WebGLMultisampleRenderTarget(w, h, { ...opts, depthBuffer: true })
      : new THREE.WebGLRenderTarget(w, h, { ...opts, depthBuffer: depth }));
    if (!this._rtScene) this._rtScene = make(true);
    else if (this._rtScene.width !== w || this._rtScene.height !== h) this._rtScene.setSize(w, h);

    /* The accumulator exists only while motion blur does. Freeing it is what makes 0 an
     * absence rather than a multiplication by zero — and it is half a screen of VRAM. */
    if (this.cam.motionBlur > 0) {
      /* ⚠ A new target is zeroed, and an accumulator that starts black FADES UP FROM
       * BLACK — so moving the slider off zero blinked the whole screen out for a third of
       * a second, which reads as a crash rather than as an effect. The first frame after
       * an allocation or a resize is written at full opacity instead. */
      if (!this._rtAccum) { this._rtAccum = make(false); this._accumFresh = true; }
      else if (this._rtAccum.width !== w || this._rtAccum.height !== h) {
        this._rtAccum.setSize(w, h); this._accumFresh = true;
      }
    } else if (this._rtAccum) {
      this._rtAccum.dispose(); this._rtAccum = null;
    }
    return this._rtScene;
  }

  /**
   * Resolve the offscreen frame to the canvas through the lens.
   *
   * MOTION BLUR IS AN APPROXIMATION AND THIS IS THE HONEST NAME FOR IT: it is an
   * accumulation buffer, not a velocity buffer. Each frame is laid over the running
   * composite, so the image smears where it changed and is untouched where it did not —
   * which is a real motion smear for camera turns and moving bodies, but it TRAILS the
   * motion instead of straddling it, and a genuinely per-pixel blur needs a velocity
   * target and a gather pass this build has no composer for.
   *
   * ⚠ The retention is raised to the power of the frame's share of 1/60s. A fixed
   * per-frame retention is a smear that lasts twice as long at 30fps as at 120, so the
   * effect a player tuned on one machine is a different effect on another.
   *
   * ⚠ Grain is applied AFTER the accumulation, never into it. Grain that feeds the
   * accumulator stops being grain and becomes streaks.
   */
  _renderPost(src, dtMs, t) {
    const R = this.renderer;
    if (this._rtAccum) {
      const dt = Math.max(POST.dtClampMs[0], Math.min(POST.dtClampMs[1], dtMs));
      const retain = this._accumFresh ? 0 : Math.pow(this.cam.motionBlur * POST.blurRetain, dt / (1000 / 60));
      this._accumFresh = false;
      this._accumMat.uniforms.tSrc.value = src.texture;
      this._accumMat.uniforms.uMix.value = 1 - retain;
      this._postMesh.material = this._accumMat;
      R.setRenderTarget(this._rtAccum);
      R.render(this._postScene, this._postCamera());
      src = this._rtAccum;
    }

    this._lensMat.uniforms.tSrc.value = src.texture;
    this._lensMat.uniforms.uGrain.value = this.cam.filmGrain;
    this._lensMat.uniforms.uDistort.value = this.cam.distortion;
    this._lensMat.uniforms.uAspect.value = this.viewH > 0 ? this.viewW / this.viewH : 1;
    /* ⚠ Wrapped to ten seconds. A half-hour mission reaches 1800.0 and float32 stops
     * resolving the fractional part, at which point the grain freezes into a fixed dirt
     * pattern — which looks like a bug in the texture, not like a precision limit. */
    this._lensMat.uniforms.uTime.value = (t % 10000) / 1000;
    this._postMesh.material = this._lensMat;
    R.setRenderTarget(null);
    R.setViewport(0, 0, this.viewW, this.viewH);
    R.render(this._postScene, this._postCamera());
  }

  _postCamera() {
    if (!this._postCam) this._postCam = new this.THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    return this._postCam;
  }

  render() {
    const g = this.game, THREE = this.THREE, p = g.viewPlayer;
    const t = g.clock.simTimeMs;
    /* Sim milliseconds since the last frame, clamped at zero because a restart rewinds
     * the clock. Zero while paused, which is what freezes bob and grain behind a menu. */
    const dtMs = this._lastT == null ? 0 : Math.max(0, t - this._lastT);
    this._lastT = t;

    /* Camera. Stress adds a small breath sway — GDD §9.4 allows breathing and steadiness
     * and nothing more, so it is sub-degree and never moves the crosshair off a target.
     *
     * The breath rides the SHAKE slider rather than a slider of its own. It is not what
     * §19.1 means by camera shake, but somebody who zeroes shake is asking the view to
     * hold still, and answering that with "still, except for the breathing" is the kind
     * of nearly-off this file refuses to ship. shake 0 therefore leaves rotation.x
     * bit-equal to p.pitch and position.y bit-equal to eyeHeight(). */
    const shakeK = this.cam.shake;
    let swayY = 0, swayPitch = 0, jYaw = 0, jRoll = 0;
    if (shakeK > 0) {
      const sway = p.stressNorm * 0.012;
      swayY = Math.sin(t / 620) * sway * shakeK;
      swayPitch = Math.sin(t / 830) * sway * 0.6 * shakeK;
      const j = this._jolted(t);
      /* A downed operative is on a concrete floor with a leg that stopped answering. The
       * tremor is the one piece of camera motion in this game that carries information,
       * and it is still opt-out because §19.2 will not have a required signal that only
       * exists as movement — the HUD and the captions say it too. */
      const tremor = (p.downed && p.alive) ? SHAKE.tremor : 0;
      jYaw = j.yaw * shakeK;
      swayPitch += (j.pitch + Math.sin(t / 430) * tremor) * shakeK;
      jRoll = (j.roll + Math.sin(t / 570) * tremor * 0.8) * shakeK;
    }

    /* Head bob. Amplitude is proportional to speed, so standing still is exactly zero
     * offset rather than a slow idle sway, and a crouch-walk bobs half as much as a walk
     * without anything having to know what crouching is. */
    let bobY = 0, bobRoll = 0;
    const bobK = this.cam.headBob;
    if (bobK > 0) {
      const speed = Math.hypot(p.vx, p.vz);
      if (speed > 0) {
        this._bobPhase = (this._bobPhase + (speed * dtMs / 1000) * (Math.PI / BOB.stepM)) % TAU;
        const k = Math.min(BOB.maxSpeedK, speed / CONFIG.player.walkSpeed) * bobK;
        bobY = Math.sin(this._bobPhase * 2) * BOB.riseM * k;
        bobRoll = Math.sin(this._bobPhase) * BOB.rollRad * k;
      }
    }

    this.camera.position.set(p.x, p.eyeHeight() + swayY + bobY, p.z);
    this.camera.rotation.y = p.yaw + jYaw;
    this.camera.rotation.x = p.pitch + swayPitch;
    this.camera.rotation.z = jRoll + bobRoll;
    this.thermalCam.position.copy(this.camera.position);
    this.thermalCam.rotation.copy(this.camera.rotation);

    this.lamp.position.copy(this.camera.position);
    const fx = -Math.sin(p.yaw) * Math.cos(p.pitch);
    const fy = Math.sin(p.pitch);
    const fz = -Math.cos(p.yaw) * Math.cos(p.pitch);
    this.lampTarget.position.set(p.x + fx * 6, p.eyeHeight() + fy * 6, p.z + fz * 6);

    this._syncDeployables(t);
    this._syncInstances();
    this._syncLights();
    this._syncIce();
    this._syncMates();

    const a = g.anomaly;
    const form = this._form;
    /* `none` is a form: the tally's eleven discs ARE the anomaly, and a body at their
     * centroid would be a thing the player can walk up to that does not exist. */
    const show = a.isLoose && !!form.spec;
    this.anomalyMesh.visible = show;
    this.anomalyHalo.visible = show && !!form.spec.halo;
    if (show) {
      const pulse = 1 + Math.sin(t / 340) * 0.05 + (a.stateKind === 'hunting' ? 0.12 : 0);
      this.anomalyMesh.position.set(a.x, form.spec.y, a.z);
      this.anomalyMesh.scale.setScalar(pulse);
      this.anomalyHalo.position.copy(this.anomalyMesh.position);
      this.anomalyHalo.scale.setScalar(pulse);
    }

    this.thermalFloor.update(g.heat, t);

    /* Both world passes go into the offscreen target when the lens is on, and to the
     * canvas when it is not.
     *
     * ⚠ Bind the target BEFORE the viewport and scissor calls, not after. `setRenderTarget`
     * overwrites the GL viewport and scissor with the target's own (in target pixels);
     * `setViewport`/`setScissor` then reapply ours multiplied by the pixel ratio. Called
     * the other way round the imager's scissor box is silently replaced by the full frame
     * and the thermal pass paints over the entire screen. */
    const rt = this._postTarget();
    this.renderer.setRenderTarget(rt);

    /* Pass 1: the eye. */
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.viewW, this.viewH);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    /* The lens resolves the ROOM to the canvas here, before the imager is drawn on it. */
    if (rt) this._renderPost(rt, dtMs, t);

    /* Pass 2: the imager, if it is switched on and in hand. Structure swaps to unlit cold
     * silhouettes for the duration, so what the operator reads is the heat and only the heat.
     *
     * The clear that empties this rectangle is the one `render()` performs because the
     * scene has a Color background — and gl.clear obeys the scissor box, so it wipes the
     * imager screen and nothing else. That is why the background is swapped rather than
     * nulled: with `autoClear = false` and no background there is no clear at all, and
     * the thermal image renders on top of whatever the eye drew a moment ago.
     *
     * ⚠ THE INSTRUMENT IS DRAWN AFTER THE LENS, AND ON PURPOSE. It went through the post
     * chain first, and two things were wrong with that. The visible one: the bezel around
     * the screen is drawn by the HUD in the DOM and does not warp, so at distortion 1 the
     * thermal image sat 1.6px proud of its own frame at 1600x900 — measured, not guessed.
     * The one that matters more: this is the channel the anomaly's rule arrives on
     * (thermalFloor.js — "the one piece of UI in the game that is allowed to be
     * authoritative"), and the GDD's own risk register says to limit nondiegetic
     * distortion for exactly this reason. Grain and warp belong on the room; a
     * hand-carried instrument screen keeps its pixels. It also happens to be what a real
     * blur would do — the room smears when you whip your head round, and the screen you
     * are holding does not, because it turns with you. */
    if (g.imagerOn) {
      const r = this.imagerRect();
      this.renderer.setScissorTest(true);
      this.renderer.setScissor(r.x, r.y, r.w, r.h);
      this.renderer.setViewport(r.x, r.y, r.w, r.h);
      const fog = this.scene.fog;
      const bg = this.scene.background;
      /* The imager does not see through fog: it measures. Restoring all three afterwards
       * matters — a frame left with fog null renders the room at twice its real size, and
       * a frame left with the thermal materials on turns the whole level into flat blocks. */
      this.scene.fog = null;
      this.scene.background = this._thermalBg;
      this._setThermalMaterials(true);
      this.renderer.render(this.scene, this.thermalCam);
      this._setThermalMaterials(false);
      this.scene.fog = fog;
      this.scene.background = bg;
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, this.viewW, this.viewH);
    }
  }
}
