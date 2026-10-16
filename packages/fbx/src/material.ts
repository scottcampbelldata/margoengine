import type {MaterialData, TextureData} from '@margoengine/exporters';
import {readResponse} from '../../shared/loading.js';
import {assetURL} from '../../shared/asset-url.js';
import {findChild,id,property,objectName,type FBXNode} from './document.js';
import {children,type SceneContext} from './scene.js';

const limit=64*1024*1024;
export async function attachMaterials(ctx:SceneContext,resourcePath:string,options:{fetch?:typeof fetch;allowedURLs?:readonly string[]}={}):Promise<void>{
  const textures=new Map<bigint,Promise<TextureData>>(),materials=new Map<bigint,Promise<MaterialData>>();let bytes=0;
  const content=(node:FBXNode|undefined):Uint8Array|undefined=>{
    const value=node&&findChild(node,'Content')?.properties[0];
    if(value instanceof Uint8Array)return value;
    if(typeof value==='string'&&value){if(value.length>limit*4/3+4)throw new RangeError('FBX texture byte budget exceeded');try{return Uint8Array.from(atob(value.replace(/\s/g,'')),c=>c.charCodeAt(0));}catch{throw new TypeError('Invalid FBX embedded texture');}}
  };
  const texture=async(source:FBXNode):Promise<TextureData>=>{
    ctx.signal?.throwIfAborted();const videos=children(ctx,id(source.properties[0])).filter(n=>n.name==='Video');
    if(videos.length>1)throw new TypeError('Multiple FBX texture videos');
    const video=videos[0];let image=content(video)??content(source);
    if(!image){
      const raw=String(findChild(source,'RelativeFilename')?.properties[0]??findChild(video??source,'RelativeFilename')?.properties[0]??findChild(source,'FileName')?.properties[0]??findChild(video??source,'Filename')?.properties[0]??'');
      if(!raw)throw new TypeError('Missing FBX texture image');
      const path=raw.replace(/\\/g,'/'),base=resourcePath||globalThis.location?.href;
      let target:URL;try{target=new URL(path,base);}catch{throw new TypeError('FBX texture needs an HTTP(S) resourcePath');}
      if(!['http:','https:'].includes(target.protocol))throw new TypeError('FBX resources need HTTP(S)');
      const url=assetURL(path,base,options.allowedURLs,'FBX texture');
      if(!['http:','https:'].includes(url.protocol))throw new TypeError('FBX resources need HTTP(S)');
      const response=await (options.fetch??fetch)(url,{signal:ctx.signal});image=await readResponse(response,{maxBytes:limit-bytes,signal:ctx.signal,label:'FBX texture'});
    }
    bytes+=image.byteLength;if(bytes>limit)throw new RangeError('FBX texture byte budget exceeded');
    const png=image.length>8&&image[0]===137&&image[1]===80&&image[2]===78&&image[3]===71,jpeg=image.length>3&&image[0]===255&&image[1]===216&&image[2]===255;
    if(!png&&!jpeg)throw new TypeError('FBX textures must be PNG or JPEG');
    return {name:objectName(source),mimeType:png?'image/png':'image/jpeg',image};
  };
  const material=async(source:FBXNode):Promise<MaterialData>=>{
    const scalar=(name:string,fallback:number)=>{const value=Number(property(source,name,fallback));if(!Number.isFinite(value)||value<0||value>1)throw new RangeError(`Invalid FBX material ${name}`);return value;};
    const color=(name:string,fallback:number[])=>{const value=property(source,name,fallback);if(!Array.isArray(value)||value.length!==3||value.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1))throw new RangeError(`Invalid FBX material ${name}`);return value as number[];};
    const shininess=Number(property(source,'Shininess',0));if(!Number.isFinite(shininess)||shininess<0)throw new RangeError('Invalid FBX shininess');
    const explicitOpacity=property(source,'Opacity',undefined),alpha=explicitOpacity===undefined?1-scalar('TransparencyFactor',0):scalar('Opacity',1),factor=scalar('DiffuseFactor',1),diffuse=color('DiffuseColor',property(source,'Diffuse',[1,1,1])),emission=color('EmissiveColor',property(source,'Emissive',[0,0,0])),emissiveFactor=scalar('EmissiveFactor',1);
    const out:MaterialData={name:objectName(source),color:[diffuse[0]*factor,diffuse[1]*factor,diffuse[2]*factor,alpha],emissive:emission.map(v=>v*emissiveFactor),metalness:0,roughness:Math.max(.045,Math.min(1,Math.sqrt(2/(shininess+2)))),alphaMode:alpha<1?'BLEND':'OPAQUE'};
    for(const c of ctx.incoming.get(id(source.properties[0]))??[]){
      if(c.kind!=='OP'||!['DiffuseColor','NormalMap'].includes(c.property??''))continue;
      const t=ctx.document.objects.get(c.child)!;if(t.name!=='Texture')throw new TypeError('Unsupported FBX layered texture');
      let promise=textures.get(c.child);if(!promise){promise=texture(t);textures.set(c.child,promise);}
      const key=c.property==='NormalMap'?'normalTexture':'baseColorTexture';if(out[key])throw new TypeError('Multiple FBX textures on one material property');out[key]=await promise;
    }
    return out;
  };
  for(const mesh of ctx.meshes){
    if(mesh.materialIndex===-1)continue;
    ctx.signal?.throwIfAborted();const sources=children(ctx,id(mesh.model.properties[0])).filter(n=>n.name==='Material');
    if(!sources.length){if(mesh.materialIndex>0)throw new RangeError('FBX material index exceeds model materials');continue;}
    const source=sources[mesh.materialIndex];if(!source)throw new RangeError('FBX material index exceeds model materials');
    const key=id(source.properties[0]);let promise=materials.get(key);if(!promise){promise=material(source);materials.set(key,promise);}mesh.node.material=await promise;
  }
}
