# Containment Detail

## Game Design Document

**Document status:** Pre-production design bible  
**Version:** 1.0  
**Date:** August 1, 2026  
**Working title:** *Containment Detail*  
**Genre:** 1-5 player cooperative first-person investigation, survival, and containment  
**Initial platform:** Desktop web prototype  
**Target platform:** Windows PC via Steam  
**Business model:** Premium game; cosmetic and expansion options only if they preserve trust  
**Audience:** Players who enjoy cooperative deduction, systemic horror, tactical preparation, and emergent team stories

> **Design thesis:** The squad does not win by discovering a monster's name or reducing its health to zero. It wins by learning an anomaly's rules, building a viable field procedure, and performing containment while those rules actively endanger the team.

---

## Document Purpose

This document is the project's design authority. It defines the intended player experience, major systems, production constraints, and scope boundaries. It should guide prototypes, feature reviews, content pitches, art and audio decisions, and milestone acceptance.

When two features compete, favor the option that creates more:

1. **Rule-based deduction** rather than checklist matching.
2. **Cooperative dependency** rather than parallel solo play.
3. **Containment improvisation** rather than conventional damage races.
4. **Tension from incomplete information** rather than arbitrary punishment.
5. **Meaningful operational choices** rather than linear stat increases.

This is a living document. Major revisions require a version note and an explicit statement of which assumptions changed.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Product Vision](#2-product-vision)
3. [Design Pillars](#3-design-pillars)
4. [Audience, Positioning, and Experience Goals](#4-audience-positioning-and-experience-goals)
5. [Game Structure and Core Loop](#5-game-structure-and-core-loop)
6. [Mission Structure](#6-mission-structure)
7. [Investigation and Identification](#7-investigation-and-identification)
8. [Anomaly and Containment Framework](#8-anomaly-and-containment-framework)
9. [Player Systems](#9-player-systems)
10. [Equipment, Weapons, and Loadouts](#10-equipment-weapons-and-loadouts)
11. [Multiplayer and Social Design](#11-multiplayer-and-social-design)
12. [Progression and Economy](#12-progression-and-economy)
13. [Foundation Home Base](#13-foundation-home-base)
14. [Maps, Objectives, and World Systems](#14-maps-objectives-and-world-systems)
15. [Content Strategy](#15-content-strategy)
16. [Art Direction](#16-art-direction)
17. [Audio Direction](#17-audio-direction)
18. [UI and UX](#18-ui-and-ux)
19. [Accessibility](#19-accessibility)
20. [Technical Architecture: HTML Prototype](#20-technical-architecture-html-prototype)
21. [Analytics, Testing, and Balancing](#21-analytics-testing-and-balancing)
22. [Monetization and Community Philosophy](#22-monetization-and-community-philosophy)
23. [Roadmap and Milestones](#23-roadmap-and-milestones)
24. [Risks and Mitigations](#24-risks-and-mitigations)
25. [SCP Licensing and Attribution](#25-scp-licensing-and-attribution)
26. [Vertical Slice Specification](#26-vertical-slice-specification)
27. [Definition of Done](#27-definition-of-done)
28. [Appendices](#28-appendices)

---

# 1. Executive Summary

*Containment Detail* is a cooperative first-person horror game for squads of one to five players. The team deploys as a Foundation field unit to locations affected by anomalous activity. Each assignment begins with incomplete, occasionally unreliable intelligence. Players investigate the site, infer the anomaly's behavioral rules, prepare an appropriate procedure, establish custody, and extract without allowing the situation to become a public disaster.

The central challenge is not simply identification. A correct designation improves confidence and reveals known procedures, but players can still succeed through careful observation and field reasoning. Conversely, naming an anomaly without understanding the current incident is insufficient. Local conditions, secondary hazards, compromised infrastructure, civilians, and imperfect equipment force the squad to adapt.

Weapons are protective tools, not universal answers. They may interrupt a manifestation, destroy a disposable appendage, create space, or protect a technician. Most primary anomalies cannot be killed by ordinary combat. The climax of a mission is an authored but systemic containment operation: sustained observation, a coordinated lure, a temporary enclosure, an anchor separation, a collection sweep, a stabilization sequence, or another procedure derived from the entity's rules.

Between missions, players return to a persistent regional Foundation site. The base provides planning, equipment development, medical recovery, archives, character customization, and a visible containment wing. Captured anomalies unlock research opportunities, incidents, tools, and higher-clearance operations. Progression expands tactical vocabulary rather than inflating damage.

The first production goal is a browser-playable desktop prototype proving one question: **Is it consistently fun for friends to discover behavioral rules and turn them into a coordinated containment plan?** The prototype should prioritize this proof over content volume, photorealism, or Steam integration.

---

# 2. Product Vision

## 2.1 High Concept

**A cooperative paranormal field-operations game in which knowledge becomes a plan, and the plan must survive contact with the anomaly.**

## 2.2 Player Fantasy

Players are not disposable ghost hunters or conventional soldiers. They are a lightly resourced Foundation response team operating at the edge of institutional control. They are competent but vulnerable. Their advantage is procedure: instruments, communication, preparation, discipline, and an expanding archive of hard-won knowledge.

The desired emotional sequence is:

> Curiosity -> suspicion -> recognition -> dread -> preparation -> controlled chaos -> relief -> institutional consequence

## 2.3 Tone

The game combines:

- **Institutional horror:** calm forms, clipped radio language, and procedural systems confronted by the impossible.
- **Tactical tension:** limited carrying capacity, uncertain intelligence, and plans that need simultaneous execution.
- **Emergent co-op comedy:** dropped equipment, panicked callouts, mistaken identity, and improvised rescues.
- **Earned mastery:** players become better because they understand systems, not because a number made them immune.

Comedy should emerge from players and bureaucracy. The anomaly itself should remain credible and threatening.

## 2.4 Scope Statement

The target game is a replayable, session-based cooperative title with a persistent social hub. A normal mission lasts 25-45 minutes. High-complexity operations may last 45-70 minutes. The game supports solo play, but the authored center is three to five players.

## 2.5 Non-Goals

The project is not intended to be:

- A competitive extraction shooter.
- A wave-based horde shooter.
- A pure evidence checklist in which three clues automatically reveal one answer.
- A lore encyclopedia requiring prior SCP knowledge.
- A direct recreation of SCP article prose, page art, or famous community imagery.
- A live-service treadmill built around daily chores, loot rarity, or power creep.
- A seamless open world.
- A fully destructible simulation.
- A role-locked hero shooter.

---

# 3. Design Pillars

## Pillar 1: Every Anomaly Has Rules

An anomaly is a compact system of triggers, states, preferences, capabilities, and containment conditions. Its behavior must be learnable. Surprise may conceal a rule; it must not replace one.

**Design test:** After a failure, can players explain what they misunderstood and propose a different plan?

## Pillar 2: Identification Is a Means, Not the Finish Line

Evidence changes what the team believes and what it dares to attempt. Correctly identifying the source is valuable, but containment still requires execution under local conditions.

**Design test:** Can a careful team achieve provisional containment without entering an exact designation? Can a team with the correct name still fail through poor procedure?

## Pillar 3: Cooperation Creates Capability

No rigid classes are required, but weight, attention, simultaneous actions, and information asymmetry make teamwork materially stronger. A scout sees the clue; an analyst interprets it; a technician configures the device; security buys time.

**Design test:** Does a four-player team need to communicate, or can four people silently perform identical chores?

## Pillar 4: Preparation Is a Wager

The van and base cannot carry every answer. Intelligence is incomplete, equipment has opportunity cost, and deployed tools may be lost. Loadout choices express a theory about the incident.

**Design test:** Is there more than one defensible loadout, with visible tradeoffs and recoverable mistakes?

## Pillar 5: Contain, Do Not Merely Kill

Damage may alter behavior, destroy a threat component, or create a window. The final objective is custody, isolation, neutralization, or transfer according to a specific procedure.

**Design test:** Could the finale be mistaken for a conventional boss health bar? If so, redesign it.

## Pillar 6: Consequences Tell the Story

Civilian lives, secrecy, evidence, infrastructure, equipment, and personnel matter. A messy success is still a story and may change the base, future intelligence, or available resources.

**Design test:** Does the debrief explain how the operation unfolded rather than merely awarding stars?

---

# 4. Audience, Positioning, and Experience Goals

## 4.1 Target Players

### Primary

- Cooperative horror players who enjoy voice communication and uncertain threats.
- Players who like deduction, tool use, and planning more than twitch mastery.
- SCP readers who want respectful mechanical interpretations of documented anomalies.
- Friend groups seeking repeatable 30-60 minute sessions with strong stories.

### Secondary

- Solo horror players comfortable commanding limited AI assistance or using simplified procedures.
- Tactical shooter players receptive to nonlethal objectives.
- Streamers and viewers who benefit from readable threats and dramatic plans.

## 4.2 Knowledge Contract

Prior SCP knowledge must be an advantage of familiarity, not a requirement or automatic solution.

- Briefings use accessible in-world language.
- Every required rule can be learned inside the mission.
- Article readers may recognize a candidate early, but incident variations prevent rote solutions.
- The codex distinguishes confirmed facts from assumptions and local deviations.
- Spoiler-sensitive lore is revealed through clearance and mission experience.

## 4.3 Experience Goals

At the end of a successful session, players should say:

- "We figured out what it wanted."
- "The plan almost worked exactly as intended."
- "I had to trust you to keep watching it."
- "Next time we bring the other tool."
- "The debrief remembered what happened."

They should not primarily say:

- "We finally drained its health."
- "The random event killed us with no warning."
- "We ran the same evidence route again."
- "The high-level player's gun solved everything."

---

# 5. Game Structure and Core Loop

## 5.1 Macro Loop

1. **Review operations** at the Foundation site.
2. **Interpret intelligence** and select an assignment.
3. **Configure the squad** and choose equipment.
4. **Deploy and establish a field perimeter.**
5. **Investigate** the location and collect evidence.
6. **Form and revise hypotheses.**
7. **Commit to a containment procedure.**
8. **Execute under escalation.**
9. **Extract personnel, evidence, and contained material.**
10. **Debrief, recover, research, and upgrade.**

## 5.2 Minute-to-Minute Loop

> Observe -> communicate -> test -> interpret -> reposition -> manage risk

Players move through spaces, establish safe routes, place sensors, manipulate environmental systems, document findings, and respond to changes. Every tool use should answer a question, create safety, or prepare containment.

## 5.3 Information Loop

Evidence is not a set of binary collectible tokens. Each observation updates one or more dimensions:

- **Presence:** Is anomalous activity here?
- **Form:** Entity, object, infestation, phenomenon, or composite incident?
- **Trigger:** What provokes or enables it?
- **Capability:** What can it do, at what range, and under which conditions?
- **Constraint:** What limits, interrupts, repels, or redirects it?
- **Anchor:** What location, object, person, or condition sustains it?
- **Custody requirement:** What must be moved, enclosed, observed, stabilized, or separated?

## 5.4 Tension Loop

Investigation raises **Incident Pressure**. Pressure is a director input, not a visible rage meter by default. It rises through time, disturbance, failed tests, casualties, power use, noisy weapons, and anomaly-specific triggers. It falls through withdrawal, correct countermeasures, restoration of stable conditions, or entering controlled procedure phases.

Pressure changes behavior in legible stages:

1. **Latent:** traces and distant manifestations.
2. **Aware:** reacts to player presence and tests perimeter weaknesses.
3. **Active:** hunts, relocates, disrupts tools, or attacks objectives.
4. **Breach:** expands beyond the initial incident boundary or compromises extraction.
5. **Critical:** produces a mission-ending public, spatial, biological, or casualty cascade.

The director must obey anomaly rules. It can choose timing and opportunity; it cannot invent untelegraphed powers.

---

# 6. Mission Structure

## 6.1 Mission Phases

### Phase A: Briefing

The operation card includes:

- Location and jurisdiction.
- Incident category and broad hazard tags.
- Witness reports with confidence labels.
- Known casualties, disappearances, or contamination.
- Weather, time, access, and infrastructure status.
- Primary mandate and optional directives.
- Permitted cover story and secrecy tolerance.
- Known exclusions, if prior teams tested something.

Reports may be incomplete or mistaken, but the game must not deliberately lie without a traceable reason such as an unreliable witness, corrupted instrument, or mimicry.

### Phase B: Loadout and Role Declaration

Players choose personal kit, shared cargo, entry point, and a proposed first action. Informal role labels help matchmaking and communication but never block equipment:

- Command
- Reconnaissance
- Research
- Containment
- Security
- Medical

### Phase C: Arrival and Perimeter

The squad locates extraction, checks communications, unloads limited cargo, and establishes a safe reference point. Early scouting is relatively safe but consumes the best low-pressure window.

### Phase D: Investigation

Players locate zones of activity, recover records, interview or triage NPCs, run controlled tests, restore utilities, and narrow hypotheses. The team can retreat to the mobile command unit to analyze data and change carried equipment.

### Phase E: Procedure Design

The field board converts discoveries into a plan:

- Target or anchor.
- Required state.
- Required devices and consumables.
- Trigger or lure.
- Team positions.
- Abort condition.
- Extraction route.

The system may recommend procedures supported by confirmed findings, but it never selects the correct answer automatically.

### Phase F: Containment Operation

The team stages equipment, initiates the trigger, maintains required conditions, and secures custody. This phase creates simultaneous responsibilities and clear recovery opportunities. A mistake should complicate the operation before it instantly ends it, unless the warning was explicit and the act knowingly catastrophic.

### Phase G: Extraction

Custody is not complete until the payload and surviving personnel reach transfer. The anomaly may still influence the route; secondary manifestations, damaged infrastructure, or civilians can create a final decision.

### Phase H: Debrief

The report grades outcomes, identifies pivotal events, records discoveries, applies injuries and losses, and updates the site.

## 6.2 Mission Objectives

Every mission has one primary objective and up to three optional directives.

**Primary objectives**

- Secure and transport an entity.
- Isolate a phenomenon and hand off the zone.
- Recover all dangerous instances of an object.
- Separate an anomaly from its anchor.
- Stabilize a breach until a specialist unit arrives.
- Rescue or verify missing personnel before containment.

**Optional directives**

- No civilian deaths.
- Recover a prior team's body camera or black box.
- Preserve an anomalous sample.
- Avoid lethal force.
- Maintain secrecy below a specified exposure threshold.
- Recover all issued experimental equipment.
- Complete a departmental research request.

## 6.3 Difficulty Model

Difficulty should alter operational complexity, not simply multiply health and damage.

| Variable | Lower difficulty | Higher difficulty |
|---|---|---|
| Intelligence | More reliable reports | Conflicting or missing reports |
| Infrastructure | Mostly operational | Failed power, blocked routes, damaged comms |
| Anomaly variance | Baseline behaviors | Additional documented behavior set or local complication |
| Civilians | Few or evacuated | Dispersed, panicked, compromised, or imitated |
| Supplies | Generous cargo | Strict weight, battery, or replacement limits |
| Procedure | Fewer simultaneous roles | Longer chains and tighter coordination |
| Failure recovery | Wider windows | Costlier errors, fewer safe zones |
| Secondary hazards | Minimal | Weather, fire, contamination, hostile fauna, or responders |

Recommended presets: **Orientation, Field, Severe, and Keter Protocol**. Custom contracts expose individual modifiers after players complete onboarding.

## 6.4 Mission Grading

The debrief uses dimensions, not a single opaque rank:

- Containment integrity
- Personnel survival
- Civilian outcome
- Evidence quality
- Secrecy and exposure
- Equipment stewardship
- Infrastructure damage
- Research completion
- Time to stabilization

The overall assessment uses Foundation language: **Exemplary, Controlled, Costly, Compromised, or Failed**. A Costly success remains progress but generates consequences.

---

# 7. Investigation and Identification

## 7.1 Evidence Types

### Environmental

Temperature gradients, radiation, electromagnetic distortion, corrosion, structural change, impossible acoustics, altered shadows, and spatial measurements.

### Biological

Tissue, residue, spores, tracks, blood chemistry, discarded skin, bite patterns, and changes in local wildlife.

### Behavioral

Movement timing, response to observation, sound, light, aggression, materials, symbols, objects, or human attention.

### Testimonial

Calls, interviews, journals, dispatch logs, social media captures, and prior responder reports. Testimony carries source and reliability metadata.

### Instrumental

Camera recordings, motion graphs, spectrum captures, audio, telemetry, and reality-stability logs. Some anomalies interfere with recording in consistent ways.

### Documentary

Site plans, purchase orders, medical histories, personnel rosters, local folklore, and Foundation archive fragments.

## 7.2 Observation Model

An evidence entry contains:

- Raw observation.
- Time and location.
- Recording player or device.
- Integrity and contamination status.
- Automatic tags.
- Player annotation.
- Linked hypotheses.

The game records raw facts before interpreting them. For example, "motion sensor activated while the camera view was obstructed" is stronger design than "evidence: moves while unseen."

## 7.3 Hypothesis Board

The field board supports:

- Candidate anomalies or archetypes.
- Confirmed, probable, disputed, and excluded traits.
- Team pins and short annotations.
- Side-by-side comparison of candidate rules.
- Proposed tests with risk labels.
- Procedure requirements derived from current beliefs.

The board never requires exact keyword entry. Players select structured claims and may add optional free-text notes.

## 7.4 Confidence, Not Checklist Completion

Each candidate has an internal likelihood based on evidence, but exact percentages remain hidden by default. The UI communicates qualitative confidence. Contradictory evidence remains visible rather than disappearing.

Correct classification produces benefits:

- Better procedure recommendations.
- Safer tool calibration.
- Higher research and grading rewards.
- More accurate specialist support.

Incorrect classification produces systemic consequences:

- A lure may provoke rather than attract.
- A barrier may fail under load.
- The wrong enclosure may become an amplifier.
- A sedative may have no effect or shorten the safe window.

## 7.5 Controlled Testing

Good investigations are designed experiments. A test should specify:

1. A claim.
2. A controlled input.
3. A measurable outcome.
4. A safe observation position.
5. An abort plan.

The interface can suggest experiment templates without revealing results. Repeating an identical low-value test yields diminishing information and increases pressure.

---

# 8. Anomaly and Containment Framework

## 8.1 Anomaly Design Schema

Every implemented anomaly receives a machine-readable and human-readable design sheet:

| Field | Purpose |
|---|---|
| Identity | SCP designation, title, author, canonical source, revision captured |
| Incident premise | Why this anomaly is here and why custody has failed |
| Perception rules | How players can perceive or record it |
| State model | Latent, active, hunting, vulnerable, contained, and special states |
| Triggers | Inputs that cause state transitions |
| Capabilities | Actions available in each state |
| Constraints | Conditions that block, weaken, redirect, or reveal it |
| Evidence channels | Discoverable observations and their reliability |
| False leads | Plausible contradictions grounded in the incident |
| Containment goal | Exact custody state the squad must create |
| Procedure variants | Minimum, safe, and research-grade methods |
| Recovery windows | How players can respond after mistakes |
| Scaling rules | Solo and squad adaptations; difficulty modifiers |
| Presentation | Model, animation, VFX, audio, UI interference |
| Licensing record | Attribution, derivative scope, approved assets, counsel notes |

## 8.2 Rule Quality Standard

An anomaly rule must be:

- **Observable:** It creates detectable evidence.
- **Consistent:** The same conditions produce compatible outcomes.
- **Actionable:** Understanding it changes player decisions.
- **Communicable:** A player can explain it quickly to teammates.
- **Composable:** It interacts with map and equipment systems.
- **Fair under latency:** Network delay does not decide an exact-frame failure.

## 8.3 Containment Grammar

Containment procedures are built from reusable verbs:

- **Detect:** locate the true target or anchor.
- **Observe:** maintain perception through people or devices.
- **Isolate:** remove civilians, stimuli, linked objects, or manifestations.
- **Lure:** induce movement with sound, material, prey, symbol, or environmental state.
- **Suppress:** temporarily reduce a capability.
- **Stabilize:** hold power, light, geometry, temperature, or reality within a band.
- **Restrain:** apply physical, chemical, electronic, or anomalous control.
- **Enclose:** establish a boundary with specific material and integrity.
- **Sequence:** activate devices or perform actions in order.
- **Transfer:** move custody into transport or a specialist handoff zone.
- **Verify:** prove that the captured target is complete and authentic.

A good procedure combines three to six verbs and assigns at least two concurrent responsibilities in a normal squad.

## 8.4 Containment Integrity

Containment is a state, not a cutscene. Its integrity depends on relevant conditions: observation coverage, barrier continuity, sedation, power, temperature, anchor distance, instance count, or another anomaly-specific measure.

The team receives diegetic indications of failure: seal strain, telemetry drift, camera blind spots, rising temperature, altered radio traffic, or movement inside the unit. Generic progress bars are reserved for information a field operator could reasonably measure.

## 8.5 Failure and Recovery

Failure escalates through three bands:

1. **Procedure fault:** a condition slips; players can correct it.
2. **Containment break:** the anomaly re-enters an active state; equipment or position is lost.
3. **Incident breach:** the primary target escapes the operational boundary or causes an irreversible cascade.

Downed players, lost tools, and incorrect hypotheses should create rescue decisions. Instant team wipes are used only for clearly telegraphed, lore-appropriate catastrophic rules.

## 8.6 Candidate SCP Portfolio

Actual selections require a design and licensing audit. Candidate types should span different verbs and sensory channels rather than selecting only iconic humanoid predators.

| Mechanical niche | Candidate direction | Design value | Key caution |
|---|---|---|---|
| Observation dependency | An SCP whose movement or threat depends on perception | Forces relays, cameras, and trust | Latency, accessibility, and former article imagery must be handled carefully |
| Auditory predator | An entity that hunts or imitates voices | Voice discipline and decoys | Avoid punishing players who cannot use voice chat |
| Invisible/filtered threat | An entity perceptible only through equipment or altered vision | Tool interdependence | Must remain readable and not induce eyestrain |
| Distributed anomalous object | Multiple instances hidden among ordinary items | Search, cataloguing, and verification | Avoid repetitive pixel hunting |
| Spatial anomaly | A location with nonstandard topology | Mapping and anchor stabilization | Network prediction and motion sickness |
| Contagious effect | A condition spreading through contact or attention | Triage, isolation, and trust | Avoid griefing and inaccessible cognitive tricks |

The content team should not commit an SCP to production solely because it is famous. It must support fair, replayable, cooperative containment.

---

# 9. Player Systems

## 9.1 Movement and Interaction

Baseline actions:

- Walk, sprint, crouch, lean, mantle low obstacles, and climb marked ladders.
- Carry one ready tool and a limited personal inventory.
- Use context-sensitive primary and secondary tool actions.
- Drag or assist downed characters.
- Place, rotate, connect, and retrieve field equipment.
- Mark locations and objects through a limited ping system.

Movement is deliberate rather than acrobatic. No slide-canceling, repeated bunny hopping, or combat rolls. Sprinting is noisy and reduces instrument stability.

## 9.2 Inventory and Encumbrance

Players have:

- Two belt slots for compact items.
- Two general slots.
- One long-tool or weapon slot.
- One worn equipment slot.
- Hands for a mission object or two-person carry.

Bulky items affect movement and require free hands. Extremely heavy containment components require two players or a trolley. Inventory pressure should create coordination, not constant menu management.

## 9.3 Health and Conditions

There is no regenerating combat health. Player state includes:

- Physical trauma
- Bleeding
- Mobility injury
- Exposure/contamination
- Cognitive stress
- Anomaly-specific conditions

Treatment stabilizes rather than erases injury. Severe harm can create persistent recovery needs at the base, but permanent character deletion is not a default feature.

## 9.4 Stress

Stress is a restrained feedback system, not a morality or sanity meter. It responds to isolation, injury, direct exposure, darkness, and anomalous effects. High stress may cause breathing noise, reduced fine motor steadiness, delayed verbal callouts, or ambiguous peripheral presentation. It must never fabricate mission-critical evidence without a clear indicator.

Players reduce stress through regrouping, light, medical support, safe zones, and anomaly-specific countermeasures.

## 9.5 Downed, Missing, and Dead States

- A downed player can communicate weakly unless an effect prevents it.
- Teammates can stabilize, drag, or extract them.
- Some anomalies can relocate, imitate, or otherwise compromise isolated players.
- Dead players may use limited spectator views that do not reveal hidden information.
- Optional accessibility/custom rules can allow a recovered player to operate a support drone from the command vehicle.

## 9.6 Character Customization

Customization includes face, body presentation, voice set, uniform layers, patches, gloves, headgear, and noncombat base clothing. Options are not gender-locked. Silhouettes remain readable and cosmetics do not mimic anomaly tells, staff clearance indicators, injury states, or active equipment.

---

# 10. Equipment, Weapons, and Loadouts

## 10.1 Equipment Philosophy

Each item should do at least one of the following:

- Ask a meaningful question.
- Make a dangerous observation safer.
- Create or maintain a containment condition.
- Restore a failed system.
- Protect a teammate during a procedure.

Upgrades generally improve portability, reliability, duration, configurability, or data quality. They do not make older tools irrelevant.

## 10.2 Detection Equipment

| Tool | Primary function | Tradeoff |
|---|---|---|
| Thermal imager | Reveals heat patterns and tracks | Narrow view; vulnerable to environmental noise |
| EM field meter | Measures localized electromagnetic disruption | Electronics and damaged wiring create false context |
| Motion sensor | Monitors a lane or room | Reports motion, not identity |
| Directional microphone | Locates distant or masked sound | Operator has reduced situational awareness |
| Audio recorder | Captures and replays anomalous speech or frequency | Playback may itself be a trigger |
| Chemical sampler | Identifies residue families | Requires collection time and consumable cartridges |
| Dosimeter | Tracks ionizing or anomalous radiation | Persistent alarm may attract attention |
| Reality stability meter | Measures local spatial/causal instability | Expensive, bulky, and difficult to interpret |
| Remote camera | Extends observation and records events | Requires placement, power, and line of sight |
| UV/alternate-spectrum lamp | Reveals traces outside visible light | Consumes power and occupies a hand |
| Sample kit | Preserves biological or material evidence | Limited sterile containers |
| Survey scanner | Compares room geometry and distance | Slow and susceptible to movement errors |

## 10.3 Containment Equipment

| Tool | Use |
|---|---|
| Portable barrier panels | Build temporary material-specific boundaries |
| Field anchor/stabilizer | Reduces spatial or reality variance in a limited radius |
| Restraint launcher | Applies cables, nets, or specialized restraints at range |
| Sedative projector | Delivers configurable chemical payloads |
| Automated observation unit | Maintains camera coverage with blind-spot warnings |
| Signal/sound lure | Plays timed, directional, or recorded stimuli |
| Floodlight tripod | Creates persistent illumination and observation support |
| Isolation tent | Controls contact, airflow, and sample transfer |
| Reinforced transit case | Holds anomalous objects with sensor ports |
| Mobile containment unit | Mission-scale transport with configurable modules |
| Tether and winch | Moves resistant payloads or holds a boundary |
| Sealant and repair kit | Restores enclosure integrity and infrastructure |

## 10.4 Defensive Weapons

Weapons create time and space. Their effectiveness is documented per threat component.

- Sidearm
- Pump shotgun
- Compact rifle
- Taser
- Tranquilizer platform
- Flare launcher
- Fire suppressant/cryogenic projector
- Less-lethal launcher

Ordinary ammunition may stop hostile civilians, animals, or mortal secondary organisms. Against primary anomalies, it may stagger, redirect, shed material, or do nothing. Firing increases noise, exposure, property damage, and Incident Pressure.

## 10.5 Support and Medical Equipment

- Trauma kit
- Contamination kit
- Portable oxygen
- Stimulant with recovery cost
- Body camera
- Radio repeater
- Power pack and cable spool
- Lock bypass kit
- Compact drone
- Evidence case
- Civilian restraint and evacuation kit

## 10.6 Tool Quality and Reliability

Tools have legible failure modes:

- Battery drain
- Calibration drift
- Physical damage
- Signal loss
- Contamination
- Anomaly-specific interference

Maintenance improves reliability. Random tool failure must be rare and telegraphed; anomalies may disrupt tools according to consistent rules.

## 10.7 Loadout Budget

The squad balances:

- Personal capacity
- Vehicle cargo volume
- Requisition cost
- Experimental-item limit
- Power demand
- Consumable supply

The base allows saved kits, shared manifests, and visible coverage warnings such as "no remote observation" or "limited medical capacity." Warnings describe gaps without prescribing the solution.

---

# 11. Multiplayer and Social Design

## 11.1 Player Count

Supported: 1-5.  
Primary balance target: 3-5.  
Prototype target: 1-4 until network and procedure complexity are proven.

## 11.2 Cooperative Dependency

Teamwork is created through:

- Split information between field operators and command displays.
- Simultaneous control points.
- Limited hands and carrying capacity.
- Observation relays and blind-spot management.
- Two-person medical or cargo actions.
- Tool combinations.
- Time-sensitive call-and-response sequences.

No player should be assigned to stare at an unchanging screen for long periods. Monitoring roles receive interpretable signals, remote switching, annotation, and alerts.

## 11.3 Communication

- Proximity voice for immersion.
- Radio voice across distance.
- Radio channels for field and command use.
- Optional voice effects only when intelligibility is preserved.
- Contextual ping wheel with danger, evidence, objective, move, watch, and help.
- Text chat and speech-to-text options.
- Quick phrase wheel with customizable entries.

The game never requires microphone input as an anomaly trigger unless a non-voice alternative produces the same gameplay function.

## 11.4 Matchmaking

Players can create:

- Friends-only lobbies.
- Invite-code lobbies.
- Public lobbies with language, difficulty, mission-length, and play-style tags.
- Quickplay queues.

Host migration is desirable for peer-hosted prototype sessions. The production goal is server-authoritative sessions with graceful reconnect and a reserved player slot.

## 11.5 Join, Leave, and Reconnect

- Joining in progress is allowed before the containment commitment phase.
- Late players arrive through the command vehicle or a plausible reinforcement point.
- Disconnected characters enter safe autopilot if possible, drop critical carried objects only when necessary, and reserve their slot.
- Reconnect restores character state and inventory.
- Intentional departure transfers unique mission items to a recoverable field crate.

## 11.6 Solo Adaptation

Solo mode uses procedure adjustments rather than full combat companions:

- Longer timing windows.
- Remote switches and automated observation units.
- Lighter two-person equipment variants.
- A command assistant that relays recorded facts without solving hypotheses.
- Optional support drone for carrying and monitoring.

The solo player still performs the complete reasoning loop.

## 11.7 Anti-Griefing

- Friendly fire options and reflected penalties in public matchmaking.
- Vote-to-remove with abuse protection.
- Ownership-free mission-critical tools.
- Recovery of deliberately discarded unique items.
- Audit log for destructive actions during containment.
- Host cannot erase earned mission progression after completion.
- Block, mute, report, and recent-player tools.

---

# 12. Progression and Economy

## 12.1 Progression Philosophy

Progression grants options, context, and efficiency. It does not invalidate early missions or turn horror into immunity.

Three connected tracks:

1. **Site clearance:** unlocks missions, rooms, and institutional authority.
2. **Department standing:** unlocks specialized equipment and contract opportunities.
3. **Research knowledge:** unlocks anomaly-specific insights, procedures, and prototypes.

## 12.2 Resources

- **Requisition:** routine equipment, consumables, repairs, and facility improvements.
- **Research data:** verified evidence and samples used for analytical unlocks.
- **Department standing:** earned through behavior aligned with departmental priorities.
- **Clearance:** milestone-based access, not a spendable currency.

Avoid multiple premium-like currencies and randomized loot.

## 12.3 Department Relationships

| Department | Rewards | Values |
|---|---|---|
| Research | Better analysis, experimental sensors | High-integrity evidence and samples |
| Engineering | Modular tools, lighter equipment | Device recovery and field telemetry |
| Medical | Treatment and exposure countermeasures | Personnel and civilian survival |
| Security | Defensive equipment and transport armor | Controlled threat response |
| Ethics Committee | Intelligence, waivers, public-risk tools | Proportional force and civilian care |
| Logistics | Cargo, maintenance, deployment options | Equipment stewardship and efficient operations |

Standing creates choices, not permanent faction exclusion.

## 12.4 Upgrade Structure

Each equipment family has sidegrades across:

- Range
- Precision
- Portability
- Battery endurance
- Durability
- Remote operation
- Environmental resistance
- Data logging

Example: a thermal camera may branch into a head-mounted short-range model, a heavy long-range scanner, or a remote unit. None is universally superior.

## 12.5 Injury and Recovery

Serious injuries apply temporary effects such as reduced carrying tolerance or slower stabilization. Treatment uses time, site capacity, or medical resources. Players can always field a character; the system should encourage rotation without forcing real-time waiting.

## 12.6 Failure Economy

Failed missions provide reduced but meaningful research for valid observations. This prevents a total time loss while preserving stakes through:

- Lost consumables.
- Damaged or unrecovered issued gear.
- Lower standing.
- Site incidents or follow-up missions.
- Reduced civilian trust and worse intelligence in that region.

No debt spiral should make recovery impossible.

---

# 13. Foundation Home Base

## 13.1 Purpose

The base is a functional lobby, progression interface, tutorial space, and physical record of the campaign. It should be compact enough that preparing for a mission takes minutes, not a commute.

## 13.2 Core Areas

### Operations Room

Mission board, squad lobby, map table, weather and regional status, difficulty modifiers, and readiness check.

### Archives

Case files, evidence review, attribution/credits access, anomaly codex, training simulations, and mission history.

### Armory and Logistics

Loadouts, maintenance, cargo manifest, firing and tool test lane, cosmetic uniform selection, and equipment recovery.

### Research Laboratory

Sample analysis, research projects, anomaly behavior review, and prototype requests.

### Engineering Bay

Upgrade branches, modular containment unit configuration, repair queue, and controlled tool tests.

### Medical Wing

Injury treatment, exposure review, character status, and tutorialization of conditions.

### Containment Wing

Captured anomalies appear in appropriate cells, lockers, or remote-monitor feeds. Entries emphasize operational history rather than treating beings as trophies. Certain captures create maintenance events, research opportunities, or new risks.

### Personnel Area

Character customization, squad commendations, photographs, recovered objects, and accessibility settings.

## 13.3 Base Growth

The site begins as an underfunded regional facility. Upgrades visibly add capability:

- Backup power
- Expanded archives
- Better medical isolation
- Specialized storage
- Additional vehicle bay
- Stronger perimeter monitoring
- Training and simulation space

Growth should change navigation modestly without making familiar functions difficult to find.

## 13.4 Base Incidents

Contained anomalies may generate short optional events between missions: a sensor discrepancy, maintenance request, interview, or minor containment concern. Incidents use existing spaces, do not become mandatory chores, and never destroy long-term progress while players are offline.

---

# 14. Maps, Objectives, and World Systems

## 14.1 Map Philosophy

Maps are operational sandboxes, not procedurally generated corridors. Each has authored landmarks, circulation, systems, civilian logic, and containment opportunities. Replayability comes from incident placement, access conditions, evidence routes, weather, infrastructure damage, and anomaly behavior.

## 14.2 Launch Environment Families

- National forest, ranger station, and campground
- Condemned apartment block and service tunnels
- Rural hospital or long-term care facility
- Small-town commercial strip and residences
- Research or industrial facility
- Highway, motel, and service station
- Utility tunnels and flood-control system

## 14.3 Map Anatomy

Each map requires:

- Two or more entry routes.
- A defensible field command location.
- A looped circulation path to reduce dead ends.
- At least three potential activity zones.
- Infrastructure controls: power, communications, ventilation, water, doors, or alarms.
- Staging areas for containment equipment.
- Multiple extraction paths, one of which may become compromised.
- Civilian or responder spaces that imply a real place.
- Readable landmarks for verbal navigation.

## 14.4 Controlled Variation

At mission start, a scenario seed selects:

- Incident origin and anchor position.
- Locked, flooded, burned, collapsed, or quarantined routes.
- Power and communication faults.
- Civilian locations and states.
- Evidence subset and false-lead source.
- Weather and time.
- Secondary hazard package.
- Anomaly behavior parameters within approved bounds.

Critical procedure items always have redundant discovery paths. Randomization must not generate unwinnable states.

## 14.5 Environment Interaction

Players can:

- Restore or isolate electrical circuits.
- Open, lock, wedge, or breach selected doors.
- Move lightweight furniture and mission props.
- Board or seal designated openings.
- Control alarms, speakers, lights, ventilation, and pumps.
- Deploy cables and sensors on supported surfaces.
- Inspect records, bodies, damage, and traces.

Broad destruction is limited to authored breakable elements for performance, network determinism, and level clarity.

## 14.6 Civilians and NPCs

NPC states include unaware, hiding, panicked, injured, contaminated, hostile, compromised, and cooperative. Players use simple commands: follow, wait, evacuate, restrain, and answer. Witness testimony reflects location and state.

NPCs are not escort baggage. They provide evidence, create moral choices, open access, and complicate triggers. Mission generation limits their number to what AI and networking can support reliably.

---

# 15. Content Strategy

## 15.1 Content Unit

The primary content unit is an **Incident Package**, not merely an SCP model. It contains:

- One anomaly implementation.
- One incident premise.
- Compatible map zones and anchors.
- Evidence set and witness variants.
- Procedure variants.
- Difficulty modifiers.
- Audio and visual presentation.
- Archive entry and attribution.
- QA test matrix.

## 15.2 Replayability Layers

1. **Epistemic variation:** different evidence order and reliability.
2. **Spatial variation:** changed origin, routes, and infrastructure.
3. **Behavioral variation:** approved parameters inside canonical rules.
4. **Operational variation:** optional directives and equipment constraints.
5. **Social variation:** team composition and emergent execution.

Do not rely on random jump scares or arbitrary identity swaps as the main replay layer.

## 15.3 Canon and Adaptation Policy

- Preserve the recognizable core rule and tone of the source.
- Clearly identify additions made for interactivity.
- Treat conflicting article details as a content-design decision requiring documentation.
- Avoid declaring game-original events to be official SCP canon.
- Favor incident-specific uncertainty over changing a famous rule without explanation.
- Maintain a revision snapshot because wiki articles can change.

## 15.4 Content Selection Scorecard

Score each candidate from 1-5:

- Cooperative role diversity
- Rule clarity
- Evidence richness
- Containment distinctiveness
- Map compatibility
- Replay variation
- Accessibility feasibility
- Network feasibility
- Art/animation cost
- Licensing clarity
- Rating/platform suitability

Candidates with unresolved licensing or unusable core mechanics do not advance, regardless of popularity.

---

# 16. Art Direction

## 16.1 Visual Thesis

**Documentary institutional realism disrupted by precise, rule-driven impossibility.**

Ordinary spaces should feel researched, used, and geographically coherent. Foundation technology is rugged, labeled, modular, and slightly behind the bleeding edge because reliability matters more than spectacle. Anomalous presentation uses a small number of distinctive violations rather than constant visual noise.

## 16.2 Style

- Stylized realism with restrained texture density.
- Strong silhouettes and readable equipment states.
- Physically plausible lighting with deliberate gameplay overrides.
- Cool institutional neutrals at the base; location-specific palettes in the field.
- Amber for operational warning, red for immediate danger, cyan/green for instrument data.
- Minimal chromatic aberration, film grain, or lens dirt; all can be disabled.

## 16.3 Anomaly Presentation

An anomaly's art communicates rules:

- State changes have consistent posture, material, sound, or environmental tells.
- Weakness is not always a glowing target.
- Distortion is localized and meaningful.
- Visual obstruction does not counterfeit evidence without an anomaly rule.
- Gore is used for consequence and forensic storytelling, not decoration.

## 16.4 Characters

Field personnel use layered workwear, body armor, protective equipment, radios, and visible carried tools. Character silhouettes remain grounded. Cosmetics use patterns, wear, patches, and practical accessories rather than novelty costumes that undermine horror.

## 16.5 Environment Art

Every field location needs:

- A normal-life layer showing what the place was for.
- An incident layer showing chronology and response.
- An anomalous layer tied to actual mechanics.
- Navigation landmarks readable in darkness.
- Surfaces and sockets that clearly support equipment placement.

## 16.6 Performance Budgets for Prototype

Initial targets on recommended desktop hardware:

- 60 frames per second at 1080p on medium settings.
- Conservative dynamic light count.
- Baked or mixed lighting where practical.
- Level-of-detail meshes and occlusion culling.
- Texture resolution appropriate to viewing distance.
- Limited transparent full-screen effects.

Exact budgets are set after the first representative map benchmark.

---

# 17. Audio Direction

## 17.1 Audio Thesis

Sound is an investigative channel, a spatial warning system, and a source of uncertainty. It must remain interpretable under voice chat.

## 17.2 Sound Layers

- Location ambience and weather
- Infrastructure hum, alarms, ventilation, and power transitions
- Player movement, equipment handling, breathing, and injury
- Diegetic radios and communications
- Anomaly state cues
- UI and instrument feedback
- Sparse adaptive score

## 17.3 Anomaly Audio Rules

Each anomaly has a documented audio vocabulary:

- Presence cue
- State transition cue
- Directional movement cue
- Attack/procedure warning
- Successful constraint cue
- Containment instability cue

Cues may be subtle, but repeated exposure teaches them. Critical information also has a visual or haptic alternative.

## 17.4 Voice and Mimicry

If an anomaly reproduces speech, the design defaults to authored lines or player-selected quick phrases. Recording and replaying live player voice requires explicit consent, clear session-only retention, a non-voice alternative, moderation review, and privacy/legal approval.

## 17.5 Music

Music is sparse during investigation. It responds to comprehension and procedural commitment rather than merely enemy proximity. Containment music supports rhythm without masking callouts. The base uses low, functional ambience and restrained motifs tied to site growth.

---

# 18. UI and UX

## 18.1 UX Principles

- Information should exist diegetically when practical, but never at the cost of clarity.
- The game distinguishes observed fact, system interpretation, and player theory.
- Critical states use redundant color, shape, text, and sound.
- Menus minimize time away from the world during danger.
- The same action uses consistent input language across tools.

## 18.2 HUD

Default HUD is minimal:

- Held item status and mode
- Radio channel and transmission state
- Context prompt
- Injury/condition warnings
- Squad status indicators
- Marked objective or team ping

No permanent minimap in standard mode. Maps are held devices or command displays; accessibility settings can add navigation aids.

## 18.3 Field Tablet

Tabs:

- Briefing
- Map and pings
- Evidence log
- Hypothesis board
- Procedure plan
- Squad vitals and equipment telemetry
- Objectives

The tablet can be used at any time but does not pause multiplayer. A compact overlay supports quick checks.

## 18.4 Procedure Planner

The team constructs a procedure with five fields:

1. Target
2. Required state
3. Trigger
4. Maintained conditions
5. Transfer/verification

Players assign positions or tasks and mark an abort trigger. The planner produces a concise shared checklist. It does not validate whether the theory is correct.

## 18.5 Interaction Language

- White outline: ordinary interactable.
- Cyan brackets: instrument target or data source.
- Amber pulse: degraded or uncertain state.
- Red segmented border: immediate hazard or failed containment condition.
- Striped seal icon: custody-critical object.

These treatments must function without color.

## 18.6 Onboarding

Training occurs in three layers:

1. **Base certification:** movement, tools, evidence logging, and placement.
2. **Controlled field exercise:** harmless rule-based target with a simple procedure.
3. **First live operation:** generous intelligence and recovery windows.

Tutorials teach the reasoning pattern, not the solution to later anomalies.

---

# 19. Accessibility

Accessibility is part of system design, particularly because perception is a core mechanic.

## 19.1 Required Options

- Full remapping for keyboard/mouse and controller.
- Hold/toggle settings for sprint, crouch, aim, lean, and tool use.
- Subtitles with speaker, direction, size, opacity, and non-speech captions.
- Color-vision presets plus icon/shape redundancy.
- Adjustable field of view, camera shake, head bob, motion blur, film grain, and distortion.
- Photosensitivity-safe mode for flashes and rapid contrast changes.
- Separate sliders for voice, anomaly cues, instruments, ambience, and music.
- Proximity voice alternatives: text, ping, phrase wheel, and speech-to-text where supported.
- UI scale and high-contrast mode.
- Difficulty assists for procedure timing, evidence legibility, and navigation.
- Content warnings and adjustable gore.

## 19.2 Rule Accessibility

No required anomaly rule may depend solely on:

- Fine color discrimination.
- Stereo hearing.
- Microphone use.
- Reading small or rapidly changing text.
- Sustained exposure to flashing imagery.
- Unavoidable spatial disorientation.

Alternative signals must preserve the challenge of interpretation rather than reveal the answer.

---

# 20. Technical Architecture: HTML Prototype

## 20.1 Prototype Goals

The HTML prototype proves:

- First-person movement and interaction feel.
- Networked cooperation for four players.
- Server-authoritative anomaly state.
- Evidence synchronization and hypothesis workflow.
- One complete containment procedure.
- Mission staging, success/failure, and debrief.
- Acceptable desktop browser performance.

It does not need Steamworks, final graphics, open matchmaking, persistent voice, or a production-scale backend.

## 20.2 Recommended Stack

| Layer | Recommendation | Reason |
|---|---|---|
| Language | TypeScript | Shared types and safer network contracts |
| Client build | Vite or equivalent lightweight bundler | Fast iteration and static output |
| 3D engine | Babylon.js or Three.js after a timed spike | WebGL/WebGPU path; select based on networking, tooling, and team familiarity |
| Physics | Engine-integrated physics adapter or Rapier-compatible web build | Deterministic-enough collision and supported WASM performance |
| UI | DOM/CSS for menus and tablet; canvas/engine UI only for world-space displays | Accessibility and iteration speed |
| Server | Node.js TypeScript process | Shared schemas and broad hosting support |
| Transport | WebSocket for gameplay state | Reliable browser support and operational simplicity |
| Serialization | Explicit binary or compact schema after JSON prototype | Debug first; optimize measured bottlenecks |
| Persistence | SQLite locally, PostgreSQL when hosted | Simple prototype path with production migration |
| Content | Versioned JSON schemas validated at build and load time | Data-driven anomaly and mission authoring |
| Testing | Unit tests plus headless integration and scripted multiplayer bots | Protect rule logic and replication |

Technology versions should be pinned only when implementation begins. A two-week engine spike should compare scene workflow, animation, physics, profiling, input, and packaging before committing.

## 20.3 Runtime Topology

```text
Desktop Browser Clients (1-4)
        | WebSocket input / snapshots / events
        v
Authoritative Session Server
  - Mission state machine
  - Anomaly simulation
  - Interaction validation
  - Evidence ledger
  - Player condition state
  - Containment evaluator
        |
        +--> Persistence (profiles, unlocks, mission results)
        +--> Telemetry (privacy-respecting development events)
```

The server owns anomaly state, damage, evidence confirmation, inventory transfers, containment conditions, and mission outcome. Clients own presentation and predict local movement where appropriate.

## 20.4 Simulation Model

- Fixed server simulation tick.
- Client input sequence numbers and acknowledgments.
- Snapshot interpolation for remote actors.
- Local movement prediction with correction smoothing.
- Reliable ordered events for inventory, evidence, objectives, and state transitions.
- Interest management by zone when maps grow.
- Server timestamps for procedure windows, avoiding client-frame tests.

Exact tick and snapshot rates are established through profiling. Anomaly rules must use latency-tolerant windows and server-confirmed conditions.

## 20.5 Game State Architecture

Use composable data and systems rather than unique hard-coded mission scripts where possible.

**Core entities**

- Player
- NPC
- Anomaly target
- Manifestation
- Evidence source
- Tool/device
- Mission object
- Containment component
- Infrastructure node
- Zone/volume

**Core services**

- Interaction service
- Inventory service
- Evidence ledger
- Anomaly state machine
- Incident pressure director
- Objective graph
- Containment evaluator
- Replication layer
- Save/profile service
- Audio event router

An anomaly may use custom logic, but it communicates through stable interfaces for perception, triggers, effects, evidence, and containment conditions.

## 20.6 Data-Driven Anomaly Schema

Illustrative structure:

```ts
interface AnomalyDefinition {
  id: string;
  contentRevision: string;
  states: StateDefinition[];
  triggers: TriggerDefinition[];
  capabilities: CapabilityDefinition[];
  constraints: ConstraintDefinition[];
  evidenceRules: EvidenceRule[];
  containment: ContainmentDefinition;
  difficultyProfiles: DifficultyProfile[];
  licensingRecordId: string;
}
```

Complex behavior belongs in tested modules referenced by data, not arbitrary executable content downloaded from servers.

## 20.7 Mission State Machine

```text
Lobby -> Loading -> Arrival -> Investigation -> ProcedureCommitted
      -> ContainmentActive -> CustodyEstablished -> Extraction -> Debrief
                              |                    |
                              +-> Breach ----------+
```

The server persists major phase transitions and enough inventory/object state to support reconnect. Full mid-mission crash recovery is a production goal, not required for the earliest prototype.

## 20.8 Content Pipeline

1. Author incident definitions in validated data files.
2. Validate references, ranges, required licensing fields, and procedure reachability.
3. Run deterministic anomaly behavior tests.
4. Build client assets with hashes and manifests.
5. Package server and client from the same protocol version.
6. Refuse incompatible clients with a clear error.

## 20.9 Security and Anti-Cheat

- Never trust client claims for evidence, inventory, hits, or success.
- Validate distance, line of sight, item ownership, timing, and state prerequisites.
- Rate-limit interaction and chat events.
- Sanitize player text and lobby metadata.
- Keep secrets and administrative credentials server-side.
- Use signed authentication/session tokens in hosted builds.
- Log suspicious actions with privacy limits.
- Treat community-hosted servers as a later, separately designed feature.

## 20.10 Voice

Voice is optional for the initial prototype and may use a proven external service or platform layer later. If implemented in-browser, WebRTC handles media while gameplay remains on WebSocket. Do not route high-bandwidth voice through the simulation server. Consent, moderation, mute/block, device selection, and failure behavior are required before public release.

## 20.11 Desktop and Steam Path

The browser build should separate web APIs behind platform adapters for storage, identity, invitations, achievements, voice, and file access. After the vertical slice:

1. Evaluate a desktop wrapper against a native-engine migration using measured performance and production needs.
2. Keep the authoritative game server platform-neutral.
3. Integrate Steam identity, lobbies/invites, achievements, cloud saves, and rich presence through the selected desktop bridge.
4. Test overlay, controller, ultrawide, suspend/resume, and packaging behavior.
5. Do not assume Steam's HTML rendering features turn a webpage into a complete networked game distribution solution.

## 20.12 Performance and Compatibility

Initial browser support: current Chromium-based desktop browsers. Firefox is best-effort during prototype; mobile is unsupported. WebGPU may be offered behind capability detection, with WebGL as the safe baseline until coverage and engine behavior justify a change.

Budgets are measured for:

- CPU simulation and render time
- Draw calls and visible triangles
- GPU memory and texture streaming
- Network bytes per second per client
- Server tick duration
- Garbage-collection spikes
- Load time and asset download size

Performance gates use a representative mission, not an empty test room.

---

# 21. Analytics, Testing, and Balancing

## 21.1 Design Questions

Telemetry should answer specific questions:

- Where do teams form their first useful hypothesis?
- Which evidence is found, ignored, or misunderstood?
- How often do teams revise a procedure?
- Which role lacks meaningful work?
- What causes containment faults?
- Are failures perceived as fair?
- How long do briefing, investigation, staging, and execution take?

## 21.2 Core Events

- Mission selected/started/completed/abandoned
- Equipment selected, deployed, lost, and recovered
- Evidence observed and logged
- Hypothesis added, excluded, or changed
- Procedure committed and revised
- Anomaly state transition with cause
- Player downed, rescued, extracted, or lost
- Containment condition gained/lost
- Optional directive outcome
- Match reconnect and network quality

Do not record raw voice, free-text chat, or unnecessary personal data.

## 21.3 Balance Metrics

Target ranges after onboarding:

- Mission success: 55-70% on standard Field difficulty.
- Correct classification among successful teams: 70-90%.
- At least one meaningful hypothesis revision: common but not mandatory.
- Containment phase duration: 15-25% of mission time.
- Every player has at least one pivotal logged contribution in most full-squad missions.
- A majority of failed teams can accurately name the decisive mistake in post-test interviews.

## 21.4 Test Layers

- Unit tests for rules, condition evaluation, and evidence generation.
- Deterministic simulation tests for every state transition.
- Network tests with latency, loss, reconnect, and out-of-order events.
- Scripted bots for repeated procedure paths.
- Internal playtests for comprehension and role activity.
- External blind tests for onboarding and fairness.
- Accessibility reviews for every perception-dependent anomaly.
- Licensing audit before content lock.

---

# 22. Monetization and Community Philosophy

## 22.1 Business Model

Preferred model: a premium base game with substantial free quality updates. Paid expansion packs may add maps, incident packages, and base capabilities after launch if they do not fragment matchmaking.

## 22.2 Prohibited Practices

- No pay-to-win equipment or stat advantages.
- No paid loot boxes.
- No purchasable research skips that affect team capability.
- No energy timers or forced daily login loops.
- No selling gameplay solutions to deliberately obscure anomalies.
- No battle pass at initial release.
- No trading economy dependent on artificial scarcity.

## 22.3 Cosmetics

If cosmetics are sold:

- They remain practical and tonally consistent.
- Prices and contents are explicit.
- They cannot imitate threat tells, staff roles, injuries, or tool states.
- A strong earnable cosmetic path remains.
- Licensing status is tracked per item.

## 22.4 Expansions and Matchmaking

When a squad selects paid content, consider allowing non-owners to join a mission hosted or selected by an owner while owners retain access to selection, progression tracks, or cosmetics. Exact policy requires platform and financial review, but avoiding player-base fragmentation is a priority.

## 22.5 Community Content

Mod support is attractive but not a launch promise. Any future workshop pipeline needs:

- Sandboxed data/script boundaries.
- Server authority and version validation.
- Content rating and moderation.
- Mandatory attribution/license fields.
- Clear distinction between official and community content.
- A process for takedowns and incompatible licenses.

---

# 23. Roadmap and Milestones

Schedule ranges are planning estimates for a small experienced team and must be recalibrated after staffing and technical spikes.

## Milestone 0: Legal and Technical Foundations (2-4 weeks)

**Goals**

- Obtain legal advice on derivative-work scope and commercial distribution.
- Establish attribution database and asset intake rules.
- Run engine/network/physics spike.
- Create the anomaly design schema.
- Lock prototype success criteria.

**Exit criteria**

- Written legal questions and counsel guidance captured.
- One client can connect to a server and manipulate a replicated object.
- Engine decision recorded with benchmark evidence.
- No prototype content enters production without a source record.

## Milestone 1: Graybox Interaction Prototype (4-6 weeks)

**Goals**

- First-person movement and interaction.
- Inventory, tool placement, power, doors, and simple injury.
- Two connected players in a graybox map.
- Basic tablet and evidence logging.

**Exit criteria**

- Two players can deploy, place a sensor, observe synchronized data, and extract.
- Representative client meets frame target in graybox.
- Interaction validation is server-owned.

## Milestone 2: Containment Proof (6-10 weeks)

**Goals**

- One full anomaly state machine.
- Six to eight tools.
- Evidence and hypothesis board.
- One multi-step containment procedure with failure recovery.
- Four-player support.

**Exit criteria**

- Blind teams can discover at least two critical rules.
- At least half of trained teams complete containment on standard settings.
- Testers describe the procedure, not combat damage, as the climax.

## Milestone 3: Vertical Slice (10-16 weeks)

**Goals**

- One polished field map.
- Compact four-room base.
- Three incident packages sharing the map.
- Progression, debrief, equipment recovery, and containment display.
- Representative art, audio, UI, and accessibility settings.

**Exit criteria**

- Complete base-to-mission-to-base loop.
- Stable 30-45 minute public-quality session.
- Three anomalies require meaningfully different reasoning and procedures.
- Performance, network, crash, and licensing gates pass.

## Milestone 4: Production Alpha (6-12 months after slice)

**Goals**

- Three environment families.
- Six to eight anomalies.
- Hosted sessions, reconnect, profiles, and matchmaking.
- Full progression foundation.
- Content pipeline usable by designers without engineering support for routine incidents.

## Milestone 5: Feature Complete / Beta

**Goals**

- Planned launch content complete.
- Steam packaging and platform features.
- Accessibility and localization pass.
- Security, moderation, privacy, and load testing.
- External balance and onboarding tests.

## Milestone 6: Launch Candidate

**Goals**

- Content lock.
- Complete attribution and license audit.
- Store, credits, EULA, privacy, and support materials approved.
- Crash, performance, networking, and save-migration thresholds met.
- Day-one operations and rollback plan rehearsed.

---

# 24. Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---:|---|
| Containment becomes a disguised boss fight | Critical | Require procedure verbs, simultaneous roles, and no universal damage solution in every content review |
| Missions become repetitive evidence sweeps | High | Use rule-based experiments, variable infrastructure, incident premises, and multiple evidence routes |
| Famous SCP knowledge trivializes play | High | Make all rules discoverable; add canonical incident variation and local complications without arbitrary contradictions |
| SCP ShareAlike obligations conflict with business assumptions | Critical | Seek counsel early; define derivative boundaries; build attribution and source release into production; do not rely on secrecy of covered content |
| Wiki media has incompatible or unclear licensing | Critical | Create original assets; maintain per-asset provenance; never scrape article images into production |
| Multiplayer latency breaks observation/timing mechanics | Critical | Server authority, tolerant timing windows, explicit timestamps, and simulated poor-network testing |
| Browser performance cannot support target fidelity | High | Benchmark representative scenes early; isolate platform adapters; preserve migration/wrapper options |
| Scope expands through anomaly uniqueness | Critical | Enforce shared containment grammar and content scorecard; custom code must justify its production cost |
| Solo play is either impossible or trivial | Medium | Adjust procedures with automation and timing, not broad stat boosts |
| Voice-dependent mechanics exclude players | High | Provide ping, text, quick phrase, and authored-sound equivalents |
| Players grief mission-critical procedures | High | Server validation, recoverable unique items, action logs, moderation, and public-lobby controls |
| Horror becomes unreadable visual/audio noise | Medium | Maintain cue vocabularies and accessibility alternatives; limit nondiegetic distortion |
| Persistent progression removes tension | High | Progress through options and efficiency; cap defenses; keep anomalies rule-dominant |
| Live-service pressure damages trust | Medium | Premium-first model, no power sales, no forced daily systems, and transparent expansion policy |
| Article revisions invalidate designs or credits | High | Store source URL, author, revision/date, derivative notes, and periodic pre-release audits |
| Community assumes official SCP endorsement | Medium | Clear independent-work notice and attribution language; do not imply endorsement |
| Content volume exceeds team capacity | Critical | Ship fewer deep incident packages; use vertical-slice metrics before scaling |

---

# 25. SCP Licensing and Attribution

> **Important:** This section is production guidance, not legal advice. Obtain advice from a qualified intellectual-property attorney before funding, announcing, or commercially releasing the project.

## 25.1 Baseline Obligation

The SCP Wiki's current licensing guide states that derivative works must attribute the works used and apply the Creative Commons Attribution-ShareAlike 3.0 license to the derived work. The license permits sharing and adaptation, including commercial use, but requires appropriate credit, ShareAlike distribution of adaptations, and no additional legal or technological restrictions that prevent the licensed permissions.

Primary references:

- [SCP Foundation Licensing Guide](https://scp-wiki.wikidot.com/licensing-guide)
- [SCP Foundation Image Use Policy](https://scp-wiki.wikidot.com/image-use-policy)
- [Creative Commons BY-SA 3.0 deed](https://creativecommons.org/licenses/by-sa/3.0/)
- [Creative Commons BY-SA 3.0 legal code](https://creativecommons.org/licenses/by-sa/3.0/legalcode)

## 25.2 Commercial Reality

Commercial use is permitted under CC BY-SA 3.0, but covered derivative material can also be copied, adapted, and sold by others if they comply with the license. The project must not depend on exclusive control over covered SCP-derived content as its sole competitive moat.

The product strategy should derive durable value from:

- Reliable multiplayer infrastructure.
- Original production assets and implementation craft.
- Ongoing service and support.
- Community trust.
- A strong content pipeline and game design.
- Original elements whose legal treatment has been reviewed separately.

Do not assume this list determines which elements are or are not part of the licensed adaptation; counsel must analyze that boundary.

## 25.3 Attribution Database

Every SCP-derived content item must have a record before implementation:

| Field | Required |
|---|---|
| SCP designation and article title | Yes |
| Article URL | Yes |
| Author(s) and attribution source | Yes |
| Wiki branch | Yes |
| Page revision/permanent link or access date | Yes |
| Concepts, text, characters, or procedures adapted | Yes |
| Changes made for the game | Yes |
| Required license and notice | Yes |
| Associated assets and their independent sources | Yes |
| Internal content owner | Yes |
| Legal review status | Yes |
| In-game and distribution credit location | Yes |

Credits should be generated from this database to reduce omissions.

## 25.4 In-Game and Distribution Notice

The final language must be reviewed, but the release needs a prominent notice that:

- Identifies the game as based on SCP Foundation material.
- Credits the SCP Wiki and specific article authors.
- Links each adapted article where practical.
- Links the CC BY-SA 3.0 license.
- States that covered derivative material is released under CC BY-SA 3.0.
- Indicates meaningful changes.
- Does not imply endorsement by the SCP Wiki or its contributors.

Attribution must be accessible from the main menu, not buried exclusively in end credits. A machine-readable or web-based attribution index can supplement the in-game credits, subject to legal review and offline availability needs.

## 25.5 Images, Audio, and Other Media

Text-license compliance does not automatically clear media attached to an SCP article. Each image, model source, texture, typeface, recording, and sound needs its own provenance and compatible rights.

Production policy:

- Create original visual and audio assets whenever possible.
- Do not copy article images, logos, photographs, or audio merely because they appear on the wiki.
- Reject assets with unknown provenance.
- Track source, author, license, modifications, and attribution per asset.
- Review composites component by component.
- Keep source files and license evidence with the asset record.

## 25.6 Special Caution: SCP-173

The SCP licensing guide specifically warns against commercial use connected to SCP-173's former image, Izumi Kato's *Untitled 2004*, which is not released under Creative Commons. If SCP-173 is considered, create a wholly original visual interpretation and obtain specific legal review. Do not use, trace, closely reproduce, market with, or otherwise rely on the former photograph or sculpture design.

## 25.7 Code, Assets, and ShareAlike Boundary

CC BY-SA was not drafted specifically for complex software products. Questions about which game code, data, art, narrative, and compiled distribution constitute the adapted material require counsel. Before production, obtain a written release architecture that addresses:

- Which repositories or content packages are covered.
- How corresponding editable forms will be provided if required by the chosen interpretation.
- How proprietary third-party middleware and platform SDK terms interact with distribution.
- Whether DRM or platform technical measures create conflicts with "no additional restrictions."
- How original, non-derived assets are identified and licensed.
- How store pages, trailers, soundtrack, merchandise, and console ports will be treated.

Do not postpone this analysis until Steam submission.

## 25.8 Licensing Gate

An Incident Package cannot reach content lock unless:

- Article attribution is complete.
- The captured source revision is archived internally.
- All assets have provenance and compatible permissions.
- Changes are documented.
- Required notices are generated and reviewed.
- Any special restrictions are resolved.
- Legal review status is recorded.

---

# 26. Vertical Slice Specification

## 26.1 Purpose

The slice proves the full design loop with enough polish for external testing and production planning. It is not a content demo built from disconnected mechanics.

## 26.2 Included Content

### Base

A compact regional site with:

- Operations room
- Armory/logistics counter
- Archive terminal
- Small research station
- Containment observation corridor

### Field Map

One forest research reserve containing:

- Ranger station and parking area
- Maintenance compound
- Visitor cabins
- Fire lookout or communications tower
- Trail network and drainage crossing
- Backup power and radio systems
- Two extraction routes

### Incident Packages

Three licensed, audited SCP adaptations selected to test distinct procedure families:

1. Observation/perception containment.
2. Auditory lure and restraint.
3. Distributed-object recovery and verification.

Final SCP designations are locked only after the mechanical, accessibility, technical, and licensing scorecards pass.

### Equipment

- Flashlight
- Thermal imager
- Motion sensor
- Directional microphone/recorder
- Sample kit
- Remote camera
- Floodlight tripod
- Portable barrier
- Configurable transit case or mobile containment unit
- Trauma kit
- Sidearm
- Less-lethal or tranquilizer platform

### Systems

- Four-player online lobby
- First-person movement and interaction
- Inventory and cargo
- Evidence log and hypothesis board
- Procedure planner
- Incident Pressure and anomaly states
- Injury, downed, rescue, and extraction
- Debrief and basic progression
- Containment wing result display
- Accessibility baseline

## 26.3 Excluded from Slice

- Public matchmaking
- Full voice moderation stack
- Large-scale base customization
- More than one field map
- Cosmetic store
- Mod support
- Dedicated server browser
- Advanced destruction
- Full Steam integration
- Extensive narrative campaign

## 26.4 Slice Success Metrics

After two onboarding missions, external teams should demonstrate:

- 80% can use the evidence board without facilitator help.
- 70% can state at least two correct behavioral rules.
- 60% complete containment on Field difficulty.
- 75% describe a meaningful role for more than one teammate.
- Median mission duration is 30-45 minutes.
- Fewer than 10% of failures are described as untelegraphed or impossible to understand.
- The containment phase is rated as more memorable than weapon use.
- No critical licensing, network-authority, save, or accessibility defect remains.

## 26.5 Kill Criteria

Reconsider the project or radically revise the loop if repeated tests show that:

- Players enjoy identification but consistently dislike performing containment.
- Optimal play is silent task-splitting with little coordination.
- Anomalies require extensive bespoke code that prevents a sustainable content cadence.
- Browser performance or networking cannot meet the representative mission target and no viable packaging/migration path exists.
- Licensing obligations cannot be reconciled with the intended product and funding model.

---

# 27. Definition of Done

## 27.1 Feature Definition of Done

A feature is complete when:

- It supports at least one design pillar.
- Its player-facing rules are documented.
- Multiplayer authority and reconnect behavior are defined.
- Keyboard/mouse and controller flows work.
- Accessibility requirements are met.
- Error, cancellation, and failure states are handled.
- Analytics answer a named design question.
- Performance is measured in a representative mission.
- Automated tests cover critical logic.
- Content and licensing dependencies are recorded.
- It has passed a blind playtest appropriate to its risk.

## 27.2 Anomaly Definition of Done

An anomaly is release-ready when:

- Every critical rule is observable, consistent, and actionable.
- At least two evidence paths reveal each required rule.
- The team can recover from one ordinary procedural mistake.
- Solo and five-player procedure variants work.
- Latency does not create frame-perfect failure.
- The anomaly offers meaningful work to multiple roles.
- Difficulty modifiers preserve the rules.
- Art and audio cues have accessibility alternatives.
- The incident can be completed with more than one defensible loadout.
- Attribution and asset provenance pass review.

## 27.3 Mission Definition of Done

- No seed is unwinnable.
- Entry, investigation, staging, containment, and extraction are supported.
- Critical objects have recovery rules.
- NPC and infrastructure states replicate correctly.
- Navigation callouts are understandable.
- Optional directives create decisions rather than chores.
- Debrief events accurately reflect the operation.
- Performance and network budgets pass with a full squad.

---

# 28. Appendices

## Appendix A: Example Mission Flow

**Operation:** Missing forestry crew at Black Pine Reserve  
**Reported category:** Predatory biological anomaly  
**Conditions:** Heavy rain, intermittent power, one injured witness, damaged radio tower

1. The squad chooses thermal, audio, medical, restraint, and remote-observation equipment.
2. At arrival, a witness reports hearing a coworker calling from two places. The statement is logged as probable, not confirmed.
3. A directional microphone records a repeated phrase with identical timing. Tracks show weight without a matching thermal signature.
4. The team hypothesizes an auditory predator and tests whether recorded speech redirects it.
5. The test succeeds but raises Incident Pressure and draws the threat toward the ranger station.
6. Players configure a lure path through floodlights and remote cameras to a reinforced transfer point.
7. Security maintains distance, command triggers sound zones, containment operates the restraint, and recon verifies that the responding target is not a civilian.
8. A power fault disables one light lane. The team aborts, restores the generator, and loses a remote camera.
9. The second attempt establishes restraint and enclosure.
10. During extraction, a second audio source challenges the assumption that only one target exists. The team must verify custody before departure.
11. Debrief rewards civilian rescue and behavioral evidence, records equipment loss, and opens a research project on vocal replication.

This example is a design illustration, not a final adaptation of any specific SCP.

## Appendix B: Example Procedure Card

**Target:** Confirmed responding entity  
**Required state:** Inside marked restraint zone and attending to decoy source  
**Trigger:** Directional playback from lure unit  
**Maintained conditions:** Camera confirmation, clear civilian roster, barrier power above threshold  
**Actions:** Trigger lure -> close outer barrier -> apply restraint -> suppress movement -> seal transfer unit  
**Verification:** No additional response to secondary playback; transit telemetry stable for 30 seconds  
**Abort:** Civilian enters zone, visual confirmation lost, or barrier power drops below safe band

## Appendix C: Design Review Questions

### New anomaly pitch

- What are its three most important rules?
- How are those rules learned in play?
- What does each player do during containment?
- Which tools interact with it, and why?
- What is the plausible wrong plan?
- How does the team recover from a normal mistake?
- What varies between missions without violating the source?
- Can the mechanic work without voice, stereo sound, or fine color vision?
- Is the content feasible under network latency?
- Is source and media licensing documented?

### New equipment pitch

- What question does it answer or condition does it create?
- What is its opportunity cost?
- How can it fail legibly?
- Which existing tools does it complement rather than replace?
- Does it produce useful information for teammates?
- Can anomaly interference affect it consistently?

### New map pitch

- What operations are natural in this location?
- Which infrastructure systems create procedural choices?
- Can players describe locations over voice?
- Where can containment be staged?
- How does variation change routing without erasing authorship?
- What normal human story existed before the incident?

## Appendix D: Glossary

**Anchor:** An object, person, location, or condition that sustains or localizes anomalous activity.  
**Containment Integrity:** The degree to which required custody conditions remain satisfied.  
**Containment Operation:** The committed mission phase in which the squad performs a planned procedure.  
**Custody:** A verified state in which the anomaly is controlled, isolated, neutralized, or ready for transfer.  
**Evidence Ledger:** The authoritative record of raw observations and their provenance.  
**Incident Package:** An anomaly plus its premise, evidence, procedure, presentation, difficulty, and licensing data.  
**Incident Pressure:** A director input representing how aggressively the situation can escalate.  
**Manifestation:** A secondary entity, effect, or temporary expression of the primary anomaly.  
**Procedure:** A sequence of actions and maintained conditions intended to establish custody.  
**Rule:** A consistent relationship between conditions and anomalous behavior.  
**Site:** The persistent Foundation home base.  
**Transfer:** The extraction or handoff phase after custody is established.

## Appendix E: Version Log

| Version | Date | Summary |
|---|---|---|
| 1.0 | August 1, 2026 | Initial comprehensive design bible |

---

## Closing Principle

The game's strongest stories should begin with a sentence like: **"We thought the rule was one thing, and then we noticed..."** Every system should help the squad turn that realization into a plan worth remembering.
