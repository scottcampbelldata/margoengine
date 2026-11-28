import { box, PbrMaterial } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf';
import { meshopt } from '@margoengine/gltf/meshopt';
import { quantized } from '@margoengine/gltf/quantized';
import { CadBench } from '@margoengine/machinery/bench';
import { ExplodedView } from '@margoengine/machinery/exploded';
import { applyQualityTier } from '@margoengine/quality';
import { Picking, Selection } from '@margoengine/selection';
import { openBench } from '@margoengine/studio/bench';
import { Tween, easeInOutCubic } from '@margoengine/tween';
import { startEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import { fullSpread, parts } from './iris.mjs';

const id = (name) => document.getElementById(name);
const canvas = id('view'), overlay = id('status'), detail = id('detail');
const slider = id('spread'), distance = id('distance'), explode = id('explode'), assemble = id('assemble');
const picker = id('part'), name = id('name');
const controls = [slider, explode, assemble, picker];
const status = demoStatus(document.body, overlay, detail);
const controller = new AbortController();
const { signal } = controller;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const motion = { spread: Number(slider.value) / 100 };
const timeline = new Tween();
// The iris rests on the surface plate: the mount, the lowest part, stays on it while the rest lift away, so every
// offset is measured from the mount's.
const plate = 0.04, floor = Math.min(...parts.map((part) => part.offset[1]));
const highlight = new PbrMaterial({ color: '#dec085', roughness: 0.48, metalness: 0 });
// Finishes by the part's material: anodised aluminium dyed teal for the frame, a bronze cam ring, steel carrier and
// washer, stainless leaves and brass pins.
const finishes = {
  frame: { finish: 'anodised' },
  outer: { finish: 'anodised', tint: [0.18, 0.4, 0.44] },
  bronze: { finish: 'machined', metal: 'bronze', roughness: 0.3 },
  steel: { finish: 'machined', metal: 'steel', roughness: 0.34 },
  blade: { finish: 'cut', metal: 'stainlessSteel', roughness: 0.26 },
  pin: { finish: 'machined', metal: 'brass', roughness: 0.3 },
};
let bench, stage, cad, outline, active, selected, stopFrame, request, pickingBusy = false, pickVersion = 0, beganInput = false;
const choices = [], pickOwners = new Map();

applyQualityTier();

function fail(error) {
  if (signal.aborted || status.failed) return;
  status.error(error);
  overlay.hidden = false;
  overlay.querySelector('strong').textContent =
    error?.code === 'unsupported' ? 'This exhibit needs WebGPU graphics.' : 'The iris could not be opened.';
  id('help').hidden = false;
  for (const control of controls) control.disabled = true;
  controller.abort();
}

function select(index) {
  if (selected && selected === choices[index]) return;
  if (selected) selected.part.mesh.setMaterial(selected.part.material);
  selected = choices[index];
  selected?.part.mesh.setMaterial(highlight);
  outline.set(selected ? [selected.part.mesh] : []);
  name.textContent = selected?.label ?? 'Move over a part';
  canvas.dataset.part = selected?.label ?? '';
  picker.value = selected ? String(index) : '';
  bench.request();
}

async function readPick() {
  if (pickingBusy || !request || signal.aborted || status.failed) return;
  pickingBusy = true;
  const at = request;
  request = undefined;
  try {
    const node = await bench.engine.pick(at.x, at.y);
    if (!signal.aborted && at.version === pickVersion) select(pickOwners.get(node?.id) ?? -1);
  } catch (error) {
    fail(error);
  } finally {
    pickingBusy = false;
    if (request) void readPick();
  }
}

function requestPick(event) {
  const rect = canvas.getBoundingClientRect();
  request = { x: event.clientX - rect.left, y: event.clientY - rect.top, version: ++pickVersion };
  void readPick();
}

// The assembled stack spans 0.046 above the mount's base; each part rises by its offset times the spread.
function stackBounds(spread) {
  let high = -Infinity;
  for (const part of parts) high = Math.max(high, part.origin[1] + 0.0094 + (part.offset[1] - floor) * spread);
  return { min: [-0.065, plate, -0.065], max: [0.065, plate + 0.02 + high, 0.065] };
}

// The camera follows the stack: the box round every part at this spread, framed along the same view direction.
function update() {
  const spread = motion.spread;
  stage.amount = spread;
  bench.fit({ bounds: stackBounds(spread), fill: 0.84 });
  slider.value = String(spread * 100);
  distance.textContent = (fullSpread * spread * 1000).toFixed(1) + ' mm';
  slider.setAttribute('aria-valuetext', distance.textContent + ' additional axial spread');
  canvas.dataset.spread = spread.toFixed(4);
  canvas.dataset.distance = (fullSpread * spread * 1000).toFixed(3);
  bench.request();
}

function mark() {
  if (beganInput && !performance.getEntriesByName('iris-first-spread-frame').length)
    performance.mark('iris-first-spread-frame');
}

function stopMotion() {
  active?.();
  active = undefined;
  stopFrame?.();
  stopFrame = undefined;
}

function goTo(target) {
  beganInput = true;
  stopMotion();
  if (reduced) {
    motion.spread = target;
    update();
    mark();
    return;
  }
  active = timeline.to(motion, 'spread', target, { duration: 0.83, easing: easeInOutCubic, onComplete: stopMotion });
  stopFrame = bench.frame((delta) => {
    timeline.update(Math.min(0.065, delta));
    update();
    mark();
  });
}

function connect() {
  slider.addEventListener('input', () => {
    beganInput = true;
    stopMotion();
    motion.spread = Number(slider.value) / 100;
    update();
    mark();
  }, { signal });
  explode.addEventListener('click', () => goTo(1), { signal });
  assemble.addEventListener('click', () => goTo(0), { signal });
  picker.addEventListener('change', () => select(picker.value === '' ? -1 : Number(picker.value)), { signal });
  canvas.addEventListener('pointermove', (event) => { if (event.pointerType === 'mouse') requestPick(event); }, { signal });
  canvas.addEventListener('pointerup', requestPick, { signal });
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    request = undefined;
    pickVersion++;
    select(-1);
  }, { signal });
}

async function open() {
  bench = await openBench(canvas, {
    start: startEngine,
    loadCompat: () => import('@margoengine/webgl2-compat'),
    signal,
    exhibit: document.body,
    camera: { position: [0.19, 0.26, 0.3], target: [0, plate + 0.05, 0], fov: 38, near: 0.01, far: 40 },
    environment: { preset: 'tent', intensity: 1 },
    backdrop: { width: 24, depth: 3, height: 3, radius: 0.8, material: { color: '#4a5558' } },
    contact: { size: 0.5, height: 0.12, opacity: 0.6, blur: 0.02, position: [0, plate + 0.0005, 0] },
    ao: true,
    orbit: { target: [0, plate + 0.05, 0], minDistance: 0.12, maxDistance: 1.2 },
    onError: fail,
  });
  if (!bench.engine.gpu) throw Object.assign(new Error('The iris part pick uses the Margo WebGPU frame graph'), { code: 'unsupported' });
  cad = CadBench.attach(bench.engine, { deck: { size: [0.3, 0.24], thickness: plate }, casters: bench });
  const model = await loadGLTF(bench.engine, new URL('./assets/iris.glb', import.meta.url), { extensions: [meshopt, quantized], signal });
  // The root sits so the mount's base (0.020 below its origin) rests on the plate.
  model.root.setPosition([0, plate + 0.02, 0]);
  if (model.meshes.length !== parts.length || model.nodes.length !== parts.length) throw new Error('The aperture geometry has the wrong number of parts.');
  const enamel = new PbrMaterial({ color: '#b5ad8f', roughness: 0.58 });
  const fine = box(0.00044, 0.00008, 0.00215), master = box(0.00072, 0.00008, 0.00325);
  for (const [index, spec] of parts.entries()) {
    const part = cad.show(model.meshes[index], finishes[spec.style]);
    choices.push({ ...spec, part, node: model.nodes[index], offset: [spec.offset[0], spec.offset[1] - floor, spec.offset[2]] });
    pickOwners.set(part.mesh.id, index);
    if (spec.id === 'bezel')
      for (let tick = 0; tick < 30; tick++) {
        const angle = (tick * Math.PI) / 15;
        const engraving = bench.engine.createMesh().setGeometry(tick % 5 === 0 ? master : fine).setMaterial(enamel)
          .setParent(model.nodes[index]).setPosition([0.0534 * Math.sin(angle), 0.004245, 0.0534 * Math.cos(angle)])
          .setRotation([0, angle, 0]);
        pickOwners.set(engraving.id, index);
      }
    const option = document.createElement('option');
    option.textContent = spec.label;
    option.value = String(index);
    picker.append(option);
  }
  stage = ExplodedView.attach(bench.engine, choices.map(({ node, offset }) => ({ node, offset })));
  Picking.attach(bench.engine, { capture: false });
  // The picked part is outlined even where the others hide it: dashed lines through the rings.
  outline = Selection.attach(bench.engine, { width: 2, color: [1, 0.62, 0.18], xray: { dash: 5, opacity: 0.9 } });
  update();
  await bench.fit({ bounds: stackBounds(motion.spread), fill: 0.84 });
  bench.orbit.saveState();
  canvas.dataset.parts = String(choices.length);
  if (!(await bench.ready()) || !status.ready()) return;
  for (const control of controls) control.disabled = false;
  connect();
  overlay.hidden = true;
  performance.mark('margo-first-usable-frame');
}

window.addEventListener('pagehide', stopMotion, { signal });
open().catch(fail);
