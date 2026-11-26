/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { finiteVector } from '@margoengine/math/validate';
import type { Vec3 } from '@margoengine/math';
import { applyView, viewSize } from '../../shared/view-rect.js';
import {
  LIGHTNING_COLOR,
  type LightningBoltOptions,
  type LightningChannelSource,
  type LightningStrike,
  type LiveStrike,
} from './weather.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Floats per segment of a {@link LightningChannel}: start xyz and its branch order, end xyz and the bolt's slot (set when drawn). */
export const CHANNEL_STRIDE = 8;
/** Most bolts drawn at once. */
export const MAX_BOLTS = 4;
/** Most segments of one channel. */
export const MAX_CHANNEL_SEGMENTS = 2048;

/** Settings of {@link lightningChannel}. */
export interface LightningChannelOptions {
  /** Seeds the growth: the same seed and settings give the same channel. */
  seed: number;
  /** Where the channel starts, in the cloud, world metres. */
  start: Vec3;
  /** Where it ends, on the ground. */
  end: Vec3;
  /** Growth steps down the main channel, 8 to 400. Default 80. */
  detail?: number;
  /** Half angle of the cone a step is drawn in, degrees, 5 to 85. Default 50. */
  spread?: number;
  /** Chance each channel point forks a branch, 0 to 0.5. Default 0.06. */
  branching?: number;
  /** Fork generations below the main channel, 0 to 3. Default 2. */
  orders?: number;
  /** Candidate steps weighed at each growth step, 2 to 32. Default 10. */
  candidates?: number;
  /** Exponent of the field a step is weighed by (the dielectric breakdown exponent), 0 to 8. Default 2. */
  eta?: number;
  /** Most segments, main channel first, 8 to {@link MAX_CHANNEL_SEGMENTS}. Default 768. */
  maxSegments?: number;
}

/** A lightning channel: straight segments from the cloud to the ground and the forks that leave it. */
export interface LightningChannel {
  /** `count` segments of {@link CHANNEL_STRIDE} floats: start xyz, branch order (0 the main channel), end xyz, 0. */
  readonly segments: Float32Array;
  readonly count: number;
  /** Segments of the main channel (the first ones), a polyline from `start` to `end`. */
  readonly trunk: number;
  readonly start: Vec3;
  readonly end: Vec3;
}

// mulberry32 (Tommy Ettinger): a small seeded generator; growth takes its numbers in a fixed order, so a seed is a bolt.
function generator(seed: number): () => number {
  let state = (Math.floor(seed) | 0) ^ 0x9e3779b9;
  return () => {
    let t = (state = (state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm = (v: number[]): number[] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Grows a lightning channel from `start` to `end`, deterministically from the seed. The channel is built the way the
 * stepped leader is, a step at a time, and each step is chosen from random candidates in a cone around the way the
 * field points (toward the ground, with a slow sideways drift for the large bends), weighed by the candidate's
 * alignment with the field to the power `eta` and cut by the shielding of the channel already grown nearby: the
 * stochastic growth law of the dielectric breakdown model (L. Niemeyer, L. Pietronero and H. J. Wiesmann, "Fractal
 * dimension of dielectric breakdown", Phys. Rev. Lett. 52(12):1033-1036, 1984, as applied to lightning by T. Kim and
 * M. C. Lin, "Physically based animation and rendering of lightning", Pacific Graphics 2004, 267-275), without its
 * grid. Forks leave the main channel and each other downward, shorter at each generation, as in the particle-traced
 * channel of K. T. Reed and B. Wyvill, "Visual simulation of lightning", SIGGRAPH 1994, 359-364. The main channel
 * always reaches `end`; forks stop at the ground height of `end` or at the segment cap.
 * @throws TypeError for an end that is not three finite numbers; RangeError for a setting out of range or a start not above the end.
 */
export function lightningChannel(options: LightningChannelOptions): LightningChannel {
  const {
    seed,
    start,
    end,
    detail = 80,
    spread = 50,
    branching = 0.06,
    orders = 2,
    candidates = 10,
    eta = 2,
    maxSegments = 768,
  } = options;
  if (!Number.isFinite(seed)) throw new RangeError('Lightning channel seed must be a finite number');
  finiteVector(start, 3, 'Lightning channel start');
  finiteVector(end, 3, 'Lightning channel end');
  const range = (v: number, lo: number, hi: number, name: string, whole = false) => {
    if (!(v >= lo && v <= hi) || (whole && !Number.isInteger(v)))
      throw new RangeError(
        `Lightning channel ${name} must be ${whole ? 'a whole number ' : ''}from ${lo} to ${hi}; got ${String(v)}`,
      );
  };
  range(detail, 8, 400, 'detail');
  range(spread, 5, 85, 'spread');
  range(branching, 0, 0.5, 'branching');
  range(orders, 0, 3, 'orders', true);
  range(candidates, 2, 32, 'candidates', true);
  range(eta, 0, 8, 'eta');
  range(maxSegments, 8, MAX_CHANNEL_SEGMENTS, 'maxSegments', true);
  if (!(start[1] > end[1]))
    throw new RangeError('Lightning channel start must be above its end; give the cloud end first');
  const random = generator(seed),
    length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]),
    step = length / detail,
    cone = (spread * Math.PI) / 180,
    ground = end[1],
    nodes: number[] = [],
    out: number[] = [];
  let trunk = 0;
  const push = (a: readonly number[], b: readonly number[], order: number): void => {
    out.push(a[0], a[1], a[2], order, b[0], b[1], b[2], 0);
    nodes.push(b[0], b[1], b[2]);
  };
  // One growth step from `tip` toward the field `pref` (unit): the weighed pick among random candidates.
  const grow = (tip: readonly number[], pref: number[], eta2: number): number[] | undefined => {
    let total = 0;
    const picks: { p: number[]; w: number }[] = [];
    for (let k = 0; k < candidates; k++) {
      // A direction in the cone around pref: polar angle from sqrt(u) (an even spread over the cap), any azimuth.
      const theta = cone * Math.sqrt(random()),
        phi = random() * Math.PI * 2,
        up = Math.abs(pref[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0],
        u = norm([
          pref[1] * up[2] - pref[2] * up[1],
          pref[2] * up[0] - pref[0] * up[2],
          pref[0] * up[1] - pref[1] * up[0],
        ]),
        v = [pref[1] * u[2] - pref[2] * u[1], pref[2] * u[0] - pref[0] * u[2], pref[0] * u[1] - pref[1] * u[0]],
        sin = Math.sin(theta),
        cos = Math.cos(theta),
        d = [0, 1, 2].map((i) => pref[i] * cos + (u[i] * Math.cos(phi) + v[i] * Math.sin(phi)) * sin),
        p = [tip[0] + d[0] * step, tip[1] + d[1] * step, tip[2] + d[2] * step];
      if (p[1] < ground) continue;
      // Shielding: channel already grown within three steps of the candidate (not the tip's own last few) lowers its pull.
      let shield = 0;
      for (let i = 0; i + 2 < nodes.length - 12; i += 3) {
        const r2 = (nodes[i] - p[0]) ** 2 + (nodes[i + 1] - p[1]) ** 2 + (nodes[i + 2] - p[2]) ** 2;
        if (r2 < 9 * step * step) shield += (step * step) / (r2 + 0.25 * step * step);
      }
      const w = Math.max(cos, 0) ** eta2 / (1 + 0.5 * shield);
      picks.push({ p, w });
      total += w;
    }
    if (!picks.length || !(total > 0)) return undefined;
    let r = random() * total;
    for (const c of picks) if ((r -= c.w) <= 0) return c.p;
    return picks[picks.length - 1].p;
  };
  // The main channel: toward the end, with a slow sideways drift (a random walk, pulled back) for the large bends.
  let tip: number[] = [start[0], start[1], start[2]],
    wander = [0, 0, 0],
    guard = 0;
  nodes.push(tip[0], tip[1], tip[2]);
  const trunkDirs: number[][] = [];
  while (guard++ < 4 * detail) {
    const toEnd = [end[0] - tip[0], end[1] - tip[1], end[2] - tip[2]],
      left = Math.hypot(toEnd[0], toEnd[1], toEnd[2]);
    if (left <= 1.2 * step) break;
    wander = [0, 1, 2].map((i) => (i === 1 ? 0 : wander[i] * 0.9 + (random() - 0.5) * 0.35));
    const pref = norm([toEnd[0] / left + wander[0], toEnd[1] / left, toEnd[2] / left + wander[2]]),
      next = grow(tip, pref, eta);
    if (!next) break;
    push(tip, next, 0);
    trunkDirs.push(norm([next[0] - tip[0], next[1] - tip[1], next[2] - tip[2]]));
    tip = next;
  }
  push(tip, [end[0], end[1], end[2]], 0);
  trunkDirs.push(norm([end[0] - tip[0], end[1] - tip[1], end[2] - tip[2]]));
  trunk = out.length / CHANNEL_STRIDE;
  // Forks, generation by generation: from a channel point downward and to one side, shorter each time.
  let parents: { at: number[]; dir: number[] }[] = [];
  for (let i = 0; i < trunk; i++)
    parents.push({ at: [out[i * 8 + 4], out[i * 8 + 5], out[i * 8 + 6]], dir: trunkDirs[i] });
  for (let order = 1; order <= orders && out.length / CHANNEL_STRIDE < maxSegments; order++) {
    const made: { at: number[]; dir: number[] }[] = [],
      chance = branching * 0.6 ** (order - 1),
      steps = Math.max(2, Math.round(detail * 0.25 * 0.5 ** (order - 1)));
    for (const parent of parents) {
      if (random() >= chance || parent.at[1] - ground < 2 * step) continue;
      const side = random() * Math.PI * 2,
        pref0 = norm([Math.cos(side) * 0.8, -0.6, Math.sin(side) * 0.8]);
      const count = 2 + Math.floor(random() * steps);
      let p = parent.at,
        pref = pref0,
        drift = [0, 0, 0];
      for (let s = 0; s < count && out.length / CHANNEL_STRIDE < maxSegments; s++) {
        drift = [0, 1, 2].map((i) => drift[i] * 0.85 + (random() - 0.5) * 0.3);
        pref = norm([pref0[0] + drift[0], pref0[1] * 0.7 - 0.3 + drift[1], pref0[2] + drift[2]]);
        const next = grow(p, pref, 1);
        if (!next) break;
        push(p, next, order);
        made.push({ at: next, dir: norm([next[0] - p[0], next[1] - p[1], next[2] - p[2]]) });
        p = next;
        if (p[1] <= ground + 0.5 * step) break;
      }
    }
    parents = made;
  }
  const count = out.length / CHANNEL_STRIDE;
  return {
    segments: Float32Array.from(out),
    count,
    trunk,
    start: [start[0], start[1], start[2]],
    end: [end[0], end[1], end[2]],
  };
}

/**
 * The lights that stand for a channel: its main channel cut into `count` equal pieces by length, each a light at the
 * piece's middle for a line of the piece's length (`radius` half of it), with a share of the light (`weight`, all
 * summing to 1) from the light a return stroke gives off at that height, which falls off as exp(-height / `decay`)
 * (Jordan and Uman 1983, as {@link Weather.lightningLight}).
 * @throws RangeError for a count that is not a whole number from 1 to 8 or a decay of 0 or less.
 */
export function channelLightPoints(
  channel: LightningChannel,
  count: number,
  decay: number,
): { position: Vec3; weight: number; radius: number }[] {
  if (!Number.isInteger(count) || count < 1 || count > 8)
    throw new RangeError('Lightning channel light count must be a whole number from 1 to 8');
  if (!(decay > 0) || !Number.isFinite(decay))
    throw new RangeError('Lightning channel light decay must be above 0 metres');
  const s = channel.segments,
    lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < channel.trunk; i++) {
    const o = i * CHANNEL_STRIDE,
      l = Math.hypot(s[o + 4] - s[o], s[o + 5] - s[o + 1], s[o + 6] - s[o + 2]);
    lengths.push(l);
    total += l;
  }
  const pieces = Array.from({ length: count }, () => ({ x: 0, y: 0, z: 0, w: 0, length: 0 }));
  let walked = 0;
  for (let i = 0; i < channel.trunk; i++) {
    const o = i * CHANNEL_STRIDE,
      mid = walked + lengths[i] / 2,
      piece = pieces[Math.min(count - 1, Math.floor((mid / total) * count))],
      y = (s[o + 1] + s[o + 5]) / 2,
      w = lengths[i] * Math.exp(-Math.max(0, y - channel.end[1]) / decay);
    piece.x += w * (s[o] + s[o + 4]) * 0.5;
    piece.y += w * y;
    piece.z += w * (s[o + 2] + s[o + 6]) * 0.5;
    piece.w += w;
    piece.length += lengths[i];
    walked += lengths[i];
  }
  const sum = pieces.reduce((a, p) => a + p.w, 0);
  return pieces
    .filter((p) => p.w > 0)
    .map((p) => ({ position: [p.x / p.w, p.y / p.w, p.z / p.w] as Vec3, weight: p.w / sum, radius: p.length / 2 }));
}

/** The brightness of a stroke train `seconds` after the flash started: each stroke rises in 8 ms and falls with time constant `tau`. */
export function strokeLevel(
  seconds: number,
  offsets: readonly number[],
  amplitudes: readonly number[],
  tau: number,
): number {
  let level = 0;
  for (let i = 0; i < offsets.length; i++) {
    const t = seconds - offsets[i];
    if (t < 0) continue;
    level = Math.max(level, amplitudes[i] * (t < 0.008 ? t / 0.008 : Math.exp(-(t - 0.008) / tau)));
  }
  return level;
}

/** The weather a {@link LightningBolt} draws. A `Weather` from `@margoengine/sky/weather` is one. */
export interface LightningBoltSource {
  readonly options: {
    readonly lightning?: {
      readonly bolt?: LightningBoltOptions;
      readonly hold?: number;
      readonly seed?: number;
      readonly light?: { readonly color?: Vec3 };
      readonly cloud?: { readonly base?: number };
    };
  };
  readonly liveStrikes: readonly LiveStrike[];
  readonly lastStrike: LightningStrike | undefined;
  channelSource?: LightningChannelSource;
}

/** Settings of {@link LightningBolt}. The bolt's look and shape are `weather.options.lightning.bolt` ({@link LightningBoltOptions}). */
export interface LightningBoltAttachOptions {
  /** The weather whose strikes are drawn. */
  weather: LightningBoltSource;
  /** Supply an immutable physical channel per strike. An absent channel uses procedural growth. */
  channel?: (strike: LightningStrike) => LightningChannel | undefined;
  /** Radiance of the core at its peak, linear, before `bolt.scale`. Default 80. */
  coreRadiance?: number;
  /** Radiance of the glow at its peak, linear, before `bolt.scale`. Default 6. */
  glowRadiance?: number;
}

const DEFAULT_TOP = 1500;
const shader = `
struct Bolt { camera:mat4x4f, eye:vec4f, screen:vec4f, look:vec4f, core:vec4f, glow:vec4f, levels:array<vec4f,${MAX_BOLTS}> }
@group(0) @binding(0) var<uniform> b:Bolt;
@group(0) @binding(1) var<storage,read> segs:array<vec4f>;
struct Out {@builtin(position) position:vec4f,@location(0) @interpolate(flat) slot:f32,@location(1) across:f32,@location(2) inner:f32,@location(3) outer:f32,@location(4) @interpolate(flat) order:f32}
const corners=array<vec2f,6>(vec2f(0,-1),vec2f(1,-1),vec2f(0,1),vec2f(0,1),vec2f(1,-1),vec2f(1,1));
const culled=Out(vec4f(2,2,2,1),0.0,0.0,0.0,0.0,0.0);
@vertex fn vertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out {
 let s0=segs[ii*2u];let s1=segs[ii*2u+1u];
 var ca=b.camera*vec4f(s0.xyz,1);var cb=b.camera*vec4f(s1.xyz,1);
 let near=0.05;
 if(ca.w<near&&cb.w<near){return culled;}
 if(ca.w<near){ca=mix(ca,cb,(near-ca.w)/(cb.w-ca.w));}
 if(cb.w<near){cb=mix(cb,ca,(near-cb.w)/(ca.w-cb.w));}
 let vp=b.screen.xy;
 let pa=ca.xy/ca.w*vp*0.5;let pb=cb.xy/cb.w*vp*0.5;
 var dir=pb-pa;let len=length(dir);
 dir=select(vec2f(0,1),dir/len,len>1e-4);
 let side=vec2f(-dir.y,dir.x);
 let order=s0.w;
 let thin=1.0/(1.0+0.6*order);
 let corner=corners[vi];
 let c=select(ca,cb,corner.x>0.5);
 // Half widths in pixels: a point at depth w spans focal * size / w; the core is never under a pixel, the glow never under the core.
 let focal=b.screen.z;
 let inner=max(b.look.x*thin*0.5*focal/c.w,0.75);
 // Near the camera a world-size glow would wash the frame: it stops growing at 5 percent of the frame's height.
 let outer=max(min(b.look.y*thin*0.5*focal/c.w,0.05*vp.y),inner);
 let p=c.xy/c.w*vp*0.5+side*corner.y*outer;
 var out:Out;
 out.position=vec4f(p/(vp*0.5)*c.w,c.z,c.w);
 out.slot=s1.w;out.across=corner.y*outer;out.inner=inner;out.outer=outer;out.order=order;
 return out;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
 let level=b.levels[u32(i.slot)];
 let d=abs(i.across);
 let sigma=max(i.inner*0.5,0.4);
 let core=exp(-d*d/(2.0*sigma*sigma));
 // The glow: the field of the channel, falling off to zero over the glow's width (Reed and Wyvill's implicit-surface glow).
 let edge=max(1.0-d/i.outer,0.0);
 let glow=edge*edge*edge;
 let thin=1.0/(1.0+0.6*i.order);
 let hot=b.core.rgb*b.core.w*level.x*core*thin;
 let halo=b.glow.rgb*b.glow.w*level.y*glow*thin;
 return vec4f(hot+halo,0.0);
}`;

/**
 * Draws lightning bolts: for each live strike of a `Weather`, a branching channel from the cloud base to the strike,
 * grown deterministically from the weather's lightning seed and the strike's number ({@link lightningChannel}), with its
 * glow, a return-stroke flicker (each stroke of the strike lights the channel, so a multi-stroke flash flickers) and a
 * hot core that fades faster than the glow, all timed to the strike's own flash by the weather's film time. It also
 * gives the weather the channel, so the light follows it ({@link WeatherLightningLightOptions.line}) and the deck's
 * flash and the ground light the way the bolt runs. The channel is drawn as screen-facing ribbons, one instance a
 * segment from a storage buffer, over the frame with additive (maximum) blending and a read-only depth test: a bolt
 * behind a hill is hidden by it. The look is `weather.options.lightning.bolt` ({@link LightningBoltOptions}), whose
 * rows are `lightning.bolt.*` of `applySkySettings`.
 * @example
 * const weather = Weather.attach(engine, { intensity: 1, lightning: {} });
 * LightningBolt.attach(engine, { weather });
 * weather.strike({ distance: 800, azimuth: 0 });
 */
export class LightningBolt implements EnginePlugin {
  readonly name = 'lightning-bolt';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private storage?: GPUBuffer;
  private capacity = 0;
  private pipeline?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private key = '';
  private disposed = false;
  private readonly values = new Float32Array(16 + 4 * 5 + 4 * MAX_BOLTS);
  private readonly channels = new Map<number, { shape: string; channel: LightningChannel }>();
  private uploaded = '';
  private uploadedSegments: Float32Array[] = [];

  constructor(readonly options: LightningBoltAttachOptions) {
    if (
      typeof options !== 'object' ||
      options === null ||
      typeof options.weather !== 'object' ||
      options.weather === null
    )
      throw new TypeError('LightningBolt needs a Weather; pass {weather}');
    for (const [k, v] of [
      ['coreRadiance', options.coreRadiance],
      ['glowRadiance', options.glowRadiance],
    ] as const)
      if (v !== undefined && !(v >= 0 && Number.isFinite(v)))
        throw new RangeError(`LightningBolt ${k} must be a finite number of 0 or more`);
    options.weather.channelSource = {
      lights: (strike, count, decay) => channelLightPoints(this.channelOf(strike), count, decay),
    };
  }

  static attach(engine: EngineKernel, options: LightningBoltAttachOptions): LightningBolt {
    const bolt = new LightningBolt(options);
    engineRuntime(engine).use(bolt);
    return bolt;
  }

  /** The channel of `strike` under the bolt's settings now, grown on first use and kept while the settings hold. */
  channelOf(strike: LightningStrike): LightningChannel {
    const supplied = this.options.channel?.(strike);
    if (supplied) return supplied;
    const o = this.options.weather.options.lightning,
      b = o?.bolt ?? {},
      top = b.top ?? o?.cloud?.base ?? DEFAULT_TOP,
      shape = [b.detail, b.spread, b.branching, top, strike.position[0], strike.position[2]].join(),
      hit = this.channels.get(strike.id);
    if (hit && hit.shape === shape) return hit.channel;
    // The channel's top wanders off the strike point by up to a quarter of its height, by the strike's own seed.
    const seed = ((o?.seed ?? 1) * 0x9e3779b1 + strike.id * 0x85ebca6b) | 0,
      g = generator(seed ^ 0x51ed27),
      angle = g() * Math.PI * 2,
      offset = 0.25 * top * Math.sqrt(g()),
      channel = lightningChannel({
        seed,
        start: [strike.position[0] + Math.cos(angle) * offset, top, strike.position[2] + Math.sin(angle) * offset],
        end: [strike.position[0], 0, strike.position[2]],
        detail: b.detail,
        spread: b.spread,
        branching: b.branching,
      });
    this.channels.set(strike.id, { shape, channel });
    if (this.channels.size > 32) this.channels.delete(this.channels.keys().next().value as number);
    return channel;
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'LightningBolt requires WebGPU; attach a new LightningBolt to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'sky:lightning-bolt',
      order: 6.55,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }

  /** The bolts to draw now: each live strike with its core and glow level, or the last strike at the held flash. */
  private live(): { strike: LightningStrike; core: number; glow: number }[] {
    const w = this.options.weather,
      o = w.options.lightning,
      b = o?.bolt ?? {},
      tau = b.fade ?? 0.03,
      out: { strike: LightningStrike; core: number; glow: number }[] = [];
    if (o?.hold !== undefined) {
      if (w.lastStrike && o.hold > 0) out.push({ strike: w.lastStrike, core: o.hold, glow: o.hold });
      return out;
    }
    for (const a of w.liveStrikes) {
      const core = strokeLevel(a.age, a.offsets, a.amplitudes, tau),
        glow = strokeLevel(a.age, a.offsets, a.amplitudes, 0.07);
      if (core > 0.002 || glow > 0.002) out.push({ strike: a.strike, core, glow });
    }
    return out.slice(-MAX_BOLTS);
  }

  private draw(c: Context): void {
    const w = this.options.weather,
      o = w.options.lightning,
      b = o?.bolt ?? {},
      scale = b.scale ?? 1,
      bolts = this.live();
    if (!scale || !bolts.length || !this.uniform) return;
    const channels = bolts.map((x) => this.channelOf(x.strike)),
      total = channels.reduce((n, ch) => n + ch.count, 0);
    if (!total) return;
    const device = c.device,
      need = total * 2 * 16;
    if (!this.storage || this.capacity < need) {
      this.storage?.destroy();
      this.capacity = Math.max(need, 2 * 16 * 512 * MAX_BOLTS);
      this.storage = device.createBuffer({
        size: this.capacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bind = undefined;
      this.uploaded = '';
    }
    // The segments only when the bolts drawn (or their channels) change: one upload for the whole flash.
    const sig = bolts
      .map((x, i) => x.strike.id + ':' + channels[i].count + ':' + (channels[i].segments[0] + channels[i].segments[5]))
      .join('|');
    if (
      sig !== this.uploaded ||
      (this.options.channel && channels.some((channel, index) => channel.segments !== this.uploadedSegments[index]))
    ) {
      const data = new Float32Array(total * CHANNEL_STRIDE);
      let at = 0;
      channels.forEach((ch, slot) => {
        data.set(ch.segments.subarray(0, ch.count * CHANNEL_STRIDE), at);
        for (let i = 0; i < ch.count; i++) data[at + i * CHANNEL_STRIDE + 7] = slot;
        at += ch.count * CHANNEL_STRIDE;
      });
      device.queue.writeBuffer(this.storage, 0, data as Float32Array<ArrayBuffer>);
      this.uploaded = sig;
      this.uploadedSegments = channels.map((channel) => channel.segments);
    }
    const key = c.format + ':' + c.descriptor.multisample?.count + ':' + c.descriptor.depthStencil?.format;
    if (this.key !== key) {
      const module = device.createShaderModule({ code: shader });
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
                alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        multisample: c.descriptor.multisample,
        depthStencil: c.descriptor.depthStencil
          ? { format: c.descriptor.depthStencil.format, depthCompare: 'greater-equal', depthWriteEnabled: false }
          : undefined,
      });
      this.bind = undefined;
      this.key = key;
    }
    if (!this.bind) {
      this.bind = device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: { buffer: this.storage } },
        ],
      });
    }
    const v = this.values,
      color = o?.light?.color ?? LIGHTNING_COLOR,
      top = Math.max(color[0], color[1], color[2]),
      glowColor = [color[0] / top, color[1] / top, color[2] / top],
      coreColor = glowColor.map((x) => 0.4 + 0.6 * x),
      [width, height] = viewSize(c) as [number, number];
    v.set(c.camera.matrix, 0);
    v.set(c.camera.position, 16);
    v[19] = 1;
    v[20] = width;
    v[21] = height;
    v[22] = height / (2 * Math.tan((c.camera.fov * Math.PI) / 360));
    v[24] = b.width ?? 1.5;
    v[25] = b.glow ?? 80;
    v[26] = 1;
    for (let i = 0; i < 3; i++) {
      v[28 + i] = coreColor[i];
      v[32 + i] = glowColor[i];
    }
    v[31] = (this.options.coreRadiance ?? 80) * scale;
    v[35] = (this.options.glowRadiance ?? 6) * scale;
    v.fill(0, 36);
    bolts.forEach((x, i) => {
      v[36 + 4 * i] = x.core;
      v[37 + 4 * i] = x.glow;
    });
    c.device.queue.writeBuffer(this.uniform, 0, v as Float32Array<ArrayBuffer>);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: c.descriptor.depthStencil
        ? { view: c.depth, depthReadOnly: true, stencilReadOnly: true }
        : undefined,
    });
    applyView(pass, c);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bind);
    pass.draw(6, total);
    pass.end();
  }

  private release(): void {
    this.uniform?.destroy();
    this.storage?.destroy();
    this.uniform = this.storage = this.pipeline = this.bind = undefined;
    this.key = '';
    this.capacity = 0;
    this.uploaded = '';
    this.uploadedSegments = [];
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.weather.channelSource = undefined;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
    this.channels.clear();
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
