// Vertex displacement along the normal (@margoengine/materials `displacementMap`): position + normal * (map.r * scale +
// bias), in mesh space. One WGSL text for the material's beauty shader and for the depth passes that draw it as a
// shadow caster (@margoengine/shadows, @margoengine/clustered, @margoengine/staging, @margoengine/selection), which bind the material's feature uniform and map.
/** The materials feature uniform: [bumpScale, displacementScale, displacementBias, lightMapIntensity], two UV rows per map. */
export const featureStruct = 'struct MargoFeatures {values:vec4f,uvt:array<vec4f,8>}';
/** Displacement of vertex UVs `uv` (UV0 xy, UV1 zw) through the displacement map's UV rows (4 and 5). */
export const displacementWgsl = `fn margoDisplacement(uv:vec4f)->f32 {
  let a=margoFeatures.uvt[4]; let p=vec3f(select(uv.xy,uv.zw,a.w>0.5),1);
  return textureSampleLevel(margoDisplacementMap,margoDisplacementSampler,vec2f(dot(a.xyz,p),dot(margoFeatures.uvt[5].xyz,p)),0.0).r*margoFeatures.values.y+margoFeatures.values.z;
}
`;
/** The WGSL of a displacement bound at bindings 0-2 of `group`: `margoDisplacement(uv)`. */
export const displacementCode = (group) => `${featureStruct}
@group(${group}) @binding(0) var<uniform> margoFeatures:MargoFeatures;
@group(${group}) @binding(1) var margoDisplacementMap:texture_2d<f32>;
@group(${group}) @binding(2) var margoDisplacementSampler:sampler;
${displacementWgsl}`;
/**
 * A caster depth shader (80-byte PBR vertices, `@location(0) position:vec4f`, `@location(3) uv:vec4f`, a vertex stage
 * placing `vec4f(i.position.xyz,1)`) displaced by a ShadowPrimitive's `displacement`: its uniform, view and sampler at
 * bindings 0-2 of `group`. Reads the normal at location 1 (offset 16).
 */
export function displacedDepth(code, group) {
  const out = code
    .replace('@location(0) position:vec4f,', '@location(0) position:vec4f,@location(1) normal:vec4f,')
    .replace('vec4f(i.position.xyz,1)', 'vec4f(i.position.xyz+i.normal.xyz*margoDisplacement(i.uv),1)');
  if (out.split('margoDisplacement(i.uv)').length !== 2 || !out.includes('@location(1) normal:vec4f'))
    throw new TypeError('Displaced shadow casters need 80-byte PBR vertices; draw them with a PBR depth shader');
  return displacementCode(group) + out;
}
