// addMesh is not here: its copy's material makes materials' 1x1 default textures on first use on a device, kept for the
// device's life (a fixed set, not a growth), and the harness counts them against the first owner.
export async function fixtures(load = (entry) => import(entry)) {
  const { OIT } = await load('../dist/index.js');
  return [false, true].map((factory) => ({ name: 'OIT' + (factory ? '.attach' : ''), create({ engine }) {
    const plugin = factory ? OIT.attach(engine) : new OIT();
    return { plugin, dispose: () => plugin.dispose() };
  } }));
}
