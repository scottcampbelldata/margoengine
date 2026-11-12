const lights = [
  { position: [0, 1.5, 1], range: 12, color: [1, 0.3, 0.1], intensity: 20 },
  { position: [1.5, 3, 0], range: 15, direction: [0, -1, 0], innerAngle: 0.3, outerAngle: 0.7, color: [0.1, 0.3, 1],
    intensity: 30 },
];

export async function fixtures(load = (entry) => import(entry)) {
  const { Clustered } = await load('../dist/index.js');
  return [false, true].map((factory) => ({ name: 'Clustered' + (factory ? '.attach' : ''), create({ engine }) {
    const plugin = factory ? Clustered.attach(engine) : new Clustered();
    if (!factory) engine.use(plugin);
    plugin.setLights(lights);
    return { plugin, dispose: () => plugin.dispose() };
  } }));
}
