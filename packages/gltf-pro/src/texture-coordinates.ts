import type {MaterialExtension} from './material-extension.js';

/** glTF texture coordinates: scale, then rotation about the origin, then offset. */
export interface TextureTransform {offset?:readonly [number,number];rotation?:number;scale?:readonly [number,number];texCoord?:0|1}
export function textureCoordinates(info:any):{texCoord:0|1;transform?:Float32Array} {
  if(!info||typeof info!=='object'||Array.isArray(info))throw new TypeError('Invalid texture coordinates');
  const value=info?.extensions?.KHR_texture_transform;
  if(value!==undefined&&(!value||typeof value!=='object'||Array.isArray(value)))throw new TypeError('Invalid KHR_texture_transform');
  const coord=value?.texCoord!==undefined?value.texCoord:info.texCoord===undefined?0:info.texCoord;
  if(coord!==0&&coord!==1)throw new RangeError('Texture requires TEXCOORD_0 or TEXCOORD_1');
  if(value===undefined)return {texCoord:coord};
  const pair=(v:any,fallback:number[],label:string):number[]=>{
    if(v===undefined)return fallback;
    if(!Array.isArray(v)||v.length!==2||Array.from(v).some(n=>typeof n!=='number'||!Number.isFinite(Math.fround(n))))throw new TypeError('Invalid texture transform '+label);
    return v;
  };
  const offset=pair(value.offset,[0,0],'offset'),scale=pair(value.scale,[1,1],'scale'),rotation=value.rotation===undefined?0:value.rotation;
  if(typeof rotation!=='number'||!Number.isFinite(Math.fround(rotation)))throw new TypeError('Invalid texture transform rotation');
  if(rotation===0&&offset[0]===0&&offset[1]===0&&scale[0]===1&&scale[1]===1)return {texCoord:coord};
  // UVs have a top-left origin. Match Khronos Sample Renderer and the authored
  // TextureTransformMultiTest reference UVs (column-major R = [c,-s,s,c]).
  const c=Math.cos(rotation),s=Math.sin(rotation),transform=new Float32Array([c*scale[0],s*scale[1],offset[0],0,-s*scale[0],c*scale[1],offset[1],0]);
  return {texCoord:coord,transform};
}
export const textureTransformWGSL='fn materialUV(p:vec2f,a:vec4f,b:vec4f)->vec2f{return vec2f(dot(a.xy,p)+a.z,dot(b.xy,p)+b.z);}\n';
const baseCoords=['f.coordsA.x','f.coordsA.y','f.coordsA.z','f.coordsA.w','f.coordsB.x'];
export interface CoordinateExtension {extension:MaterialExtension;source?:MaterialExtension;length:number;transforms:readonly (Float32Array|undefined)[]}

/** Append affine rows to the optional slot without changing caller-owned factors. */
export function coordinateExtension(maps:readonly any[],source?:MaterialExtension,previous?:CoordinateExtension):CoordinateExtension|undefined {
  if(!maps.some(map=>map?.extensions?.KHR_texture_transform!==undefined))return undefined;
  const transforms=maps.map(map=>map?.extensions?.KHR_texture_transform===undefined?undefined:textureCoordinates(map).transform);
  if(!transforms.some(Boolean))return undefined;
  const length=source?.factors?.length??0;
  // Keep validation of caller factors identical, even when combining coordinate rows.
  if(source?.factors!==undefined&&(!(source.factors instanceof Float32Array)||!length||length%4||source.factors.some(v=>!Number.isFinite(v))))throw new TypeError('Material extension factors require finite vec4 values');
  let cached=previous;
  if(!cached||cached.source!==source||cached.length!==length||transforms.some((t,i)=>!!t!==!!cached!.transforms[i])){
    const factors=new Float32Array(length+transforms.filter(Boolean).length*8);
    cached={extension:{...source,factors},source,length,transforms};
  }
  const extension=cached.extension,factors=extension.factors!;
  // Hooks, factors and views remain editable after installation.
  Object.assign(extension,source);extension.factors=factors;
  for(const key of ['wgsl','direct','output','lighting','declarations','textures'] as const)if(source?.[key]===undefined)delete extension[key];
  if(source?.factors)factors.set(source.factors);
  let at=length;for(const transform of transforms)if(transform){factors.set(transform,at);at+=8;}
  cached.transforms=transforms;return cached;
}

export function coordinateShader(code:string,coordinates?:CoordinateExtension,normalUV1=false):string {
  if(coordinates){
    let at=coordinates.length/4;
    for(let i=0;i<5;i++)if(coordinates.transforms[i]){
      // Only the original surface uses these exact expressions. Extension maps carry their own transforms.
      code=code.replaceAll('uv(i,'+baseCoords[i]+')',`materialUV(uv(i,${baseCoords[i]}),materialFactors[${at}],materialFactors[${at+1}])`);at+=2;
    }
    if(!coordinates.source?.declarations?.includes('fn materialUV('))code=textureTransformWGSL+code;
  }
  if(normalUV1||coordinates?.transforms[2])code=code.replace('if(abs(i.tangent.w)<0.5)', 'if(true)');
  return code;
}
