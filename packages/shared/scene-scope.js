let serial = 0;
const unique = (engine, base) => {
  let name = base + serial++;
  while (engine.plugins?.has(name)) name += ':';
  return name;
};

/**
 * The scene set up or drawn right now (the default scene otherwise), kept for work that finishes after an await. Call it
 * before the first await of a loader; `run(work)` then calls `work` with that scene active, so the meshes and plugins it
 * makes belong to it and not to whatever scene is active when the load finishes.
 */
export function captureScene(engine) {
  let scene;
  if (typeof engine?.sceneOf === 'function') {
    // The active scene's plugins all map back to it; with none, a probe plugin learns it from the engine.
    for (const plugin of engine.plugins?.values() ?? []) if ((scene = engine.sceneOf(plugin))) break;
    if (!scene) {
      const probe = {
        name: unique(engine, 'scene-scope:'),
        setup() {
          scene = engine.sceneOf(probe);
        },
      };
      engine.use(probe);
      engine.removePlugin(probe.name);
    }
  }
  return sceneScope(engine, scene);
}

/**
 * A scope over `scene` itself, for work that belongs to a scene known from an object (the scene a plugin or model is in)
 * and not from the scene active now. With no scene, `run` just calls the work.
 */
export function sceneScope(engine, scene) {
  return {
    scene,
    run(work) {
      if (!scene) return work();
      let result;
      const scope = {
        name: unique(engine, 'scene-scope:'),
        setup() {
          result = work();
        },
      };
      scene.use(scope);
      scene.removePlugin(scope.name);
      return result;
    },
  };
}
