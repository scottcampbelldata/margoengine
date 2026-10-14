import {engineRuntime,meshRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import type {EngineKernel,Vec3} from '@margoengine/core';
import {Lines,Line} from '@margoengine/lines';
import {TextRenderer,Text,type Font,type FontOptions,type ColorInput} from '@margoengine/text';
import {viewMatrix} from '../../shared/view.js';
import {worldAnchor,type Anchor} from './anchors.js';
import {measureDistance} from './metrology.js';
import {sub} from '@margoengine/math/vec3';
export type {Anchor} from './anchors.js';

/** Distance between two anchors; `offset` is the dimension line's distance from them in CSS pixels (signed, default 24) or a screen pixel vector, as `EngineeringAnnotations` dimensions. */
export interface LinearDimension {kind?:'linear';a:Anchor;b:Anchor;offset?:number|readonly [number,number];label?:string}
/** Angle a-vertex-b (the 3D angle, in degrees), drawn as an arc of `radius` CSS pixels (default 40). */
export interface AngleDimension {kind:'angle';vertex:Anchor;a:Anchor;b:Anchor;radius?:number;label?:string}
/** Radius from `center` to `a` on the circle (`diameter` doubles the value and prefixes Ø). */
export interface RadiusDimension {kind:'radius';center:Anchor;a:Anchor;diameter?:boolean;label?:string}
export type DimensionSpec=LinearDimension|AngleDimension|RadiusDimension;
export interface DimensionOptions {
 /** Plugin name, unique per engine; its Lines and TextRenderer are `<name>:lines` and `<name>:text`. Default 'dimensions'. */
 name?:string;
 /** Lengths as `measureDistance` reports them. Default 'mm' with 1 scene unit = 1 m. */
 unit?:'mm'|'in'|'m';sceneToMeters?:number;decimals?:number;
 color?:ColorInput;outlineColor?:ColorInput;font?:Font|FontOptions;
 /** CSS pixels: label em size (14), line width (1.5), arrowhead length (10). */
 fontSize?:number;lineWidth?:number;arrowSize?:number;
 /** Draw over the scene (default true). */
 onTop?:boolean;
}

type Point=[number,number];
const GAP=3,OVERSHOOT=6;

/**
 * GPU dimension callouts: every dimension's extension lines, dimension lines and arrowheads are one `@margoengine/lines`
 * segment list (one instanced draw), labels are `@margoengine/text` SDF blocks. Laid out in screen pixels each frame and
 * placed back in the view plane at each anchor's depth, so they keep a constant pixel size at any zoom, perspective or
 * orthographic (`@margoengine/cameras`).
 */
export class Dimensions implements EnginePlugin {
 readonly name:string;readonly lines:Lines;readonly text:TextRenderer;
 private readonly line:Line;private readonly items=new Map<DimensionSpec,Text>();private engine?:Engine;
 private positions=new Float32Array(0);private count=0;private readonly view=new Float32Array(16);
 private readonly right=[0,0,0];private readonly up=[0,0,0];private m=new Float32Array(16);private width=1;private height=1;
 constructor(readonly options:DimensionOptions={}){
  this.name=options.name??'dimensions';const o=options;
  if(!this.name||typeof this.name!=='string'||!['mm','in','m'].includes(o.unit??'mm')||!(Number.isFinite(o.sceneToMeters??1)&&(o.sceneToMeters??1)>0)||!Number.isInteger(o.decimals??2)||(o.decimals??2)<0||(o.decimals??2)>6||[o.fontSize??14,o.lineWidth??1.5,o.arrowSize??10].some(v=>!Number.isFinite(v)||v<=0))throw new RangeError('Invalid dimension options');
  this.lines=new Lines({name:this.name+':lines'});this.text=new TextRenderer({name:this.name+':text'});
  this.line=this.lines.add(new Line({mode:'segments',color:o.color??'#ffa76c',width:o.lineWidth??1.5,cap:'butt',join:'miter',onTop:o.onTop??true}));
 }
 static attach(engine:EngineKernel,options:DimensionOptions={}):Dimensions {const d=new Dimensions(options);engineRuntime(engine).use(d);return d;}
 /** Adds a dimension (for example a machinery `Dimension` from `EngineeringAnnotations`) and returns it; anchors are read every frame, so moving parts move their dimensions. */
 add<T extends DimensionSpec>(spec:T):T {
  const kind=spec.kind??'linear',anchors=kind==='angle'?[(spec as AngleDimension).vertex,spec.a,(spec as AngleDimension).b]:kind==='radius'?[(spec as RadiusDimension).center,spec.a]:[spec.a,(spec as LinearDimension).b];
  if(!['linear','angle','radius'].includes(kind))throw new TypeError('Unknown dimension kind');for(const anchor of anchors)worldAnchor(anchor);
  const offset=(spec as LinearDimension).offset,radius=(spec as AngleDimension).radius;
  if(kind==='linear'&&offset!==undefined&&!(typeof offset==='number'?Number.isFinite(offset):offset.length===2&&offset.every(Number.isFinite))||kind==='angle'&&radius!==undefined&&!(radius>0&&Number.isFinite(radius)))throw new RangeError('Invalid dimension offset or radius');
  if(!this.items.has(spec)){const o=this.options;this.items.set(spec,this.text.add(new Text({font:o.font,color:o.color??'#ffa76c',outlineWidth:0.12,outlineColor:o.outlineColor??'#101720',onTop:o.onTop??true,anchorX:'center',anchorY:'bottom',visible:false})));}
  return spec;
 }
 remove(spec:DimensionSpec):void {const text=this.items.get(spec);if(!text)return;this.items.delete(spec);this.text.remove(text);}
 clear():void {for(const spec of [...this.items.keys()])this.remove(spec);}
 get dimensions():readonly DimensionSpec[] {return [...this.items.keys()];}
 /** The measured value: length in `unit`, or degrees for an angle. */
 value(spec:DimensionSpec):number {
  const o=this.options,length=(a:Anchor,b:Anchor)=>measureDistance(a,b,o.unit??'mm',o.sceneToMeters??1);
  if(spec.kind==='angle'){const v=worldAnchor(spec.vertex),a=sub(worldAnchor(spec.a),v),b=sub(worldAnchor(spec.b),v),l=Math.hypot(...a)*Math.hypot(...b);return l?Math.acos(Math.min(1,Math.max(-1,(a[0]*b[0]+a[1]*b[1]+a[2]*b[2])/l)))*180/Math.PI:0;}
  if(spec.kind==='radius')return length(spec.center,spec.a)*(spec.diameter?2:1);
  return length(spec.a,spec.b);
 }
 /** The label drawn for a dimension. */
 label(spec:DimensionSpec):string {
  if(spec.label!==undefined)return spec.label;const value=this.value(spec).toFixed(this.options.decimals??2);
  return spec.kind==='angle'?value+'°':(spec.kind==='radius'?(spec.diameter?'Ø':'R')+value:value)+' '+(this.options.unit??'mm');
 }
 setup(engine:Engine):void {this.engine=engine;engine.use(this.lines);engine.use(this.text);}
 registerPasses(graph:FrameGraph):void {graph.add({name:this.name+':layout',order:19,execute:c=>this.layout(c)});}
 private hidden(anchor:Anchor):boolean {if(!anchor.node)return false;const e=this.engine!,id=meshRuntime(anchor.node).id;if(e.meshes.get(id)!==(anchor.node as unknown))return true;for(let slot=id;slot!==-1;slot=e.store.parents[slot])if(e.store.hidden[slot])return true;return false;}
 /** Screen position (CSS pixels) of a world point and the world vectors of one pixel right and down there; null behind the eye. */
 private project(p:Vec3):{x:number;y:number;px:Vec3;py:Vec3}|null {
  const m=this.m,w=m[3]*p[0]+m[7]*p[1]+m[11]*p[2]+m[15];if(!(w>1e-9))return null;
  const r=this.right,u=this.up,kx=2*w/(this.width*(m[0]*r[0]+m[4]*r[1]+m[8]*r[2])),ky=2*w/(this.height*(m[1]*u[0]+m[5]*u[1]+m[9]*u[2]));
  return {x:((m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12])/w*0.5+0.5)*this.width,y:(0.5-(m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13])/w*0.5)*this.height,px:[r[0]*kx,r[1]*kx,r[2]*kx],py:[-u[0]*ky,-u[1]*ky,-u[2]*ky]};
 }
 private layout(c:PassContext):void {
  this.count=0;const canvas=this.engine!.canvas;this.width=canvas.clientWidth||c.width;this.height=canvas.clientHeight||c.height;this.m=c.camera.matrix;
  const v=viewMatrix(this.view,c.camera);this.right[0]=v[0];this.right[1]=v[4];this.right[2]=v[8];this.up[0]=v[1];this.up[1]=v[5];this.up[2]=v[9];
  const s=this.options.arrowSize??10,font=this.options.fontSize??14;
  for(const [spec,text] of this.items){
   text.visible=false;const kind=spec.kind??'linear',anchors=kind==='angle'?[(spec as AngleDimension).vertex,spec.a,(spec as AngleDimension).b]:kind==='radius'?[(spec as RadiusDimension).center,spec.a]:[spec.a,(spec as LinearDimension).b];
   if(anchors.some(a=>this.hidden(a)))continue;const world=anchors.map(worldAnchor),screen=world.map(p=>this.project(p));if(screen.some(p=>!p))continue;
   // World point at a pixel offset from a projected anchor, in the view plane through it (exact for both projections).
   const at=(i:number,dx:number,dy:number):Vec3=>{const p=world[i],q=screen[i]!;return [p[0]+q.px[0]*dx+q.py[0]*dy,p[1]+q.px[1]*dx+q.py[1]*dy,p[2]+q.px[2]*dx+q.py[2]*dy];};
   const seg=(i:number,a:Point,j:number,b:Point)=>this.push(at(i,a[0]-screen[i]!.x,a[1]-screen[i]!.y),at(j,b[0]-screen[j]!.x,b[1]-screen[j]!.y));
   const arrow=(i:number,tip:Point,d:Point)=>{for(const side of [-0.35,0.35])seg(i,tip,i,[tip[0]+d[0]*s-d[1]*s*side,tip[1]+d[1]*s+d[0]*s*side]);};
   let place:Point,dir:Point=[1,0],ref=0,anchorX:'center'|'left'|'right'='center',anchorY:'bottom'|'middle'='middle';
   const p0:Point=[screen[0]!.x,screen[0]!.y],p1:Point=[screen[1]!.x,screen[1]!.y];
   if(kind==='linear'){
    let d=sub2(p1,p0);const length=Math.hypot(...d);d=length>1e-6?[d[0]/length,d[1]/length]:[1,0];
    const offset=(spec as LinearDimension).offset??24,o:Point=typeof offset==='number'?[d[1]*offset,-d[0]*offset]:[offset[0],offset[1]],ol=Math.hypot(...o),n:Point=ol>1e-6?[o[0]/ol,o[1]/ol]:[d[1],-d[0]];
    const a:Point=[p0[0]+o[0],p0[1]+o[1]],b:Point=[p1[0]+o[0],p1[1]+o[1]],inside=length>=2.5*s,k=inside?1:-1,reach=inside?0:2*s;
    for(const [i,p] of [[0,p0],[1,p1]] as const)if(ol>GAP)seg(i,[p[0]+n[0]*GAP,p[1]+n[1]*GAP],i,[p[0]+o[0]+n[0]*OVERSHOOT,p[1]+o[1]+n[1]*OVERSHOOT]);
    seg(0,[a[0]-d[0]*reach,a[1]-d[1]*reach],1,[b[0]+d[0]*reach,b[1]+d[1]*reach]);arrow(0,a,[d[0]*k,d[1]*k]);arrow(1,b,[-d[0]*k,-d[1]*k]);
    // Read left to right (vertical lines bottom to top), just above the dimension line.
    dir=d[0]<-1e-6||Math.abs(d[0])<=1e-6&&d[1]>0?[-d[0],-d[1]]:d;place=[(a[0]+b[0])/2+dir[1]*GAP,(a[1]+b[1])/2-dir[0]*GAP];anchorY='bottom';
   }else if(kind==='angle'){
    const r=(spec as AngleDimension).radius??40,p2:Point=[screen[2]!.x,screen[2]!.y],ta=Math.atan2(p1[1]-p0[1],p1[0]-p0[0]);let sweep=Math.atan2(p2[1]-p0[1],p2[0]-p0[0])-ta;
    sweep=Math.atan2(Math.sin(sweep),Math.cos(sweep));const steps=Math.min(64,Math.max(8,Math.ceil(Math.abs(sweep)*r/4))),point=(t:number):Point=>[p0[0]+r*Math.cos(ta+sweep*t),p0[1]+r*Math.sin(ta+sweep*t)];
    for(let i=0;i<steps;i++)seg(0,point(i/steps),0,point((i+1)/steps));
    for(const [p,ray] of [[p1,ta],[p2,ta+sweep]] as const){const l=Math.hypot(p[0]-p0[0],p[1]-p0[1]),u:Point=[Math.cos(ray),Math.sin(ray)];if(l<r+OVERSHOOT-0.5)seg(0,[p0[0]+u[0]*l,p0[1]+u[1]*l],0,[p0[0]+u[0]*(r+OVERSHOOT),p0[1]+u[1]*(r+OVERSHOOT)]);}
    const sign=Math.sign(sweep)||1,tangent=(angle:number,k:number):Point=>[-Math.sin(angle)*sign*k,Math.cos(angle)*sign*k];
    if(Math.abs(sweep)*r>=2.5*s){arrow(0,point(0),tangent(ta,1));arrow(0,point(1),tangent(ta+sweep,-1));}
    const mid=ta+sweep/2;place=[p0[0]+(r+font*0.8)*Math.cos(mid),p0[1]+(r+font*0.8)*Math.sin(mid)];
   }else{
    let d=sub2(p1,p0);const length=Math.hypot(...d);d=length>1e-6?[d[0]/length,d[1]/length]:[1,0];
    this.push(world[0],world[1]);arrow(1,p1,[-d[0],-d[1]]);seg(1,p1,1,[p1[0]+d[0]*12,p1[1]+d[1]*12]);
    place=[p1[0]+d[0]*(12+GAP),p1[1]+d[1]*(12+GAP)];anchorX=d[0]<0?'right':'left';ref=1;
   }
   // Label: em = fontSize pixels along the reading direction, in the view plane at the reference anchor's depth.
   // Text x along the reading direction, y up on screen; z any non-degenerate normal (text is flat).
   const q=screen[ref]!,origin=at(ref,place[0]-q.x,place[1]-q.y),x=[0,1,2].map(k=>(q.px[k]*dir[0]+q.py[k]*dir[1])*font),y=[0,1,2].map(k=>(q.px[k]*dir[1]-q.py[k]*dir[0])*font);
   const z=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]],zl=Math.hypot(...z)/font||1;
   text.setMatrix([...x,0,...y,0,z[0]/zl,z[1]/zl,z[2]/zl,0,...origin,1]);text.set({text:this.label(spec),anchorX,anchorY});text.visible=true;
  }
  // Rewrite the shared segment list only when a point moved (a still camera uploads nothing).
  const n=this.count*6,points=this.line.points;let same=this.line.count*3===n;
  for(let i=0;same&&i<n;i++)same=points[(i/3|0)*4+i%3]===this.positions[i];
  if(!same)this.line.setPositions(this.positions.subarray(0,n));
 }
 private push(a:ArrayLike<number>,b:ArrayLike<number>):void {
  if((this.count+1)*6>this.positions.length){const next=new Float32Array(Math.max(96,this.positions.length*2));next.set(this.positions);this.positions=next;}
  this.positions.set(a,this.count*6);this.positions.set(b,this.count*6+3);this.count++;
 }
 /** Removes the dimensions, their lines and text from the engine and frees their GPU resources. */
 dispose():void {const e=this.engine;if(!e)return;this.engine=undefined;e.removePlugin(this.lines.name);e.removePlugin(this.text.name);e.removePlugin(this.name);}
}
const sub2=(a:Point,b:Point):Point=>[a[0]-b[0],a[1]-b[1]];
