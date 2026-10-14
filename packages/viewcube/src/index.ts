import type {Camera,EngineKernel} from '@margoengine/core';
import type {FrameGraph} from '@margoengine/core/extension';

export type Face='top'|'bottom'|'front'|'back'|'left'|'right';
/** A named view (`iso` is top-front-right), or a direction from the target toward the camera such as `[1, 1, 0]`. */
export type View=Face|'iso'|readonly [number,number,number];
export type Projection='orthographic'|'perspective';
export interface ViewCubeOptions {
  /** Element the cube is placed in. Default: the canvas's parent. */
  container?:HTMLElement;
  corner?:'top-right'|'top-left'|'bottom-right'|'bottom-left';
  /** Cube edge in CSS pixels. Default 80. */
  size?:number;
  /** Seconds a click animates for. Default 0.4. */
  duration?:number;
  /** A `@margoengine/cameras` CameraProjection (anything with `mode`): shows a perspective/orthographic toggle.
   * Default: the CameraProjection already attached to the engine, if any. */
  projection?:{mode:Projection};
  /** Face names, for translation. */
  labels?:Partial<Record<Face,string>>;
}
type V3=[number,number,number];
/** Normal, then the face's right and up as seen from outside. Y up, front is +Z, right is +X. */
const FACES:Record<Face,[V3,V3,V3]>={front:[[0,0,1],[1,0,0],[0,1,0]],back:[[0,0,-1],[-1,0,0],[0,1,0]],right:[[1,0,0],[0,0,-1],[0,1,0]],
  left:[[-1,0,0],[0,0,1],[0,1,0]],top:[[0,1,0],[1,0,0],[0,0,-1]],bottom:[[0,-1,0],[1,0,0],[0,0,1]]};
/** Arrow-key step; polar angles within POLE of 0 or π land exactly on the pole. */
const STEP=Math.PI/4,POLE=1e-9;
const CSS=`.mvc{position:absolute;z-index:1;user-select:none;-webkit-user-select:none;font:600 11px system-ui,sans-serif}
.mvc-cube{position:absolute;inset:0;transform-style:preserve-3d;pointer-events:none}
.mvc-face{position:absolute;inset:0;display:grid;grid-template:20% 60% 20%/20% 60% 20%;backface-visibility:hidden;-webkit-backface-visibility:hidden;pointer-events:auto;box-sizing:border-box;border:1px solid #868d98;background:rgba(236,238,242,.92);color:#262a31}
.mvc-face>*{border:0;margin:0;padding:0;background:none;color:inherit;font:inherit;text-transform:uppercase;cursor:pointer;outline:none}
.mvc-face>:hover,.mvc-face>:focus-visible{background:rgba(52,128,246,.45)}
.mvc button:focus-visible{box-shadow:inset 0 0 0 2px #1a63d6}
.mvc-projection{position:absolute;left:0;right:0;bottom:-26px;height:22px;border:1px solid #868d98;border-radius:4px;background:rgba(236,238,242,.92);color:#262a31;font:inherit;cursor:pointer}`;

/** Spherical angles of a direction: azimuth about +Y from +Z (0 when vertical, so top and bottom keep -Z and +Z up), polar from +Y. */
const angles=(d:readonly number[]):[number,number]=>{const l=Math.hypot(d[0],d[1],d[2]),h=Math.hypot(d[0],d[2]);return [h>1e-9*l?Math.atan2(d[0],d[2]):0,Math.acos(Math.max(-1,Math.min(1,d[1]/l)))];};
/** "Top Front Right" for [1, 1, 1]. */
const describe=(d:readonly number[],labels:Record<Face,string>):string=>[d[1]>0?labels.top:d[1]<0?labels.bottom:'',d[2]>0?labels.front:d[2]<0?labels.back:'',d[0]>0?labels.right:d[0]<0?labels.left:''].filter(Boolean).join(' ');
const css=(m:readonly number[]):string=>`matrix3d(${m.map(v=>+v.toFixed(6)).join(',')})`;
let count=0;

/**
 * A CAD orientation cube in a corner of the view (Autodesk-style ViewCube). It turns with the camera; a click on a face,
 * edge or corner animates the camera around its target to that view, keeping the distance. Keyboard: the six faces are
 * buttons; arrow keys step the view 45°, Home goes to the isometric view. Works with core's CADCameraControls and
 * `@margoengine/controls` OrbitControls (they read the camera each frame), and toggles a `@margoengine/cameras` projection.
 */
export class ViewCube {
  /** The widget root; style or move it as you like. */
  readonly element:HTMLDivElement;
  readonly camera:Camera;
  duration:number;
  readonly name='margoengine-viewcube:'+count++;
  private readonly cube:HTMLDivElement;private readonly buttons:[HTMLElement,V3][]=[];private readonly toggle?:HTMLButtonElement;private readonly projection?:{mode:Projection};
  private readonly container:HTMLElement;private readonly position:string;
  private animation?:{theta:number;phi:number;dTheta:number;dPhi:number;radius:number;elapsed:number;duration:number;at?:readonly number[]};
  private last='';private disposed=false;private upSet?:V3;private upPrev?:Camera['up'];

  constructor(readonly engine:EngineKernel,{container=engine.canvas.parentElement!,corner='top-right',size=80,duration=0.4,projection,labels={}}:ViewCubeOptions={}) {
    if(!container)throw new TypeError('ViewCube needs a container (the canvas has no parent)');
    if(!(size>0)||!(duration>=0))throw new RangeError('Invalid ViewCube size or duration');
    // A CameraProjection already attached to the engine is found by its plugin name.
    const found=(engine as unknown as {plugins?:ReadonlyMap<string,{mode?:Projection}>}).plugins?.get('cameras');
    projection??=found?.mode?found as {mode:Projection}:undefined;
    this.camera=engine.camera;this.duration=duration;this.projection=projection;this.container=container;
    const names:Record<Face,string>={top:'Top',bottom:'Bottom',front:'Front',back:'Back',left:'Left',right:'Right',...labels};
    const doc=container.ownerDocument,el=<K extends keyof HTMLElementTagNameMap>(tag:K,parent:HTMLElement,className?:string)=>{const e=doc.createElement(tag);if(className)e.className=className;parent.appendChild(e);return e;};
    const root=this.element=el('div',container,'mvc');
    root.setAttribute('role','group');root.setAttribute('aria-label','View cube');
    const [v,h]=corner.split('-');root.style[v as 'top']=(v==='bottom'&&projection?38:12)+'px';root.style[h as 'left']='12px';root.style.width=root.style.height=size+'px';
    el('style',root).textContent=CSS;
    this.cube=el('div',root,'mvc-cube');
    for(const face of Object.keys(FACES) as Face[]){
      const [n,u,w]=FACES[face],f=el('div',this.cube,'mvc-face'),k=size/2;
      // Element x to the face's right, element y (down) to its down, z outward, pushed out by half the cube.
      f.style.transform=css([...u,0,...w.map(x=>-x),0,...n,0,...n.map(x=>x*k),1]);
      for(let i=0;i<9;i++){
        const row=1-Math.floor(i/3),col=i%3-1,d=n.map((x,a)=>x+col*u[a]+row*w[a]) as V3,label=describe(d,names),center=i===4;
        const cell=el(center?'button':'div',f);cell.dataset.view=d.join();cell.title=label;
        if(center){(cell as HTMLButtonElement).type='button';this.buttons.push([cell,n]);cell.textContent=names[face];cell.setAttribute('aria-label',label+' view');}
        else cell.setAttribute('aria-hidden','true');
      }
    }
    if(projection){
      const t=this.toggle=el('button',root,'mvc-projection');t.type='button';t.dataset.projection='';t.setAttribute('aria-label','Orthographic projection');this.showProjection();
    }
    root.addEventListener('click',this.onClick);root.addEventListener('keydown',this.onKey);
    // Absolute placement needs a positioned container; restored on dispose.
    this.position=container.style.position;
    if(!this.position&&doc.defaultView?.getComputedStyle(container).position==='static')container.style.position='relative';
    engine.use({name:this.name,setup(){},onPreUpdate:(delta:number)=>this.update(delta),
      // After every control has moved the camera, so the cube never lags a frame.
      registerPasses:(graph:FrameGraph)=>{graph.add({name:this.name+':sync',order:10000,execute:()=>this.sync()});},
      dispose:()=>this.dispose()} as Parameters<EngineKernel['use']>[0]);
    this.sync();
  }

  /** Animates to a view (`duration` 0 jumps). The target and distance stay; vertical views keep -Z (top) or +Z (bottom) up. */
  view(view:View,duration=this.duration):void {
    const d=typeof view==='string'?(view==='iso'?[1,1,1]:FACES[view]?.[0]):view;
    if(!d||d.length!==3||!d.every(Number.isFinite)||!Math.hypot(...d))throw new RangeError('Invalid view');
    this.orbit(...angles(d),duration);
  }
  /** Current projection mode, or undefined without a projection. */
  getProjection():Projection|undefined {return this.projection?.mode;}
  setProjection(mode:Projection):void {
    if(!this.projection)throw new Error('ViewCube was created without a projection');
    if(mode!=='orthographic'&&mode!=='perspective')throw new RangeError('Invalid projection');
    this.projection.mode=mode;this.showProjection();
  }
  /** Advances the animation; the engine calls it before each frame. */
  update(delta:number):void {
    const a=this.animation,c=this.camera;
    // Another control moved the camera: it wins.
    if(!a||a.at&&Math.hypot(...c.position.map((x,i)=>x-a.at![i]))>1e-6*a.radius){this.animation=undefined;this.pole();return;}
    const t=a.duration?Math.min(1,(a.elapsed+=Math.max(0,delta))/a.duration):1,s=t*t*(3-2*t),theta=a.theta+a.dTheta*s;
    a.at=this.place(theta,a.phi+a.dPhi*s,a.radius);this.pole(theta);
    if(t===1)this.animation=undefined;
  }
  /** True while a view change is animating. */
  get animating():boolean {return !!this.animation;}
  /** Turns the cube to the camera; called after each frame's updates. */
  sync():void {
    if(this.disposed)return;
    const c=this.camera,z=c.position.map((x,i)=>x-c.target[i]),l=Math.hypot(...z);if(!l)return;
    // Core's view rotation: right = up x back, then up' = back x right (camera.up is +Y unless an app changed it).
    const [zx,zy,zz]=z.map(x=>x/l),u=c.up??[0,1,0],r=[u[1]*zz-u[2]*zy,u[2]*zx-u[0]*zz,u[0]*zy-u[1]*zx],s=Math.hypot(...r);
    const [xx,xy,xz]=s?r.map(x=>x/s):[1,0,0],yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
    // Rows (right, up, back) with y flipped for CSS: the columns are the images of world X, Y and Z.
    const m=css([xx,-yx,zx,0,xy,-yy,zy,0,xz,-yz,zz,0,0,0,0,1]);
    if(m===this.last)return;this.cube.style.transform=this.last=m;
    // Only faces turned toward the viewer take keyboard focus (screen readers still reach all six).
    for(const [button,n] of this.buttons)button.tabIndex=n[0]*zx+n[1]*zy+n[2]*zz>0.05?0:-1;
  }
  dispose():void {
    if(this.disposed)return;this.disposed=true;this.animation=undefined;
    // Give back the up it set; a vertical camera moves 1e-6 rad off the pole (same image) so core accepts that up.
    const c=this.camera;
    if(this.upSet&&c.up===this.upSet){const [theta,phi]=this.current(),d=c.position.map((x,i)=>x-c.target[i]);c.up=this.upPrev!;if(!d[0]&&!d[2])this.place(theta,phi?Math.PI-1e-6:1e-6,Math.hypot(...d));}
    this.element.removeEventListener('click',this.onClick);this.element.removeEventListener('keydown',this.onKey);this.element.remove();
    this.container.style.position=this.position;
    if(!this.engine.disposed&&this.engine.hasPlugin(this.name))this.engine.removePlugin(this.name);
  }

  /** Moves the camera to azimuth theta and polar angle phi around the target; near the poles exactly onto them. */
  private place(theta:number,phi:number,r:number):V3 {
    const p=this.camera.target,pole=phi<POLE?1:phi>Math.PI-POLE?-1:0;
    return this.camera.position=pole?[p[0],p[1]+pole*r,p[2]]:[p[0]+r*Math.sin(phi)*Math.sin(theta),p[1]+r*Math.cos(phi),p[2]+r*Math.sin(phi)*Math.cos(theta)];
  }
  /**
   * Core rejects an up parallel to the view. On an exactly vertical view the cube sets camera.up to the screen up the
   * view had on its way to the pole (azimuth theta), and puts the previous up back once the camera leaves the pole. An up
   * it did not set that already works (a CameraProjection's vertical up) is left alone.
   */
  private pole(theta?:number):void {
    const c=this.camera,d=c.position.map((x,i)=>x-c.target[i]);
    if(this.upSet&&c.up!==this.upSet)this.upSet=undefined;
    if(d[0]||d[2]||!d[1]){if(this.upSet){c.up=this.upPrev!;this.upSet=undefined;}return;}
    if(theta===undefined||!this.upSet&&Math.hypot(c.up[0],c.up[2]))return;
    if(!this.upSet)this.upPrev=c.up;
    const k=Math.sign(d[1]);c.up=this.upSet=[-k*Math.sin(theta),0,-k*Math.cos(theta)];
  }
  /** Azimuth and polar angle of the camera; on the pole the azimuth comes from camera.up (the screen up). */
  private current():[number,number] {
    const c=this.camera,d=c.position.map((x,i)=>x-c.target[i]),u=c.up,a=angles(d);
    if(!d[0]&&!d[2]&&d[1]&&Math.hypot(u[0],u[2]))a[0]=d[1]>0?Math.atan2(-u[0],-u[2]):Math.atan2(u[0],u[2]);
    return a;
  }
  private orbit(theta:number,phi:number,duration:number):void {
    const c=this.camera,offset=c.position.map((x,i)=>x-c.target[i]),[t0,p0]=this.current();
    c.cancelFit?.();
    this.animation={theta:t0,phi:p0,dTheta:((theta-t0)%(2*Math.PI)+3*Math.PI)%(2*Math.PI)-Math.PI,dPhi:phi-p0,radius:Math.hypot(...offset),elapsed:0,duration};
    if(!duration)this.update(0);
  }
  private showProjection():void {const t=this.toggle!,ortho=this.projection!.mode==='orthographic';t.textContent=ortho?'Ortho':'Persp';t.setAttribute('aria-pressed',String(ortho));}
  private readonly onClick=(event:Event):void=>{
    const target=(event.target as HTMLElement|null)?.closest?.('[data-view],[data-projection]') as HTMLElement|null;if(!target)return;
    if(target.dataset.view)this.view(target.dataset.view.split(',').map(Number) as V3);
    else this.setProjection(this.projection!.mode==='orthographic'?'perspective':'orthographic');
  };
  private readonly onKey=(event:KeyboardEvent):void=>{
    const [theta,phi]=this.current(),snap=(x:number)=>Math.round(x/STEP)*STEP;
    switch(event.key){
      case 'ArrowLeft':this.orbit(snap(theta)-STEP,phi,this.duration);break;
      case 'ArrowRight':this.orbit(snap(theta)+STEP,phi,this.duration);break;
      case 'ArrowUp':this.orbit(theta,Math.max(0,snap(phi)-STEP),this.duration);break;
      case 'ArrowDown':this.orbit(theta,Math.min(Math.PI,snap(phi)+STEP),this.duration);break;
      case 'Home':this.view('iso');break;
      default:return;
    }
    event.preventDefault();
  };
}
