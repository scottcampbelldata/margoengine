// Clouds and BlownSand are one plugin each with no dependency: the handle is the plugin itself. Smoke's handle is
// its puffs' VFX; Flame (one ray-marched volume) and FireFront (with no smoke columns or flame volumes) are their own plugins.
// Fire attaches three particle effects and lights a Clustered it is given; its flames are the handle, the Clustered
// is the caller's and is left empty. Battery (cannon fire) and HullFire are their own plugins: their banks, flashes,
// flames and smoke columns are plugins they attach and dispose, and their lights a LightGroups group they own.
export async function fixtures(load = (entry) => import(entry)) {
  const { Fire } = await load('../dist/fire.js');
  const { Clustered } = await load('../../clustered/dist/index.js');
  const { Clouds } = await load('../dist/clouds.js');
  const { BlownSand } = await load('../dist/blown-sand.js');
  const { Smoke } = await load('../dist/smoke.js');
  const { FireFront } = await load('../dist/fire-front.js');
  const { Flame } = await load('../dist/flame.js');
  const { Battery, HullFire } = await load('../dist/gunfire.js');
  const { GPUFlock } = await load('../dist/flocking.js');
  return [
    {
      name: 'Clouds.attach',
      create({ engine }) {
        const clouds = Clouds.attach(engine);
        clouds.add({ segments: 6 });
        return { plugin: clouds, dispose: () => clouds.dispose() };
      },
    },
    {
      name: 'BlownSand.attach',
      create({ engine }) {
        const sand = BlownSand.attach(engine, { ground: () => 0, wind: { speed: 12, direction: 0 } });
        return { plugin: sand, dispose: () => sand.dispose() };
      },
    },
    {
      name: 'Smoke.attach',
      create({ engine }) {
        const smoke = Smoke.attach(engine, { position: [0, 0, 0], lifetime: 4, rate: 10 });
        return { plugin: smoke.effect, dispose: () => smoke.dispose() };
      },
    },
    {
      name: 'Flame.attach',
      create({ engine }) {
        const flame = Flame.attach(engine, { position: [0, 0, 0], length: 4 });
        return { plugin: flame, dispose: () => flame.dispose() };
      },
    },
    {
      name: 'FireFront.attach',
      create({ engine }) {
        const front = FireFront.attach(engine, {
          size: [64, 64],
          cell: 4,
          columns: 0,
          flames: 0,
          buildingFlames: 0,
          ignitions: [{ at: [0, 0] }],
        });
        return { plugin: front, dispose: () => front.dispose() };
      },
    },
    {
      name: 'Fire.attach',
      create({ engine, dependency }) {
        const clustered = new Clustered();
        dependency(() => engine.use(clustered));
        const fire = Fire.attach(engine, {
          position: [0, 0.2, 0],
          lights: clustered,
          castShadow: false,
          steam: [0.4, 0.6, 0],
        });
        return {
          plugin: fire.particles.flames,
          dependencies: [clustered],
          dispose: () => fire.dispose(),
          cleanup: () => clustered.dispose(),
        };
      },
    },
    {
      name: 'Battery.attach',
      create({ engine }) {
        const battery = Battery.attach(engine, {
          guns: [{ position: [0, 3, 0], direction: [1, 0, 0] }],
          shots: [{ gun: 0, time: 0 }],
          banks: 2,
          puffs: 4,
        });
        return { plugin: battery, dispose: () => battery.dispose() };
      },
    },
    {
      name: 'HullFire.attach',
      create({ engine }) {
        const fire = HullFire.attach(engine, {
          ship: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          ports: [{ position: [6.5, 3, 0] }],
          flames: 2,
          columns: 1,
        });
        return { plugin: fire, dispose: () => fire.dispose() };
      },
    },
    {
      name: 'GPUFlock.attach',
      create({ engine }) {
        const flock = GPUFlock.attach(engine, { count: 64 });
        return { plugin: flock, dispose: () => flock.dispose() };
      },
    },
  ];
}
