/* Pose the game for a screenshot: an operative in the office doorway with the imager up,
 * the draught held against a tripod, and the case ready to seal.
 *
 * ⚠ PAUSE THE CLOCK BEFORE DRAWING. The page's own rAF loop keeps stepping while a pose
 * script runs, and under `--virtual-time-budget` it steps a LOT — the lesson recorded
 * against SmallTownEmergencyServices `_shot-coop.js`, where a fire was lit and the burnt
 * shell was photographed ninety seconds later.
 *
 * ⚠ AND CAPTURE `game` AFTER any restart call. Nothing here restarts, but the same trap
 * (a stale reference to a replaced state object) is one line away at all times.
 */

window.addEventListener('cd-ready', ({ detail: cd }) => {
  const { game, renderer, hud, panels } = cd;

  panels.hide();
  panels.node.style.display = 'none';
  game.commitLoadout([
    { itemId: 'thermal-imager', qty: 1 },
    { itemId: 'floodlight-tripod', qty: 3 },
    { itemId: 'reinforced-transit-case', qty: 1 },
    { itemId: 'trauma-kit', qty: 1 },
  ]);

  /* Light the place: both circuits up, both doors open. */
  game.site.setCircuit('circuit-office', true);
  game.site.setCircuit('circuit-storage', true);
  for (const d of game.site.doors) game.site.setDoorOpen(d, true);

  /* The procedure, already built. Case in the office, tripod in the doorway. */
  const items = game.itemsById;
  const kase = game.deployables.place(items.get('reinforced-transit-case'), -9.4, -9.6, 0);
  game.deployables.place(items.get('floodlight-tripod'), -8.0, -9.75, 0);
  game.deployables.place(items.get('floodlight-tripod'), -10.6, -8.6, 0);

  /* Kit in hand. */
  game.player.take(items.get('thermal-imager'));
  game.player.take(items.get('trauma-kit'));
  game.imagerOn = true;

  /* Stand in the bay looking through the doorway at the office. */
  game.player.x = -5.6; game.player.z = -8.4;
  game.player.yaw = Math.atan2(-(-9.4 - game.player.x), -(-9.6 - game.player.z));
  game.player.pitch = -0.06;

  /* Put the draught where the fence has it, and settle the field so the imager's floor
   * image is the real one rather than the blank it starts as. */
  game.anomaly.x = -9.6; game.anomaly.z = -9.4;
  game.anomaly.state = 'banked';
  game.anomaly.transitions.push({ simTimeMs: 0, from: 'drawn', to: 'banked', triggerId: 'heat-wall', telegraph: '', pressureDelta: -2 });
  game.mission.pressure = 28;
  game.player.stress = 34;
  game.notice('Frost edge stops dead at the doorway. It is held — get the case sealed.');

  /* One step to rebuild the heat field from the world, then freeze everything. */
  game.clock.setPaused(false);
  game.step(1000 / 60, 1);
  renderer.thermalFloor.lastUpdateMs = -1e9;
  renderer.thermalFloor.update(game.heat, 1);
  game.clock.setPaused(true);

  renderer.resize();
  renderer.render();
  hud.update();
});
