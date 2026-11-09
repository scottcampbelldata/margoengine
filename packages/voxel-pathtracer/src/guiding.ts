import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { VoxelPathTracer, type VoxelPathTracerOptions } from '@margoengine/voxel-pathtracer';
import { validateFeatureOptions, type VoxelTraceFeature } from './compose-types.js';

/** Options for the optional bounding-box caustic path guide. */
export interface GuidedVoxelPathTracerOptions extends VoxelPathTracerOptions {
  /** Share of diffuse continuation directions drawn toward glass/mirror bounds, 0 to 0.95. Default 0.5. */
  guideStrength?: number;
}

function strengthValue(guideStrength: number): number {
  if (typeof guideStrength !== 'number') throw new TypeError('GuidedVoxelPathTracer guideStrength must be a number');
  if (!Number.isFinite(guideStrength) || guideStrength < 0 || guideStrength > 0.95)
    throw new RangeError('GuidedVoxelPathTracer guideStrength must be finite and between 0 and 0.95');
  return guideStrength;
}

/** Bounding-box caustic guiding for a composed tracer. Default strength 0.5; 0 disables guiding. */
export function causticGuiding(options: Pick<GuidedVoxelPathTracerOptions, 'guideStrength'> = {}): VoxelTraceFeature {
  validateFeatureOptions(options, 'causticGuiding');
  const guideStrength = strengthValue(options.guideStrength === undefined ? 0.5 : options.guideStrength);
  return Object.freeze({ id: 'guiding', source: (source: string) => guidedSource(source, guideStrength) });
}

/**
 * Guides pure diffuse continuation rays toward the scene's light-sampled glass and mirrors.
 * Visible box faces and cosine sampling share a complete mixture PDF, including
 * overlapping bounds. Actual voxel intersections, Fresnel events and visibility are unchanged.
 * No photon density estimate, learning pass or persistent GPU allocation is needed.
 */
export class GuidedVoxelPathTracer extends VoxelPathTracer {
  private readonly guideStrength: number;

  protected constructor(options: GuidedVoxelPathTracerOptions) {
    if (!options || typeof options !== 'object')
      throw new TypeError('GuidedVoxelPathTracer.attach expects (engine, {scene, ...options})');
    const { guideStrength = 0.5, ...rest } = options;
    strengthValue(guideStrength);
    super(rest);
    this.guideStrength = guideStrength;
  }

  /** Attach a caustic-guided tracer; zero strength retains the original kernel exactly. */
  static override attach(engine: EngineKernel, options: GuidedVoxelPathTracerOptions): GuidedVoxelPathTracer {
    return super.attach(engine, options) as GuidedVoxelPathTracer;
  }

  protected override tracingSource(): string {
    return guidedSource(super.tracingSource(), this.guideStrength);
  }
}

function guidedSource(source: string, guideStrength: number): string {
  if (guideStrength === 0) return source;
  const edits = [
    [
      'let e=evalAt(kind,m,n,wo,wi,lobes);',
      'var e=evalAt(kind,m,n,wo,wi,lobes);if(kind==0u&&air&&guideable(m)){e.pdf=guidePdf(o,n,wi);}',
    ],
    ['let s=sampleSurface(m,n,wo,etaI);', 'let s=guidedSurface(m,n,wo,etaI,p+off,inAir);'],
    ['var medium=0u;var mInst=NONE;', 'var guideRoulette=1.0;var medium=0u;var mInst=NONE;'],
    [
      '\n  thr*=s.w;\n  if(s.transmit){',
      '\n  if(inAir&&guideable(m)&&guideCount()>0u){guideRoulette=clamp(guideRoulette*s.pdf/max(dot(n,s.wi)*INV_PI,1e-20),1e-20,1e20);}\n  thr*=s.w;\n  if(s.transmit){',
    ],
  ];
  if (edits.some(([original]) => !source.includes(original)))
    throw new MargoError(
      'state',
      'Caustic guiding kernel does not match this tracer; rebuild the package, see https://margoengine.com/errors#voxel-pathtracer',
    );
  let result = source;
  for (const [original, replacement] of edits) result = result.replace(original, replacement);
  result = result.replaceAll('roulette(&thr,bounces)', 'guidedRoulette(&thr,bounces,guideRoulette)');
  const helpers = /* wgsl */ `
// Sampling a small bound lowers throughput by its directional importance weight.
// Do not immediately discard that variance gain at the next dielectric exit.
// Roulette's probability may be chosen freely; its actual survival divides throughput.
fn guidedRoulette(thr:ptr<function,vec3f>,bounces:u32,guideScale:f32)->bool {
 if(bounces<3u){return true;}
 let q=clamp(max(max((*thr).x,(*thr).y),(*thr).z)*guideScale,0.05,1.0);
 if(rand()>=q){return false;}*thr/=q;return true;
}
fn guideable(m:Mat)->bool {return m.glass==0.0&&m.metal==0.0&&m.spec==0.0;}
// Deflector records follow every setScene upload. No cached geometry can go stale.
fn guideCount()->u32 {return scene[scene[1]+1u];}
struct GuideBox {size:vec3f,origin:vec3f,local:Xform,world:Xform,area:vec3f,side:vec3f,total:f32,inside:bool}
fn guideFace(g:GuideBox,axis:u32,sign:f32)->bool {
 if(!g.inside){return g.side[axis]==sign;}
 // A face containing the origin projects to a zero-solid-angle plane. Sampling
 // it would add singular directional mass that a continuous PDF cannot represent.
 return select(g.origin[axis]>0.0,g.origin[axis]<g.size[axis],sign>0.0);
}
fn guideBox(o:vec3f,k:u32)->GuideBox {
 let inst=scene[scene[scene[1]]+2u*k];
 let mb=f.scene.x+scene[f.scene.y+inst*INSTANCE+36u]*MODEL;
 var g:GuideBox;
 g.size=vec3f(f32(scene[mb]),f32(scene[mb+1u]),f32(scene[mb+2u]));
 g.world=worldX(inst);g.local=localX(inst);
 let u=colOf(g.world,0u);let v=colOf(g.world,1u);let w=colOf(g.world,2u);
 g.area=vec3f(length(cross(v,w))*g.size.y*g.size.z,length(cross(w,u))*g.size.z*g.size.x,length(cross(u,v))*g.size.x*g.size.y);
 let p=xpoint(g.local,o);
 g.origin=p;
 g.side=select(select(vec3f(0.0),vec3f(1.0),p>g.size),vec3f(-1.0),p<vec3f(0.0));
 g.inside=all(g.side==vec3f(0.0));
 for(var face=0u;face<6u;face++){
  let axis=face>>1u;let sign=select(-1.0,1.0,(face&1u)!=0u);
  if(guideFace(g,axis,sign)){g.total+=g.area[axis];}
 }
 return g;
}
// Area sampling of visible box faces has a one-to-one directional mapping.
// Inside the bound, all six faces are sampled. The PDF uses the exit face then.
fn boxPdf(o:vec3f,wi:vec3f,g:GuideBox)->f32 {
 let p=xpoint(g.local,o);let d=xdir(g.local,wi);
 var near=-INF;var far=INF;var na=0u;var fa=0u;
 for(var a=0u;a<3u;a++){
  if(abs(d[a])<1e-20){if(p[a]<0.0||p[a]>g.size[a]){return 0.0;}continue;}
  let t0=-p[a]/d[a];let t1=(g.size[a]-p[a])/d[a];
  let lo=min(t0,t1);let hi=max(t0,t1);
  if(lo>near){near=lo;na=a;}if(hi<far){far=hi;fa=a;}
 }
 if(far<=max(near,0.0)){return 0.0;}
 let t=select(near,far,g.inside);let axis=select(na,fa,g.inside);
 let cosine=abs(dot(normalize(rowOf(g.local,axis)),wi));
 if(t<=0.0||cosine<=0.0){return 0.0;}
 return t*t/(g.total*cosine);
}
fn guidePdf(o:vec3f,n:vec3f,wi:vec3f)->f32 {
 let count=guideCount();let base=max(dot(n,wi),0.0)*INV_PI;
 if(count==0u){return base;}
 var pdf=0.0;
 for(var k=0u;k<count;k++){pdf+=boxPdf(o,wi,guideBox(o,k))/f32(count);}
 return ${(1 - guideStrength).toPrecision(9)}*base+${guideStrength.toPrecision(9)}*pdf;
}
fn guidedSurface(m:Mat,n:vec3f,wo:vec3f,etaI:f32,o:vec3f,air:bool)->Bounce {
 let count=guideCount();
 if(!air||!guideable(m)||count==0u){return sampleSurface(m,n,wo,etaI);}
 var s:Bounce;
 if(rand()<${guideStrength.toPrecision(9)}){
  let k=min(u32(rand()*f32(count)),count-1u);let g=guideBox(o,k);
  var pick=rand()*g.total;var selected=0u;
  for(var face=0u;face<6u;face++){
   let axis=face>>1u;let sign=select(-1.0,1.0,(face&1u)!=0u);
   if(!guideFace(g,axis,sign)){continue;}
   pick-=g.area[axis];
   // Keep the last active face if cumulative floating-point subtraction rounds up.
   selected=face;
   if(pick<=0.0){break;}
  }
  let axis=selected>>1u;var p=vec3f(0.0);
  p[axis]=select(0.0,g.size[axis],(selected&1u)!=0u);
  p[(axis+1u)%3u]=rand()*g.size[(axis+1u)%3u];
  p[(axis+2u)%3u]=rand()*g.size[(axis+2u)%3u];
  let v=xpoint(g.world,p)-o;
  if(dot(v,v)==0.0){return s;}
  s.wi=normalize(v);
 }else{s.wi=cosineDir(n);}
 s.pdf=guidePdf(o,n,s.wi);
 if(s.pdf<=0.0||dot(n,s.wi)<=0.0){return s;}
 let e=evalSurface(m,n,wo,s.wi);
 s.w=e.f/s.pdf;s.ok=true;
 return s;
}
`;
  return result.replace('@compute @workgroup_size(8,8) fn trace', helpers + '\n@compute @workgroup_size(8,8) fn trace');
}
