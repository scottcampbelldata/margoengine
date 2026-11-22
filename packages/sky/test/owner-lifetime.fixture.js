// The day presets, scene kits and sky maths hold nothing with a lifetime; SkyMoon, PresetScene and the night-sky layers
// (MilkyWay, Aurora, Moon) are entries as well as the sky and its features.
// check:owners runs one browser leaf per entry: the night-sky layers and SkyMoon that came over from scenery took the
// fixture to 19 entries (247 cases), past the 208 cases a single leaf holds inside its 180 s limit, which never rises.
export const leafPerEntry = true;
// A 4 x 2 lunar map: bright maria-free highlands on the left, darker on the right.
const albedo = () => ({
  width: 4,
  height: 2,
  data: new Uint8Array(32).map((_, i) => (i % 4 === 3 ? 255 : (i >> 2) % 4 < 2 ? 200 : 120)),
});

export async function fixtures(load = (entry) => import(entry)) {
  const { Sky } = await load('../dist/index.js');
  const { AerialPerspective } = await load('../dist/aerial.js');
  const { AstroSky } = await load('../dist/astro.js');
  const { HillaireSky } = await load('../dist/hillaire.js');
  const { LightShafts } = await load('../dist/shafts.js');
  const { VolumetricClouds } = await load('../dist/volumetric-clouds.js');
  const { Weather } = await load('../dist/weather.js');
  const { WeatherFX } = await load('../dist/weather-fx.js');
  const { degrees } = await load('../dist/sun.js');
  const { SkyMoon } = await load('../dist/night-preset.js');
  const { PresetScene } = await load('../dist/scenes.js');
  const { MilkyWay } = await load('../dist/milky-way.js');
  const { Aurora } = await load('../dist/aurora.js');
  const { Moon } = await load('../dist/moon.js');
  const depth = () => undefined;
  // A plugin another fixture entry reads from: installed by the caller, so it counts as a dependency.
  const needs = (dependency, scene, Source, ...args) => {
    const source = new Source(...args);
    dependency(() => scene.use(source));
    return source;
  };
  const entries = [];
  const standalone = {
    Sky: (engine) => Sky.attach(engine),
    // The opt-in coverage record owns two more textures (resolved and multisampled), freed by dispose.
    SkyCoverage: (engine) => Sky.attach(engine, { coverage: true }),
    HillaireSky: () => new HillaireSky(),
    VolumetricClouds: () => new VolumetricClouds(),
    Weather: () => new Weather(),
  };
  for (const [name, make] of Object.entries(standalone))
    entries.push({
      name,
      create({ engine }) {
        const plugin = make(engine);
        return { plugin, dispose: () => plugin.dispose() };
      },
    });
  const dependent = {
    AerialPerspective: (source) => new AerialPerspective({ sky: source, depth }),
    LightShafts: (source) => new LightShafts({ sky: source, depth }),
    AstroSky: (source) => new AstroSky({ latitude: degrees(51.5), longitude: degrees(0), sky: source }),
  };
  for (const [name, make] of Object.entries(dependent))
    entries.push({
      name,
      create({ scene, dependency }) {
        const source = needs(dependency, scene, Sky);
        const plugin = make(source);
        return { plugin, dependencies: [source], dispose: () => plugin.dispose(), cleanup: () => source.dispose() };
      },
    });
  entries.push({
    name: 'WeatherFX',
    create({ scene, dependency }) {
      const source = needs(dependency, scene, Weather);
      const plugin = new WeatherFX({ weather: source });
      return { plugin, dependencies: [source], dispose: () => plugin.dispose(), cleanup: () => source.dispose() };
    },
  });
  const observer = () => ({ latitude: degrees(47), longitude: degrees(8) });
  for (const factory of [false, true]) {
    const suffix = factory ? '.attach' : '';
    const pick = (Kind, options) => (engine) => (factory ? Kind.attach(engine, options) : new Kind(options));
    for (const [name, make] of [
      ['SkyMoon', pick(SkyMoon, { moonDirection: [0.45, 0, -1], moonPhase: 0.85 })],
      ['MilkyWay', pick(MilkyWay, observer())],
      ['Aurora', pick(Aurora, { intensity: 100, red: 0.5 })],
      ['Moon', pick(Moon, { albedo: albedo() })],
    ])
      entries.push({
        name: name + suffix,
        create({ engine }) {
          const plugin = make(engine);
          return { plugin, dispose: () => plugin.dispose() };
        },
      });
  }
  // PresetScene attaches a sky and a post stack (bloom and tonemap); it is no plugin itself, its sky is the handle.
  for (const name of ['goldenHour', 'noon'])
    entries.push({
      name: 'PresetScene.attach ' + name,
      create({ engine }) {
        const scene = PresetScene.attach(engine, name);
        scene.set('overcast');
        return { plugin: scene.sky, dispose: () => scene.dispose() };
      },
    });
  return entries;
}
