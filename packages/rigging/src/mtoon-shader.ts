import { fault } from '../../shared/errors.js';
import { clusterBrdf } from '../../shared/light-terms.js';

// VRMC_materials_mtoon 1.0 equations; maps use independent affine UV rows.
const declarations = (group: number) => `
struct MToonFrame { rows:array<vec4f,26> }
@group(${group}) @binding(180) var<uniform> mt:MToonFrame;
${Array.from({ length: 6 }, (_, i) => `@group(${group}) @binding(${181 + i * 2}) var mtMap${i}:texture_2d<f32>;\n@group(${group}) @binding(${182 + i * 2}) var mtSampler${i}:sampler;`).join('\n')}
fn mtRaw(i:Out,k:u32)->vec2f {return select(i.uv.xy,i.uv.zw,mt.rows[8u+k*3u].w>0.5);}
fn mtTransform(p:vec2f,k:u32)->vec2f {let a=mt.rows[8u+k*3u];let b=mt.rows[9u+k*3u];return vec2f(dot(a.xyz,vec3f(p,1)),dot(b.xyz,vec3f(p,1)));}
fn mtAnimate(i:Out,p:vec2f)->vec2f {
 let mask=textureSampleLevel(mtMap5,mtSampler5,mtTransform(mtRaw(i,5u),5u),0.0).b;
 let t=mt.rows[5].w*mask;let a=mt.rows[6].z*t;let c=cos(a);let s=sin(a);let q=p-0.5;
 return vec2f(c*q.x+s*q.y,-s*q.x+c*q.y)+0.5+mt.rows[6].xy*t;
}
fn mtUV(i:Out,k:u32)->vec2f {return mtTransform(mtAnimate(i,mtRaw(i,k)),k);}
fn mtStep(nl:f32,shift:f32)->f32 {let width=1.0-mt.rows[4].y;let x=nl+shift;if(width==0.0){return select(0.0,1.0,x>=0.0);}return clamp(0.5+x/(2.0*width),0.0,1.0);}
fn mtDirect(base:vec3f,shade:vec3f,shift:f32,nl:f32)->vec3f {return mix(shade,base,mtStep(nl,shift));}
fn mtRim(i:Out,s:Surface,v:vec3f,lighting:vec3f)->vec3f {
 var x=vec3f(v.z,0,-v.x);if(dot(x,x)<1e-10){x=vec3f(f.view[0].x,f.view[1].x,f.view[2].x);}x=normalize(x);let y=cross(v,x);
 let uv=vec2f(dot(x,s.n),dot(y,s.n))*0.495+0.5;
 let matcap=textureSample(mtMap2,mtSampler2,mtTransform(uv,2u)).rgb*mt.rows[2].rgb*mt.rows[10u+2u*3u].y;
 let rim=pow(clamp(1.0-dot(s.n,v)+mt.rows[5].x,0.0,1.0),max(mt.rows[4].w,0.00001))*mt.rows[1].rgb;
 return (matcap+rim)*textureSample(mtMap3,mtSampler3,mtUV(i,3u)).rgb*mix(vec3f(1),lighting,mt.rows[5].y);
}
`;

const replace = (code: string, from: string | RegExp, to: string): string => {
  const next = code.replace(from, () => to);
  if (next === code)
    throw fault('unsupported', 'MToon shader contract changed; use matching rigging and gltf-pro versions');
  return next;
};
/** Internal standard PBR shader adapter; optional material, no renderer replacement. */
export function mtoonShader(code: string, group: number, outline = false): string {
  let out = code;
  out = replace(out, 'emissive:vec3f}', 'emissive:vec3f, mtShade:vec3f, mtShift:f32, f0:vec3f, sw:f32}');
  out = replace(out, '*f.base*i.color;', '*f.base;');
  out = replace(
    out,
    'return s;\n}',
    `s.mtShade=textureSample(mtMap0,mtSampler0,mtUV(i,0u)).rgb*mt.rows[0].rgb;
  s.mtShift=mt.rows[4].x+textureSample(mtMap1,mtSampler1,mtUV(i,1u)).r*mt.rows[13].x;
  s.metal=0; s.roughness=1;s.occlusion=1;s.f0=vec3f(0);s.sw=0; return s;\n}`,
  );
  out = replace(out, 'select(i.uv.xy,i.uv.zw,m.w>0.5),1)', 'mtAnimate(i,select(i.uv.xy,i.uv.zw,m.w>0.5)),1)');
  out = replace(
    out,
    /fn direct_light\(s:Surface,v:vec3f,l:vec3f\)->vec3f \{[^}]*\}/,
    'fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {return mtDirect(s.base.rgb,s.mtShade,s.mtShift,dot(s.n,l))*f.radiance.rgb*f.light.w;}',
  );
  out = replace(
    out,
    /fn hemisphere_ambient\(s:Surface\)->vec3f \{[^}]*\}/,
    'fn hemisphere_ambient(s:Surface)->vec3f {return s.base.rgb*mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0))*f.radiance.w;}',
  );
  // Layered hook contract lets global illumination be evaluated at three normals.
  out = replace(
    out,
    '@fragment fn fragment(',
    `fn margoFront(s:Surface)->Surface {return s;}
fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}
fn margoAmbientLayers(i:Out,s:Surface,v:vec3f)->vec3f {return margoAmbientTerm(i,s,v);}
@fragment fn fragment(`,
  );
  if (outline) {
    out = replace(
      out,
      'o.clip=f.camera*p; o.position=p.xyz;',
      `let n=normalize((f.normalMatrix*vec4f(i.normal.xyz,0)).xyz);
    o.uv=i.uv;
    let mask=textureSampleLevel(mtMap4,mtSampler4,mtUV(o,4u),0.0).g;
    var world=p;var clip=f.camera*p;
    if(mt.rows[7].x<1.5){world+=vec4f(n*mt.rows[6].w*mask,0);clip=f.camera*world;}
    else {let projected=(f.camera*vec4f(n,0));let dir=projected.xy-clip.xy*projected.w/clip.w;
      let aspect=mt.rows[7].y;let screen=vec2f(dir.x*aspect,dir.y);let len=length(screen);
      if(len>0){clip=vec4f(clip.xy+vec2f(screen.x/aspect,screen.y)/len*2.0*mt.rows[6].w*mask*clip.w,clip.zw);}}
    o.clip=clip; o.position=world.xyz;`,
    );
  }
  out = out.replace('if(abs(i.tangent.w)<0.5)', 'if(true)');
  return declarations(group) + out;
}
/** Final lighting composition, including IBL, local lights, rim and outlines. */
export function mtoonLit(code: string, outline = false): string {
  let out = code;
  // The two ambient functions include the composed environment and sky hooks.
  out = replace(
    out,
    '@fragment fn fragment(',
    `fn mtGI(i:Out,s:Surface,v:vec3f)->vec3f {
    var up=s;var down=s;up.n=vec3f(0,1,0);down.n=vec3f(0,-1,0);
    return mix(ambient(s)+margoAmbientTerm(i,s,v),
      (ambient(up)+ambient(down)+margoAmbientTerm(i,up,v)+margoAmbientTerm(i,down,v))*0.5,mt.rows[4].z);
  }
  @fragment fn fragment(`,
  );
  // Keep one ambient contribution, replace all composed ambient terms after extracting their definitions.
  out = out.replace(/let margoAmbient=[^;]*;/g, '');
  out = out.replace(/\+margoAmbient(?=[;+])/g, '');
  out = replace(out, '+ambient(s)', '+mtGI(i,s,v)');
  const clustered = out.includes(clusterBrdf);
  const fragment = out.slice(out.indexOf('@fragment fn fragment('));
  const equation = /var color=([^;]*);/.exec(fragment)?.[1];
  if (!equation)
    throw fault('unsupported', 'MToon lighting sum contract changed; use matching rigging and gltf-pro versions');
  // Evaluate the composed incident light with a white diffuse surface. This
  // retains every local-light and direct-shadow hook, without material colour.
  out = replace(
    out,
    '@fragment fn fragment(',
    `fn mtIncident(i:Out,s:Surface,v:vec3f)->vec3f {
    var white=s;white.base=vec4f(1);white.mtShade=vec3f(1);white.emissive=vec3f(0);
    ${clustered ? 'let savedShade=mtLocalShade;let savedShift=mtLocalShift;mtLocalShade=vec3f(1);mtLocalShift=white.mtShift;' : ''}
    let l=f.light.xyz;let direct=direct_light(white,v,l);
    let result=${equation.replace(/\bs\b/g, 'white')};
    ${clustered ? 'mtLocalShade=savedShade;mtLocalShift=savedShift;' : ''}
    return result;
  }
  @fragment fn fragment(`,
  );
  out = replace(
    out,
    'if(f.ext.x>0.5){color=s.base.rgb;}',
    `if(mt.rows[16].y>0.5||any(mt.rows[1].rgb!=vec3f(0))) {
      var incident=vec3f(1);if(mt.rows[5].y>0){incident=mtIncident(i,s,v);}
      color+=mtRim(i,s,v,incident);
    }
    ${outline ? 'if(mt.rows[7].x<0.5||mt.rows[6].w==0.0){discard;}color=mt.rows[3].rgb*mix(vec3f(1),color,mt.rows[5].z);' : ''}`,
  );
  // Clustered's material function receives the shade and shift through invocation-private values.
  if (out.includes(clusterBrdf)) {
    out = out.replace(
      'let s=surface(i,front); let v=',
      'let s=surface(i,front); mtLocalShade=s.mtShade;mtLocalShift=s.mtShift; let v=',
    );
    out = out
      .split('result+=' + clusterBrdf + '*nl*')
      .join('result+=mtDirect(base,mtLocalShade,mtLocalShift,dot(n,l))*');
    out = 'var<private> mtLocalShade:vec3f;var<private> mtLocalShift:f32;\n' + out;
  }
  return out;
}
