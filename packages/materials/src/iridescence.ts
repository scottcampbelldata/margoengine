/**
 * Belcour/Barla thin-film Fresnel with the KHR_materials_iridescence two-harmonic
 * analytic CIE integration. Equations and Gaussian fits are documented at:
 * https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_iridescence
 * https://github.com/KhronosGroup/glTF-Sample-Renderer/blob/main/source/Renderer/shaders/iridescence.glsl
 * The returned linear RGB value replaces a Fresnel term, not the whole BRDF.
 */
export const iridescenceWGSL = /* wgsl */ `
fn materialIridescenceSensitivity(pathNm:f32,shift:vec3f)->vec3f {
  let phase=pathNm*0.000000006283185307179586;
  let variance=vec3f(4.3278e9,9.3046e9,6.6121e9);
  let phaseSquared=phase*phase;
  var xyz=vec3f(5.4856e-13,4.4201e-13,5.2481e-13)*sqrt(6.283185307179586*variance)*
    cos(vec3f(1.6810e6,1.7953e6,2.2084e6)*phase+shift)*exp(-phaseSquared*variance);
  xyz.x+=9.7470e-14*sqrt(6.283185307179586*4.5282e9)*cos(2.2399e6*phase+shift.x)*exp(-4.5282e9*phaseSquared);
  xyz/=1.0685e-7;
  return vec3f(dot(vec3f(3.2404542,-1.5371385,-0.4985314),xyz),
    dot(vec3f(-0.9692660,1.8760108,0.0415560),xyz),
    dot(vec3f(0.0556434,-0.2040259,1.0572252),xyz));
}

fn materialIridescenceFresnel(cosTheta:f32,outsideIor:f32,filmIor:f32,thicknessNm:f32,baseF0:vec3f)->vec3f {
  let cosine=clamp(cosTheta,0.0,1.0);
  let f0=clamp(baseF0,vec3f(0),vec3f(1));
  let base=f0+(vec3f(1)-f0)*pow(1.0-cosine,5.0);
  if(thicknessNm<=0.0){return base;}
  // These extreme bounds avoid overflow without changing practical optical IORs.
  let outside=clamp(outsideIor,0.0001,100000000.0);
  let film=mix(outside,clamp(filmIor,0.0001,100000000.0),smoothstep(0.0,0.03,thicknessNm));
  if(film==outside){return base;}
  let ratio=outside/film;
  let transmittedCosineSquared=1.0-ratio*ratio*(1.0-cosine*cosine);
  if(transmittedCosineSquared<0.0){return vec3f(1);}
  let transmittedCosine=sqrt(max(transmittedCosineSquared,0.0));
  let interfaceRatio=(film-outside)/(film+outside);
  let interfaceF0=interfaceRatio*interfaceRatio;
  let reflected=interfaceF0+(1.0-interfaceF0)*pow(1.0-cosine,5.0);
  let transmitted=1.0-reflected;
  // Metallic F0 is converted to a real IOR, the glTF approximation to a complex
  // conductor IOR. The upper guard keeps a perfect reflector finite.
  let root=sqrt(min(f0,vec3f(0.9999)));
  let substrate=(vec3f(1)+root)/(vec3f(1)-root);
  let substrateRatio=(substrate-vec3f(film))/(substrate+vec3f(film));
  let substrateF0=substrateRatio*substrateRatio;
  let substrateReflection=substrateF0+(vec3f(1)-substrateF0)*pow(1.0-transmittedCosine,5.0);
  let product=clamp(reflected*substrateReflection,vec3f(0.00001),vec3f(0.9999));
  let internal=transmitted*transmitted*substrateReflection/(vec3f(1)-product);
  var result=vec3f(reflected)+internal;
  // At very large optical depth, the Gaussian Fourier terms vanish. Taking
  // their DC limit before the multiplication prevents infinite phase values.
  let opticalRate=2.0*film*transmittedCosine;
  if(thicknessNm>100000.0/max(opticalRate,1.0e-30)){return clamp(result,vec3f(0),vec3f(1));}
  let opticalPath=opticalRate*thicknessNm;
  let reversePhase=select(3.141592653589793,0.0,film<outside);
  let phase=vec3f(reversePhase)+select(vec3f(0),vec3f(3.141592653589793),substrate<vec3f(film));
  var amplitude=internal-vec3f(transmitted);
  let attenuation=sqrt(product);
  for(var order=1u;order<=2u;order++){
    amplitude*=attenuation;
    result+=2.0*amplitude*materialIridescenceSensitivity(f32(order)*opticalPath,f32(order)*phase);
  }
  // Analytic spectral reconstruction can leave the linear RGB gamut.
  return clamp(result,vec3f(0),vec3f(1));
}
`;
