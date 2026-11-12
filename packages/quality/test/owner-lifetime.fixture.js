// Quality's helpers are functions that install a plugin and return its stop; the plugin is the one they add.
const added = (scene, start) => {
  const before = new Set(scene.plugins.values());
  const stop = start();
  return { plugin: [...scene.plugins.values()].find((p) => !before.has(p)), stop };
};

// Frames are never requested from the page: the harness draws every frame itself.
const inert = { request: () => 1, cancel() {} };

export async function fixtures(load = (entry) => import(entry)) {
  const { redrawAfterRestore } = await load('../dist/index.js');
  const { renderOnDemand } = await load('../dist/demand.js');
  return [
    { name: 'redrawAfterRestore', create({ engine, scene }) {
      const { plugin, stop } = added(scene, () => redrawAfterRestore(engine, () => {}, inert.request));
      return { plugin, dispose: stop };
    } },
    { name: 'renderOnDemand', create({ engine, scene }) {
      const { plugin, stop: loop } = added(scene, () => renderOnDemand(engine, { update() {}, ...inert }));
      return { plugin, dispose: () => loop.dispose() };
    } },
  ];
}
