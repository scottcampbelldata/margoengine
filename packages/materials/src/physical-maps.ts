// Private sparse map specialization for constructed PhysicalMaterial surfaces.
// Logical slots stay stable even when texture views and samplers are shared.
export function physicalMapsShader(
  source: string,
  group: number,
  slots: readonly (readonly [number, number] | null)[],
): string {
  const sample = (k: number): string => {
    const slot = slots[k];
    return slot
      ? `textureSample(margoPhysicalMap${slot[0]},margoPhysicalSampler${slot[1]},margoPhysicalUV(i,${k}))`
      : k === 2 || k === 7
        ? 'vec4f(0.5,0.5,1,1)'
        : k === 15
          ? 'vec4f(1,0.5,1,1)'
          : 'vec4f(1)';
  };
  const textures = new Set<number>(),
    samplers = new Set<number>();
  for (const slot of slots)
    if (slot) {
      textures.add(slot[0]);
      samplers.add(slot[1]);
    }
  const declarations =
    `struct MargoPhysicalMaps {uvt:array<vec4f,34>,volume:vec4f}
@group(${group}) @binding(200) var<uniform> margoPhysicalMaps:MargoPhysicalMaps;
` +
    [...textures]
      .map((k) => `@group(${group}) @binding(${201 + k}) var margoPhysicalMap${k}:texture_2d<f32>;`)
      .join('\n') +
    '\n' +
    [...samplers].map((k) => `@group(${group}) @binding(${240 + k}) var margoPhysicalSampler${k}:sampler;`).join('\n') +
    `
fn margoPhysicalUV(i:Out,k:u32)->vec2f {
  let a=margoPhysicalMaps.uvt[k*2]; let p=vec3f(select(i.uv.xy,i.uv.zw,a.w>0.5),1);
  return vec2f(dot(a.xyz,p),dot(margoPhysicalMaps.uvt[k*2+1].xyz,p));
}
fn margoPhysicalFrame(i:Out,n:vec3f,k:u32)->mat3x3f {
  let dp1=dpdx(i.position); let dp2=dpdy(i.position);
  let duv1=dpdx(margoPhysicalUV(i,k)); let duv2=dpdy(margoPhysicalUV(i,k));
  let p1=cross(n,dp1); let p2=cross(dp2,n);
  var t=p2*duv1.x+p1*duv2.x; var b=p2*duv1.y+p1*duv2.y;
  // WebGPU's screen Y points down; normalize before squaring to retain subpixel derivatives.
  let orientation=sign(dot(cross(dp1,dp2),n));
  let largest=max(max(max(abs(t.x),abs(t.y)),abs(t.z)),max(max(abs(b.x),abs(b.y)),abs(b.z)));
  if(largest>0) {t/=largest; b/=largest; let scale=orientation*inverseSqrt(max(dot(t,t),dot(b,b))); t*=scale; b*=scale;}
  else {t=normalize(cross(n,select(vec3f(1,0,0),vec3f(0,1,0),abs(n.x)>0.9))); b=cross(n,t);}
  return mat3x3f(t,b,n);
}
`;
  let code = source.replace(/@group\(1\) @binding\(\d+\) var \w+:[^;]+;\n?/g, '');
  const base = ['base', 'mr', 'normal', 'ao', 'emissive'];
  for (let k = 0; k < base.length; k++) {
    const name = base[k];
    code = code.replace(
      new RegExp(`textureSample\\(${name}Map,${name}Sampler,uv\\(i,f\\.coords[AB]\\.\\w\\)\\)`, 'g'),
      sample(k),
    );
  }
  // The native normal frame must follow the mapped UV set and affine transform.
  code = code.replaceAll('uv(i,f.coordsA.z)', 'margoPhysicalUV(i,2)');
  if (slots[2]) code = code.replace('if(abs(i.tangent.w)<0.5)', 'if(true)');
  const edits: [string, string][] = [
    ['f.specular.rgb*vec4f(1).rgb', `f.specular.rgb*${sample(12)}.rgb`],
    ['f.specular.w*vec4f(1).a', `f.specular.w*${sample(11)}.a`],
    ['f.coat.w*vec4f(1).r', `f.coat.w*${sample(8)}.r`],
    ['s.th=1', `s.th=${sample(16)}.g`],
    ['let cm=vec4f(0.5,0.5,1,1).xyz', `let cm=${sample(7)}.xyz`],
    ['f.coat.x*vec4f(1).r', `f.coat.x*${sample(5)}.r`],
    ['f.coat.y*vec4f(1).g', `f.coat.y*${sample(6)}.g`],
    ['f.sheen.rgb*vec4f(1).rgb', `f.sheen.rgb*${sample(9)}.rgb`],
    ['f.sheen.w*vec4f(1).a', `f.sheen.w*${sample(10)}.a`],
    ['mix(f.iri.z,f.iri.w,vec4f(1).g)', `mix(f.iri.z,f.iri.w,${sample(14)}.g)`],
    ['f.iri.x*vec4f(1).r', `f.iri.x*${sample(13)}.r`],
    [
      'margoAnisotropy(s.n,t,b,vec4f(1,0.5,1,1).xyz)',
      slots[15]
        ? `margoAnisotropy(s.n,margoPhysicalFrame(i,n,15)[0],margoPhysicalFrame(i,n,15)[1],${sample(15)}.xyz)`
        : 'margoAnisotropy(s.n,t,b,vec4f(1,0.5,1,1).xyz)',
    ],
  ];
  for (const [from, to] of edits) code = code.replaceAll(from, to);
  if (slots[7])
    code = code.replace(
      's.cn=normalize(t*cm.x*f.coat.z+b*cm.y*f.coat.z+n*cm.z)',
      's.cn=normalize(margoPhysicalFrame(i,n,7)*vec3f(cm.xy*f.coat.z,cm.z))',
    );
  code = code.replace(
    /@fragment fn margoTint\(i:Out\)->@location\(0\) vec4f \{[^}]*\}/,
    '@fragment fn margoTint(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {let s=surface(i,front);return vec4f(s.base.rgb*s.tr*pow(margoPhysicalMaps.volume.yzw,vec3f(margoPhysicalMaps.volume.x*s.th)),1);}',
  );
  return declarations + code;
}
