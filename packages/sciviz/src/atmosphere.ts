import { trackSpecLayer } from './spec-hooks.js';
import { PlanetAtmosphere, planetWGSL } from '@margoengine/sky/planet';
import type { AtmosphereParameters } from '@margoengine/sky/planet';
import { sunPosition, greenwichSiderealTime } from '@margoengine/sky/astro';
import { degrees } from '@margoengine/sky/sun';
import { invertMatrix } from '@margoengine/math/mat4';
import { rangeError } from '../../shared/errors.js';
import { WGS84, project, tileLayer, type TileLayerOptions, type TileLayer } from './geo.js';
import { flowParticles, type FlowGrid, type FlowParticlesOptions, type FlowParticles } from './flow.js';
import { meshLayer, type TriangleSet, type MeshLayerOptions, type MeshLayer } from './grids.js';
import type { Figure } from './figure.js';
import type { Bounds } from './layer.js';
import type { LayerAppearance } from './appearance.js';
import { validateFlowGrid } from './flow-seeds.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
declare const GPUShaderStage:{VERTEX:number;FRAGMENT:number};

/** Settings for the WGS84 globe and Hillaire clear atmosphere. All data heights are metres above the ellipsoid. */
export interface GlobeAtmosphereOptions {
  /** UTC solar time. Default 2024-01-01T12:00:00Z; mutate via setDate. */
  readonly date?: Date;
  /** Ground tiles; default a neutral blue globe, zoom 2. Attribution and cancellation are forwarded. */
  readonly tiles?: Omit<TileLayerOptions,'projection'|'appearance'>;
  /** Hillaire medium, with WGS84 equatorial ground radius and 100 km thickness. */
  readonly atmosphere?: Omit<AtmosphereParameters,'bottomRadius'>;
  /** Solar illuminance above the atmosphere, 0..1000000. Default 20. */
  readonly illuminance?: number;
  /** Exposure in stops, -20..20. Default 0. */
  readonly exposure?: number;
  /** Cancels creation, tile loads and the default data operations. */
  readonly signal?: AbortSignal;
}

/** Earth-centred, Earth-fixed unit direction toward the sun, using sky/astro without horizon refraction. */
export function globeSunDirection(date:Date):[number,number,number] {
 const position=sunPosition(date,{latitude:degrees(0),longitude:degrees(0)},{refraction:false});
 const dec=position.declination.degrees*Math.PI/180;
 const hour=(greenwichSiderealTime(date,{apparent:true}).degrees-position.rightAscension.degrees)*Math.PI/180;
 return [Math.cos(dec)*Math.cos(hour),-Math.cos(dec)*Math.sin(hour),Math.sin(dec)];
}

/** Converts a longitude/latitude/ellipsoid-height grid of east/north/up m/s into degree/degree/metre per second. */
export function geographicFlowGrid(grid:FlowGrid):FlowGrid {
 validateFlowGrid(grid);
 const [nx,ny,nz]=grid.dims, [west,east,south,north,low,high]=grid.bounds;
 if(!Number.isInteger(nx)||nx<2||!Number.isInteger(ny)||ny<2||!Number.isInteger(nz)||nz<1||
  ![west,east,south,north,low,high].every(Number.isFinite)||!(east>west&&east-west<=360&&north>south&&south>-90&&north<90&&low>=0&&high>=low))
  throw rangeError('Geographic flow needs ascending longitude/latitude degrees within the open poles and nonnegative metre heights','sciviz');
 const size=nx*ny*nz;
 if(!Number.isSafeInteger(size)||size>8_000_000)throw rangeError('Geographic flow exceeds 8000000 samples; reduce dimensions','sciviz');
 const frames=grid.frames.map(frame=>{
  if(frame.u.length!==size||frame.v.length!==size||(frame.w&&frame.w.length!==size))throw rangeError('Geographic flow needs one east/north/up value per grid sample','sciviz');
  const u=new Float32Array(size),v=new Float32Array(size);
  for(let i=0;i<size;i++){
   const row=Math.floor(i/nx)%ny;
   const phi=(south+(north-south)*row/(ny-1))*Math.PI/180;
   const height=low+(high-low)*(nz>1?Math.floor(i/(nx*ny))/(nz-1):0);
   const k=1-WGS84.e2*Math.sin(phi)**2;
   const N=WGS84.a/Math.sqrt(k),M=WGS84.a*(1-WGS84.e2)/k**1.5;
   u[i]=frame.u[i]/((N+height)*Math.cos(phi))*180/Math.PI;
   v[i]=frame.v[i]/(M+height)*180/Math.PI;
  }
  return {time:frame.time,u,v,...(frame.w?{w:frame.w.slice()}:{})};
 });
 return {dims:[nx,ny,nz],bounds:[...grid.bounds],frames};
}

const skyShader=`${frameWGSL}
struct Out { @builtin(position) clip:vec4f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {var out:Out;out.clip=vec4f(select(-1.0,3.0,i==1u),select(-1.0,3.0,i==2u),0,1);return out;}
@fragment fn fragment(in:Out)->@location(0) vec4f {
 let uv=in.clip.xy/frame.viewport.xy;let clip=vec2f(uv.x*2.0-1.0,1.0-uv.y*2.0);
 let h=frame.inverse*vec4f(clip,0.0001,1);let world=h.xyz/h.w;
 return vec4f(toOutput(planetSky(world-frame.eye.xyz)),1);
}
${planetWGSL}`;

/** A composed, lazily imported globe: solar ground, atmospheric limb, and per-layer aerial transport. */
export class GlobeAtmosphere implements Drawable {
 /** False hides the atmospheric background; hide tiles separately via ground.visible. */
 visible=true;
 readonly transparent=false;
 /** Full globe data bounds. */
 readonly bounds:Bounds=[-1,1,-1,1,-1,1];
 /** Ground tile layer, once globeAtmosphere resolves. */
 ground!:TileLayer;
 readonly #figure:Figure;
 readonly #options:GlobeAtmosphereOptions;
 #date:Date;
 #planet!:PlanetAtmosphere;
 #empty!:GPUBindGroupLayout;
 #disposed=false;
 readonly #children:(MeshLayer|FlowParticles)[]=[];
 /** @internal One shader shared by all participating optional layers; root entries import no sky implementation. */
 readonly appearance:LayerAppearance;
 /** @internal Use globeAtmosphere. */
 constructor(figure:Figure,options:GlobeAtmosphereOptions={}){
  requireGPU(figure.renderer);this.#figure=figure;this.#options=options;this.#date=new Date(options.date??'2024-01-01T12:00:00Z');
  globeSunDirection(this.#date);
  const self=this;
  this.appearance={key:'planet-hillaire',shader:planetWGSL,
   get layout(){return self.#planet.layout;},get group(){return self.#planet.group;},prepare(context){self.prepare(context);}};
  this.restore();
 }
 /** Solar date, copied so caller mutation cannot silently alter lighting. */
 get date():Date{return new Date(this.#date);}
 /** Sets solar time without advancing the data or changing its units. */
 setDate(date:Date):void{globeSunDirection(date);this.#date=new Date(date);}
 /** @internal Recreates sky-owned tables after device replacement. */
 restore():void{this.#planet?.dispose();this.#planet=new PlanetAtmosphere(this.#figure.renderer.device!);this.#empty=this.#figure.renderer.device!.createBindGroupLayout({entries:[]});}
 /** @internal */ setModel(_model:Float32Array):void{}
 /** @internal */ center():readonly[number,number,number]{return [0,0,0];}
 /** @internal */ prepare(context:GpuContext):void{
  const inverse=new Float32Array(16);
  if(!invertMatrix(this.#figure.model,inverse))throw rangeError('Atmosphere needs an invertible figure model; use nonzero aspect','sciviz');
  const km=WGS84.a/1000;
  for(let c=0;c<4;c++)for(let r=0;r<3;r++)inverse[c*4+r]*=km/(r===2?1-WGS84.f:1);
  const camera=context.camera.position;
  const clip=context.camera.matrix;
  if(!(clip[3]||clip[7]||clip[11]))throw rangeError('Atmospheric globe needs a perspective camera; choose perspective projection','sciviz');
  const eye=[0,1,2].map(r=>inverse[r]*camera[0]+inverse[4+r]*camera[1]+inverse[8+r]*camera[2]+inverse[12+r]);
  const solar=globeSunDirection(this.#date);solar[2]/=1-WGS84.f;
  this.#planet.prepare(context.encoder,inverse,eye,solar,{...this.#options,atmosphere:{...this.#options.atmosphere,bottomRadius:km,topRadius:this.#options.atmosphere?.topRadius??km+100}});
 }
 /** @internal */ draw(pass:GPURenderPassEncoder,context:GpuContext,renderer:SciRenderer):void{
  const pipeline=renderer.pipeline('atmosphere-background',context,target=>{
   const module=renderer.device!.createShaderModule({code:skyShader,label:'sciviz atmospheric globe'});
   return {layout:renderer.device!.createPipelineLayout({bindGroupLayouts:[renderer.frameLayout!,this.#empty,this.#planet.layout]}),vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:target.format}]},primitive:{topology:'triangle-list'},multisample:target.multisample,depthStencil:{format:target.depth,depthWriteEnabled:false,depthCompare:'greater-equal'}};
  });
  pass.setPipeline(pipeline);pass.setBindGroup(2,this.#planet.group);pass.draw(3);
 }
 /** Creates GPU-resident wind particles. Longitude/latitude degrees, heights metres, east/north/up m/s, time seconds. */
 async flow(grid:FlowGrid,options:FlowParticlesOptions={}):Promise<FlowParticles>{
  this.#check();const layer=await flowParticles(this.#figure,geographicFlowGrid(grid),{...options,signal:options.signal??this.#options.signal,projection:'globe',appearance:this.appearance});
  if(this.#disposed){this.#figure.remove(layer);throw rangeError('Globe disposed during flow creation; keep it alive until settlement','sciviz');}
  this.#children.push(layer);return trackSpecLayer(this.#figure, 'globe.flow', [this, grid, options], layer);
 }
 /** Projects lon/lat/metre triangles and preserves values and masks, with per-fragment aerial perspective. */
 mesh(set:TriangleSet,options:MeshLayerOptions={}):MeshLayer{
  this.#check();const positions=new Float32Array(set.positions.length);
  for(let i=0;i<positions.length;i+=3)positions.set(project(set.positions[i],set.positions[i+1],set.positions[i+2],'globe'),i);
  const layer=meshLayer(this.#figure,{...set,positions,bounds:[-1,1,-1,1,-1,1]},{...options,appearance:options.appearance??this.appearance});
  this.#children.push(layer);return trackSpecLayer(this.#figure, 'globe.mesh', [this, set, options], layer);
 }
 /** Geographic point glyphs as tangent discs; radius metres (default 10000), scalar colour and central height preserved. */
 points(coordinates:ArrayLike<number>,values:ArrayLike<number>,options:MeshLayerOptions&{radius?:number}={}):MeshLayer{
  this.#check();const count=coordinates.length/3,radius=options.radius??10000;
  if(!Number.isInteger(count)||values.length!==count||!(radius>0&&radius<=1000000))throw rangeError('Globe points need lon/lat/height triples, one value each and radius 0..1000000 m','sciviz');
  const positions=new Float32Array(count*8*9),normals=new Float32Array(positions.length),scalars=new Float32Array(count*24);
  for(let i=0;i<count;i++){
   const lon=coordinates[i*3],lat=coordinates[i*3+1],h=coordinates[i*3+2],p=project(lon,lat,h,'globe');
   const l=lon*Math.PI/180,f=lat*Math.PI/180,e=[-Math.sin(l),Math.cos(l),0],n=[-Math.sin(f)*Math.cos(l),-Math.sin(f)*Math.sin(l),Math.cos(f)];
   for(let j=0;j<8;j++)for(let k=0;k<3;k++){
    const angle=(j+(k===2?1:0))*Math.PI/4,r=k===0?0:radius/WGS84.a,at=(i*24+j*3+k)*3;
    for(let c=0;c<3;c++)positions[at+c]=p[c]+r*(e[c]*Math.cos(angle)+n[c]*Math.sin(angle));
    scalars[at/3]=values[i];
   }
  }
  const layer=meshLayer(this.#figure,{positions,normals,values:scalars,cells:new Uint32Array(count*8),bounds:[-1,1,-1,1,-1,1]},{...options,appearance:this.appearance});this.#children.push(layer);return trackSpecLayer(this.#figure, 'globe.points', [this, coordinates, values, options], layer);
 }
 /** Optional cloud data: supply geographic shell triangles with density values in [0,1]; no procedural weather is generated. */
 clouds(set:TriangleSet,options:Omit<MeshLayerOptions,'colormap'>={}):MeshLayer{
  const self=this;
  const appearance:LayerAppearance={key:'planet-clouds',shader:planetWGSL,surface:true,get layout(){return self.#planet.layout;},get group(){return self.#planet.group;},prepare(context){self.prepare(context);}};
  return trackSpecLayer(this.#figure, 'globe.clouds', [this,set,options], this.mesh(set,{...options,colormap:[[0,'#ffffff'],[1,'#ffffff']],scalarOpacity:true,appearance,opacity:options.opacity??0.6}));
 }
 #check():void{if(this.#disposed)throw rangeError('Atmospheric globe disposed; create a new one','sciviz');this.#options.signal?.throwIfAborted();}
 /** Removes owned data and tiles and frees the sky resources; idempotent. */
 dispose():void{if(this.#disposed)return;this.#disposed=true;for(const layer of this.#children)this.#figure.remove(layer);this.#children.length=0;if(this.ground)this.#figure.remove(this.ground);this.#figure.renderer.remove(this);this.#planet.dispose();}
 [Symbol.dispose]():void{this.dispose();}
}

/** Loads a globe with date-driven solar light and Hillaire transport. Sky code loads only through this entry. */
export async function globeAtmosphere(figure:Figure,options:GlobeAtmosphereOptions={}):Promise<GlobeAtmosphere>{
 options.signal?.throwIfAborted();const globe=new GlobeAtmosphere(figure,options);
 try{
  figure.renderer.add(globe);figure.addLayer(globe);
  globe.ground=await tileLayer(figure,{tiles:async()=>new ImageData(new Uint8ClampedArray([45,85,105,255]),1,1),...options.tiles,projection:'globe',appearance:globe.appearance,signal:options.signal??options.tiles?.signal});
  trackSpecLayer(figure, 'globe', [options], globe);
  trackSpecLayer(figure, 'globe.ground', [globe], globe.ground);
  return globe;
 }catch(error){figure.remove(globe);throw error;}
}
