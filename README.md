# Containment Detail — the browser build

**Play it: https://dumb-tony.github.io/ContainmentDetailWeb/**

A first-person containment operation. You are a Foundation field unit sent two levels
down into a cold store where a maintenance crew reported *"cold that moves"*. Two of the
three came back.

You do not kill it. You work out what it wants, build something that stops it, and put it
in a box while it is still trying to get past you.

![the fence, held](docs/m0-fence.png)

## What is actually going on

One scalar field, sampled. `heat.temperatureAt(x, z)` is what the thermal imager paints,
what the anomaly's path test reads, and what decides whether a fence holds — there is no
second source of truth for either of them to drift from. Everything the game does falls
out of that one function and the anomaly's own rule: **it cannot cross a sustained heat
gradient above 40°C.**

- A **floodlight tripod** is a fence post because its own 40°C contour blocks the approach
  to itself. Nothing in the code special-cases "ignore floodlights" — it just cannot get
  there.
- The **transit case** runs its heater at 39°C. One degree under the threshold, two above
  a human being: it is the warmest thing on the floor the draught can still reach, so it
  is bait rather than a wall. Set a tripod down too close to it and the bait becomes a
  wall, and nothing comes.
- Heat sources **superpose**, so two tripods bridge a 4.2 m aisle that neither can span
  alone. The measured contour radii are printed by the test suite rather than remembered.
- The draught is a **cold mass**: it lowers the wall it leans on. A fence that was exactly
  good enough on the way in is not good enough at contact.
- The floor gets **colder** the longer you take, and a colder floor shrinks every contour
  you own. That is the clock, and you can feel it.

Two kinds of wall exist and they are different lists. Cold-store panel and closed freight
doors stop the draught; the steel racking in the aisles does not, and neither does
anything else you might reasonably expect to. That asymmetry is why the site's two-step
power puzzle matters — the office breaker is out on the bay wall, the storage breaker is
*inside the office*, and the freight door they bring up is the lane your lure needs.

The mission ends when the case is sealed, has held for thirty seconds, and is carried up
the stairs. It can be lost at any point in that sentence.

## Seven incidents, three buildings, six things

The content unit is an **Incident Package**, not a map — an anomaly file holds rules and
nothing about where; a map holds geometry and nothing about what happened;
`content/incidents/` binds them and carries the spawn, the evidence lying about, and the
briefing. That is the only reason two operations can share a building.

**Cold that moves.** The graybox-draught: an invisible cold mass that hunts the warmest
thing it can reach and cannot cross a sustained 40 °C gradient. You fence it, bait it with
a case running one degree under the threshold, and seal it while it is held.

**The figure in aisle B.** The stillwater-figure does not move while it is observed. That
is the entire rule and the entire containment: you never fence it, you never stop looking
at it, and the difficulty is that looking is a resource you also need for carrying,
placing, powering and sealing. It reads at ambient on thermal, the breakers are
irrelevant, and its own capability browns out the cameras holding it — the fence you built
is the thing it feeds on.

A squad that arrives with the first playbook finds every instinct wrong. That is the point
(GDD §15.2: the building is the constant, the incident is the variable).

**Ashlar House, ninth floor.** The mirror of that: the same draught, on a condemned
crosswall block with a drained district-heating gallery running its full width. Nineteen
of its fifty-seven walls carry the building and the other thirty-eight are plasterboard,
so the squad and the thing walk two different buildings over one footprint — you go the
long way round the flats while it crosses them in a straight line.

One floodlight's 40 °C contour measures **3.374 m** across. The cold store's aisles are
4.2 m, so a lane costs two posts and heat is the scarce thing. The gallery is **2.400 m**,
so one post closes the tube *across* and only its two ends are left: heat is cheap here
and the journey is what costs. A squad that learned "bring four tripods" has carried four
tripods up nine floors for nothing.

And the last lane cannot be closed with heat at all. The case reads 39.0 °C alone and
53.7 °C once the closing post is up, which takes the bait past the threshold and stops it
attracting anything — so the post is the *lid*, not the fence, and it goes down last. The
fire-stopping door is worth exactly one tripod. That exchange rate is the whole power
puzzle.

Neither the building nor the thing in it is the constant. You learn both, separately, and
neither answer transfers whole.

**The stocktake.** Eleven identical brass discs on the cold-store floor; five of them are
the anomaly. Nothing hunts you, there is no fence, and the failure state is arithmetic. The
tell is the heat field again, used as an *instrument* rather than a wall — each disc is a
four-degree sink, so superposition does the search gradient without a line of code deciding
it: the three in the office read 7.9 °C below ambient and are obvious from the doorway, the
singletons read 3.8 and have to be stood over.

Verification is the case, not a label. Log a real one and the count moves; log a mundane
one and the case takes it **silently** and the number does not. The game never says "that
was the wrong one" — noticing the silence is the mechanic. And the total is on a stocktake
sheet in the office, not on the HUD, so you can seal on three of five and find out at the
debrief.

**The caller.** In a condemned forest reserve, a thing that hunts *sound* and is restrained
by *silence*. Every other containment here is something you build; this one is something
you stop doing. You cannot make a quiet louder — you switch things off, put things down,
and crouch.

The lure is your own kit, which is the trap. A heater carries 22 m, a floodlight ballast
11, a power pack 7. On the cold-store floor those are the fence and the bait; here every
one is a beacon, and a squad running the draught playbook has built a perfect lure around
itself and switched it on. Two lures at once mask each other into unresolvable and it stops
in the wrong place.

Crouch stops being a way to be shorter. At two metres: 29.6 dB standing still, 35.1
crouch-walking, 48.0 walking, against a 46 dB threshold. Walk at a stilled caller and it is
running within a second. Crouch and you can get to arm's reach and close the case.

**What was left running.** The fourth operation on the cold-store floor, and the one that
punishes knowing it. A contractor went down on the Tuesday to replace a failed heater and
did not come back up. He is at the north end of the west run and he was warm when they
found him on the Wednesday.

It does not move at all. It takes whatever warm object comes within a metre and a half of
it, and it will not be watched while it holds one. So the squad arrives with three
operations' worth of correct knowledge about this floor and every piece of it is aimed at
the wrong thing: nothing here is fenced by anything, ever; a camera left pointing anywhere
near the case makes the whole operation stutter on a three-and-a-half second cycle and
burns five of the case's twelve minutes; and restoring the mains does exactly one thing,
which is make the floor bright enough to look at things by. Looking at things is the
failure mode.

It reads at ambient on every instrument in the manifest, in every state, from every
distance. An imager pointed at it shows the floor. The only habit that survives is the one
nobody thinks of as a habit: get the case out of cargo and get it powered first.

**Flat 5.** The second operation on Ashlar's ninth floor, and the inversion of what the
first one taught. The gallery draught is a journey and a fence; this never leaves one flat
and there is nothing to build.

Ashlar's argument is that nineteen of fifty-seven walls are real and thirty-eight are not.
The draught incident is about the thirty-eight being *useless* — they stop the squad and
not the thing. This one is about the thirty-eight being *useful*, for a reason nobody has
needed yet: a sightline is cast against all fifty-seven, so eleven millimetres of
plasterboard breaks a line of sight exactly as completely as a concrete crosswall does. On
this floor a wall that stops nothing can hide you from something, and hiding is the whole
containment.

Watching it holds it rigid, instantly, from any state. Slackening takes five continuous
seconds of nobody and no camera seeing it. So the climax is one operative standing beside
the case with their back to something they cannot see, pressing a verb they cannot aim —
and a squad that deploys a camera out of habit holds it rigid for that camera's whole
battery with no seal verb available at all.

Same sense as the figure in aisle B, opposite sign. That is the argument the closed
vocabulary exists to make: a key names a quantity, and the content decides what it means.

That is GDD §26.2's three procedure families — perception, auditory, distributed-object —
plus the heat fence the build started with, over three buildings — and then two more that
use the same words for the opposite purpose.

**The engine does not know what either of them is called.** States, triggers, capabilities
and field disturbance are all read from content, through a closed vocabulary of senses and
effect verbs in `src/sim/senses.js`. A JSON key may name a *quantity*, never an *operator*.
The suite proves it by renaming every state in the shipped anomaly to `q0`–`q4` and running
the whole sequence through anyway.

## The site

Between operations you are at Regional Site 19: a mission board, an armory counter, an
archive, a research station and a containment corridor that lists what you are holding by
its operational history rather than as a trophy. Progression grants **options, context and
efficiency** — never damage, never immunity (GDD §12.1). Equipment upgrades are sidegrades;
a new variant never makes the old tool irrelevant.

Failure is recoverable and never profitable. A failed operation still yields research for
valid observations, and the site can always fund one more attempt — but leaving your kit on
the floor costs you, with the departments that care about kit.

## Accessibility

Full remapping with browser-reserved keys refused, hold-vs-toggle resolved at the source,
captions for every audio cue, colour-vision presets with shape redundancy, adjustable
FOV/shake/bob/blur/grain/distortion, photosensitivity-safe mode that clamps rather than
recording a preference, five volume sliders, UI scale, and difficulty assists. `O` opens it.

GDD §19.2 is the design constraint, not the menu: no required rule may depend on fine
colour discrimination, stereo hearing, a microphone, small text or flashing imagery.

Two rules the suite enforces rather than trusting:

**An assist widens a window; it never moves a rule.** `procedureTiming` stretches the gap
between one contact and the next, and the ninety seconds you have while down. Reach, what
a contact applies, the 40 °C threshold and the thirty seconds of custody read *identically*
at 1.0 and at 2.0. It is also scoped to the operative, not the session — the host
simulates everybody's clock, so the obvious build would take the assist away from anyone
who joins a friend's game.

**The navigation aid draws the building, never the incident.** Walls, open doors, the
extraction, your squad. Not the anomaly: finding it is most of the game and the imager is
how you find it. The test reads the canvas pixels — nothing at all where the anomaly
stands, and the extraction drawn in the same pass so the test can prove it is looking at
an image rather than a blank.

An accessibility control that silently does nothing is worse than one that is absent,
because a player who needs it will believe they have already tried it. So consumption is
asserted, not presence.

**Controller.** Nothing above `input.js` has ever asked about a key — the whole build asks
for *actions* — so a pad button is a synthetic code through the same path, and it inherits
the binding table, the conflict checker, hold-versus-toggle and remapping for free. The
sticks are analog, with a squared response after a radial deadzone: half deflection reads
0.179, so the first half of the travel is fine control, which is what makes placing a
tripod in a 1.5 m doorway possible on a pad. Look is a rate times the frame's duration, not
a delta, so turn speed is not a function of frame rate.

## Does the game do what the document says

`GAME_BIBLE/GDD.md` §27.2 lists ten criteria an anomaly must meet to be release-ready and
§26.4 lists eight metrics the slice is judged on. Section AC runs them as a scorecard across
every anomaly in the build.

The five that need external testers report **OPEN**. A suite that quietly asserted `true`
for "80% can use the evidence board without facilitator help" would be worse than one that
omitted it — it would look like the criterion had been met. Median mission duration reports
OPEN too, with the bot times printed as the lower bound they are: a bot does not search or
hesitate.

It has found real gaps rather than confirming what was already believed. §27.2 asks for at
least two evidence paths per required rule; measured, the build had **3 of 12**. With one
path a squad that walks past a single pickup can never learn that rule — not "finds it
harder", cannot — which fails Pillar 1's design test outright. It is 16 of 16 now.

## One to five operatives

Host a room, share the five-character code, and everyone connects browser to browser over
WebRTC. No account, no server, no lobby list. A public broker introduces the two machines
and then carries nothing — every command and every snapshot goes peer to peer.

**The host's browser is the mission.** A client sends intent and draws snapshots and steps
nothing at all, so it cannot disagree about whether custody was established. It predicts
its own feet for responsiveness and blends toward the host's answer; past 1.2 m it snaps,
because smoothing that far is a slow lie. A client that teleports itself is simply
overwritten on the next snapshot.

**The squad's channel is not voice.** GDD §11.3 lists voice chat first and §19.2 says no
required rule may depend on a microphone or on stereo hearing. Those two are only
compatible if the *primary* channel is the one that needs neither, so what exists is a
ping-and-phrase wheel on `Z`: ten phrases the loop actually requires — *it is here*, *hold,
leave that alone*, *something to log here*, *set up here*, *bring kit here*, *I have this
one*, *in position*, *on me*, *keep this in view*, *I am in trouble*. No greetings, no
emotes. A squad with no microphones between them can run a whole operation on it, and a
squad on voice still gets a marker on the floor instead of "over there, no, the OTHER one".

Every call is host-decided. The client sends the phrase and where it aimed and **does not
send who it is** — the host stamps the seat the link is in, so putting a callout on the
board under somebody else's name is impossible by construction rather than by validation.
You cannot mark what you cannot see, or anything over thirty metres away. Markers expire:
*it is here* lasts six seconds, because it walks, and a nine-second-old marker points at
where it was. Lose your radio and your markers go with it.

A second operative changes the simulation, not just the roster:

- **Every one of them is a heat source**, so a squad is several lures. The draught takes
  whichever it can actually reach — not whoever happens to be player one.
- **A second serious contact puts you down, not dead**, on a ninety-second clock. A
  teammate with a trauma kit gets the rescue prompt above everything but the seal. Alone,
  nobody comes.
- **A tripod is a long item**, so each of you carries one at a time. A fence that takes
  three trips solo takes one with three people.
- **Two on the case** move it at 95% pace; one drags it at 75%. Never gated — solo works.
- Somebody can watch the imager while somebody else has both hands full. There is one
  imager in the cargo budget, so that is a decision.

Joining is open until the squad commits to a procedure. After that the operation is
running and the door is shut. Lose your connection and your seat is held: your kit stays
yours, your operative stands still rather than wandering off, and a resume token puts you
back in the same body. If you were carrying custody when your radio died, the case is set
down where you stood rather than leaving the floor with you.

## Controls

| | |
|---|---|
| `W A S D` | move · `Shift` sprint · `Ctrl` crouch |
| `F` | the context verb — it says what it will do before you press it |
| `E` | use or deploy what is in hand |
| `1`–`5` | select a slot |
| `Q` | thermal imager on/off |
| `Tab` | field tablet: evidence log, hypothesis board, procedure planner |
| `Z` (hold) | squad comms — the wheel picks the phrase, the mouse aims it |
| `O` | settings, remapping, accessibility |
| `Esc` | release the mouse |

Click the page to take the mouse. Two belt slots, two general, one long — a floodlight
tripod is the only thing that fits the long slot, so you carry them one at a time and the
walk back to the vehicle is part of the wager.

## Running it locally

Serving over http is required, not a convenience: the game is ES modules and browsers
refuse module loads on `file://`.

```bash
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```

It scans ports 8401–8410 and prints the one it got. Read that line — several projects on
this machine run the same server.

## Tests

There is no Node.js here, so the harness is a browser.

```bash
powershell -ExecutionPolicy Bypass -File tools/smoketest.ps1 -Tests tools/m0-tests.js
```

**746 assertions, all headless.** Section I is the one that matters: it plays a complete
solo containment through the same interfaces a keyboard reaches — walks to the vehicle,
takes kit, throws breakers, opens doors, baits, fences, seals, waits out custody and
carries the case to the stairs. No teleports and no direct state writes, because testing
the simulation is not testing the game. Sections C and E print measured numbers rather
than asserting remembered ones.

Section M runs a whole three-operative session through the real encode/decode over a
loopback link — join, intent, snapshot, refusal, the squad cap, a version mismatch, a
drop, a reconnect, the join gate, custody being put down rather than carried offline by
somebody whose radio died — with no WebRTC in sight. What a loopback *cannot* prove was
checked in two real browsers on the real broker, and that is where the notice-feed bug
was found: a refusal the host sent and the client's next snapshot destroyed.

Section K is the hygiene pass, and one of its rules earns its keep more than the others:
**a CONFIG value that nothing reads fails the build.** It found ten dead constants in a
single run — three engine rules left over from the Unity port that are content here, five
battery lives sitting beside the real ones in `items.json` and quietly disagreeing with
them, a `lightReliefRadiusM: 4.5` next to a hard-coded 6.5 for the same radius, and an RTT
budget under a correct comment about a rule the content already enforces per trigger. A
number in a config file is a promise that changing it changes the game, and ten of them
were lying.

`tools/shot.ps1 -Setup tools/_shot-fence.js -Out docs/m0-fence.png` poses a scene and
photographs it. `tools/verify-live.ps1` asks whether GitHub Pages is actually serving the
current commit — by git blob hash, because the working copy is CRLF and Pages serves LF,
so a byte comparison is off by one per line and never matches.

## Structure

```
index.html            the page; loads the vendored r128 and src/main.js
GAME_BIBLE/GDD.md     the design authority, imported verbatim
content/              incidents, anomalies, maps, equipment and the site — all validated JSON
src/sim/              the rules. No renderer, no DOM, no wall clock — enforced by the suite
src/net/              protocol.js is pure; net.js is the only file that touches Peer
src/ui/settings.js    the accessibility model (DOM-free) and its panel
src/render/           three.js: the eye's view, and the imager's second pass
src/ui/               HUD and panels, plain DOM
tools/                dev server, headless test harness, screenshot harness
```

**`src/sim/` does not know there is a renderer.** That is the Unity build's central rule
carried over, and it is what lets the suite drive an entire containment with no canvas.
Section K greps for violations rather than trusting anyone to remember.

## Relationship to the Unity build

[`Dumb-Tony/ContainmentDetail`](https://github.com/Dumb-Tony/ContainmentDetail) is the
same game in Unity, and it is not going anywhere. This is a second implementation of the
same design bible, in the browser, so the loop can be played in one click.

The design bible, the anomaly, the map and the equipment manifest are **imported from that
repo**, not re-invented — `graybox-draught.json` here is its content file, extended with
the fields this build's simulation reads. Where the two disagree, the GDD is the authority
and the disagreement is a bug in one of them.

## Licensing

The anomaly is deliberately **original, not an SCP** — `licensingRecordId: null`. GDD §25
makes an attribution record a prerequisite for implementing any SCP-derived content, and
the open questions in §25.7 about how ShareAlike applies to game code are not settled. The
whole discovery-to-custody loop can be built and tested while that stays open, and it has
been.

Third-party code is vendored and credited in [`assets/lib/NOTICE.md`](assets/lib/NOTICE.md).

A solo operation makes **zero external requests**. Hosting or joining contacts exactly one
network host — a signalling broker that introduces two browsers and then carries no game
traffic. That exception lives in one named file, and the suite asserts it rather than
letting it pass by accident: section K fails if any *other* source file grows a hostname.
