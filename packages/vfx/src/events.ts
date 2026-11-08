import { MargoError } from '@margoengine/math/errors';
import type { VFXEvents, VFXExtension, VFXState } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };

/**
 * The event buffer, u32s: [0..3] totals (1: events listed last frame), then n = ceil(capacity / 256) workgroup counts
 * (turned into offsets), then n x 256 listed slots (each workgroup's event slots in slot order), then the list (every
 * event's slot in slot order, at most capacity). Event data is a second buffer, two vec4s (position, velocity) a slot,
 * in two halves by frame parity: an event stores in this frame's half and births read last frame's, so a slot that
 * raises a new event never overwrites one still waiting to be read.
 */
const declarations = /* wgsl */ `
@group(0) @binding(15) var<storage,read_write> events:array<u32>;
@group(0) @binding(16) var<storage,read_write> eventData:array<vec4f>;
struct Events {control:vec4u,shape:vec4f,velocity:vec4f,color:vec4f}
@group(0) @binding(17) var<uniform> ev:Events;
var<private> eventHere:u32;
fn eventGroups()->u32 {return (f.control.x+255u)/256u;}
fn storeEvent(i:u32,p:Particle){let at=(f.control.z%2u)*f.control.x*2u+i*2u;eventData[at]=vec4f(p.positionLife.xyz,0);eventData[at+1u]=vec4f(p.velocitySize.xyz,0);eventHere=1u;}
`;
/** The scan and compaction of the simulation's own draw list (shader.ts), over the event counts. */
const kernels = /* wgsl */ `
@compute @workgroup_size(256) fn eventScan(@builtin(local_invocation_index) l:u32){
  let n=eventGroups();let per=(n+255u)/256u;let a=min(l*per,n);let b=min(a+per,n);
  var sum=0u;for(var k=a;k<b;k++){sum+=events[4u+k];}
  var run=prefix(l,sum)-sum;for(var k=a;k<b;k++){let v=events[4u+k];events[4u+k]=run;run+=v;}
  if(l==255u){events[1]=run;}
}
@compute @workgroup_size(256) fn eventCompact(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32){
  let n=eventGroups();let start=events[4u+w.x];var end=events[1];if(w.x+1u<n){end=events[4u+w.x+1u];}
  if(l<end-start){events[4u+n*257u+start+l]=events[4u+n+w.x*256u+l];}
}`;

const edits: Record<'ticket' | 'birth' | 'death' | 'collision' | 'list', [string, string]> = {
  // A birth whose ticket is past the emitter's budget takes event (ticket - budget) / count of last frame's list, if any.
  ticket: [
    'if(ticket>=f.control.y){particles[at].w=0;return 0u;}',
    'var child=0u;if(ticket>=f.control.y){let e=(ticket-f.control.y)/ev.control.x;if(e>=events[1]){particles[at].w=0;return 0u;}child=events[4u+eventGroups()*257u+e]+1u;}',
  ],
  // A child starts at its event's position with `inherit` of the parent's velocity plus its own, with the event's own
  // life, size and colour, and generation 1 (rotation.w), so it never raises events of its own.
  birth: [
    'particles[cold]=p.color;particles[cold+1]=p.rotation;',
    `if(child>0u){let source=((f.control.z+1u)%2u)*f.control.x*2u+(child-1u)*2u;let childLife=mix(ev.shape.x,ev.shape.y,random(seed));
    p.positionLife=vec4f(eventData[source].xyz,max(0.0,childLife-dt));
    p.velocitySize=vec4f(eventData[source+1u].xyz*ev.shape.w+ev.velocity.xyz+(vec3f(random(seed+1u),random(seed+2u),random(seed+3u))*2-1)*ev.velocity.w,ev.shape.z);
    p.color=vec4f(ev.color.rgb*f.emissionExtent.w,ev.color.a);p.rotation=vec4f(p.rotation.x,p.rotation.y,childLife,1);}
    particles[cold]=p.color;particles[cold+1]=p.rotation;`,
  ],
  // A first-generation particle whose life ends this frame raises a death event where it is.
  death: [
    '  p.positionLife.w-=dt;',
    '  p.positionLife.w-=dt;if(p.positionLife.w<=0&&particles[at].w>0&&particles[cold+1].w==0){storeEvent(i,p);}',
  ],
  // A first-generation particle that meets the ground faster than `speed` raises a collision event as it touches.
  collision: [
    'if(p.velocitySize.y<0){p.velocitySize.y=-p.velocitySize.y*f.physics.z;}',
    'if(p.velocitySize.y<0){if(-p.velocitySize.y>bitcast<f32>(ev.control.z)&&particles[cold+1].w==0){storeEvent(i,p);}p.velocitySize.y=-p.velocitySize.y*f.physics.z;}',
  ],
  // Each workgroup lists its events in slot order, as it lists the drawn particles.
  list: [
    'if(l==255u){groups[w.x]=rank;}',
    'if(l==255u){groups[w.x]=rank;}\n  let er=prefix(l,eventHere);if(eventHere==1u){events[4u+eventGroups()+w.x*256u+er-1u]=id.x;}if(l==255u){events[4u+w.x]=er;}',
  ],
};

function once(code: string, [from, to]: [string, string]): string {
  if (code.split(from).length !== 2)
    throw new MargoError(
      'unsupported',
      'VFX events need the simulation shader they were written for; update the event edits',
    );
  return code.replace(from, to);
}

const range = (v: unknown, name: string, min: number, max: number) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new RangeError(`VFX events ${name} must be a number from ${min} to ${max}; pass a finite value in range`);
};

/**
 * The `events` feature (sub-emitters): a particle that dies, or hits the ground faster than `speed`, raises an event on
 * the GPU, and the next frame `count` new particles are born at it into the free slots of the same effect, with their
 * own velocity, life, size and colour. Events and their births are listed in slot order, so the same frames give the
 * same particles. Born particles never raise events. Pass it as `{events}` to `VFX` from `@margoengine/vfx/base`; the
 * root `VFX` has it. `on` is read at attach; the rest every frame.
 */
export const events: VFXExtension<VFXEvents> = {
  validate(e) {
    if (!e || typeof e !== 'object' || (e.on !== 'death' && e.on !== 'collision'))
      throw new TypeError("VFX events needs on: 'death' or 'collision'; pass e.g. {on: 'death', count: 8}");
    const count = e.count ?? 8;
    if (!Number.isInteger(count) || count < 1 || count > 64)
      throw new RangeError(`VFX events count is ${count}; pass a whole number of births per event from 1 to 64`);
    const life = e.lifetime ?? [0.5, 1];
    if (!Array.isArray(life) || life.length !== 2) throw new TypeError('VFX events lifetime needs [min, max] seconds');
    range(life[0], 'lifetime[0]', 1e-6, 1e6);
    range(life[1], 'lifetime[1]', life[0], 1e6);
    range(e.size ?? 0.05, 'size', 1e-6, 1e6);
    range(e.spread ?? 1, 'spread', 0, 1e4);
    range(e.inherit ?? 0, 'inherit', -10, 10);
    range(e.speed ?? 0.5, 'speed', 0, 1e4);
    const v = e.velocity ?? [0, 0, 0];
    if (!Array.isArray(v) || v.length !== 3) throw new TypeError('VFX events velocity needs [x, y, z]');
    v.forEach((x, i) => range(x, `velocity[${i}]`, -1e4, 1e4));
    const c = e.color ?? [1, 1, 1, 1];
    if (!Array.isArray(c) || c.length !== 4) throw new TypeError('VFX events color needs linear [r, g, b, a]');
    c.forEach((x, i) => range(x, `color[${i}]`, 0, 1));
  },
  simulation(code, e) {
    let out = code.replace('fn update(', declarations + 'fn update(');
    for (const key of ['ticket', 'birth', e.on, 'list'] as const) out = once(out, edits[key]);
    return out + kernels;
  },
  create(state: VFXState, e, owned) {
    const { device, capacity, options } = state,
      n = Math.ceil(capacity / 256),
      list = device.createBuffer({
        size: (4 + n * 257 + capacity) * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    owned.push(list);
    const data = device.createBuffer({ size: capacity * 64, usage: GPUBufferUsage.STORAGE });
    owned.push(data);
    const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    owned.push(uniform);
    const on = e.on,
      step = (entryPoint: string) => {
        const pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: state.module, entryPoint },
        });
        return [
          pipeline,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: state.uniform } },
              { binding: 15, resource: { buffer: list } },
            ],
          }),
        ] as const;
      },
      scan = step('eventScan'),
      compact = step('eventCompact'),
      values = new Float32Array(16),
      ints = new Uint32Array(values.buffer);
    return {
      births: true,
      compute: [
        { binding: 15, resource: { buffer: list } },
        { binding: 16, resource: { buffer: data } },
        { binding: 17, resource: { buffer: uniform } },
      ],
      reset: () => device.queue.writeBuffer(list, 0, new Uint32Array(4)),
      write(c) {
        const v = options.events;
        if (!v || v.on !== on)
          throw new TypeError('VFX events and their on are fixed at attach; attach a new VFX to change them');
        const life = v.lifetime ?? [0.5, 1];
        ints[0] = v.count ?? 8;
        values[2] = v.speed ?? 0.5;
        values.set([life[0], life[1], v.size ?? 0.05, v.inherit ?? 0], 4);
        values.set(v.velocity ?? [0, 0, 0], 8);
        values[11] = v.spread ?? 1;
        values.set(v.color ?? [1, 1, 1, 1], 12);
        c.device.queue.writeBuffer(uniform, 0, values as Float32Array<ArrayBuffer>);
      },
      run(pass) {
        for (const [[pipeline, group], groups] of [
          [scan, 1],
          [compact, n],
        ] as const) {
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(groups);
        }
      },
    };
  },
};
