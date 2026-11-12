export async function fixtures(load = (entry) => import(entry)) {
  const { CameraProjection } = await load('../dist/index.js');
  return [false, true].map((factory) => ({ name: 'CameraProjection' + (factory ? '.attach' : ''), create({ engine }) {
    const options = { mode: 'orthographic', height: 10 };
    const plugin = factory ? CameraProjection.attach(engine, options) : new CameraProjection(options);
    return { plugin, dispose: () => plugin.dispose() };
  } }));
}
