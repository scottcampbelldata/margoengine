import {textureCoordinates, type TextureTransform} from '@margoengine/gltf-pro';
import type {ClearcoatTextureSlot} from './shader.js';

export const coordinateWGSL='fn materialUV(p:vec2f,a:vec4f,b:vec4f)->vec2f{return vec2f(dot(a.xy,p)+a.z,dot(b.xy,p)+b.z);}\n';
export function coordinateSlot(value:{texCoord?:0|1;transform?:TextureTransform},factors:number[]):Pick<ClearcoatTextureSlot,'texCoord'|'transformIndex'> {
  const parsed=textureCoordinates({texCoord:value.texCoord,extensions:{KHR_texture_transform:value.transform}});
  if(!parsed.transform)return {texCoord:parsed.texCoord};
  const transformIndex=factors.length/4;factors.push(...parsed.transform);return {texCoord:parsed.texCoord,transformIndex};
}
export function coordinateExpression(slot:ClearcoatTextureSlot):string {
  const uv=`uv(i,${slot.texCoord}.0)`;
  return slot.transformIndex===undefined?uv:`materialUV(${uv},materialFactors[${slot.transformIndex}],materialFactors[${slot.transformIndex+1}])`;
}
