import {meshRuntime} from '@scottcampbelldata/vexel-core/extension';
import type {Mesh as MeshHandle} from '@scottcampbelldata/vexel-core';
import type {Engine,EnginePlugin,Mesh,Vec3} from '@scottcampbelldata/vexel-core/extension';
export interface Joint {node:MeshHandle;axis:'x'|'y'|'z';kind?:'revolute'|'prismatic';min:number;max:number;velocity?:number}
export interface GearCoupling {source:number;target:number;ratio:number;offset?:number}
export interface PistonCoupling {source:number;target:number;radius:number;rodLength:number;phase?:number;offset?:number}
export interface IKTarget {node:MeshHandle;target:Vec3;point?:Vec3}
export interface DistanceConstraint {a:MeshHandle;b:MeshHandle;length:number;pointA?:Vec3;pointB?:Vec3}
export interface KinematicOptions {gears?:readonly GearCoupling[];pistons?:readonly PistonCoupling[];targets?:readonly IKTarget[];distances?:readonly DistanceConstraint[];iterations?:number;tolerance?:number;damping?:number}
const zero:Vec3=[0,0,0];
const finite=(value:number)=>typeof value==='number'&&Number.isFinite(Math.fround(value));
function vector(value:Vec3):void {if(value.length!==3||!value.every(finite))throw new TypeError('Invalid constraint point');}
function point(node:MeshHandle,p:Vec3):number[]{node.check();vector(p);const m=meshRuntime(node).matrix;return [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];}

export class Kinematics implements EnginePlugin {
  readonly name='kinematics';readonly result={converged:true,error:0,iterations:0};
  private engine?:Engine;private origins:number[]=[];private driven=new Set<number>();private order:Array<GearCoupling|PistonCoupling>=[];
  private readonly iterations:number;private readonly tolerance:number;private readonly damping:number;
  private readonly joints:readonly (Omit<Joint,'node'>&{node:Mesh})[];
  private readonly previous:Float64Array;
  private values:Float32Array[]=[];private readonly offsets:Int32Array;
  constructor(joints:readonly Joint[],readonly options:KinematicOptions={}) {
    this.joints=joints.map(joint=>({...joint,node:meshRuntime(joint.node)}));
    this.previous=new Float64Array(joints.length);this.offsets=new Int32Array(joints.length);
    this.iterations=options.iterations??24;this.tolerance=options.tolerance??1e-3;this.damping=options.damping??0.01;
    if(joints.length>1024||(options.targets?.length||options.distances?.length)&&joints.length>32||!Number.isSafeInteger(this.iterations)||this.iterations<1||this.iterations>100||!finite(this.tolerance)||this.tolerance<=0||!finite(this.damping)||this.damping<=0||(options.targets?.length??0)+(options.distances?.length??0)>64)throw new RangeError('Invalid solver limits');
  }
  setup(engine:Engine):void {
    const seen=new Map<Mesh,Set<string>>();
    for(const joint of this.joints){joint.node.check();const axes=seen.get(joint.node)??new Set<string>();
      if(joint.node.engine!==engine||!['x','y','z'].includes(joint.axis)||!['revolute','prismatic'].includes(joint.kind??'revolute')||![joint.min,joint.max,joint.velocity??0].every(finite)||joint.min>joint.max||axes.has((joint.kind??'revolute')+joint.axis))throw new TypeError('Invalid joint');axes.add((joint.kind??'revolute')+joint.axis);seen.set(joint.node,axes);}
    const pending=[...(this.options.gears??[]),...(this.options.pistons??[])];this.driven.clear();this.order=[];
    for(const c of pending){if(!Number.isSafeInteger(c.source)||!Number.isSafeInteger(c.target)||!this.joints[c.source]||!this.joints[c.target]||c.source===c.target||this.driven.has(c.target)||!finite(c.offset??0))throw new TypeError('Invalid coupling');
      if('ratio'in c){if(!finite(c.ratio)||c.ratio===0)throw new TypeError('Invalid gear ratio');}
      else if(!finite(c.radius)||!finite(c.rodLength)||c.radius<=0||c.rodLength<=c.radius||!finite(c.phase??0)||this.joints[c.source].kind==='prismatic'||this.joints[c.target].kind!=='prismatic')throw new TypeError('Invalid slider-crank linkage');this.driven.add(c.target);}
    while(pending.length){const at=pending.findIndex(c=>!this.driven.has(c.source)||this.order.some(previous=>previous.target===c.source));if(at===-1)throw new Error('Coupling cycle');this.order.push(pending.splice(at,1)[0]);}
    const check=(node:MeshHandle)=>{node.check();if(meshRuntime(node).engine!==engine)throw new TypeError('Constraint node belongs to another engine');};
    for(const target of this.options.targets??[]){check(target.node);vector(target.target);vector(target.point??zero);}
    for(const distance of this.options.distances??[]){check(distance.a);check(distance.b);vector(distance.pointA??zero);vector(distance.pointB??zero);if(!finite(distance.length)||distance.length<0)throw new TypeError('Invalid distance constraint');}
    this.origins=this.joints.map(joint=>joint.node.position[joint.axis]);this.values=this.joints.map((joint,i)=>{this.offsets[i]=joint.kind==='prismatic'?joint.node.id:'xyz'.indexOf(joint.axis);return joint.kind==='prismatic'?engine.store.transforms[joint.axis]:joint.node.euler;});this.engine=engine;
    this.joints.forEach((joint,i)=>{const axis='xyz'.indexOf(joint.axis)+(joint.kind==='prismatic'?0:3),id=joint.node.id,offset=joint.kind==='prismatic'?this.origins[i]:0;engine.store.limits.set([joint.min+offset,joint.max+offset],id*12+axis*2);engine.store.constrained[id]|=1<<axis;});
  }
  value(index:number):number {const joint=this.joints[index];if(!joint||!this.engine)throw new Error('Joint is not attached');joint.node.check();return this.values[index][this.offsets[index]]-(joint.kind==='prismatic'?this.origins[index]:0);}
  private assign(index:number,value:number):void {const joint=this.joints[index];joint.node.check();const stored=value+(joint.kind==='prismatic'?this.origins[index]:0);if(!finite(stored))throw new RangeError('Invalid joint value');this.values[index][this.offsets[index]]=stored;}
  private write(index:number,value:number):void {const joint=this.joints[index];this.assign(index,Math.max(joint.min,Math.min(joint.max,value)));}
  private snapshot():void {for(let i=0;i<this.joints.length;i++){const joint=this.joints[i];joint.node.check();this.previous[i]=this.values[i][this.offsets[i]]-(joint.kind==='prismatic'?this.origins[i]:0);}}
  private restore():void {for(let i=0;i<this.joints.length;i++)this.assign(i,this.previous[i]);}
  setValue(index:number,value:number):void {const joint=this.joints[index];if(!joint||!this.engine||!finite(value)||value<joint.min||value>joint.max||this.driven.has(index))throw new RangeError('Joint value exceeds limits or is coupled');this.snapshot();try{this.write(index,value);this.couple();}catch(error){this.restore();throw error;}}
  setAngle(index:number,angle:number):void {if(this.joints[index]?.kind==='prismatic')throw new TypeError('Prismatic joints use setValue');this.setValue(index,angle);}
  private couple():void {for(let i=0;i<this.order.length;i++){const c=this.order[i],source=this.values[c.source][this.offsets[c.source]]-(this.joints[c.source].kind==='prismatic'?this.origins[c.source]:0),value='ratio'in c?source*c.ratio+(c.offset??0):c.radius*Math.cos(source+(c.phase??0))+Math.sqrt(c.rodLength**2-c.radius**2*Math.sin(source+(c.phase??0))**2)+(c.offset??0);
    if(value<this.joints[c.target].min-1e-6||value>this.joints[c.target].max+1e-6)throw new RangeError('Coupling exceeds target joint limits');this.write(c.target,value);}}
  private residual():number[] {this.engine!.store.tick(false);const values:number[]=[];
    for(const target of this.options.targets??[]){vector(target.target);const actual=point(target.node,target.point??zero);for(let i=0;i<3;i++)values.push(actual[i]-target.target[i]);}
    for(const c of this.options.distances??[]){const a=point(c.a,c.pointA??zero),b=point(c.b,c.pointB??zero);values.push(Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])-c.length);}return values;}
  solve():typeof this.result {
    if(!this.engine)throw new Error('Kinematics is not attached');const variables=this.joints.map((_,i)=>i).filter(i=>!this.driven.has(i)),n=variables.length;
    this.snapshot();this.couple();let residual=this.residual(),error=Math.hypot(...residual),iteration=0;
    for(;iteration<this.iterations&&error>this.tolerance&&n;iteration++){
      const previous=variables.map(i=>this.value(i)),jacobian=Array.from({length:residual.length},()=>new Float64Array(n));
      for(let j=0;j<n;j++){const id=variables[j],joint=this.joints[id],step=previous[j]+1e-3<=joint.max?1e-3:-1e-3;
        try{this.write(id,previous[j]+step);this.couple();const change=this.value(id)-previous[j],next=this.residual();if(change!==0)for(let r=0;r<residual.length;r++)jacobian[r][j]=(next[r]-residual[r])/change;}catch(error){if(!(error instanceof RangeError))throw error;}finally{this.write(id,previous[j]);this.couple();}}
      const system=Array.from({length:n},()=>new Float64Array(n+1));
      for(let a=0;a<n;a++){for(let b=0;b<n;b++)system[a][b]=jacobian.reduce((sum,row)=>sum+row[a]*row[b],a===b?this.damping**2:0);system[a][n]=-jacobian.reduce((sum,row,r)=>sum+row[a]*residual[r],0);}
      for(let a=0;a<n;a++){const pivot=system[a][a];for(let b=a;b<=n;b++)system[a][b]/=pivot;for(let row=0;row<n;row++)if(row!==a){const factor=system[row][a];for(let b=a;b<=n;b++)system[row][b]-=factor*system[a][b];}}
      let accepted=false;
      const scale=Math.min(1,0.5/Math.max(...system.map(row=>Math.abs(row[n]))));
      for(const gain of [1,0.5,0.25,0.1]){try{for(let j=0;j<n;j++)this.write(variables[j],previous[j]+system[j][n]*scale*gain);this.couple();const next=this.residual(),nextError=Math.hypot(...next);if(nextError<error){residual=next;error=nextError;accepted=true;break;}}catch(error){if(!(error instanceof RangeError))throw error;}}
      if(!accepted){for(let j=0;j<n;j++)this.write(variables[j],previous[j]);this.couple();this.engine.store.tick(false);break;}
    }
    Object.assign(this.result,{converged:error<=this.tolerance,error,iterations:iteration});return this.result;
  }
  onPreUpdate(delta:number):void {if(!Number.isFinite(delta)||delta<0||delta>1)throw new RangeError('Frame delta must be 0..1 seconds');this.snapshot();try{for(let i=0;i<this.joints.length;i++)if(!this.driven.has(i))this.write(i,this.previous[i]+(this.joints[i].velocity??0)*delta);this.couple();}catch(error){this.restore();throw error;}if(this.options.targets?.length||this.options.distances?.length)this.solve();}
  dispose():void {if(this.engine&&!this.engine.disposed)for(const joint of this.joints)if(this.engine.meshes.get(joint.node.id)===joint.node)this.engine.store.constrained[joint.node.id]&=~(1<<('xyz'.indexOf(joint.axis)+(joint.kind==='prismatic'?0:3)));this.engine=undefined;this.origins=[];this.values=[];this.order=[];this.driven.clear();}
}
