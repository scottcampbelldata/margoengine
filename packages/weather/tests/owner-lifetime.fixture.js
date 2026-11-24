// Owner/lifetime fixture for @margoengine/weather: every plugin an app attaches, through its constructor and its attach:
// Hail, Puddles, Snow (plain, and drawing a SnowDrift field, which adds its own uniform and map), GLTFWeather, LensDrops
// (which makes a PostStack for itself when the scene has none), WeatherDrive, WeatherAudio (on a fake audio context),
// AvalancheScatter (the plant maps of an Avalanche) and Snow drawing an Avalanche.
// Not entries: WeatherMachine, WeatherRegions, SnowDrift, Avalanche, Eruption (it only adds clouds to a Clouds it is given), LavaFlow (it only writes into the lights and instances it is given), WindField and FuelMoistureModel are plain models with no
// engine registration, GPU resource or listener (a drive or a hook reads them); the settings rows and the maths are pure
// functions of their input. PrecipitationCover takes over a vfx WeatherFX capture and is checked with vfx.
import { FakeAudioContext } from '../../audio/tests/fake-web-audio.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { WeatherMachine } = await load('../dist/index.js');
  const { Hail } = await load('../dist/hail.js');
  const { Puddles } = await load('../dist/puddles.js');
  const { Snow } = await load('../dist/snow.js');
  const { SnowDrift } = await load('../dist/snow-drift.js');
  const { GLTFWeather } = await load('../dist/gltf.js');
  const { LensDrops } = await load('../dist/lens.js');
  const { WeatherDrive } = await load('../dist/drive.js');
  const { WeatherAudio } = await load('../dist/audio.js');
  const { AudioListener } = await load('../../audio/dist/index.js');
  const { Avalanche, AvalancheScatter } = await load('../dist/avalanche.js');
  const ground = new Float32Array(16 * 16).map((_, k) => Math.max(0, 4 - Math.abs((k % 16) - 8)));
  const drift = () => new SnowDrift({ width: 16, depth: 16, ground, initialDepth: 0.3 });
  const entries = [];
  const own = (name, make) =>
    entries.push({
      name,
      async create({ engine }) {
        const plugin = await make(engine);
        return { plugin, dispose: () => plugin.dispose() };
      },
    });
  own('Hail', () => new Hail({ intensity: 0.5 }));
  own('Hail.attach', (engine) => Hail.attach(engine, { intensity: 0.5 }));
  own('Puddles', () => new Puddles({ wetness: 0.8 }));
  own('Puddles.attach', (engine) => Puddles.attach(engine, { wetness: 0.8 }));
  own('Snow', () => new Snow({ cover: 0.7 }));
  own('Snow.attach', (engine) => Snow.attach(engine, { cover: 0.7 }));
  own('Snow.field', () => new Snow({ field: drift() }));
  own('Snow.attach.field', (engine) => Snow.attach(engine, { field: drift(), band: 0.1 }));
  own('GLTFWeather', () => new GLTFWeather({ puddles: { wetness: 0.5 }, snow: { cover: 0.5 } }));
  own('GLTFWeather.attach', (engine) => GLTFWeather.attach(engine, { puddles: { wetness: 0.5 }, snow: { cover: 0.5 } }));
  // An avalanche is a plain model; its scatter maps are GPU textures the plugin owns. Snow drawing it is a Snow field.
  const slide = () => new Avalanche({ width: 8, depth: 8, ground: new Float32Array(64).map((_, k) => -(k >> 3)), release: { at: [3, 3] } });
  own('AvalancheScatter', () => new AvalancheScatter(slide()));
  own('AvalancheScatter.attach', (engine) => {
    const s = AvalancheScatter.attach(engine, slide());
    s.heightmap();
    return s;
  });
  own('Snow.attach.avalanche', (engine) => Snow.attach(engine, { field: slide() }));
  own('LensDrops.attach', (engine) => LensDrops.attach(engine, { wetness: 0.6 }));
  // The drive and the sounds follow a machine the app owns: it goes after them, as an app would let it go.
  entries.push({
    name: 'WeatherDrive.attach',
    create({ engine }) {
      const weather = new WeatherMachine();
      const plugin = WeatherDrive.attach(engine, { weather });
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => weather.dispose() };
    },
  });
  entries.push({
    name: 'WeatherAudio.attach',
    async create({ engine, scene, dependency }) {
      // The gesture listeners of autoResume go on the canvas document's window; the Node canvas has none.
      if (!engine.canvas.ownerDocument) engine.canvas.ownerDocument = { defaultView: new EventTarget() };
      const weather = new WeatherMachine();
      // The listener is the app's, installed by the caller: a dependency the sounds play through.
      const listener = await dependency(() => AudioListener.attach(engine, { context: new FakeAudioContext() }));
      // Attach in the owner's scene: the fixture's own await already returned the engine to its active scene.
      let plugin;
      const scope = { name: 'owner-lifetime:weather-audio', setup() { plugin = WeatherAudio.attach(engine, listener, { weather }); } };
      scene.use(scope);
      scene.removePlugin(scope.name);
      return {
        plugin,
        dependencies: [listener],
        dispose: () => plugin.dispose(),
        cleanup: () => {
          listener.dispose();
          weather.dispose();
        },
      };
    },
  });
  return entries;
}
