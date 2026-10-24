// Thin-film interference Fresnel of KHR_materials_iridescence ("Implementation Notes", "Iridescence Fresnel"), the model
// of Belcour and Barla 2017, "A Practical Extension to Microfacet Theory for the Modeling of Varying Iridescence".
// Three media: outside, film and base (its IOR recovered from F0). The Airy series of the film is summed in closed form
// over the spectrum: its constant term plus the first two Fourier orders, each weighted by the Fourier transform of the
// Gaussian fits of the CIE colour matching functions, taken to linear Rec. 709.
//
// Amplitudes below are the spec's fit values a sqrt(2 pi variance) divided by its normaliser 1.0685e-7 (so the Y
// response is 1 at zero path difference), computed once here: X 0.84659 (plus its second lobe 0.15386831), Y 1.0002219,
// Z 1.0011225. Centres (1/m) and variances (1/m^2) are the spec's.
//
// Guards of our own, each keeping the result finite and continuous:
// - thickness <= 0 (or NaN), and a film whose IOR equals the outside's, return the plain Schlick Fresnel of baseF0;
// - below 0.05 nm the film fades out linearly: its IOR ramps toward the outside IOR and the result toward that Schlick
//   term by the same weight (Schlick's (1 - cos)^5 keeps a matched interface reflecting, so ramping the IOR alone would
//   still jump at zero thickness);
// - IORs are clamped to [1e-4, 1e8] and baseF0 to [0, 0.9999] before the F0-to-IOR step (a white metal stays finite);
// - past an optical path difference of 5e4 nm the Fourier terms are dropped: their Gaussian envelope exp(-k^2 variance)
//   is below 1e-180 there, while the cosines would only add f32 rounding noise;
// - the result is clamped to [0, 1] (the analytic reconstruction can leave the gamut).
/**
 * WGSL module-scope text declaring the thin-film Fresnel used by material lobes:
 * `fn materialIridescenceFresnel(cosTheta:f32, outsideIor:f32, filmIor:f32, thicknessNm:f32, baseF0:vec3f)->vec3f`.
 * `cosTheta` is the cosine at the outer interface (v.h for direct light), `thicknessNm` the film thickness in nanometres,
 * `baseF0` the base layer's normal-incidence reflectance; it returns linear RGB reflectance in [0, 1] replacing a Fresnel
 * term.
 */
export const iridescenceWGSL = /* wgsl */ `
fn materialIridescenceSpectrum(opd:f32,shift:vec3f)->vec3f {
  let filmK=6.28318531e-9*opd;
  var filmXyz=vec3f(0.84659,1.0002219,1.0011225)*cos(vec3f(1.6810e6,1.7953e6,2.2084e6)*filmK+shift)*exp(-filmK*filmK*vec3f(4.3278e9,9.3046e9,6.6121e9));
  filmXyz.x+=0.15386831*cos(2.2399e6*filmK+shift.x)*exp(-4.5282e9*filmK*filmK);
  return mat3x3f(3.2404542,-0.969266,0.0556434,-1.5371385,1.8760108,-0.2040259,-0.4985314,0.041556,1.0572252)*filmXyz;
}
fn materialIridescenceFresnel(cosTheta:f32,outsideIor:f32,filmIor:f32,thicknessNm:f32,baseF0:vec3f)->vec3f {
  let filmC1=clamp(cosTheta,0.0,1.0);let filmF0=clamp(baseF0,vec3f(0.0),vec3f(1.0));
  let filmPlain=filmF0+(1.0-filmF0)*pow(1.0-filmC1,5.0);
  let filmOutside=clamp(outsideIor,0.0001,1e8);let filmTarget=clamp(filmIor,0.0001,1e8);
  if(!(thicknessNm>0.0)||filmTarget==filmOutside){return filmPlain;}
  let filmFade=min(thicknessNm/0.05,1.0);let filmEta=mix(filmOutside,filmTarget,filmFade);
  if(filmEta==filmOutside){return filmPlain;}
  let filmRatio=filmOutside/filmEta;let filmC2Squared=1.0-filmRatio*filmRatio*(1.0-filmC1*filmC1);
  if(filmC2Squared<0.0){return mix(filmPlain,vec3f(1.0),filmFade);}
  let filmC2=sqrt(filmC2Squared);
  let filmR0=(filmEta-filmOutside)/(filmEta+filmOutside);
  let filmR12=filmR0*filmR0+(1.0-filmR0*filmR0)*pow(1.0-filmC1,5.0);let filmT121=1.0-filmR12;
  let filmRoot=sqrt(min(filmF0,vec3f(0.9999)));let filmBase=(1.0+filmRoot)/(1.0-filmRoot);
  let filmQ=(filmBase-filmEta)/(filmBase+filmEta);let filmR23=filmQ*filmQ+(1.0-filmQ*filmQ)*pow(1.0-filmC2,5.0);
  let filmR123=clamp(filmR12*filmR23,vec3f(0.00001),vec3f(0.9999));
  let filmInner=filmT121*filmT121*filmR23/(1.0-filmR123);
  var filmSum=filmR12+filmInner;
  let filmOpd=2.0*filmEta*thicknessNm*filmC2;
  if(filmOpd>50000.0){return mix(filmPlain,clamp(filmSum,vec3f(0.0),vec3f(1.0)),filmFade);}
  // Reflection phase: pi going from a lower to a higher IOR at each interface (spec "Phase Shift").
  let filmPhase=select(vec3f(3.14159265),vec3f(0.0),filmEta<filmOutside)+select(vec3f(0.0),vec3f(3.14159265),filmBase<filmEta);
  let filmOrder=2.0*(filmInner-filmT121);
  filmSum+=filmOrder*sqrt(filmR123)*materialIridescenceSpectrum(filmOpd,filmPhase);
  filmSum+=filmOrder*filmR123*materialIridescenceSpectrum(2.0*filmOpd,2.0*filmPhase);
  return mix(filmPlain,clamp(filmSum,vec3f(0.0),vec3f(1.0)),filmFade);
}
`;
