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
import { Progression, loadSite } from './sim/progression.js';
import { escapeHtml } from './ui/hud.js';
import { dist } from './sim/geometry.js';
import { CONFIG } from './config.js';

const CONFIG_NET_HZ = CONFIG.net.snapshotHz;

/* The crash banner keeps the FIRST error and tallies the rest — a page that rewrites the
 * banner on every follow-on error hides the one that started it. */
let firstError = null, errorCount = 0;
function showError(msg) {
  errorCount++;
  if (!firstError) firstError = msg;
  const b = document.getElementById('err-banner');
  b.style.display = 'block';
  b.textContent = errorCount > 1 ? `${firstError}\n\n(+${errorCount - 1} further error${errorCount > 2 ? 's' : ''})` : firstError;
}
window.addEventListener('error', (e) => showError(`${e.message}\n  ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => showError(`Unhandled rejection: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

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

  let content;
  try {
    content = await loadContent({ incident: incidentId });
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
  const net = new NetSession(game, { snapshotHz: CONFIG_NET_HZ });
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
      if (op && op.incident && op.incident !== incidentId) {
        const u = new URL(location.href);
        u.searchParams.set('incident', op.incident);
        location.href = u.toString();
        return;
      }
      panels.showSquad(net);
    },
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
  document.addEventListener('mousemove', (e) => {
    if (pointerLocked && !panels.isOpen && game.viewPlayer) game.viewPlayer.look(e.movementX || 0, e.movementY || 0);
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

    const me = game.playerById(net.localPlayerId);
    let cmd = null;
    if (!paused) {
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
        else if (me) me.selectSlot(i - 1);
      }
      if (input.wasPressed('tablet')) { document.exitPointerLock(); panels.showTablet(); }
      if (input.wasPressed('settings')) { document.exitPointerLock(); settingsPanel.show(); }
    }

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
    drawCaptions();

    if (audio.ok) {
      audio.apply(mixFor({
        anomalyState: game.anomaly.state,
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
  net.onStatus = () => { if (panels.open === 'squad') panels._renderSquad(); };
  net.onRoster = () => { if (panels.open === 'squad') panels._renderSquad(); };
  game.localId = net.localPlayerId;

  window.__CD = { game, renderer, hud, panels, audio, input, content, mixFor, net, ROLE, ACT,
    settings, settingsPanel, base, progression, site,
    get paused() { return game.clock.paused; } };
  window.dispatchEvent(new CustomEvent('cd-ready', { detail: window.__CD }));
}

boot();
