// Render check for the Khronos sample assets (HANDOFF launch gate 5, queue 5w). Serve the repo root with Vite
// (`npx vite`) after `npm run build:packages`, then open /examples/khronos-gallery.html: every model in
// assets/khronos/manifest.json is loaded in turn and reported (loads or the error, extensions gltf-pro ignores, GPU
// validation errors). `?model=Name` shows one model as a still frame; that is the view scripts/visual-regression.js
// captures (readiness: body[data-ready]); `&variant=Name` (or its index) shows that KHR_materials_variants variant (model.selectVariant).
import {createStage} from 'margoengine';
import {applyGLTFLights, loadGLTF, viewGLTFCamera} from '@margoengine/gltf-pro';
import {instancing} from '@margoengine/gltf-pro/instancing';
import {extendedMaterials} from '@margoengine/gltf-pro/extended';
import {DracoDecoder, KTX2Decoder, MeshoptDecoder} from '@margoengine/decoders';
import {Environment, EnvironmentLighting, ColorBackground} from '@margoengine/environment';
import {OrbitControls} from '@margoengine/controls';
import {Clustered} from '@margoengine/clustered';
import {afterPresented} from '../packages/shared/demo-frame.js';

// Extensions gltf-pro renders or decodes (packages/gltf-pro/src/asset.ts `supported` plus the decoder hooks passed
// below). Any other extension in extensionsUsed is ignored by the loader and listed as a gap.
const HANDLED = new Set(['KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength', 'KHR_materials_unlit',
  'KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_volume', 'KHR_materials_sheen',
  'KHR_materials_specular', 'KHR_materials_iridescence', 'KHR_materials_anisotropy', 'KHR_materials_diffuse_transmission', 'KHR_materials_variants',
  'EXT_texture_webp', 'EXT_texture_avif', 'EXT_mesh_gpu_instancing', 'KHR_draco_mesh_compression',
  'EXT_meshopt_compression', 'KHR_meshopt_compression', 'KHR_texture_basisu', 'KHR_lights_punctual']);

// Neutral studio: grey gradient sky with two soft white key lights (equirect, linear radiance).
function studio(width = 128, height = 64) {
  const data = new Float32Array(width * height * 4), blob = (u, v, cu, cv, r) => Math.exp(-(((u - cu) * 2) ** 2 + (v - cv) ** 2) / (r * r));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width, v = (y + 0.5) / height, sky = v < 0.5 ? 0.55 + 0.45 * (0.5 - v) * 2 : 0.55 - 0.35 * (v - 0.5) * 2;
    const value = sky + 8 * blob(u, v, 0.3, 0.28, 0.08) + 4 * blob(u, v, 0.72, 0.32, 0.1);
    data.set([value, value, value, 1], (y * width + x) * 4);
  }
  return {width, height, data};
}

// Not top-level await: that would hold the page's load event until every model is in.
async function main() {
  const params = new URLSearchParams(location.search), only = params.get('model'), caption = document.querySelector('#caption');
  const manifest = await (await fetch(new URL('./assets/khronos/manifest.json', import.meta.url))).json();
  const models = only ? manifest.models.filter(m => m.name === only) : manifest.models;
  if (only) document.body.dataset.model = only;
  const stage = await createStage('#viewport', {backend: 'webgpu', autoStart: false, controls: false, label: 'Khronos glTF sample model', camera: {position: [0.6, 0.8, 3], target: [0, 0, 0]}});
  const engine = stage.engine, device = engine.gpu, gpuErrors = [];
  device.addEventListener('uncapturederror', event => {gpuErrors.push(event.error.message); console.error('GPU validation error:', event.error.message);});
  ColorBackground.attach(engine, {color: '#5d6168', bottom: '#2c2f34'});
  const environment = await Environment.attach(engine, studio());
  const lighting = EnvironmentLighting.attach(engine, environment);
  const decoders = {draco: new DracoDecoder(), ktx2: new KTX2Decoder({device}), meshopt: MeshoptDecoder, instancing, materials: extendedMaterials};
  const controls = OrbitControls.attach(engine);
  let clustered; // for KHR_lights_punctual point and spot lights, attached by the first model that has some
  const camera = engine.camera, fov = camera.fov, light = [engine.lighting.direction.slice(), engine.lighting.radiance.slice()];
  // ABeautifulGame's 33 2048x2048 textures decode to 528 MiB, over the default image budget (4 x 128 MiB): HANDOFF 5w.c.
  const maxDownloadBytes = 160 * 1024 * 1024;

  const report = [], rows = document.querySelector('#rows'), esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
  window.khronosGallery = {report};
  for (const m of models) {
    caption.textContent = `Loading ${m.name}…`;
    const row = {name: m.name, ok: false, error: undefined, ignored: [], gpuErrors: [], loadMs: 0, frameMs: 0}, start = performance.now(), before = gpuErrors.length;
    let model;
    try {
      engine.lighting.direction.set(light[0]); engine.lighting.radiance.set(light[1]); camera.project = undefined; camera.up = [0, 1, 0]; camera.fov = fov;
      model = await loadGLTF(engine, new URL(`./assets/khronos/${m.name}/${m.file}`, import.meta.url), {decoders, maxDownloadBytes});
      row.loadMs = Math.round(performance.now() - start);
      const used = model.asset.doc.extensionsUsed ?? [];
      row.ignored = used.filter(e => !HANDLED.has(e));
      if (only && params.has('variant')) {const v = params.get('variant'); model.selectVariant(/^\d+$/.test(v) ? Number(v) : v);}
      lighting.add(model);
      // The file's lights (applyGLTFLights): a directional light replaces the engine's, scaled to its default strength 3.
      const sun = model.lights.find(l => l.type === 'directional');
      if (model.clusteredLights().length) clustered ??= Clustered.attach(engine); else clustered?.setLights([]);
      applyGLTFLights(model, {clustered: model.clusteredLights().length ? clustered : undefined, exposure: sun?.intensity ? 3 / sun.intensity : 1});
      const b = model.bounds, min = [b[0], b[1], b[2]], max = [b[3], b[4], b[5]];
      if (![...min, ...max].every(Number.isFinite)) throw new Error('model has no finite bounds');
      const radius = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
      camera.near = radius / 100; camera.far = radius * 100; camera.position = [0.6, 0.8, 3]; camera.target = [0, 0, 0];
      // The file's first glTF camera when it has one (viewGLTFCamera), else a view fitted from the front right.
      if (model.cameras.length) viewGLTFCamera(model);
      else camera.fitToBoundingBox(min, max, {aspect: stage.canvas.clientWidth / stage.canvas.clientHeight, duration: 0, padding: 1});
      controls.saveState();
      engine.render();
      await afterPresented(device.queue, new AbortController().signal);
      row.frameMs = Math.round(performance.now() - start); // load start to first presented frame (diagnostic)
      row.ok = true;
    } catch (error) {
      row.error = String(error?.message ?? error);
      console.error(`${m.name}:`, error);
    }
    row.gpuErrors = gpuErrors.slice(before);
    report.push(row);
    rows.insertAdjacentHTML('beforeend', `<tr><td><a href="?model=${m.name}">${m.name}</a></td><td class="${row.ok && !row.gpuErrors.length ? 'ok' : 'fail'}">${row.ok ? 'loads' : `fails: ${esc(row.error)}`}</td>`
      + `<td>${row.ignored.join(', ') || '-'}</td><td>${row.gpuErrors.length ? row.gpuErrors.map(esc).join('<br>') : '0'}</td><td>${row.loadMs} / ${row.frameMs} ms</td></tr>`);
    if (!only) model?.dispose();
  }
  caption.textContent = only ? only : `${report.filter(r => r.ok).length}/${report.length} models load`;
  if (only) engine.start();
  document.body.dataset.ready = 'true';
}
main().catch(error => {console.error(error); document.querySelector('#caption').textContent = String(error);});
