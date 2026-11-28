import { loadGLTF } from '@margoengine/gltf';
import { meshopt } from '@margoengine/gltf/meshopt';
import { quantized } from '@margoengine/gltf/quantized';
import { CadBench } from '@margoengine/machinery/bench';
import { applyQualityTier } from '@margoengine/quality';
import { openBench } from '@margoengine/studio/bench';
import { startEngine } from '@margoengine/webgl2-compat/auto';
import { demoStatus } from 'margo-demo-status';
import facts from './facts.json';

const byId = (name) => document.getElementById(name);
const canvas = byId('part');
const notice = byId('status');
const errorOutput = byId('error');
const status = demoStatus(document.body, notice, errorOutput);
const operations = byId('operations');
const buttons = [...operations.querySelectorAll('button')];
const reset = byId('reset');
// The balance weighs one turned part at a time in the chosen metal: machined stock, measured F0 per metal.
const metals = ['aluminium', 'steel', 'copper'];
const densities = [2700, 7850, 8960];
const separator = ' · ';
const metal = byId('metal');
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const controller = new AbortController();
const { signal } = controller;
// The surface plate is 5 cm thick and rests on the floor; the solids rest on its top.
const plate = 0.05;
let bench, cad, mark, parts, step = 0;

const rounded = (value) => number.format(Math.abs(value) < 0.005 ? 0 : value);

function updatePanel() {
  const state = facts[step],
    grade = Number(metal.value),
    density = densities[grade];
  byId('volume').value = number.format(state.volume * 1e6) + ' cm³';
  byId('density').value = density.toLocaleString() + ' kg/m³';
  byId('centre').value = state.centroid.map((axis) => rounded(axis * 1000)).join(separator) + ' mm';
  byId('scale').value = (state.volume * density).toFixed(3) + ' kg';
  state.inertia.forEach((moment, index) => {
    const label = rounded(moment * density * 1e4);
    byId('i' + index).textContent = label;
    if (index > 2) byId('i' + index + 'b').textContent = label;
  });
  buttons.forEach((button, index) => button.setAttribute('aria-pressed', String(step === index)));
  document.body.dataset.modelStep = String(step);
  document.body.dataset.metal = String(grade);
}

// The amber cross stands on the part's top face over its centre of mass (its horizontal projection).
function showCentroid() {
  mark?.remove();
  const { centroid, top, lift } = facts[step];
  mark = cad.mark([centroid[0], top + lift + plate + 0.0015, centroid[2]], { size: 0.009, color: '#e3a21a', width: 2.5 });
}

function paint() {
  const material = cad.material('machined', { metal: metals[Number(metal.value)] });
  for (const part of parts) part.mesh.setMaterial(material);
  updatePanel();
  bench.request();
}

// Same three-quarter view for each part, framed to its box; Reset view returns here.
async function frame() {
  bench.engine.camera.position = [0.5, 0.42, 0.62];
  bench.engine.camera.target = [0, 0.05, 0];
  const { min, max } = facts[step].box;
  await bench.fit({ bounds: { min: [min[0], min[1] + plate, min[2]], max: [max[0], max[1] + plate, max[2]] }, fill: 0.62 });
  bench.orbit.saveState();
  bench.request();
}

async function choose(next) {
  step = next;
  parts.forEach((part, index) => (part.visible = index === step));
  updatePanel();
  showCentroid();
  await frame();
}

function fail(error) {
  if (signal.aborted) return;
  status.error(error);
  notice.hidden = true;
  errorOutput.hidden = false;
  operations.disabled = true;
  reset.disabled = true;
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
    camera: { position: [0.5, 0.42, 0.62], target: [0, 0.05, 0], fov: 36, near: 0.01, far: 40 },
    environment: { preset: 'tent', intensity: 1 },
    // A cove sized to the bench: its back wall 1.5 m behind the part, so oblique views end on the wall, not past its side.
    backdrop: { width: 24, depth: 3, height: 3, radius: 0.8, material: { color: '#4a4743' } },
    contact: { size: 0.6, height: 0.14, opacity: 0.6, blur: 0.02, position: [0, plate + 0.0005, 0] },
    ao: true,
    orbit: { minDistance: 0.12, maxDistance: 1.6 },
    onError: fail,
  });

  cad = CadBench.attach(bench.engine, { deck: { size: [0.46, 0.34], thickness: plate }, casters: bench });
  const model = await loadGLTF(bench.engine, new URL('./assets/bodies.glb', import.meta.url), {
    extensions: [meshopt, quantized],
    signal,
  });
  model.root.setPosition([0, cad.deckTop, 0]);
  parts = model.meshes.map((mesh) => cad.show(mesh, { finish: 'machined', metal: metals[Number(metal.value)] }));
  operations.addEventListener(
    'click',
    (event) => {
      const button = event.target.closest('[data-step]');
      if (button) choose(Number(button.dataset.step)).catch(fail);
    },
    { signal },
  );
  metal.addEventListener('change', paint, { signal });
  reset.addEventListener('click', () => (bench.orbit.reset(), bench.request()), { signal });
  await choose(0);
  if (!(await bench.ready()) || !status.ready()) return;
  notice.hidden = true;
  operations.disabled = false;
  reset.disabled = false;
  performance.mark('margo-first-usable-frame');
}

open().catch(fail);
