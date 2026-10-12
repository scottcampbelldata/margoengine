import { Camera, PbrMaterial } from '@margoengine/core';
import { HDRRenderTarget } from '@margoengine/creative';
import {
  SkyMoonPass,
  type SkyMoonConfig,
} from '@margoengine/scenery';
import { invert } from '../../../packages/shared/math.js';
import { createCitadel, moonDirection, moonShadowMatrix } from './scene.js';
import { frameDue } from './frame-timing.js';
import geometrySource from './citadel.wgsl?raw';
import presentSource from './present.wgsl?raw';
import './style.css';

declare const GPUBufferUsage: {
  UNIFORM: number;
  COPY_DST: number;
  VERTEX: number;
  INDEX: number;
};
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
};
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('scene'),
  status = element<HTMLParagraphElement>('status');
const orbit = element<HTMLInputElement>('orbit'),
  cadence = element<HTMLSelectElement>('cadence');
const controls = ['azimuth', 'elevation', 'phase', 'haze', 'stars', 'glow'].map(
  (id) => element<HTMLInputElement>(id),
);
const values = controls.map((input) =>
  element<HTMLOutputElement>(input.id + '-value'),
);
const fpsText = element<HTMLOutputElement>('fps').firstChild as Text,
  deltaText = element<HTMLOutputElement>('delta').firstChild as Text;
const fpsLabels = Array.from({ length: 241 }, (_, i) => String(i)),
  deltaLabels = Array.from({ length: 1001 }, (_, i) => (i / 10).toFixed(1));

export class NightCitadel {
  readonly eye: [number, number, number] = [0, 0, 0];
  readonly camera = new Camera({
    position: this.eye,
    target: [0, 12, 0],
    fov: 58,
    near: 0.3,
    far: 500,
  });
  readonly moon: [number, number, number] = [0, 1, 0];
  readonly frameData = new Float32Array(48);
  readonly inverse = new Float32Array(16);
  private readonly inverseWorkspace = new Float64Array(52);
  private readonly lightMatrix = new Float32Array(16);
  // Retained numeric storage also avoids boxing captured camera/timing scalars on every callback.
  readonly motion = new Float64Array([0.65, -0.03, 82, 0, 0, 0, 0, 0, 0, 0]);
  private readonly clock = new Float64Array(3);
  readonly pointers = new Float64Array([-1, 0, 0, -1, 0, 0, 0]);
  readonly stats = { frames: 0, drawCalls: 0, instances: 0, fps: 0, delta: 0 };
  readonly batches = createCitadel();
  readonly target: HDRRenderTarget;
  readonly sky: SkyMoonPass;
  readonly shadow: GPUTexture;
  readonly geometryModule: GPUShaderModule;
  readonly presentModule: GPUShaderModule;
  private readonly buffers: GPUBuffer[] = [];
  private readonly uniform: GPUBuffer;
  private readonly presentPipeline: GPURenderPipeline;
  private presentGroup!: GPUBindGroup;
  private readonly shadowBundles: GPURenderBundle[] = [];
  private readonly beautyBundles: GPURenderBundle[] = [];
  private readonly commands: GPUCommandBuffer[] = [];
  private readonly shadowDescriptor: GPURenderPassDescriptor;
  private readonly beautyDescriptor: GPURenderPassDescriptor;
  private readonly presentAttachment: GPURenderPassColorAttachment;
  private readonly presentDescriptor: GPURenderPassDescriptor;
  private readonly events = new AbortController();
  private readonly observer: ResizeObserver;
  private readonly skyConfig: SkyMoonConfig;
  private readonly horizon: [number, number, number];
  private readonly baseHorizon: Float32Array;
  private raf = 0;
  private targetRate = 60;
  private aspect = 1;
  private projectionShift = 0;
  disposed = false;

  constructor(
    readonly device: GPUDevice,
    readonly context: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    this.target = new HDRRenderTarget(device, 1, 1);
    this.sky = new SkyMoonPass(device, 'rgba16float', this.target.depth.format);
    const zenith = new PbrMaterial({ color: '#020512' }).data;
    this.baseHorizon = new PbrMaterial({ color: '#11162b' }).data;
    this.horizon = [
      this.baseHorizon[0],
      this.baseHorizon[1],
      this.baseHorizon[2],
    ];
    const lunar = new PbrMaterial({ color: '#e2eeff' }).data;
    this.skyConfig = {
      zenithColor: [zenith[0], zenith[1], zenith[2]],
      horizonColor: this.horizon,
      moonColor: [lunar[0], lunar[1], lunar[2]],
      moonDirection: this.moon,
      moonSize: 0.035,
      starIntensity: 1,
    };
    this.uniform = this.upload(this.frameData, GPUBufferUsage.UNIFORM);
    this.shadow = device.createTexture({
      label: 'Citadel lunar shadow',
      size: [2048, 2048],
      format: 'depth32float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const shadowView = this.shadow.createView();
    const frameLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: 192 },
        },
      ],
    });
    const beautyLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: 192 },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'comparison' },
        },
      ],
    });
    const frameGroup = device.createBindGroup({
      layout: frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniform } }],
    });
    const beautyGroup = device.createBindGroup({
      layout: beautyLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: shadowView },
        {
          binding: 2,
          resource: device.createSampler({
            compare: 'greater-equal',
            magFilter: 'nearest',
            minFilter: 'nearest',
          }),
        },
      ],
    });
    this.geometryModule = device.createShaderModule({
      label: 'Moonlit masonry',
      code: geometrySource,
    });
    const vertices: GPUVertexBufferLayout[] = [
      {
        arrayStride: 24,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ],
      },
      {
        arrayStride: 96,
        stepMode: 'instance',
        attributes: Array.from({ length: 6 }, (_, i) => ({
          shaderLocation: i + 2,
          offset: i * 16,
          format: 'float32x4' as const,
        })),
      },
    ];
    const shadowPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout] }),
      vertex: {
        module: this.geometryModule,
        entryPoint: 'shadow_vertex',
        buffers: vertices,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'greater-equal',
      },
    });
    const beautyPipeline = device.createRenderPipeline({
      multisample:{count:this.target.samples},
      layout: device.createPipelineLayout({ bindGroupLayouts: [beautyLayout] }),
      vertex: {
        module: this.geometryModule,
        entryPoint: 'vertex',
        buffers: vertices,
      },
      fragment: {
        module: this.geometryModule,
        entryPoint: 'fragment',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this.target.depth.format,
        depthWriteEnabled: true,
        depthCompare: 'greater-equal',
      },
    });
    const lanternPipeline = device.createRenderPipeline({
      multisample:{count:this.target.samples},
      layout: device.createPipelineLayout({ bindGroupLayouts: [beautyLayout] }),
      vertex: {
        module: this.geometryModule,
        entryPoint: 'vertex',
        buffers: vertices,
      },
      fragment: {
        module: this.geometryModule,
        entryPoint: 'lantern_fragment',
        targets: [
          {
            format: 'rgba16float',
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: this.target.depth.format,
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
    });
    const shadowBundle = device.createRenderBundleEncoder({
        colorFormats: [],
        depthStencilFormat: 'depth32float',
      }),
      beautyBundle = device.createRenderBundleEncoder({
        colorFormats: ['rgba16float'],
        sampleCount:this.target.samples,
        depthStencilFormat: this.target.depth.format,
      });
    shadowBundle.setPipeline(shadowPipeline);
    shadowBundle.setBindGroup(0, frameGroup);
    beautyBundle.setPipeline(beautyPipeline);
    beautyBundle.setBindGroup(0, beautyGroup);
    this.stats.drawCalls = 2;
    for (const batch of this.batches) {
      const vertex = this.upload(
          batch.geometry.vertices,
          GPUBufferUsage.VERTEX,
        ),
        index = this.upload(batch.geometry.indices, GPUBufferUsage.INDEX),
        instances = this.upload(batch.instances, GPUBufferUsage.VERTEX);
      if (batch.glow) beautyBundle.setPipeline(lanternPipeline);
      for (const bundle of batch.glow
        ? [beautyBundle]
        : [shadowBundle, beautyBundle]) {
        bundle.setVertexBuffer(0, vertex);
        bundle.setVertexBuffer(1, instances);
        bundle.setIndexBuffer(index, 'uint32');
        bundle.drawIndexed(batch.geometry.indices.length, batch.count);
        this.stats.drawCalls++;
      }
      this.stats.instances += batch.count;
    }
    this.shadowBundles.push(shadowBundle.finish());
    this.beautyBundles.push(beautyBundle.finish());
    element<HTMLOutputElement>('draws').value = String(this.stats.drawCalls);
    this.presentModule = device.createShaderModule({ code: presentSource });
    this.presentPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: this.presentModule, entryPoint: 'vertex' },
      fragment: {
        module: this.presentModule,
        entryPoint: 'fragment',
        targets: [{ format }],
      },
    });
    this.shadowDescriptor = {
      colorAttachments: [],
      depthStencilAttachment: {
        view: shadowView,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    };
    this.beautyDescriptor = {
      colorAttachments: [
        {
          view: this.target.scene.color,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.target.scene.depth,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    };
    this.presentAttachment = {
      view: this.target.color.createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    };
    this.presentDescriptor = { colorAttachments: [this.presentAttachment] };
    this.resize();
    this.updateSky();
    orbit.checked = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const options = { signal: this.events.signal };
    for (const input of controls)
      input.addEventListener('input', this.updateSky, options);
    cadence.addEventListener(
      'change',
      () => {
        this.targetRate = Number(cadence.value);
        this.clock.fill(0);
      },
      options,
    );
    canvas.addEventListener('pointerdown', this.pointerDown, options);
    canvas.addEventListener('pointermove', this.pointerMove, options);
    canvas.addEventListener('pointerup', this.pointerUp, options);
    canvas.addEventListener('pointercancel', this.pointerUp, options);
    canvas.addEventListener('lostpointercapture', this.pointerUp, options);
    canvas.addEventListener('wheel', this.wheel, {
      ...options,
      passive: false,
    });
    canvas.addEventListener('keydown', this.keyDown, options);
    element('reset').addEventListener('click', this.reset, options);
    document.addEventListener('visibilitychange', this.visibility, options);
    window.addEventListener('pagehide', this.dispose, options);
    device.addEventListener('uncapturederror', this.gpuError, options);
    void device.lost.then((info) => {
      if (!this.disposed)
        this.fail(
          new Error(info.message || 'WebGPU device lost. Reload to reconnect.'),
        );
    });
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    this.start();
  }

  private upload(data: Float32Array | Uint32Array, usage: number): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    this.buffers.push(buffer);
    this.device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
    return buffer;
  }

  private readonly updateSky = (): void => {
    moonDirection(
      this.moon,
      controls[0].valueAsNumber,
      controls[1].valueAsNumber,
    );
    const phase = controls[2].valueAsNumber,
      haze = controls[3].valueAsNumber;
    this.skyConfig.moonPhase = phase;
    this.skyConfig.starTwinkleIntensity = controls[4].valueAsNumber;
    this.skyConfig.glowIntensity = controls[5].valueAsNumber;
    this.skyConfig.hazeDensity = haze * 3;
    for (let i = 0; i < 3; i++)
      this.horizon[i] =
        this.baseHorizon[i] * (0.55 + haze * 1.3) * (1 + 0.12 * this.moon[1]);
    this.sky.setConfig(this.skyConfig);
    moonShadowMatrix(this.lightMatrix, this.moon);
    this.frameData.set(this.lightMatrix, 16);
    this.frameData.set(this.moon, 36);
    this.frameData[39] = 0.2 + (phase + 1) * 0.65;
    this.frameData[40] = 0.12;
    this.frameData[41] = 0.155;
    this.frameData[42] = 0.23;
    this.frameData.set(this.horizon, 44);
    this.frameData[47] = haze * 0.0075;
    for (let i = 0; i < controls.length; i++)
      values[i].value =
        i < 2 ? controls[i].value + '°' : controls[i].valueAsNumber.toFixed(2);
  };

  readonly resize = (): void => {
    if (this.disposed) return;
    const dpr = Math.min(devicePixelRatio, 1.5),
      limit = Math.min(4096, this.device.limits.maxTextureDimension2D),
      w = Math.max(1, Math.min(limit, Math.round(canvas.clientWidth * dpr))),
      h = Math.max(1, Math.min(limit, Math.round(canvas.clientHeight * dpr)));
    if (w === canvas.width && h === canvas.height && this.target.width === w)
      return;
    this.target.resize(w, h);
    canvas.width = w;
    canvas.height = h;
    this.aspect = w / h;
    this.projectionShift = canvas.clientWidth > 700 ? 0.12 : 0;
    (
      this.beautyDescriptor.colorAttachments as GPURenderPassColorAttachment[]
    )[0].view = this.target.scene.color;
    this.beautyDescriptor.depthStencilAttachment!.view =
      this.target.scene.depth;
    this.presentGroup = this.device.createBindGroup({
      layout: this.presentPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.target.color.createView() }],
    });
  };

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const m = this.motion,
      interval = 1000 / this.targetRate,
      elapsed = m[6] ? now - m[6] : interval;
    if (!frameDue(this.clock, now, this.targetRate)) return;
    const dt = m[6] ? Math.min(0.05, elapsed * 0.001) : interval * 0.001;
    m[6] = now;
    const decay = Math.exp(-8 * dt);
    if (orbit.checked) m[0] += 0.025 * dt;
    m[0] += m[3] * dt;
    m[1] = Math.max(-0.08, Math.min(1.2, m[1] + m[4] * dt));
    m[2] = Math.max(42, Math.min(140, m[2] + m[5] * dt));
    m[3] *= decay;
    m[4] *= decay;
    m[5] *= decay;
    const horizontal = Math.cos(m[1]) * m[2];
    this.eye[0] = Math.sin(m[0]) * horizontal;
    this.eye[1] = 12 + Math.sin(m[1]) * m[2];
    this.eye[2] = Math.cos(m[0]) * horizontal;
    this.camera.update(this.aspect, true);
    for (let c = 0; c < 4; c++)
      this.camera.matrix[c * 4] -=
        this.projectionShift * this.camera.matrix[c * 4 + 3];
    if (!invert(this.inverse, this.camera.matrix, 0, this.inverseWorkspace)) {
      this.fail(new Error('Camera matrix cannot be inverted'));
      return;
    }
    this.frameData.set(this.camera.matrix, 0);
    this.frameData.set(this.eye, 32);
    this.device.queue.writeBuffer(
      this.uniform,
      0,
      this.frameData as Float32Array<ArrayBuffer>,
    );
    this.sky.updateFrame(this.inverse, this.eye, now * 0.001);
    // WebGPU command handles are unavoidable; scene arrays, descriptors and draw bundles stay retained.
    const encoder = this.device.createCommandEncoder();
    const shadow = encoder.beginRenderPass(this.shadowDescriptor);
    shadow.executeBundles(this.shadowBundles);
    shadow.end();
    const beauty = encoder.beginRenderPass(this.beautyDescriptor);
    this.sky.record(beauty,this.target.samples);
    beauty.executeBundles(this.beautyBundles);
    beauty.end();
    this.target.scene.resolve(encoder,true);
    this.presentAttachment.view = this.context.getCurrentTexture().createView();
    const present = encoder.beginRenderPass(this.presentDescriptor);
    present.setPipeline(this.presentPipeline);
    present.setBindGroup(0, this.presentGroup);
    present.draw(3);
    present.end();
    this.commands[0] = encoder.finish();
    this.device.queue.submit(this.commands);
    this.stats.frames++;
    m[7]++;
    m[8] += elapsed;
    if (now - m[9] >= 500) {
      this.stats.delta = m[8] / m[7];
      this.stats.fps = 1000 / this.stats.delta;
      fpsText.nodeValue =
        fpsLabels[Math.max(0, Math.min(240, Math.round(this.stats.fps)))];
      deltaText.nodeValue =
        deltaLabels[
          Math.max(0, Math.min(1000, Math.round(this.stats.delta * 10)))
        ];
      m[7] = 0;
      m[8] = 0;
      m[9] = now;
    }
  };

  readonly start = (): void => {
    if (!this.raf && !this.disposed) {
      this.motion[6] = 0;
      this.motion[7] = 0;
      this.motion[8] = 0;
      this.clock.fill(0);
      this.motion[9] = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  };
  readonly stop = (): void => {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  };
  private readonly visibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };
  private readonly reset = (): void => {
    this.motion[0] = 0.65;
    this.motion[1] = -0.03;
    this.motion[2] = 82;
    this.motion[3] = this.motion[4] = this.motion[5] = 0;
  };
  private readonly pointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const p = this.pointers,
      slot = p[0] < 0 ? 0 : p[3] < 0 ? 3 : -1;
    if (slot < 0) return;
    p[slot] = e.pointerId;
    p[slot + 1] = e.clientX;
    p[slot + 2] = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    orbit.checked = false;
    p[6] = p[0] >= 0 && p[3] >= 0 ? Math.hypot(p[1] - p[4], p[2] - p[5]) : 0;
  };
  private readonly pointerMove = (e: PointerEvent): void => {
    const p = this.pointers,
      slot = p[0] === e.pointerId ? 0 : p[3] === e.pointerId ? 3 : -1;
    if (slot < 0) return;
    const dx = e.clientX - p[slot + 1],
      dy = e.clientY - p[slot + 2];
    p[slot + 1] = e.clientX;
    p[slot + 2] = e.clientY;
    if (p[0] >= 0 && p[3] >= 0) {
      const length = Math.hypot(p[1] - p[4], p[2] - p[5]);
      if (p[6] > 0)
        this.motion[2] = Math.max(
          42,
          Math.min(140, (this.motion[2] * p[6]) / Math.max(1, length)),
        );
      p[6] = length;
      this.motion[3] = this.motion[4] = 0;
    } else {
      this.motion[3] = -dx * 0.16;
      this.motion[4] = dy * 0.13;
    }
  };
  private readonly pointerUp = (e: PointerEvent): void => {
    const p = this.pointers;
    if (p[0] === e.pointerId) p[0] = -1;
    if (p[3] === e.pointerId) p[3] = -1;
    p[6] = 0;
  };
  private readonly wheel = (e: WheelEvent): void => {
    e.preventDefault();
    const delta =
      e.deltaY *
      (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1);
    this.motion[5] += Math.max(-200, Math.min(200, delta * 0.25));
  };
  private readonly keyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.motion[3] = e.key === 'ArrowLeft' ? -1 : 1;
      orbit.checked = false;
      e.preventDefault();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      this.motion[4] = e.key === 'ArrowUp' ? -0.6 : 0.6;
      orbit.checked = false;
      e.preventDefault();
    } else if (e.key === '+' || e.key === '=') this.motion[5] = -50;
    else if (e.key === '-') this.motion[5] = 50;
  };
  private readonly gpuError = (e: GPUUncapturedErrorEvent): void => {
    this.fail(e.error);
  };
  private fail(error: { message: string }): void {
    status.hidden = false;
    status.setAttribute('role', 'alert');
    status.textContent = error.message;
    this.dispose();
  }
  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.events.abort();
    this.observer?.disconnect();
    for (const buffer of this.buffers) buffer.destroy();
    this.sky.dispose();
    this.shadow.destroy();
    this.target.dispose();
    this.context.unconfigure();
    this.device.destroy();
  };
}

declare global {
  interface Window {
    nightCitadel?: NightCitadel;
  }
}
async function boot(): Promise<void> {
  let device: GPUDevice | undefined;
  try {
    if (!navigator.gpu)
      throw new Error(
        'This showcase needs WebGPU. Open it in a WebGPU-enabled browser on localhost or HTTPS.',
      );
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) throw new Error('WebGPU canvas is unavailable.');
    context.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'opaque',
    });
    window.nightCitadel = new NightCitadel(
      device,
      context,
      navigator.gpu.getPreferredCanvasFormat(),
    );
    status.hidden = true;
  } catch (error) {
    device?.destroy();
    status.hidden = false;
    status.setAttribute('role', 'alert');
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}
void boot();
if (import.meta.hot)
  import.meta.hot.dispose(() => window.nightCitadel?.dispose());
