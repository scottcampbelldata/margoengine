/// <reference lib="esnext.disposable" preserve="true" />
// Steep-bed river flow for Water's terrain-coupled shallow water. The virtual-pipe update (O'Brien & Hodgins 1995;
// Mei, Decaudin & Hu 2007) is driven by hydrostatically reconstructed interface depths (Audusse, Bouchut, Bristeau,
// Klein & Perthame 2004): each pipe sees the bed max(b_i, b_j), so a drop of any height drives only the water above
// the brink, a lake at rest on a stepped bed stays at rest, and depths stay non-negative. Pipe velocity is capped by a
// Froude limit and the Courant-Friedrichs-Lewy bound (Courant, Friedrichs & Lewy 1928) of half a cell per substep.
import type { Water } from './index.js';
import { integrateShader, waterFrame } from './coastal.js';
import { queryStates, riverKernels, type RiverKernels } from './query-state.js';
import { fault, rangeError } from '../../shared/errors.js';

/** A square inflow footprint: `discharge` cubic metres per second spread over the cells whose centres lie within
 * `radius` metres (per axis) of `position`. */
export interface RiverSource {
  /** World [x, z] in metres, finite. */
  position: readonly [number, number];
  /** Volume rate, 0..100000 m^3/s. */
  discharge: number;
  /** Half side of the footprint, 0..10000 m. Default 0: the one cell under `position`. */
  radius?: number;
}
/** Settings read at attach and by setSources. */
export interface RiversOptions {
  /** Up to 16 inflows. Default none. */
  sources?: readonly RiverSource[];
  /** Solver substeps per frame, integer 1..64. Default 8 (Water's own coast uses 3). */
  substeps?: number;
  /** Highest pipe Froude number, 0.1..20. Default 4: supercritical chutes and falls, bounded. */
  maxFroude?: number;
}
const MAX_SOURCES = 16;

const flowShader = (ratio: number, froude: number) =>
  waterFrame +
  `
@group(0) @binding(1) var state:texture_2d<f32>;
@group(0) @binding(2) var previous:texture_2d<f32>;
@group(0) @binding(3) var next:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=vec2i(textureDimensions(state));let p=vec2i(id.xy);if(any(p>=size)){return;}
 let v=textureLoad(state,p,0);let surface=v.x+v.y;let dt=frame.flow.x*${ratio};
 let offsets=array<vec2i,4>(vec2i(-1,0),vec2i(1,0),vec2i(0,-1),vec2i(0,1));
 let lengths=vec4f(frame.flow.y,frame.flow.y,frame.flow.z,frame.flow.z);
 let old=textureLoad(previous,p,0)*exp(-dt*0.12);var q=vec4f(0);
 for(var k=0;k<4;k++){
  let n=p+offsets[k];if(any(n<vec2i(0))||any(n>=size)){continue;}
  let w=textureLoad(state,n,0);let brink=max(v.y,w.y);
  let a=max(0.0,surface-brink);let b=max(0.0,w.x+w.y-brink);let l=lengths[k];
  q[k]=clamp(old[k]+dt*9.81*a*(a-b)/l,0.0,a*min(${froude}*sqrt(9.81*a),0.5*l/dt));
 }
 // Limit the complete outflow together so a cell cannot spend more water than it owns.
 let outgoing=(q.x+q.y)/frame.flow.y+(q.z+q.w)/frame.flow.z;
 q*=min(1.0,v.x/max(0.000001,dt*outgoing));textureStore(next,p,q);
}`;
const inflow = `
@group(0) @binding(5) var<uniform> sources:array<vec4f,${MAX_SOURCES + 1}>;
fn inflow(p:vec2i,size:vec2i)->f32 {
 let cell=frame.coast.zw/vec2f(size);var rate=0.0;
 for(var i=0u;i<u32(sources[0].x);i++){let s=sources[i+1u];
  let lo=max(ceil((s.xy-s.w-frame.coast.xy)/cell-0.5),vec2f(0));let hi=min(floor((s.xy+s.w-frame.coast.xy)/cell-0.5),vec2f(size-1));
  let at=vec2f(p);if(all(at>=lo)&&all(at<=hi)){rate+=s.z/((hi.x-lo.x+1.0)*(hi.y-lo.y+1.0)*cell.x*cell.y);}
 }return rate;
}`;

/** Steep-bed river solver for one Water with a terrain `coast`: inflows, waterfalls and chutes that stay stable. */
export class Rivers {
  private readonly kernels: RiverKernels;
  private disposed = false;
  constructor(
    readonly water: Water,
    options: RiversOptions = {},
  ) {
    if (!queryStates.has(water) || typeof (water as { setWaveHeight?: unknown }).setWaveHeight !== 'function')
      throw fault('state', 'Rivers needs a Water; pass the Water whose coast terrain the river runs on');
    if (!options || typeof options !== 'object') throw fault('state', 'Rivers options must be an object');
    const substeps = options.substeps ?? 8,
      froude = options.maxFroude ?? 4;
    if (!Number.isInteger(substeps) || substeps < 1 || substeps > 64)
      throw rangeError(
        'Rivers substeps must be an integer in 1..64; raise it for finer cells or faster falls',
        'geometry',
      );
    if (!Number.isFinite(froude) || froude < 0.1 || froude > 20)
      throw rangeError('Rivers maxFroude must be finite in 0.1..20', 'geometry');
    if (riverKernels.has(water))
      throw fault('attached', 'This Water already has Rivers; dispose it or call setSources on it', 'state');
    this.kernels = {
      flow: flowShader(3 / substeps, froude),
      integrate: integrateShader(`frame.flow.x*${3 / substeps}`, inflow),
      substeps,
      sources: new Float32Array((MAX_SOURCES + 1) * 4),
    };
    this.setSources(options.sources ?? []);
    riverKernels.set(water, this.kernels);
  }
  /** Attach to a Water; its coastal flow restarts with the river solver on the next frame. */
  static attach(water: Water, options: RiversOptions = {}): Rivers {
    return new Rivers(water, options);
  }
  /** Replace the inflows; read on the next substep, without restarting the flow. */
  setSources(sources: readonly RiverSource[]): void {
    if (this.disposed) throw fault('disposed', 'Rivers is disposed; create another Rivers');
    if (!Array.isArray(sources) || sources.length > MAX_SOURCES)
      throw rangeError(`Rivers takes at most ${MAX_SOURCES} sources in an array`, 'geometry');
    const data = new Float32Array(this.kernels.sources.length);
    sources.forEach((s, i) => {
      const r = s?.radius ?? 0;
      if (
        !s ||
        !Array.isArray(s.position) ||
        s.position.length !== 2 ||
        !s.position.every(Number.isFinite) ||
        !Number.isFinite(s.discharge) ||
        s.discharge < 0 ||
        s.discharge > 100000 ||
        !Number.isFinite(r) ||
        r < 0 ||
        r > 10000
      )
        throw rangeError(
          'Rivers source needs a finite [x, z] position, discharge 0..100000 m^3/s and radius 0..10000 m',
          'geometry',
        );
      data.set([s.position[0], s.position[1], s.discharge, r], (i + 1) * 4);
    });
    data[0] = sources.length;
    this.kernels.sources.set(data);
  }
  /** Water's coastal flow returns to its own solver on the next frame. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (riverKernels.get(this.water) === this.kernels) riverKernels.delete(this.water);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
