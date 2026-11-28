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
// The cup is sand cast in iron, so every wall and draft shows the cast finish.
const wall = byId('wall');
const draft = byId('draft');
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const controller = new AbortController();
const { signal } = controller;
// The surface plate is 5 cm thick and rests on the floor; the solids rest on its top.
const plate = 0.05;
let bench, parts, step = 12;

function updatePanel() {
  const state = facts[step];
  byId('volume').value = number.format(state.volume * 1e6) + ' cm³';
  byId('check').value = 'Valid solid';
  byId('faces').value = String(state.faces);
  byId('feature').textContent = 'Draft · ' + state.deg + '° toward the opening';
  byId('wall-value').value = state.mm + ' mm';
  byId('draft-value').value = state.deg + '°';
  wall.setAttribute('aria-valuetext', state.mm + ' mm');
  draft.setAttribute('aria-valuetext', state.deg + ' degrees');
  document.body.dataset.modelStep = String(step);
}

// Same view from above for each cup, so the opening and its wall show, framed to its box; Reset view returns here.
async function frame() {
  bench.engine.camera.position = [0.42, 0.5, 0.52];
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
    camera: { position: [0.42, 0.5, 0.52], target: [0, 0.05, 0], fov: 36, near: 0.01, far: 40 },
    environment: { preset: 'tent', intensity: 0.5 },
    // A cove sized to the bench: its back wall 1.5 m behind the part, so oblique views end on the wall, not past its side.
    backdrop: { width: 24, depth: 3, height: 3, radius: 0.8, material: { color: '#4a4743' } },
    contact: { size: 0.6, height: 0.14, opacity: 0.6, blur: 0.02, position: [0, plate + 0.0005, 0] },
    ao: true,
    orbit: { minDistance: 0.12, maxDistance: 1.6 },
    onError: fail,
  });

  const cad = CadBench.attach(bench.engine, { deck: { size: [0.46, 0.34], thickness: plate }, casters: bench });
  const model = await loadGLTF(bench.engine, new URL('./assets/cups.glb', import.meta.url), {
    extensions: [meshopt, quantized],
    signal,
  });
  model.root.setPosition([0, cad.deckTop, 0]);
  parts = model.meshes.map((mesh) => cad.show(mesh, { finish: 'cast' }));
  // Five drafts by five walls: the state index the generator wrote is draft / 2 * 5 + wall - 2.
  operations.addEventListener(
    'input',
    () => choose((Number(draft.value) / 2) * 5 + Number(wall.value) - 2).catch(fail),
    { signal },
  );
  reset.addEventListener('click', () => (bench.orbit.reset(), bench.request()), { signal });
  await choose(12);
  if (!(await bench.ready()) || !status.ready()) return;
  notice.hidden = true;
  operations.disabled = false;
  reset.disabled = false;
  performance.mark('margo-first-usable-frame');
}

open().catch(fail);
