// The model cabinet: the published Khronos sample models on the gallery template. examples/khronos-gallery.html stays the
// check page (every model, and the visual baselines); this one is what visitors see. scripts/build-site.js copies the
// models named by the section buttons to gallery/models/ and nothing else, so the 250 MB set stays out of the site.
import { engineRuntime } from '@margoengine/core/extension';
import { createStage } from 'margoengine';
import type { loadGLTF } from '@margoengine/gltf-pro';
import { ColorBackground, Environment, EnvironmentLighting } from '@margoengine/environment';
import { OrbitControls } from '@margoengine/controls';
import type { Clustered } from '@margoengine/clustered';
import { Stats } from '@margoengine/stats';
import { afterPresented } from '../../packages/shared/demo-frame.js';
import { mountGallery } from './gallery.js';

const BASE = import.meta.env.DEV ? '../assets/khronos/' : './models/';

/** The material extensions `@margoengine/gltf-pro/extended` adds. */
const EXTENDED = new Set([
  'KHR_materials_iridescence',
  'KHR_materials_anisotropy',
  'KHR_materials_diffuse_transmission',
]);

/** A soft paper-white studio: two lamps on a pale sky (equirectangular, linear radiance). */
function studio(width = 128, height = 64) {
  const data = new Float32Array(width * height * 4),
    lamp = (u: number, v: number, cu: number, cv: number, r: number) =>
      Math.exp(-(((u - cu) * 2) ** 2 + (v - cv) ** 2) / (r * r));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width,
        v = (y + 0.5) / height,
        sky = v < 0.5 ? 0.62 + 0.4 * (0.5 - v) : 0.62 - 0.5 * (v - 0.5);
      const value = sky + 8 * lamp(u, v, 0.3, 0.28, 0.08) + 4 * lamp(u, v, 0.72, 0.32, 0.1);
      data.set([value, value, value, 1], (y * width + x) * 4);
    }
  return { width, height, data };
}

/** What the page reads about a model; scripts/build-site.js writes the published models' entries to models/manifest.json. */
interface ModelEntry {
  name: string;
  file: string;
  extensionsUsed: string[];
  legal: { artist?: string; owner?: string; license: string }[];
}

async function main() {
  // The loader comes with the first model, not before the first frame (the gallery check's 120,000 B budget): its
  // download starts here, beside the stage's, and show() waits for it (amd-gpu-hunt row 16).
  const pro = import('@margoengine/gltf-pro');
  pro.catch(() => {}); // a failed load is reported by show(), which awaits it
  const manifest: ModelEntry[] = (await (await fetch(new URL(`${BASE}manifest.json`, document.baseURI))).json()).models;
  const host = document.querySelector<HTMLElement>('#viewport')!,
    canvas = host.querySelector('canvas')!,
    credit = document.querySelector<HTMLElement>('[data-credit]')!,
    variantLabel = document.querySelector<HTMLElement>('[data-variants]')!,
    variantSelect = variantLabel.querySelector('select')!;
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    controls: false,
    features: ['timestamp-query'],
    camera: { position: [0.6, 0.8, 3], target: [0, 0, 0] },
  });
  const engine = stage.engine,
    runtime = engineRuntime(engine),
    device = runtime.gpu as GPUDevice;
  device.addEventListener('uncapturederror', (event: Event) => {
    console.error('GPU validation error:', (event as GPUUncapturedErrorEvent).error.message);
  });
  ColorBackground.attach(engine, { color: '#efeadf', bottom: '#d3ccbc' });
  const environment = await Environment.attach(engine, studio());
  const lighting = EnvironmentLighting.attach(engine, environment);
  const controls = OrbitControls.attach(engine);
  // The strip reads the plugin's numbers; its own overlay stays in a hidden element.
  const statsHost = document.createElement('div');
  statsHost.hidden = true;
  document.body.append(statsHost);
  const stats = Stats.attach(engine, { parent: statsHost, profiling: true });
  const camera = engine.camera,
    light = [runtime.lighting.direction.slice(), runtime.lighting.radiance.slice()];
  let clustered: Clustered | undefined, model: Awaited<ReturnType<typeof loadGLTF>> | undefined;

  variantSelect.addEventListener('change', () => {
    model?.selectVariant(Number(variantSelect.value));
  });

  async function show(id: string, signal: AbortSignal) {
    const entry = manifest.find((m) => m.name === id);
    if (!entry) throw new RangeError(`No model "${id}" in the Khronos manifest`);
    // Loaded only for the models that use them, so the page's first frame does not carry them.
    const used: readonly string[] = entry.extensionsUsed,
      decoders: Record<string, unknown> = {};
    if (used.includes('KHR_meshopt_compression') || used.includes('EXT_meshopt_compression'))
      decoders.meshopt = (await import('@margoengine/decoders')).MeshoptDecoder;
    if (used.some((name) => EXTENDED.has(name)))
      decoders.materials = (await import('@margoengine/gltf-pro/extended')).extendedMaterials;
    const { applyGLTFLights, loadGLTF, viewGLTFCamera } = await pro;
    const next = await loadGLTF(engine, new URL(`${BASE}${id}/${entry.file}`, document.baseURI), {
      decoders,
      signal,
    });
    if (signal.aborted) {
      next.dispose();
      return;
    }
    model?.dispose();
    model = next;
    runtime.lighting.direction.set(light[0]);
    runtime.lighting.radiance.set(light[1]);
    lighting.add(model);
    const sun = model.lights.find((l) => l.type === 'directional');
    if (model.clusteredLights().length) clustered ??= (await import('@margoengine/clustered')).Clustered.attach(engine);
    else clustered?.setLights([]);
    applyGLTFLights(model, {
      clustered: model.clusteredLights().length ? clustered : undefined,
      exposure: sun?.intensity ? 3 / sun.intensity : 1,
    });
    const b = model.bounds,
      min: [number, number, number] = [b[0], b[1], b[2]],
      max: [number, number, number] = [b[3], b[4], b[5]],
      radius = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    camera.project = undefined;
    camera.up = [0, 1, 0];
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.position = [0.6, 0.8, 3];
    camera.target = [0, 0, 0];
    if (model.cameras.length) viewGLTFCamera(model);
    else
      camera.fitToBoundingBox(min, max, {
        aspect: canvas.clientWidth / canvas.clientHeight,
        duration: 0,
        padding: 1,
      });
    controls.saveState();
    variantLabel.hidden = model.variants.length === 0;
    variantSelect.replaceChildren(...model.variants.map((name, index) => new Option(name, String(index))));
    credit.textContent = `${id}: ${entry.legal
      .map((l) => `${l.artist ?? l.owner}, ${l.license}`)
      .filter((line, index, all) => all.indexOf(line) === index)
      .join('; ')}.`;
    await afterPresented(device.queue, signal);
  }

  await mountGallery({
    engine,
    stats,
    show,
    reset: () => controls.reset(),
    dispose: () => stage.dispose(),
  });
}

main().catch((error) => {
  console.error(error);
  const status = document.querySelector('[data-gallery-status]');
  if (status) status.textContent = String(error?.message ?? error);
});
