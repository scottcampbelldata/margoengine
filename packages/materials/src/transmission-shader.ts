import type {MaterialExtension} from '@margoengine/gltf-pro';
import type {ClearcoatTextureSlot} from './shader.js';

export interface TransmissionShaderTextures {
  /** Snapshot of the opaque scene, in the render attachment's original format. */
  opaque:number;
  factor?:ClearcoatTextureSlot;
  thickness?:ClearcoatTextureSlot;
  /** [factor, IOR, thickness, inverse attenuation distance], then [attenuation RGB, 0]. */
  factorsIndex?:number;
}
/** Compiler-owned expressions evaluated in the extension's surface hook. */
export interface TransmissionShaderValues {
  factor:string;
  ior:string;
  thickness:string;
  attenuation:string;
  inverseDistance:string;
}

/** The output hook composites after the baseline tone map, so the copy is never tone mapped twice. */
export function transmissionShader(textures:TransmissionShaderTextures,values?:TransmissionShaderValues):Pick<MaterialExtension,'declarations'|'output'> {
  const index=textures.factorsIndex??0,opaque=`materialTexture${textures.opaque}`;
  const sample=(slot:ClearcoatTextureSlot)=>{
    const texture=`materialTexture${slot.index}`,coords=`uv(i,${slot.texCoord}.0)`;
    if(slot.sampler)return `textureSampleLevel(${texture},materialSampler${slot.index},${coords},0.0)`;
    const size=`vec2f(textureDimensions(${texture},0))`;
    return `textureLoad(${texture},vec2i(clamp(${coords}*${size},vec2f(0),${size}-vec2f(1))),0)`;
  };
  return {
    // The zero-factor branch preserves the complete original return, including alpha.
    output:`if(${values?values.factor:`materialFactors[${index}].x`}>0.0){return vec4f(materialTransmission(i,s,color,front${values?','+values.factor+','+values.ior+','+values.thickness+','+values.attenuation+','+values.inverseDistance:''}),1.0);}`,
    declarations:/* wgsl */`
fn materialTransmissionLinear(value:vec3f)->vec3f {
  return select(value/12.92,pow((value+0.055)/1.055,vec3f(2.4)),value>vec3f(0.04045));
}
fn materialTransmissionEncoded(value:vec3f)->vec3f {
  return select(value*12.92,1.055*pow(max(value,vec3f(0)),vec3f(1.0/2.4))-0.055,value>=vec3f(0.0031308));
}
fn materialTransmission(i:Out,s:Surface,color:vec3f,front:bool${values?',materialTransmissionFactor:f32,materialTransmissionIor:f32,materialTransmissionThickness:f32,materialTransmissionAttenuation:vec3f,materialTransmissionInverseDistance:f32':''})->vec3f {
${values?'  let factors=vec4f(materialTransmissionFactor,materialTransmissionIor,materialTransmissionThickness,materialTransmissionInverseDistance);':'  let factors=materialFactors['+index+'];'}
  // Explicit mip samples do not require derivatives in the beauty output hook.
  let factor=clamp(factors.x${textures.factor?'*'+sample(textures.factor)+'.r':''},0.0,1.0);
  let thickness=max(factors.z${textures.thickness?'*'+sample(textures.thickness)+'.g':''},0.0);
  if(factor<=0.0){return color;}
  let size=vec2f(textureDimensions(${opaque},0));
  var pixel=i.clip.xy;
  let view=f.eye.xyz-i.position;
  let viewDistance=length(view);
  let v=select(vec3f(0,0,1),view/max(viewDistance,0.000001),viewDistance>0.000001);
  let normalLength=length(s.n);
  let n=select(vec3f(0,0,1),s.n/max(normalLength,0.000001),normalLength>0.000001);
  var ray=-v;
  // In particular, IOR 1 never projects or rounds a different screen pixel.
  if(factors.y!=1.0){
    let entering=front==(f.coordsB.y>0);
    ray=refract(-v,n,select(factors.y,1.0/factors.y,entering));
    let rayLength=length(ray);
    if(rayLength<=0.000001){return color;}
    ray/=rayLength;
  }
  // Thickness is measured in mesh coordinates. Projecting the inverse-transformed
  // world ray onto the mesh normal also handles nonuniform scale and rotation.
  let localRay=(transpose(f.normalMatrix)*vec4f(ray,0)).xyz;
  let localNormalRaw=(transpose(f.model)*vec4f(n,0)).xyz;
  let localNormal=localNormalRaw/max(length(localNormalRaw),0.000001);
  let path=thickness/max(abs(dot(localRay,localNormal)),0.0001);
  if(factors.y!=1.0){
    // Without a volume, probe 10% of the view distance behind the surface. This
    // is a single screen-space estimate; the opaque snapshot has no traced depth.
    let distance=select(viewDistance*0.1,path,thickness>0.0);
    let bent=f.camera*vec4f(i.position+ray*distance,1);
    let straight=f.camera*vec4f(i.position-v*distance,1);
    if(bent.w>0.000001&&straight.w>0.000001){
      pixel+=(bent.xy/bent.w-straight.xy/straight.w)*vec2f(0.5,-0.5)*size;
    }
  }
  var transmitted=textureLoad(${opaque},vec2i(clamp(pixel,vec2f(0),size-vec2f(1))),0).rgb;
  let attenuation=${values?'materialTransmissionAttenuation':`materialFactors[${index+1}].rgb`};
  let attenuating=path>0.0&&factors.w>0.0;
  let tint=clamp(s.base.rgb,vec3f(0),vec3f(1));
  // Preserve captured values exactly for a colorless, unattenuated interface.
  // Otherwise tint and Beer attenuation operate in linear light. HDR captures
  // are already linear; LDR captures include the baseline sRGB transfer.
  if(attenuating||any(tint!=vec3f(1))){
    if(f.settings.w<0.5){transmitted=materialTransmissionLinear(transmitted);}
    transmitted*=tint;
    // This branch excludes 0^0 when an attenuation channel and thickness are 0.
    if(attenuating){transmitted*=pow(attenuation,vec3f(path*factors.w));}
    if(f.settings.w<0.5){transmitted=materialTransmissionEncoded(transmitted);}
  }
  return mix(color,transmitted,factor);
}
`
  };
}
