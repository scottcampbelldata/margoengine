export async function fixtures(load = (entry) => import(entry)) {
  const { DOF } = await load('../dist/index.js');
  return [false, true].map((factory) => ({ name: 'DOF' + (factory ? '.attach' : ''), create({ engine }) {
    const plugin = factory ? DOF.attach(engine, { focalDistance: 5 }) : new DOF({ focalDistance: 5 });
    return { plugin, dispose: () => plugin.dispose() };
  } }));
}
