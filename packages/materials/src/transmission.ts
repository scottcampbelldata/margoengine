import type {TransmissionPassOptions} from './transmission-pass.js';
export {Transmission, type TransmissionPassOptions} from './transmission-pass.js';
import {textureCoordinates, type MaterialExtension} from '@margoengine/gltf-pro';
import {coordinateSlot,coordinateWGSL} from './coordinates.js';
import type {ClearcoatTexture} from './index.js';
import {transmissionShader} from './transmission-shader.js';

export interface VolumeOptions {
  thicknessFactor?:number;
  thicknessTexture?:ClearcoatTexture;
  attenuationColor?:readonly [number,number,number];
  attenuationDistance?:number;
}
export interface TransmissionOptions extends TransmissionPassOptions {
  factor?:number;
  ior?:number;
  opaqueColor?:GPUTextureView;
  transmissionTexture?:ClearcoatTexture;
  volume?:VolumeOptions;
}
export function transmissionScalar(value:unknown,fallback:number,label:string,min=0,max=Infinity):number {
  const n=value===undefined?fallback:value;
  if(typeof n!=='number'||!Number.isFinite(Math.fround(n))||n<min||n>max)throw new RangeError('Invalid transmission '+label);
  return n;
}
export function validateTransmission(options:TransmissionOptions):{factor:number;ior:number;thickness:number;inverseDistance:number;color:readonly number[]} {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('Invalid transmission options');
  const factor=transmissionScalar(options.factor,0,'factor',0,1),ior=transmissionScalar(options.ior,1.5,'IOR',1);
  const volume=options.volume;
  if(volume!==undefined&&(!volume||typeof volume!=='object'||Array.isArray(volume)))throw new TypeError('Invalid KHR_materials_volume');
  if(volume&&factor===0)throw new Error('KHR_materials_volume requires transmission');
  const thickness=transmissionScalar(volume?.thicknessFactor,0,'thickness');
  const color=volume?.attenuationColor===undefined?[1,1,1]:volume.attenuationColor;
  if(!Array.isArray(color)||color.length!==3||color.some(c=>typeof c!=='number'||!Number.isFinite(c)||c<0||c>1))throw new RangeError('Invalid volume attenuation color');
  const distance=volume?.attenuationDistance===undefined?Infinity:volume.attenuationDistance;
  if(typeof distance!=='number'||distance<=0||Number.isNaN(distance))throw new RangeError('Invalid volume attenuation distance');
  const inverseDistance=distance===Infinity?0:1/distance;
  if(!Number.isFinite(Math.fround(inverseDistance)))throw new RangeError('Volume attenuation distance is too small');
  return {factor,ior,thickness,inverseDistance,color};
}
function validateMap(map:ClearcoatTexture):void {
  if(!map||typeof map!=='object'||!map.view||map.texCoord!==undefined&&map.texCoord!==0&&map.texCoord!==1||map.sampler!==undefined&&!map.sampler)throw new TypeError('Invalid transmission texture or UV set');
  textureCoordinates({texCoord:map.texCoord,extensions:{KHR_texture_transform:map.transform}});
}
/** The base extension (if any) is retained, so clearcoat and transmission share one slot. */
export function createTransmission(options:TransmissionOptions={},base?:MaterialExtension):MaterialExtension {
  const values=validateTransmission(options);
  if(options.transmissionTexture!==undefined)validateMap(options.transmissionTexture);
  if(options.volume?.thicknessTexture!==undefined)validateMap(options.volume.thicknessTexture);
  if(values.factor===0)return base??{};
  if(!options.opaqueColor)throw new TypeError('Transmission requires an opaqueColor view or materials.install(model)');
  const factorsIndex=(base?.factors?.length??0)/4,textures=[...(base?.textures??[])],opaque=textures.length;
  const factors=[...(base?.factors??[]),values.factor,values.ior,values.thickness,values.inverseDistance,...values.color,0];
  textures.push({view:options.opaqueColor});
  const slot=(map?:ClearcoatTexture)=>{
    if(!map)return undefined;
    const index=textures.length;textures.push({view:map.view,...(map.sampler?{sampler:map.sampler}:{})});
    return {index,...coordinateSlot(map,factors),sampler:!!map.sampler};
  };
  const factor=slot(options.transmissionTexture),thickness=slot(options.volume?.thicknessTexture);
  const shader=transmissionShader({opaque,factor,thickness,factorsIndex});
  const helper=(factor?.transformIndex!==undefined||thickness?.transformIndex!==undefined)&&!base?.declarations?.includes('fn materialUV(')?coordinateWGSL:'';
  return {...base,...shader,declarations:(base?.declarations??'')+'\n'+helper+shader.declarations,
    factors:Float32Array.from(factors),textures,lighting:false};
}

/** Caller-owned screen capture. Set the primitive material's settings[0] to 2 for blending. */
export function transmission(options:TransmissionOptions={}):MaterialExtension {return createTransmission(options);}
