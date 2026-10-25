// Margo implementation of the parity light scenes (../parity.js, area 'lights'). Units (docs/threejs-parity.md 7):
// clustered point and spot intensities are candela, area lights nits, environment ambient and hemisphere a plain
// albedo multiplier (no /pi). The three.js side maps these to its own units.
import { engineRuntime } from '@margoengine/core/extension';
import { LIGHT } from '../catalog.js';
import { app, engineFor, floor, linear, meshes, palette } from '../margo.js';

const ms = (s) => +(performance.now() - s).toFixed(1);
/** Spot positions of p-spot at t seconds: circling at 4 m, 0.3 rad/s (the camera's angular speed). */
export const spotAt = (s, t) => [Math.cos(s.phase + t * 0.3) * s.radius, 4, Math.sin(s.phase + t * 0.3) * s.radius];
const toward = (p, q = [0, 0, 0]) => {
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]],
    l = Math.hypot(...d);
  return d.map((v) => v / l);
};
/** Core's sun off (the scenes that say "only" or "no direct light"). */
const noSun = (engine) => engineRuntime(engine).lighting.direction.set([...LIGHT.direction, 0]);

async function yard(canvas, data, marks) {
  const engine = await engineFor(canvas, data.camera, data.items.length + 16, marks),
    s = performance.now();
  floor(engine, data.floor);
  meshes(engine, data, palette(data));
  return { engine, s };
}

export const builders = {
  async 'p-ambient'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { AmbientLight } = await import('@margoengine/environment');
    meshes(engine, data, palette(data));
    noSun(engine);
    AmbientLight.attach(engine, { color: '#ffffff', intensity: 1 });
    marks.buildMs = ms(s);
    return app(engine, () => {}, { camera: data.camera, note: 'environment AmbientLight only (core sun off)' });
  },

  async 'p-hemisphere'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 8, marks),
      s = performance.now(),
      { HemisphereLight } = await import('@margoengine/environment');
    meshes(engine, data, palette(data));
    HemisphereLight.attach(engine, { sky: '#bbddff', ground: '#443322', intensity: 1 });
    marks.buildMs = ms(s);
    return app(engine, () => {}, { camera: data.camera, note: 'environment HemisphereLight + core sun' });
  },

  async 'p-spot'(canvas, data, marks) {
    const { engine, s } = await yard(canvas, data, marks),
      { Clustered } = await import('@margoengine/clustered'),
      lights = Clustered.attach(engine),
      set = (t) =>
        lights.setLights(
          data.spots.map((sp) => {
            const position = spotAt(sp, t);
            return {
              position,
              direction: toward(position),
              angle: 0.5,
              penumbra: 0.3,
              range: 20,
              intensity: 30,
              color: linear(sp.color),
            };
          }),
        );
    set(0);
    marks.buildMs = ms(s);
    return app(engine, set, {
      camera: data.camera,
      note: 'clustered spot lights + core sun; light passes not counted',
    });
  },

  async 'p-rect-area'(canvas, data, marks) {
    const { engine, s } = await yard(canvas, data, marks),
      [{ Clustered }, { AreaLights }] = await Promise.all([
        import('@margoengine/clustered'),
        import('@margoengine/clustered/area'),
      ]),
      lights = Clustered.attach(engine),
      areas = AreaLights.attach(engine, { lights }),
      e = data.extent / 2;
    // 4 x 1 m panels centred 1 m up on the yard's four sides, facing the centre (width along the side).
    areas.setLights(
      [
        [e, 0],
        [-e, 0],
        [0, e],
        [0, -e],
      ].map(([x, z]) => ({
        position: [x, 1, z],
        direction: toward([x, 1, z], [0, 1, 0]),
        up: [0, 1, 0],
        width: 4,
        height: 1,
        intensity: 10,
      })),
    );
    marks.buildMs = ms(s);
    return app(engine, () => {}, { camera: data.camera, note: 'clustered AreaLights (LTC) + core sun' });
  },

  async 'p-light-probe'() {
    throw new Error(
      'unsupported: a light probe from given SH coefficients (environment LightProbes bake their SH from the scene; no API takes 9 coefficients)',
    );
  },

  async 'p-ies'(canvas, data, marks) {
    const { engine, s } = await yard(canvas, data, marks),
      [{ Clustered }, { IESLights, parseIES }] = await Promise.all([
        import('@margoengine/clustered'),
        import('@margoengine/clustered/ies'),
      ]),
      profile = parseIES(data.ies),
      lights = Clustered.attach(engine),
      ies = IESLights.attach(engine, { lights }),
      e = data.extent / 2,
      corners = [
        [e, 5, e],
        [-e, 5, e],
        [e, 5, -e],
        [-e, 5, -e],
      ];
    // Spots at the full pi / 2 (the profile spans 0-90 degrees), intensity the profile's peak candela, unlimited range.
    lights.setLights(
      corners.map((position) => ({
        position,
        direction: toward(position),
        angle: Math.PI / 2,
        penumbra: 0,
        range: 0,
        decay: 2,
        intensity: profile.peak,
      })),
    );
    ies.setProfiles(corners.map(() => profile));
    marks.buildMs = ms(s);
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'clustered IESLights (4 spots, one profile) + core sun',
    });
  },
};
