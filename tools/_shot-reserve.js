/* Pose the game for a screenshot: Blackthorn Reserve at night — the outdoor family.
 *
 * The claim under test is buildScene's `outdoor` split (scene.js): a map whose
 * `ceilingHeight` is a collision lid rather than a roof (the reserve's 4.6m) must not
 * read as a very large room. The lid is drawn as unlit, fog-exempt, star-less black; the
 * fog is thinner; the ambient is cooler. The frame also carries the extraction beacon —
 * the green stack — at its real position, because "the way out is visible from across
 * the floor" is a claim about distance and fog that only a photograph can check.
 *
 * ⚠ THE INCIDENT IS CHOSEN BY THE URL, NOT HERE. Run as
 *   tools\shot.ps1 -Setup tools/_shot-reserve.js -Query "incident=blackthorn-caller" ...
 * Any other incident poses the wrong map and the photograph tests nothing.
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

  /* The compound's own circuits up, so any authored luminaire shows its lit diffuser. */
  for (const c of game.site.circuits.values()) game.site.setCircuit(c.id, true);

  /* One lit tripod in the open between the beacon and the compound fence, pane turned
   * back toward the camera: an A-frame against open night is the 20m outline test. */
  const items = game.itemsById;
  game.deployables.place(items.get('floodlight-tripod'), -12.0, -17.5, 0.74);

  /* The south-west open corner (south of the cabin at [-22,-20.4]→[-19.6,-18], west of
   * extraction), looking north-east ACROSS the beacon at (-9.6,-20.2): green stack at
   * 7m, tripod at 6m beyond-left, the compound fence and standby-set hut in the middle
   * distance, black sky over all of it. The first framing stood inside the compound and
   * photographed a wall. */
  game.player.x = -16.5; game.player.z = -22.5;
  const ex = game.site.extraction;
  game.player.yaw = Math.atan2(-(ex.x - game.player.x), -(ex.z - game.player.z));
  game.player.pitch = 0.03;
  game.player.stress = 8;

  game.notice('Reserve is dark. Fall back on the green stack if it moves.');

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
