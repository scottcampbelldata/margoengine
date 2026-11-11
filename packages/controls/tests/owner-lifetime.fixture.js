export async function fixtures(load = (entry) => import(entry)) {
  const controls = await load('../dist/index.js');
  const { WalkControls } = await load('../dist/walk.js');
  const { ThirdPersonControls } = await load('../dist/third-person.js');
  return [
    ...['OrbitControls', 'MapControls', 'TrackballControls', 'ArcballControls', 'FlyControls',
      'FirstPersonControls', 'PointerLockControls', 'TransformControls'].map((name) => [name, controls[name]]),
    ['WalkControls', WalkControls], ['ThirdPersonControls', ThirdPersonControls],
  ].map(([name, Control]) => ({
    name,
    create({ engine, scene }) {
      const before = new Set(scene.plugins.values());
      const control = name === 'ThirdPersonControls' ? new Control(engine, () => [0, 0, 0]) : new Control(engine);
      const plugin = [...scene.plugins.values()].find((p) => !before.has(p));
      return { plugin, dispose: () => control.dispose() };
    },
  }));
}
