import type {VoxelTraceScene} from '@margoengine/voxel-pathtracer';
import type {MeshTraceScene} from './mesh.js';
import type {TraceGeometryBuilder} from './compose-types.js';
import {TraceMeshBuilder} from './mesh-instances.js';
import {meshKernel} from './mesh-build.js';
import {snapshotSpots,appendSpots} from './mesh-lights.js';

/** Optional light metadata over the existing shared geometry builder. */
export class MeshLightingBuilder implements TraceGeometryBuilder {
  #base:TraceGeometryBuilder;
  constructor(base:TraceGeometryBuilder=new TraceMeshBuilder()){this.#base=base;}
  async build(input:VoxelTraceScene,signal?:AbortSignal):Promise<Uint32Array>{
    signal?.throwIfAborted();const scene=input as MeshTraceScene;
    const spots=snapshotSpots(scene.spotLights),emission=new Float32Array(1024);
    let emissive=false;
    for(const m of scene.materials){
      const strength=m.emission??(m.type==='emit'?1:0),rgb=m.emissionColor??m.color;
      if(strength>0&&rgb?.some(c=>c>0)){emissive=true;if(m.id>=1&&m.id<256)emission.set([...rgb.map(c=>c*strength),0],m.id*4);}
    }
    const pbr=(scene as MeshTraceScene&{pbrMaterials?:unknown[]}).pbrMaterials!==undefined;
    if(!emissive&&!spots.length&&!pbr)return this.#base.build(scene,signal);
    const normalized=scene.meshInstances===undefined?{...scene,meshInstances:scene.meshes.map(m=>({id:m.id,mesh:m.id}))}:scene;
    const geometry=await this.#base.build(normalized,signal),k=await meshKernel(signal),size=1025+geometry.length,p=k.allocate(size);
    let lights:Uint32Array;
    try{
      const words=new Uint32Array(k.memory.buffer,p,size);words[0]=geometry.length;words.set(new Uint32Array(emission.buffer),1);words.set(geometry,1025);
      const code=k.build_lights(p,size);if(code)throw new RangeError(`Mesh emitter packet is invalid or exceeds 128 MiB (${code}); check meshes and pass fewer instances`);
      lights=new Uint32Array(k.memory.buffer,k.output_ptr(),k.output_len()).slice();
    }finally{k.release(p,size);}
    // Retain the complete proposal schedule in the feature-local light header.
    lights[lights[12]!+4]=7;
    signal?.throwIfAborted();return appendSpots(lights,spots);
  }
  dispose():void{this.#base.dispose();}
}
