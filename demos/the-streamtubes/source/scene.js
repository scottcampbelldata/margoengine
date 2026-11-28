import { PbrMaterial, box } from '@margoengine/core';
import { toGeometry } from '@margoengine/geometry';
import { chamferBoxGeometry, wingGeometry } from '@margoengine/geometry/parts';
import { Material, createMesh } from '@margoengine/materials';
import { applyQualityTier } from '@margoengine/quality';
import { openBench } from '@margoengine/studio/bench';
import { startEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { flowEnd, flowStart, paths, wake } from './field.js';

const id = (name) => document.getElementById(name);
const canvas = id('view'),
  tools = id('tools'),
  notice = id('status'),
  slider = id('thickness'),
  state = document.body.dataset;
const buttons = [...tools.querySelectorAll('[data-group]')],
  views = [...tools.querySelectorAll('[data-view]')];
const controller = new AbortController(),
  { signal } = controller;
const status = demoStatus(document.body, notice, id('error'));
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
// Camera presets around the middle of the wake, [azimuth from +z, elevation] in radians.
const cameras = {
  three: { angles: [-0.28, 0.51], title: 'Oblique view' },
  top: { angles: [0, 1.5], title: 'Overhead view' },
  end: { angles: [Math.PI * 0.5, 0.14], title: 'Downstream view' },
};
const target = [0.25, 0.04, 0];
let bench, tubes, group = 0, multiplier = 1;

function showWake() {
  const geometry = wake(0.047 * multiplier, group);
  if (tubes) tubes.setGeometry(geometry);
  else {
    // Satin plastic tubes: the vertex colour carries the speed, the sheen shows the twist.
    tubes = createMesh(bench.engine, geometry, new Material({ roughness: 0.32, metalness: 0, clearcoat: 0.4 }));
    bench.add(tubes);
  }
  const visible = paths.filter((path) => !group || path.side === group),
    speeds = visible.flatMap((path) => [...path.scalar]),
    faces = geometry.indices.length / 3;
  id('count').value = String(visible.length);
  id('triangles').value = number.format(faces);
  id('speed').value = Math.min(...speeds).toFixed(2) + '–' + Math.max(...speeds).toFixed(2);
  id('multiplier').value = multiplier.toFixed(2) + '×';
  Object.assign(state, { multiplier: String(multiplier), group: String(group), activeTubes: String(visible.length), triangles: String(faces) });
  for (const button of buttons) button.setAttribute('aria-pressed', String(Number(button.dataset.group) === group));
  bench.request();
}

function changeView(name) {
  const { angles, title } = cameras[name],
    reach = Math.max(11.6, 13.9 / (canvas.clientWidth / Math.max(1, canvas.clientHeight))),
    level = reach * Math.cos(angles[1]);
  bench.engine.camera.position = [target[0] + Math.sin(angles[0]) * level, target[1] + Math.sin(angles[1]) * reach, Math.cos(angles[0]) * level];
  bench.engine.camera.target = target;
  bench.orbit.target = target;
  id('angle').textContent = title;
  state.view = name;
  for (const button of views) button.setAttribute('aria-pressed', String(button.dataset.view === name));
  bench.request();
}

function buildTunnel(engine) {
  const place = (geometry, material, where) => {
    const mesh = engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(where);
    bench.add(mesh);
    return mesh;
  };
  const paint = (color, roughness, metalness) => new PbrMaterial({ color, roughness, metalness });
  const alloy = paint('#8fa3a8', 0.28, 0.85),
    plinth = paint('#2d3a42', 0.6, 0.1),
    deck = paint('#3c4b54', 0.82, 0.05),
    tape = paint('#c9d6d4', 0.5, 0.05),
    brass = paint('#c8a36b', 0.35, 0.9);
  place(box(175, 0.12, 175), paint('#26333b', 0.9, 0.02), [0, -0.97, 0]);
  place(toGeometry(chamferBoxGeometry(10.18, 0.36, 5.28, { chamfer: 0.04 })), plinth, [0.23, -0.76, 0]);
  place(toGeometry(chamferBoxGeometry(10.02, 0.027, 5.09, { chamfer: 0.008 })), alloy, [0.23, -0.566, 0]);
  place(toGeometry(chamferBoxGeometry(9.88, 0.032, 4.96, { chamfer: 0.01 })), deck, [0.23, -0.547, 0]);
  // A NACA 0013 wing, 3.05 wide, chord 1.48 at the root tapering to 0.99 with a gentle sweep and dihedral.
  const wing = wingGeometry({ span: 3.05, rootChord: 1.48, tipChord: 0.99, thickness: 0.134, sweep: 0.44, dihedral: 0.09, curve: 2, sections: 64, stations: 40 });
  place(toGeometry(wing), alloy, [-3.96, 0.58, 0]);
  for (const side of [-1, 1]) {
    place(toGeometry(chamferBoxGeometry(0.15, 1.1, 0.2, { chamfer: 0.02 })), alloy, [-3.33, 0.01, side * 0.46]);
    place(toGeometry(chamferBoxGeometry(0.75, 0.065, 0.65, { chamfer: 0.012 })), plinth, [-3.36, -0.495, side * 0.46]);
    place(box(0.5, 0.047, 0.43), alloy, [-3.36, -0.459, side * 0.46]);
    for (const x of [-3.62, -3.13]) for (const z of [-0.19, 0.19]) place(box(0.053, 0.025, 0.065), brass, [x, -0.435, side * 0.46 + z]);
    for (let station = 0; station < 16; station++)
      place(box(station % 2 ? 0.027 : 0.052, 0.015, station % 2 ? 0.105 : 0.17), tape, [-4.2 + station * 0.55, -0.521, side * 2.19]);
  }
  for (let i = 0; i < 4; i++) place(box(0.024, 0.009, 3.84), tape, [flowStart + ((flowEnd - flowStart) * i) / 3, -0.521, 0]);
}

function fail(error) {
  if (signal.aborted) return;
  status.error(error);
  notice.hidden = true;
  id('error').hidden = false;
  tools.disabled = true;
  console.error(error);
  controller.abort();
}

async function open() {
  applyQualityTier();
  bench = await openBench(canvas, {
    start: startEngine,
    loadCompat: () => import('@margoengine/webgl2-compat'),
    signal,
    exhibit: document.body,
    background: '#1f2a31',
    camera: { position: [-3.2, 6.2, 9.9], target, fov: 41, near: 0.1, far: 120 },
    light: { direction: [-0.38, 0.85, 0.36], intensity: 3.2 },
    environment: { preset: 'tent', intensity: 0.55 },
    backdrop: false,
    contact: { size: 12, height: 1.6, opacity: 0.55, blur: 0.15, position: [0.23, -0.53, 0] },
    ao: true,
    orbit: { minDistance: 4, maxDistance: 24 },
    onError: fail,
  });
  buildTunnel(bench.engine);
  showWake();
  changeView('three');
  slider.addEventListener('input', () => ((multiplier = slider.valueAsNumber), showWake()), { signal });
  for (const button of buttons)
    button.addEventListener('click', () => ((group = Number(button.dataset.group)), showWake()), { signal });
  for (const button of views) button.addEventListener('click', () => changeView(button.dataset.view), { signal });
  canvas.addEventListener('pointerdown', () => {
    id('angle').textContent = 'Orbit view';
    state.view = 'custom';
    for (const button of views) button.setAttribute('aria-pressed', 'false');
  }, { signal });
  if (!(await bench.ready()) || !status.ready()) return;
  notice.hidden = true;
  tools.disabled = false;
  performance.mark('margo-first-usable-frame');
}

open().catch(fail);
