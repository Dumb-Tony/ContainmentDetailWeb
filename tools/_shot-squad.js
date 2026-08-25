/* Pose the game for a screenshot: three squadmates in a dark aisle, headlamps on.
 *
 * The claim under test is MATE_FORM's (renderer.js): a teammate must never be mistakable
 * for the stillwater-figure. K36–K37 assert the profile numbers; this photographs the
 * argument — mates are shorter, helmeted, BANDED in their seat colour, and above all LIT,
 * carrying the beam cone and lamp face the figure is defined by lacking. Shot in the dark
 * on purpose: the figure is only ever seen at the limit of the light, so the dark is
 * where the two silhouettes would be confused if they were confusable.
 *
 * One mate is downed, because "which shape on the floor is my operative" is the §18.1
 * question a rescue asks under the worst light in the game.
 *
 * ⚠ THE INCIDENT IS CHOSEN BY THE URL, NOT HERE. Run as
 *   tools\shot.ps1 -Setup tools/_shot-squad.js -Query "incident=cold-storage-draught" ...
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
    { itemId: 'floodlight-tripod', qty: 1 },
    { itemId: 'trauma-kit', qty: 1 },
  ]);

  /* Circuits stay DOWN. One tripod off to the side rims the silhouettes; everything else
   * is headlamps, which is the point of the photograph. */
  const items = game.itemsById;
  game.deployables.place(items.get('floodlight-tripod'), -3.4, -1.0, 0);

  /* The squad: seats p2, p3, p4 — armbands two, three and four of MATE_FORM.bands. Real
   * Players through the real roster call, so the renderer path being photographed is the
   * one a co-op session drives. Two standing, facing the camera obliquely; one downed. */
  const mates = [
    { name: 'KESTREL', x: -2.1, z: 0.4, yaw: Math.PI - 0.3, downed: false },
    { name: 'MAGPIE', x: -0.2, z: -0.7, yaw: Math.PI + 0.4, downed: false },
    { name: 'CURLEW', x: -1.5, z: -2.3, yaw: Math.PI / 2, downed: true },
  ];
  for (const m of mates) {
    const p = game.addPlayer(m.name);
    p.x = m.x; p.z = m.z; p.yaw = m.yaw;
    if (m.downed) p.downed = true;
  }

  game.player.x = -1.2; game.player.z = 4.2;
  game.player.yaw = 0;            // facing -z, into the squad
  game.player.pitch = -0.06;
  game.player.stress = 12;

  game.notice('Squad on me. CURLEW is down — MAGPIE, trauma kit.');

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
