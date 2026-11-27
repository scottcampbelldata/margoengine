/// <reference lib="esnext.disposable" preserve="true" />
import { PbrMaterial, type EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { windShader, validateSway, validateWind, type ScatterSway, type ScatterWind } from './wind.js';
import { translucencyShader } from './translucency.js';
import { sameBindings, snapshotBindings } from './bindings.js';
import { MargoError } from '@margoengine/math/errors';
import { overlayDepthPass } from '../../shared/pass.js';
import { unitLight } from '../../shared/unit-light.js';
import { captureStage, type ScatterCapture } from './capture.js';

declare const GPUBufferUsage: { VERTEX: number; INDEX: number; INDIRECT: number; UNIFORM: number; COPY_DST: number };
type ScatterPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/** One material batch of fixed PBR instances for `ScatterInstances`, drawn with one indexed indirect draw. */
export interface ScatterBatch {
  /** Diagnostic label. */
  name: string;
  /** Position, normal, tangent, UV0/UV1 and color, five vec4s (80 bytes). */
  vertices: Float32Array;
  /** Triangle indices into `vertices`. */
  indices: Uint32Array;
  /** Column-major affine matrices, 16 floats per instance. */
  transforms: Float32Array;
  /** Core PBR material shared by the batch. Its values are copied into the instance buffer at upload and device restoration only; a change after attach shows once a new ScatterInstances is attached. */
  material: PbrMaterial;
  /** Linear HDR emission, added after lighting and baked occlusion. */
  emissive?: readonly [number, number, number];
  /** Rooted wind bend `[directionX, directionZ, strength]`. Omitted: static. */
  wind?: ScatterWind;
  /** Branch/foliage ripple, 0-1, layered over rooted wind. Defaults to 0. */
  windDetail?: number;
  /**
   * How the batch's plants sway (as `ScatterOptions.sway`): `stiffness` 0.1 to 10 divides the 1.2 m reach, `height` is
   * the plant's top in mesh units (default the batch's highest vertex); each instance's top is that times its
   * transform's Y-axis length.
   */
  sway?: ScatterSway;
  /**
   * Sunlight seen through thin foliage, 0-1 (default 0): wrapped back-light translucency after Barre-Brisebois and
   * Bouchard (GDC 2011). Leaves facing away from the sun glow when the camera looks toward it, scaled by the vertex
   * occlusion (alpha) so outer leaves glow and a canopy's core does not. 1 matches the albedo's front-lit diffuse.
   */
  translucency?: number;
}
interface Batch {
  vertex: GPUBuffer;
  index: GPUBuffer;
  instance: GPUBuffer;
  command: GPUBuffer;
}
const vertexLayouts: GPUVertexBufferLayout[] = [
  {
    arrayStride: 80,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 16, format: 'float32x3' },
      { shaderLocation: 8, offset: 64, format: 'float32x4' },
    ],
  },
  {
    arrayStride: 144,
    stepMode: 'instance',
    attributes: [
      ...Array.from({ length: 6 }, (_, i) => ({ shaderLocation: i + 2, offset: i * 16, format: 'float32x4' as const })),
      { shaderLocation: 9, offset: 96, format: 'float32x3' },
      { shaderLocation: 10, offset: 112, format: 'float32x4' },
      { shaderLocation: 11, offset: 128, format: 'float32x4' },
    ],
  },
];
// Location 9 also carries translucency in .w when any batch sets it.
const translucentLayouts: GPUVertexBufferLayout[] = [
  vertexLayouts[0],
  {
    ...vertexLayouts[1],
    attributes: [...vertexLayouts[1].attributes].map((a) =>
      a.shaderLocation === 9 ? { ...a, format: 'float32x4' as const } : a,
    ),
  },
];
// Light through thin leaves (Barre-Brisebois and Bouchard 2011): a lobe around the direction away from the sun, bent by
// the normal so curved canopies light unevenly, plus wrapped diffuse on the shadow side. Unshadowed (a canopy's own
// shadow map would hide its back-lit side); baked occlusion stands in for thickness.
// Wrapped diffuse: Green 2004, GPU Gems ch. 16. Distortion 0.4, power 4 and weight 0.3 are Margo tuning.
/**
 * Interpolation of a varying that changes across a triangle (a blade's root-to-tip shade, vertex colour, occlusion).
 * With multisampling a pixel the triangle only partly covers is shaded at its centre, which can lie outside the
 * triangle, where plain interpolation extrapolates past the vertex values: a 0..1 shade went below 0 at thin blade
 * edges and drew negative radiance into the HDR scene. Centroid interpolation reads at a covered sample instead.
 */
export const centroid = '@interpolate(perspective,centroid)';
/**
 * Holds core's colour varying at 0 and above in the fragment shader. Centroid gets within the GPU's precision: on a thin
 * triangle it can still land just outside (2 of 65,536 pixels on an Apple M6 in WebKit, the colour near -0.05, drawn as
 * negative radiance). The vertex colours are never negative, so neither is a colour read inside the triangle.
 */
export const positiveColor = (code: string): string =>
  code.replace(
    /@fragment fn fragment\(i:Output,([^{]+)\{/,
    '@fragment fn fragment(varyings:Output,$1{\n var i=varyings;i.color=max(i.color,vec3f(0.0));',
  );
/** The first @location a struct does not use: patches that add varyings to a shared struct must not collide. */
export const freeLocation = (struct: string): number =>
  Math.max(-1, ...[...struct.matchAll(/@location\((\d+)\)/g)].map((m) => Number(m[1]))) + 1;
const shadowShader =
  windShader +
  `
struct ShadowFrame {camera:mat4x4f,time:vec4f}
@group(0) @binding(0) var<uniform> frame:ShadowFrame;
struct Input {@location(0) p:vec3f,@location(2) a:vec4f,@location(3) b:vec4f,@location(4) c:vec4f,@location(5) d:vec4f,@location(10) wind:vec4f,@location(11) sway:vec4f}
@vertex fn vertex(i:Input)->@builtin(position) @invariant vec4f {var p=mat4x4f(i.a,i.b,i.c,i.d)*vec4f(i.p,1);let bend=windDeformation(p.xyz,i.d.xyz,vec4f(i.wind.xyz,frame.time.x),i.wind.w,vec4f(i.sway.xy,frame.time.x,1.0));p=vec4f(p.x+bend.offset.x,p.y-bend.drop.x,p.z+bend.offset.y,1);return frame.camera*p;}
`;
let serial = 0;

/**
 * Fixed, indirect PBR instances. The factory runs only at upload/device restoration; CPU geometry is not retained.
 * @throws TypeError when the factory is not a function; RangeError when a batch is invalid or exceeds GPU limits.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class ScatterInstances implements EnginePlugin {
  readonly name = 'scatter:instances:' + ++serial;
  readonly batches: { name: string; vertices: number; indices: number; instances: number }[] = [];
  disposed = false;
  /** Multiplies all batch emission; a callback is sampled each render. */
  emissiveIntensity: number | (() => number) = 1;
  protected engine?: Engine;
  private resources: Batch[] = [];
  private uniform?: GPUBuffer;
  private readonly values = new Float32Array(36);
  private readonly shadowValues = new Float32Array(20);
  private seconds = 0;
  private shadowPipeline?: GPURenderPipeline;
  private shadowUniforms: GPUBuffer[] = [];
  private shadowGroups: GPUBindGroup[] = [];
  private pipeline?: GPURenderPipeline;
  private group?: GPUBindGroup;
  private shader = '';
  private format = '';
  private bindings: GPUBindGroupEntry[] = [];
  /** Whether any batch sets `translucency`; otherwise the shader and layout stay as they were without it. */
  private translucent = false;
  /** `setCapture`'s hook, the dispose listeners, and the capture pipelines with their per-view frame uniforms. */
  private capture?: ScatterCapture;
  private readonly disposers = new Set<() => void>();
  private readonly capturePipelines = new Map<string, GPURenderPipeline>();
  private readonly captureGroups = new Map<GPURenderPipeline, GPUBindGroup[]>();
  private captureUniforms: GPUBuffer[] = [];
  private captureBindings: GPUBindGroupEntry[] = [];
  private readonly captureValues = new Float32Array(36);
  private readonly presentation = overlayDepthPass();
  private readonly color = this.presentation.colorAttachments[0];
  private readonly depth = this.presentation.depthStencilAttachment;

  constructor(private readonly generate: () => readonly ScatterBatch[]) {
    if (typeof generate !== 'function') throw new TypeError('Expected an instance factory');
  }
  static attach(engine: EngineKernel, generate: () => readonly ScatterBatch[]): ScatterInstances {
    const effect = new ScatterInstances(generate);
    engineRuntime(engine).use(effect);
    return effect;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'PBR scatter requires WebGPU; attach a new ScatterInstances to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    const d = engine.gpu;
    const upload = (data: Float32Array | Uint32Array, usage: number): GPUBuffer => {
      if (data.byteLength > d.limits.maxBufferSize)
        throw new RangeError(
          'Instances exceed GPU buffer limit; split the batch into smaller batches or reduce the instance count.',
        );
      const buffer = d.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      try {
        d.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
      } catch (error) {
        buffer.destroy();
        throw error;
      }
      return buffer;
    };
    try {
      this.uniform = d.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      for (const b of this.generate()) {
        const count = b.vertices.length / 20,
          instances = b.transforms.length / 16;
        if (
          !(b.vertices instanceof Float32Array) ||
          !(b.indices instanceof Uint32Array) ||
          !(b.transforms instanceof Float32Array) ||
          !(b.material instanceof PbrMaterial) ||
          !Number.isInteger(count) ||
          count < 3 ||
          count > 1_000_000 ||
          !Number.isInteger(instances) ||
          instances < 1 ||
          instances > 1_000_000 ||
          !b.indices.length ||
          b.indices.length % 3 ||
          b.indices.some((i) => i >= count) ||
          b.vertices.some((v) => !Number.isFinite(v)) ||
          b.transforms.some((v) => !Number.isFinite(v))
        )
          throw new RangeError(
            'Invalid PBR scatter batch; pass finite Float32Array vertices (20 floats each), Uint32Array triangle indices within range, 16-float transforms (1 to 1000000) and a PbrMaterial.',
          );
        if (
          b.emissive !== undefined &&
          (b.emissive.length !== 3 ||
            [0, 1, 2].some((i) => !Number.isFinite(Math.fround(b.emissive![i])) || b.emissive![i] < 0))
        )
          throw new RangeError('Invalid scatter emission; pass emissive as three finite numbers of 0 or more.');
        if (
          b.translucency !== undefined &&
          (!Number.isFinite(b.translucency) || b.translucency < 0 || b.translucency > 1)
        )
          throw new RangeError('Scatter batch translucency must be from 0 to 1');
        this.translucent ||= (b.translucency ?? 0) > 0;
        const windLength = b.wind ? validateWind(b.wind) : 1;
        if (
          b.windDetail !== undefined &&
          (!b.wind || !Number.isFinite(b.windDetail) || b.windDetail < 0 || b.windDetail > 1)
        )
          throw new RangeError('Invalid scatter wind detail; set a wind on the batch and windDetail between 0 and 1.');
        const wind = b.wind ? [b.wind[0] / windLength, b.wind[1] / windLength, b.wind[2]] : undefined;
        const reach = validateSway(b.sway);
        let top = b.sway?.height ?? 0;
        if (!b.sway?.height) for (let v = 1; v < b.vertices.length; v += 20) top = Math.max(top, b.vertices[v]);
        const packed = new Float32Array(instances * 36);
        for (let i = 0; i < instances; i++) {
          const m = b.transforms.subarray(i * 16, i * 16 + 16);
          const det =
            m[0] * (m[5] * m[10] - m[6] * m[9]) -
            m[4] * (m[1] * m[10] - m[2] * m[9]) +
            m[8] * (m[1] * m[6] - m[2] * m[5]);
          if (m[3] || m[7] || m[11] || m[15] !== 1 || !Number.isFinite(det) || !det)
            throw new RangeError('Expected nonsingular affine instance transforms');
          packed.set(m, i * 36);
          packed.set(b.material.data, i * 36 + 16);
          packed[i * 36 + 23] = -1; // Fixed batches have no core mesh ID.
          if (b.emissive) packed.set(b.emissive, i * 36 + 24);
          packed[i * 36 + 27] = b.translucency ?? 0;
          if (wind) packed.set(wind, i * 36 + 28);
          packed[i * 36 + 31] = b.windDetail ?? 0;
          // The plant's top in metres (the mesh top along the transform's Y axis) and the reach.
          packed[i * 36 + 32] = top * Math.hypot(m[4], m[5], m[6]);
          packed[i * 36 + 33] = reach;
        }
        const buffers: GPUBuffer[] = [];
        try {
          buffers.push(upload(b.vertices, GPUBufferUsage.VERTEX));
          buffers.push(upload(b.indices, GPUBufferUsage.INDEX));
          buffers.push(upload(packed, GPUBufferUsage.VERTEX));
          buffers.push(upload(new Uint32Array([b.indices.length, instances, 0, 0, 0]), GPUBufferUsage.INDIRECT));
        } catch (error) {
          for (const buffer of buffers) buffer.destroy();
          throw error;
        }
        this.resources.push({ vertex: buffers[0], index: buffers[1], instance: buffers[2], command: buffers[3] });
        this.batches.push({ name: b.name, vertices: count, indices: b.indices.length, instances });
      }
      const module = d.createShaderModule({ code: this.appearanceCode(shadowShader, true) });
      this.shadowPipeline = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex', buffers: vertexLayouts },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
      });
      for (let i = 0; i < 4; i++) {
        const buffer = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.shadowUniforms.push(buffer);
        this.shadowGroups.push(
          d.createBindGroup({
            layout: this.shadowPipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer } }],
          }),
        );
      }
    } catch (error) {
      this.release();
      throw error;
    }
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.drawColour(c);
      },
    });
  }
  /**
   * Lets a capture hook (`@margoengine/post` SSR, SceneTargets, LightBounce: `targets.add(instances)`) draw the
   * instances' material with `draw(c, 'capture')`: every batch with the colour pass's own stage (wind, sway, vertex
   * colour and occlusion) ending in the hook's `margoSSR`, depth tested (greater-equal) and written. Returns a remover.
   * Without a hook the instances draw exactly as before.
   * @throws TypeError for a bad hook or disposed instances.
   */
  setCapture(hook: ScatterCapture): () => void {
    if (
      this.disposed ||
      !hook ||
      typeof hook.declarations !== 'function' ||
      typeof hook.begin !== 'function' ||
      !Array.isArray(hook.targets)
    )
      throw new TypeError(
        'Invalid scatter capture hook; pass an object with declarations() and begin() functions and a targets array to live ScatterInstances.',
      );
    this.capture = hook;
    return () => {
      if (this.capture === hook) this.capture = undefined;
    };
  }
  /** Calls `callback` once when the instances are disposed; returns a remover. */
  onDispose(callback: () => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('ScatterInstances onDispose needs a function');
    this.disposers.add(callback);
    return () => this.disposers.delete(callback);
  }
  /**
   * `mode` 'capture': draws every batch into the capture hook's pass (`setCapture`); `color` and `depth` are unused
   * (the hook's pass has its own). Does nothing without a hook, before setup or after disposal.
   */
  draw(c: ScatterPassContext, mode: 'capture', color?: GPUTextureView, depth?: GPUTextureView): void {
    const hook = this.capture;
    void color;
    void depth;
    if (mode !== 'capture' || !hook || this.disposed || !this.engine || !this.uniform) return;
    const declarations = hook.declarations(c.shader),
      key =
        hook.targets.map((t) => t.format).join(',') +
        ':' +
        c.descriptor.multisample?.count +
        ':' +
        c.descriptor.depthStencil!.format +
        '\0' +
        declarations +
        '\0' +
        c.shader;
    let pipeline = this.capturePipelines.get(key);
    if (!pipeline) {
      const code = captureStage(positiveColor(this.colourCode(c.shader)), declarations);
      if (code === undefined)
        throw new MargoError(
          'unsupported',
          "ScatterInstances capture needs core's lit fragment; a plugin replaced it. Remove that plugin or the capture",
        );
      const module = c.device.createShaderModule({ code: this.appearanceCode(code, false) });
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex', buffers: this.translucent ? translucentLayouts : vertexLayouts },
        fragment: { module, entryPoint: 'fragment', targets: hook.targets as GPUColorTargetState[] },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: true,
          depthCompare: 'greater-equal',
        },
      });
      if (this.capturePipelines.size >= 32) {
        this.capturePipelines.clear();
        this.captureGroups.clear();
      }
      this.capturePipelines.set(key, pipeline);
    }
    // Each view its own frame uniform: the colour pass's buffer holds the colour pass's camera in the same submit.
    const view = c.view?.index ?? 0;
    const uniform = (this.captureUniforms[view] ??= c.device.createBuffer({
      size: 144,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    this.frameValues(this.captureValues, c);
    c.device.queue.writeBuffer(uniform, 0, this.captureValues as Float32Array<ArrayBuffer>);
    if (!sameBindings(this.captureBindings, c.bindings)) {
      this.captureGroups.clear();
      this.captureBindings = snapshotBindings(c.bindings);
    }
    let groups = this.captureGroups.get(pipeline);
    if (!groups) this.captureGroups.set(pipeline, (groups = []));
    groups[view] ??= c.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniform } }, ...c.bindings],
    });
    const pass = hook.begin();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, groups[view]);
    this.drawBatches(pass, pipeline);
  }
  /** Seconds on the wind clock: the sum of the deltas given to `advanceTime` (each frame update runs it). */
  get time(): number {
    return this.seconds;
  }
  /** Back to time 0 and a fresh one's state, history dropped (GAP-FILM-RESET; `resetClocks` in `@margoengine/cutscene/seek`). */
  resetTime(): void {
    this.seconds = 0;
  }
  /**
   * Moves the wind clock by `delta` seconds without drawing: all of a frame update. `seek` from
   * `@margoengine/cutscene/seek` replays these steps, so every instance sways where a continuous run has it.
   */
  advanceTime(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid scatter delta; pass a finite frame time of 0 or more.');
    this.seconds = this.seconds + delta;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  /** The frame uniform: camera, sun, ambient, wind clock and emission intensity. */
  private frameValues(values: Float32Array, c: ScatterPassContext): void {
    const intensity = typeof this.emissiveIntensity === 'function' ? this.emissiveIntensity() : this.emissiveIntensity;
    if (typeof intensity !== 'number' || !Number.isFinite(Math.fround(intensity)) || intensity < 0)
      throw new RangeError('Invalid scatter emissive intensity; return a finite number of 0 or more.');
    values.set(c.camera.matrix);
    values.set(c.camera.position, 16);
    unitLight(values, 20, this.engine!.lighting.direction);
    values.set(this.engine!.lighting.radiance, 24);
    values.fill(1, 28, 31);
    if (this.engine!.lighting.ambient) values.set(this.engine!.lighting.ambient, 28);
    values[32] = this.seconds;
    values[33] = intensity;
  }
  /** Core's lit shader with the instances' wind, vertex colour, occlusion, emission and translucency. */
  private colourCode(shader: string): string {
    const lucent = this.translucent;
    return (
      windShader +
      (lucent ? translucencyShader : '') +
      shader
        .replace(/struct Frame \{[^}]+\}/, (frame) => frame.replace('}', ',windTime:vec4f }'))
        .replace(/struct Input \{[^}]+\}/, (input) =>
          input.replace(
            '}',
            `,@location(8) vertexColor:vec4f,@location(9) emissive:${lucent ? 'vec4f' : 'vec3f'},@location(10) wind:vec4f,@location(11) sway:vec4f }`,
          ),
        )
        .replace(/struct Output \{[^}]+\}/, (output) => {
          // After core's own varyings and any another patch added (terrain's mesh id). Vertex colour and occlusion vary
          // across a triangle: read them inside it (centroid), as for scatter's blades.
          const at = freeLocation(output);
          return output
            .replace('@location(2) color:vec3f', `@location(2) ${centroid} color:vec3f`)
            .replace(
              '}',
              `,@location(${at}) emissive:vec3f,@location(${at + 1}) ${centroid} occlusion:f32${lucent ? `,@location(${at + 2}) @interpolate(flat) translucency:f32` : ''} }`,
            );
        })
        .replace(
          'let p=model*vec4f(i.position,1);',
          'var p=model*vec4f(i.position,1);let wind=vec4f(i.wind.xyz,frame.windTime.x);let bend=windDeformation(p.xyz,i.m3.xyz,wind,i.wind.w,vec4f(i.sway.xy,frame.windTime.x,1.0));p=vec4f(p.x+bend.offset.x,p.y-bend.drop.x,p.z+bend.offset.y,1);',
        )
        .replace(
          'o.color=i.color.rgb;',
          'o.normal=windDetailNormal(o.normal,bend,wind);o.color=i.color.rgb*i.vertexColor.rgb;' +
            (lucent
              ? 'o.emissive=i.emissive.rgb*frame.windTime.y;o.translucency=i.emissive.w;'
              : 'o.emissive=i.emissive*frame.windTime.y;') +
            'o.occlusion=clamp(i.vertexColor.a,0.0,1.0);',
        )
        .replace('i.color*(1.0-i.material.y)*', 'i.color*(1.0-i.material.y)*i.occlusion*')
        .replace(
          /let linear=([^;]+);/,
          lucent
            ? 'let linear=$1+foliageTranslucency(n,v,l,i.occlusion,i.translucency)*i.color*frame.radiance.xyz*frame.light.w+i.emissive;'
            : 'let linear=$1+i.emissive;',
        )
    );
  }
  private drawColour(c: ScatterPassContext): void {
    const changed = !sameBindings(this.bindings, c.bindings);
    const format = c.format + ':' + c.descriptor.multisample?.count + ':' + c.descriptor.depthStencil!.format;
    if (this.shader !== c.shader || this.format !== format) {
      const lucent = this.translucent;
      const code = this.colourCode(c.shader);
      const module = c.device.createShaderModule({ code: this.appearanceCode(positiveColor(code), false) });
      this.pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex', buffers: lucent ? translucentLayouts : vertexLayouts },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
        depthStencil: { ...c.descriptor.depthStencil!, depthWriteEnabled: true, depthCompare: 'greater-equal' },
      });
      this.group = undefined;
      this.shader = c.shader;
      this.format = format;
    }
    if (!this.group || changed) {
      this.group = c.device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.uniform! } }, ...c.bindings],
      });
      this.bindings = snapshotBindings(c.bindings);
    }
    this.frameValues(this.values, c);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    this.color.view = c.color;
    this.depth.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.group!);
    this.drawBatches(pass, this.pipeline!);
    pass.end();
  }
  drawShadow({
    context,
    pass,
    matrix,
    cascade,
  }: {
    context: ScatterPassContext;
    pass: GPURenderPassEncoder;
    matrix: Float32Array;
    cascade: number;
  }): void {
    this.shadowValues.set(matrix);
    this.shadowValues[16] = this.seconds;
    context.device.queue.writeBuffer(this.shadowUniforms[cascade], 0, this.shadowValues as Float32Array<ArrayBuffer>);
    pass.setPipeline(this.shadowPipeline!);
    pass.setBindGroup(0, this.shadowGroups[cascade]);
    this.drawBatches(pass, this.shadowPipeline!);
  }
  /** Optional entries add per-instance shader inputs to both colour and shadow modules. */
  protected appearanceCode(code: string, _shadow: boolean): string {
    return code;
  }
  /** Per-batch optional bindings, after the shared frame bindings. */
  protected bindBatch(_pass: GPURenderPassEncoder, _batch: number, _pipeline: GPURenderPipeline): void {}
  private drawBatches(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline): void {
    // shortcut: draws every fixed instance, add GPU culling for large populations.
    for (let i = 0; i < this.resources.length; i++) {
      const b = this.resources[i];
      this.bindBatch(pass, i, pipeline);
      pass.setVertexBuffer(0, b.vertex);
      pass.setVertexBuffer(1, b.instance);
      pass.setIndexBuffer(b.index, 'uint32');
      pass.drawIndexedIndirect(b.command, 0);
    }
  }
  protected release(): void {
    for (const b of this.resources) {
      b.vertex.destroy();
      b.index.destroy();
      b.instance.destroy();
      b.command.destroy();
    }
    for (const b of this.shadowUniforms) b.destroy();
    for (const b of this.captureUniforms) b?.destroy();
    this.captureUniforms = [];
    this.capturePipelines.clear();
    this.captureGroups.clear();
    this.captureBindings = [];
    this.uniform?.destroy();
    this.resources.length = this.batches.length = this.shadowUniforms.length = this.shadowGroups.length = 0;
    this.uniform = undefined;
    this.pipeline = this.shadowPipeline = undefined;
    this.group = undefined;
    this.shader = this.format = '';
    this.translucent = false;
    this.bindings.length = 0;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
    this.capture = undefined;
    const listeners = [...this.disposers];
    this.disposers.clear();
    for (const listener of listeners) listener();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
