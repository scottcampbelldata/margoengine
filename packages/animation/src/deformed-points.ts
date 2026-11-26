/// <reference lib="esnext.disposable" preserve="true" />
// A triangle mesh drawn as its vertices: one camera-facing quad per vertex, instanced straight from the buffer the
// deformation pass (index.ts, skin.ts, geometry-cache.ts) already wrote, so the points follow skinning and morph
// targets with no second copy of that arithmetic and no CPU work per vertex.
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { applyView, viewSize } from '../../shared/view-rect.js';
import { linearHdr } from '../../shared/hdr-format.js';
import type { PBRModel, PBRPrimitive } from '@margoengine/gltf/pbr';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { parseColor, type ColorInput } from '@margoengine/math/color';
import { deformReaders } from './deform-readers.js';
declare const GPUBufferUsage: { UNIFORM: number; VERTEX: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options for {@link DeformedPoints}; every one is also a live field of the same name. */
export interface DeformedPointsOptions {
  /** Point diameter: pixels of the view, or world units when `sizeUnits` is 'world'. Finite, 0 or more. Default 4. */
  size?: number;
  /** 'pixels' keeps a constant screen size; 'world' shrinks with distance. Default 'pixels'. */
  sizeUnits?: 'pixels' | 'world';
  /** '#rrggbb', '#rgb' or 0xrrggbb are sRGB; an [r, g, b] array is linear RGB. Default white. */
  color?: ColorInput;
  /** Multiplies alpha, 0 to 1; below 1 the points blend over what is drawn and still write depth. Default 1. */
  opacity?: number;
  /** 'square', or 'round' (a disc cut from the square). Default 'square'. */
  shape?: 'square' | 'round';
  /** Multiplies `color` by each vertex's colour (glTF COLOR_0; white where the mesh has none). Default true. */
  vertexColors?: boolean;
}

/**
 * What the vertex stage adds to a point's clip position for a quad corner in [-1, 1]: `corner * [x, y]`, times the
 * clip w when the third number is 1. `camera` is the view-projection matrix (column-major, `Camera.matrix`), `width`
 * and `height` the view's pixels. Pixels: a point covers `size` pixels at any depth. World: `size` world units across,
 * measured in the image plane, for any projection (the matrix's x and y rows without their share along the w row, so
 * an orthographic or off-axis projection is sized like a centred perspective one).
 * @throws RangeError for a size that is not finite and >= 0, an unknown unit or a view without pixels.
 */
export function pointScale(
  camera: ArrayLike<number>,
  size: number,
  sizeUnits: 'pixels' | 'world',
  width: number,
  height: number,
  out = new Float32Array(3),
): Float32Array {
  if (
    !(size >= 0 && Number.isFinite(size)) ||
    (sizeUnits !== 'pixels' && sizeUnits !== 'world') ||
    !(width > 0 && height > 0)
  )
    throw new RangeError(
      "Invalid point size; pass a finite size >= 0, sizeUnits 'pixels' or 'world' and a view of at least 1 pixel",
    );
  if (sizeUnits === 'pixels') {
    out[0] = size / width;
    out[1] = size / height;
    out[2] = 1;
    return out;
  }
  const wx = camera[3],
    wy = camera[7],
    wz = camera[11],
    ww = wx * wx + wy * wy + wz * wz;
  for (let row = 0; row < 2; row++) {
    const x = camera[row],
      y = camera[4 + row],
      z = camera[8 + row],
      along = ww > 0 ? (x * wx + y * wy + z * wz) / ww : 0;
    out[row] = (size / 2) * Math.hypot(x - along * wx, y - along * wy, z - along * wz);
  }
  out[2] = 0;
  return out;
}

/**
 * The WGSL the points draw with. Each instance is one 80-byte vertex of the mesh (position at byte 0, colour at 64);
 * the four strip vertices are the corners of its quad. Exposed for tooling and tests.
 */
export const deformedPointsShader = /* wgsl */ `
struct Frame {camera:mat4x4f,model:mat4x4f,color:vec4f,scale:vec4f,flags:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
struct Out {@builtin(position) clip:vec4f,@location(0) color:vec4f,@location(1) corner:vec2f}
@vertex fn vertex(@location(0) position:vec3f,@location(1) color:vec4f,@builtin(vertex_index) i:u32)->Out {
 let corner=vec2f(f32(i&1u),f32(i>>1u))*2.0-1.0;let c=f.camera*(f.model*vec4f(position,1.0));
 var o:Out;o.clip=vec4f(c.xy+corner*f.scale.xy*mix(1.0,c.w,f.scale.z),c.zw);o.color=f.color*mix(vec4f(1.0),color,f.flags.x);o.corner=corner;return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
 if(f.scale.w>0.5&&dot(i.corner,i.corner)>1.0){discard;}
 let x=clamp(i.color.rgb,vec3f(0.0),vec3f(1.0));
 return vec4f(select(select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308)),i.color.rgb,f.flags.y>0.5),i.color.a);
}
`;

let serial = 0;
/**
 * Draws every vertex of a `gltf/pbr` model (or a `createMesh` mesh) as a point where the model's deformer last put
 * it: `Animation` (skins and morph targets), `Skin`, `MorphWeightPlayer` or a geometry cache. A primitive with no
 * deformer draws its own vertices at its node. Unlit, depth tested and depth writing, no shadows, picking or fog.
 * The points show while `visible` is true whatever the model's own visibility: hide the model
 * (`model.root.visible = false`) to see the points alone, and it keeps deforming for them.
 * @example
 * const points = DeformedPoints.attach(model, { size: 3, color: '#ffcc00' });
 * model.root.visible = false;
 */
export class DeformedPoints implements EnginePlugin {
  readonly name = 'deformed-points:' + serial++;
  size = 4;
  sizeUnits: 'pixels' | 'world' = 'pixels';
  /** Linear RGB; assign with `set({ color })`. */
  readonly color = new Float32Array([1, 1, 1]);
  opacity = 1;
  shape: 'square' | 'round' = 'square';
  vertexColors = true;
  /** False draws nothing (the model then deforms only while it shows itself). */
  visible = true;
  disposed = false;
  private engine?: Engine;
  private device?: GPUDevice;
  private pipeline?: GPURenderPipeline;
  private key = '';
  private frames?: GPUBuffer;
  private groups: GPUBindGroup[] = [];
  /** Vertices of primitives no deformer writes, uploaded here. */
  private readonly own = new Map<PBRPrimitive, { source: Float32Array; buffer: GPUBuffer }>();
  private readonly values = new Float32Array(44);
  private readonly scale = new Float32Array(3);
  private reading = false;
  private unsubscribe?: () => void;
  /** Same as `model.root.engine.use(new DeformedPoints(model, options))`; returns the points. */
  static attach(model: PBRModel, options?: DeformedPointsOptions): DeformedPoints {
    const value = new DeformedPoints(model, options);
    model.root.engine.use(value);
    return value;
  }
  /** @throws TypeError for anything but a model with primitives; RangeError for an option out of range. */
  constructor(
    readonly model: PBRModel,
    options: DeformedPointsOptions = {},
  ) {
    if (!Array.isArray(model?.primitives) || !model.root)
      throw new TypeError('DeformedPoints needs a gltf/pbr model; pass a loaded model or a createMesh mesh');
    this.set(options);
  }
  /** Changes the given options; the others keep their values. Nothing changes when one is out of range. */
  set({ size, sizeUnits, color, opacity, shape, vertexColors }: DeformedPointsOptions): this {
    const next = {
      size: size ?? this.size,
      sizeUnits: sizeUnits ?? this.sizeUnits,
      opacity: opacity ?? this.opacity,
      shape: shape ?? this.shape,
      vertexColors: vertexColors ?? this.vertexColors,
    };
    check(next);
    if (color !== undefined) parseColor(color, this.color);
    Object.assign(this, next);
    return this;
  }
  /** Points drawn: the model's vertices over all its primitives. */
  get count(): number {
    let n = 0;
    for (const p of this.model.primitives) n += p.vertices.length / 20;
    return n;
  }
  setup(engine: Engine): void {
    if (this.disposed)
      throw new MargoError('disposed', 'DeformedPoints is disposed; create new points before attaching');
    if (this.model.disposed)
      throw new MargoError('disposed', 'DeformedPoints model is disposed; attach the points to a live model');
    requireWebGPU(engine, 'DeformedPoints');
    this.engine = engine;
    this.unsubscribe ??= this.model.onDispose(() => this.dispose());
    this.read(true);
  }
  // Counts this plugin among the model's readers while it is set up, so the model deforms while hidden.
  private read(on: boolean): void {
    if (this.reading === on) return;
    this.reading = on;
    const n = (deformReaders.get(this.model) ?? 0) + (on ? 1 : -1);
    if (n > 0) deformReaders.set(this.model, n);
    else deformReaders.delete(this.model);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private draw(c: Context): void {
    const e = this.engine,
      primitives = this.model.primitives;
    if (!e || !this.visible || this.model.disposed || !primitives.length) return;
    check(this);
    const device = c.device;
    if (this.device !== device) {
      this.release();
      this.device = device;
    }
    const samples = c.descriptor.multisample?.count ?? 1,
      depth = c.descriptor.depthStencil!.format,
      blend = this.opacity < 1,
      key = c.format + samples + depth + blend;
    if (this.key !== key) {
      const module = device.createShaderModule({ code: deformedPointsShader });
      this.key = key;
      this.groups = [];
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 80,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 64, format: 'float32x4' },
              ],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            blend
              ? {
                  format: c.format,
                  blend: {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  },
                }
              : { format: c.format },
          ],
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format: depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
        multisample: { count: samples },
      });
    }
    // One 256-byte slot per primitive: the uniform offset alignment every device accepts.
    if (!this.frames || this.frames.size < primitives.length * 256) {
      this.frames?.destroy();
      this.frames = device.createBuffer({
        size: primitives.length * 256,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.groups = [];
    }
    const [width, height] = viewSize(c),
      scale = pointScale(c.camera.matrix, this.size, this.sizeUnits, width, height, this.scale),
      f = this.values;
    f.set(c.camera.matrix);
    f.set(this.color, 32);
    f[35] = this.opacity;
    f.set(scale, 36);
    f[39] = +(this.shape === 'round');
    f[40] = +this.vertexColors;
    f[41] = +linearHdr(c.format);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', stencilReadOnly: true },
    });
    try {
      applyView(pass, c);
      pass.setPipeline(this.pipeline!);
      primitives.forEach((p, i) => {
        const count = p.vertices.length / 20;
        if (!count) return;
        f.set(p.node.matrix, 16);
        device.queue.writeBuffer(this.frames!, i * 256, f);
        pass.setBindGroup(
          0,
          (this.groups[i] ??= device.createBindGroup({
            layout: this.pipeline!.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.frames!, offset: i * 256, size: 176 } }],
          })),
        );
        if (p.deformed) pass.setVertexBuffer(0, p.deformed, p.deformedOffset ?? 0, count * 80);
        else pass.setVertexBuffer(0, this.bind(device, p));
        pass.draw(4, count);
        e.stats.drawCalls++;
      });
    } finally {
      pass.end();
    }
  }
  // The bind-pose vertices of a primitive no deformer writes; uploaded again when its vertex array is replaced.
  private bind(device: GPUDevice, p: PBRPrimitive): GPUBuffer {
    let held = this.own.get(p);
    if (held?.source !== p.vertices) {
      held?.buffer.destroy();
      held = {
        source: p.vertices,
        buffer: device.createBuffer({
          size: p.vertices.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      };
      device.queue.writeBuffer(held.buffer, 0, p.vertices as Float32Array<ArrayBuffer>);
      this.own.set(p, held);
    }
    return held.buffer;
  }
  private release(): void {
    this.frames?.destroy();
    for (const { buffer } of this.own.values()) buffer.destroy();
    this.own.clear();
    this.frames = this.pipeline = this.device = undefined;
    this.groups = [];
    this.key = '';
  }
  onDeviceRestored(): void {
    this.release();
  }
  /** Stops drawing and frees the GPU buffers; the model and its deformer are untouched. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.read(false);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

function check({ size, sizeUnits, opacity, shape, vertexColors }: Required<Omit<DeformedPointsOptions, 'color'>>) {
  if (
    !(size >= 0 && Number.isFinite(size)) ||
    (sizeUnits !== 'pixels' && sizeUnits !== 'world') ||
    !(opacity >= 0 && opacity <= 1) ||
    (shape !== 'square' && shape !== 'round')
  )
    throw new RangeError(
      "Invalid point options; use a finite size >= 0, sizeUnits 'pixels' or 'world', opacity in 0..1 and shape 'square' or 'round'",
    );
  if (typeof vertexColors !== 'boolean') throw new TypeError('DeformedPoints vertexColors must be true or false');
}
