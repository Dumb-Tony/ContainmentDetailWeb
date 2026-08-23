/* Pose the game for a screenshot: the stillwater-figure, seen, from aisle B.
 *
 * This exists because of what it replaced. Every anomaly in the build was drawn as the same
 * 0.78m purple icosahedron, and five of them are declared `visible` in their own content —
 * including this one, whose resting `visualTell` reads *"A figure at the limit of the light,
 * facing away, at the wrong scale for the distance"* and whose entire containment is a squad
 * looking at it. A photograph is the only check that catches a silhouette; the suite can
 * assert the lathe profile is 1.78m tall and cannot tell you it reads as a person.
 *
 * ⚠ THE INCIDENT IS CHOSEN BY THE URL, NOT HERE. `main.js` reads `?incident=` at boot, so
 * this must be run as
 *   tools\shot.ps1 -Setup tools/_shot-figure.js -Query "incident=cold-storage-figure" ...
 * Without the query it poses the draught, and the draught has no body to the eye at all —
 * the photograph would be an empty aisle and would look like a renderer bug.
 *
 * ⚠ PAUSE THE CLOCK BEFORE DRAWING (the `_shot-fence.js` lesson): the page's own rAF loop
 * keeps stepping while a pose script runs, and under `--virtual-time-budget` it steps a lot.
 * Here that matters more than usual — this anomaly MOVES when it is not observed, so an
 * unpaused pose photographs it somewhere else, or on top of you.
 */

window.addEventListener('cd-ready', ({ detail: cd }) => {
  const { game, renderer, hud, panels } = cd;

  panels.hide();
  panels.node.style.display = 'none';
  /* ⚠ AND THE BASE, which opens over the world on first boot and is what the first attempt
   * at this photograph actually captured: a full-screen operations board with the aisle
   * behind it, four per cent visible down the left edge. */
  if (cd.base) { cd.base.hide(); cd.base.node.style.display = 'none'; }
  game.commitLoadout([
    { itemId: 'thermal-imager', qty: 1 },
    { itemId: 'floodlight-tripod', qty: 1 },
    { itemId: 'reinforced-transit-case', qty: 1 },
    { itemId: 'trauma-kit', qty: 1 },
  ]);

  /* Lights up. This is the operation where seeing is the whole job, and photographing it
   * in the dark would be photographing the fog. */
  for (const c of game.site.circuits.values()) game.site.setCircuit(c.id, true);
  for (const d of game.site.doors) game.site.setDoorOpen(d, true);

  const items = game.itemsById;
  game.player.take(items.get('thermal-imager'));
  game.player.take(items.get('trauma-kit'));

  /* One tripod down and to the side, so there is something lit between the camera and it —
   * "at the limit of the light" needs a limit. */
  game.deployables.place(items.get('floodlight-tripod'), -3.4, -6.2, 0);

  /* Down the aisle: the operative at one end, the figure at the other, eleven metres off.
   * Far enough that the silhouette is doing the work rather than the geometry. */
  game.player.x = -1.2; game.player.z = 3.4;
  game.anomaly.x = -1.2; game.anomaly.z = -3.2;
  game.anomaly.state = game.anomaly.def.states[0].id;
  game.player.yaw = Math.atan2(-(game.anomaly.x - game.player.x), -(game.anomaly.z - game.player.z));
  game.player.pitch = -0.02;

  game.mission.pressure = 22;
  game.player.stress = 27;
  game.notice('It is where it was. Keep somebody on it.');

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
