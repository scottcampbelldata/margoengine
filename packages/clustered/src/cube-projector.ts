import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { ProjectorLights, type ProjectorImage, type ProjectorLightOptions } from './projector.js';
/** Six equal square RGBA8 faces, ordered +X, -X, +Y, -Y, +Z, -Z; rows run top to bottom. */
export interface CubeProjectorImage { readonly faces: readonly [ProjectorImage, ProjectorImage, ProjectorImage, ProjectorImage, ProjectorImage, ProjectorImage]; }
/** Point-light cookie and optional emitter-to-world orientation. */
export interface CubeProjectorEntry {
  /** Six-face image; pixels are copied when setCubes is called. */
  image: CubeProjectorImage;
  /** Byte encoding, default sRGB. Decode precedes filtering. */
  colorSpace?: 'srgb' | 'linear';
  /** Emitter-to-world quaternion [x,y,z,w], normalized on input; default identity. */
  rotation?: readonly [number, number, number, number];
}
/** Maximum distinct cubemaps per call. */
export const MAX_CUBE_PROJECTORS = 16;
/** Maximum combined face texels, 64 MiB of RGBA8. */
export const MAX_CUBE_PROJECTOR_TEXELS = 1 << 24;
const HEADER = 4 + MAX_CUBE_PROJECTORS * 4;
const sampling=(group:number)=>/* wgsl */`
// The cube block follows the spot words in clusterProjectorData (binding 143); its header.z is the block's first word.
fn cubeWord(i:u32)->u32{return clusterProjectorData.words[clusterProjectorData.header.z+i];}
fn cubeImage(i:u32)->vec4u{let a=4u+i*4u;return vec4u(cubeWord(a),cubeWord(a+1u),cubeWord(a+2u),cubeWord(a+3u));}
fn cubeData(i:u32)->u32{return cubeWord(${HEADER}u+i);}
fn cubeCookieCoord(d:vec3f)->vec3f {
 let a=abs(d);var f=0.0;var p=vec2f(0);var m=a.x;
 if(a.x>=a.y&&a.x>=a.z){if(d.x>=0.0){p=vec2f(-d.z,-d.y);}else{f=1.0;p=vec2f(d.z,-d.y);}}
 else if(a.y>=a.z){m=a.y;if(d.y>=0.0){f=2.0;p=vec2f(d.x,d.z);}else{f=3.0;p=vec2f(d.x,-d.z);}}
 else{m=a.z;if(d.z>=0.0){f=4.0;p=vec2f(d.x,-d.y);}else{f=5.0;p=vec2f(-d.x,-d.y);}}
 return vec3f(p/max(m,1e-30)*0.5+0.5,f);
}
fn cubeCookieDirection(face:u32,p:vec2f)->vec3f {
 switch(face){case 0u:{return vec3f(1,-p.y,-p.x);}case 1u:{return vec3f(-1,-p.y,p.x);}
 case 2u:{return vec3f(p.x,1,p.y);}case 3u:{return vec3f(p.x,-1,-p.y);}
 case 4u:{return vec3f(p.x,-p.y,1);}default:{return vec3f(-p.x,-p.y,-1);}}
}
fn cubeCookieDecoded(image:vec4u,coord:vec3f)->vec3f {
 let pixel=clamp(vec2i(coord.xy*f32(image.y)),vec2i(0),vec2i(i32(image.y)-1));
 let packed=cubeData(image.x+u32(coord.z)*image.y*image.y+u32(pixel.y)*image.y+u32(pixel.x));let c=unpack4x8unorm(packed);
 let rgb=select(c.rgb,select(c.rgb/12.92,pow((c.rgb+0.055)/1.055,vec3f(2.4)),c.rgb>vec3f(0.04045)),image.z==1u);return rgb*c.a;
}
fn cubeCookieTexel(image:vec4u,face:u32,p:vec2i)->vec3f {
 var f=face;var pixel=p;let side=i32(image.y);
 let outside=vec2<bool>(p.x<0||p.x>=side,p.y<0||p.y>=side);
 if(all(outside)){let corner=cubeCookieDirection(face,sign((vec2f(p)+0.5)/f32(side)*2-1));
 return (cubeCookieDecoded(image,cubeCookieCoord(corner*vec3f(2,1,1)))+cubeCookieDecoded(image,cubeCookieCoord(corner*vec3f(1,2,1)))+
 cubeCookieDecoded(image,cubeCookieCoord(corner*vec3f(1,1,2))))/3.0;}
 if(any(pixel<vec2i(0))||any(pixel>=vec2i(side))){let mapped=cubeCookieCoord(cubeCookieDirection(face,(vec2f(pixel)+0.5)/f32(side)*2-1));
  f=u32(mapped.z);pixel=clamp(vec2i(mapped.xy*f32(side)),vec2i(0),vec2i(side-1));}
 return cubeCookieDecoded(image,vec3f((vec2f(pixel)+0.5)/f32(side),f32(f)));
}
fn clusterCubeProjector(index:u32,light:ClusterLight,position:vec3f)->vec3f {
 if(index>=cubeWord(0u)||light.params.y>=0.5){return vec3f(1);}let at=index*8u;let id=cubeData(at);
 if(id==0u){return vec3f(1);}let image=cubeImage(id-1u);let world=position-light.positionRange.xyz;
 if(dot(world,world)<1e-30){return vec3f(1);}
 let q=vec4f(bitcast<f32>(cubeData(at+4u)),bitcast<f32>(cubeData(at+5u)),bitcast<f32>(cubeData(at+6u)),bitcast<f32>(cubeData(at+7u)));
 let v=-q.xyz;let d=world+2.0*cross(v,cross(v,world)+q.w*world);let coord=cubeCookieCoord(d);let face=u32(coord.z);
 let t=coord.xy*f32(image.y)-0.5;let p=vec2i(floor(t));let f=fract(t);
 return mix(mix(cubeCookieTexel(image,face,p),cubeCookieTexel(image,face,p+vec2i(1,0)),f.x),
 mix(cubeCookieTexel(image,face,p+vec2i(0,1)),cubeCookieTexel(image,face,p+vec2i(1,1)),f.x),f.y);
}`;
/**
 * ProjectorLights superset: spot images through setProjectors and point cubemaps through setCubes share one light
 * term. Cube filtering crosses face edges, decodes sRGB and multiplies alpha. Point cookies follow emitter rotation.
 * Up to 16 distinct cubes and 1024 indexed entries; empty cookies add no light hook. Imported only from this entry.
 */
export class CubeProjectorLights extends ProjectorLights {
  /** Per-light product for coexisting spot and cube images. */
  override readonly term='clusterProjector(index,light,position)*clusterCubeProjector(index,light,position)';
  private cubeWords=new Uint32Array(HEADER);
  private cubesActive=false;
  private cubesDisposed=false;
  private cubesList:readonly (CubeProjectorImage|CubeProjectorEntry|null|undefined)[]=[];
  /** Attach spot and cube cookies to one clustered light list. */
  static override attach(instance:EngineKernel,options:ProjectorLightOptions):CubeProjectorLights {
    const effect=new CubeProjectorLights(options);engineRuntime(instance).use(effect);return effect;
  }
  /** Last cube entries, as a frozen list. */
  get cubes():readonly (CubeProjectorImage|CubeProjectorEntry|null|undefined)[]{return this.cubesList;}
  /** Replace cube cookies atomically; entry i modulates point light i, while spot lights ignore cube entries. */
  setCubes(entries:readonly (CubeProjectorImage|CubeProjectorEntry|null|undefined)[]):this {
    if(this.cubesDisposed)throw new MargoError('disposed','CubeProjectorLights is disposed; create a new effect');
    if(!Array.isArray(entries)||entries.length>1024)throw new RangeError('Pass at most 1024 cube entries, one per clustered light');
    const images:{image:CubeProjectorImage;srgb:boolean;side:number}[]=[];let texels=0;
    const values=entries.map(entry=>{
      if(entry==null)return [0,0,0,0,0,0,0,1];
      if(typeof entry!=='object')throw new TypeError('A cube cookie needs six RGBA8 faces; pass an image, an entry or null');
      const options:CubeProjectorEntry='image'in entry?entry:{image:entry},
        {image,colorSpace='srgb',rotation=[0,0,0,1]}=options;
      if(colorSpace!=='srgb'&&colorSpace!=='linear')throw new TypeError('Cube colorSpace must be srgb or linear');
      if(!image||!Array.isArray(image.faces)||image.faces.length!==6)throw new TypeError('A cube needs six faces in +X,-X,+Y,-Y,+Z,-Z order');
      const side=image.faces[0]?.width;
      for(const face of image.faces)if(!face||!Number.isInteger(side)||side<1||side>4096||face.width!==side||face.height!==side||
        !(face.data instanceof Uint8Array||face.data instanceof Uint8ClampedArray)||face.data.length!==side*side*4)
        throw new RangeError('Cube faces must be equal square RGBA8 images, 1..4096 texels per side');
      if(!Array.isArray(rotation)||rotation.length!==4||rotation.some((n:number)=>!Number.isFinite(n))||!(Math.hypot(...rotation)>0))
        throw new RangeError('Cube rotation must be a finite nonzero quaternion [x,y,z,w]');
      const scale=Math.max(...rotation.map(Math.abs)),scaled=rotation.map((n:number)=>n/scale),length=Math.hypot(...scaled),
        q=scaled.map((n:number)=>n/length),srgb=colorSpace==='srgb';
      let id=images.findIndex(known=>known.image===image&&known.srgb===srgb);
      if(id<0){texels+=6*side*side;id=images.push({image,srgb,side})-1;}
      return [id+1,0,0,0,...q];
    });
    if(images.length>MAX_CUBE_PROJECTORS||texels>MAX_CUBE_PROJECTOR_TEXELS)
      throw new RangeError('Cube cookies exceed 16 images or 16777216 total texels; use fewer or smaller cubes');
    const words=new Uint32Array(HEADER+entries.length*8+texels),floats=new Float32Array(words.buffer);
    words[0]=entries.length;words[1]=images.length;
    let offset=entries.length*8;
    images.forEach(({image,srgb,side},i)=>{
      words.set([offset,side,+srgb,0],4+i*4);
      for(const face of image.faces){new Uint8Array(words.buffer,(HEADER+offset)*4,face.data.length).set(face.data);offset+=side*side;}
    });
    values.forEach((v,i)=>{words[HEADER+i*8]=v[0];floats.set(v.slice(4),HEADER+i*8+4);});
    this.storage(images.length?words.length:0,'Cube cookies');
    const installed=this.lights.projector===this,changed=this.cubesActive!==(images.length>0);
    this.cubeWords=words;this.cubesActive=images.length>0;this.setTail(this.cubesActive?words:undefined);this.cubesList=Object.freeze([...entries]);this.sync();
    // Spot images can keep the composite hook installed while its cube declarations/bindings change.
    if(installed&&changed&&this.lights.projector===this)this.lights.projector=this;
    return this;
  }
  /** @internal Cube-only lights still activate the inherited projector upload and light hook. */
  protected override get enabled():boolean{return super.enabled||this.cubesActive;}
  /** Shader declarations for both projector kinds. */
  override declarations(group:number):string{return super.declarations(group)+(this.cubesActive?sampling(group):'\nfn clusterCubeProjector(index:u32,light:ClusterLight,position:vec3f)->vec3f{return vec3f(1);}\n');}
  /** Refuse the small WebGL2 preview before inheriting GPU storage: cube cookies upload through a WebGPU queue. */
  override setup(engine:Engine):void{requireWebGPU(engine,'CubeProjectorLights');super.setup(engine);}
  /** Release both projector hooks and the shared storage. */
  override dispose():void{this.cubesDisposed=true;super.dispose();}
}
