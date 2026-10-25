// Margo implementation of the parity helper scenes (../parity.js, area 'helpers').
import { app, engineFor, floor, meshes, palette } from '../margo.js';
import { clipName, offsetOf, robotCrowd } from './margo-animation.js';

/** Deterministic LCG, as catalog.js `random`. */
function random(seed = 1) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
/** The lights scene's moving point lights (catalog.js `lights(n, count)`, seed 11), as plain light objects. */
export function yardLights(def, count) {
  const pick = random(11),
    r = def.extent / 2;
  const orbits = Array.from({ length: count }, () => ({
    radius: r * (0.15 + 0.85 * pick()),
    phase: pick() * Math.PI * 2,
    speed: 0.2 + pick() * 0.6,
    height: 1 + pick() * 2,
  }));
  return orbits.map((o) => ({
    color: [0.4 + 0.6 * pick(), 0.4 + 0.6 * pick(), 0.4 + 0.6 * pick()],
    intensity: 6,
    range: Math.max(4, r * 0.5),
    at: (t) => [Math.cos(o.phase + t * o.speed) * o.radius, o.height, Math.sin(o.phase + t * o.speed) * o.radius],
  }));
}
// Shared look, set the same on the three side: grid 100 m / 100 divisions lifted 1 cm off the floor top (no z-fight),
// Margo's default helper colours.
export const GRID = { size: 100, divisions: 100, y: 0.01, centre: '#8f8f8f', lines: '#5e5e5e' };
export const AXES_SIZE = 5;

export const builders = {
  async 'p-helpers'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 16, marks),
      s = performance.now(),
      { Lines, GridHelper, AxesHelper, BoxHelper } = await import('@margoengine/lines');
    floor(engine, data.floor);
    const list = meshes(engine, data, palette(data)),
      lines = Lines.attach(engine),
      grid = new GridHelper({ size: GRID.size, divisions: GRID.divisions, color1: GRID.centre, color2: GRID.lines });
    grid.matrix[13] = GRID.y;
    lines.add(grid);
    lines.add(new AxesHelper({ size: AXES_SIZE }));
    for (const mesh of list) lines.add(new BoxHelper(mesh));
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: `core batches; lines: ${2 + list.length} lines, one draw each (not counted)`,
    });
  },

  async 'p-light-helpers'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 16, marks),
      s = performance.now(),
      [{ Clustered }, { Lines, PointLightHelper }] = await Promise.all([
        import('@margoengine/clustered'),
        import('@margoengine/lines'),
      ]);
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    const paths = yardLights(data, data.lights),
      list = paths.map((l) => ({ position: l.at(0), range: l.range, color: l.color, intensity: l.intensity })),
      clustered = Clustered.attach(engine),
      lines = Lines.attach(engine);
    for (const light of list) lines.add(new PointLightHelper(light, { size: 0.25 }));
    const set = (t) => {
      paths.forEach((p, i) => {
        const at = p.at(t),
          pos = list[i].position;
        pos[0] = at[0];
        pos[1] = at[1];
        pos[2] = at[2];
      });
      clustered.setLights(list);
    };
    set(0);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, set, {
      camera: data.camera,
      note: 'clustered lights; PointLightHelper is three circles (three.js draws a wireframe sphere)',
    });
  },

  async 'p-skeleton-helper'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, 4096, marks),
      s = performance.now(),
      { Lines, SkeletonHelper } = await import('@margoengine/lines'),
      { models, animations } = await robotCrowd(engine, data),
      clip = clipName(animations[0].clips, data.clip),
      lines = Lines.attach(engine);
    for (const a of animations) {
      a.play(clip);
      a.playing = false;
    }
    for (const m of models) lines.add(SkeletonHelper.fromGLTF(m));
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(
      engine,
      (t) => {
        for (let i = 0; i < animations.length; i++) animations[i].seek(t + offsetOf(i));
      },
      { camera: data.camera, note: '25 robots (cloneModel), Walking seeked per frame, SkeletonHelper.fromGLTF each' },
    );
  },

  async 'p-view-helper'(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.items.length + 16, marks),
      s = performance.now(),
      { ViewCube } = await import('@margoengine/viewcube');
    meshes(engine, data, palette(data));
    ViewCube.attach(engine, { corner: 'top-right', size: 128 });
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: 'ViewCube is DOM/CSS over the canvas (three.js ViewHelper draws into the canvas)',
    });
  },
};
