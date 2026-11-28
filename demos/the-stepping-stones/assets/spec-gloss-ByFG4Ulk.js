import{f as e,p as t,u as n,x as r}from"./index-Bd8B_KrP.js";import{extendedMaterials as i}from"./extended-guGRuT4t.js";var a=`KHR_materials_pbrSpecularGlossiness`,o=(e,t)=>{if(typeof e!=`number`||!Number.isFinite(e)||e<0||e>1)throw TypeError(`Invalid glTF spec/gloss ${t}; pass a finite number from 0 to 1`);return e},s=(e,t,n)=>{if(!Array.isArray(e)||e.length!==t||Array.from(e).some(e=>typeof e!=`number`))throw TypeError(`Invalid glTF spec/gloss ${n}; pass ${t} finite components from 0 to 1`);return Array.from(e,e=>o(e,n))},c=e=>{if(e!==void 0){if(!e||typeof e!=`object`||Array.isArray(e)||!Number.isSafeInteger(e.index)||e.index<0)throw TypeError(`Invalid glTF spec/gloss texture; pass a textureInfo with a nonnegative integer index`);return n(e),e}};function l(e){let t=e.extensions?.[a];if(t===void 0)return e;if(!t||typeof t!=`object`||Array.isArray(t))throw TypeError(`Invalid glTF spec/gloss extension; pass a material extension object`);let n=t,r=s(n.diffuseFactor===void 0?[1,1,1,1]:n.diffuseFactor,4,`diffuse`),i=s(n.specularFactor===void 0?[1,1,1]:n.specularFactor,3,`specular`),l=o(n.glossinessFactor===void 0?1:n.glossinessFactor,`glossiness`);return{...e,pbrMetallicRoughness:{baseColorFactor:r,baseColorTexture:c(n.diffuseTexture),roughnessFactor:l,metallicFactor:0},extensions:{...e.extensions,KHR_materials_specular:{specularColorFactor:i.map(e=>e*25),specularColorTexture:c(n.specularGlossinessTexture)},KHR_materials_ior:{ior:1.5}}}}var u=`
fn margoSpecGloss(d:vec3f,s:vec3f)->vec4f {
  let weights=vec3f(0.299,0.587,0.114);
  let db=sqrt(dot(d*d,weights)); let sb=sqrt(dot(s*s,weights));
  let share=1-max(s.r,max(s.g,s.b)); let qb=db*share/0.96+sb-0.08;
  let metal=select(clamp((-qb+sqrt(max(0.0,qb*qb-0.16*(0.04-sb))))/0.08,0.0,1.0),0.0,sb<0.04);
  let bd=d*share/(0.96*max(1-metal,0.000001));
  let bs=(s-vec3f(0.04*(1-metal)))/max(metal,0.000001);
  return vec4f(clamp(mix(bd,bs,metal*metal),vec3f(0),vec3f(1)),metal);
}
`,d={extensions:[a],convert:l,parse(e){let t=i.parse(e);return e[a]===void 0?t:{features:{iridescence:!1,anisotropy:!1,diffuseTransmission:!1,...t?.features,specularGlossiness:!0},maps:t?.maps??Array(8).fill(void 0),rows:t?.rows??Array(24).fill(0)}},plan:e,shader(e){let n=t(e);if(!e.specularGlossiness)return n;let i=e.slots[12],a=i>=0?`textureSample(margoMap${i},margoSampler${i},uv(i,12)).a`:`1.0`,o=`  return s;`;if(n.split(o).length!==2)throw r(`failed`,`Spec/gloss surface conversion anchor changed; update the optional material shader`);return u+n.replace(o,`
  if(f.ext.x<0.5){
    let converted=margoSpecGloss(s.base.rgb,s.f0);
    s.base=vec4f(converted.rgb,s.base.a); s.metal=converted.a;
    s.roughness=clamp(1-f.factors.x*${a},0.045,1.0);
    s.f0=vec3f(0.04); s.sw=1;
  }
${o}`)}};export{d as specGlossMaterials};