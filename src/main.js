/* Boot, input, and the frame loop. The only file that touches the browser directly.
 *
 * Nothing here decides a rule. It reads the keyboard, hands the simulation an axis, calls
 * `game.frame()`, and draws. That boundary is what lets the whole rule layer be driven
 * headless by the suite through the same `frame()` — and it is why `tools/m0-tests.js` can
 * play an entire containment without a window manager.
 *
 * ⚠ Drive `game.frame(now)`, never `game.step()` — step reads its time from the clock, so
 * calling it directly leaves simulation time pinned at zero and the floor never gets colder.
 * (The lesson recorded against SmallTownEmergencyServices `runBotShift` in Dev\INDEX.md.)
 */

import { loadContent, ContentError } from './sim/content.js';
import { Game, EVENTS, PHASE } from './game.js';
import { NetSession, ROLE, ACT } from './net/net.js';
import { Renderer } from './render/renderer.js';
import { Hud } from './ui/hud.js';
import { Panels } from './ui/panels.js';
import { Audio, mixFor } from './audio/audio.js';
import { Input } from './core/input.js';
import { Settings, SettingsPanel } from './ui/settings.js';
import { BaseScreen } from './ui/base.js';
import { LobbyScreen } from './ui/lobby.js';
import { CommsWheel, screenProjector } from './ui/commswheel.js';
import { Progression, loadSite } from './sim/progression.js';
import { escapeHtml } from './ui/hud.js';
import { dist } from './sim/geometry.js';
import { CONFIG } from './config.js';
import { installCrashBoundary, buildId } from './core/crash.js';
import { sessionRecord, sessionRecordText } from './sim/telemetry.js';
import { locale } from './core/i18n.js';

const CONFIG_NET_HZ = CONFIG.net.snapshotHz;

/**
 * The crash boundary — GDD §23 Milestone 6's crash threshold, installed before anything
 * else can throw.
 *
 * ⚠ TWELVE LINES OF BANNER LIVED HERE AND THEY WERE NOT ENOUGH. They kept the first error
 * and tallied the rest, which is the right instinct and only the first half of the problem:
 * a throw INSIDE the requestAnimationFrame loop happens sixty times a second, so the tally
 * ran to five figures while the page went on painting the last good frame — and a game that
 * is still drawing is a game the player believes is working. §18.1 does not allow the UI to
 * misrepresent state, and continuing to paint a frame the simulation did not produce is the
 * most convincing misrepresentation available.
 *
 * `core/crash.js` deduplicates by stack signature, counts occurrences per signature, stops
 * the frame loop rather than pretending, and prints which commit and which incident it
 * happened in, so a screenshot is a bug report.
 */
installCrashBoundary();

async function boot() {
  const bootNode = document.getElementById('boot');
  const canvas = document.getElementById('view');

  /**
   * Which incident this deployment is. Two of them share the cold store, and the URL is
   * how you pick (GDD §15: the content unit is an Incident Package, not a map).
   *
   * ⚠ SWITCHING INCIDENT NAVIGATES rather than rebuilding in place. It looks lazy and it
   * is the right call for a browser build: a Game, a WebGL context, a scene graph, a
   * thermal texture and a net session all have to come down together, and the one that
   * gets missed leaks a context until the tab dies. A navigation is one line and cannot
   * half-succeed. Settings and progression live in localStorage, so nothing is lost.
   */
  const params = new URL(location.href).searchParams;
  const incidentId = params.get('incident') || 'cold-storage-draught';

  /**
   * The SCENARIO seed (GDD §14.4), which is not the mission seed.
   *
   * ⚠ THE TWO SEEDS DO DIFFERENT JOBS AND MUST NOT BE THE SAME ONE. The mission seed
   * drives the simulation's rng and a replay has to be a replay, so it must not move the
   * world. The scenario seed decides which world you get — the origin, the weather, which
   * route is shut, which circuit is faulted, what evidence is on the floor.
   *
   * It defaults to the number of operations this site has closed, so redeploying to the
   * same floor is a different night rather than the same one again — which is the whole
   * point of §15.2's "the building is the constant". `?scenario=` pins one, so a squad can
   * hand each other a specific operation and a bug report can name the one that broke.
   */
  const scenario = params.get('scenario');

  let content;
  try {
    content = await loadContent({ incident: incidentId, seed: scenario });
  } catch (e) {
    bootNode.innerHTML = `<h1>Content refused</h1>
      <p>The mission did not load, and that is deliberate: a mission whose rules are broken
         is a mission whose rules cannot be learned.</p>
      <div class="err">${(e instanceof ContentError ? e.message : String(e)).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</div>`;
    return;
  }

  const THREE = window.THREE;
  if (!THREE) { bootNode.innerHTML = '<h1>Renderer missing</h1><p>assets/lib/r128/three.min.js did not load.</p>'; return; }

  /**
   * The site, and everything the squad has earned on it (GDD §12, §13).
   *
   * ⚠ FITTED KIT IS APPLIED TO THE CONTENT, NOT TO THE SIMULATION. A site upgrade or a
   * sidegrade changes what an item IS, so it is folded into the content the Game is handed
   * and nothing downstream needs to know progression exists — `game.js` still just reads
   * `content.itemsById`. The alternative is a modifier lookup at every use site, which is
   * the same thing with more places to forget.
   *
   * §12.1 is the constraint the data obeys: progression grants options, context and
   * efficiency. Never damage, never immunity.
   */
  const site = await loadSite();
  const progression = new Progression({ site });
  const fx = progression.effects();
  const handicap = progression.squadHandicap();
  const issued = content.items.items.map((it) => progression.itemAsIssued(it));
  const fitted = {
    ...content,
    items: {
      ...content.items,
      items: issued,
      cargoVolumeBudget: content.items.cargoVolumeBudget + fx.cargoVolumeBudget + handicap.cargoVolume,
    },
    itemsById: new Map(issued.map((i) => [i.id, Object.freeze(i)])),
  };

  const game = new Game(fitted, { seed: new URL(location.href).searchParams.get('seed') || 'cold-storage-1' });
  const renderer = new Renderer(THREE, canvas, game);
  const hud = new Hud(document.getElementById('hud'), game, renderer);
  const audio = new Audio();

  /* Settings are restored before anything reads them, so frame one is already the one the
   * player configured last session (GDD 19.1). A profile that refuses storage starts at
   * the defaults rather than throwing. */
  const settings = Settings.restore();
  const input = new Input(window, settings.bindings(), settings.holdModes()).attach();
  input.onBindingsChanged = (table) => { settings.setBindings(table); settings.save(); };
  /**
   * ⚠ THE LOBBY'S CLOCK IS INJECTED FROM HERE, AND IT IS WALL TIME.
   *
   * `src/net/**` is forbidden wall-clock access by the suite's own hygiene rule (section
   * K5) and it defaults to simulation time, which is exactly wrong for a lobby: the
   * mission clock is PAUSED behind an open panel, so a directory row would never age and a
   * per-seat flood budget would refill at zero tokens a second — a seat that spent its
   * budget in the room would be muted for the rest of the session. A lobby happens in the
   * world, not in the mission, and it has to be timed against the world.
   */
  const net = new NetSession(game, { snapshotHz: CONFIG_NET_HZ, now: () => Date.now() });
  let pointerLocked = false;

  /* Pointer lock can only be requested from a user gesture, and the request REJECTS rather
   * than returning false when it is not. An unguarded call therefore paints the crash
   * banner over the game the first time anything closes a panel programmatically — a pose
   * script, a test, a debrief. Ask, and accept no for an answer. */
  const grabPointer = () => {
    try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* no gesture */ }
  };

  const panels = new Panels(document.body, game, {
    onDeploy: () => { document.body.classList.remove("free"); grabPointer(); },
    onResume: () => { if (game.mission.phase !== PHASE.DEBRIEF) grabPointer(); },
  });

  /**
   * ONE function applies every setting. A settings screen that pushed each value straight
   * to its own consumer grows a path per option and eventually loses one of them — and the
   * option it loses is the one somebody needed (GDD §19.1).
   *
   * ⚠ Read `settings.effective`, never the raw values: `effective` is the copy with the
   * photosensitivity clamps already applied, so a safe-mode player cannot be handed a
   * strobe by a code path that forgot to check.
   */
  const applySettings = () => {
    settings.applyCssVars(document.documentElement);
    audio.setVolumes(settings.volumes());
    audio.captions.enabled = settings.get('captions.enabled');
    audio.captions.maxLines = settings.get('captions.maxLines');
    audio.captions.holdMs = settings.get('captions.holdMs');
    input.setHoldModes(settings.holdModes());
    /* §19.1's timing assist into the rules. Solo and hosting, it is the whole session;
     * as a client it is declared on join and the host applies it to this operative only,
     * so the assist travels with the person who needs it (see Player.assistTiming). */
    game.setAssists(settings.effective.assists, net.role === ROLE.CLIENT ? game.localId : null);
    /* The renderer grew applySettings after the settings screen shipped, so the six camera
     * sliders spent a while doing nothing at all. Guarded because an old cached module is
     * a stale renderer, not a broken game — the sliders come back on the next load. */
    if (renderer.applySettings) renderer.applySettings(settings.effective);
    hud.setNavigationAid(settings.effective.assists.navigationAids);
  };
  const settingsPanel = new SettingsPanel(document.body, settings, {
    input,
    onChange: applySettings,
    onClose: () => { if (game.mission.phase !== PHASE.DEBRIEF && !panels.isOpen) grabPointer(); },
  });
  applySettings();

  /* Cues are a table lookup, so a new simulation event is a new row in audio.js and never
   * a change here. An event with no row is silent rather than fatal. */
  game.bus.onAny((e) => { audio.cue(e.type, e); });
  /* The debrief closes the loop: the operation's nine graded dimensions become requisition,
   * research and standing, and the site is what carries between missions (GDD 12.6 — a
   * failed operation still yields something for valid observations, so no run is a total
   * loss and no run can start a debt spiral). */
  let currentOp = null;
  game.bus.on(EVENTS.MISSION_ENDED, (e) => {
    document.exitPointerLock();
    document.body.classList.add('free');
    progression.applyDebrief(e.result, game.mission, {
      anomalyId: fitted.anomaly.id,
      mapId: fitted.map.id,
      operationId: currentOp && currentOp.id,
      custody: game.custody,
      minutes: game.clock.simTimeMs / 60000,
      observations: game.ledger.entries.length,
      squad: game.players,
      /* Which night it was (§14.4), so the archive can tell two operations on the same
       * floor apart. Without it "the cold store, Costly" twice over describes a hard frost
       * with a jammed freight door and a still night with everything open. */
      scenario: content.variation ? {
        seed: content.variation.seed,
        weather: content.weather ? content.weather.label : null,
        time: content.time ? content.time.label : null,
        faulted: content.variation.faults.slice(),
        shut: content.variation.routesShut.slice(),
      } : null,
    });
    panels.showDebrief(e.result);
  });

  const base = new BaseScreen(document.body, {
    progression, site, items: fitted.items,
    onDeploy: (op) => {
      currentOp = op;
      /* Taking an operation for a DIFFERENT incident means loading different rules and a
       * different evidence set, so it navigates — same reasoning as the incident switcher
       * above. Everything earned is in localStorage and survives it. */
      /* A fresh scenario per deployment (§14.4). Taking the SAME operation again is a
       * different night on the same floor — a different origin, weather, route and fault —
       * which is what makes "the building is the constant" (§15.2) worth anything past the
       * second visit. It is derived from the site's own history rather than a random draw,
       * so a squad can be told which one they are on and get it again. */
      const nextScenario = `${op ? op.id : incidentId}-${progression.profile.operationsCompleted + 1}`;
      if (op && op.incident && (op.incident !== incidentId || nextScenario !== scenario)) {
        const u = new URL(location.href);
        u.searchParams.set('incident', op.incident);
        u.searchParams.set('scenario', nextScenario);
        location.href = u.toString();
        return;
      }
      /* The lobby, not the old squad panel: forming the squad is now a phase with its own
       * state (who is in it, which seat, which operation, whether everybody is ready) and
       * its own moderation controls, rather than a code to read aloud. GDD §11.4. */
      lobby.show(op);
    },
    onClose: () => {},
  });

  /**
   * The room before the operation (GDD §11.4, §11.7). It owns discovery, the roster, the
   * ready state and the host's moderation controls; it does not own the simulation and
   * never touches `game` — everything it does goes through `net`, which is the one place
   * that decides anything.
   */
  const lobby = new LobbyScreen(document.body, {
    net, site, progression,
    now: () => Date.now(),
    onDeploy: () => { panels.showLoadout(); },
    onClose: () => {},
  });

  /* ── input plumbing ──────────────────────────────────────────────────── */

  canvas.addEventListener('click', () => {
    audio.start();
    if (!panels.isOpen && game.mission.phase !== PHASE.DEBRIEF) grabPointer();
  });
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    document.body.classList.toggle('free', !pointerLocked);
  });
  /**
   * The squad's non-voice channel (GDD §11.3). Held on `Z`; the mouse picks a sector.
   *
   * ⚠ §19.2 forbids any required rule depending on a microphone or stereo hearing, so
   * this is the PRIMARY channel and not the accessible alternative to one. A squad with
   * no microphones between them can run an entire operation on it.
   */
  const commsWheel = new CommsWheel(document.getElementById('hud'), game, {
    project: screenProjector(renderer),
    settings,
    onRefuse: (why) => game.noticeLocal(why),
    onSend: (phraseId, aim) => {
      if (net.role === ROLE.CLIENT) {
        net.act(ACT.PING, { p: phraseId, x: Math.round(aim.x * 100), z: Math.round(aim.z * 100) });
      } else {
        /* noticeLocal, not notice: "you cannot see that from here" is addressed to the
         * person who just pressed the key, and a refusal on the squad feed is destroyed
         * by the next snapshot anyway. */
        const e = game.ping(net.localPlayerId, phraseId, aim.x, aim.z);
        if (e) game.noticeLocal(e);
      }
    },
  });

  document.addEventListener('mousemove', (e) => {
    if (!pointerLocked || panels.isOpen) return;
    /* The wheel takes the deltas INSTEAD of the head, never as well — aiming a callout
     * while your view spins is how you mark the ceiling. */
    if (commsWheel.isOpen) commsWheel.aim(e.movementX || 0, e.movementY || 0);
    else if (game.viewPlayer) game.viewPlayer.look(e.movementX || 0, e.movementY || 0);
  });
  input.onBlur = () => { game.clock.setPaused(true); };

  /* ── the loop ────────────────────────────────────────────────────────── */

  /**
   * The caption channel's visual end — GDD §17.3 requires a visual alternative for every
   * critical audio cue, and §19.2 forbids any required rule from depending on hearing at
   * all. Captions expire on SIMULATION time, so a paused game holds its last line instead
   * of losing it while the player reads the tablet.
   */
  const capNode = document.getElementById('captions');
  let capSig = '';
  function drawCaptions() {
    const on = settings.get('captions.enabled');
    capNode.style.display = on ? 'flex' : 'none';
    if (!on) return;
    const html = audio.captions.active(game.clock.simTimeMs)
      .map((r) => `<div class="cap p${r.priority}">${escapeHtml(r.text)}</div>`).join('');
    if (html !== capSig) { capSig = html; capNode.innerHTML = html; }
  }

  let lastFrameAt = 0;
  function frame(now) {
    requestAnimationFrame(frame);

    /* Total pause by construction: the panel closes the clock, and every mutation in the
     * game runs inside the clock's step callback, so no system needs to check a flag. */
    const paused = panels.isOpen || settingsPanel.isOpen || !pointerLocked;
    game.clock.setPaused(paused);

    /* The pad is POLLED, not evented — once a frame, before anything asks what is held.
     * `navigator.getGamepads` is passed in rather than reached for inside input.js so that
     * file never touches the browser and the suite can drive a synthetic pad down the same
     * path a real one uses. */
    input.pollPads(navigator.getGamepads ? navigator.getGamepads() : []);

    const me = game.playerById(net.localPlayerId);
    let cmd = null;
    if (!paused) {
      /* Stick look, applied to the same `look()` the mouse calls. It arrives as a RATE and
       * is multiplied by the frame's own duration; the mouse arrives as a distance already
       * travelled. Confusing the two makes turning speed a function of frame rate. */
      if (input.pad.connected && me && pointerLocked !== undefined) {
        const dtLook = Math.min(100, now - (lastFrameAt || now));
        const l = input.padLook(dtLook);
        if (l.yaw || l.pitch) {
          if (commsWheel.isOpen) commsWheel.aim(-l.yaw * 220, l.pitch * 220);
          else { me.yaw += l.yaw; me.pitch = Math.max(-CONFIG.player.pitchLimit, Math.min(CONFIG.player.pitchLimit, me.pitch + l.pitch)); }
        }
      }
      /* One command object per frame, exactly the shape a remote operative's arrives in.
       * From here down the simulation cannot tell a keyboard from a network packet. */
      cmd = {
        axis: input.moveAxis(),
        sprint: input.isDown('sprint'),
        crouch: input.isDown('crouch'),
        yaw: me ? me.yaw : 0,
        pitch: me ? me.pitch : 0,
      };
      game.setCommand(net.localPlayerId, cmd);

      /* A client ASKS; the host DOES. Both go through the same verbs, so there is exactly
       * one implementation of every action in the game (GDD §20.9). */
      const client = net.role === ROLE.CLIENT;
      if (input.wasPressed('interact')) {
        if (client) net.act(ACT.INTERACT);
        else {
          const r = game.doInteract(net.localPlayerId);
          if (r === 'OPEN_CACHE') { document.exitPointerLock(); panels.showCache(); }
        }
      }
      if (input.wasPressed('use')) {
        if (client) net.act(ACT.USE);
        else { const e = game.useHeld(net.localPlayerId); if (e) game.notice(e); }
      }
      if (input.wasPressed('imager')) {
        if (client) net.act(ACT.IMAGER);
        else { const e = game.toggleImager(net.localPlayerId); if (e) game.notice(e); }
      }
      if (input.wasPressed('abort') && game.mission.procedure) {
        if (client) net.act(ACT.ABORT); else game.abortProcedure();
      }
      for (let i = 1; i <= 5; i++) {
        if (!input.wasPressed(`slot${i}`)) continue;
        if (client) net.act(ACT.SLOT, { n: i - 1 });
        else game.selectSlot(net.localPlayerId, i - 1);
      }
      if (input.wasPressed('tablet')) { document.exitPointerLock(); panels.showTablet(); }
      if (input.wasPressed('settings')) { document.exitPointerLock(); settingsPanel.show(); }
      /* Held, not pressed: the wheel is open while the key is down and sends on release,
       * which is why `comms` is registered as a `sustained` action and gets §19.1's
       * hold-vs-toggle for free. */
      commsWheel.setHeld(input.isDown('comms'));
    }
    if (paused) commsWheel.hide(false);

    /* THE AUTHORITY RULE, in three lines. A host (or a solo operative, which is a host
     * with nobody connected) steps the mission. A client steps nothing at all — it
     * predicts its own feet and draws what the host last told it. */
    if (net.role === ROLE.CLIENT) {
      const dt = Math.min(now - (lastFrameAt || now), CONFIG.sim.maxFrameMs);
      if (!paused) game.predictLocal(net.localPlayerId, dt);
      game.reconcileLocal(net.localPlayerId);
    } else {
      game.frame(now);
    }
    net.pump(Math.min(now - (lastFrameAt || now), 250), cmd);
    lastFrameAt = now;
    input.endStep();

    renderer.render();
    hud.update();
    commsWheel.update(game.clock.simTimeMs);
    drawCaptions();

    if (audio.ok) {
      audio.apply(mixFor({
        anomalyStateKind: game.anomaly.stateKind,
        distance: dist(game.player.x, game.player.z, game.anomaly.x, game.anomaly.z),
        imagerOn: game.imagerOn,
        imagerLockMs: game.imagerHoldMs,
        custodyHeldMs: game.anomaly.sealedIn ? game.anomaly.sealedIn.custodyHeldMs : 0,
        stressNorm: game.player.stressNorm,
        pressureStage: game.mission.stage,
        activeEmitters: game.deployables.list.filter((d) => d.isEmitter && d.active).length,
      }), 0.12, game.clock.simTimeMs);
    }
  }

  window.addEventListener('resize', () => renderer.resize());
  bootNode.remove();
  document.body.classList.add('free');
  base.show();
  requestAnimationFrame(frame);

  /* The debug handle. The suite and any console probe drive the game through THIS, so
   * everything they exercise is the shipped object graph and not a parallel one. */
  /* Three callbacks, one screen. The lobby re-renders on ANY of them because all three
   * change something it prints: the status line, the roster, and the room itself. A
   * screen that only redrew on one of them showed a seat that had gone. */
  net.onStatus = () => { lobby.refresh(); if (panels.open === 'squad') panels._renderSquad(); };
  net.onRoster = () => { lobby.refresh(); if (panels.open === 'squad') panels._renderSquad(); };
  net.onLobby = () => { lobby.refresh(); };
  game.localId = net.localPlayerId;

  window.__CD = { game, renderer, hud, panels, audio, input, content, mixFor, net, ROLE, ACT,
    commsWheel, lobby,
    settings, settingsPanel, base, progression, site,
    /**
     * §21's session record, for the external balance and onboarding tests §23 Milestone 5
     * asks for. `__CD.sessionRecord()` returns the object; `__CD.sessionRecordText()`
     * returns it as something a facilitator can copy out of the console at the end of a run.
     *
     * ⚠ IT IS PULLED AND NEVER PUSHED. Nothing in `sim/telemetry.js` can reach the network —
     * the suite greps it for `fetch`, a beacon, a socket and a hostname. Handing the record
     * to somebody is a decision a person makes, once, out loud.
     *
     * This comment used to end "because this build contacts exactly one host, the signalling
     * broker". That was measured and it is false: `PEER_OPTS` sets no `config`, so PeerJS
     * uses its defaults and a hosted session can reach FOUR — the broker, `stun.l.google.com`
     * for the reflexive address, and TURN at `eu-0.turn.peerjs.com` / `us-0.turn.peerjs.com`
     * when a direct path cannot be found. `assets/lib/NOTICE.md` and the privacy notice name
     * all four; the audit asserts the library really carries them and that we do not override
     * them. The telemetry claim above never depended on the count — it is a property of that
     * file, checked in that file — and stating it in terms of a number that was wrong is how
     * a true sentence gets retired along with a false one.
     */
    sessionRecord: () => sessionRecord(game, { build: buildId(), locale: locale() }),
    sessionRecordText: () => sessionRecordText(game, { build: buildId(), locale: locale() }),
    get paused() { return game.clock.paused; } };
  window.dispatchEvent(new CustomEvent('cd-ready', { detail: window.__CD }));

  /* The offline copy. `sw.js` is network-first in every case — it reads its cache only when
   * `fetch` rejects or the origin returns 5xx — so it cannot hand an online player a staler
   * build than they would get with no worker at all. That property is what makes registering
   * it safe under push-is-the-deploy, and `tools/platform-tests.js` section E asserts it
   * from both directions rather than trusting the sentence.
   *
   * ⚠ AT THE END OF A BOOT THAT SUCCEEDED. A build that throws on the way up never reaches
   * this line, so it never becomes anybody's offline copy — the one failure a service worker
   * can make permanent. `new URL(..., import.meta.url)` because this page is served from a
   * repository subpath on Pages and from the root locally, the same discipline `content.js`
   * and `i18n.js` keep. `updateViaCache: 'none'` so a fix to the worker is not ten minutes
   * behind Pages' `max-age=600`. Never awaited, and the failure is swallowed: the game is
   * identical without it. */
  if ('serviceWorker' in navigator) navigator.serviceWorker
    .register(new URL('../sw.js', import.meta.url).href, { updateViaCache: 'none' })
    .catch(() => {});
}

boot();
