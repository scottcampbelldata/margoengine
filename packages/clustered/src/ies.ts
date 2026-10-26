/// <reference lib="esnext.disposable" preserve="true" />
// IES photometric profiles (ANSI/IES LM-63, the standard file format for luminaire photometry) for clustered point and spot
// lights. parseIES reads an LM-63 file (1986, 1991, 1995, 2002 and 2019 revisions; type C photometry); IESLights gives
// lights a profile by their position in the clustered list. The profile is resampled on the CPU onto a fixed grid (1 degree
// of vertical angle by 5 degrees of horizontal angle, or one column when it is rotationally symmetric), normalised to its
// peak and packed as unorm16 pairs into one storage buffer with a small per-light table; the shader filters it bilinearly
// by hand (no texture binding: the 16-texture budget stays untouched) and multiplies it into the light's cone term.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Clustered, ClusteredLightTerm } from './index.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** A parsed IES LM-63 photometric file: candela by vertical and horizontal angle (type C photometry). */
export interface IESProfile {
  /** The file's revision line (`IESNA:LM-63-2002`, `IESNA91`...), or `'LM-63-1986'` when it has none. */
  readonly format: string;
  /** Keyword lines (`[MANUFAC]`, `[LUMCAT]`...) by keyword, `[MORE]` lines joined to the one before with a newline. */
  readonly keywords: Readonly<Record<string, string>>;
  /** Vertical angles in degrees, ascending, 0 (nadir: straight down the light's axis) to 180. */
  readonly vertical: readonly number[];
  /** Horizontal angles in degrees, ascending (one angle: rotationally symmetric; last 90 or 180: mirrored). */
  readonly horizontal: readonly number[];
  /** Candela per horizontal angle, then per vertical angle, multipliers (candela, ballast, ballast-lamp) applied. */
  readonly candela: readonly (readonly number[])[];
  /** The largest candela value: the luminous intensity of the light's brightest direction. */
  readonly peak: number;
  /** Total luminous flux in lumens: the candela distribution integrated over the sphere. */
  readonly flux: number;
  /** Rated lamp lumens times the number of lamps, or -1 for absolute photometry (the file's own field). */
  readonly lampLumens: number;
}
/** One light's profile in {@link IESLights.setProfiles}, with a turn about the light's axis. */
export interface IESLightProfile {
  profile: IESProfile;
  /** Radians the profile is turned about the light's axis, counterclockwise looking along the axis from behind (default 0). */
  rotation?: number;
}
/** Options of {@link IESLights}. */
export interface IESLightOptions {
  /** The clustered lighting whose point and spot lights the profiles shape. */
  lights: Clustered;
}
/** Distinct profiles per {@link IESLights.setProfiles} call. */
export const MAX_IES_PROFILES = 16;
/** Grid rows: vertical angles 0 to 180 degrees in 1-degree steps. */
const ROWS = 181,
  /** Grid columns of a profile that varies with horizontal angle: 0 to 355 degrees in 5-degree steps. */
  COLUMNS = 72,
  MAX_LIGHTS = 1024,
  HEADER_WORDS = 4 + MAX_IES_PROFILES * 4,
  BINDING = 142;

const fail = (message: string): never => {
  throw new RangeError(`Invalid IES file: ${message}; pass the text of a valid IES LM-63 photometric file`);
};
/**
 * Parses an IES LM-63 photometric file (text). Type C photometry only (luminaires: vertical angle 0 is nadir); types A
 * and B (floodlights, automotive) throw a TypeError. Lamp tilt data (`TILT=INCLUDE`) is read past and not applied.
 */
export function parseIES(text: string): IESProfile {
  if (typeof text !== 'string')
    throw new TypeError(
      'parseIES takes the text of an .ies file; read the file as a string (await response.text()) and pass that',
    );
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let line = 0,
    format = 'LM-63-1986';
  if (/^\s*IESNA/i.test(lines[0] ?? '')) format = lines[line++].trim();
  const keywords: Record<string, string> = {};
  let last = '';
  for (; line < lines.length && !/^\s*TILT\s*=/i.test(lines[line]); line++) {
    const match = /^\s*\[([^\]]+)\]\s*(.*)$/.exec(lines[line]);
    if (!match) continue;
    const key = match[1].trim().toUpperCase();
    if (key === 'MORE' && last) keywords[last] += '\n' + match[2].trim();
    else {
      last = key;
      keywords[key] = keywords[key] === undefined ? match[2].trim() : `${keywords[key]}\n${match[2].trim()}`;
    }
  }
  if (line >= lines.length) fail('no TILT= line');
  const tilt = lines[line++].replace(/^\s*TILT\s*=\s*/i, '').trim();
  const numbers = lines
    .slice(line)
    .join(' ')
    .split(/[\s,]+/)
    .filter((token) => token !== '')
    .map(Number);
  let at = 0;
  const next = (what: string): number => {
    if (at >= numbers.length) fail(`ends before ${what}`);
    const value = numbers[at++];
    if (!Number.isFinite(value)) fail(`${what} is not a number`);
    return value;
  };
  if (tilt.toUpperCase() === 'INCLUDE') {
    next('the lamp-to-luminaire geometry');
    const count = next('the number of tilt angles');
    if (!Number.isInteger(count) || count < 0) fail('bad number of tilt angles');
    at += 2 * count;
  }
  const lamps = next('the number of lamps'),
    lumensPerLamp = next('the lumens per lamp'),
    multiplier = next('the candela multiplier'),
    rows = next('the number of vertical angles'),
    columns = next('the number of horizontal angles'),
    type = next('the photometric type');
  next('the units type');
  next('the width');
  next('the length');
  next('the height');
  const ballast = next('the ballast factor'),
    ballastLamp = next('the ballast-lamp photometric factor');
  next('the input watts');
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(columns) || columns < 1)
    fail('the number of vertical and horizontal angles must be positive integers');
  if (type !== 1)
    throw new TypeError(
      `IES photometric type ${type === 2 ? 'B' : type === 3 ? 'A' : type} is not supported; give a type C (1) file`,
    );
  const vertical = Array.from({ length: rows }, () => next('a vertical angle')),
    horizontal = Array.from({ length: columns }, () => next('a horizontal angle'));
  // Unset factors (0 in some writers' "future use" field) count as 1.
  const scale = multiplier * (ballast > 0 ? ballast : 1) * (ballastLamp > 0 ? ballastLamp : 1);
  const candela = horizontal.map(() => vertical.map(() => next('a candela value') * scale));
  const ascending = (list: number[]) => list.every((v, i) => i === 0 || v > list[i - 1]);
  if (!ascending(vertical) || vertical[0] < 0 || vertical[rows - 1] > 180)
    fail('vertical angles must ascend within 0 to 180 degrees');
  if (!ascending(horizontal) || horizontal[0] < 0 || horizontal[columns - 1] > 360)
    fail('horizontal angles must ascend within 0 to 360 degrees');
  if (!(scale >= 0) || candela.some((row) => row.some((v) => v < 0))) fail('candela values must be 0 or more');
  const peak = Math.max(...candela.map((row) => Math.max(...row)));
  const profile = {
    format,
    keywords: Object.freeze(keywords),
    vertical: Object.freeze(vertical),
    horizontal: Object.freeze(horizontal),
    candela: Object.freeze(candela.map((row) => Object.freeze(row))),
    peak,
    flux: 0,
    lampLumens: lumensPerLamp < 0 ? -1 : lamps * lumensPerLamp,
  };
  profile.flux = integrate(profile);
  return Object.freeze(profile);
}

/** `value` at `x` in the ascending `angles`, linear between them; `outside` past either end. */
function interpolate(angles: readonly number[], values: readonly number[], x: number, outside: number): number {
  const n = angles.length;
  if (n === 1) return x === angles[0] ? values[0] : outside;
  if (x < angles[0] || x > angles[n - 1]) return outside;
  let i = 1;
  while (i < n - 1 && angles[i] < x) i++;
  const t = (x - angles[i - 1]) / (angles[i] - angles[i - 1]);
  return values[i - 1] + (values[i] - values[i - 1]) * t;
}
/** The horizontal angle (degrees, 0 to 360) folded into the file's measured range by its symmetry (LM-63 type C). */
function fold(h: readonly number[], phi: number): number {
  const first = h[0],
    last = h[h.length - 1];
  if (h.length === 1) return first;
  if (first === 0 && last === 90) {
    const p = phi > 180 ? 360 - phi : phi;
    return p > 90 ? 180 - p : p;
  }
  if (first === 0 && last === 180) return phi > 180 ? 360 - phi : phi;
  if (first === 90 && last === 270) return phi < 90 ? 180 - phi : phi > 270 ? 540 - phi : phi;
  return phi;
}
/** Candela of `profile` at vertical angle `theta` and horizontal angle `phi` (degrees); 0 outside its vertical range. */
export function iesCandela(profile: IESProfile, theta: number, phi: number): number {
  const v = profile.vertical,
    h = profile.horizontal,
    p = fold(h, ((phi % 360) + 360) % 360);
  const column = (k: number) => interpolate(v, profile.candela[k], theta, 0);
  if (h.length === 1) return column(0);
  // A full-circle file without a 360-degree column wraps from its last angle to its first.
  if (p > h[h.length - 1] || p < h[0]) {
    const a = h[h.length - 1],
      b = h[0] + 360,
      x = p < h[0] ? p + 360 : p,
      t = (x - a) / (b - a);
    return column(h.length - 1) * (1 - t) + column(0) * t;
  }
  let i = 1;
  while (i < h.length - 1 && h[i] < p) i++;
  const t = (p - h[i - 1]) / (h[i] - h[i - 1]);
  return column(i - 1) * (1 - t) + column(i) * t;
}
const symmetric = (profile: IESProfile) => profile.horizontal.length === 1;
/** The profile on the shader's grid (ROWS x columns), normalised to its peak. */
function grid(profile: IESProfile): Float64Array {
  const columns = symmetric(profile) ? 1 : COLUMNS,
    out = new Float64Array(ROWS * columns),
    peak = profile.peak || 1;
  for (let c = 0; c < columns; c++)
    for (let r = 0; r < ROWS; r++) out[c * ROWS + r] = iesCandela(profile, r, (c * 360) / columns) / peak;
  return out;
}
/** Luminous flux (lm): candela integrated over the sphere (midpoint rule, 0.5-degree by 5-degree steps). */
function integrate(profile: IESProfile): number {
  const columns = symmetric(profile) ? 1 : COLUMNS,
    steps = 360,
    dTheta = Math.PI / steps;
  let flux = 0;
  for (let c = 0; c < columns; c++)
    for (let r = 0; r < steps; r++) {
      const theta = (r + 0.5) * dTheta;
      flux += iesCandela(profile, (theta * 180) / Math.PI, (c * 360) / columns) * Math.sin(theta) * dTheta;
    }
  return (flux * 2 * Math.PI) / columns;
}

// One storage buffer: a header (light entries, profiles), each profile's word offset and column count, then per light its
// profile (index + 1, 0 for none) and rotation, then the grids as unorm16 pairs. The light's axis is the spot's direction
// (a point light's is straight down); horizontal angle 0 is world +x made perpendicular to the axis (+z when the axis is
// within 26 degrees of x), angles turning counterclockwise seen from behind the light, so a downlight's run counterclockwise
// seen from above, as LM-63's type C.
const sampling = (group: number) => /* wgsl */ `
struct ClusterIesData {header:vec4u,profiles:array<vec4u,${MAX_IES_PROFILES}>,words:array<u32>}
@group(${group}) @binding(${BINDING}) var<storage,read> clusterIesData:ClusterIesData;
fn clusterIesValue(o:u32,k:u32)->f32 {let p=unpack2x16unorm(clusterIesData.words[o+k/2u]);return select(p.x,p.y,(k&1u)==1u);}
fn clusterIes(index:u32,light:ClusterLight,l:vec3f)->f32 {
  if(index>=clusterIesData.header.x){return 1.0;}let id=clusterIesData.words[index*2u];if(id==0u){return 1.0;}
  let profile=clusterIesData.profiles[id-1u];let o=profile.x;let columns=profile.y;
  let axis=select(vec3f(0,-1,0),light.directionOuter.xyz,light.params.y>0.5);let d=-l;
  let t=acos(clamp(dot(d,axis),-1.0,1.0))*${((ROWS - 1) / Math.PI).toFixed(8)};let r0=min(u32(t),${ROWS - 2}u);let fr=t-f32(r0);
  var c0=0u;var c1=0u;var fc=0.0;
  if(columns>1u){
    let side=select(vec3f(1,0,0),vec3f(0,0,1),abs(axis.x)>0.9);let x=normalize(side-axis*dot(side,axis));let y=cross(x,axis);
    let turn=atan2(dot(d,y),dot(d,x))-bitcast<f32>(clusterIesData.words[index*2u+1u]);
    let s=(turn-6.2831853*floor(turn/6.2831853))*f32(columns)/6.2831853;c0=min(u32(s),columns-1u);c1=(c0+1u)%columns;fc=s-f32(c0);
  }
  let a=mix(clusterIesValue(o,c0*${ROWS}u+r0),clusterIesValue(o,c0*${ROWS}u+r0+1u),fr);
  let b=mix(clusterIesValue(o,c1*${ROWS}u+r0),clusterIesValue(o,c1*${ROWS}u+r0+1u),fr);
  return mix(a,b,fc);
}
`;
/**
 * IES photometric profiles for clustered point and spot lights: each light
 * at index i of `Clustered.setLights` takes entry i of {@link setProfiles}. The profile, normalised to its peak, multiplies
 * the light's cone term, so `intensity` is the luminous intensity of the brightest direction (`profile.peak` for the file's
 * own candela; `@margoengine/clustered/units` converts lumens). Its vertical angle 0 points along a spot's `direction`, or
 * straight down for a point light. Without profiles it adds nothing to the shaders or the GPU work.
 */
export class IESLights implements EnginePlugin, ClusteredLightTerm {
  readonly name = 'clustered:ies';
  /** @internal ClusteredLightTerm: the factor in the light loop. */
  readonly term = 'clusterIes(index,light,l)';
  readonly lights: Clustered;
  private engine?: Engine;
  private device?: GPUDevice;
  private buffer?: GPUBuffer;
  private entries: GPUBindGroupEntry[] = [];
  private words = new Uint32Array(HEADER_WORDS);
  private listValue: readonly (IESProfile | IESLightProfile | null | undefined)[] = Object.freeze([]);
  private active = false;
  private dirty = true;
  private disposed = false;
  constructor(options: IESLightOptions) {
    if (!options?.lights || typeof options.lights.setLights !== 'function')
      throw new TypeError('IESLights needs the Clustered lights: new IESLights({ lights })');
    this.lights = options.lights;
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: IESLightOptions): IESLights {
    const effect = new IESLights(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** The entries last given to `setProfiles` (a frozen copy of the list). */
  get list(): readonly (IESProfile | IESLightProfile | null | undefined)[] {
    return this.listValue;
  }
  /**
   * Entry i shapes the light at index i of `Clustered.setLights` (a profile, a profile with a rotation, or null for none);
   * lights past the end have none. At most {@link MAX_IES_PROFILES} distinct profiles; validates everything before
   * changing anything. No profiles removes the shader code.
   */
  setProfiles(entries: readonly (IESProfile | IESLightProfile | null | undefined)[]): this {
    if (this.disposed) throw new MargoError('disposed', 'IESLights is disposed; create new IESLights');
    if (!Array.isArray(entries) || entries.length > MAX_LIGHTS)
      throw new RangeError(`Expected an array of at most ${MAX_LIGHTS} IES entries, one per clustered light`);
    const profiles: IESProfile[] = [],
      perLight = entries.map((entry) => {
        if (entry === null || entry === undefined) return [0, 0];
        if (typeof entry !== 'object')
          throw new TypeError('An IES entry must be a parseIES profile, { profile, rotation? } or null');
        const profile = 'profile' in entry ? entry.profile : entry,
          rotation = 'profile' in entry ? (entry.rotation ?? 0) : 0;
        if (!profile || !Array.isArray(profile.vertical) || !Array.isArray(profile.candela) || !(profile.peak >= 0))
          throw new TypeError('An IES entry must be a parseIES profile, { profile, rotation? } or null');
        if (!Number.isFinite(Math.fround(rotation)))
          throw new RangeError('IES rotation must be a finite number of radians');
        let id = profiles.indexOf(profile);
        if (id < 0) id = profiles.push(profile) - 1;
        return [id + 1, rotation];
      });
    if (profiles.length > MAX_IES_PROFILES)
      throw new RangeError(`Expected at most ${MAX_IES_PROFILES} distinct IES profiles, got ${profiles.length}`);
    const grids = profiles.map(grid),
      lightWords = perLight.length * 2;
    let offset = lightWords;
    const offsets = grids.map((g) => {
      const at = offset;
      offset += Math.ceil(g.length / 2);
      return at;
    });
    const words = new Uint32Array(HEADER_WORDS + offset),
      floats = new Float32Array(words.buffer);
    words[0] = perLight.length;
    words[1] = profiles.length;
    profiles.forEach((profile, i) => {
      words[4 + i * 4] = offsets[i];
      words[5 + i * 4] = symmetric(profile) ? 1 : COLUMNS;
    });
    perLight.forEach(([id, rotation], i) => {
      words[HEADER_WORDS + i * 2] = id;
      floats[HEADER_WORDS + i * 2 + 1] = rotation;
    });
    grids.forEach((g, i) => {
      const base = HEADER_WORDS + offsets[i];
      for (let k = 0; k < g.length; k++)
        words[base + (k >> 1)] |= Math.round(Math.min(1, Math.max(0, g[k])) * 65535) << ((k & 1) * 16);
    });
    this.words = words;
    this.active = profiles.length > 0;
    this.listValue = Object.freeze([...entries]);
    this.dirty = true;
    this.sync();
    return this;
  }
  /** @internal ClusteredLightTerm: WGSL defining `clusterIes`. */
  declarations(group: number): string {
    return sampling(group);
  }
  /** @internal ClusteredLightTerm: binding 142 of the lit shader's group. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.buffer || this.disposed)
      throw new MargoError('state', 'IES lights are not attached; engine.use(ies) and set some profiles first');
    return this.entries;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'IESLights is disposed; create new IESLights');
    if (!engine.gpu) throw new MargoError('unsupported', 'IESLights requires the WebGPU backend');
    this.engine = engine;
    this.device = engine.gpu;
    this.dirty = true;
    this.sync();
  }
  // The buffer and the hook exist only while some light has a profile, so an empty IESLights changes no GPU call. The
  // buffer grows (to a power of two) when the profiles need more room, and is kept when they need less.
  private sync(): void {
    const active = !!this.device && !this.disposed && this.active;
    if (active && (!this.buffer || this.buffer.size < this.words.byteLength)) {
      this.buffer?.destroy();
      const buffer = (this.buffer = this.device!.createBuffer({
        size: Math.max(1024, 2 ** Math.ceil(Math.log2(this.words.byteLength))),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }));
      this.entries = [{ binding: BINDING, resource: { buffer } }];
      this.dirty = true;
    }
    const hook = active ? this : undefined;
    if (this.lights.ies !== hook) this.lights.ies = hook;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -3.5,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.buffer || !this.dirty || !this.active) return;
        c.device.queue.writeBuffer(this.buffer, 0, this.words as Uint32Array<ArrayBuffer>);
        this.dirty = false;
      },
    });
  }
  private release(): void {
    if (this.lights.ies === this) this.lights.ies = undefined;
    this.buffer?.destroy();
    this.buffer = undefined;
    this.entries = [];
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
