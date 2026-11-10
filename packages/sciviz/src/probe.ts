// Clean-room finite-element interpolation and exact simplex measures; sources in docs/clean-room.md.
import { fault, rangeError } from '../../shared/errors.js';
import type { AnalysisGrid, AnalysisImage } from './clip.js';
import type { Bounds } from './layer.js';
import type { Figure, LineLayer, ScatterLayer } from './figure.js';
import type { PipelineOperator } from './pipeline.js';
import { checkComplex, simplices, cross3, dot3, sub3 } from './cell-complex.js';

/** A grid or a regular/curvilinear image. */
export type ProbeInput = AnalysisGrid | AnalysisImage;
/** Cooperative cancellation, preserving the exact reason. */
export interface ProbeOptions { readonly signal?: AbortSignal }
/** One interpolated tuple per source point array and one copied tuple per source cell array. */
export interface ProbeSample {
  readonly cell: number;
  readonly sourceCell: number;
  readonly pointData?: number;
  readonly cellData?: number;
  readonly pointArrays: Readonly<Record<string, Float64Array>>;
  readonly cellArrays: Readonly<Record<string, Float64Array>>;
}
/** Profile samples at equal arc-length positions along the entire polyline. Missing samples are NaN and masked. */
export interface LineProbe {
  readonly positions: Float64Array;
  readonly distance: Float64Array;
  readonly valid: Uint8Array;
  readonly cells: Int32Array;
  readonly pointData?: Float64Array;
  readonly cellData?: Float64Array;
  readonly pointArrays: Readonly<Record<string, Float64Array>>;
  readonly cellArrays: Readonly<Record<string, Float64Array>>;
}
/** Cell measures and field integrals stay separate by physical dimension. */
export interface IntegralFields {
  readonly measure: number;
  readonly pointData?: number;
  readonly cellData?: number;
  readonly pointArrays: Readonly<Record<string, Float64Array>>;
  readonly cellArrays: Readonly<Record<string, Float64Array>>;
}
/** Mixed-dimensional inputs never add values with incompatible units. */
export interface GridIntegrals { readonly length: IntegralFields; readonly area: IntegralFields; readonly volume: IntegralFields }
/** Geometry and target cell arrays retained; point arrays are sampled from the source. */
export interface ResampledDataset {
  readonly grid: ProbeInput;
  readonly valid: Uint8Array;
  readonly cells: Int32Array;
  /** Source cell fields sampled at target points, kept separate to avoid name collisions with point fields. */
  readonly sampledCellArrays: Readonly<Record<string, Float64Array>>;
  readonly sampledCellData?: Float64Array;
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const point = (grid: AnalysisGrid, id: number) => [grid.points[3 * id], grid.points[3 * id + 1], grid.points[3 * id + 2]];
const isImage = (grid: ProbeInput): grid is AnalysisImage => 'dims' in grid;
const countPoints = (grid: ProbeInput) => isImage(grid) ? grid.dims.reduce((a, b) => a * b, 1) : grid.points.length / 3;
const countCells = (grid: ProbeInput) => isImage(grid) ? grid.dims.reduce((a, b) => a * Math.max(1, b - 1), 1) : grid.types.length;
const rows = (grid: ProbeInput, point: boolean): Record<string, ArrayLike<number>> => ({ ...(point ? grid.pointArrays : grid.cellArrays),
  ...((point ? grid.pointData : grid.cellData) ? { '': (point ? grid.pointData : grid.cellData)! } : {}) });
const solve = (a: number[], b: number[], c: number[], p: number[]): number[] | null => {
  const bc = cross3(b, c), det = dot3(a, bc);
  return det !== 0 && Number.isFinite(det) ? [dot3(p, bc), dot3(p, cross3(c, a)), dot3(p, cross3(a, b))].map(x => x / det) : null;
};
const hexCorners = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
function hexShape(uvw: number[]) {
  const weights = hexCorners.map(c => c.reduce((v, x, a) => v * (x ? uvw[a] : 1 - uvw[a]), 1));
  const derivatives = hexCorners.map(c => [0,1,2].map(a => c.reduce((v, x, k) => v * (a === k ? (x ? 1 : -1) : x ? uvw[k] : 1 - uvw[k]), 1)));
  return { weights, derivatives };
}
function simplexWeights(p: number[][], at: number[], tolerance: number): number[] | null {
  const q = sub3(at, p[0]);
  if (p.length === 1) return Math.hypot(...q) <= tolerance ? [1] : null;
  const a = sub3(p[1], p[0]);
  if (p.length === 2) {
    const n = dot3(a, a), t = dot3(a, q) / n;
    return n > 0 && t >= 0 && t <= 1 && Math.hypot(...q.map((x, k) => x - t * a[k])) <= tolerance ? [1 - t, t] : null;
  }
  const b = sub3(p[2], p[0]);
  let uvw: number[] | null;
  if (p.length === 3) {
    const n = cross3(a, b), nn = dot3(n, n);
    if (!(nn > 0) || Math.abs(dot3(q, n)) > tolerance * Math.sqrt(nn)) return null;
    uvw = [dot3(cross3(q, b), n) / nn, dot3(cross3(a, q), n) / nn];
  } else uvw = solve(a, b, sub3(p[3], p[0]), q);
  if (!uvw) return null;
  const w = [1 - uvw.reduce((s, x) => s + x, 0), ...uvw];
  return w.every(x => x >= -64 * Number.EPSILON && x <= 1 + 64 * Number.EPSILON) ? w : null;
}

function validate(grid: ProbeInput) {
  if (isImage(grid)) {
    if (grid.dims.length !== 3 || !grid.dims.every(x => Number.isSafeInteger(x) && x >= 1) ||
      grid.bounds?.length !== 6 || !grid.bounds.every(Number.isFinite) || !Number.isSafeInteger(countPoints(grid)))
      throw rangeError('Probe image needs three positive dimensions and six finite bounds', 'sciviz');
    if (grid.points && grid.points.length !== countPoints(grid) * 3) throw rangeError('Curvilinear points must match image dimensions', 'sciviz');
    for (let a = 0; a < 3; a++) if (!grid.points && (grid.dims[a] === 1) !== (grid.bounds[2*a] === grid.bounds[2*a+1]))
      throw rangeError('Probe image active bounds must differ and singleton bounds must agree', 'sciviz');
  } else checkComplex(grid, true);
  if(countPoints(grid)>8_000_000)throw rangeError('Probe inputs support at most 8000000 points per snapshot','sciviz');
  if (Object.hasOwn(grid.pointArrays ?? {}, '') || Object.hasOwn(grid.cellArrays ?? {}, '')) throw rangeError('Probe named arrays must use nonempty names', 'sciviz');
  for (const association of [true, false]) {
    const n = association ? countPoints(grid) : countCells(grid);
    for (const array of Object.values(rows(grid, association))) if (n ? !Number.isInteger(array.length / n) || array.length < n : array.length !== 0)
      throw rangeError('Probe arrays must hold complete tuples matching their associated count', 'sciviz');
  }
  if ((grid.pointData && grid.pointData.length !== countPoints(grid)) || (grid.cellData && grid.cellData.length !== countCells(grid)))
    throw rangeError('Default probe pointData/cellData must be scalar', 'sciviz');
  if (grid.points && Array.from(grid.points).some(x => !Number.isFinite(x))) throw rangeError('Probe points must be finite', 'sciviz');
}
function imagePoint(grid: AnalysisImage, i: number): number[] {
  if (grid.points) return [grid.points[3*i], grid.points[3*i+1], grid.points[3*i+2]];
  const d = grid.dims, k = [i % d[0], Math.floor(i / d[0]) % d[1], Math.floor(i / (d[0]*d[1]))];
  return k.map((x, a) => grid.bounds[2*a] + (d[a] === 1 ? 0 : x / (d[a]-1) * (grid.bounds[2*a+1]-grid.bounds[2*a])));
}
function materialize(grid: AnalysisImage): AnalysisGrid {
  const points = Float64Array.from({ length: countPoints(grid)*3 }, (_, i) => imagePoint(grid, Math.floor(i/3))[i%3]), d = grid.dims,
    stride = [1,d[0],d[0]*d[1]], active = [0,1,2].filter(a => d[a]>1), connectivity: number[] = [], offsets: number[] = [], types: number[] = [];
  for (let z=0;z<Math.max(1,d[2]-1);z++) for(let y=0;y<Math.max(1,d[1]-1);y++) for(let x=0;x<Math.max(1,d[0]-1);x++) {
    const i=x+d[0]*(y+d[1]*z), [a,b,c]=active.map(a=>stride[a]);
    const ids=active.length===0?[i]:active.length===1?[i,i+a]:[i,i+a,i+a+b,i+b];
    if(active.length===3)ids.push(i+c,i+a+c,i+a+b+c,i+b+c);
    connectivity.push(...ids); offsets.push(connectivity.length); types.push([1,3,9,12][active.length]);
  }
  return {points,connectivity:new Uint32Array(connectivity),offsets:new Uint32Array(offsets),types:new Uint8Array(types),pointData:grid.pointData,cellData:grid.cellData,pointArrays:grid.pointArrays,cellArrays:grid.cellArrays};
}

/** Owned snapshot and uniform-bucket cell locator. Large spanning cells use a separate candidate list. */
export class CellLocator {
  private dead = false;
  private constructor(private data: ProbeInput, private buckets: Map<number, number[]>, private global: number[], private bounds: number[], private bins: number) {}
  /** Snapshots inputs; regular images retain implicit topology and sample in constant work. */
  static async create(input: ProbeInput, options: ProbeOptions = {}): Promise<CellLocator> {
    options.signal?.throwIfAborted(); validate(input); await pause(); options.signal?.throwIfAborted();
    let data: ProbeInput = { ...input, pointData: input.pointData && Float64Array.from(input.pointData), cellData: input.cellData && Float64Array.from(input.cellData),
      pointArrays: Object.fromEntries(Object.entries(input.pointArrays ?? {}).map(([k,v])=>[k,Float64Array.from(v)])),
      cellArrays: Object.fromEntries(Object.entries(input.cellArrays ?? {}).map(([k,v])=>[k,Float64Array.from(v)])) };
    if (isImage(data)) data = { ...data, dims:[...data.dims],bounds:[...data.bounds],points:data.points && Float64Array.from(data.points) };
    else data={...data,points:Float64Array.from(data.points),connectivity:Uint32Array.from(data.connectivity),offsets:Uint32Array.from(data.offsets),types:Uint8Array.from(data.types),sourceCells:data.sourceCells && Uint32Array.from(data.sourceCells)};
    if (isImage(data) && !data.points) return new CellLocator(data,new Map(),[],[...data.bounds],1);
    if (isImage(data)) data=materialize(data);
    const bounds=[Infinity,-Infinity,Infinity,-Infinity,Infinity,-Infinity];
    for(let i=0;i<data.points.length;i++){const a=i%3;bounds[2*a]=Math.min(bounds[2*a],data.points[i]);bounds[2*a+1]=Math.max(bounds[2*a+1],data.points[i]);}
    const bins=Math.max(1,Math.min(32,Math.ceil(Math.cbrt(data.types.length)))),buckets=new Map<number,number[]>(),global:number[]=[];
    const bucket=(v:number,a:number)=>Math.max(0,Math.min(bins-1,Math.floor((v-bounds[2*a])/(bounds[2*a+1]-bounds[2*a] || 1)*bins)));
    for(let c=0;c<data.types.length;c++){
      if(c%2048===0){await pause();options.signal?.throwIfAborted();}
      const start=c?data.offsets[c-1]:0,ids=Array.from({length:data.offsets[c]-start},(_,k)=>(data as AnalysisGrid).connectivity[start+k]),p=ids.map(id=>point(data as AnalysisGrid,id)),lo=[0,1,2].map(a=>bucket(Math.min(...p.map(v=>v[a])),a)),hi=[0,1,2].map(a=>bucket(Math.max(...p.map(v=>v[a])),a));
      if(hi.reduce((v,x,a)=>v*(x-lo[a]+1),1)>128){global.push(c);continue;}
      for(let z=lo[2];z<=hi[2];z++)for(let y=lo[1];y<=hi[1];y++)for(let x=lo[0];x<=hi[0];x++){const key=x+bins*(y+bins*z);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key)!.push(c);}
    }
    options.signal?.throwIfAborted();return new CellLocator(data,buckets,global,bounds,bins);
  }
  private live(){if(this.dead)throw fault('disposed','Cell locator is disposed; create a new one','sciviz');}
  private interpolate(cell:number,ids:number[],weights:number[]):ProbeSample{
    const make=(association:boolean)=>Object.fromEntries(Object.entries(rows(this.data,association)).map(([name,a])=>{
      const width=a.length/(association?countPoints(this.data):countCells(this.data));
      return [name,Float64Array.from({length:width},(_,k)=>association?ids.reduce((s,id,i)=>s+(weights[i]===0?0:weights[i]*a[id*width+k]),0):a[cell*width+k])];
    }));
    const pa=make(true),ca=make(false),pointData=pa['']?.[0],cellData=ca['']?.[0];delete pa[''];delete ca[''];
    return {cell,sourceCell:!isImage(this.data)?this.data.sourceCells?.[cell]??cell:cell,pointData,cellData,pointArrays:pa,cellArrays:ca};
  }
  /** Returns null outside cells. At a shared boundary the lowest current cell ID wins. */
  probe(position: readonly [number,number,number], options:ProbeOptions={}):ProbeSample|null{
    this.live();options.signal?.throwIfAborted();if(position.length!==3||!position.every(Number.isFinite))throw rangeError('Probe position must be finite xyz','sciviz');
    const at=[...position],g=this.data;
    if(isImage(g)){
      const d=g.dims,logical=at.map((x,a)=>d[a]===1?(x===g.bounds[2*a]?0:NaN):(x-g.bounds[2*a])/(g.bounds[2*a+1]-g.bounds[2*a])*(d[a]-1));
      if(logical.some((x,a)=>!(x>=0&&x<=d[a]-1)))return null;
      const base=logical.map((x,a)=>Math.max(0,Math.min(Math.ceil(x)-1,Math.max(0,d[a]-2)))),t=logical.map((x,a)=>d[a]===1?0:x-base[a]),ids:number[]=[],w:number[]=[];
      for(let z=0;z<Math.min(2,d[2]);z++)for(let y=0;y<Math.min(2,d[1]);y++)for(let x=0;x<Math.min(2,d[0]);x++){
        ids.push(base[0]+x+d[0]*(base[1]+y+d[1]*(base[2]+z)));w.push([x,y,z].reduce((v,k,a)=>v*(d[a]===1?1:k?t[a]:1-t[a]),1));
      }
      const c=d.map(n=>Math.max(1,n-1));return this.interpolate(base[0]+c[0]*(base[1]+c[1]*base[2]),ids,w);
    }
    if(at.some((x,a)=>x<this.bounds[2*a]||x>this.bounds[2*a+1]))return null;
    const b=at.map((x,a)=>Math.min(this.bins-1,Math.floor((x-this.bounds[2*a])/(this.bounds[2*a+1]-this.bounds[2*a]||1)*this.bins))),candidates=[...new Set([...(this.buckets.get(b[0]+this.bins*(b[1]+this.bins*b[2]))??[]),...this.global])].sort((a,b)=>a-b);
    const tolerance=128*Number.EPSILON*Math.max(1,...this.bounds.map(Math.abs));
    for(const cell of candidates){
      const ids=Array.from({length:g.offsets[cell]-(cell?g.offsets[cell-1]:0)},(_,k)=>g.connectivity[(cell?g.offsets[cell-1]:0)+k]),p=ids.map(id=>point(g,id));
      if(g.types[cell]===12){
        let uvw=[0.5,0.5,0.5];
        for(let turn=0;turn<24;turn++){
          const {weights,derivatives}=hexShape(uvw),mapped=[0,1,2].map(a=>p.reduce((s,v,k)=>s+weights[k]*v[a],0)),error=sub3(at,mapped);
          if(Math.hypot(...error)<=tolerance){if(uvw.every(x=>x>=-64*Number.EPSILON&&x<=1+64*Number.EPSILON))return this.interpolate(cell,ids,weights);break;}
          const j=[0,1,2].map(a=>[0,1,2].map(b=>p.reduce((s,v,k)=>s+derivatives[k][a]*v[b],0))),step=solve(j[0],j[1],j[2],error);
          if(!step)break;uvw=uvw.map((x,a)=>x+step[a]);
        }
      }else{
        const one={...g,connectivity:ids,offsets:[ids.length],types:[g.types[cell]]};
        for(const simplex of simplices(one)){const w=simplexWeights(simplex.ids.map(id=>point(g,id)),at,tolerance);if(w)return this.interpolate(cell,simplex.ids,w);}
      }
    }
    return null;
  }
  /** @internal Width metadata used to initialize missing tuples without an arbitrary successful probe. */
  fields(association:boolean):Readonly<Record<string,number>>{this.live();return Object.fromEntries(Object.entries(rows(this.data,association)).map(([k,v])=>[k,v.length/(association?countPoints(this.data):countCells(this.data))||1]));}
  /** Releases the owned snapshot and index; never touches caller arrays or a device. */
  dispose():void{if(this.dead)return;this.dead=true;this.buckets.clear();this.global.length=0;this.data={points:[],connectivity:[],offsets:[],types:[]};}
  /** Same as dispose, for using. */
  [Symbol.dispose]():void{this.dispose();}
}

/** Sample a location using a short-lived locator. Reuse CellLocator for repeated queries. */
export async function probeGrid(input:ProbeInput,position:readonly[number,number,number],options:ProbeOptions={}):Promise<ProbeSample|null>{using locator=await CellLocator.create(input,options);return locator.probe(position,options);}

async function samplePositions(locator:CellLocator,count:number,position:(i:number)=>number[],options:ProbeOptions){
  const valid=new Uint8Array(count),cells=new Int32Array(count).fill(-1),data=(association:boolean)=>Object.fromEntries(Object.entries(locator.fields(association)).map(([k,width])=>[k,new Float64Array(count*width).fill(NaN)])),pa=data(true),ca=data(false);
  for(let i=0;i<count;i++){
    if(i%2048===0){await pause();options.signal?.throwIfAborted();}
    const sample=locator.probe(position(i) as [number,number,number]);if(!sample)continue;valid[i]=1;cells[i]=sample.cell;
    for(const [out,fields,value] of [[pa,sample.pointArrays,sample.pointData],[ca,sample.cellArrays,sample.cellData]] as const){
      if(out[''])out[''][i]=value??NaN;
      for(const [name,tuple] of Object.entries(fields))out[name].set(tuple,i*tuple.length);
    }
  }
  options.signal?.throwIfAborted();const pointData=pa[''],cellData=ca[''];delete pa[''];delete ca[''];return {valid,cells,pointData,cellData,pointArrays:pa,cellArrays:ca};
}
/** Sample equal arc-length positions, including endpoints, along a polyline. Default 101 samples. */
export async function plotOverLine(locator:CellLocator,polyline:ArrayLike<number>,options:ProbeOptions&{readonly samples?:number}={}):Promise<LineProbe>{
  options.signal?.throwIfAborted();const points=Float64Array.from(polyline),samples=options.samples??101;
  if(points.length<6||points.length%3||points.some(x=>!Number.isFinite(x))||!Number.isSafeInteger(samples)||samples<2||samples>1_000_000)throw rangeError('Line probe needs finite xyz vertices and 2 to 1000000 samples','sciviz');
  const arc=[0];for(let i=3;i<points.length;i+=3)arc.push(arc[arc.length-1]+Math.hypot(...[0,1,2].map(a=>points[i+a]-points[i-3+a])));
  const length=arc[arc.length-1];if(!(length>0))throw rangeError('Line probe must have positive length','sciviz');
  const positions=new Float64Array(samples*3),distance=Float64Array.from({length:samples},(_,i)=>i/(samples-1)*length);let segment=0;
  for(let i=0;i<samples;i++){while(segment<arc.length-2&&distance[i]>=arc[segment+1])segment++;const t=(distance[i]-arc[segment])/(arc[segment+1]-arc[segment]||1);for(let a=0;a<3;a++)positions[3*i+a]=points[3*segment+a]+t*(points[3*segment+3+a]-points[3*segment+a]);}
  return {...await samplePositions(locator,samples,i=>Array.from(positions.subarray(3*i,3*i+3)),options),positions,distance};
}

/** Resample all source point arrays and source cell tuples onto a target's points. Outside values are masked NaN. */
export async function resampleDataset(locator:CellLocator,target:ProbeInput,options:ProbeOptions={}):Promise<ResampledDataset>{
  options.signal?.throwIfAborted();validate(target);const n=countPoints(target);if(n>8_000_000)throw rangeError('Resampling supports at most 8000000 target points','sciviz');
  const sampled=await samplePositions(locator,n,i=>isImage(target)?imagePoint(target,i):point(target,i),options);
  const pointArrays=sampled.pointArrays;
  const grid:ProbeInput=isImage(target)?{...target,dims:[...target.dims],bounds:[...target.bounds],points:target.points&&Float64Array.from(target.points)}:{...target,points:Float64Array.from(target.points),connectivity:Uint32Array.from(target.connectivity),offsets:Uint32Array.from(target.offsets),types:Uint8Array.from(target.types),sourceCells:target.sourceCells&&Uint32Array.from(target.sourceCells)};
  return {grid:{...grid,pointData:sampled.pointData,pointArrays,cellData:target.cellData&&Float64Array.from(target.cellData),cellArrays:Object.fromEntries(Object.entries(target.cellArrays??{}).map(([k,v])=>[k,Float64Array.from(v)]))},valid:sampled.valid,cells:sampled.cells,sampledCellArrays:sampled.cellArrays,sampledCellData:sampled.cellData};
}
/** Resample to a regular image with the given sample dimensions and signed bounds. */
export function resampleToImage(locator:CellLocator,dims:readonly[number,number,number],bounds:Bounds,options:ProbeOptions={}):Promise<ResampledDataset>{return resampleDataset(locator,{dims,bounds},options);}

/** Exact simplex field integrals; 3-point tensor Gauss integration of nonfolded trilinear hexahedra. */
export async function integrateGrid(input:ProbeInput,options:ProbeOptions={}):Promise<GridIntegrals>{
  options.signal?.throwIfAborted();validate(input);const grid=isImage(input)?materialize(input):input;
  const make=()=>({measure:0,pa:Object.fromEntries(Object.entries(rows(grid,true)).map(([k,v])=>[k,new Float64Array(v.length/countPoints(grid)||1)])),ca:Object.fromEntries(Object.entries(rows(grid,false)).map(([k,v])=>[k,new Float64Array(v.length/countCells(grid)||1)]))}),out=[make(),make(),make()];
  const add=(dimension:number,measure:number,ids:number[],weights:number[],cell:number)=>{
    const target=out[dimension-1];target.measure+=measure;
    for(const [name,data]of Object.entries(rows(grid,true))){const a=target.pa[name];for(let k=0;k<a.length;k++)a[k]+=measure*ids.reduce((s,id,i)=>s+weights[i]*data[id*a.length+k],0);}
    for(const [name,data]of Object.entries(rows(grid,false))){const a=target.ca[name];for(let k=0;k<a.length;k++)a[k]+=measure*data[cell*a.length+k];}
  };
  const x=[0.5-Math.sqrt(3/5)/2,0.5,0.5+Math.sqrt(3/5)/2],w=[5/18,4/9,5/18];
  for(let cell=0;cell<grid.types.length;cell++){
    if(cell%2048===0){await pause();options.signal?.throwIfAborted();}
    const ids=Array.from({length:grid.offsets[cell]-(cell?grid.offsets[cell-1]:0)},(_,k)=>grid.connectivity[(cell?grid.offsets[cell-1]:0)+k]),p=ids.map(id=>point(grid,id));
    if(grid.types[cell]===12){
      let sign=0;
      for(let a=0;a<3;a++)for(let b=0;b<3;b++)for(let c=0;c<3;c++){
        const shape=hexShape([x[a],x[b],x[c]]),j=[0,1,2].map(a=>[0,1,2].map(b=>p.reduce((s,v,k)=>s+shape.derivatives[k][a]*v[b],0))),det=dot3(j[0],cross3(j[1],j[2]));
        if(det===0||!Number.isFinite(det)||(sign&&Math.sign(det)!==sign))throw rangeError('Hex integration needs a nondegenerate consistently signed Jacobian; repair the cell','sciviz');sign=Math.sign(det);add(3,Math.abs(det)*w[a]*w[b]*w[c],ids,shape.weights,cell);
      }
    }else for(const simplex of simplices({...grid,connectivity:ids,offsets:[ids.length],types:[grid.types[cell]]})){
      const p=simplex.ids.map(id=>point(grid,id)),dimension=p.length-1;if(!dimension)continue;
      const a=sub3(p[1],p[0]),b=p.length>2?sub3(p[2],p[0]):[];
      const measure=dimension===1?Math.hypot(...a):dimension===2?Math.hypot(...cross3(a,b))/2:Math.abs(dot3(a,cross3(b,sub3(p[3],p[0]))))/6;
      if(!(measure>0)||!Number.isFinite(measure))throw rangeError('Integration needs nondegenerate finite cells; repair the geometry','sciviz');add(dimension,measure,simplex.ids,new Array(p.length).fill(1/p.length),cell);
    }
  }
  const finish=(r:ReturnType<typeof make>):IntegralFields=>{const pointData=r.pa['']?.[0],cellData=r.ca['']?.[0];delete r.pa[''];delete r.ca[''];return {measure:r.measure,pointData,cellData,pointArrays:r.pa,cellArrays:r.ca};};
  options.signal?.throwIfAborted();return {length:finish(out[0]),area:finish(out[1]),volume:finish(out[2])};
}

/** Linked chart/3D path owner. moveTo(index) also supports keyboard or external controls. */
export interface LinkedProbePlot { readonly marker:ScatterLayer; moveTo(index:number):void; dispose():void; [Symbol.dispose]():void }
/** Render a profile and link chart hover to a 3D marker. Caller owns both figures; dispose removes only these layers. */
export async function linkProbePlot(view:Figure,chart:Figure,profile:LineProbe,options:ProbeOptions&{readonly array?:string;readonly component?:number}={}):Promise<LinkedProbePlot>{
  options.signal?.throwIfAborted();const values=options.array===undefined?profile.pointData:profile.pointArrays[options.array],component=options.component??0,n=profile.distance.length,width=values?values.length/n:0;
  if(!values||!Number.isInteger(component)||component<0||component>=width)throw rangeError('Linked probe plot needs a present point array and a valid component','sciviz');
  const owned:{figure:Figure;layer:LineLayer|ScatterLayer}[]=[],maps=new Map<LineLayer,number[]>();let marker:ScatterLayer|undefined;
  try{
    let run:number[]=[];
    const flush=async()=>{if(run.length>=2){const layer=await chart.line({x:run.map(i=>profile.distance[i]),y:run.map(i=>values[i*width+component])},{color:'#65d9ff'});owned.push({figure:chart,layer});maps.set(layer,run);}run=[];};
    for(let i=0;i<n;i++){if(i%2048===0){await pause();options.signal?.throwIfAborted();}if(profile.valid[i]&&Number.isFinite(values[i*width+component]))run.push(i);else await flush();}await flush();
    const path=await view.line({x:Array.from(profile.positions).filter((_,i)=>i%3===0),y:Array.from(profile.positions).filter((_,i)=>i%3===1),z:Array.from(profile.positions).filter((_,i)=>i%3===2)},{color:'#65d9ff'});owned.push({figure:view,layer:path});
    const first=profile.valid.findIndex(x=>x!==0);if(first<0)throw rangeError('Linked probe plot needs at least one valid sample','sciviz');
    marker=await view.scatter({x:[profile.positions[3*first]],y:[profile.positions[3*first+1]],z:[profile.positions[3*first+2]]},{color:'#ffbf69',size:8});owned.push({figure:view,layer:marker});options.signal?.throwIfAborted();
    let dead=false;
    const moveTo=(i:number)=>{if(dead)throw fault('disposed','Linked probe plot is disposed; create another','sciviz');if(!Number.isInteger(i)||i<0||i>=n||!profile.valid[i])throw rangeError('Choose a valid profile sample index','sciviz');const position=profile.positions.subarray(3*i,3*i+3);marker!.positions.set(position);marker!.cloud.updatePositions(0,position);view.engine.render();};
    const chartCanvas=chart.engine.canvas;
    const hover=(event:PointerEvent)=>{const picked=chart.pick(event.offsetX,event.offsetY,{radius:12});if(picked){const indices=maps.get(picked.layer as LineLayer);if(indices)moveTo(indices[picked.index]);}};
    // Only the chart owns the pointer listener; the 3D canvas remains available for orbit controls.
    chartCanvas.addEventListener('pointermove',hover as EventListener);
    const dispose=()=>{if(dead)return;dead=true;chartCanvas.removeEventListener('pointermove',hover as EventListener);for(const {figure,layer}of owned.reverse())figure.remove(layer);};
    return {marker,moveTo,dispose,[Symbol.dispose]:dispose};
  }catch(error){for(const {figure,layer}of owned.reverse())figure.remove(layer);throw error;}
}

/** Pipeline adapter: operation probe, line, integrate, image or resample. Locator creation stays lazy. */
export function probeOperator():PipelineOperator{return {kind:'filter',execute:async c=>{
  const p=c.params as unknown as {operation:string;position:[number,number,number];polyline:number[];samples?:number;dims:[number,number,number];bounds:Bounds};
  if(p?.operation==='integrate')return integrateGrid(c.inputs[0] as ProbeInput,{signal:c.signal});
  using locator=await CellLocator.create(c.inputs[0] as ProbeInput,{signal:c.signal});
  if(p?.operation==='probe')return locator.probe(p.position,{signal:c.signal});if(p?.operation==='line')return plotOverLine(locator,p.polyline,{samples:p.samples,signal:c.signal});
  if(p?.operation==='image')return resampleToImage(locator,p.dims,p.bounds,{signal:c.signal});if(p?.operation==='resample')return resampleDataset(locator,c.inputs[1] as ProbeInput,{signal:c.signal});
  throw rangeError('Probe pipeline operation must be probe, line, integrate, image or resample','sciviz');
}};}
