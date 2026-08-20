/* Pose the Foundation site for a screenshot, with a campaign behind it so the rooms have
 * something to show. See _shot-fence.js for the pause discipline. */

window.addEventListener('cd-ready', ({ detail: cd }) => {
  cd.game.clock.setPaused(true);
  cd.panels.open = null;
  cd.panels.node.style.display = 'none';

  /* One closed operation, so the archive, the ledger and the containment corridor are not
   * all empty. Graded through the real `mission.grade()` rather than hand-written. */
  const g = cd.game;
  g.commitLoadout(cd.game.content.items.items.slice(0, 3).map((i) => ({ itemId: i.id, qty: 1 })));
  g.custody = 'verified';
  g.extracted = true;
  for (const p of g.players) p.extracted = true;
  const result = g.endMission(null, 9 * 60000);
  cd.progression.applyDebrief(result, g.mission, {
    anomalyId: g.content.anomaly.id, mapId: g.content.map.id,
    custody: 'verified', minutes: 9, observations: 4, squad: g.players,
  });

  cd.base.show();
});
