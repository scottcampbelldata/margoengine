import { applyView } from '../../shared/view-rect.js';
import type { VFXExtension, VFXRibbons, VFXState } from './base.js';
import { frame } from './frame.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };

/** Most recorded points across all of an effect's ribbons: capacity x (points - 1), 16 bytes each (64 MB). */
export const MAX_RIBBON_POINTS = 4_194_304;

// control: records made so far (n), records that can be read (min(n, r)), ring length r = points - 1, points.
// shape.x: width. eye: the camera position, so each ribbon turns its face to the eye.
const uniform = /* wgsl */ `
struct Ribbon {control:vec4u,shape:vec4f,eye:vec4f}
@group(0) @binding(14) var<uniform> ribbon:Ribbon;
`;

/**
 * Each record stores every live particle's position, stamped with its birth angle plus 1 (drawn once per spawn, never
 * 0, so a cleared buffer matches no particle), in slot-major rings: record m of slot s is at s * r + m % r.
 */
const record = /* wgsl */ `
@group(0) @binding(13) var<storage,read_write> ribbonHistory:array<vec4f>;
${uniform}
@compute @workgroup_size(256) fn ribbonRecord(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=f.control.x){return;}let p=particles[id.x*2];if(p.w<=0){return;}
  ribbonHistory[id.x*ribbon.control.z+(ribbon.control.x-1u)%ribbon.control.z]=vec4f(p.xyz,particles[f.control.x*2+id.x*2+1].x+1);
}`;

/**
 * One triangle strip per slot: vertex 2k and 2k+1 are the two edges at point k (0: the particle, k >= 1: k records
 * back). Records of this life are the newest ones with its stamp, a run that starts at record 1 because every record
 * since its birth stored it, so a binary search finds the run's length; points past it collapse onto the oldest point,
 * so a young particle's ribbon is shorter. A dead slot is moved outside the clip volume. The strip's side is
 * perpendicular to the ribbon (the neighbours' difference, or the next pair's where the newest record is the particle
 * itself) and to the eye, so it shows its face; where neither gives a direction the strip has no width. Alpha falls from the particle's own (with its life
 * fade) at the head to 0 at the tail, and across the width as 1 - e^2 (e from -1 to 1).
 */
export const ribbonShader =
  frame +
  /* wgsl */ `
@group(0) @binding(1) var<storage,read> particles:array<vec4f>;
@group(0) @binding(13) var<storage,read> ribbonHistory:array<vec4f>;
${uniform}
struct Out {@builtin(position) clip:vec4f,@location(0) color:vec4f,@location(1) edge:f32}
fn ribbonPoint(slot:u32,k:u32,head:vec3f)->vec3f {
  if(k==0u){return head;}return ribbonHistory[slot*ribbon.control.z+(ribbon.control.x-k)%ribbon.control.z].xyz;
}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) slot:u32)->Out {
  var o:Out;let at=slot*2;let cold=f.control.x*2+at;let head=particles[at];let color=particles[cold];let rotation=particles[cold+1];
  if(head.w<=0){o.clip=vec4f(2,2,2,1);return o;}
  let stamp=rotation.x+1;var lo=0u;var hi=ribbon.control.y;
  loop{if(lo>=hi){break;}let mid=(lo+hi+1u)/2u;if(ribbonHistory[slot*ribbon.control.z+(ribbon.control.x-mid)%ribbon.control.z].w==stamp){lo=mid;}else{hi=mid-1u;}}
  let k=min(v/2u,lo);let p=ribbonPoint(slot,k,head.xyz);
  var t=ribbonPoint(slot,max(k,1u)-1u,head.xyz)-ribbonPoint(slot,min(k+1u,lo),head.xyz);
  if(dot(t,t)<1e-12){t=ribbonPoint(slot,max(k,2u)-2u,head.xyz)-ribbonPoint(slot,min(k+2u,lo),head.xyz);}
  let side=cross(t,ribbon.eye.xyz-p);let s=dot(side,side);
  let e=f32(v%2u)*2-1;o.edge=e;
  o.clip=f.camera*vec4f(p+side*inverseSqrt(max(s,1e-24))*select(0.0,e*ribbon.shape.x*0.5,s>1e-12),1);
  o.color=vec4f(color.rgb,color.a*clamp(head.w/rotation.z,0.0,1.0)*(1-f32(v/2u)/f32(ribbon.control.w-1u)));return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {return vec4f(i.color.rgb,i.color.a*(1-i.edge*i.edge));}`;

const points = (v: VFXRibbons) => v.points ?? 16;

/**
 * The `ribbons` feature: a camera-facing ribbon behind every particle through its last positions (`points`, recorded
 * every `interval` seconds), for smoke and magic trails. Pass it as `{ribbons}` to `VFX` from `@margoengine/vfx/base`;
 * the root `VFX` has it. Ribbons draw after the billboards in their own pass, alpha blended and depth tested, in slot
 * order; `heads: false` leaves the billboards out.
 */
export const ribbons: VFXExtension<VFXRibbons> = {
  validate(v, o) {
    if (!v || typeof v !== 'object')
      throw new TypeError('VFX ribbons must be an object; pass e.g. {points: 16, interval: 1 / 60}');
    const n = points(v),
      interval = v.interval ?? 1 / 60;
    if (!Number.isInteger(n) || n < 2 || n > 64)
      throw new RangeError(`VFX ribbons points is ${n}; pass a whole number from 2 to 64`);
    if (typeof interval !== 'number' || !(interval >= 0 && interval <= 1))
      throw new RangeError('VFX ribbons interval must be 0 to 1 seconds; pass e.g. 1 / 60, or 0 for every frame');
    if (v.width !== undefined && !(typeof v.width === 'number' && Number.isFinite(Math.fround(v.width)) && v.width > 0))
      throw new RangeError('VFX ribbons width must be a world distance above 0; pass e.g. 0.1');
    if (v.heads !== undefined && typeof v.heads !== 'boolean')
      throw new TypeError('VFX ribbons heads must be true or false; pass a boolean');
    if ((o.capacity ?? 1_000_000) * (n - 1) > MAX_RIBBON_POINTS)
      throw new RangeError(
        `VFX ribbons need capacity x (points - 1) at most ${MAX_RIBBON_POINTS}; lower capacity or points`,
      );
  },
  simulation: (code) => code + record,
  create(state: VFXState, value, owned) {
    const { device, capacity, options } = state,
      count = points(value),
      ring = count - 1,
      history = device.createBuffer({ size: capacity * ring * 16, usage: GPUBufferUsage.STORAGE });
    owned.push(history);
    const buffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    owned.push(buffer);
    const recorder = device.createComputePipeline({
        layout: 'auto',
        compute: { module: state.module, entryPoint: 'ribbonRecord' },
      }),
      entries = (layout: GPUBindGroupLayout) =>
        device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: state.uniform } },
            { binding: 1, resource: { buffer: state.particles } },
            { binding: 13, resource: { buffer: history } },
            { binding: 14, resource: { buffer } },
          ],
        }),
      recordGroup = entries(recorder.getBindGroupLayout(0)),
      values = new Float32Array(12),
      ints = new Uint32Array(values.buffer),
      pipelines = new Map<string, [GPURenderPipeline, GPUBindGroup]>(),
      color: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' },
      depth: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true },
      descriptor: GPURenderPassDescriptor = { colorAttachments: [color], depthStencilAttachment: depth };
    let module: GPUShaderModule | undefined,
      records = 0,
      // The first frame records, so a ribbon starts at the first particle position.
      elapsed = Infinity,
      recording = false;
    const settings = () => {
      const v = options.ribbons;
      if (!v || points(v) !== count)
        throw new TypeError('VFX ribbons and their points are fixed at attach; attach a new VFX to change them');
      return v;
    };
    return {
      hides: () => settings().heads === false,
      write(c) {
        const v = settings(),
          interval = v.interval ?? 1 / 60;
        elapsed += c.delta;
        recording = elapsed >= interval;
        if (recording) {
          records++;
          // A long frame (and the first) records once and does not try to catch up.
          elapsed = elapsed - interval >= interval ? 0 : elapsed - interval;
        }
        ints[0] = records;
        ints[1] = Math.min(records, ring);
        ints[2] = ring;
        ints[3] = count;
        values[4] = v.width ?? options.size ?? 0.1;
        values.set(c.camera.position, 8);
        c.device.queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
      },
      run(pass) {
        if (!recording) return;
        pass.setPipeline(recorder);
        pass.setBindGroup(0, recordGroup);
        pass.dispatchWorkgroups(Math.ceil(capacity / 256));
      },
      draw(c) {
        const format = c.descriptor.depthStencil!.format,
          samples = c.descriptor.multisample?.count ?? 1,
          key = c.format + ':' + format + ':' + samples;
        let drawing = pipelines.get(key);
        if (!drawing) {
          module ??= device.createShaderModule({ code: ribbonShader });
          const pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vertex' },
            fragment: {
              module,
              entryPoint: 'fragment',
              targets: [
                {
                  format: c.format,
                  blend: {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  },
                },
              ],
            },
            primitive: { topology: 'triangle-strip' },
            multisample: c.descriptor.multisample,
            depthStencil: { format, depthWriteEnabled: false, depthCompare: 'greater-equal' },
          });
          drawing = [pipeline, entries(pipeline.getBindGroupLayout(0))];
          pipelines.set(key, drawing);
        }
        color.view = c.color;
        depth.view = c.depth;
        depth.stencilReadOnly = format.includes('stencil') ? true : undefined;
        const pass = c.encoder.beginRenderPass(descriptor);
        pass.setPipeline(drawing[0]);
        pass.setBindGroup(0, drawing[1]);
        applyView(pass, c);
        pass.draw(count * 2, capacity);
        pass.end();
        state.stats.drawCalls++;
      },
    };
  },
};
