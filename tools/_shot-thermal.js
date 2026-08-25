/* Pose the game for a screenshot: the imager reading the new rigs — and telling the truth.
 *
 * The claim under test is DEPLOYABLE_FORMS' thermal contract (renderer.js): heat lives on
 * glow parts and `thermalHot` swaps, so a POWERED unit reads warm on the instrument and a
 * DEAD one reads as cold structure. The old per-item constant lied — a flat tripod stayed
 * white-hot on the screen that exists to say otherwise. So this frame holds a live tripod
 * and a dead one side by side, a heater behind them, and a squadmate (warm, 37C) — with
 * the imager ON. The eye view says the same thing in its own channels: the dead unit is
 * dimmed, its pane dark, its lamp out.
 *
 * ⚠ THE INCIDENT IS CHOSEN BY THE URL, NOT HERE. Run as
 *   tools\shot.ps1 -Setup tools/_shot-thermal.js -Query "incident=cold-storage-draught" ...
 *
 * ⚠ PAUSE THE CLOCK BEFORE DRAWING (the `_shot-fence.js` lesson).
 */

window.addEventListener('cd-ready', ({ detail: cd }) => {
  const { game, renderer, hud, panels } = cd;

  panels.hide();
  panels.node.style.display = 'none';
  if (cd.base) { cd.base.hide(); cd.base.node.style.display = 'none'; }
  /* The click-to-play hint is toggled by the frame loop — removing the node is the only
   * hide that sticks (the _shot-gear lesson). */
  const freeHint = document.querySelector('.cd-freehint');
  if (freeHint) freeHint.remove();
  game.commitLoadout([
    { itemId: 'thermal-imager', qty: 1 },
    { itemId: 'floodlight-tripod', qty: 2 },
    { itemId: 'portable-heater', qty: 1 },
    { itemId: 'trauma-kit', qty: 1 },
  ]);

  /* Dark floor: the imager is the light you brought. */
  const items = game.itemsById;
  const live = game.deployables.place(items.get('floodlight-tripod'), -2.2, -1.0, 0.4);
  const dead = game.deployables.place(items.get('floodlight-tripod'), 0.0, -1.2, -0.4);
  game.deployables.place(items.get('portable-heater'), -1.2, -2.6, 0);
  /* Flat cells, not switched off: `active` derives from hasPower, and a dead unit is the
   * fence-power failure the content authored — dim to the eye, COLD to the instrument. */
  dead.batteryMs = 0;
  void live;

  const mate = game.addPlayer('KESTREL');
  mate.x = -2.6; mate.z = 0.8; mate.yaw = Math.PI - 0.5;

  game.player.take(items.get('thermal-imager'));
  game.player.x = -1.2; game.player.z = 3.0;
  game.player.yaw = -0.06;
  game.player.pitch = -0.06;
  game.toggleImager('p1');

  game.notice('Two posts on the screen. Only one of them is holding.');

  /* One step to build the heat field from the world, then freeze everything. */
  game.clock.setPaused(false);
  game.step(1000 / 60, 1);
  renderer.thermalFloor.lastUpdateMs = -1e9;
  renderer.thermalFloor.update(game.heat, 1);
  game.clock.setPaused(true);

  renderer.resize();
  renderer.render();
  hud.update();
});
