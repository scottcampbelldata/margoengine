import type {Vec3} from '@margoengine/core/extension';
import {VFX,type VFXObstacle,type VFXTexture} from '@margoengine/vfx';
export type WindObstacle=VFXObstacle;
export type ParticleTexture=VFXTexture;
export interface ParticleOptions {count?:number;gravity?:Vec3;wind?:Vec3;size?:number;curl?:number;obstacles?:readonly WindObstacle[];sort?:boolean;texture?:ParticleTexture}
/** A drifting leaf/weather field: a `@margoengine/vfx` preset that keeps `count` particles wrapping inside a 6 m cube. */
export class GPUParticles extends VFX {
 override readonly name='gpu-particles';
 constructor(options:ParticleOptions={}) {
  const {count=5000,gravity=[0,-0.5,0],wind=[0.4,0,0],size=0.035,curl=0}=options;
  if(!Number.isFinite(size)||!(curl>=0&&curl<=10)||gravity.length!==3||wind.length!==3)throw new RangeError('Invalid particle options');
  super({capacity:count,initialCount:count,rate:0,position:[0,0,0],emissionExtent:[3,3,3],wrap:true,velocity:[0,0,0],spread:0,gravity:[gravity[0]+wind[0],gravity[1]+wind[1],gravity[2]+wind[2]],
   turbulence:curl,size:size*2,lifetime:[1e6,1e6],ground:-1e30,bounce:0.5,angularVelocity:1,color:[0.93,0.53,0.17,0.85],obstacles:options.obstacles,sort:options.sort,texture:options.texture});
 }
 get count():number {return this.capacity;}
}
