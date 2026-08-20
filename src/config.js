/* Every tunable the simulation reads, in one place — GDD §21.3 wants balance changes to
 * be evidence-led, and that is only possible if the numbers are findable.
 *
 * The load-bearing one is `heat.gradientThresholdC = 40`. It is not a game-feel knob: the
 * anomaly definition (content/anomalies/graybox-draught.json, trigger `heat-wall`) states
 * the rule as "a continuous heat gradient above 40C spans the anomaly's approach path".
 * Change it here and the content file is lying to the player.
 *
 * The second load-bearing one is the pair `floodlight.peakC` / `heat.falloffMetres`,
 * because together they decide the RADIUS of a floodlight's 40C contour, and that radius
 * is what makes the cold-storage map's aisles a design problem. See heat.js `contourRadius`.
 */

export const CONFIG = Object.freeze({
  sim: {
    stepMs: 1000 / 60,
    maxFrameMs: 250,
    /* Mission length before the incident is written off. GDD §2.4 wants 25-45 minutes for
     * a normal operation. Thirty is the bottom of that band, and a solo run measured at
     * ~15 minutes end to end (suite section I) — enough slack for one failed attempt and
     * a re-plan, which is the recoverable mistake Pillar 4 asks for. */
    missionLimitMs: 30 * 60 * 1000,
  },

  player: {
    eyeHeight: 1.62,
    crouchEyeHeight: 1.05,
    radius: 0.34,
    walkSpeed: 2.6,
    sprintSpeed: 4.4,
    crouchSpeed: 1.3,
    accel: 22,
    friction: 14,
    /* A hurt operative is slower. One replicated speed factor, min-combined across
     * causes, so no two systems can each claim to own the player's speed. */
    injuredSpeedFactor: 0.62,
    carrySpeedFactor: 0.75,
    reachMetres: 2.2,
    lookSensitivity: 0.0022,
    pitchLimit: 1.45,
    /* Body heat. Peak is at the operative's own position and it falls off fast — a lone
     * human is a lure, never a fence. Asserted directly in the suite. */
    bodyHeatC: 37,
    bodyHeatFalloffM: 1.15,
  },

  heat: {
    /* The plant room has been unpowered for six days (see the incident premise). */
    ambientC: 6,
    /* THE RULE. See the file header. */
    gradientThresholdC: 40,
    /* Softened inverse-square: contribution = (peak - ambient) / (1 + (d/d0)^2).
     * d0 is per-source; this is the default for anything that does not name its own. */
    falloffMetres: 2.2,
    /* How finely a path is sampled when asking "does a 40C gradient span this line".
     * Coarser than this and a tripod's contour develops gaps the player cannot see. */
    pathSampleMetres: 0.18,
    /* The anomaly is a cold mass: it subtracts heat around itself. This is what makes a
     * marginal fence fail — the thing you are fencing is actively lowering the wall. */
    anomalyChillC: 26,
    anomalyChillFalloffM: 2.6,
    /* Ambient decay while the anomaly is loose, per minute. The floor gets colder the
     * longer the team takes; it is the clock you can feel. */
    ambientDriftCPerMin: 0.55,
    ambientFloorC: -8,
  },

  fence: {
    /* An escape ray is cast this far. Anything that survives to the radius counts as a
     * way out, so a "fence" made of one tripod in open floor does not bank anything. */
    testRadiusM: 6.5,
    rayCount: 24,
  },

  anomaly: {
    /* Speeds come from the content file's states; this is the pressure multiplier band. */
    pressureSpeedGain: 0.16,      // +16% per pressure stage above Latent
    contactRadiusM: 1.2,
    contactCooldownMs: 3000,
    batteryDrainRadiusM: 5,
    batteryDrainMultiplier: 4,
    /* How long the case must hold before custody is verified (content: 30s). */
    custodyVerifySeconds: 30,
    /* Retreat pace once banked and being sealed — it does not move, but the fence is
     * re-tested every step and this is how fast it resumes if the fence drops. */
    reacquireGraceMs: 3000,
  },

  pressure: {
    /* GDD §5.4. Pressure is a director INPUT, not a rage meter; the HUD shows the stage
     * word, never the number. Stages at 0/20/45/70/90. */
    perMinute: 3.4,
    stageThresholds: [0, 20, 45, 70, 90],
    stageNames: ['Latent', 'Aware', 'Active', 'Breach', 'Critical'],
    max: 100,
    /* Withdrawal relief: being far from the anomaly with nothing running sheds pressure. */
    withdrawalPerMinute: -6,
    withdrawalDistanceM: 14,
  },

  power: {
    /* Batteries are minutes of runtime at nominal draw, not opaque percentages. */
    packMinutes: 9,
    floodlightMinutes: 5.5,
    heaterMinutes: 4,
    imagerMinutes: 14,
    sensorMinutes: 20,
    /* A power pack in range feeds emitters instead of their own cells draining. */
    packFeedRadiusM: 5.0,
  },

  stress: {
    /* GDD §9.4 — restrained. It changes breathing, steadiness and callout delay. It never
     * fabricates evidence. Rises in darkness, isolation, injury and near the anomaly. */
    max: 100,
    darknessPerMinute: 7,
    proximityPerMinute: 22,
    proximityRadiusM: 8,
    injuryPerMinute: 9,
    reliefPerMinute: -13,
    /* Suppressed inside a deployed floodlight's glow — restoring light is the first relief. */
    lightReliefRadiusM: 4.5,
  },

  render: {
    fov: 74,
    thermalFov: 50,          // the imager's narrow view is a real cost (GDD §10.2)
    near: 0.05,
    far: 90,
    /* The imager screen, as a fraction of the viewport. Deliberately small. */
    imagerRect: { w: 0.34, h: 0.34, cx: 0.5, cy: 0.62 },
    maxPixelRatio: 2,
  },

  audio: {
    masterGain: 0.5,
  },
});

export const BULK = Object.freeze({ compact: 'compact', general: 'general', long: 'long' });

/* Slot layout, GDD §9.2: two belt slots for compact items, two general slots, one long
 * slot. `hands` is separate — a two-person carry or a mission object lives there. */
export const SLOTS = Object.freeze([
  { id: 'belt1', accepts: ['compact'] },
  { id: 'belt2', accepts: ['compact'] },
  { id: 'gen1', accepts: ['compact', 'general'] },
  { id: 'gen2', accepts: ['compact', 'general'] },
  { id: 'long1', accepts: ['long'] },
]);
