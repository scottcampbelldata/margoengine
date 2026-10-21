// Fixture for scripts/shader-raw-gpu-check.js. Built imports exercise the published entries on a real adapter.
import { Engine, box } from '../packages/core/dist/extension.js';
import { RawMesh, RawShaderMaterial, RawShaders } from '../packages/shader/dist/raw.js';
import * as effects from '../packages/shader/dist/effects.js';
import { PostStack } from '../packages/post/dist/index.js';

declare global {
  var margoLow: number | undefined;
}
globalThis.margoLow = new URLSearchParams(location.search).get('samples') === '1' ? 1 : undefined;
const canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } }),
  errors: string[] = [],
  compiled: Promise<string[]>[] = [];
engine.stop();
engine.onError = (error) => errors.push(String(error));
let sampleCount = 0;
engine.frameGraph.add({
  name: 'raw-check:samples',
  order: -100,
  execute(c) {
    if (c.backend === 'webgpu') sampleCount = c.descriptor.multisample?.count ?? 1;
  },
});
// Every module's compilation messages (errors and warnings) and every uncaptured GPU error are collected.
let observed: GPUDevice | undefined;
function observe() {
  const device = engine.gpu!;
  if (device === observed) return;
  observed = device;
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const create = device.createShaderModule.bind(device);
  device.createShaderModule = (descriptor) => {
    const module = create(descriptor);
    compiled.push(
      module
        .getCompilationInfo()
        .then((info) =>
          info.messages
            .filter((m) => m.type === 'error')
            .map((m) => `${descriptor.label ?? 'module'} ${m.lineNum}:${m.linePos} ${m.message}`),
        ),
    );
    return module;
  };
}
observe();

const core = engine.createMesh().setGeometry(box());
// A quad 1 x 0.6 drawn twice: instance 0 in front of the unit box, instance 1 behind it. Red to blue across the quad
// (per-vertex `tint`), the per-instance `offset` and u32 `id`, the camera's view and projection as separate matrices.
const sceneMaterial = new RawShaderMaterial({
  name: 'scene',
  vertexShader: `struct Out { @builtin(position) clip:vec4f, @location(0) tint:vec3f, @location(1) @interpolate(flat) id:u32 }
@vertex fn main(a:Attributes)->Out {
  let world = mesh.world * vec4f(a.position + a.offset, 1.0);
  return Out(camera.projection * (camera.view * world), a.tint, a.id);
}`,
  fragmentShader: `struct Out { @builtin(position) clip:vec4f, @location(0) tint:vec3f, @location(1) @interpolate(flat) id:u32 }
@fragment fn main(i:Out)->@location(0) vec4f {
  return vec4f(i.tint * uniforms.gain + vec3f(0.0, select(0.0, uniforms.green, i.id == 1u), 0.0), 1.0);
}`,
  uniforms: { gain: { value: 1 }, green: { value: 1 } },
});
const offsets = [-0.55, 0.3, 0.9, 0.55, -0.3, -0.9],
  sceneMesh = new RawMesh({
    material: sceneMaterial,
    attributes: {
      position: { data: [-0.5, -0.3, 0, 0.5, -0.3, 0, 0.5, 0.3, 0, -0.5, 0.3, 0], type: 'vec3f' },
      tint: { data: [1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0], type: 'vec3f' },
      offset: { data: offsets, type: 'vec3f', step: 'instance' },
      id: { data: [0, 1], type: 'u32', step: 'instance' },
    },
    index: [0, 1, 2, 0, 2, 3],
  });
// Clip-space rectangles (no camera): per-vertex corner and colour, per-instance rect and shade, one module.
const flat = new RawShaderMaterial({
  name: 'flat',
  vertexShader: `struct Out { @builtin(position) clip:vec4f, @location(0) color:vec3f }
@vertex fn vertex(a:Attributes)->Out { return Out(vec4f(mix(a.rect.xy, a.rect.zw, a.corner), 0.5, 1.0), a.color * a.shade); }
@fragment fn fragment(i:Out)->@location(0) vec4f { return vec4f(i.color, 1.0); }`,
});
const corners = { data: [0, 0, 1, 0, 1, 1, 0, 1], type: 'vec2f' as const },
  edgeMesh = new RawMesh({
    material: flat,
    attributes: {
      corner: corners,
      color: { data: new Array(12).fill(1), type: 'vec3f' },
      rect: { data: [-1, -1, 0, 1, 0, -1, 1, 1], type: 'vec4f', step: 'instance' },
      shade: { data: [0.2, 0.2, 0.2, 0.6, 0.6, 0.6], type: 'vec3f', step: 'instance' },
    },
    index: [0, 1, 2, 0, 2, 3],
  }),
  gradientMesh = new RawMesh({
    material: flat,
    attributes: {
      corner: corners,
      color: { data: [0, 0.5, 0, 1, 0.5, 0, 1, 0.5, 1, 0, 0.5, 1], type: 'vec3f' },
      rect: { data: [-1, -1, 1, 1], type: 'vec4f', step: 'instance' },
      shade: { data: [1, 1, 1], type: 'vec3f', step: 'instance' },
    },
    index: [0, 1, 2, 0, 2, 3],
  });
const raw = new RawShaders();
for (const mesh of [sceneMesh, edgeMesh, gradientMesh]) raw.add(mesh);
let stack: PostStack | undefined;

async function frame() {
  observe();
  engine.render();
  await raw.ready();
  engine.render();
  await engine.gpu!.queue.onSubmittedWorkDone();
  return {
    errors: errors.splice(0),
    compile: (await Promise.all(compiled.splice(0))).flat(),
    materials: [sceneMaterial.error, flat.error].filter(Boolean).map(String),
    sampleCount,
    drawCalls: raw.stats.drawCalls,
    pending: raw.stats.pending,
  };
}
type Effect = keyof typeof effects;
declare global {
  interface Window {
    rawFixture: unknown;
  }
}
window.rawFixture = {
  /** 'none' (plugin detached), 'core' (attached, nothing raw visible), 'raw', 'edge' or 'gradient'; optional effect. */
  async show(scene: string, effect?: Effect, options: Record<string, unknown> = {}) {
    const attached = engine.hasPlugin(raw.name);
    if (scene === 'none' && attached) engine.removePlugin(raw.name);
    if (scene !== 'none' && !attached) engine.use(raw);
    core.visible = scene === 'none' || scene === 'core' || scene === 'raw';
    sceneMesh.visible = scene === 'raw';
    edgeMesh.visible = scene === 'edge';
    gradientMesh.visible = scene === 'gradient';
    stack?.dispose();
    stack = effect ? PostStack.attach(engine, [(effects[effect] as (o: unknown) => never)(options)]) : undefined;
    return frame();
  },
  /** Live uniform and ranged attribute updates: halves the colours, then moves instance 0 out of view. */
  async live(gain: number, moveFirst: boolean) {
    sceneMaterial.uniforms.gain.value = gain;
    const data = [...offsets];
    if (moveFirst) data[0] = -50;
    sceneMesh.setAttribute('offset', data, [0, 1]);
    return frame();
  },
  async restore() {
    const old = engine.gpu;
    await engine.rebootDevice();
    const result = await frame();
    return { ...result, changedDevice: old !== engine.gpu };
  },
};
