import type { MaterialExtension } from '@margoengine/gltf-pro';
import type { ClearcoatTextureSlot } from './shader.js';
import { coordinateExpression, coordinateWGSL } from './coordinates.js';
import { iridescenceWGSL } from './iridescence.js';

export interface LobeShaderConfig {
  /** [linear color RGB, roughness]. */
  sheen?: { index: number; color?: ClearcoatTextureSlot; roughness?: ClearcoatTextureSlot };
  /** [linear F0 color RGB, dielectric specular strength]. Identity is white/1. */
  specular?: { index: number; color?: ClearcoatTextureSlot; factor?: ClearcoatTextureSlot };
  /** [strength, rotation radians, 0, 0]. */
  anisotropy?: { index: number; texture?: ClearcoatTextureSlot };
  /** [factor, film IOR, minimum thickness nm, maximum thickness nm]. */
  iridescence?: { index: number; factor?: ClearcoatTextureSlot; thickness?: ClearcoatTextureSlot };
  ior?: number;
  /** False when an earlier extension already declares materialUV. */
  coordinateHelper?: boolean;
}

/** Optional lobes replace only the existing directional BRDF and hemisphere approximation. */
export function lobeShader(
  config: LobeShaderConfig,
): Pick<MaterialExtension, 'wgsl' | 'declarations' | 'direct' | 'ambient'> {
  const { sheen, specular, anisotropy, iridescence } = config,
    ior = config.ior ?? 1.5;
  if (!Number.isFinite(Math.fround(ior)) || ior < 1) throw new RangeError('Invalid lobe IOR');
  const dielectricF0 =
    ior === 1.5
      ? '0.04'
      : String(((ior - 1) / (ior + 1)) ** 2) + (Number.isInteger(((ior - 1) / (ior + 1)) ** 2) ? '.0' : '');
  const sample = (slot: ClearcoatTextureSlot) => {
    const texture = `materialTexture${slot.index}`,
      coords = coordinateExpression(slot);
    if (slot.sampler) return `textureSample(${texture},materialSampler${slot.index},${coords})`;
    const size = `vec2f(textureDimensions(${texture},0))`;
    return `textureLoad(${texture},vec2i(clamp(${coords}*${size},vec2f(0),${size}-vec2f(1))),0)`;
  };
  const slots = [
    sheen?.color,
    sheen?.roughness,
    specular?.color,
    specular?.factor,
    anisotropy?.texture,
    iridescence?.factor,
    iridescence?.thickness,
  ];
  const helper =
    config.coordinateHelper !== false && slots.some((slot) => slot?.transformIndex !== undefined) ? coordinateWGSL : '';
  const sheenInputs = sheen
    ? `let materialSheen=materialFactors[${sheen.index}];
  material.sheen=vec4f(clamp(materialSheen.rgb${sheen.color ? '*' + sample(sheen.color) + '.rgb' : ''},vec3f(0),vec3f(1)),clamp(materialSheen.a${sheen.roughness ? '*' + sample(sheen.roughness) + '.a' : ''},0.0,1.0));`
    : 'material.sheen=vec4f(0);';
  const specularInputs = specular
    ? `let materialSpecular=materialFactors[${specular.index}];
  material.specular=vec4f(max(materialSpecular.rgb${specular.color ? '*' + sample(specular.color) + '.rgb' : ''},vec3f(0)),clamp(materialSpecular.a${specular.factor ? '*' + sample(specular.factor) + '.a' : ''},0.0,1.0));`
    : 'material.specular=vec4f(1);';
  const iridescenceInputs = iridescence
    ? `let materialFilm=materialFactors[${iridescence.index}];
  material.iridescence=vec4f(clamp(materialFilm.x${iridescence.factor ? '*' + sample(iridescence.factor) + '.r' : ''},0.0,1.0),materialFilm.y,${iridescence.thickness ? 'mix(materialFilm.z,materialFilm.w,' + sample(iridescence.thickness) + '.g)' : 'materialFilm.w'},0);`
    : 'material.iridescence=vec4f(0,1.3,0,0);';
  const anisotropyInputs = anisotropy
    ? /* wgsl */ `
  let materialAnisotropy=materialFactors[${anisotropy.index}];
  let materialDirectionSample=${anisotropy.texture ? sample(anisotropy.texture) + '.rgb' : 'vec3f(1,0.5,1)'};
  let materialDirectionRaw=materialDirectionSample.xy*2-1;
  let materialDirectionLength=length(materialDirectionRaw);
  let materialDirection=select(vec2f(1,0),materialDirectionRaw/max(materialDirectionLength,0.000001),materialDirectionLength>0.000001);
  let materialRotation=vec2f(cos(materialAnisotropy.y),sin(materialAnisotropy.y));
  let materialRotated=vec2f(materialRotation.x*materialDirection.x-materialRotation.y*materialDirection.y,materialRotation.y*materialDirection.x+materialRotation.x*materialDirection.y);
  material.anisotropy=clamp(materialAnisotropy.x*materialDirectionSample.z,0.0,1.0);
  // Tangents belong to UV0. Other UV sets/transforms derive their own frame.
  var materialT=i.tangent.xyz-materialNormal*dot(materialNormal,i.tangent.xyz);
  var materialB=cross(materialNormal,materialT)*i.tangent.w;
  let materialDP1=dpdx(i.position);let materialDP2=dpdy(i.position);
  let materialDUV1=dpdx(${anisotropy.texture ? coordinateExpression(anisotropy.texture) : 'uv(i,0.0)'});let materialDUV2=dpdy(${anisotropy.texture ? coordinateExpression(anisotropy.texture) : 'uv(i,0.0)'});
  if(abs(i.tangent.w)<0.5${anisotropy.texture && (anisotropy.texture.texCoord === 1 || anisotropy.texture.transformIndex !== undefined) ? '||true' : ''}){
    let materialP1=cross(materialNormal,materialDP1);let materialP2=cross(materialDP2,materialNormal);
    materialT=materialP2*materialDUV1.x+materialP1*materialDUV2.x;materialB=materialP2*materialDUV1.y+materialP1*materialDUV2.y;
  }
  let materialAxis=select(vec3f(0,0,1),vec3f(0,1,0),abs(materialNormal.z)>0.9);
  let materialFallback=normalize(cross(materialAxis,materialNormal));
  let materialTLength=length(materialT);materialT=select(materialFallback,materialT/max(materialTLength,0.000001),materialTLength>0.000001);
  let materialSign=select(1.0,-1.0,dot(cross(materialNormal,materialT),materialB)<0.0);
  materialB=cross(materialNormal,materialT)*materialSign;
  material.tangent=normalize(materialT*materialRotated.x+materialB*materialRotated.y);
  material.bitangent=cross(materialNormal,material.tangent);
`
    : 'material.anisotropy=0;material.tangent=vec3f(1,0,0);material.bitangent=vec3f(0,1,0);';
  return {
    wgsl: 'let materialLobeInputs=materialLobesInputs(i,s,front);',
    direct: 'direct=materialLobesDirect(i,s,direct,materialLobeInputs);',
    ambient: 'materialAmbient=materialLobesAmbient(s,materialAmbient,materialLobeInputs);',
    declarations:
      helper +
      (iridescence ? iridescenceWGSL : '') +
      /* wgsl */ `
struct MaterialLobeInputs {sheen:vec4f,specular:vec4f,iridescence:vec4f,anisotropy:f32,tangent:vec3f,bitangent:vec3f,viewCos:f32}
fn materialLobesInputs(i:Out,s:Surface,front:bool)->MaterialLobeInputs {
  var material:MaterialLobeInputs;
  let materialNormal=s.n/max(length(s.n),0.000001);
  let materialView=f.eye.xyz-i.position;
  material.viewCos=clamp(dot(materialNormal,materialView/max(length(materialView),0.000001)),0.0001,1.0);
  ${sheenInputs}
  ${specularInputs}
  ${iridescenceInputs}
  ${anisotropyInputs}
  return material;
}
fn materialLobesMax(value:vec3f)->f32 {return max(max(value.x,value.y),value.z);}
fn materialLobesSpecularActive(s:Surface,material:MaterialLobeInputs)->bool {
  return s.metal<1.0&&(${ior !== 1.5 ? 'true||' : ''}material.specular.a!=1.0||any(material.specular.rgb!=vec3f(1)));
}
fn materialLobesFilmActive(material:MaterialLobeInputs)->bool {
  return material.iridescence.x>0.0&&material.iridescence.z>0.0&&material.iridescence.y!=1.0;
}
fn materialLobesDielectricF0(material:MaterialLobeInputs)->vec3f {return min(vec3f(${dielectricF0})*material.specular.rgb,vec3f(1));}
// Charlie's distribution with the permitted Neubelt visibility approximation.
// https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_sheen
fn materialLobesSheenBRDF(roughness:f32,nl:f32,nv:f32,nh:f32)->f32 {
  let materialRoughness=max(roughness,0.0001);let materialInverse=1.0/(materialRoughness*materialRoughness);
  let materialDistribution=(2.0+materialInverse)*pow(max(1.0-nh*nh,0.0),materialInverse*0.5)/6.2831853;
  let materialVisibility=min(1.0,1.0/max(4.0*(nl+nv-nl*nv),0.000001));
  return materialDistribution*materialVisibility;
}
// Analytic directional-albedo fit to integrated Charlie/Neubelt sheen.
// https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/lights_physical_pars_fragment.glsl.js
fn materialLobesSheenAlbedo(mu:f32,roughness:f32)->f32 {
  let materialR2=roughness*roughness;let materialInverse=1.0/(roughness+0.1);
  let materialA=-1.9362+1.0678*roughness+0.4573*materialR2-0.8469*materialInverse;
  let materialB=-0.6014+0.5538*roughness-0.4670*materialR2-0.1255*materialInverse;
  return clamp(exp(materialA*mu+materialB),0.0,1.0);
}
fn materialLobesDirect(i:Out,s:Surface,baseline:vec3f,material:MaterialLobeInputs)->vec3f {
  let materialSpecularActive=materialLobesSpecularActive(s,material);
  let materialFilmActive=materialLobesFilmActive(material);
  let materialSheenActive=any(material.sheen.rgb>vec3f(0));
  // Do not even add zero: preserve the complete original operation order.
  if(!materialSpecularActive&&!materialFilmActive&&!materialSheenActive&&material.anisotropy<=0.0){return baseline;}
  let materialV=normalize(f.eye.xyz-i.position);let materialL=normalize(f.light.xyz);let materialH=(materialV+materialL)/max(length(materialV+materialL),0.0001);
  let materialNL=clamp(dot(s.n,materialL),0.0,1.0);let materialNV=clamp(dot(s.n,materialV),0.0001,1.0);let materialNH=clamp(dot(s.n,materialH),0.0,1.0);let materialVH=clamp(dot(materialV,materialH),0.0,1.0);
  var materialResult=baseline;
  if(materialSpecularActive||materialFilmActive||material.anisotropy>0.0){
    let materialA=s.roughness*s.roughness;let materialA2=materialA*materialA;
    let materialD=materialA2/(3.14159265*pow(materialNH*materialNH*(materialA2-1)+1,2.0));
    let materialG=2*materialNV/(materialNV+sqrt(materialA2+(1-materialA2)*materialNV*materialNV))*2*materialNL/max(materialNL+sqrt(materialA2+(1-materialA2)*materialNL*materialNL),0.0001);
    var materialSpecularBRDF=materialD*materialG/max(4*materialNL*materialNV,0.0001);
    if(material.anisotropy>0.0){
      let materialAT=mix(materialA,1.0,material.anisotropy*material.anisotropy);let materialAB=materialA;let materialProduct=materialAT*materialAB;
      // Keep the isotropic formula when f32 rounding leaves both widths equal.
      if(materialAT!=materialAB){
      let materialDistribution=vec3f(materialAB*dot(material.tangent,materialH),materialAT*dot(material.bitangent,materialH),materialProduct*materialNH);
      let materialW=materialProduct/max(dot(materialDistribution,materialDistribution),0.000000000001);
      let materialAnisotropicD=materialProduct*materialW*materialW/3.14159265;
      // Independent anisotropic Smith G1 terms retain the base shader's limit.
      // https://www.pbr-book.org/4ed/Reflection_Models/Roughness_Using_Microfacet_Theory
      let materialViewLength=length(vec3f(materialAT*dot(material.tangent,materialV),materialAB*dot(material.bitangent,materialV),materialNV));
      let materialLightLength=length(vec3f(materialAT*dot(material.tangent,materialL),materialAB*dot(material.bitangent,materialL),materialNL));
      let materialG1V=2*materialNV/(materialNV+materialViewLength);
      let materialG1L=2*materialNL/max(materialNL+materialLightLength,0.0001);
      materialSpecularBRDF=materialAnisotropicD*materialG1V*materialG1L/max(4*materialNL*materialNV,0.0001);
      }
    }
    let materialWeight=pow(1-materialVH,5.0);
    let materialBaseF0=mix(vec3f(0.04),s.base.rgb,s.metal);let materialBaseFresnel=materialBaseF0+(1-materialBaseF0)*materialWeight;
    var materialFresnel=materialBaseFresnel;
    var materialDiffuse=(1-materialBaseFresnel)*(1-s.metal)*s.base.rgb/3.14159265;
    if(materialSpecularActive||materialFilmActive){
      let materialDielectricF0=materialLobesDielectricF0(material);
      var materialDielectric=(materialDielectricF0+(1-materialDielectricF0)*materialWeight)*material.specular.a;
      var materialMetal=s.base.rgb+(1-s.base.rgb)*materialWeight;
      ${
        iridescence
          ? `if(materialFilmActive){
        materialDielectric=mix(materialDielectric,materialIridescenceFresnel(materialVH,1.0,material.iridescence.y,material.iridescence.z,materialDielectricF0)*material.specular.a,material.iridescence.x);
        materialMetal=mix(materialMetal,materialIridescenceFresnel(materialVH,1.0,material.iridescence.y,material.iridescence.z,s.base.rgb),material.iridescence.x);
      }`
          : ''
      }
      materialFresnel=mix(materialDielectric,materialMetal,s.metal);
      materialDiffuse=(1.0-materialLobesMax(materialDielectric))*(1.0-s.metal)*s.base.rgb/3.14159265;
    }
    materialResult=(materialDiffuse+materialFresnel*materialSpecularBRDF)*materialNL*f.radiance.rgb*f.light.w;
  }
  if(materialSheenActive){
    let materialEnergy=max(materialLobesSheenAlbedo(materialNV,material.sheen.a),materialLobesSheenAlbedo(materialNL,material.sheen.a));
    let materialScale=max(0.0,1.0-materialLobesMax(material.sheen.rgb)*materialEnergy);
    materialResult=materialResult*materialScale+material.sheen.rgb*materialLobesSheenBRDF(material.sheen.a,materialNL,materialNV,materialNH)*materialNL*f.radiance.rgb*f.light.w;
  }
  return materialResult;
}
fn materialLobesAmbient(s:Surface,baseline:vec3f,material:MaterialLobeInputs)->vec3f {
  let materialSpecularActive=materialLobesSpecularActive(s,material);let materialFilmActive=materialLobesFilmActive(material);let materialSheenActive=any(material.sheen.rgb>vec3f(0));
  if(!materialSpecularActive&&!materialFilmActive&&!materialSheenActive){return baseline;}
  var materialResult=baseline;
  let materialHemisphere=mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0))*f.radiance.w*s.occlusion;
  if(materialSpecularActive||materialFilmActive){
    let materialDielectricF0=materialLobesDielectricF0(material);var materialDielectric=materialDielectricF0*material.specular.a;var materialMetal=s.base.rgb;
    ${
      iridescence
        ? `if(materialFilmActive){
      materialDielectric=mix(materialDielectric,materialIridescenceFresnel(1.0,1.0,material.iridescence.y,material.iridescence.z,materialDielectricF0)*material.specular.a,material.iridescence.x);
      materialMetal=mix(materialMetal,materialIridescenceFresnel(1.0,1.0,material.iridescence.y,material.iridescence.z,s.base.rgb),material.iridescence.x);
    }`
        : ''
    }
    materialResult=(s.base.rgb*(1-s.metal)+mix(materialDielectric,materialMetal,s.metal)*0.5)*materialHemisphere;
  }
  if(materialSheenActive){let materialEnergy=materialLobesSheenAlbedo(material.viewCos,material.sheen.a);materialResult=materialResult*max(0.0,1.0-materialLobesMax(material.sheen.rgb)*materialEnergy)+material.sheen.rgb*materialEnergy*materialHemisphere;}
  return materialResult;
}
`,
  };
}
