// Physics holds no GPU resource: its owner state is the kernel world, the plugin's registration with the engine and the
// scene hook that syncs bodies to meshes. One entry per way a world is made, each with the pieces that hold rows in it.
export async function fixtures(load = (entry) => import(entry)) {
  const { Physics, Rope, Vehicle, Multibody } = await load('../dist/index.js');
  await Physics.load();
  const fill = (physics) => {
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [5, 0.5, 5] },
    });
    const a = physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'sphere', radius: 0.5 } });
    const b = physics.addBody(null, {
      position: [1.5, 2, 0],
      colliders: { shape: 'box', halfExtents: [0.4, 0.4, 0.4] },
    });
    physics.addJoint(a, b, { type: 'spherical', anchorA: [0.75, 0, 0], anchorB: [-0.75, 0, 0] });
    physics.step();
    return physics;
  };
  const entries = [];
  const own = (name, make) =>
    entries.push({
      name,
      create({ engine }) {
        const plugin = make(engine);
        return { plugin, dispose: () => plugin.dispose() };
      },
    });
  own('Physics', (engine) => fill(new Physics(engine)));
  own('Physics.attach', (engine) => fill(Physics.attach(engine)));
  own('Physics.attach with a rope and a multibody', (engine) => {
    const physics = fill(Physics.attach(engine));
    new Rope(physics, { start: [0, 3, 0], end: [2, 3, 0], segments: 4 });
    const multibody = new Multibody(physics, {
      links: [{ shape: { shape: 'box', halfExtents: [0.2, 0.2, 0.2] }, joint: { type: 'revolute', axis: [0, 0, 1] } }],
    });
    void multibody;
    physics.step();
    return physics;
  });
  own('Physics.attach with a vehicle', (engine) => {
    const physics = fill(Physics.attach(engine));
    const chassis = physics.addBody(null, {
      position: [0, 1, 3],
      colliders: { shape: 'box', halfExtents: [0.8, 0.2, 1.4] },
    });
    new Vehicle(physics, chassis, {
      wheels: [
        { position: [-0.8, -0.2, 1], radius: 0.3 },
        { position: [0.8, -0.2, 1], radius: 0.3 },
        { position: [-0.8, -0.2, -1], radius: 0.3 },
        { position: [0.8, -0.2, -1], radius: 0.3 },
      ],
    });
    physics.step();
    return physics;
  });
  return entries;
}
