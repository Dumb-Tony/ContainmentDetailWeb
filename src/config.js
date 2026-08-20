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
    /* A second pair of hands on the case. It does not gate the carry — solo must stay
     * possible — it just costs you a third of your pace to do it alone (GDD §11.2). */
    assistedCarryFactor: 0.95,
    assistReachM: 2.2,
    dragSpeedFactor: 0.5,
    /* GDD §9.5: down is not dead. Ninety seconds is long enough to be a decision and
     * short enough to be a crisis. Being dragged or stabilised slows the clock to a
     * quarter rather than stopping it — help has to keep arriving. */
    bleedOutMs: 90000,
    reachMetres: 2.2,
    lookSensitivity: 0.0022,
    pitchLimit: 1.45,
    /* Body heat. Peak is at the operative's own position and it falls off fast — a lone
     * human is a lure, never a fence. Asserted directly in the suite. */
    bodyHeatC: 37,
    bodyHeatFalloffM: 1.15,
    /* Footfall level at 1m, read from SPEED and not from the key being held — a sprint
     * key against a wall is silent. The squad emits on BOTH fields and neither is
     * optional, which is what makes being quiet a playable state rather than a setting.
     * Measured carry in the unpowered cold store: 1.0m still, 3.4m crouched, 15.8m
     * walking, and sprinting is heard across the whole map. */
    stillNoiseDb: 34,
    crouchNoiseDb: 42,
    walkNoiseDb: 55,
    sprintNoiseDb: 68,
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

  /* The second field (GDD §26.2, "auditory lure and restraint"). See src/sim/sound.js —
   * the design argument for why this is not heat with different numbers lives there. */
  sound: {
    /* Six days unpowered: no plant, no fans. NOT a backdrop — audibility is measured
     * against this, so it is the number that decides how far a footstep carries. */
    ambientDb: 28,
    /* d0 for spreading. At 1m the softened inverse-square IS the free-field law
     * (measured 0.04 dB out at 10m), while staying finite at the source. */
    referenceDistanceM: 1.0,
    /* How far above everything else a source must be to be picked out of it. There is
     * deliberately no absolute hearing floor: ambientDb is always in the sum, so the room
     * tone IS the floor and there is only one mechanism. */
    audibilityMarginDb: 3,
    /* Transmission loss. ⚠ THE THIRD RELATIONSHIP TO WALLS: sound is attenuated by mass
     * rather than stopped by it, so site.js's two lists become three prices — and the
     * third disagreement between them is the interesting one. */
    massiveLossDb: 32,          // closed cold-store door, structural panel
    panelLossDb: 12,            // a deployed portable barrier: absolute to the draught, 12dB here
    rackLossDb: 5,              // steel shelving: stops a person, stops sight, barely slows sound
    /* What a diffraction bend costs. Below this, going through beats going round. */
    cornerLossDb: 9,
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
    batteryDrainRadiusM: 5,
    batteryDrainMultiplier: 4,
    /* ⚠ `contactRadiusM`, `contactCooldownMs` and `reacquireGraceMs` used to live here and
     * were read by nothing. They came over from the Unity build, where contact WAS an
     * engine rule; here every one of them is content — a capability names its own
     * `rangeMetres` and `cooldownMs`, and the anomaly re-tests its fence every step rather
     * than running a grace timer. Three constants sitting in the config quietly describing
     * a game that is not this one, and any of them could have been "tuned" for an
     * afternoon with no effect whatsoever. Section K now fails the build on an unread
     * CONFIG leaf, which is the only reason this cannot happen again. */
    /* How long the case must hold before custody is verified (content: 30s). */
    custodyVerifySeconds: 30,
    /* How long a wall-follower may make no headway before it tries the other way round.
     * Long enough that it is not indecisive, short enough that a squad does not stand
     * about waiting for a lure that is already working. */
    reroundMs: 6000,
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
    /* ⚠ The five `*Minutes` constants that used to live here were a SECOND set of battery
     * lives, read by nothing, next to the real ones in content/equipment/items.json. Not
     * merely dead — divergent: items.json ships eight batteries including a 16, a 12 and a
     * 22 that this block had never heard of, so anyone who found these first would have
     * been reading a runtime the game does not have. Batteries are minutes of runtime at
     * nominal draw and the item that owns the battery states them. */
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
    /* ⚠ `lightReliefRadiusM: 4.5` was here, unread, while game.js used a hard-coded 6.5 for
     * the same glow. It is items.json's `lightRadiusMetres` now — a lamp's reach belongs to
     * the lamp, and one number cannot disagree with itself. */
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

  net: {
    /* GDD §20.4 wants "local movement prediction with correction smoothing". A client
     * integrates its OWN operative every step and blends toward the host's answer as
     * snapshots land; past `snapErrorM` it gives up and teleports, because at that point
     * smoothing would just be a long slow lie. */
    snapshotHz: 12,
    snapErrorM: 1.2,
    blend: 0.25,
    /* ⚠ `assumedRttMs: 120` sat here, unread, under a comment about §8.2 "fair under
     * latency". The principle is real and the constant was not doing it: every trigger in
     * the content file carries its own `latencyToleranceMs`, which is what actually keeps
     * a rule from being decided on an exact frame. A transport-wide RTT budget would have
     * been a second, coarser answer to a question the content already answers per rule. */
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
