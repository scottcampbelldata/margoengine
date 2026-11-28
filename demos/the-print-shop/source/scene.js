import { Geometry, PbrMaterial } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf';
import { meshopt } from '@margoengine/gltf/meshopt';
import { quantized } from '@margoengine/gltf/quantized';
import { parseGCode, toolpathBeads } from '@margoengine/loaders/gcode';
import { CadBench } from '@margoengine/machinery/bench';
import { applyQualityTier } from '@margoengine/quality';
import { openBench } from '@margoengine/studio/bench';
import { startEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import facts from './facts.json';

const id = (name) => document.getElementById(name);
const canvas = id('scene'), slider = id('layer'), sizes = id('sizes'), travels = id('travel'), play = id('play');
const state = demoStatus(document.body, id('status'), id('error'));
const controller = new AbortController();
const { signal } = controller;
const modelFiles = [
  new URL('./assets/kite-8.3mf', import.meta.url), new URL('./assets/kite-11.3mf', import.meta.url), new URL('./assets/kite-14.3mf', import.meta.url),
];
const programs = [
  new URL('./assets/kite-8.gcode', import.meta.url), new URL('./assets/kite-11.gcode', import.meta.url), new URL('./assets/kite-14.gcode', import.meta.url),
];
// The surface plate stands in for the print bed: 4 cm thick on the floor. The finished jig sits on the left, the
// toolpaths of its G-code print on the right at their real size (the file is in millimetres, centred on 60, 60).
const plate = 0.04, solidX = -0.05, printX = 0.05, layerRate = 0.29;
// A 0.4 mm nozzle lays 0.45 mm lines 0.28 mm tall; travel moves draw as thin threads.
const bead = { width: 0.45, height: 0.28 }, thread = { width: 0.12, height: 0.12 };
const materials = {
  // Orange PLA, a glossy dielectric plastic; the layer being printed is lighter so it reads against the rest.
  printed: new PbrMaterial({ color: '#b5622c', roughness: 0.5, metalness: 0 }),
  active: new PbrMaterial({ color: '#e9a640', roughness: 0.45, metalness: 0 }),
  travel: new PbrMaterial({ color: '#3f8aa6', roughness: 0.6, metalness: 0 }),
};
const paths = new Map();
let bench, solids, part = 0, layer = 0, playing = false, since = 0, stopFrame;

// One mesh per layer for its beads and one for its travel, built once per part when its G-code is first shown.
function toolpaths(index) {
  if (paths.has(index)) return paths.get(index);
  const pending = (async () => {
    const response = await fetch(programs[index], { signal });
    if (!response.ok) throw Error('The G-code could not load.');
    const { layers } = parseGCode(await response.text());
    const mesh = (segments, size, material) => {
      const { positions, normals, indices } = toolpathBeads(segments, size);
      const made = bench.engine.createMesh().setGeometry(new Geometry(positions, normals, indices)).setMaterial(material);
      // Machine millimetres, Z up, to bench metres, Y up: scale, turn -90 degrees about X, move the file's centre over.
      made.setScale([0.001, 0.001, 0.001]).setRotation([-Math.PI / 2, 0, 0]).setPosition([printX - 0.06, plate, 0.06]);
      made.visible = false;
      bench.add(made, { contact: false, fit: false });
      return made;
    };
    return layers.map((entry) => ({
      z: entry.z,
      moves: entry.extrusion.length / 6,
      beads: mesh(entry.extrusion, bead, materials.printed),
      travel: mesh(entry.travel, thread, materials.travel),
    }));
  })();
  paths.set(index, pending);
  return pending;
}

async function show() {
  const shown = part, layers = await toolpaths(shown);
  if (shown !== part || signal.aborted) return;
  for (const [index, other] of paths)
    if (index !== part) for (const entry of await other) entry.beads.visible = entry.travel.visible = false;
  layers.forEach((entry, index) => {
    entry.beads.visible = index <= layer;
    entry.beads.setMaterial(index === layer ? materials.active : materials.printed);
    entry.travel.visible = index === layer && travels.checked;
  });
  solids.forEach((solid, index) => (solid.visible = index === part));
  const active = layers[layer], shape = facts[part];
  slider.value = String(layer + 1);
  id('layer-readout').value = layer + 1 + ' / ' + layers.length;
  id('height').value = active.z.toFixed(2) + ' mm';
  id('moves').value = String(active.moves);
  id('filament').value = (shape.filament / 1000).toFixed(2) + ' m';
  id('download-model').href = modelFiles[part].href;
  id('download-model').download = 'Kite-jig-' + shape.diameter + 'mm.3mf';
  id('download-gcode').href = programs[part].href;
  id('download-gcode').download = 'Kite-jig-' + shape.diameter + 'mm.gcode';
  for (const [i, button] of sizes.querySelectorAll('button').entries()) button.setAttribute('aria-pressed', String(i === part));
  Object.assign(document.body.dataset, {
    bore: String(shape.diameter),
    layer: String(layer + 1),
    moves: String(active.moves),
    travel: String(travels.checked),
  });
  bench.request();
  performance.mark('print-layer-applied');
}

function switchPlay(active) {
  playing = active;
  play.textContent = playing ? 'Pause layers' : 'Play layers';
  play.setAttribute('aria-pressed', String(playing));
  since = 0;
  stopFrame?.();
  stopFrame = undefined;
  if (playing)
    stopFrame = bench.frame((delta) => {
      since += delta;
      if (since < layerRate) return;
      since -= layerRate;
      if (layer + 1 === facts[part].layers) return switchPlay(false);
      layer++;
      show().catch(fail);
    });
}

function fail(reason) {
  if (signal.aborted) return;
  state.error(reason);
  id('status').hidden = true;
  id('error').hidden = false;
  console.error(reason);
  controller.abort();
}

async function start() {
  applyQualityTier();
  bench = await openBench(canvas, {
    start: startEngine,
    loadCompat: () => import('@margoengine/webgl2-compat'),
    signal,
    exhibit: document.body,
    camera: { position: [0.12, 0.2, 0.24], target: [0, 0.045, 0], fov: 37, near: 0.01, far: 40 },
    environment: { preset: 'tent', intensity: 1 },
    // A cove sized to the bench: its back wall 1.5 m behind the part, so oblique views end on the wall, not past its side.
    backdrop: { width: 24, depth: 3, height: 3, radius: 0.8, material: { color: '#4a4743' } },
    contact: { size: 0.5, height: 0.1, opacity: 0.6, blur: 0.02, position: [0, plate + 0.0005, 0] },
    ao: true,
    orbit: { target: [0, 0.045, 0], minDistance: 0.08, maxDistance: 1.2 },
    onError: fail,
  });
  CadBench.attach(bench.engine, { deck: { size: [0.26, 0.16], thickness: plate }, casters: bench });
  const model = await loadGLTF(bench.engine, new URL('./assets/kites.glb', import.meta.url), { extensions: [meshopt, quantized], signal });
  model.root.setPosition([solidX, plate, 0]);
  solids = model.meshes;
  for (const solid of solids) {
    solid.setMaterial(materials.printed);
    bench.add(solid, { fit: false });
  }
  await show();
  await bench.fit({ bounds: { min: [-0.085, plate, -0.035], max: [0.09, plate + 0.02, 0.035] }, fill: 0.8 });
  bench.orbit.saveState();
  sizes.addEventListener('click', (event) => {
    const button = event.target.closest('[data-part]');
    if (!button) return;
    part = Number(button.dataset.part);
    show().catch(fail);
  }, { signal });
  slider.addEventListener('input', () => {
    switchPlay(false);
    layer = Number(slider.value) - 1;
    show().catch(fail);
  }, { signal });
  travels.addEventListener('change', () => show().catch(fail), { signal });
  play.addEventListener('click', () => {
    if (!playing && layer + 1 === facts[part].layers) {
      layer = 0;
      show().catch(fail);
    }
    switchPlay(!playing);
  }, { signal });
  if (!(await bench.ready()) || !state.ready()) return;
  id('status').hidden = true;
  sizes.disabled = slider.disabled = play.disabled = travels.disabled = false;
  performance.mark('margo-first-usable-frame');
}

start().catch(fail);
