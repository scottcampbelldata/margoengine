// A Stage over an engine the app already made (README: a React Canvas's engine). Its only registration is the imports
// plugin; the app detaches it by removing that plugin from the scene it joined, which aborts pending feature loads.
export async function fixtures(load = (entry) => import(entry)) {
  const { Stage } = await load('../dist/index.js');
  return [{ name: 'Stage', create({ engine, scene }) {
    const before = new Set(scene.plugins.values());
    const stage = new Stage(engine);
    const plugin = [...scene.plugins.values()].find((p) => !before.has(p));
    return { plugin, dispose() {
      engine.sceneOf(plugin)?.removePlugin(plugin.name);
      if (!stage.signal.aborted) throw new Error('removing the stage did not abort its pending imports');
    } };
  } }];
}
