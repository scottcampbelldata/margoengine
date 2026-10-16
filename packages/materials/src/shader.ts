import type {MaterialExtension} from '@margoengine/gltf-pro';

/** Resource index in the extension slot, and the existing vertex UV set. */
export interface ClearcoatTextureSlot {index:number;texCoord:0|1;sampler?:boolean}
export interface ClearcoatShaderTextures {
  factor?:ClearcoatTextureSlot;
  roughness?:ClearcoatTextureSlot;
  normal?:ClearcoatTextureSlot;
}
/** Compiler-owned expressions evaluated in the extension's surface hook. */
export interface ClearcoatShaderValues {
  factor:string;
  roughness:string;
  /** Optional world-space normal, leaving the base Surface normal unchanged. */
  normal?:string;
}

/** Factors are [clearcoat, roughness, normal scale, reserved] in materialFactors[0]. */
export function clearcoatShader(textures:ClearcoatShaderTextures={},values?:ClearcoatShaderValues):Pick<MaterialExtension,'wgsl'|'declarations'|'direct'> {
  const sample=(slot:ClearcoatTextureSlot)=>{
    const texture=`materialTexture${slot.index}`,coords=`uv(i,${slot.texCoord}.0)`;
    if(slot.sampler)return `textureSample(${texture},materialSampler${slot.index},${coords})`;
    const size=`vec2f(textureDimensions(${texture},0))`;
    return `textureLoad(${texture},vec2i(clamp(${coords}*${size},vec2f(0),${size}-vec2f(1))),0)`;
  };
  const normal=textures.normal;
  if(values&&normal)throw new TypeError('Node clearcoat normals must use the graph normalMap node');
  const normalShader=normal?/* wgsl */`
  let sampledNormal=${sample(normal)}.xyz*2-1;
  var t=i.tangent.xyz-n*dot(n,i.tangent.xyz);
  var b=cross(n,t)*i.tangent.w;
  let dp1=dpdx(i.position); let dp2=dpdy(i.position);
  let duv1=dpdx(uv(i,${normal.texCoord}.0)); let duv2=dpdy(uv(i,${normal.texCoord}.0));
  // A coat UV set different from the base normal map needs its own tangent frame.
  if(abs(i.tangent.w)<0.5||f.coordsA.z!=${normal.texCoord}.0) {
    let p1=cross(n,dp1); let p2=cross(dp2,n);
    t=p2*duv1.x+p1*duv2.x; b=p2*duv1.y+p1*duv2.y;
    let scale=inverseSqrt(max(max(dot(t,t),dot(b,b)),0.000001)); t*=scale; b*=scale;
  } else {t/=max(length(t),0.000001); b=cross(n,t); b=b/max(length(b),0.000001)*i.tangent.w;}
  // A common scale leaves the final direction unchanged and bounds finite normal scales.
  let normalMagnitude=max(abs(factors.z),1.0);
  let mappedNormal=t*sampledNormal.x*(factors.z/normalMagnitude)+b*sampledNormal.y*(factors.z/normalMagnitude)+n*(sampledNormal.z/normalMagnitude);
  let mappedLength=length(mappedNormal);
  coatNormal=select(n,mappedNormal/max(mappedLength,0.000001),mappedLength>0.000001);
`:'';
  return {
    wgsl:`let materialClearcoat=materialClearcoatLighting(i,front${values?','+values.factor+','+values.roughness+(values.normal?','+values.normal:''):''});`,
    // Skip even the addition when factor is zero, preserving the base operation order.
    direct:`if(${values?values.factor:'materialFactors[0].x'}>0.0){direct+=materialClearcoat;}`,
    declarations:/* wgsl */`
// Clearcoat has an independent normal. Never change Surface.n: SSAO and shadows use the base normal.
fn materialClearcoatLighting(i:Out,front:bool${values?',materialCoatFactor:f32,materialCoatRoughness:f32'+(values.normal?',materialCoatNormal:vec3f':''):''})->vec3f {
${values?'':'  let factors=materialFactors[0];\n'}  let factor=clamp(${values?'materialCoatFactor':'factors.x'}${textures.factor?'*'+sample(textures.factor)+'.r':''},0.0,1.0);
  let roughness=clamp(${values?'materialCoatRoughness':'factors.y'}${textures.roughness?'*'+sample(textures.roughness)+'.g':''},0.045,1.0);
  let facing=front==(f.coordsB.y>0);
  let normalLength=length(i.normal);
  let n=select(vec3f(0,0,1),i.normal/max(normalLength,0.000001),normalLength>0.000001)*select(-1.0,1.0,facing);
  var coatNormal=${values?.normal?'materialCoatNormal':'n'};
${normalShader}
  // Texture samples and derivative frames above must precede this varying branch.
  if(factor<=0.0){return vec3f(0);}
  let view=f.eye.xyz-i.position; let v=view/max(length(view),0.0001);
  let l=f.light.xyz/max(length(f.light.xyz),0.0001); let h=(v+l)/max(length(v+l),0.0001);
  let nl=clamp(dot(coatNormal,l),0.0,1.0); let nv=clamp(dot(coatNormal,v),0.0001,1.0);
  let nh=clamp(dot(coatNormal,h),0.0,1.0); let vh=clamp(dot(v,h),0.0,1.0);
  let a=roughness*roughness; let a2=a*a;
  let d=a2/(3.14159265*pow(nh*nh*(a2-1)+1,2.0));
  let g=2*nv/(nv+sqrt(a2+(1-a2)*nv*nv))*2*nl/max(nl+sqrt(a2+(1-a2)*nl*nl),0.0001);
  let fresnel=0.04+(1-0.04)*pow(1-vh,5.0);
  return factor*d*g*fresnel/max(4*nl*nv,0.0001)*nl*f.radiance.rgb*f.light.w;
}
`
  };
}
