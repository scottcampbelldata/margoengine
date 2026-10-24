import type { MaterialExtension } from '@margoengine/gltf-pro';
import type { ClearcoatTextureSlot } from './shader.js';
import { coordinateExpression } from './coordinates.js';

export interface TransmissionShaderTextures {
  /** Snapshot of the opaque scene, in the render attachment's original format. */
  opaque: number;
  factor?: ClearcoatTextureSlot;
  thickness?: ClearcoatTextureSlot;
  /** [factor, IOR, thickness, inverse attenuation distance], then [attenuation RGB, dispersion]. */
  factorsIndex?: number;
}
/** Compiler-owned expressions evaluated in the extension's surface hook. */
export interface TransmissionShaderValues {
  factor: string;
  ior: string;
  thickness: string;
  attenuation: string;
  inverseDistance: string;
  dispersion?: string;
}

/** The output hook composites after the baseline tone map, so the copy is never tone mapped twice. */
export function transmissionShader(
  textures: TransmissionShaderTextures,
  values?: TransmissionShaderValues,
): Pick<MaterialExtension, 'declarations' | 'output' | 'transmission'> {
  const index = textures.factorsIndex ?? 0,
    opaque = `materialTexture${textures.opaque}`;
  const sample = (slot: ClearcoatTextureSlot) => {
    const texture = `materialTexture${slot.index}`,
      coords = coordinateExpression(slot);
    if (slot.sampler) return `textureSampleLevel(${texture},materialSampler${slot.index},${coords},0.0)`;
    const size = `vec2f(textureDimensions(${texture},0))`;
    return `textureLoad(${texture},vec2i(clamp(${coords}*${size},vec2f(0),${size}-vec2f(1))),0)`;
  };
  return {
    // The host scales diffuse and ambient light by 1 - this factor (as native transmission does), and the output adds
    // the transmitted light behind, so reflections keep their strength.
    transmission: values
      ? values.factor
      : `materialFactors[${index}].x${textures.factor ? '*' + sample(textures.factor) + '.r' : ''}`,
    // Assign RGB and reconverge before the host's final return, which owns alpha and derivatives.
    output: `if(${values ? values.factor : `materialFactors[${index}].x`}>0.0){color=materialTransmission(i,s,color,front${values ? ',' + values.factor + ',' + values.ior + ',' + values.thickness + ',' + values.attenuation + ',' + values.inverseDistance + ',' + (values.dispersion ?? '0.0') : ''});}`,
    declarations: /* wgsl */ `
fn materialTransmissionLinear(value:vec3f)->vec3f {
  return select(value/12.92,pow((value+0.055)/1.055,vec3f(2.4)),value>vec3f(0.04045));
}
fn materialTransmissionEncoded(value:vec3f)->vec3f {
  return select(value*12.92,1.055*pow(max(value,vec3f(0)),vec3f(1.0/2.4))-0.055,value>=vec3f(0.0031308));
}
// Transmitted share of the light behind: the dielectric part not reflected (Schlick Fresnel), as on the native path.
fn materialTransmissionWeight(s:Surface,v:vec3f,n:vec3f,factor:f32)->vec3f {
  let f0=mix(vec3f(0.04),s.base.rgb,s.metal);
  return factor*(1-s.metal)*(1-(f0+(1-f0)*pow(1-clamp(dot(n,v),0.0,1.0),5.0)));
}
fn materialTransmission(i:Out,s:Surface,color:vec3f,front:bool${values ? ',materialTransmissionFactor:f32,materialTransmissionIor:f32,materialTransmissionThickness:f32,materialTransmissionAttenuation:vec3f,materialTransmissionInverseDistance:f32,materialTransmissionDispersion:f32' : ''})->vec3f {
${values ? '  let factors=vec4f(materialTransmissionFactor,materialTransmissionIor,materialTransmissionThickness,materialTransmissionInverseDistance);' : '  let factors=materialFactors[' + index + '];'}
  // Explicit mip samples do not require derivatives in the beauty output hook.
  let factor=clamp(factors.x${textures.factor ? '*' + sample(textures.factor) + '.r' : ''},0.0,1.0);
  let thickness=max(factors.z${textures.thickness ? '*' + sample(textures.thickness) + '.g' : ''},0.0);
  if(factor<=0.0){return color;}
  let size=vec2f(textureDimensions(${opaque},0));
  var pixel=i.clip.xy;
  let view=f.eye.xyz-i.position;
  let viewDistance=length(view);
  let v=select(vec3f(0,0,1),view/max(viewDistance,0.000001),viewDistance>0.000001);
  let normalLength=length(s.n);
  let n=select(vec3f(0,0,1),s.n/max(normalLength,0.000001),normalLength>0.000001);
  let dispersion=${values ? 'materialTransmissionDispersion' : `materialFactors[${index + 1}].w`};
  if(dispersion>0.0&&thickness>0.0&&factors.y!=1.0){
    let halfSpread=(factors.y-1.0)*0.025*dispersion;
    let iors=max(vec3f(1),vec3f(factors.y-halfSpread,factors.y,factors.y+halfSpread));
    let entering=front==(f.coordsB.y>0);
    let localNormalRaw=(transpose(f.model)*vec4f(n,0)).xyz;
    let localNormal=localNormalRaw/max(length(localNormalRaw),0.000001);
    let attenuation=${values ? 'materialTransmissionAttenuation' : `materialFactors[${index + 1}].rgb`};
    let tint=clamp(s.base.rgb,vec3f(0),vec3f(1));
    var dispersed=color;
    for(var channel=0u;channel<3u;channel++){
      let ior=iors[channel];
      var ray=refract(-v,n,select(ior,1.0/ior,entering));
      let rayLength=length(ray);
      if(rayLength>0.000001){
        ray/=rayLength;
        let localRay=(transpose(f.normalMatrix)*vec4f(ray,0)).xyz;
        let path=thickness/max(abs(dot(localRay,localNormal)),0.0001);
        var channelPixel=i.clip.xy;
        if(ior!=1.0){
          let bent=f.camera*vec4f(i.position+ray*path,1);
          let straight=f.camera*vec4f(i.position-v*path,1);
          if(bent.w>0.000001&&straight.w>0.000001){
            channelPixel+=(bent.xy/bent.w-straight.xy/straight.w)*vec2f(0.5,-0.5)*size;
          }
        }
        var received=vec3f(textureLoad(${opaque},vec2i(clamp(channelPixel,vec2f(0),size-vec2f(1))),0)[channel]);
        let attenuating=path>0.0&&factors.w>0.0;
        if(attenuating||tint[channel]!=1.0){
          if(f.settings.w<0.5){received=materialTransmissionLinear(received);}
          received*=tint[channel];
          if(attenuating){received*=pow(attenuation[channel],path*factors.w);}
          if(f.settings.w<0.5){received=materialTransmissionEncoded(received);}
        }
        dispersed[channel]=received.x;
      }
    }
    return color+materialTransmissionWeight(s,v,n,factor)*dispersed;
  }
  var ray=-v;
  // In particular, IOR 1 never projects or rounds a different screen pixel.
  if(thickness>0.0&&factors.y!=1.0){
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
  if(thickness>0.0&&factors.y!=1.0){
    // A thin interface keeps the sightline; only an authored volume supplies a
    // refraction path. The opaque snapshot still has no traced scene depth.
    let distance=path;
    let bent=f.camera*vec4f(i.position+ray*distance,1);
    let straight=f.camera*vec4f(i.position-v*distance,1);
    if(bent.w>0.000001&&straight.w>0.000001){
      pixel+=(bent.xy/bent.w-straight.xy/straight.w)*vec2f(0.5,-0.5)*size;
    }
  }
  var transmitted=textureLoad(${opaque},vec2i(clamp(pixel,vec2f(0),size-vec2f(1))),0).rgb;
  let attenuation=${values ? 'materialTransmissionAttenuation' : `materialFactors[${index + 1}].rgb`};
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
  return color+materialTransmissionWeight(s,v,n,factor)*transmitted;
}
`,
  };
}
