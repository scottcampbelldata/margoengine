// Margo implementation of the parity shadow scenes (../parity.js, area 'shadows'): @margoengine/shadows for the
// directional cascades, clustered LocalShadows for point and spot lights. The spec leaves the local lights' paths,
// spot positions and intensity open; both engines use the values written here (see info().note).
import { app, engineFor, floor, meshes, palette } from '../margo.js';

const ms = (s) => +(performance.now() - s).toFixed(1);
const toward = (p, q = [0, 0, 0]) => {
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]],
    l = Math.hypot(...d);
  return d.map((v) => v / l);
};
/** p-point-shadows: light i circles at radius 8, 3 m high, 0.3 rad/s, a quarter turn apart. */
const pointAt = (i, t) => {
  const a = (i * Math.PI) / 2 + t * 0.3;
  return [Math.cos(a) * 8, 3, Math.sin(a) * 8];
};
/** p-spot-shadows: four static spots 8 m high over the yard's quarter points, aiming at the centre, 60 cd. */
const SPOTS = [
  [10, 8, 10],
  [-10, 8, 10],
  [10, 8, -10],
  [-10, 8, -10],
];

async function yard(canvas, data, marks) {
  const engine = await engineFor(canvas, data.camera, data.items.length + 16, marks),
    s = performance.now(),
    ground = floor(engine, data.floor),
    list = meshes(engine, data, palette(data));
  return { engine, s, casters: [ground, ...list] };
}

async function local(engine, resolution) {
  const [{ Clustered }, { LocalShadows }] = await Promise.all([
      import('@margoengine/clustered'),
      import('@margoengine/clustered/shadows'),
    ]),
    lights = Clustered.attach(engine);
  return { lights, shadows: LocalShadows.attach(engine, { lights, resolution, maxLights: 4 }) };
}

export const builders = {
  async 'p-csm'(canvas, data, marks) {
    const { engine, s, casters } = await yard(canvas, data, marks),
      { Shadows } = await import('@margoengine/shadows'),
      shadows = Shadows.attach(engine, {
        resolution: data.resolution,
        cascades: data.cascades,
        lambda: 0.5,
        distance: data.far,
        filter: 'pcf',
      });
    shadows.add(casters[0], { static: true });
    for (const mesh of casters.slice(1)) shadows.add(mesh);
    marks.buildMs = ms(s);
    return app(engine, () => {}, {
      camera: data.camera,
      note: "Shadows: 4 cascades, lambda 0.5, out to 100, filter 'pcf' (4 bilinear comparison taps); shadow passes not counted",
    });
  },

  async 'p-point-shadows'(canvas, data, marks) {
    const { engine, s, casters } = await yard(canvas, data, marks),
      { lights, shadows } = await local(engine, 512);
    for (const mesh of casters) shadows.add(mesh);
    const set = (t) =>
      lights.setLights(
        [0, 1, 2, 3].map((i) => ({ position: pointAt(i, t), range: 15, decay: 2, intensity: 40, castShadow: true })),
      );
    set(0);
    marks.buildMs = ms(s);
    return app(engine, set, {
      camera: data.camera,
      note: '4 clustered point lights circling r=8 at 0.3 rad/s, LocalShadows 512 cubes (3x3 PCF) + core sun',
    });
  },

  async 'p-spot-shadows'(canvas, data, marks) {
    const { engine, s, casters } = await yard(canvas, data, marks),
      { lights, shadows } = await local(engine, 1024);
    for (const mesh of casters) shadows.add(mesh);
    lights.setLights(
      SPOTS.map((position) => ({
        position,
        direction: toward(position),
        angle: 0.6,
        penumbra: 0.2,
        range: 30,
        decay: 2,
        intensity: 60,
        castShadow: true,
      })),
    );
    marks.buildMs = ms(s);
    return app(engine, () => {}, {
      camera: data.camera,
      note: '4 static clustered spots (60 cd, from (+-10, 8, +-10) at the centre), LocalShadows 1024 (3x3 PCF) + core sun',
    });
  },
};
