export const deformationShader = /* wgsl */ `
struct Vertex {position:vec4f,normal:vec4f,tangent:vec4f,uv:vec4f,color:vec4f}
struct Morph {position:vec4f,normal:vec4f,tangent:vec4f}
struct Influence {joints:vec4u,weights:vec4f}
@group(0) @binding(0) var<storage,read> source:array<Vertex>;
@group(0) @binding(1) var<storage,read_write> output:array<Vertex>;
@group(0) @binding(2) var<storage,read> morphs:array<Morph>;
@group(0) @binding(3) var<storage,read> weights:array<f32>;
@group(0) @binding(4) var<storage,read> boneMatrices:array<mat4x4f>;
@group(0) @binding(5) var<storage,read> influences:array<Influence>;
@group(0) @binding(6) var<uniform> counts:vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=counts.x){return;}
  var v=source[id.x];
  for(var morphIndex=0u;morphIndex<counts.y;morphIndex++) {
    let m=morphs[morphIndex*counts.x+id.x];let w=weights[morphIndex];
    v.position+=vec4f(m.position.xyz*w,0);v.normal+=vec4f(m.normal.xyz*w,0);v.tangent+=vec4f(m.tangent.xyz*w,0);
  }
  if(counts.z>0u) {
    let inf=influences[id.x];
    let skin=boneMatrices[inf.joints.x]*inf.weights.x+boneMatrices[inf.joints.y]*inf.weights.y+boneMatrices[inf.joints.z]*inf.weights.z+boneMatrices[inf.joints.w]*inf.weights.w;
    v.position=skin*vec4f(v.position.xyz,1);
    let normalMatrix=mat3x3f(cross(skin[1].xyz,skin[2].xyz),cross(skin[2].xyz,skin[0].xyz),cross(skin[0].xyz,skin[1].xyz));
    let handedness=sign(dot(skin[0].xyz,cross(skin[1].xyz,skin[2].xyz)));
    v.normal=vec4f(normalMatrix*v.normal.xyz*handedness,0);
    v.tangent=vec4f((skin*vec4f(v.tangent.xyz,0)).xyz,v.tangent.w*handedness);
  }
  v.normal=vec4f(normalize(v.normal.xyz),0);output[id.x]=v;
}
`;

/** The four-influence shader and its 32-byte storage stride remain unchanged. */
export const deformationShader8 = deformationShader
  .replace(
    'struct Influence {joints:vec4u,weights:vec4f}',
    'struct Influence {joints:vec4u,weights:vec4f,jointsExtra:vec4u,weightsExtra:vec4f}',
  )
  .replace(
    'boneMatrices[inf.joints.w]*inf.weights.w;',
    'boneMatrices[inf.joints.w]*inf.weights.w+boneMatrices[inf.jointsExtra.x]*inf.weightsExtra.x+boneMatrices[inf.jointsExtra.y]*inf.weightsExtra.y+boneMatrices[inf.jointsExtra.z]*inf.weightsExtra.z+boneMatrices[inf.jointsExtra.w]*inf.weightsExtra.w;',
  );
