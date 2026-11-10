// KHR_materials_iridescence "Iridescence Fresnel" (Belcour and Barla 2017): air (IOR 1) over a film of IOR `film` and
// `thickness` nm over the base, whose IOR comes from F0 (exact for dielectrics, extinction ignored for metals; F0 + 1e-4,
// at most 0.9999, keeps a white metal finite). Airy sum: constant term plus Fourier orders 1 and 2, each weighted by
// margoFilmSpectrum, the closed-form Fourier transform of the spec's Gaussian CIE fits (amplitudes a sqrt(2 pi var) /
// 1.0685e-7 precomputed) in linear Rec. 709. Total internal reflection in the film reflects everything.
/** WGSL module-scope text declaring gltf-pro's thin-film Fresnel for extended materials. */
export const iridescenceWgsl = /* wgsl */ `fn margoFilmSpectrum(opd:f32,shift:vec3f)->vec3f {
  let k=6.28318531e-9*opd;
  var xyz=vec3f(0.84659,1.0002219,1.0011225)*cos(vec3f(1.6810e6,1.7953e6,2.2084e6)*k+shift)*exp(-k*k*vec3f(4.3278e9,9.3046e9,6.6121e9));
  xyz.x+=0.15386831*cos(2.2399e6*k+shift.x)*exp(-4.5282e9*k*k);
  return mat3x3f(3.2404542,-0.969266,0.0556434,-1.5371385,1.8760108,-0.2040259,-0.4985314,0.041556,1.0572252)*xyz;
}
fn margoIridescence(f0:vec3f,c1:f32,thickness:f32,film:f32)->vec3f {
  let c2Squared=1-(1-c1*c1)/(film*film); if(c2Squared<0){return vec3f(1);}
  let c2=sqrt(c2Squared); let r0=(film-1)/(film+1); let r12=r0*r0+(1-r0*r0)*pow(1-c1,5.0); let t=1-r12;
  let root=sqrt(min(f0+0.0001,vec3f(0.9999))); let base=(1+root)/(1-root);
  let q=(base-film)/(base+film); let r23=q*q+(1-q*q)*pow(1-c2,5.0);
  let r123=clamp(r12*r23,vec3f(0.00001),vec3f(0.9999)); let inner=t*t*r23/(1-r123);
  let opd=2*film*thickness*c2; let phase=select(vec3f(3.14159265),vec3f(0),film<1)+select(vec3f(0),vec3f(3.14159265),base<vec3f(film));
  let order=2*(inner-t);
  return max(r12+inner+order*sqrt(r123)*margoFilmSpectrum(opd,phase)+order*r123*margoFilmSpectrum(2*opd,2*phase),vec3f(0));
}
`;
