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
    HillaireSky: () => new HillaireSky(),
    VolumetricClouds: () => new VolumetricClouds(),
    Weather: () => new Weather(),
  };
  for (const [name, make] of Object.entries(standalone)) entries.push({ name, create({ engine }) {
    const plugin = make(engine);
    return { plugin, dispose: () => plugin.dispose() };
  } });
  const dependent = {
    AerialPerspective: (source) => new AerialPerspective({ sky: source, depth }),
    LightShafts: (source) => new LightShafts({ sky: source, depth }),
    AstroSky: (source) => new AstroSky({ latitude: degrees(51.5), longitude: degrees(0), sky: source }),
  };
  for (const [name, make] of Object.entries(dependent)) entries.push({ name, create({ scene, dependency }) {
    const source = needs(dependency, scene, Sky);
    const plugin = make(source);
    return { plugin, dependencies: [source], dispose: () => plugin.dispose(), cleanup: () => source.dispose() };
  } });
  entries.push({ name: 'WeatherFX', create({ scene, dependency }) {
    const source = needs(dependency, scene, Weather);
    const plugin = new WeatherFX({ weather: source });
    return { plugin, dependencies: [source], dispose: () => plugin.dispose(), cleanup: () => source.dispose() };
  } });
  return entries;
}
