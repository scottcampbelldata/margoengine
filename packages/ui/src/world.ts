/// <reference lib="esnext.disposable" preserve="true" />
import { requireWebGPU } from '../../shared/require-webgpu.js';
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { unprojectPoint } from '@margoengine/math';
import { rangeError, typeError } from '../../shared/errors.js';
import { generateMipmaps } from '../../shared/mipmaps.js';
import { overlayPass } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';
import { attachPointer, detacher, listener, type Detach } from './dom.js';
import type { PointerInfo } from './interaction.js';
import { PREMULTIPLIED, UiPainter } from './painter.js';
import type { Ui } from './ui.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

type GpuContext = Extract<PassContext, { backend: 'webgpu' }>;
type Vec3 = readonly [number, number, number];

/** A ray in world space; `direction` need not be unit length. */
export interface UiRay {
  origin: ArrayLike<number>;
  direction: ArrayLike<number>;
}

/** Where a ray meets a {@link WorldPanel}. */
export interface PanelHit {
  /** Distance along the ray in units of its direction's length (metres for a unit direction). */
  distance: number;
  /** The world point. */
  point: [number, number, number];
  /** The point in the panel's UI, in CSS pixels from its top left (as `ui.pointerMove` takes them). */
  x: number;
  y: number;
  /** True when the point lies on the panel rather than elsewhere on its plane. */
  inside: boolean;
  /** True when the ray comes from the panel's back (only a double-sided panel is hit there). */
  back: boolean;
}

/** Options for {@link WorldPanel}. */
export interface WorldPanelOptions {
  /** Width in world units (metres with glTF scenes). Default 1. */
  width?: number;
  /** Height in world units. Default: the width times the UI's height over its width, so the UI keeps its shape. */
  height?: number;
  /** Centre of the panel. Default `[0, 0, 0]`. */
  position?: Vec3;
  /** Orientation as a unit quaternion `[x, y, z, w]`; the UI faces +Z with +Y up. Default `[0, 0, 0, 1]`. */
  rotation?: readonly [number, number, number, number];
  /** Texture pixels per CSS pixel of the UI: higher is sharper up close and costs memory. Default 1. */
  pixelRatio?: number;
  /** Show (and take input on) the back too, mirrored so its text reads right. Default false: the back is invisible. */
  doubleSided?: boolean;
}

/**
 * A {@link Ui} on a flat rectangle in the 3D scene: a diegetic screen, a VR menu or a wrist panel. The UI keeps its CSS
 * pixel size (`new Ui({ width, height })`) and is drawn into a texture that a {@link WorldPanels} renderer puts in the
 * scene, depth-tested against it. Pointer, touch and XR controller rays reach its widgets through `pointerMove`,
 * `pointerDown` and `pointerUp`, which take a ray instead of a point.
 *
 * `matrix` is the panel's pose (column-major, rigid); set `position` and `rotation`, or copy a pose into `matrix` (an XR
 * grip, say) and call nothing else. Width and height are in world units along the matrix's X and Y axes.
 *
 * @example
 * const menu = new Ui({ width: 640, height: 400 });
 * const panel = new WorldPanel(menu, { width: 1.6, position: [0, 1.5, -2] });
 * WorldPanels.attach(engine).add(panel);
 */
export class WorldPanel {
  /** The pose: column-major, rotation and translation only. */
  readonly matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  /** Width in world units. */
  width: number;
  /** Height in world units. */
  height: number;
  /** Draw and hit the back as well. */
  doubleSided: boolean;
  /** Hidden panels are neither drawn nor hit. Default true. */
  visible = true;
  /** Texture pixels per CSS pixel. */
  readonly pixelRatio: number;
  /** The UI's size in CSS pixels, fixed when the panel is made. */
  readonly cssWidth: number;
  readonly cssHeight: number;

  /**
   * @throws TypeError for a missing `ui`.
   * @throws RangeError for a size or pixel ratio that is not finite and positive, or a rotation that is not a unit quaternion.
   */
  constructor(
    readonly ui: Ui,
    options: WorldPanelOptions = {},
  ) {
    if (!ui || typeof ui.draw !== 'function') throw typeError('WorldPanel needs a Ui: new WorldPanel(new Ui())', 'ui');
    this.cssWidth = ui.width * ui.cssScale;
    this.cssHeight = ui.height * ui.cssScale;
    this.pixelRatio = options.pixelRatio ?? 1;
    this.width = options.width ?? 1;
    this.height = options.height ?? (this.width * this.cssHeight) / this.cssWidth;
    this.doubleSided = options.doubleSided ?? false;
    for (const value of [this.pixelRatio, this.width, this.height])
      if (!(value > 0) || !Number.isFinite(value))
        throw rangeError(
          'WorldPanel width, height and pixelRatio must be finite and above 0; pass numbers such as { width: 1.2, pixelRatio: 2 }',
          'ui',
        );
    this.setPose(options.position ?? [0, 0, 0], options.rotation ?? [0, 0, 0, 1]);
    ui.resize(this.cssWidth, this.cssHeight, this.pixelRatio);
  }

  /**
   * Place the panel: centre `position`, orientation `rotation` (a unit quaternion `[x, y, z, w]`).
   * @throws RangeError for non-finite values or a quaternion whose length is not 1.
   */
  setPose(position: Vec3, rotation: readonly [number, number, number, number]): void {
    const [x, y, z, w] = rotation;
    if (![...position, x, y, z, w].every(Number.isFinite) || Math.abs(x * x + y * y + z * z + w * w - 1) > 1e-3)
      throw rangeError(
        'WorldPanel position must be finite and rotation a unit quaternion [x, y, z, w]; normalize the rotation',
        'ui',
      );
    const m = this.matrix;
    m[0] = 1 - 2 * (y * y + z * z);
    m[1] = 2 * (x * y + z * w);
    m[2] = 2 * (x * z - y * w);
    m[4] = 2 * (x * y - z * w);
    m[5] = 1 - 2 * (x * x + z * z);
    m[6] = 2 * (y * z + x * w);
    m[8] = 2 * (x * z + y * w);
    m[9] = 2 * (y * z - x * w);
    m[10] = 1 - 2 * (x * x + y * y);
    m[12] = position[0];
    m[13] = position[1];
    m[14] = position[2];
    m[3] = m[7] = m[11] = 0;
    m[15] = 1;
  }

  /** The side `eye` is on: +1 in front, -1 behind, 0 on the plane. */
  side(eye: ArrayLike<number>): number {
    const m = this.matrix;
    return Math.sign((eye[0] - m[12]) * m[8] + (eye[1] - m[13]) * m[9] + (eye[2] - m[14]) * m[10]);
  }

  /**
   * Where `ray` meets the panel's plane, or null when it runs parallel to it, points away from it, or comes from a
   * one-sided panel's back. `inside` says whether the point is on the panel itself.
   */
  intersect(ray: UiRay): PanelHit | null {
    const m = this.matrix,
      o = ray.origin,
      d = ray.direction;
    // Plane through the centre with normal +Z of the pose; the in-plane axes are the pose's X and Y.
    const nx = m[8],
      ny = m[9],
      nz = m[10],
      facing = (o[0] - m[12]) * nx + (o[1] - m[13]) * ny + (o[2] - m[14]) * nz,
      dn = d[0] * nx + d[1] * ny + d[2] * nz;
    if (!(Math.abs(dn) > 1e-12) || !Number.isFinite(facing)) return null;
    const t = -facing / dn;
    if (!(t >= 0)) return null;
    const back = facing < 0;
    if (back && !this.doubleSided) return null;
    const px = o[0] + d[0] * t,
      py = o[1] + d[1] * t,
      pz = o[2] + d[2] * t,
      rx = px - m[12],
      ry = py - m[13],
      rz = pz - m[14],
      lx = (rx * m[0] + ry * m[1] + rz * m[2]) / (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]),
      ly = (rx * m[4] + ry * m[5] + rz * m[6]) / (m[4] * m[4] + m[5] * m[5] + m[6] * m[6]);
    let u = lx / this.width + 0.5;
    const v = 0.5 - ly / this.height;
    // Seen from behind, a double-sided panel shows its UI mirrored back to reading order.
    if (back) u = 1 - u;
    return {
      distance: t,
      point: [px, py, pz],
      x: u * this.cssWidth,
      y: v * this.cssHeight,
      inside: u >= 0 && u <= 1 && v >= 0 && v <= 1,
      back,
    };
  }

  /** Hover with a ray (a mouse, or a controller's pointing ray). Returns true when the UI used it. */
  pointerMove(ray: UiRay, info?: PointerInfo): boolean {
    const hit = this.intersect(ray);
    if (!hit) {
      this.ui.pointerLeave();
      return false;
    }
    return this.ui.pointerMove(hit.x, hit.y, info);
  }

  /** Press with a ray. Returns true when it landed on a widget; otherwise the game should have it. */
  pointerDown(ray: UiRay, info?: PointerInfo): boolean {
    const hit = this.intersect(ray);
    return !!hit && hit.inside && this.ui.pointerDown(hit.x, hit.y, info);
  }

  /** Release with a ray. Returns true when it ends a press that began on the UI; a ray off the panel still ends it. */
  pointerUp(ray: UiRay, info?: PointerInfo): boolean {
    const hit = this.intersect(ray);
    return hit ? this.ui.pointerUp(hit.x, hit.y, info) : this.ui.pointerUp(-1e9, -1e9, info);
  }
}

/**
 * The world ray under a point of the canvas: from the camera's `position` through (`x`, `y`) CSS pixels of a
 * `width` by `height` view, for core's perspective `engine.camera` (its matrix is set once a frame has been drawn).
 * @throws TypeError for a camera without a 16-element matrix; RangeError for one with no inverse yet.
 */
export function screenRay(
  camera: { readonly matrix: ArrayLike<number>; readonly position: ArrayLike<number> },
  x: number,
  y: number,
  width: number,
  height: number,
): UiRay {
  // Depth 0.5 lies between near and far on both depth conventions (WebGPU 1 to 0, WebGL -1 to 1).
  const p = unprojectPoint({ x: (x / width) * 2 - 1, y: 1 - (y / height) * 2, z: 0.5 }, camera, { x: 0, y: 0, z: 0 });
  const o = camera.position;
  if (!p) return { origin: [o[0], o[1], o[2]], direction: [0, 0, -1] };
  const dx = p.x - o[0],
    dy = p.y - o[1],
    dz = p.z - o[2],
    length = Math.hypot(dx, dy, dz) || 1;
  return { origin: [o[0], o[1], o[2]], direction: [dx / length, dy / length, dz / length] };
}

/** An XR pointing ray from a column-major pose matrix (WebXR's target ray space points along its -Z axis). */
export function rayFromMatrix(matrix: ArrayLike<number>): UiRay {
  const length = Math.hypot(matrix[8], matrix[9], matrix[10]) || 1;
  return {
    origin: [matrix[12], matrix[13], matrix[14]],
    direction: [-matrix[8] / length, -matrix[9] / length, -matrix[10] / length],
  };
}

/** The nearest visible panel that `ray` lands on, with the hit, or null. */
export function pickPanel(panels: Iterable<WorldPanel>, ray: UiRay): { panel: WorldPanel; hit: PanelHit } | null {
  let best: { panel: WorldPanel; hit: PanelHit } | null = null;
  for (const panel of panels) {
    if (!panel.visible) continue;
    const hit = panel.intersect(ray);
    if (hit?.inside && (!best || hit.distance < best.hit.distance)) best = { panel, hit };
  }
  return best;
}

/** A controller as `@margoengine/xr`'s `XRController` has it: a target-ray pose and button values. */
export interface RayController {
  /** Column-major pose of the pointing ray; all zero when untracked. */
  readonly targetRayMatrix: ArrayLike<number>;
  /** Per button: value, pressed, touched. Button 0 (the trigger) presses. */
  readonly buttons: ArrayLike<number>;
}

/** Options for {@link WorldPanels}. */
export interface WorldPanelsOptions {
  /** Plugin name, unique per engine. Default `'ui-world'`. */
  name?: string;
  /** Frame graph order. Default 25: after the scene and lines, before post-processing resolves at 30, so panels are part of the picture. */
  order?: number;
  /** Route the canvas's mouse, pen and touch to the panels by camera ray. Default true. */
  input?: boolean;
  /** Detach the canvas listeners when the signal aborts. */
  signal?: AbortSignal;
}

interface PointerState {
  hover: WorldPanel | null;
  captured: WorldPanel | null;
  pressed: boolean;
}

interface PanelGpu {
  texture: GPUTexture;
  view: GPUTextureView;
  levels: number;
  painter: UiPainter;
  uniform: GPUBuffer;
  group: GPUBindGroup;
  painted: number;
  atlas: string;
}

const PANEL_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

/**
 * Engine plugin that draws {@link WorldPanel}s in the scene and routes rays to them. Each frame it steps every panel's
 * UI, redraws a panel's texture only when its UI changed (with mipmaps, so a distant panel does not shimmer), and draws
 * each visible panel as a depth-tested quad in every view, XR eyes included. With `input` (the default) a mouse, pen or
 * touch on the canvas reaches the nearest panel under it, and an event a panel used does not reach the game; call
 * {@link WorldPanels.controller} each frame for each XR controller.
 *
 * WebGPU only; on WebGL2 the panels still update and take rays, but nothing is drawn.
 *
 * @example
 * const panels = WorldPanels.attach(engine);
 * panels.add(new WorldPanel(menuUi, { width: 1.2, position: [0, 1.4, -1.5] }));
 * xr.onFrame(() => panels.controller(xr.controllers[0], 1)); // trigger presses, the ray hovers
 */
export class WorldPanels implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  /** Counts for the latest frame: panels drawn, panel textures redrawn and draw calls. */
  readonly stats = { panels: 0, repaints: 0, drawCalls: 0 };
  private readonly panels = new Set<WorldPanel>();
  private readonly gpu = new Map<WorldPanel, PanelGpu>();
  private readonly pointers = new Map<number, PointerState>();
  private readonly input: boolean;
  private readonly signal?: AbortSignal;
  private readonly descriptor = overlayPass();
  private readonly cameras: { buffer: GPUBuffer; group: GPUBindGroup }[] = [];
  private readonly cameraData = new Float32Array(20);
  private readonly panelData = new Float32Array(20);
  private readonly mipCache = new Map<unknown, unknown>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private engine?: Engine;
  private device?: GPUDevice;
  private module?: GPUShaderModule;
  private panelLayout?: GPUBindGroupLayout;
  private cameraLayout?: GPUBindGroupLayout;
  private pipelineLayout?: GPUPipelineLayout;
  private sampler?: GPUSampler;
  private detach?: Detach;
  private frameDrawn = -1;
  private frame = 0;

  /** Same as `engine.use(new WorldPanels(options))`; returns the plugin. */
  static attach(engine: EngineKernel, options?: WorldPanelsOptions): WorldPanels {
    const value = new WorldPanels(options);
    engine.use(value);
    return value;
  }

  /** @throws TypeError for an empty name or a non-finite order. */
  constructor(options: WorldPanelsOptions = {}) {
    this.name = options.name ?? 'ui-world';
    this.order = options.order ?? 25;
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order))
      throw typeError(
        'WorldPanels needs a non-empty name and a finite order; pass a name string and an order number',
        'ui',
      );
    this.input = options.input ?? true;
    this.signal = options.signal;
  }

  /** Add panels; returns this. */
  add(...panels: WorldPanel[]): this {
    for (const panel of panels) {
      if (!(panel instanceof WorldPanel))
        throw typeError('WorldPanels.add takes WorldPanel objects; wrap the Ui first: new WorldPanel(ui)', 'ui');
      this.panels.add(panel);
    }
    return this;
  }

  /** Remove a panel and free its texture. The panel's `Ui` is not disposed. */
  remove(panel: WorldPanel): void {
    this.panels.delete(panel);
    this.release(panel);
    for (const state of this.pointers.values()) {
      if (state.hover === panel) state.hover = null;
      if (state.captured === panel) state.captured = null;
    }
  }

  /** The panels, in the order they were added. */
  get list(): readonly WorldPanel[] {
    return [...this.panels];
  }

  /**
   * One pointer's ray and button state, from any device: hovers the nearest panel under the ray, leaves the one it
   * left, and on a change of `pressed` presses or releases. A pressed pointer stays with the panel it pressed until it
   * is released, even off the panel (dragging a slider). Returns true when a panel used it.
   */
  pointer(ray: UiRay, pressed: boolean, info: PointerInfo = {}): boolean {
    const id = info.id ?? 0;
    let state = this.pointers.get(id);
    if (!state) this.pointers.set(id, (state = { hover: null, captured: null, pressed: false }));
    const wasPressed = state.pressed;
    state.pressed = pressed;
    if (state.captured) {
      const panel = state.captured;
      if (pressed) return panel.pointerMove(ray, info) || true;
      state.captured = null;
      return panel.pointerUp(ray, info);
    }
    const picked = pickPanel(this.panels, ray),
      panel = picked?.panel ?? null;
    if (state.hover && state.hover !== panel) state.hover.ui.pointerLeave();
    state.hover = panel;
    if (!panel) return false;
    const used = panel.ui.pointerMove(picked!.hit.x, picked!.hit.y, info);
    if (pressed && !wasPressed && panel.ui.pointerDown(picked!.hit.x, picked!.hit.y, info)) {
      state.captured = panel;
      return true;
    }
    if (!pressed && wasPressed) return panel.ui.pointerUp(picked!.hit.x, picked!.hit.y, info);
    return used;
  }

  /**
   * Feed an XR controller (or anything with a target-ray pose and buttons) for this frame: its ray hovers, button 0 (the
   * trigger) presses. `id` keeps two hands apart. An untracked controller (all-zero pose) leaves the panels.
   */
  controller(source: RayController, id = 1): boolean {
    const m = source.targetRayMatrix;
    if (!m[15]) {
      const state = this.pointers.get(id);
      if (state?.captured) state.captured.ui.pointerCancel();
      state?.hover?.ui.pointerLeave();
      this.pointers.delete(id);
      return false;
    }
    return this.pointer(rayFromMatrix(m), source.buttons[1] > 0, { id, type: 'pen' });
  }

  /** Take a press away from every panel (the canvas lost focus, an XR session ended). */
  cancel(): void {
    for (const state of this.pointers.values()) state.captured?.ui.pointerCancel();
    for (const state of this.pointers.values()) state.hover?.ui.pointerLeave();
    this.pointers.clear();
  }

  setup(engine: Engine): void {
    requireWebGPU(engine, 'WorldPanels');
    this.engine = engine;
    const canvas = (engine as unknown as { canvas?: HTMLElement }).canvas;
    if (this.input && canvas && !this.detach) this.detach = this.listen(canvas);
    const device = (this.device = engine.gpu),
      both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.panelLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform', minBindingSize: 80 } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.cameraLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', minBindingSize: 80 } }],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.panelLayout, this.cameraLayout] });
    this.module = device.createShaderModule({ code: panelShader });
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 4,
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: this.execute });
  }

  onPreUpdate(delta: number): void {
    this.frame++;
    for (const panel of this.panels) panel.ui.update(delta);
  }

  /** Mouse, pen and touch on the canvas, as screen rays from the engine's camera. */
  private listen(canvas: HTMLElement): Detach {
    const cleanups: (() => void)[] = [];
    const ray = (x: number, y: number) => {
      const camera = (this.engine as unknown as EngineKernel).camera;
      return screenRay(camera, x, y, canvas.clientWidth || 1, canvas.clientHeight || 1);
    };
    const down = new Set<number>();
    attachPointer(
      {
        pointerMove: (x, y, info) => this.pointer(ray(x, y), down.has(info.id ?? 0), info),
        pointerDown: (x, y, info) => {
          if (info.button) return false;
          down.add(info.id ?? 0);
          const used = this.pointer(ray(x, y), true, info);
          if (!used) down.delete(info.id ?? 0);
          return used;
        },
        pointerUp: (x, y, info) => {
          if (!down.delete(info.id ?? 0)) return false;
          return this.pointer(ray(x, y), false, info);
        },
        pointerCancel: () => {
          down.clear();
          this.cancel();
        },
        pointerLeave: () => {
          for (const state of this.pointers.values()) if (!state.captured) state.hover?.ui.pointerLeave();
        },
        wheel: (x, y, dy) => {
          const picked = pickPanel(this.panels, ray(x, y));
          return !!picked && picked.panel.ui.wheel(picked.hit.x, picked.hit.y, dy);
        },
      },
      canvas,
      listener(canvas, cleanups),
    );
    return detacher(cleanups, this.signal);
  }

  private resources(panel: WorldPanel): PanelGpu {
    let gpu = this.gpu.get(panel);
    if (gpu) return gpu;
    const device = this.device!,
      width = Math.round(panel.cssWidth * panel.pixelRatio),
      height = Math.round(panel.cssHeight * panel.pixelRatio),
      max = device.limits.maxTextureDimension2D;
    if (width > max || height > max || width < 1 || height < 1)
      throw rangeError(
        `A WorldPanel texture of ${width} by ${height} pixels does not fit this GPU, whose limit is ${max} a side; lower the UI size or pixelRatio`,
        'ui',
      );
    const levels = Math.floor(Math.log2(Math.max(width, height))) + 1,
      texture = device.createTexture({
        size: [width, height],
        format: PANEL_FORMAT,
        mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      painter = new UiPainter(
        { atlasSize: 1024, colorAtlasSize: 512, maxPages: 16 },
        { rects: 0, glyphs: 0, drawCalls: 0, uploads: 0 },
      );
    painter.setup(device);
    gpu = {
      texture,
      view: texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
      levels,
      painter,
      uniform,
      group: device.createBindGroup({
        layout: this.panelLayout!,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: this.sampler! },
          { binding: 2, resource: texture.createView() },
        ],
      }),
      painted: -1,
      atlas: '',
    };
    this.gpu.set(panel, gpu);
    return gpu;
  }

  /** Redraw a panel's texture when its UI changed; the UI pass and the mipmaps go in their own submissions. */
  private paint(panel: WorldPanel, gpu: PanelGpu): void {
    const list = panel.ui.draw();
    if (gpu.painted === list.version && gpu.atlas === gpu.painter.atlasKey) return;
    const device = this.device!,
      painter = gpu.painter,
      draw = painter.prepare(list),
      encoder = device.createCommandEncoder(),
      pass = encoder.beginRenderPass({
        colorAttachments: [{ view: gpu.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      });
    if (draw)
      painter.encode(pass, {
        width: gpu.texture.width,
        height: gpu.texture.height,
        format: PANEL_FORMAT,
        samples: 1,
      });
    pass.end();
    device.queue.submit([encoder.finish()]);
    if (gpu.levels > 1) generateMipmaps(device, gpu.texture, gpu.levels, this.mipCache);
    gpu.painted = list.version;
    gpu.atlas = painter.atlasKey;
    this.stats.repaints++;
  }

  private camera(index: number, context: GpuContext): GPUBindGroup {
    let slot = this.cameras[index];
    if (!slot) {
      const buffer = this.device!.createBuffer({
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      slot = this.cameras[index] = {
        buffer,
        group: this.device!.createBindGroup({
          layout: this.cameraLayout!,
          entries: [{ binding: 0, resource: { buffer } }],
        }),
      };
    }
    const camera = context.camera,
      c = this.cameraData;
    c.set(camera.matrix);
    c[16] = camera.position[0];
    c[17] = camera.position[1];
    c[18] = camera.position[2];
    c[19] = 1;
    this.device!.queue.writeBuffer(slot.buffer, 0, c);
    return slot.group;
  }

  private pipeline(context: GpuContext): GPURenderPipeline {
    const depthFormat = context.descriptor.depthStencil!.format,
      samples = context.descriptor.multisample?.count ?? 1,
      key = `${context.format}|${depthFormat}|${samples}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.module!;
      pipeline = this.device!.createRenderPipeline({
        layout: this.pipelineLayout!,
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        vertex: { module, entryPoint: 'panelVertex' },
        fragment: { module, entryPoint: 'panelFragment', targets: [{ format: context.format, blend: PREMULTIPLIED }] },
        multisample: { count: samples },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private readonly execute = (context: PassContext): void => {
    const stats = this.stats;
    stats.panels = stats.drawCalls = 0;
    if (this.frameDrawn !== this.frame) stats.repaints = 0;
    if (context.backend !== 'webgpu' || !this.device || context.device !== this.device || !this.panels.size) return;
    const eye = context.camera.position,
      shown: [WorldPanel, PanelGpu][] = [];
    for (const panel of this.panels) {
      if (!panel.visible) continue;
      const gpu = this.resources(panel);
      // Textures once per frame, before the first view draws them.
      if (this.frameDrawn !== this.frame) this.paint(panel, gpu);
      if (panel.doubleSided || panel.side(eye) > 0) shown.push([panel, gpu]);
    }
    this.frameDrawn = this.frame;
    if (!shown.length) return;
    const linear = context.format.endsWith('-srgb') || context.format.includes('float') ? 1 : 0,
      p = this.panelData;
    for (const [panel, gpu] of shown) {
      p.set(panel.matrix);
      p[16] = panel.width;
      p[17] = panel.height;
      p[18] = linear;
      p[19] = 0;
      this.device.queue.writeBuffer(gpu.uniform, 0, p);
    }
    this.descriptor.colorAttachments[0].view = context.color;
    this.descriptor.depthStencilAttachment.view = context.depth;
    const pass = context.encoder.beginRenderPass(this.descriptor);
    applyView(pass, context);
    pass.setPipeline(this.pipeline(context));
    pass.setBindGroup(1, this.camera(context.view?.index ?? 0, context));
    for (const [, gpu] of shown) {
      pass.setBindGroup(0, gpu.group);
      pass.draw(6);
      stats.drawCalls++;
      stats.panels++;
    }
    pass.end();
  };

  private release(panel: WorldPanel): void {
    const gpu = this.gpu.get(panel);
    if (!gpu) return;
    gpu.texture.destroy();
    gpu.uniform.destroy();
    gpu.painter.release(true);
    this.gpu.delete(panel);
  }

  onDeviceRestored(engine: Engine): void {
    for (const panel of [...this.gpu.keys()]) this.release(panel);
    for (const slot of this.cameras) slot.buffer.destroy();
    this.cameras.length = 0;
    this.pipelines.clear();
    this.mipCache.clear();
    this.setup(engine);
  }

  /** Free every panel texture and detach the canvas listeners. The panels' `Ui`s are not disposed. */
  dispose(): void {
    this.detach?.();
    this.detach = undefined;
    this.cancel();
    for (const panel of [...this.gpu.keys()]) this.release(panel);
    for (const slot of this.cameras) slot.buffer.destroy();
    this.cameras.length = 0;
    this.pipelines.clear();
    this.mipCache.clear();
    this.panels.clear();
    this.device = this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol.for('Symbol.dispose')) as symbol](): void {
    this.dispose();
  }
}

/**
 * Panel quad: the pose places a width by height rectangle, the view-projection draws it; the fragment samples the
 * panel's UI texture (linear premultiplied, from an sRGB texture) and writes it in the target's encoding.
 */
const panelShader: string = /* wgsl */ `
struct Panel { model: mat4x4f, size: vec2f, linear: f32, pad: f32 }
struct View { viewProj: mat4x4f, eye: vec4f }
@group(0) @binding(0) var<uniform> panel: Panel;
@group(0) @binding(1) var panelSampler: sampler;
@group(0) @binding(2) var panelTexture: texture_2d<f32>;
@group(1) @binding(0) var<uniform> view: View;

struct Out { @builtin(position) clip: vec4f, @location(0) uv: vec2f }
@vertex fn panelVertex(@builtin(vertex_index) vi: u32) -> Out {
  let c = vec2f(f32((0x32u >> vi) & 1u), f32((0x2cu >> vi) & 1u));
  let world = panel.model * vec4f((c.x - 0.5) * panel.size.x, (0.5 - c.y) * panel.size.y, 0.0, 1.0);
  // From behind, the UI is mirrored back to reading order.
  let behind = dot(view.eye.xyz - panel.model[3].xyz, panel.model[2].xyz) < 0.0;
  var o: Out;
  o.clip = view.viewProj * world;
  o.uv = vec2f(select(c.x, 1.0 - c.x, behind), c.y);
  return o;
}
fn toSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
@fragment fn panelFragment(i: Out) -> @location(0) vec4f {
  let c = textureSample(panelTexture, panelSampler, i.uv);
  if (panel.linear > 0.5 || c.a <= 0.0) { return c; }
  return vec4f(toSrgb(c.rgb / c.a) * c.a, c.a);
}
`;
