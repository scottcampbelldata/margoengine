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
const reset = byId('reset');
const inputs = [...operations.querySelectorAll('input')];
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const controller = new AbortController();
const { signal } = controller;
// The stock block is 120 x 62 x 86 mm before its twelve edges are blended.
const stock = 0.12 * 0.062 * 0.086;
// The surface plate is 5 cm thick and rests on the floor; the block rests on its top.
const plate = 0.05;
let bench, parts, step = 3;

function updatePanel() {
  const state = facts[step];
  byId('volume').value = number.format(state.volume * 1e6) + ' cm³';
  byId('removed').value = number.format((stock - state.volume) * 1e6) + ' cm³';
  byId('faces').value = String(state.faces);
  byId('feature').textContent = (state.operation === 'round' ? 'Fillet · ' : 'Chamfer · ') + state.mm + ' mm';
  for (const input of inputs) input.setAttribute('aria-valuetext', input.value + ' mm');
  document.body.dataset.modelStep = String(step);
}

async function choose(next) {
  step = next;
  parts.forEach((part, index) => (part.visible = index === step));
  updatePanel();
  bench.request();
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
    camera: { position: [0.4, 0.3, 0.46], target: [0, 0.08, 0], fov: 36, near: 0.01, far: 40 },
    environment: { preset: 'tent', intensity: 1 },
    // A cove sized to the bench: its back wall 1.5 m behind the part, so oblique views end on the wall, not past its side.
    backdrop: { width: 24, depth: 3, height: 3, radius: 0.8, material: { color: '#4a4743' } },
    contact: { size: 0.6, height: 0.14, opacity: 0.6, blur: 0.02, position: [0, plate + 0.0005, 0] },
    ao: true,
    orbit: { minDistance: 0.12, maxDistance: 1.6 },
    onError: fail,
  });

  const cad = CadBench.attach(bench.engine, { deck: { size: [0.42, 0.3], thickness: plate }, casters: bench });
  const model = await loadGLTF(bench.engine, new URL('./assets/blends.glb', import.meta.url), {
    extensions: [meshopt, quantized],
    signal,
  });
  model.root.setPosition([0, cad.deckTop, 0]);
  // The block is milled aluminium; each blend is a fresh cut in the same stock.
  parts = model.meshes.map((mesh) => cad.show(mesh, { finish: 'machined' }));
  // Nine fillet radii then nine chamfer distances, 2 to 18 mm: the slider last moved picks the state.
  operations.addEventListener(
    'input',
    (event) => {
      const slider = event.target;
      const index = facts.findIndex((state) => state.operation === slider.dataset.operation && state.mm === Number(slider.value));
      if (index < 0) return;
      byId(slider.id + '-value').value = slider.value + ' mm';
      choose(index).catch(fail);
    },
    { signal },
  );
  reset.addEventListener('click', () => (bench.orbit.reset(), bench.request()), { signal });
  await choose(3);
  const { min, max } = facts[3].box;
  await bench.fit({ bounds: { min: [min[0], min[1] + plate, min[2]], max: [max[0], max[1] + plate, max[2]] }, fill: 0.6 });
  bench.orbit.saveState();
  if (!(await bench.ready()) || !status.ready()) return;
  notice.hidden = true;
  operations.disabled = false;
  reset.disabled = false;
  performance.mark('margo-first-usable-frame');
}

open().catch(fail);
