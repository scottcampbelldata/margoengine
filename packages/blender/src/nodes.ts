import type { EngineKernel } from '@margoengine/core';
import { GLTFAsset, PBRModel, type MaterialExtension } from '@margoengine/gltf-pro/model';
import { margoError } from '../../shared/errors.js';
import { readResponse } from '../../shared/loading.js';
import { decodeImages, maxBytes } from './container.js';
import { decodeMargo, type MargoOptions } from './index.js';
import { mathExpressions, blendExpressions, nodeHelpers, noiseHelpers } from './nodes-wgsl.js';

type Value = readonly number[];
type Wire = { link: number } | { parameter: string };
interface Parameter { value: number[]; samples?: number[][] }
interface GraphNode {
  name: string; op: string; type: 'float' | 'color' | 'vector'; inputs: Wire[];
  operation?: string; clamp?: boolean; clampFactor?: boolean; mode?: string; blend?: string;
  stops?: [Wire, Wire][]; interpolation?: string; colorMode?: string; hue?: string; alpha?: boolean;
  dimensions?: number; noiseType?: string; normalize?: boolean; color?: boolean; sockets?: string[]; component?: number;
}
/** Versioned live socket graph written by the Blender add-on's opt-in live_nodes export. */
export interface MargoNodeGraph {
  version: 1;
  nodes: GraphNode[];
  parameters: Record<string, Parameter>;
  surface: Record<string, Wire>;
  bounds: [number[], number[]];
  /** Blender units to metres, default 1 for older manifests. */
  unitScale?: number;
  /** Seconds from the scene range's first frame, sampled at its fps. Omitted for static graphs. */
  times?: number[];
}
function reject(detail: string): never {
  throw margoError('unsupported', `Invalid live Blender graph: ${detail}; re-export with supported live nodes; see https://margoengine.com/errors#unsupported`);
}
const finiteValue = (v: unknown): v is number[] => Array.isArray(v) && [1, 3, 4].includes(v.length) && v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e20);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (e: string, type: string) => type === 'color' ? `dot(${e}.rgb,vec3f(0.3333333333))` : `${e}.x`;

/** A compiled GPU surface and its live uniform values. set and seek never recompile the shader or bake an image. */
export class MargoNodeMaterial {
  /** Attach to a PBRMaterial.extension or PBRPrimitive.extension. GPU resources belong to the PBRModel. */
  readonly extension: MaterialExtension;
  /** Stable socket paths accepted by get/set, including ramp stops and unlinked node inputs. */
  readonly parameters: readonly string[];
  private readonly graph: MargoNodeGraph;
  private readonly offsets = new Map<string, number>();
  private readonly values: Float32Array;
  private readonly overrides = new Map<string, Value>();

  /** Validates untrusted exported metadata before generating WGSL. */
  constructor(input: MargoNodeGraph) {
    if (!record(input) || input.version !== 1 || !Array.isArray(input.nodes) || input.nodes.length > 256 || !record(input.parameters) || !record(input.surface)) reject('version, nodes or parameters');
    // Retain an independent snapshot: later edits to the caller's metadata cannot inject WGSL or change layouts.
    const g = structuredClone(input);
    this.graph = g;
    this.parameters = Object.freeze(Object.keys(g.parameters));
    if (this.parameters.length > 1024) reject('more than 1024 parameters');
    if (g.times && (!Array.isArray(g.times) || g.times.length > 3601 || !g.times.length || g.times.some((t,i) => !Number.isFinite(t) || t < 0 || (i > 0 && t <= g.times![i-1])))) reject('animation times');
    let sampleCount = 0;
    for (const [key,p] of Object.entries(g.parameters)) {
      if (!record(p) || !finiteValue(p.value)) reject(`parameter ${key}`);
      if (p.samples && (!g.times || !Array.isArray(p.samples) || p.samples.length !== g.times.length || p.samples.some(v => !finiteValue(v) || v.length !== p.value.length))) reject(`samples of ${key}`);
      sampleCount += p.samples?.length ?? 0;
      this.offsets.set(key, this.offsets.size * 4);
    }
    if (sampleCount > 262144) reject('more than 262144 samples');
    if (!Array.isArray(g.bounds) || g.bounds.length !== 2 || g.bounds.some(v => !finiteValue(v) || v.length !== 3) || g.bounds[0].some((v,i) => v > g.bounds[1][i])) reject('local bounds');
    if (g.unitScale !== undefined && (!Number.isFinite(g.unitScale) || g.unitScale <= 0 || g.unitScale > 1e20)) reject('unit scale');
    this.values = new Float32Array(Math.max(4, this.parameters.length * 4));
    const expressions: string[] = [], types: string[] = [], helpers = new Map<string, string>();
    const wire = (w: Wire, type: string): string => {
      if (!record(w)) reject('socket reference');
      let e: string, source: string;
      if ('link' in w) {
        if (!Number.isSafeInteger(w.link) || w.link < 0 || w.link >= expressions.length) reject('forward or cyclic socket link');
        e = `bn${w.link}`; source = types[w.link];
      } else if ('parameter' in w && typeof w.parameter === 'string' && this.offsets.has(w.parameter)) {
        e = `materialFactors[${this.offsets.get(w.parameter)! / 4}]`;
        source = g.parameters[w.parameter].value.length === 1 ? 'float' : g.parameters[w.parameter].value.length === 4 ? 'color' : 'vector';
      } else reject('unknown parameter');
      if (type === 'float') return scalar(e, source);
      if (source === 'float') return `vec4f(vec3f(${e}.x),1.0)`;
      return source === 'vector' ? `vec4f(${e}.xyz,1.0)` : e;
    };
    for (const n of g.nodes) {
      if (!record(n) || !['float','color','vector'].includes(n.type) || typeof n.name !== 'string' || !Array.isArray(n.inputs) || n.inputs.length > 16) reject('node record');
      const get = (i: number, type = 'float') => wire(n.inputs[i], type);
      let e: string;
      switch (n.op) {
        case 'value': e = get(0, n.type); if (n.type === 'float') e = `vec4f(${e})`; break;
        case 'uv': e = 'vec4f(i.uv.x,1.0-i.uv.y,0.0,1.0)'; break;
        case 'object': e = 'vec4f(bnLocal(i.position),1.0)'; break;
        case 'normal': e = 'vec4f(i.normal.x,-i.normal.z,i.normal.y,1.0)'; break;
        case 'generated': {
          const lo = g.bounds[0].map(v => Number(v).toExponential()).join(','), extent = g.bounds[0].map((v,i) => Math.max(g.bounds[1][i]-v,1e-20).toExponential()).join(',');
          e = `vec4f((bnLocal(i.position)-vec3f(${lo}))/vec3f(${extent}),1.0)`; break;
        }
        case 'math': {
          const expression = mathExpressions[n.operation!]; if (!expression) reject(`math ${n.operation}`);
          const a=get(0), b=get(1), c=get(2);
          let code = expression.replace(/\b[abc]\b/g, v => ({a,b,c})[v as 'a']);
          if (n.clamp) code = `clamp(${code},0.0,1.0)`;
          e = `vec4f(${code})`; break;
        }
        case 'mix': {
          if (!['FLOAT','VECTOR','RGBA'].includes(n.mode!)) reject('mix data type');
          let t = get(0, n.mode === 'VECTOR' ? 'vector' : 'float');
          if (n.mode === 'VECTOR') t += '.xyz';
          if (n.clampFactor) t = n.mode === 'VECTOR' ? `clamp(${t},vec3f(0),vec3f(1))` : `clamp(${t},0.0,1.0)`;
          if (n.mode === 'FLOAT') e = `vec4f(mix(${get(1)},${get(2)},${t}))`;
          else if (n.mode === 'VECTOR') e = `vec4f(mix(${get(1,'vector')}.xyz,${get(2,'vector')}.xyz,${t}),1.0)`;
          else {
            const blend=blendExpressions[n.blend!]; if(!blend) reject(`blend ${n.blend}`);
            const a=get(1,'color'), b=get(2,'color');
            const code=blend.replace(/\b[ab]\b/g,v=>`(${v==='a'?a:b}.rgb)`);
            e=`vec4f(mix(${a}.rgb,${code},${t}),${a}.a)`;
          }
          if(n.clamp) e=`clamp(${e},vec4f(0),vec4f(1))`; break;
        }
        case 'separate':
          if (!Number.isInteger(n.component) || n.component! < 0 || n.component! > 3) reject('separate component');
          e=`vec4f(${get(0,'vector')}[${n.component}])`; break;
        case 'combine': e=`vec4f(${get(0)},${get(1)},${get(2)},1.0)`; break;
        case 'ramp': {
          const stops=n.stops;
          if(!Array.isArray(stops)||stops.length<2||stops.length>32||stops.some(s=>!Array.isArray(s)||s.length!==2||s.some(w=>!record(w)||!('parameter' in w)))||!['CONSTANT','LINEAR','EASE','CARDINAL','B_SPLINE'].includes(n.interpolation!)||!['RGB','HSV','HSL'].includes(n.colorMode!)||!['NEAR','FAR','CW','CCW'].includes(n.hue!)) reject('ramp settings');
          const name=`bnRamp${expressions.length}`, color=(i:number)=>`colors[${Math.max(0,Math.min(stops.length-1,i))}]`, pos=(i:number)=>`positions[${i}]`;
          let code=`fn ${name}(x:f32)->vec4f {var positions=array<f32,${stops.length}>(${stops.map(s=>wire(s[0],'float')).join(',')});var colors=array<vec4f,${stops.length}>(${stops.map(s=>wire(s[1],'color')).join(',')});
          for(var a=1u;a<${stops.length}u;a++){var b=a;loop{if(b==0u){break;}if(positions[b]>=positions[b-1u]){break;}let p=positions[b];positions[b]=positions[b-1u];positions[b-1u]=p;let c=colors[b];colors[b]=colors[b-1u];colors[b-1u]=c;b--;}}
          if(x<${pos(0)}){return ${color(0)};}\n`;
          for(let j=1;j<stops.length;j++) {
            const raw=`clamp(bnDiv(x-${pos(j-1)},${pos(j)}-${pos(j-1)}),0.0,1.0)`;
            const t=n.interpolation==='EASE'?`(${raw}*${raw}*(3.0-2.0*${raw}))`:n.interpolation==='CONSTANT'?'0.0':raw;
            let mix=`mix(${color(j-1)},${color(j)},t)`;
            if(n.colorMode!=='RGB') {
              const convert=n.colorMode==='HSV'?'bnHSV':'bnHSL', back=n.colorMode==='HSV'?'bnRGB':'bnFromHSL', hue=['NEAR','FAR','CCW','CW'].indexOf(n.hue!);
              mix=`vec4f(${back}(vec3f(bnHue(a.x,b.x,t,${hue}u),mix(a.yz,b.yz,t))),mix(${color(j-1)}.a,${color(j)}.a,t))`;
              code+=`if(x<${pos(j)}){let t=${t};let a=${convert}(${color(j-1)}.rgb);let b=${convert}(${color(j)}.rgb);return ${mix};}\n`;
            } else {
              if(n.interpolation==='CARDINAL'||n.interpolation==='B_SPLINE') mix=`bnCubic(${color(j-2)},${color(j-1)},${color(j)},${color(j+1)},t,${n.interpolation==='B_SPLINE'})`;
              code+=`if(x<${pos(j)}){let t=${t};return ${mix};}\n`;
            }
          }
          code+=`return ${color(stops.length-1)};}`; helpers.set(name,code);
          e=`${name}(${get(0)})`; if(n.alpha)e=`vec4f(${e}.a)`; break;
        }
        case 'noise': {
          const dim=n.dimensions!, kind=['FBM','MULTIFRACTAL','RIDGED_MULTIFRACTAL','HYBRID_MULTIFRACTAL','HETERO_TERRAIN'].indexOf(n.noiseType!);
          if(![1,2,3,4].includes(dim)||kind<0||!Array.isArray(n.sockets)||n.sockets.length!==n.inputs.length)reject('noise settings');
          if(!helpers.has(`noise${dim}`)) helpers.set(`noise${dim}`,noiseHelpers(dim).replace(/fn bnHash\([^\n]+\n/,'') );
          const socket=(name:string,fallback:string)=>{const i=n.sockets!.indexOf(name);return i<0?fallback:get(i);};
          const v=get(0,'vector'), w=socket('W','0.0'), scale=socket('Scale','5.0');
          const p=dim===1?`vec4f(${w},0,0,0)`:dim===2?`vec4f(${v}.xy,0,0)`:dim===3?`vec4f(${v}.xyz,0)`: `vec4f(${v}.xyz,${w})`;
          const call=(channel:number)=>`bnTexture${dim}(${p}*${scale},${socket('Detail','2.0')},${socket('Roughness','0.5')},${socket('Lacunarity','2.0')},${socket('Distortion','0.0')},${socket('Offset','1.0')},${socket('Gain','1.0')},${kind}u,${n.normalize!==false},${channel}.0)`;
          e=n.color?`vec4f(${call(0)},${call(1)},${call(2)},1.0)`:`vec4f(${call(0)})`; break;
        }
        default: reject(`node ${n.op}`);
      }
      expressions.push(`let bn${expressions.length}=${e};`); types.push(n.type);
    }
    let wgsl=expressions.join('\n');
    for(const [key,w] of Object.entries(g.surface)) {
      if(!['base','alpha','metal','roughness','emission','strength','ior'].includes(key))reject('surface input');
      const e=wire(w,key==='base'||key==='emission'?'color':'float');
      if(key==='base') wgsl+=`\ns.base=vec4f(${e}.rgb,s.base.a);`;
      if(key==='alpha')wgsl+=`\ns.base.a=clamp(${e},0.0,1.0);`;
      if(key==='metal')wgsl+=`\ns.metal=clamp(${e},0.0,1.0);`;
      if(key==='roughness')wgsl+=`\ns.roughness=clamp(${e},0.045,1.0);`;
      if(key==='emission')wgsl+=`\ns.emissive=${e}.rgb;`;
    }
    if(g.surface.strength)wgsl+=`\ns.emissive*=${wire(g.surface.strength,'float')};`;
    const hash=noiseHelpers(1).match(/fn bnHash\([^\n]+\n/)![0];
    const localHelpers=nodeHelpers.replace('return vec3f(v.x,-v.z,v.y);',`return vec3f(v.x,-v.z,v.y)/${(g.unitScale??1).toExponential()};`);
    this.extension={factors:this.values,declarations:localHelpers+(helpers.size?hash:'')+[...helpers.values()].join('\n'),wgsl,
      ior:g.surface.ior?wire(g.surface.ior,'float'):undefined};
    this.seek(0);
  }

  /** Copies the current scalar, vector or RGBA socket value. */
  get(key: string): number[] {
    const p=this.graph.parameters[key], offset=this.offsets.get(key);
    if(offset===undefined)reject(`unknown socket ${key}`);
    return Array.from(this.values.subarray(offset,offset+p.value.length));
  }
  /** Overrides a socket until reset. Values use scene-linear RGB and Blender Z-up vectors. */
  set(key: string, value: number | Value): this {
    const p=this.graph.parameters[key], v=typeof value==='number'?[value]:Array.from(value);
    if(!p||!finiteValue(v)||v.length!==p.value.length)reject(`socket value ${key}`);
    this.overrides.set(key,v); this.write(key,v); return this;
  }
  /** Removes one override, or all overrides. Call seek to restore the animation's current values. */
  reset(key?: string): this { if(key===undefined)this.overrides.clear();else this.overrides.delete(key);return this; }
  private write(key:string,v:Value): void {
    const at=this.offsets.get(key)!;
    this.values.set(v.length===1?[v[0],v[0],v[0],v[0]]:v.length===3?[...v,1]:v,at);
  }
  /** Clamped seek in seconds from the scene range start. Negative and past-end times clamp; no implicit loop. */
  seek(seconds: number): this {
    if(!Number.isFinite(seconds))reject('seek time');
    const times=this.graph.times;
    let left=0,right=0,t=0;
    if(times){right=times.findIndex(v=>v>seconds);if(right<0)right=times.length-1;left=Math.max(0,right-1);t=right===left?0:Math.max(0,Math.min(1,(seconds-times[left])/(times[right]-times[left])));}
    for(const [key,p] of Object.entries(this.graph.parameters)) {
      const v=this.overrides.get(key)??(p.samples?p.samples[left].map((v,i)=>v+(p.samples![right][i]-v)*t):p.value);
      this.write(key,v);
    }
    return this;
  }
}

/** Loaded PBR scene and its distinct live material controllers, in source material order. */
export interface MargoNodes {
  model: PBRModel;
  materials: ReadonlyMap<number, MargoNodeMaterial>;
  /** Seek all exported material socket animations. */
  seek(seconds: number): void;
  /** Releases the PBRModel, its geometry, textures and extension uniforms. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Decode a .margo scene, validate graphs and attach live PBR surfaces. signal defaults to absent. */
export async function parseMargoNodes(engine: EngineKernel, input: ArrayBuffer | ArrayBufferView, options: MargoOptions & {signal?: AbortSignal} = {}): Promise<MargoNodes> {
  options.signal?.throwIfAborted();
  const asset=decodeMargo(input,options), materials=new Map<number,MargoNodeMaterial>();
  asset.document.materials?.forEach((m,i)=>{const graph=(m.extras as Record<string,unknown> | undefined)?.['margo:nodes'];if(graph!==undefined)materials.set(i,new MargoNodeMaterial(graph as MargoNodeGraph));});
  const images=await decodeImages(asset.images,options.signal);
  let model:PBRModel|undefined;
  try {
    options.signal?.throwIfAborted();
    model=new PBRModel(engine,new GLTFAsset(asset.document,[],undefined,undefined,undefined,options.maxNodes),images,asset.geometry);
    for(const p of model.primitives){const live=materials.get(p.definition.material??-1);if(live)p.extension=live.extension;}
    engine.use(model);
    const dispose=()=>model!.dispose();
    return {model,materials,seek(seconds){for(const m of materials.values())m.seek(seconds);},dispose,[Symbol.dispose]:dispose};
  } catch(error){model?.dispose();for(const image of images)image.close();throw error;}
}

/** Fetch HTTP(S) .margo bytes with bounded loading, cancellation and optional fetch injection. */
export async function loadMargoNodes(engine:EngineKernel,url:string|URL,{fetch:get=globalThis.fetch,...options}:MargoOptions & {signal?:AbortSignal;fetch?:typeof fetch}={}):Promise<MargoNodes> {
  options.signal?.throwIfAborted();
  const target=new URL(url,globalThis.location?.href);
  if(!['http:','https:'].includes(target.protocol))throw new TypeError('Live .margo URL must use HTTP(S); read local bytes and call parseMargoNodes');
  return parseMargoNodes(engine,await readResponse(await get(target,{signal:options.signal}),{maxBytes,signal:options.signal,label:'.margo nodes download'}),options);
}
