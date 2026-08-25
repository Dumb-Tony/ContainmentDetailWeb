/* Pose the game for a screenshot: every deployable in the manifest, in one lit aisle.
 *
 * This exists because of what it replaced. Until DEPLOYABLE_FORMS (renderer.js), seven of
 * the nine deployables shared one crate-with-a-stalk rig — a motion sensor, a camera, a
 * microphone, a pack, a heater and a flashlight could not be told apart across an aisle,
 * in a game whose loop is a squad calling equipment out across an aisle. K30–K35 assert
 * the rigs are outline-distinct through a stub THREE; only a photograph can say whether
 * the outlines actually READ. Every deployable is placed active, so the tripod pane, the
 * heater band, the case strips and the flashlight lens are all in their powered state.
 *
 * ⚠ THE INCIDENT IS CHOSEN BY THE URL, NOT HERE. Run as
 *   tools\shot.ps1 -Setup tools/_shot-gear.js -Query "incident=cold-storage-draught" ...
 *
 * ⚠ PAUSE THE CLOCK BEFORE DRAWING (the `_shot-fence.js` lesson): the page's own rAF loop
 * keeps stepping under `--virtual-time-budget`, and an unpaused pose drifts.
 */

window.addEventListener('cd-ready', ({ detail: cd }) => {
  const { game, renderer, hud, panels } = cd;

  panels.hide();
  panels.node.style.display = 'none';
  /* ⚠ AND THE BASE, which opens over the world on first boot (the _shot-figure lesson). */
  if (cd.base) { cd.base.hide(); cd.base.node.style.display = 'none'; }
  /* ⚠ AND THE CLICK-TO-PLAY HINT (this file's own lesson): the frame loop toggles its
   * display every frame, so hiding it is overwritten — remove the node instead. The loop
   * keeps styling a detached element, which is harmless. */
  const freeHint = document.querySelector('.cd-freehint');
  if (freeHint) freeHint.remove();
  game.commitLoadout([
    { itemId: 'thermal-imager', qty: 1 },
    { itemId: 'trauma-kit', qty: 1 },
  ]);

  /* Lights up and doors open: this photograph is about telling shapes apart, and shapes
   * are told apart in the light. The dark version is _shot-squad.js's job. */
  for (const c of game.site.circuits.values()) game.site.setCircuit(c.id, true);
  for (const d of game.site.doors) game.site.setDoorOpen(d, true);

  /* Down the aisle _shot-figure.js proved open, alternating sides so no rig hides
   * another: small kit near the camera, the A-frame and the barrier at the far end where
   * a 20m read is the claim being tested. The instruments face the CAMERA (yaw ≈ π) —
   * a dish photographed from behind is a ball, which is the ambiguity this rig exists
   * to remove. */
  const items = game.itemsById;
  const row = [
    ['flashlight', -1.9, 2.1, 1.2],
    ['motion-sensor', 0.2, 1.6, Math.PI - 0.4],
    ['remote-camera', -2.3, 0.9, Math.PI + 0.35],
    ['directional-microphone', -0.9, -0.2, Math.PI - 0.15],
    ['power-pack', -2.2, -1.2, 0],
    ['portable-heater', -0.1, -1.9, 0],
    /* Front strip and lamp pane toward the camera (yaw ≈ π); the map's own evidence post
     * stands near (-0.3, -4), so the tripod goes right of the aisle centre, off the
     * heater's sight line, rather than behind furniture. */
    ['reinforced-transit-case', -2.3, -3.0, Math.PI + 0.3],
    ['floodlight-tripod', 0.35, -2.9, Math.PI],
    ['portable-barrier', -1.2, -6.0, 0],
  ];
  for (const [id, x, z, yaw] of row) game.deployables.place(items.get(id), x, z, yaw);

  game.player.x = -1.2; game.player.z = 4.8;
  game.player.yaw = 0;            // facing -z, straight down the row
  game.player.pitch = -0.10;
  game.player.stress = 0;

  game.notice('Inventory check. Call each piece as you pass it.');

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
