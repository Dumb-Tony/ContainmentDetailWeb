/* Pose the operation card for a screenshot. See _shot-fence.js for the pause discipline. */

window.addEventListener('cd-ready', ({ detail: cd }) => {
  cd.game.clock.setPaused(true);
  cd.panels.open = null;
  cd.panels.node.style.display = 'none';
  cd.panels.showLoadout();
});
