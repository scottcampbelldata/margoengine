import { Engine, box, PbrMaterial } from '@margoengine/core/extension';
import { Transitions } from '@margoengine/transitions';
import { Toon } from '@margoengine/toon';
import { Water } from '@margoengine/water';
import { Sky } from '@margoengine/sky';
import { Selection } from '@margoengine/selection';
import { Scatter } from '@margoengine/scatter';
import { HTML } from '@margoengine/html';
import { Video } from '@margoengine/video';
import { Stats, GPUProfiler } from '@margoengine/stats';
import { Inspector } from '@margoengine/inspector';
const canvas = document.querySelector('canvas')!;
let engine: Engine, effect: any, videoFrame: VideoFrame | undefined, stats: Stats | undefined;
const errors: string[] = [];
const harness = {
  errors,
  async setup(name: string, capacity = 64) {
    engine?.dispose();
    videoFrame?.close();
    videoFrame = undefined;
    stats = undefined;
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      capacity,
      camera: { position: [5, 4, 8], target: [0, 0, 0] },
    });
    engine.gpu!.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    engine.gpu!.pushErrorScope('validation');
    const floor = engine
      .createMesh()
      .setGeometry(box(20, 0.2, 20))
      .setPosition([0, -0.6, 0])
      .setMaterial(new PbrMaterial({ color: '#b9bcc1' }));
    floor.name = 'Ground';
    const mesh = engine
      .createMesh()
      .setGeometry(box(2, 2, 2))
      .setPosition([0, 0.6, 0])
      .setMaterial(new PbrMaterial({ color: '#bc314d' }));
    mesh.name = 'Main cube';
    if (name === 'toon') effect = Toon.attach(engine);
    else if (name === 'water') effect = Water.attach(engine, { size: [20, 20], segments: 32, height: -0.45 });
    else if (name === 'preetham' || name === 'bruneton') effect = Sky.attach(engine, { model: name, timeScale: 0 });
    else if (name === 'jfa' || name === 'morphological') {
      effect = Selection.attach(engine, { algorithm: name, width: 5, color: [1, 0.5, 0] });
      effect.set([mesh]);
    } else if (name === 'scatter')
      effect = Scatter.attach(engine, [box(0.2, 1, 0.2), box(0.2, 0.6, 0.2), box(0.2, 0.3, 0.2)], {
        count: 500,
        area: [16, 16],
        center: [0, 0, 0],
        scale: [0.5, 1],
        lod: [5, 10, 30],
      });
    else if (name === 'transitions') {
      effect = Transitions.attach(engine);
      engine.render();
      effect.start('wipe', 0.5);
      mesh.setMaterial(new PbrMaterial({ color: '#14ac79' }));
    } else if (name === 'html') {
      effect = HTML.attach(engine);
      const behind = document.createElement('span');
      behind.className = 'anchor';
      behind.textContent = 'Occluded';
      effect.add(behind, { position: [0, 0.6, -1.5] });
      const front = document.createElement('span');
      front.className = 'anchor';
      front.textContent = 'Front';
      effect.add(front, { position: [0, 2.5, 0] });
    } else if (name === 'video') {
      const bitmap = document.createElement('canvas');
      bitmap.width = 64;
      bitmap.height = 64;
      const context = bitmap.getContext('2d')!;
      context.fillStyle = '#f52719';
      context.fillRect(0, 0, 64, 64);
      context.fillStyle = '#1ef5a0';
      context.fillRect(32, 0, 32, 64);
      videoFrame = new VideoFrame(bitmap, { timestamp: 0 });
      effect = Video.attach(engine, videoFrame, { rect: [0.25, 0.25, 0.5, 0.5] });
    } else if (name === 'debug') {
      stats = Stats.attach(engine);
      const inspector = Inspector.attach(engine, { effects: { exposure: 0, bloom: 0.5 } });
      inspector.select(mesh);
      for (const mode of ['wireframe', 'normals', 'bounds'] as const) inspector.setDebug(mode, true);
      effect = { stats, inspector };
    } else if (name === 'combined') {
      stats = Stats.attach(engine);
      Sky.attach(engine, { model: 'bruneton', timeScale: 0 });
      Water.attach(engine, { size: [20, 20], segments: 32, height: -0.45 });
      Toon.attach(engine);
      const selected = Selection.attach(engine);
      selected.set([mesh]);
      Scatter.attach(engine, box(0.1, 0.7, 0.1), { count: 256, lod: [5, 10, 30] });
      const labels = HTML.attach(engine);
      labels.add(document.createElement('span'), { position: [0, 2, 0] });
      effect = Transitions.attach(engine);
    }
    for (let i = 0; i < 3; i++) {
      engine.render({ delta: 0.05 });
      await engine.gpu!.queue.onSubmittedWorkDone();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const error = await engine.gpu!.popErrorScope();
    if (error) throw new Error(error.message);
    return { backend: engine.backend, drawCalls: engine.stats.drawCalls };
  },
  async frame(delta = 0.1) {
    engine.gpu!.pushErrorScope('validation');
    engine.render({ delta });
    await engine.gpu!.queue.onSubmittedWorkDone();
    const error = await engine.gpu!.popErrorScope();
    if (error) throw new Error(error.message);
  },
  async restore() {
    await engine.rebootDevice();
    await this.frame();
  },
  async fbx(url: string) {
    await this.setup('baseline', 512);
    engine.gpu!.pushErrorScope('validation');
    const { loadFBX } = await import('@margoengine/fbx'),
      { Animation } = await import('@margoengine/animation'),
      model = await loadFBX(engine, url),
      animation = Animation.attach(model);
    model.root.setScale([0.01, 0.01, 0.01]);
    animation.play(0);
    animation.playing = false;
    animation.seek(0);
    await this.frame(0);
    effect = animation;
    const doc = model.asset.doc;
    const error = await engine.gpu!.popErrorScope();
    if (error) throw new Error(error.message);
    return {
      primitives: model.primitives.length,
      skins: doc.skins?.length ?? 0,
      joints: doc.skins?.reduce((n: number, skin: { joints: number[] }) => n + skin.joints.length, 0) ?? 0,
      clips: animation.clips.length,
      channels: doc.animations?.reduce((n: number, clip: { channels: unknown[] }) => n + clip.channels.length, 0) ?? 0,
    };
  },
  async seek(time: number) {
    effect.seek(time);
    await this.frame(0);
  },
  async timestamps() {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter?.features.has('timestamp-query')) return { supported: false };
    const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] }),
      profiler = new GPUProfiler(device),
      buffer = device.createBuffer({ size: 65536 * 4, usage: GPUBufferUsage.STORAGE });
    const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({
            code: '@group(0) @binding(0) var<storage,read_write> output:array<u32>;@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){var x=id.x+1u;for(var i=0u;i<512u;i++){x=(x^(x>>16u))*0x7feb352du;}output[id.x]=x;}',
          }),
          entryPoint: 'main',
        },
      }),
      bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer } }],
      });
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    device.pushErrorScope('validation');
    const samples = [];
    try {
      for (let i = 0; i < 2; i++) {
        if (!profiler.beginFrame()) throw new Error('Profiler could not begin a reused frame');
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass({ timestampWrites: profiler.timestampWrites() });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(1024);
        pass.end();
        if (!profiler.resolve(encoder)) throw new Error('Profiler did not resolve timestamps');
        device.queue.submit([encoder.finish()]);
        samples.push(await profiler.read());
      }
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      return { supported: true, samples };
    } finally {
      profiler.dispose();
      buffer.destroy();
      device.destroy();
    }
  },
  state() {
    return {
      html: [...document.querySelectorAll('span.anchor')].map((node) => ({
        text: node.textContent,
        visible: (node as HTMLElement).style.display !== 'none',
      })),
      progress: effect?.progress,
      stats: stats ? { draws: stats.drawCalls, dispatches: stats.dispatches } : undefined,
    };
  },
  dispose() {
    engine.dispose();
    videoFrame?.close();
    videoFrame = undefined;
  },
};
(window as any).margoModules = harness;
