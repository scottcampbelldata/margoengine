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
const features = [
  'Extrude the L-shaped profile 132 mm.',
  'Round the heel and upper lip with a 4.6 mm radius.',
  'Open the right end and leave a 3.5 mm wall.',
  'Cut two Ø12.4 mm bores through the foot.',
];
// One aluminium bracket through four operations: sawn billet, then machined, then anodised once finished.
const finishes = ['cut', 'machined', 'machined', 'anodised'];
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const controller = new AbortController();
const { signal } = controller;
// The surface plate is 6 cm thick and rests on the floor; the solids rest on its top.
const plate = 0.06;
let bench, parts, step = 0;

function updatePanel() {
  const state = facts[step];
  byId('volume').value = number.format(state.volume * 1e6) + ' cm³';
  byId('mass').value = number.format(state.volume * 2.7e6) + ' g';
  byId('faces').value = String(state.faces);
  byId('feature').textContent = features[step];
  buttons.forEach((button, index) => button.setAttribute('aria-pressed', String(step === index)));
  document.body.dataset.modelStep = String(step);
}

// Same three-quarter view for each solid, framed to its box; Reset view returns here.
async function frame() {
  bench.engine.camera.position = [0.62, 0.36, 0.66];
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
    camera: { position: [0.62, 0.36, 0.66], target: [0, 0.05, 0], fov: 36, near: 0.01, far: 40 },
    background: '#4f4c48',
    environment: { preset: 'soft', intensity: 0.5 },
    backdrop: { material: { color: '#4a4743' } },
    contact: { size: 0.6, height: 0.14, opacity: 0.6, blur: 0.02, position: [0, plate + 0.0005, 0] },
    ao: true,
    orbit: { minDistance: 0.12, maxDistance: 1.6 },
    onError: fail,
  });
  const cad = CadBench.attach(bench.engine, { deck: { size: [0.46, 0.34], thickness: plate }, casters: bench });
  const model = await loadGLTF(bench.engine, new URL('./assets/bracket.glb', import.meta.url), {
    extensions: [meshopt, quantized],
    signal,
  });
  model.root.setPosition([0, cad.deckTop, 0]);
  parts = model.meshes.map((mesh, index) => cad.show(mesh, { finish: finishes[index] }));
  operations.addEventListener(
    'click',
    (event) => {
      const button = event.target.closest('[data-step]');
      if (button) choose(Number(button.dataset.step)).catch(fail);
    },
    { signal },
  );
  reset.addEventListener('click', () => (bench.orbit.reset(), bench.request()), { signal });
  await choose(0);
  if (!(await bench.ready()) || !status.ready()) return;
  notice.hidden = true;
  operations.disabled = false;
  reset.disabled = false;
  performance.mark('margo-first-usable-frame');
}

open().catch(fail);
