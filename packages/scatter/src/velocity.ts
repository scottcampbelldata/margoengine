/// <reference lib="esnext.disposable" preserve="true" />
// Scatter motion vectors (`@margoengine/scatter/velocity`, FG-16): the motion of every swaying blade, leaf and stem drawn
// into TAA's object velocity pass, so TAA keeps their history and `@margoengine/post`'s MotionBlur smears them along
// the wind instead of only along the camera's move. Each vertex is posed twice with the scatter's own pose (its blades,
// ground fit and wind bend), once with this frame's wind clock, eye and pixel footprint and once with the last frame's,
// and both are projected with TAA's current and previous view-projections: the per-vertex velocity of a deforming mesh
// that a velocity buffer carries for skinned and animated geometry (the per-object and per-vertex motion of McGuire,
// Hennessy, Bukowski and Osman, "A Reconstruction Filter for Plausible Motion Blur", I3D 2012,
// https://doi.org/10.1145/2159616.2159639; the history it feeds is Karis, "High Quality Temporal Supersampling",
// SIGGRAPH 2014 Advances in Real-Time Rendering). The pass tests depth for equality, as TAA's does for every object, so
// it draws each stage that writes depth exactly as the colour pass does: opaque rings, a split ring's opaque core, and
// the coverage-depth stage of covered rings and split tips, which keeps a fragment only where the strip's coverage
// passes the pose's hashed threshold (`coverCode` with depth, Wyman and McGuire, "Hashed Alpha Testing", I3D 2017), so
// the same pixels take the grass's depth and its vector.
import type { Scatter, ScatterVelocityParts } from './index.js';
import { poseShader } from './pose.js';
import { windShader } from './wind.js';
import { coverDeclaration, coverageShader, splitDeclaration } from './cover.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** TAA's object velocity frame (`TAAVelocityFrame` of `@margoengine/taa`), as far as this pass reads it. */
export interface ScatterVelocityFrame {
  readonly context: {
    readonly backend: string;
    readonly device?: GPUDevice;
    readonly width: number;
    readonly height: number;
  };
  /** 36 floats: current view-projection, previous view-projection, width, height, history (1 or 0), 0. */
  readonly camera: Float32Array;
  readonly key: object;
  readonly targets: readonly GPUColorTargetState[];
  readonly depthStencil: GPUDepthStencilState;
  readonly samples: number;
}

// Frame values: current and previous view-projection (0-31), size (32: width, height, history, 0), the eye now and
// before with each frame's pixel footprint in w (36, 40), the wind now and before (44, 48), the ground fit (52) and the
// blades (56): the colour pass's frame values 68-80 for each frame.
// `cover` draws a ring's coverage-depth stage: the pose's coverage in `scatterCover`, kept above its threshold w.
const code = (split: boolean, cover: boolean) =>
  (split ? splitDeclaration : '') +
  (cover ? coverDeclaration + coverageShader : '') +
  windShader +
  poseShader +
  `
struct VelocityFrame {current:mat4x4f,previous:mat4x4f,size:vec4f,eye:vec4f,before:vec4f,wind:vec4f,windBefore:vec4f,ground:vec4f,blade:vec4f}
struct Instance {position:vec4f,rotation:vec4f}
@group(0) @binding(0) var<uniform> frame:VelocityFrame;
@group(0) @binding(1) var<storage,read> instances:array<Instance>;
struct Output {@builtin(position) @invariant clip:vec4f,@location(0) current:vec4f,@location(1) previous:vec4f${cover ? ',@location(2) cover:vec4f' : ''}}
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@builtin(instance_index) index:u32)->Output {
 let data=instances[index];
 let then=scatterPose(p,n,data.position,data.rotation,frame.ground,frame.blade,frame.before.xyz,frame.windBefore,frame.before.w).world;
 let now=scatterPose(p,n,data.position,data.rotation,frame.ground,frame.blade,frame.eye.xyz,frame.wind,frame.eye.w).world;
 var o:Output;o.clip=frame.current*vec4f(now,1);o.current=o.clip;o.previous=frame.previous*vec4f(then,1);${cover ? 'o.cover=scatterCover;' : ''}
 if(frame.size.z<=0.0){o.previous.w=-1.0;}
 return o;
}
struct Motion {@location(0) velocity:vec2f,@location(1) depth:f32}
@fragment fn fragment(i:Output)->Motion {
 ${cover ? 'if(scatterCoverage(i.cover)<=i.cover.w){discard;}' : ''}var o:Motion;o.velocity=vec2f(0);o.depth=-1.0;
 if(i.previous.w>0.0){o.velocity=(i.current.xy/i.current.w-i.previous.xy/i.previous.w)*vec2f(0.5,-0.5);o.depth=i.previous.z/i.previous.w;}
 return o;
}
`;

interface View {
  uniform: GPUBuffer;
  /** The last frame's eye and footprint, and wind, once drawn. */
  last?: Float32Array;
  groups: Map<GPURenderPipeline, GPUBindGroup[]>;
}

/**
 * A `TAAVelocityPass` for one Scatter (a `GrassScatter`, a forest, any scatter with wind): `taa.add(new
 * ScatterVelocity(grass))`. TAA then calls `drawVelocity` inside its object velocity pass each frame, so the scatter's
 * wind motion reaches `taa.velocity` and through it `MotionBlur`. Drawn on WebGPU and the full WebGL2 layer; nothing is
 * drawn before the scatter's first frame or after it is disposed.
 *
 * ```ts
 * import { TAA } from 'margoengine/taa';
 * import { MotionBlur } from 'margoengine/post';
 * import { GrassScatter } from 'margoengine/scatter/grass';
 * import { ScatterVelocity } from 'margoengine/scatter/velocity';
 *
 * const grass = GrassScatter.attach(engine, { count: 700_000, wind: [1, 0.3, 0.6] });
 * const taa = TAA.attach(engine);
 * taa.add(new ScatterVelocity(grass));
 * MotionBlur.attach(engine, { velocity: () => taa.velocity });
 * ```
 */
export class ScatterVelocity {
  private readonly views = new Map<object, View>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly values = new Float32Array(60);
  private device?: GPUDevice;
  #disposed = false;
  constructor(readonly scatter: Scatter) {
    if (!scatter || typeof scatter.velocityParts !== 'function')
      throw new TypeError('ScatterVelocity needs a Scatter; pass the scatter whose motion TAA should see');
  }
  /** True after `dispose()`, or once the scatter is disposed. */
  get disposed(): boolean {
    return this.#disposed || this.scatter.disposed;
  }
  /** TAA's `TAAVelocityPass` call: draws this frame's motion of the scatter's depth-writing rings. */
  drawVelocity(pass: GPURenderPassEncoder, frame: ScatterVelocityFrame): void {
    const c = frame.context,
      parts = this.disposed ? undefined : this.scatter.velocityParts();
    if (!parts || c.backend !== 'webgpu' || !c.device) return;
    const device = c.device;
    if (this.device !== device) this.reset(device);
    let view = this.views.get(frame.key);
    if (!view) {
      view = {
        uniform: device.createBuffer({ size: 240, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        groups: new Map(),
      };
      this.views.set(frame.key, view);
    }
    const v = this.values,
      p = parts.values;
    v.set(frame.camera.subarray(0, 36));
    v.set(p.subarray(16, 19), 36);
    v[39] = p[80];
    v.set(p.subarray(68, 72), 44);
    v.set(p.subarray(72, 80), 52);
    // The last frame's pose; on the first frame of a view, this frame's (no wind motion, the camera's alone).
    const last = view.last ?? v.subarray(36, 40).slice();
    v.set(last.subarray(0, 4), 40);
    v.set(view.last ? last.subarray(4, 8) : v.subarray(44, 48), 48);
    device.queue.writeBuffer(view.uniform, 0, v as Float32Array<ArrayBuffer>);
    (view.last ??= new Float32Array(8)).set(v.subarray(36, 40));
    view.last.set(v.subarray(44, 48), 4);
    // The colour pass's depth-writing stages of each ring (the pose this frame is posed last, so `scatterCover` is
    // this frame's): an opaque ring; a split ring's core and its tips' coverage depth; a covered ring's coverage depth.
    for (let ring = 0; ring < 3; ring++) {
      const stage = parts.stages[ring];
      const uses: [boolean, boolean][] =
        stage === 'opaque'
          ? [[false, false]]
          : stage === 'split'
            ? [
                [true, false],
                [true, true],
              ]
            : stage === 'cover'
              ? [[false, true]]
              : [];
      for (const [split, cover] of uses) this.drawRing(pass, device, parts, frame, view, ring, split, cover);
    }
  }
  private drawRing(
    pass: GPURenderPassEncoder,
    device: GPUDevice,
    parts: ScatterVelocityParts,
    frame: ScatterVelocityFrame,
    view: View,
    ring: number,
    split: boolean,
    cover: boolean,
  ): void {
    const pipeline = this.pipeline(device, parts, frame, split, cover);
    let groups = view.groups.get(pipeline);
    if (!groups) {
      groups = parts.instances.map((buffer, i) =>
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { buffer: view.uniform },
            { buffer },
            ...(parts.route ? [parts.route.count(i)] : []),
            ...parts.entries(),
          ].map((resource, binding) => ({ binding, resource })),
        }),
      );
      view.groups.set(pipeline, groups);
    }
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, groups[ring]);
    pass.setVertexBuffer(0, parts.vertices[ring]);
    pass.setIndexBuffer(parts.indices[ring], 'uint32');
    if (parts.route) pass.drawIndexed(parts.counts[ring], parts.route.capacity);
    else pass.drawIndexedIndirect(parts.commands, ring * 20);
  }
  /** TAA's call when a view's history goes: forgets that view's last frame. */
  releaseVelocity(key: object): void {
    const view = this.views.get(key);
    if (!view) return;
    view.uniform.destroy();
    this.views.delete(key);
  }
  /** Frees the uniforms and pipelines; TAA drops this pass on its next frame. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.reset(undefined);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private reset(device: GPUDevice | undefined): void {
    for (const key of [...this.views.keys()]) this.releaseVelocity(key);
    this.pipelines.clear();
    this.device = device;
  }
  private pipeline(
    device: GPUDevice,
    parts: ScatterVelocityParts,
    frame: ScatterVelocityFrame,
    split: boolean,
    cover: boolean,
  ): GPURenderPipeline {
    const key = `${split}:${cover}:${frame.samples}:${frame.depthStencil.format}:${parts.stride}:${!!parts.route}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      let text = parts.pose(code(split, cover), parts.route ? 3 : 2);
      if (parts.route) text = parts.route.vertex(text);
      const module = device.createShaderModule({ code: text });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: parts.stride,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: [...frame.targets] },
        multisample: { count: frame.samples },
        depthStencil: frame.depthStencil,
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}
