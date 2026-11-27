import{t as e}from"./errors-THVaUwlL-C81vxm_p.js";var t=`
struct MargoBaseInfo {rows:array<vec4f,10>}
@group(1) @binding(0) var margoBaseMaps:texture_2d_array<f32>;
@group(1) @binding(1) var<uniform> margoBaseInfo:MargoBaseInfo;
fn margoBaseWrap(x:i32,n:i32,mode:f32)->i32 {
  if(mode<0.5){return clamp(x,0,n-1);}
  if(mode<1.5){return ((x%n)+n)%n;}
  let k=((x%(2*n))+2*n)%(2*n); return min(k,2*n-1-k);
}
fn margoBaseTexel(slot:i32,p:vec2i,level:i32)->vec4f {
  let a=margoBaseInfo.rows[slot*2];let b=margoBaseInfo.rows[slot*2+1];
  let size=max(vec2i(a.xy)>>vec2u(u32(level)),vec2i(1));
  return textureLoad(margoBaseMaps,vec2i(margoBaseWrap(p.x,size.x,b.z),margoBaseWrap(p.y,size.y,b.w)),slot,level);
}
fn margoBaseCoord(v:f32,mode:f32)->f32 {
  if(mode<0.5){return clamp(v,0.0,1.0);}
  if(mode<1.5){return fract(v);}
  let x=fract(v*0.5)*2.0; return min(x,2.0-x);
}
fn margoBaseLevel(slot:i32,uv:vec2f,level:i32,linear:bool)->vec4f {
  let wrap=margoBaseInfo.rows[slot*2+1].zw;
  let at=vec2f(margoBaseCoord(uv.x,wrap.x),margoBaseCoord(uv.y,wrap.y));
  let size=max(vec2i(margoBaseInfo.rows[slot*2].xy)>>vec2u(u32(level)),vec2i(1));
  if(!linear){return margoBaseTexel(slot,vec2i(floor(at*vec2f(size))),level);}
  let p=at*vec2f(size)-0.5;let lo=vec2i(floor(p));let f=fract(p);
  return mix(mix(margoBaseTexel(slot,lo,level),margoBaseTexel(slot,lo+vec2i(1,0),level),f.x),
    mix(margoBaseTexel(slot,lo+vec2i(0,1),level),margoBaseTexel(slot,lo+vec2i(1,1),level),f.x),f.y);
}
fn margoBaseSample(slot:i32,at:vec2f)->vec4f {
  let a=margoBaseInfo.rows[slot*2];let b=margoBaseInfo.rows[slot*2+1];
  let dx=dpdx(at)*a.xy;let dy=dpdy(at)*a.xy;let lod=log2(max(max(length(dx),length(dy)),0.000001));
  let linear=select(b.x>0.5,a.w>0.5,lod<=0.0);
  let l=select(clamp(lod,0.0,a.z-1.0),0.0,b.y>1.5);
  if(b.y<0.5){return margoBaseLevel(slot,at,i32(floor(l+0.5)),linear);}
  let lo=i32(floor(l));let hi=min(lo+1,i32(a.z)-1);
  return mix(margoBaseLevel(slot,at,lo,linear),margoBaseLevel(slot,at,hi,linear),fract(l));
}
`;function n(e){let n=[`base`,`mr`,`normal`,`ao`,`emissive`];for(let t=0;t<n.length;t++){let r=n[t];e=e.replace(`@group(1) @binding(${t*2}) var ${r}Map:texture_2d<f32>;`,``).replace(`@group(1) @binding(${t*2+1}) var ${r}Sampler:sampler;`,``).replaceAll(`textureSample(${r}Map,${r}Sampler,`,`margoBaseSample(${t},`)}return t+e}var r=`fn margoFilmSpectrum(opd:f32,shift:vec3f)->vec3f {
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
`,i=new WeakMap,a=`var<private> margoDirectVisible:vec3f=vec3f(1);`;function o(e,t){let n=i.get(t),r=n?.get(e);return r===void 0?u(e,t,n):r}var s=/mix\(vec3f\(0\.35,0\.3,0\.25\),vec3f\(1(?:\.0)?\),clamp\(([\w.]+)\.y\*0\.5\+0\.5,0\.0,1\.0\)\)/g,c=e=>e.replace(s,`margoSkyHook($1)`).replaceAll(`*f.radiance.w`,``),l=e=>e!==void 0&&new RegExp(s.source).test(e);function u(t,n,r){let a=e=>e&&(t.includes(` f0:vec3f`)?e:e.replaceAll(`s.f0`,`vec3f(0.04)`)).replaceAll(`s.sw`,t.includes(` sw:f32`)?`s.sw`:`1.0`),o=t,s=(t,n)=>{if(typeof t==`string`?!o.includes(t):o.search(t)<0)throw e(`unsupported`,`PBR lighting hook point missing: ${t}; use matching @margoengine/gltf/pbr and effect package versions`);o=o.replace(t,n)},u=t.includes(`fn margoAmbientLayers(`);if(n.direct){let e=n.direct(`direct`,t.includes(`fn margoLightSide(`)?`margoLightSide(s.n,l)`:void 0);if(t.includes(`var<private> margoDirectVisible:vec3f=vec3f(1);`)&&e!==`direct`){let n=t.includes(`fn margoLit(`)?`margoLit(s,l,direct)`:`vec3f(1)`;s(/(?:let margoAmbient=[^;]*;)?var color=/,t=>`{let direct=${n};margoDirectVisible=${e};}\n  ${t}`),s(`direct+ambient(s)`,`direct*margoDirectVisible+ambient(s)`)}else s(`direct+ambient(s)`,e+`+ambient(s)`)}if(n.light){if(u){let e=o.split(`fn margoLocal`).length-1;s(`var color=`,`var color=margoLocal${e}(i,margoFront(s),v)+`),o+=`\nfn margoLocal${e}(i:Out,s:Surface,v:vec3f)->vec3f {return ${a(n.light)};}\n`}else s(`var color=`,`var color=`+a(n.light)+`+`)}let d=o.includes(`fn margoSkyHook(`);n.ambient&&((!d||l(n.ambient))&&s(/fn ambient\(s:Surface\)->vec3f \{[^}]*\}/,`fn ambient(s:Surface)->vec3f {return vec3f(0);}`),u&&s(`fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}`,()=>`fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return ${a(n.ambient)};}`),s(/var color=([^;]+)\+s\.emissive;/,(e,t)=>`let margoAmbient=${u?`margoAmbientLayers(i,s,v)`:a(n.ambient)};var color=${t}+s.emissive+margoAmbient;`));for(let[e,t]of[[`margoCoatAmbient`,n.coat],[`margoSheenAmbient`,n.sheen]])t&&o.includes(`fn ${e}(`)&&s(RegExp(`fn ${e}\\(s:Surface,v:vec3f\\)->vec3f \\{return [^;]*;\\}`),()=>`fn ${e}(s:Surface,v:vec3f)->vec3f {return ${t};}`);if(n.sky){if(d)throw e(`unsupported`,`Two sky lighting hooks on one shader; attach one HemisphereLight per engine`);let t=/let margoAmbient=([^;]*);/.exec(o)?.[1],r=/fn margoAmbientTerm\(i:Out,s:Surface,v:vec3f\)->vec3f \{return ([^;]*);\}/.exec(o)?.[1];t!==void 0&&!l(t)&&!l(r)&&s(`fn ambient(s:Surface)->vec3f {return vec3f(0);}`,`fn ambient(s:Surface)->vec3f {${o.includes(`fn margoHemisphere(`)?`return margoHemisphere(s);`:o.includes(`fn hemisphere_ambient(`)?`return hemisphere_ambient(s);`:`let f0=mix(vec3f(0.04),s.base.rgb,s.metal);return (s.base.rgb*(1.0-s.metal)+f0*0.5)*margoSkyHook(s.n)*s.occlusion;`}}`),o+=`
fn margoSkyHook(n:vec3f)->vec3f {return ${n.sky};}
`}(n.sky||d)&&(o=c(o));let f=`if(f.settings.w<0.5) {color=toDisplay(color);}`;if(n.output){let e=o.includes(f);s(e?f:`if(f.settings.w<0.5) {color=pbrNeutral(max(color,vec3f(0)));`,`color=${n.output(`select(color,pbrNeutral(max(color,vec3f(0))),f.settings.w<0.5)`)};if(f.settings.w<0.5) {${e?`color=select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308));}`:``}`)}return o=n.declarations+o,n.finish&&(o=n.finish(o)),r||i.set(n,r=new Map),r.size>=64&&r.clear(),r.set(t,o),o}var d=`fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
`;`${d}`;var f=[[`s.base.rgb*(1-s.metal)+`,`s.base.rgb*(1-s.metal)*(1-s.tr)+`],[`(1-s.metal)*s.base.rgb/`,`(1-s.metal)*(1-s.tr)*s.base.rgb/`]];function p(e){return!!e.tint&&!e.renderState&&!e.extension?.replacesPhysical}function ee(t){if(t.includes(` tr:f32`))return t;for(let[n,r]of[[`emissive:vec3f}`,`emissive:vec3f, tr:f32}`],...f]){if(!t.includes(n))throw e(`unsupported`,`PBR shader transmission target missing: ${n}; use matching @margoengine/gltf/pbr and materials versions`);t=t.replaceAll(n,r)}return t}var m=`fn margoCotangentFrame(n:vec3f,dp1:vec3f,dp2:vec3f,duv1:vec2f,duv2:vec2f)->mat3x3f {
  let ps=max(max(max(abs(dp1.x),abs(dp1.y)),max(abs(dp1.z),abs(dp2.x))),max(abs(dp2.y),abs(dp2.z)));
  let us=max(max(abs(duv1.x),abs(duv1.y)),max(abs(duv2.x),abs(duv2.y)));
  if(ps>0.0&&us>0.0){
    let q1=dp1/ps;let q2=dp2/ps;let w1=duv1/us;let w2=duv2/us;
    let r1=cross(q2,n);let r2=cross(n,q1);let side=select(-1.0,1.0,dot(q1,r1)>=0.0);
    let gu=(r1*w1.x+r2*w2.x)*side;let gv=(r1*w1.y+r2*w2.y)*(-side);
    let longest=max(dot(gu,gu),dot(gv,gv));
    if(longest>1e-30){let k=inverseSqrt(longest);return mat3x3f(gu*k,gv*k,n);}
  }
  let axis=select(vec3f(1,0,0),vec3f(0,0,1),abs(n.x)>0.5);let t=normalize(axis-n*dot(n,axis));
  return mat3x3f(t,cross(n,t),n);
}
`,h=(e,t)=>`a2/(3.14159265*pow(max(dot(cross(${e},${t}),cross(${e},${t})),step(nh,0.0))+a2*nh*nh,2.0))`,g=`a2/(3.14159265*pow(max(dot(cross(n,h),cross(n,h)),step(nh,0.0))+a2*nh*nh,2.0))`,_=`2*nl*nv/max(nl*sqrt(a2+(1-a2)*nv*nv)+nv*sqrt(a2+(1-a2)*nl*nl),1e-30)`,v=e=>`fn ${e}L(x:f32,w:f32)->f32 {
  let p=mix(vec4f(21.5473,3.82987,0.19823,-1.9776),vec4f(25.3245,3.32435,0.16801,-1.27393),w);
  return p.x/(1.0+p.y*pow(max(x,1e-12),p.z))+p.w*x+mix(-4.32054,-4.85967,w);
}
fn ${e}Lambda(c:f32,w:f32)->f32 {return exp(select(2.0*${e}L(0.5,w)-${e}L(1.0-c,w),${e}L(c,w),c<0.5));}
fn ${e}(roughness:f32,nl:f32,nv:f32,nh:f32)->f32 {
  let sheenAlpha=max(roughness,0.0001)*max(roughness,0.0001);let sheenSpread=1.0/sheenAlpha;
  let sheenD=(2.0+sheenSpread)*pow(max(1.0-nh*nh,0.0),0.5*sheenSpread)/6.2831853;
  let sheenW=(1.0-sheenAlpha)*(1.0-sheenAlpha);
  return sheenD/max((1.0+${e}Lambda(nv,sheenW)+${e}Lambda(nl,sheenW))*4.0*nl*nv,0.000001);
}
`,y=e=>`fn ${e}(nv:f32,nl:f32,v:vec3f,l:vec3f)->f32 {return clamp((nv+nl)/max(length(v+l),0.0001),0.0,1.0);}
`,b={size:16,k:.1,p:.45},te=[-3.22,-3.22,-3.22,-3.22,-3.22,-3.22,-3.88,-4.89,-6.25,-8.85,-12.09,-21.05,-24,-24,-24,-24,-1.75,-1.75,-1.85,-2.07,-2.41,-2.9,-3.58,-4.31,-5.96,-8.09,-11.84,-18.65,-24,-24,-24,-24,-1.7,-1.68,-1.75,-1.95,-2.27,-2.71,-3.3,-4.1,-5.24,-6.67,-9.55,-14.09,-22.96,-24,-24,-24,-1.69,-1.63,-1.68,-1.86,-2.14,-2.52,-2.99,-3.64,-4.47,-5.72,-7.48,-10.23,-14.98,-24,-24,-24,-1.67,-1.59,-1.62,-1.78,-2.02,-2.33,-2.73,-3.23,-3.88,-4.74,-5.93,-7.64,-10.31,-14.93,-24,-24,-1.65,-1.55,-1.57,-1.7,-1.9,-2.16,-2.48,-2.88,-3.37,-4.01,-4.84,-5.97,-7.6,-10.17,-14.96,-24,-1.62,-1.49,-1.5,-1.62,-1.79,-2,-2.27,-2.59,-2.97,-3.45,-4.05,-4.84,-5.92,-7.52,-10.24,-19.62,-1.61,-1.43,-1.42,-1.52,-1.66,-1.85,-2.07,-2.33,-2.63,-3,-3.46,-4.04,-4.8,-5.87,-7.58,-12.5,-1.53,-1.33,-1.31,-1.4,-1.53,-1.68,-1.87,-2.08,-2.33,-2.63,-2.98,-3.42,-3.99,-4.75,-5.9,-8.73,-1.42,-1.21,-1.18,-1.26,-1.37,-1.5,-1.66,-1.84,-2.05,-2.29,-2.57,-2.92,-3.36,-3.91,-4.73,-6.47,-1.27,-1.05,-1.02,-1.08,-1.18,-1.3,-1.44,-1.59,-1.77,-1.97,-2.2,-2.49,-2.83,-3.26,-3.86,-4.98,-1.09,-.86,-.83,-.88,-.97,-1.08,-1.2,-1.34,-1.49,-1.66,-1.86,-2.1,-2.38,-2.71,-3.17,-3.93,-.87,-.65,-.61,-.66,-.75,-.85,-.96,-1.08,-1.22,-1.37,-1.54,-1.75,-1.98,-2.26,-2.62,-3.16,-.64,-.43,-.39,-.44,-.52,-.62,-.72,-.84,-.97,-1.1,-1.26,-1.44,-1.65,-1.88,-2.17,-2.58,-.43,-.22,-.18,-.24,-.32,-.41,-.51,-.62,-.74,-.87,-1.02,-1.18,-1.37,-1.57,-1.82,-2.13,-.28,-.09,-.05,-.1,-.18,-.27,-.37,-.48,-.59,-.71,-.85,-1,-1.16,-1.34,-1.55,-1.81],ne=(e,t=te)=>`const ${e}Table=array<f32,256>(${t.map(e=>Number.isInteger(e)?e+`.0`:e).join(`,`)});
fn ${e}(mu:f32,roughness:f32)->f32 {
  let sheenR=clamp(roughness,0.0001,1.0);let sheenMu=clamp(mu,0.0001,1.0);
  let sheenU=pow(sheenMu*(sheenR+${b.k})/(sheenR+${b.k}*sheenMu),${b.p})*15.0;let sheenV=sqrt(clamp(roughness,0.0,1.0))*15.0;
  let sheenI=min(u32(sheenU),14u);let sheenJ=min(u32(sheenV),14u);let sheenS=sheenU-f32(sheenI);let sheenT=sheenV-f32(sheenJ);
  let sheenN=sheenJ*16u+sheenI;
  let sheenLog=mix(mix(${e}Table[sheenN],${e}Table[sheenN+1u],sheenS),mix(${e}Table[sheenN+16u],${e}Table[sheenN+17u],sheenS),sheenT);
  return clamp(exp(sheenLog)/sheenR,0.0,1.0);
}
`,re=`fn margoDielectricFresnel(f0:vec3f,weight:f32,c:f32)->vec3f {return f0+(weight-f0)*pow(1.0-c,5.0);}
fn margoFresnelPeak(fresnel:vec3f)->f32 {return max(fresnel.r,max(fresnel.g,fresnel.b));}
`,x=`fn margoBumpGradient(n:vec3f,p:vec3f,dhdx:f32,dhdy:f32,facing:bool)->vec3f {
  let sx=dpdx(p); let sy=dpdy(p); let r1=cross(sy,n); let r2=cross(n,sx);
  let det=dot(sx,r1)*select(-1.0,1.0,facing); let o=abs(det)*n-sign(det)*(dhdx*r1+dhdy*r2);
  return select(n,normalize(o),dot(o,o)>0.0);
}
`,S=(e,t)=>t===1/0?0:Math.min(-Math.log(Math.max(e,1e-6))/t,1e30),C=`fn margoScatterShares(extinction:vec3f,color:vec3f,anisotropy:f32,depth:f32)->mat2x3f {
  let m=clamp(color,vec3f(0),vec3f(1)); let d=4.09712+4.20863*m-sqrt(9.59217+41.6808*m+17.7126*m*m);
  let absorbed=extinction*d*d; let scattered=max(min((extinction-absorbed)*(1-anisotropy),extinction),vec3f(0));
  return mat2x3f(1-exp(-scattered*depth),exp(-(absorbed+scattered)*depth));
}
`,w=`fn hemisphere_ambient(s:Surface)->vec3f {
  let f0=mix(vec3f(0.04),s.base.rgb,s.metal);
  let hemisphere=mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0));
  return (s.base.rgb*(1-s.metal)+f0*0.5)*hemisphere*f.radiance.w*s.occlusion;
}
// Keep the established lighting-effect splice point for optional environment plugins.
fn ambient(s:Surface)->vec3f {
  return hemisphere_ambient(s);
}
fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {
  let h=(v+l)/max(length(v+l),0.0001);
  let nl=clamp(dot(s.n,l),0.0,1.0); let nv=clamp(dot(s.n,v),0.0001,1.0); let nh=clamp(dot(s.n,h),0.0,1.0); let vh=clamp(dot(v,h),0.0,1.0);
  let a=s.roughness*s.roughness; let a2=a*a; let d=${h(`s.n`,`h`)};
  let g=${_};
  let dielectric=vec3f(0.04); let f0=mix(vec3f(0.04),s.base.rgb,s.metal); let fresnel=f0+(1-f0)*pow(1-vh,5.0);
  return ((1-(dielectric+(1-dielectric)*pow(1-vh,5.0)))*(1-s.metal)*s.base.rgb/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))*nl*f.radiance.rgb*f.light.w;
}
`,T=`
${d}
${m}
struct Frame {
  camera:mat4x4f, model:mat4x4f, normalMatrix:mat4x4f, view:mat4x4f,
  eye:vec4f, light:vec4f, radiance:vec4f, base:vec4f, factors:vec4f, emissive:vec4f,
  settings:vec4f, coordsA:vec4f, coordsB:vec4f
}
@group(0) @binding(0) var<uniform> f:Frame;
@group(1) @binding(0) var baseMap:texture_2d<f32>;
@group(1) @binding(1) var baseSampler:sampler;
@group(1) @binding(2) var mrMap:texture_2d<f32>;
@group(1) @binding(3) var mrSampler:sampler;
@group(1) @binding(4) var normalMap:texture_2d<f32>;
@group(1) @binding(5) var normalSampler:sampler;
@group(1) @binding(6) var aoMap:texture_2d<f32>;
@group(1) @binding(7) var aoSampler:sampler;
@group(1) @binding(8) var emissiveMap:texture_2d<f32>;
@group(1) @binding(9) var emissiveSampler:sampler;
struct Input {
  @location(0) position:vec4f, @location(1) normal:vec4f,
  @location(2) tangent:vec4f, @location(3) uv:vec4f, @location(4) color:vec4f
}
struct Out {
  @builtin(position) @invariant clip:vec4f, @location(0) position:vec3f, @location(1) normal:vec3f,
  @location(2) tangent:vec4f, @location(3) uv:vec4f, @location(4) color:vec4f
}
@vertex fn vertex(i:Input)->Out {
  var o:Out; let p=f.model*vec4f(i.position.xyz,1);
  o.clip=f.camera*p; o.position=p.xyz;
  o.normal=(f.normalMatrix*vec4f(i.normal.xyz,0)).xyz;
  o.tangent=vec4f((f.model*vec4f(i.tangent.xyz,0)).xyz,i.tangent.w*f.coordsB.y);
  o.normal=select(vec3f(0,1,0),o.normal,dot(o.normal,o.normal)>0.0);
  o.uv=i.uv; o.color=i.color; return o;
}
fn uv(i:Out, coord:f32)->vec2f {return select(i.uv.xy,i.uv.zw,coord>0.5);}
struct Surface {base:vec4f, n:vec3f, roughness:f32, metal:f32, occlusion:f32, emissive:vec3f}
fn surface(i:Out,front:bool)->Surface {
  var s:Surface;
  s.base=textureSample(baseMap,baseSampler,uv(i,f.coordsA.x))*f.base*i.color;
  let mr=textureSample(mrMap,mrSampler,uv(i,f.coordsA.y));
  let sampledNormal=textureSample(normalMap,normalSampler,uv(i,f.coordsA.z)).xyz*2-1;
  s.occlusion=mix(1.0,textureSample(aoMap,aoSampler,uv(i,f.coordsA.w)).r,f.factors.w);
  s.emissive=textureSample(emissiveMap,emissiveSampler,uv(i,f.coordsB.x)).rgb*f.emissive.xyz;
  s.roughness=clamp(mr.g*f.factors.x,0.045,1.0); s.metal=clamp(mr.b*f.factors.y,0.0,1.0);
  let facing=front==(f.coordsB.y>0); let n=normalize(i.normal)*select(-1.0,1.0,facing);
  var t=i.tangent.xyz-n*dot(n,i.tangent.xyz);
  var b=cross(n,t)*i.tangent.w;
  let dp1=dpdx(i.position); let dp2=dpdy(i.position); let duv1=dpdx(uv(i,f.coordsA.z)); let duv2=dpdy(uv(i,f.coordsA.z));
  if(abs(i.tangent.w)<0.5) {
    // No glTF tangents: the per-pixel cotangent frame (shared/tangent-frame.js; B points up the image).
    let frame=margoCotangentFrame(n,dp1,dp2,duv1,duv2); t=frame[0]; b=frame[1];
  } else {
    if(dot(t,t)<0.000000000001){t=cross(n,select(vec3f(1,0,0),vec3f(0,1,0),abs(n.x)>0.9));}
    t=normalize(t); b=cross(n,t)*i.tangent.w;
  }
  s.n=normalize(t*sampledNormal.x*f.factors.z+b*sampledNormal.y*f.factors.z+n*sampledNormal.z);
  if(!facing&&f.settings.z<0.5){discard;}
  if(f.settings.x>0.5&&f.settings.x<1.5&&s.base.a<f.settings.y){discard;}
  return s;
}
${w}@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); let v=normalize(f.eye.xyz-i.position); let l=f.light.xyz;
  let direct=direct_light(s,v,l);
  var color=direct+ambient(s)+s.emissive;
  if(f.settings.w<0.5) {color=pbrNeutral(max(color,vec3f(0))); color=select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308));}
  return vec4f(color,select(1.0,s.base.a,f.settings.x>1.5));
}
@fragment fn gbuffer(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); return vec4f(normalize((f.view*vec4f(s.n,0)).xyz),-(f.view*vec4f(i.position,1)).z);
}
@fragment fn ambientFragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); return vec4f(ambient(s),select(1.0,s.base.a,f.settings.x>1.5));
}
`,E=`
${d}
${m}
struct Frame {
  camera:mat4x4f, model:mat4x4f, normalMatrix:mat4x4f, view:mat4x4f,
  eye:vec4f, light:vec4f, radiance:vec4f, base:vec4f, factors:vec4f, emissive:vec4f,
  settings:vec4f, coordsA:vec4f, coordsB:vec4f, ext:vec4f, uvt:array<vec4f,26>, coat:vec4f, specular:vec4f, sheen:vec4f
}
@group(0) @binding(0) var<uniform> f:Frame;
override margoFaceTest:bool=true;
override margoAlphaTest:bool=true;
@group(1) @binding(0) var baseMap:texture_2d<f32>;
@group(1) @binding(1) var baseSampler:sampler;
@group(1) @binding(2) var mrMap:texture_2d<f32>;
@group(1) @binding(3) var mrSampler:sampler;
@group(1) @binding(4) var normalMap:texture_2d<f32>;
@group(1) @binding(5) var normalSampler:sampler;
@group(1) @binding(6) var aoMap:texture_2d<f32>;
@group(1) @binding(7) var aoSampler:sampler;
@group(1) @binding(8) var emissiveMap:texture_2d<f32>;
@group(1) @binding(9) var emissiveSampler:sampler;
struct Input {
  @location(0) position:vec4f, @location(1) normal:vec4f,
  @location(2) tangent:vec4f, @location(3) uv:vec4f, @location(4) color:vec4f
}
struct Out {
  @builtin(position) @invariant clip:vec4f, @location(0) position:vec3f, @location(1) normal:vec3f,
  @location(2) tangent:vec4f, @location(3) uv:vec4f, @location(4) color:vec4f
}
@vertex fn vertex(i:Input)->Out {
  var o:Out; let p=f.model*vec4f(i.position.xyz,1);
  o.clip=f.camera*p; o.position=p.xyz;
  o.normal=(f.normalMatrix*vec4f(i.normal.xyz,0)).xyz;
  o.tangent=vec4f((f.model*vec4f(i.tangent.xyz,0)).xyz,i.tangent.w*f.coordsB.y);
  o.normal=select(vec3f(0,1,0),o.normal,dot(o.normal,o.normal)>0.0);
  o.uv=i.uv; o.color=i.color; return o;
}
fn uv(i:Out, k:f32)->vec2f {let m=f.uvt[u32(k)*2]; let p=vec3f(select(i.uv.xy,i.uv.zw,m.w>0.5),1); return vec2f(dot(m.xyz,p),dot(f.uvt[u32(k)*2+1].xyz,p));}
struct Surface {base:vec4f, n:vec3f, roughness:f32, metal:f32, occlusion:f32, emissive:vec3f}
fn surface(i:Out,front:bool)->Surface {
  var s:Surface;
  s.base=textureSample(baseMap,baseSampler,uv(i,f.coordsA.x))*f.base*i.color;
  let mr=textureSample(mrMap,mrSampler,uv(i,f.coordsA.y));
  let sampledNormal=textureSample(normalMap,normalSampler,uv(i,f.coordsA.z)).xyz*2-1;
  s.occlusion=mix(1.0,textureSample(aoMap,aoSampler,uv(i,f.coordsA.w)).r,f.factors.w);
  s.emissive=textureSample(emissiveMap,emissiveSampler,uv(i,f.coordsB.x)).rgb*f.emissive.xyz;
  s.roughness=clamp(mr.g*f.factors.x,0.045,1.0); s.metal=clamp(mr.b*f.factors.y,0.0,1.0);
  let facing=front==(f.coordsB.y>0); let n=normalize(i.normal)*select(-1.0,1.0,facing);
  var t=i.tangent.xyz-n*dot(n,i.tangent.xyz);
  var b=cross(n,t)*i.tangent.w;
  let dp1=dpdx(i.position); let dp2=dpdy(i.position); let duv1=dpdx(uv(i,f.coordsA.z)); let duv2=dpdy(uv(i,f.coordsA.z));
  if(abs(i.tangent.w)<0.5) {
    // No glTF tangents: the per-pixel cotangent frame (shared/tangent-frame.js; B points up the image).
    let frame=margoCotangentFrame(n,dp1,dp2,duv1,duv2); t=frame[0]; b=frame[1];
  } else {
    if(dot(t,t)<0.000000000001){t=cross(n,select(vec3f(1,0,0),vec3f(0,1,0),abs(n.x)>0.9));}
    t=normalize(t); b=cross(n,t)*i.tangent.w;
  }
  s.n=normalize(t*sampledNormal.x*f.factors.z+b*sampledNormal.y*f.factors.z+n*sampledNormal.z);
  if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}
  if(margoAlphaTest&&f.settings.x>0.5&&f.settings.x<1.5&&s.base.a<f.settings.y){discard;}
  return s;
}
${w}@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); let v=normalize(f.eye.xyz-i.position); let l=f.light.xyz;
  let direct=direct_light(s,v,l);
  var color=direct+ambient(s)+s.emissive;
  if(f.ext.x>0.5){color=s.base.rgb;}
  if(f.settings.w<0.5) {color=pbrNeutral(max(color,vec3f(0))); color=select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308));}
  return vec4f(color,select(1.0,s.base.a,f.settings.x>1.5));
}
@fragment fn gbuffer(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); return vec4f(normalize((f.view*vec4f(s.n,0)).xyz),-(f.view*vec4f(i.position,1)).z);
}
@fragment fn ambientFragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); return vec4f(ambient(s),select(1.0,s.base.a,f.settings.x>1.5));
}
`;function D(e){let t=O.get(e);return t===void 0&&(O.size>=64&&O.clear(),t=`override margoFaceTest:bool=true;
override margoAlphaTest:bool=true;
`+e.replace(`if(!facing&&f.settings.z<0.5)`,`if(margoFaceTest&&!facing&&f.settings.z<0.5)`).replace(`if(f.settings.x>0.5&&f.settings.x<1.5&&s.base.a<f.settings.y)`,`if(margoAlphaTest&&f.settings.x>0.5&&f.settings.x<1.5&&s.base.a<f.settings.y)`),O.set(e,t)),t}var O=new Map,k=`@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {`,A=new Map;function ie(t,n){let r=A.get(n),i=r?.get(t);if(i!==void 0)return i;if(t.split(k).length!==2)throw e(`failed`,`PBR transparency hook point missing or used twice; keep exactly one hook marker in the shader source`);let a=n.includes(`var<private> margoCoverage:u32`);return i=n+t.replace(k,`fn margoShade(i:Out,front:bool)->vec4f {`)+`\n@fragment fn transparent(i:Out,@builtin(front_facing) front:bool${a?`,@builtin(sample_mask) mask:u32`:``})->MargoTransparent {${a?`margoCoverage=mask;`:``}return margoTransparent(margoShade(i,front),i);}\n`,r||(A.size>=8&&A.clear(),A.set(n,r=new Map)),r.size>=64&&r.clear(),r.set(t,i),i}function ae(e){let t=/@fragment fn margoTint\(i:Out,@builtin\(front_facing\) front:bool\)/.test(e);return e.replace(/@fragment fn margoTint\(i:Out(?:,@builtin\(front_facing\) front:bool)?\)->@location\(0\) vec4f \{/,`fn margoTintShade(i:Out${t?`,front:bool`:``})->vec4f {`)+`\n@fragment fn margoTint(i:Out${t?`,@builtin(front_facing) front:bool`:``})->MargoTransparent {return margoTransparentTint(margoTintShade(i${t?`,front`:``}));}\n`}var j=new Map;function oe(t,n,r){let i=r?`${r}\n${t}`:t,a=j.get(n),o=a?.get(i);if(o!==void 0)return o;if(t.split(k).length!==2)throw e(`failed`,`PBR capture hook point missing or used twice; keep exactly one hook marker in the shader source`);let s=t.includes(`fn layers(`)?`layers(s,v,f.light.xyz,vec3f(1))-layers(s,v,f.light.xyz,vec3f(0))`:`vec3f(1)`,c=r?`(${s})*(${r})`:s;return o=n+t.replace(k,`fn margoShade(i:Out,front:bool)->vec4f {`)+`\n@fragment fn capture(i:Out,@builtin(front_facing) front:bool)->MargoCapture {${n.includes(`var<private> margoBeauty:`)?`margoBeauty=margoShade(i,front);`:`if(false){_=margoShade(i,front);}`}let s=surface(i,front);let v=normalize(f.eye.xyz-i.position);${n.includes(`var<private> margoPosition:`)?`margoPosition=i.position;`:``}return margoCapture(s,v,${c});}\n`,a||(j.size>=8&&j.clear(),j.set(n,a=new Map)),a.size>=64&&a.clear(),a.set(i,o),o}var M=[`clearcoat`,`clearcoatRoughness`,`clearcoatNormal`,`transmission`,`sheenColor`,`sheenRoughness`,`specular`,`specularColor`],se=[`iridescence`,`iridescenceThickness`,`anisotropy`,`diffuseTransmission`,`diffuseTransmissionColor`,`bump`,`multiscatter`,`thickness`,`diffuseRoughness`],N=e=>`textureSample(${e}Map,${e}Sampler,uv(i,${M.indexOf(e)+5}))`;function P(t,n){for(let[r,i]of n){if(typeof r==`string`?!t.includes(r):!r.test(t))throw e(`failed`,`PBR shader patch target missing: `+r+`; the shader source changed, update the patch`);t=typeof r==`string`?t.replaceAll(r,i):t.replace(r,i)}return t}var F,I=()=>F??=P(E,J(N,M.map((e,t)=>`@group(1) @binding(${10+t*2}) var ${e}Map:texture_2d<f32>;\n@group(1) @binding(${11+t*2}) var ${e}Sampler:sampler;`).join(`
`))),L,R=()=>I(),z=new Map,B=[0,4,9,12,17,19],V=[10,11,16];function H(e,t,n=e.length){let r=t=>e[t]?.index,i=r(t);if(!e[t])return-1;if(typeof i!=`number`)return t;let a=-1,o=-1,s=-1;for(let t=5;t<n;t++)e[t]&&r(t)===i&&(B.includes(t)?a=a<0?t:a:(o=o<0?t:o,s<0&&!V.includes(t)&&(s=t)));return B.includes(t)?a:V.includes(t)?a>=0?a:o:a>=0?s:o}function U(e,t=!1){let r=+t;for(let t=5;t<13;t++){let n=H(e,t,13);r=r*9+(n<0?0:n-4)}let i=z.get(r);if(i!==void 0)return i;i=I();for(let t=0;t<M.length;t++){let n=H(e,t+5,13);if(n===t+5)continue;let r=M[t];i=i.replace(`@group(1) @binding(${10+t*2}) var ${r}Map:texture_2d<f32>;`,``).replace(`@group(1) @binding(${11+t*2}) var ${r}Sampler:sampler;`,``).replaceAll(N(r),n>=0?`textureSample(${M[n-5]}Map,${M[n-5]}Sampler,uv(i,${t+5}))`:r===`clearcoatNormal`?`vec4f(0.5,0.5,1,1)`:`vec4f(1)`)}return t&&(i=n(i)),z.set(r,i),i}var W=new Map,G=`
fn margoTintShare(i:Out,tint:vec3f)->vec4f {
  let nv=clamp(abs(dot(normalize(i.normal),normalize(f.eye.xyz-i.position))),0.0001,1.0); let w=pow(1-nv,5.0);
  let ior=(f.ext.y-1)/(f.ext.y+1); let f0=min(ior*ior*f.specular.rgb,vec3f(1)); let fr=f0+(1-f0)*w;
  let share=tint*(1-f.specular.w*max(fr.r,max(fr.g,fr.b)))*(1-max(f.sheen.r,max(f.sheen.g,f.sheen.b))*margoSheenAlbedo(nv,clamp(f.sheen.w,0.0,1.0)))*(1-f.coat.x*(0.04+0.96*w));
  return margoTintEncode(share);
}
fn margoTintEncode(share:vec3f)->vec4f {
  return vec4f(select(share,select(share*12.92,1.055*pow(share,vec3f(1.0/2.4))-0.055,share>=vec3f(0.0031308)),f.settings.w<0.5),1);
}
fn margoTintSurface(i:Out,s:Surface,tint:vec3f)->vec4f {
  let nv=clamp(abs(dot(s.n,normalize(f.eye.xyz-i.position))),0.0001,1.0); let fr=margoTintFresnel(s,nv);
  return margoTintEncode(tint*(1-s.metal)*(1-margoFresnelPeak(fr))*(1-max(s.sh.r,max(s.sh.g,s.sh.b))*margoSheenAlbedo(nv,s.sh.w))*(1-s.cc*(0.04+0.96*pow(1-nv,5.0))));
}
@fragment fn margoTint(i:Out)->@location(0) vec4f {return margoTintShare(i,vec3f(f.coordsB.zw,f.ext.z));}
`;function K(e,t,n,r){if(!t||!/^storage\b/.test(t))return n;if(/^array\s*<[^,<>]+(<[^<>]*>)?\s*>$/.test(r))return`arrayLength(&${n})`;let i=(RegExp(`struct\\s+${r}\\s*\\{([^}]*)\\}`).exec(e)?.[1])?.split(`,`).map(e=>e.trim()).filter(Boolean).pop(),a=i&&/^(?:@\w+\s*\([^)]*\)\s*)*(\w+)\s*:\s*array\s*<[^,<>]+(<[^<>]*>)?\s*>$/.exec(i);return a?`arrayLength(&${n}.${a[1]})`:n}function q(e){let t=Array.from(e.matchAll(/((?:@\w+\s*\([^)]*\)\s*)+)var(?:\s*<([^>]+)>)?\s+(\w+)\s*:\s*([^;]+);/g)).filter(([,e])=>/@group\s*\(/.test(e)&&/@binding\s*\(/.test(e)).map(([,,t,n,r])=>`_=${K(e,t,n,r.trim())};`).join(``);return e.replace(/@fragment fn margoTint\(i:Out(?:,@builtin\(front_facing\) front:bool)?\)->@location\(0\) vec4f \{/,`@fragment fn margoTint(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {${t}`)}function ce(e){let t=(q(e)+(e.includes(`fn margoThickness(`)?``:`fn margoThickness(i:Out)->f32 {return 1.0;}`)+`
// thicknessFactor is in mesh units; attenuationDistance is in world units (KHR_materials_volume).
// The native route estimates a slab. Transform its refracted ray into mesh space before crossing that slab.
fn margoVolumeTint(i:Out,s:Surface,m:mat3x3f)->vec3f {
  let incident=normalize(i.position-f.eye.xyz);
  let ray=refract(incident,s.n,1.0/select(max(f.ext.y,1.0),1e30,f.ext.y==0.0));
  let c0=cross(m[1],m[2]); let c1=cross(m[2],m[0]); let c2=cross(m[0],m[1]);
  let determinant=abs(dot(m[0],c0));
  let normal=normalize(vec3f(dot(m[0],i.normal),dot(m[1],i.normal),dot(m[2],i.normal)));
  let projected=abs(dot(vec3f(dot(c0,ray),dot(c1,ray),dot(c2,ray)),normal));
  let raw=vec3f(f.coordsB.zw,f.ext.z); let scale=margoThickness(i);
  let depth=select(vec3f(0),select(raw*scale,vec3f(-1),raw<vec3f(0)),scale>0.0);
  if(projected==0.0){return select(vec3f(0),vec3f(1),depth==vec3f(0));}
  return select(exp(-max(depth,vec3f(0))*(determinant/projected)),vec3f(0),depth<vec3f(0));
}
`).replace(`return margoTintShare(i,vec3f(f.coordsB.zw,f.ext.z));`,`let s=surface(i,front);return margoTintSurface(i,s,s.base.rgb*s.tr*margoVolumeTint(i,s,mat3x3f(f.model[0].xyz,f.model[1].xyz,f.model[2].xyz)));`);if(e.includes(`o.mirror=margoS;`)){let e=/struct Out \{([^}]+)\}/.exec(t)[1],n=0;for(;[n,n+1,n+2].some(t=>e.includes(`@location(${t})`));)n++;t=t.replace(/(struct Out \{[^}]*?)\n\}/,`$1, @location(${n}) @interpolate(flat) volume0:vec3f, @location(${n+1}) @interpolate(flat) volume1:vec3f, @location(${n+2}) @interpolate(flat) volume2:vec3f\n}`).replace(`o.mirror=margoS;`,`o.mirror=margoS; o.volume0=margoI[0].xyz; o.volume1=margoI[1].xyz; o.volume2=margoI[2].xyz;`).replace(`margoVolumeTint(i,s,mat3x3f(f.model[0].xyz,f.model[1].xyz,f.model[2].xyz))`,`margoVolumeTint(i,s,mat3x3f(i.volume0,i.volume1,i.volume2))`)}return t}function le(e=L??=n(R())){let t=W.get(e);return t===void 0&&(t=P(e,[[`@fragment fn fragment(`,`fn margoFront(s:Surface)->Surface {var o=s; o.base=vec4f(s.base.rgb*(1-s.tr),s.base.a); return o;}
fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}
fn margoAmbientLayers(i:Out,s:Surface,v:vec3f)->vec3f {return margoAmbientTerm(i,margoFront(s),v);}
@fragment fn fragment(`]])+`fn margoTintFresnel(s:Surface,nv:f32)->vec3f {return ${e.includes(` ir:vec4f`)?`mix(margoDielectricFresnel(s.f0,s.sw,nv),s.ir.rgb,s.ir.w)`:`margoDielectricFresnel(s.f0,s.sw,nv)`};}`+G,W.set(e,t)),t}var J=(e,t)=>[[`emissive:vec3f}`,`emissive:vec3f, f0:vec3f, sw:f32, tr:f32, th:f32, cn:vec3f, cc:f32, cr:f32, sh:vec4f}`],[`var emissiveSampler:sampler;`,`var emissiveSampler:sampler;
`+t],[`  if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}`,`  let ior=(f.ext.y-1)/(f.ext.y+1); s.sw=f.specular.w*${e(`specular`)}.a; s.f0=min(ior*ior*f.specular.rgb*${e(`specularColor`)}.rgb,vec3f(1))*s.sw;
  s.tr=f.coat.w*${e(`transmission`)}.r; s.th=1; let cm=${e(`clearcoatNormal`)}.xyz*2-1; s.cn=normalize(t*cm.x*f.coat.z+b*cm.y*f.coat.z+n*cm.z);
  s.cc=f.coat.x*${e(`clearcoat`)}.r; s.cr=clamp(f.coat.y*${e(`clearcoatRoughness`)}.g,0.045,1.0);
  // Sheen: linear colour (factor x map rgb) and roughness (factor x map alpha), no floor (KB3297d).
  s.sh=vec4f(f.sheen.rgb*${e(`sheenColor`)}.rgb,clamp(f.sheen.w*${e(`sheenRoughness`)}.a,0.0,1.0));
  if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}`],[`mix(vec3f(0.04),s.base.rgb,s.metal)`,`mix(s.f0,s.base.rgb,s.metal)`],...f,[`let fresnel=f0+(1-f0)*pow(1-vh,5.0);`,`let fresnel=f0+(mix(vec3f(s.sw),vec3f(1),s.metal)-f0)*pow(1-vh,5.0);`],[`return ((1-(dielectric+(1-dielectric)*pow(1-vh,5.0)))*(1-s.metal)`,`return ((1-margoFresnelPeak(margoDielectricFresnel(s.f0,s.sw,vh)))*(1-s.metal)`],[`@fragment fn fragment(`,`${a}\n${re}fn ggx(n:vec3f,v:vec3f,l:vec3f,r:f32)->f32 {
  let h=normalize(v+l); let nl=clamp(dot(n,l),0.0,1.0); let nv=clamp(dot(n,v),0.0001,1.0); let nh=clamp(dot(n,h),0.0,1.0);
  let a2=pow(r,4.0); let d=${g}; let g=${_};
  return d*g/max(4*nl*nv,0.0001)*nl;
}
fn margoLayerSky(s:Surface)->vec3f {return mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.cn.y*0.5+0.5,0.0,1.0))*f.radiance.w*s.occlusion;}
// Ambient light of the clearcoat (before its Fresnel) and of the sheen (before its colour); lighting effects with an
// environment replace them (PBRHooks coat and sheen), the defaults are the hemisphere.
fn margoCoatAmbient(s:Surface,v:vec3f)->vec3f {return 0.5*margoLayerSky(s);}
${v(`margoSheenBRDF`)}${y(`margoSheenHalf`)}${ne(`margoSheenAlbedo`)}fn margoSheenAmbient(s:Surface,v:vec3f)->vec3f {return margoSheenAlbedo(clamp(dot(s.n,v),0.0001,1.0),s.sh.w)*mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0))*f.radiance.w*s.occlusion;}
// What the direct hook is asked about: the base's light, or a coat or sheen lobe with light of its own. Fragments with
// none of these stay zero, so a shadow hook skips them as it does on any other shader.
fn margoLit(s:Surface,l:vec3f,direct:vec3f)->vec3f {return vec3f(select(0.0,1.0,any(direct!=vec3f(0))||(f.light.w>0.0&&((s.cc>0.0&&dot(s.cn,l)>0.0)||(any(s.sh.rgb>vec3f(0))&&dot(s.n,l)>0.0)))));}
var<private> margoSheenSun:vec3f=vec3f(0);
fn layers(s:Surface,v:vec3f,l:vec3f,under:vec3f)->vec3f {
  // Both lobes are sunlight, so a shadow takes them with the base's direct light.
  let light=f.radiance.rgb*f.light.w*margoDirectVisible;
  // Sheen (KHR_materials_sheen) lies on the base surface, so it uses s.n. \`under\` holds direct and ambient light
  // together; its sun part, margoSheenSun, takes the punctual form with E(n.l) as well, the rest the ambient form; black
  // sheen leaves it exactly as it was and adds zero.
  let sheenNV=clamp(dot(s.n,v),0.0001,1.0); let sheenNL=clamp(dot(s.n,l),0.0,1.0);
  let sheenLobe=margoSheenBRDF(s.sh.w,sheenNL,sheenNV,margoSheenHalf(sheenNV,sheenNL,v,l))*sheenNL*light;
  let sheenMax=max(s.sh.r,max(s.sh.g,s.sh.b)); let sheenEV=margoSheenAlbedo(sheenNV,s.sh.w);
  let color=under*(1-sheenMax*sheenEV)-margoSheenSun*margoDirectVisible*sheenMax*max(margoSheenAlbedo(sheenNL,s.sh.w)-sheenEV,0.0)+s.sh.rgb*(sheenLobe+margoSheenAmbient(s,v));
  let fc=0.04+0.96*pow(1-clamp(dot(s.cn,v),0.0,1.0),5.0);
  return color*(1-s.cc*fc)+s.cc*fc*(ggx(s.cn,v,l,s.cr)*light+margoCoatAmbient(s,v));
}
@fragment fn fragment(`],[`  if(f.ext.x>0.5){color=s.base.rgb;}`,`  margoSheenSun=direct;
  color=layers(s,v,l,color);
  if(f.ext.x>0.5){color=s.base.rgb;}`]],ue,de=()=>ue??=I().replace(/@group\(1\) @binding\((\d+)\) var \w+:[^;]+;\n?/g,(e,t)=>+t<10?e:``).replace(/textureSample\((\w+)Map,\1Sampler,uv\(i,\d+\)\)/g,(e,t)=>t===`clearcoatNormal`?`vec4f(0.5,0.5,1,1)`:`vec4f(1)`),Y=`  color=layers(s,v,l,color);`,X=new Map;function fe(t,n){let r=X.get(n),i=r?.get(t);if(i!==void 0)return i;if(t.split(Y).length!==2)throw e(`failed`,`PBR transmission hook point missing or used twice; keep exactly one hook marker in the shader source`);return i=`@group(0) @binding(1) var<uniform> margoVolume:vec4f;
`+n+t.replace(Y,`  color=layers(s,v,l,color+margoTransmission(s,v,i));`),r||(X.size>=8&&X.clear(),X.set(n,r=new Map)),r.size>=64&&r.clear(),r.set(t,i),i}function pe(e,t){let n=[];return{slots:Array.from({length:Math.max(21,e.length)},(t,r)=>{if(r<5||!e[r])return-1;let i=H(e,r),a=n.indexOf(i);return a>=0?a:n.length===8?-1:n.push(i)-1}),...t}}var me=`fn margoAnisotropy(n:vec3f,t:vec3f,b:vec3f,a:vec3f)->vec4f {
  let d=a.xy*2-1; let dir=select(vec2f(1,0),d/length(d),dot(d,d)>1e-8); let r=vec2f(f.aniso.y*dir.x-f.aniso.z*dir.y,f.aniso.z*dir.x+f.aniso.y*dir.y);
  let ta=t*r.x+b*r.y; let o=ta-n*dot(n,ta); return vec4f(o/max(length(o),1e-6),f.aniso.x*a.z);
}
fn margoBent(s:Surface,v:vec3f)->vec3f {
  let b=cross(s.n,s.at.xyz); let bent=normalize(cross(cross(b,v),b)); return normalize(mix(bent,s.n,pow(1-s.at.w*(1-s.roughness),4.0)));
}
`,he=`fn margoEONE(mu:f32,r:f32)->f32 {let m=1-mu; return (1+r*m*(0.0571085289+m*(0.491881867+m*(-0.332181442+m*0.0714429953))))/(1+0.28779341*r);}
fn margoEONScatter(rho:vec3f,r:f32)->vec4f {let avg=(1+0.07248822*r)/(1+0.28779341*r); let c=clamp(rho,vec3f(0),vec3f(1)); return vec4f(c*c*avg/(1-c*(1-avg)),avg);}
fn margoEON(rho:vec3f,r:f32,nl:f32,nv:f32,st:f32)->vec3f {
  let t=st/select(1.0,max(max(nl,nv),0.0001),st>0.0); let m=margoEONScatter(rho,r);
  return rho*((1+r*t)/(1+0.28779341*r))+m.rgb*(max(1-margoEONE(nv,r),0.0)*max(1-margoEONE(nl,r),0.0)/max(1-m.a,0.0000001));
}
fn margoEONAlbedo(rho:vec3f,r:f32,nv:f32)->vec3f {let e=margoEONE(nv,r); return rho*e+margoEONScatter(rho,r).rgb*(1-e);}
`,Z=(e,t=!1,n=!1)=>`fn margoDirect(s:Surface,v:vec3f,l:vec3f)->vec3f {
  let h=normalize(v+l); let nl=clamp(dot(s.n,l),0.0,1.0); let nv=clamp(dot(s.n,v),0.0001,1.0); let nh=clamp(dot(s.n,h),0.0,1.0); let vh=clamp(dot(v,h),0.0,1.0);
  let f0=mix(s.f0,s.base.rgb,s.metal); let schlick=f0+(mix(vec3f(s.sw),vec3f(1),s.metal)-f0)*pow(1-vh,5.0);
  let fr=mix(schlick,s.ir.rgb,s.ir.w); let kd=mix(vec3f(1-margoFresnelPeak(margoDielectricFresnel(s.f0,s.sw,vh))),vec3f(1-max(s.ir.r,max(s.ir.g,s.ir.b))),s.ir.w); let a=s.roughness*s.roughness;
  ${e?`let t=s.at.xyz; let b=cross(s.n,t); let alt=mix(a,1.0,s.at.w*s.at.w); let a2=alt*a;
  let q=vec3f(a*dot(t,h),alt*dot(b,h),a2*nh); let w2=a2/max(dot(q,q),1e-12);
  let spec=a2*w2*w2/3.14159265*clamp(0.5/max(nl*length(vec3f(alt*dot(t,v),a*dot(b,v),nv))+nv*length(vec3f(alt*dot(t,l),a*dot(b,l),nl)),1e-6),0.0,1.0);`:`let a2=a*a; let spec=${h(`s.n`,`h`)}*0.5/max(nl*sqrt(a2+(1-a2)*nv*nv)+nv*sqrt(a2+(1-a2)*nl*nl),0.00005);`}
${n?`  let st=dot(v,l)-dot(s.n,v)*dot(s.n,l); let back=clamp(-dot(s.n,l),0.0,1.0);
`:``}  let diffuse=kd*(1-s.metal)*((1-s.tr)*(${n?`margoEON(s.base.rgb,s.dr.x,nl,nv,st)`:`s.base.rgb`}*(1-s.dt.w)*nl+${n?`margoEON(s.dt.rgb,s.dr.x,back,nv,st)*s.dt.w*back`:`s.dt.rgb*s.dt.w*clamp(-dot(s.n,l),0.0,1.0)`})${t?`+s.sc*nl`:``})/3.14159265;
  return diffuse+spec*fr*nl;
}
`,ge=e=>{let t=t=>e.diffuseRoughness?`margoEONAlbedo(${t},s.dr.x,s.dr.y)`:t;return`${e.diffuseTransmission?`fn margoLightSide(n:vec3f,l:vec3f)->vec3f {return select(n,-n,dot(n,l)<0.0);}
`:``}fn margoSky(n:vec3f)->vec3f {return mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(n.y*0.5+0.5,0.0,1.0));}
fn margoFront(s:Surface)->Surface {var o=s; o.base=vec4f(s.base.rgb*(1-s.tr)*(1-s.dt.w)${e.scatter?`+s.sc`:``},s.base.a); return o;}
fn margoHemisphere(s:Surface)->vec3f {
  let f0=mix(mix(s.f0,s.base.rgb,s.metal),s.ir.rgb,s.ir.w); let k=(1-s.metal)*(1-s.tr);
  return (${t(`s.base.rgb`)}*k*(1-s.dt.w)*margoSky(s.n)+${t(`s.dt.rgb`)}*k*s.dt.w*margoSky(-s.n)${e.scatter?`+s.sc*(1-s.metal)*margoSky(s.n)`:``}+f0*0.5*margoSky(s.n))*f.radiance.w*s.occlusion;
}
fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}
fn margoAmbientLayers(i:Out,s:Surface,v:vec3f)->vec3f {
  var o=margoFront(s);${e.anisotropy?` o.n=margoBent(s,v);`:``} var sum=margoAmbientTerm(i,o,v);${e.diffuseRoughness?`
  var d=o; d.metal=0; let lambert=margoAmbientTerm(i,d,v); d.base=vec4f(o.base.rgb+(margoEONAlbedo(s.base.rgb,s.dr.x,s.dr.y)-s.base.rgb)*(1-s.tr)*(1-s.dt.w),o.base.a); sum+=(1-s.metal)*(margoAmbientTerm(i,d,v)-lambert);`:``}${e.iridescence?`
  var m=o; m.metal=1; m.base=vec4f(s.ir.rgb,1); sum+=s.ir.w*margoAmbientTerm(i,m,v);
  m.base=vec4f(mix(s.f0,o.base.rgb,o.metal),1); sum-=s.ir.w*margoAmbientTerm(i,m,v);`:``}${e.diffuseTransmission?`
  var back=s; back.n=-s.n; back.metal=0; back.base=vec4f(${t(`s.dt.rgb`)},1); let k=s.dt.w*(1-s.metal)*(1-s.tr); sum+=k*margoAmbientTerm(i,back,-v);
  back.base=vec4f(0,0,0,1); sum-=k*margoAmbientTerm(i,back,-v);`:``}
  return sum;
}
`},_e=e=>`  {
    let bumpUV=uv(i,18); let bumpBase=${e(`bump`,`bumpUV`)}.r;
    let bumpScale=f.bump.x*select(1.0,length(n*mat3x3f(f.model[0].xyz,f.model[1].xyz,f.model[2].xyz)),f.bump.y>0.5);
    s.n=margoBumpGradient(s.n,i.position,(${e(`bump`,`bumpUV+dpdx(bumpUV)`)}.r-bumpBase)*bumpScale,(${e(`bump`,`bumpUV+dpdy(bumpUV)`)}.r-bumpBase)*bumpScale,facing);
  }
`,ve=e=>`  {
    let scatterColor=f.scatter.rgb*${e(`multiscatter`)}.rgb;
    let scatterDepth=f.extinction.w*${e(`thickness`)}.g*length(n*mat3x3f(f.model[0].xyz,f.model[1].xyz,f.model[2].xyz));
    let scatterShares=margoScatterShares(f.extinction.rgb,scatterColor,f.scatter.w,scatterDepth);
    s.sc=(s.tr+(1-s.tr)*s.dt.w)*scatterShares[0]*clamp(scatterColor,vec3f(0),vec3f(1));
    s.dt=vec4f(s.dt.rgb*scatterShares[1],s.dt.w);
  }
`,Q=new Map;function ye(e){let t=e.slots.join()+ +e.iridescence+ +e.anisotropy+ +e.diffuseTransmission+ +!!e.bump+ +!!e.scatter+ +!!e.packedBase+ +!!e.diffuseRoughness,i=Q.get(t);if(i!==void 0)return i;let a=[...M,...se],o=Math.max(-1,...e.slots)+1,s=(t,n)=>{let r=a.indexOf(t)+5,i=e.slots[r];return i>=0?`textureSample(margoMap${i},margoSampler${i},${n??`uv(i,${r})`})`:t===`clearcoatNormal`?`vec4f(0.5,0.5,1,1)`:t===`anisotropy`?`vec4f(1,0.5,1,1)`:`vec4f(1)`};return i=P(E,[...J(s,Array.from({length:o},(e,t)=>`@group(1) @binding(${10+t*2}) var margoMap${t}:texture_2d<f32>;\n@group(1) @binding(${11+t*2}) var margoSampler${t}:sampler;`).join(`
`)),[`uvt:array<vec4f,26>`,`uvt:array<vec4f,${e.slots.length*2}>`],[`sheen:vec4f
}`,`sheen:vec4f, iri:vec4f, aniso:vec4f, dtr:vec4f, bump:vec4f, scatter:vec4f, extinction:vec4f
}`],[`sh:vec4f}`,`sh:vec4f, ir:vec4f, at:vec4f, dt:vec4f${e.scatter?`, sc:vec3f`:``}${e.diffuseRoughness?`, dr:vec2f`:``}}`],[`  if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}`,`${e.bump?_e(s):``}  s.ir=${e.iridescence?`vec4f(margoIridescence(mix(s.f0,s.base.rgb,s.metal),clamp(dot(s.n,normalize(f.eye.xyz-i.position)),0.0,1.0),mix(f.iri.z,f.iri.w,${s(`iridescenceThickness`)}.g),f.iri.y),f.iri.x*${s(`iridescence`)}.r)`:`vec4f(0)`};
  s.at=${e.anisotropy?`margoAnisotropy(s.n,t,b,${s(`anisotropy`)}.xyz)`:`vec4f(0)`};
  s.dt=${e.diffuseTransmission?`vec4f(f.dtr.yzw*${s(`diffuseTransmissionColor`)}.rgb,f.dtr.x*${s(`diffuseTransmission`)}.a)`:`vec4f(0)`};
${e.scatter?ve(s):``}${e.diffuseRoughness?`  s.dr=vec2f(f.aniso.w*${s(`diffuseRoughness`)}.r,clamp(dot(s.n,normalize(f.eye.xyz-i.position)),0.0001,1.0));\n`:``}  if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}`],[/fn ambient\(s:Surface\)->vec3f \{[^}]*\}/,`fn ambient(s:Surface)->vec3f {return margoHemisphere(s);}`],[`return ((1-margoFresnelPeak(margoDielectricFresnel(s.f0,s.sw,vh)))*(1-s.metal)*(1-s.tr)*s.base.rgb/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))*nl*`,`return margoDirect(s,v,l)*`],[`@fragment fn fragment(`,(e.bump?x:``)+(e.iridescence?r:``)+(e.anisotropy?me:``)+(e.scatter?C:``)+(e.diffuseRoughness?he:``)+Z(e.anisotropy,e.scatter,e.diffuseRoughness)+ge(e)+`@fragment fn fragment(`]])+`fn margoThickness(i:Out)->f32 {return ${s(`thickness`)}.g;}fn margoTintFresnel(s:Surface,nv:f32)->vec3f {return ${e.iridescence?`mix(margoDielectricFresnel(s.f0,s.sw,nv),s.ir.rgb,s.ir.w)`:`margoDielectricFresnel(s.f0,s.sw,nv)`};}`+G,e.packedBase&&(i=n(i)),Q.size>=64&&Q.clear(),Q.set(t,i),i}var be=`struct MargoView {camera:mat4x4f, view:mat4x4f, eye:vec4f, light:vec4f, radiance:vec4f, flags:vec4f}
@group(0) @binding(3) var<uniform> margoView:MargoView;
`,xe=/\bf\.(camera|view|eye|light|radiance)\b|\bf\.settings\.w\b/g,$=new Map;function Se(e){let t=$.get(e);if(t===void 0){$.size>=256&&$.clear();let n=e.replace(xe,(e,t)=>t?`margoView.`+t:`margoView.flags.x`);t=n===e?e:be+n,$.set(e,t)}return t}export{ye as C,q as S,le as _,R as a,p as b,T as c,ae as d,ce as f,ie as g,fe as h,H as i,U as l,ee as m,D as n,S as o,de as p,E as r,Se as s,B as t,a as u,o as v,pe as x,oe as y};