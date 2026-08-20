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
 */

import { CONFIG } from '../config.js';
import { ANOMALY_STATE } from '../sim/anomaly.js';

/**
 * Pure. Returns target values for the continuous voices, in 0..1 gains and Hz.
 * @param {object} s {anomalyState, distance, imagerOn, imagerLockMs, custodyHeldMs,
 *                    stressNorm, pressureStage, activeEmitters}
 */
export function mixFor(s) {
  const near = Math.max(0, 1 - s.distance / 18);

  /* The draught itself. Gain follows proximity; pitch follows state, exactly as authored. */
  let whistle = 0, whistleHz = 0, drone = 0.12 + near * 0.2;
  switch (s.anomalyState) {
    case ANOMALY_STATE.LATENT: whistle = 0; whistleHz = 0; break;
    case ANOMALY_STATE.AWARE: whistle = 0.10 * near; whistleHz = 420; break;
    case ANOMALY_STATE.DRAWN: whistle = 0.24 * near; whistleHz = 720; break;
    case ANOMALY_STATE.BANKED: whistle = 0.13 * near; whistleHz = 300; break;
    case ANOMALY_STATE.CONTAINED: whistle = 0; whistleHz = 0; drone = 0.04; break;
    default: break;
  }
  /* Flutter is what "banked" sounds like: the note breaks up rather than dropping out,
   * so a held anomaly never sounds like a contained one. */
  const flutterHz = s.anomalyState === ANOMALY_STATE.BANKED ? 7 : 0;

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

/** One-shot cues, as a data table keyed by simulation event. A new event is a new row; an
 *  event with no row is silent rather than fatal. */
export const CUES = Object.freeze({
  CONTACT: { hz: 90, dur: 0.9, type: 'sawtooth', gain: 0.5, sweep: -40 },
  SEAL_ATTEMPT: { hz: 240, dur: 0.35, type: 'square', gain: 0.3, sweep: 120 },
  CUSTODY_VERIFIED: { hz: 520, dur: 0.7, type: 'triangle', gain: 0.32, sweep: 180 },
  CUSTODY_LOST: { hz: 300, dur: 1.1, type: 'sawtooth', gain: 0.4, sweep: -220 },
  DEPLOYED: { hz: 180, dur: 0.14, type: 'square', gain: 0.16, sweep: 0 },
  RETRIEVED: { hz: 260, dur: 0.11, type: 'square', gain: 0.13, sweep: 0 },
  CIRCUIT_CHANGED: { hz: 70, dur: 0.5, type: 'sawtooth', gain: 0.26, sweep: 30 },
  DOOR_CHANGED: { hz: 120, dur: 0.4, type: 'triangle', gain: 0.2, sweep: -30 },
  BATTERY_DEAD: { hz: 420, dur: 0.5, type: 'sine', gain: 0.24, sweep: -260 },
  EVIDENCE_LOGGED: { hz: 880, dur: 0.09, type: 'sine', gain: 0.12, sweep: 0 },
});

export class Audio {
  constructor() {
    this.ctx = null;
    this.ok = false;
    this.voices = null;
  }

  /** Browsers refuse an AudioContext before a gesture; main.js calls this on first input. */
  start() {
    if (this.ok) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { this.ctx = new AC(); } catch { return false; }
    const master = this.ctx.createGain();
    master.gain.value = CONFIG.audio.masterGain;
    master.connect(this.ctx.destination);
    this.master = master;

    const voice = (type, hz, gain) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type; o.frequency.value = hz; g.gain.value = gain;
      o.connect(g); g.connect(master); o.start();
      return { o, g };
    };
    this.voices = {
      drone: voice('sine', 58, 0),
      whistle: voice('triangle', 420, 0),
      imager: voice('sine', 620, 0),
      hum: voice('sawtooth', 110, 0),
      breath: voice('sine', 180, 0),
    };
    this.ok = true;
    return true;
  }

  /** Apply a mix. Ramps rather than steps, so nothing clicks. */
  apply(mix, tSec = 0.12) {
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

  cue(name) {
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
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + c.dur + 0.02);
    return true;
  }
}
