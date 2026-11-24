// Owner/lifetime fixture for @margoengine/tonemap: the Tonemap plugin as an app attaches it, alone (constructor and
// attach), with every built-in effect and auto exposure, with a Cube LUT, and with each extension (Grade, HueGrade,
// CustomCurve in WGSL and as a sampled function, LocalExposure), which add their own buffers and textures to the plugin,
// with a Grade and a HueGrade in one list (KB-OWN-TONE2) and with a WGSL curve that ignores curveParams (KB-OWN-TONE3).
// Not entries: parseCube, validateLUT, exportCube, sampleCurve, whiteBalanceGain and the shader builders are pure
// functions of their input; an extension is owned by the Tonemap it is given to and has no registration of its own.
const identityLUT = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';

export async function fixtures(load = (entry) => import(entry)) {
  const { Tonemap } = await load('../dist/index.js');
  const { Grade } = await load('../dist/grade.js');
  const { HueGrade } = await load('../dist/hue.js');
  const { CustomCurve } = await load('../dist/custom.js');
  const { LocalExposure } = await load('../dist/local.js');
  const entry = (name, make) => ({
    name,
    create({ engine }) {
      const plugin = make(engine);
      return { plugin, dispose: () => plugin.dispose() };
    },
  });
  const effects = {
    curve: 'agx',
    exposure: 0.5,
    contrast: 1.1,
    temperature: 5000,
    tint: 0.1,
    vignette: 0.3,
    grain: 0.05,
    chromaticAberration: 0.5,
    autoExposure: true,
  };
  return [
    entry('Tonemap', () => new Tonemap()),
    entry('Tonemap.attach', (engine) => Tonemap.attach(engine)),
    entry('Tonemap.effects', (engine) => Tonemap.attach(engine, effects)),
    entry('Tonemap.setLUT', (engine) => {
      const tonemap = Tonemap.attach(engine);
      tonemap.setLUT(identityLUT);
      return tonemap;
    }),
    entry('Tonemap.Grade', (engine) => Tonemap.attach(engine, { extensions: [new Grade({ saturation: 1.2 })] })),
    entry('Tonemap.HueGrade', (engine) => Tonemap.attach(engine, { extensions: [new HueGrade()] })),
    entry('Tonemap.Grade+HueGrade', (engine) =>
      Tonemap.attach(engine, { extensions: [new Grade({ shadows: [0.05, 0, 0] }), new HueGrade({ hueShift: 20 })] })),
    entry('Tonemap.CustomCurve.wgsl', (engine) =>
      Tonemap.attach(engine, { extensions: [new CustomCurve({ wgsl: 'fn film(x: vec3f) -> vec3f { return x / (x + vec3f(curveParams[0].x)); }', params: [1] })] })),
    entry('Tonemap.CustomCurve.wgsl-no-params', (engine) =>
      Tonemap.attach(engine, { extensions: [new CustomCurve({ wgsl: 'fn reinhard(x: vec3f) -> vec3f { return x / (x + vec3f(1.0)); }' })] })),
    entry('Tonemap.CustomCurve.sampled', (engine) =>
      Tonemap.attach(engine, { extensions: [new CustomCurve({ curve: (x) => x / (x + 1) })] })),
    entry('Tonemap.LocalExposure', (engine) => Tonemap.attach(engine, { extensions: [new LocalExposure()] })),
  ];
}
