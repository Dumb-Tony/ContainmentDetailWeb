/* Pose the settings screen for a screenshot. See _shot-fence.js for the pause discipline. */

window.addEventListener('cd-ready', ({ detail: cd }) => {
  cd.panels.open = null;
  cd.panels.node.style.display = 'none';
  cd.game.clock.setPaused(true);
  cd.settingsPanel.show('vision');
  cd.renderer.resize();
  cd.renderer.render();
  cd.hud.update();
});
