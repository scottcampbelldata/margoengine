const lights = [
  { position: [0, 1.5, 1], range: 12, color: [1, 0.3, 0.1], intensity: 20 },
  {
    position: [1.5, 3, 0],
    range: 15,
    direction: [0, -1, 0],
    innerAngle: 0.3,
    outerAngle: 0.7,
    color: [0.1, 0.3, 1],
    intensity: 30,
  },
];

export async function fixtures(load = (entry) => import(entry)) {
  const { Clustered } = await load('../dist/index.js');
  const { LightGroups } = await load('../dist/groups.js');
  const { LightBounce } = await load('../dist/bounce.js');
  const entries = [false, true].map((factory) => ({
    name: 'Clustered' + (factory ? '.attach' : ''),
    create({ engine }) {
      const plugin = factory ? Clustered.attach(engine) : new Clustered();
      if (!factory) engine.use(plugin);
      plugin.setLights(lights);
      return { plugin, dispose: () => plugin.dispose() };
    },
  }));
  // The Clustered is the caller's: the groups (and their frame callback) are the registration under test.
  entries.push({
    name: 'LightGroups',
    create({ scene, dependency }) {
      const clustered = new Clustered();
      dependency(() => scene.use(clustered));
      const plugin = new LightGroups(clustered);
      plugin.group('fire').setLights(lights.slice(0, 1));
      plugin.group('lamp').setLights(lights.slice(1));
      return { plugin, dependencies: [clustered], dispose: () => plugin.dispose(), cleanup: () => clustered.dispose() };
    },
  });
  // LightBounce: its capture pass, readback buffers and the Clustered.bounce hook are the registration under test; the
  // spot bounces (`bounce: true`) without a shadow map.
  entries.push({
    name: 'LightBounce',
    create({ scene, dependency }) {
      const clustered = new Clustered();
      dependency(() => scene.use(clustered));
      clustered.setLights(lights.map((l) => ({ ...l, bounce: true })));
      const plugin = new LightBounce({ lights: clustered, resolution: 8, vpls: 8, visibility: 8 });
      return { plugin, dependencies: [clustered], dispose: () => plugin.dispose(), cleanup: () => clustered.dispose() };
    },
  });
  return entries;
}
