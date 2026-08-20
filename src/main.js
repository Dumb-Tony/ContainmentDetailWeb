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
import { Renderer } from './render/renderer.js';
import { Hud } from './ui/hud.js';
import { Panels } from './ui/panels.js';
import { Audio, mixFor } from './audio/audio.js';
import { Input } from './core/input.js';
import { dist } from './sim/geometry.js';

const BINDINGS = Object.freeze({
  moveUp: ['KeyW', 'ArrowUp'],
  moveDown: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'KeyC'],
  interact: ['KeyF'],
  use: ['KeyE'],
  imager: ['KeyQ'],
  tablet: ['Tab'],
  abort: ['KeyR'],
  slot1: ['Digit1'], slot2: ['Digit2'], slot3: ['Digit3'], slot4: ['Digit4'], slot5: ['Digit5'],
});

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

  let content;
  try {
    content = await loadContent();
  } catch (e) {
    bootNode.innerHTML = `<h1>Content refused</h1>
      <p>The mission did not load, and that is deliberate: a mission whose rules are broken
         is a mission whose rules cannot be learned.</p>
      <div class="err">${(e instanceof ContentError ? e.message : String(e)).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</div>`;
    return;
  }

  const THREE = window.THREE;
  if (!THREE) { bootNode.innerHTML = '<h1>Renderer missing</h1><p>assets/lib/r128/three.min.js did not load.</p>'; return; }

  const game = new Game(content, { seed: new URL(location.href).searchParams.get('seed') || 'cold-storage-1' });
  const renderer = new Renderer(THREE, canvas, game);
  const hud = new Hud(document.getElementById('hud'), game, renderer);
  const audio = new Audio();

  const input = new Input(window, BINDINGS).attach();
  let pointerLocked = false;

  /* Pointer lock can only be requested from a user gesture, and the request REJECTS rather
   * than returning false when it is not. An unguarded call therefore paints the crash
   * banner over the game the first time anything closes a panel programmatically — a pose
   * script, a test, a debrief. Ask, and accept no for an answer. */
  const grabPointer = () => {
    try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* no gesture */ }
  };

  const panels = new Panels(document.body, game, {
    onDeploy: () => { document.body.classList.remove('free'); grabPointer(); },
    onResume: () => { if (game.mission.phase !== PHASE.DEBRIEF) grabPointer(); },
  });

  /* Cues are a table lookup, so a new simulation event is a new row in audio.js and never
   * a change here. An event with no row is silent rather than fatal. */
  game.bus.onAny((e) => { audio.cue(e.type); });
  game.bus.on(EVENTS.MISSION_ENDED, (e) => {
    document.exitPointerLock();
    document.body.classList.add('free');
    panels.showDebrief(e.result);
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
    if (pointerLocked && !panels.isOpen) game.player.look(e.movementX || 0, e.movementY || 0);
  });
  input.onBlur = () => { game.clock.setPaused(true); };

  /* ── the loop ────────────────────────────────────────────────────────── */

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);

    /* Total pause by construction: the panel closes the clock, and every mutation in the
     * game runs inside the clock's step callback, so no system needs to check a flag. */
    const paused = panels.isOpen || !pointerLocked;
    game.clock.setPaused(paused);

    if (!paused) {
      game.player.sprinting = input.isDown('sprint');
      game.player.crouching = input.isDown('crouch');
      game.setAxis(input.moveAxis());

      if (input.wasPressed('interact')) {
        const r = game.doInteract();
        if (r === 'OPEN_CACHE') { document.exitPointerLock(); panels.showCache(); }
      }
      if (input.wasPressed('use')) { const e = game.useHeld(); if (e) game.notice(e); }
      if (input.wasPressed('imager')) { const e = game.toggleImager(); if (e) game.notice(e); }
      if (input.wasPressed('abort') && game.mission.procedure) game.abortProcedure();
      for (let i = 1; i <= 5; i++) if (input.wasPressed(`slot${i}`)) game.player.selectSlot(i - 1);
      if (input.wasPressed('tablet')) { document.exitPointerLock(); panels.showTablet(); }
    }

    game.frame(now);
    input.endStep();

    renderer.render();
    hud.update();

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
      }));
    }
    last = now;
  }

  window.addEventListener('resize', () => renderer.resize());
  bootNode.remove();
  document.body.classList.add('free');
  panels.showLoadout();
  requestAnimationFrame(frame);

  /* The debug handle. The suite and any console probe drive the game through THIS, so
   * everything they exercise is the shipped object graph and not a parallel one. */
  window.__CD = { game, renderer, hud, panels, audio, input, content, mixFor,
    get paused() { return game.clock.paused; } };
  window.dispatchEvent(new CustomEvent('cd-ready', { detail: window.__CD }));
}

boot();
