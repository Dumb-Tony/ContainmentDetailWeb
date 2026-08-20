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

## Controls

| | |
|---|---|
| `W A S D` | move · `Shift` sprint · `Ctrl` crouch |
| `F` | the context verb — it says what it will do before you press it |
| `E` | use or deploy what is in hand |
| `1`–`5` | select a slot |
| `Q` | thermal imager on/off |
| `Tab` | field tablet: evidence log, hypothesis board, procedure planner |
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

**159 assertions, all headless.** Section I is the one that matters: it plays a complete
solo containment through the same interfaces a keyboard reaches — walks to the vehicle,
takes kit, throws breakers, opens doors, baits, fences, seals, waits out custody and
carries the case to the stairs. No teleports and no direct state writes, because testing
the simulation is not testing the game. Sections C and E print measured numbers rather
than asserting remembered ones.

`tools/shot.ps1 -Setup tools/_shot-fence.js -Out docs/m0-fence.png` poses a scene and
photographs it.

## Structure

```
index.html            the page; loads the vendored r128 and src/main.js
GAME_BIBLE/GDD.md     the design authority, imported verbatim
content/              the anomaly, the map and the equipment, as validated JSON
src/sim/              the rules. No renderer, no DOM, no wall clock — enforced by the suite
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
The page makes **zero external requests** at runtime.
