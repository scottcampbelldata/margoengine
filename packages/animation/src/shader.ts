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

/** Another way to blend bones: `Animation`'s `skinning` option. `@margoengine/animation/dqs` holds the one Margo ships. */
export interface SkinningMode {
  /** Names the mode in the arena's pipeline table and in errors. */
  readonly name: string;
  /** The batched compute shader, four influences or (`extra`) eight. */
  shader(extra: boolean): string;
  /** Rewrites a bone palette in place, 16 floats per bone, into what the shader reads. Runs after the palette is checked. */
  encode(palette: Float32Array): void;
}

/** Text a skinning mode puts into the batched shader: module-scope `functions`, and the `blend` that moves `v`. */
export interface SkinningShader {
  functions: string;
  blend: string;
}

const linearBlend = (extra: boolean) => /* wgsl */ `let skin=boneMatrices[s.bones+joints.x]*jointWeights.x+boneMatrices[s.bones+joints.y]*jointWeights.y+boneMatrices[s.bones+joints.z]*jointWeights.z+boneMatrices[s.bones+joints.w]*jointWeights.w${
  extra
    ? '+boneMatrices[s.bones+jointsExtra.x]*weightsExtra.x+boneMatrices[s.bones+jointsExtra.y]*weightsExtra.y+boneMatrices[s.bones+jointsExtra.z]*weightsExtra.z+boneMatrices[s.bones+jointsExtra.w]*weightsExtra.w'
    : ''
};
    v.position=skin*vec4f(v.position.xyz,1);
    let normalMatrix=mat3x3f(cross(skin[1].xyz,skin[2].xyz),cross(skin[2].xyz,skin[0].xyz),cross(skin[0].xyz,skin[1].xyz));
    let handedness=sign(dot(skin[0].xyz,cross(skin[1].xyz,skin[2].xyz)));
    v.normal=vec4f(normalMatrix*v.normal.xyz*handedness,0);
    v.tangent=vec4f((skin*vec4f(v.tangent.xyz,0)).xyz,v.tangent.w*handedness);`;

/**
 * Batched deformation (batch.ts): many primitives in one dispatch. Each workgroup deforms 64 vertices of one slot,
 * named by the work list (`work[0].x` workgroups, then a slot index and first vertex per workgroup); each slot record
 * gives where its vertices, deltas, weights, bones and influences start in the shared buffers. The per-vertex
 * arithmetic is the per-primitive shader's, term for term, so the output is the same bits. `extra`: eight influences.
 * `skin` replaces that arithmetic for a skinning mode.
 */
export function batchedDeformationShader(
  extra: boolean,
  skin: SkinningShader = { functions: '', blend: linearBlend(extra) },
): string {
  return /* wgsl */ `
struct Vertex {position:vec4f,normal:vec4f,tangent:vec4f,uv:vec4f,color:vec4f}
struct Morph {position:vec4f,normal:vec4f,tangent:vec4f}
struct Slot {source:u32,output:u32,count:u32,targets:u32,morphs:u32,weights:u32,bones:u32,joints:u32,influences:u32,pad0:u32,pad1:u32,pad2:u32}
@group(0) @binding(0) var<storage,read> source:array<Vertex>;
@group(0) @binding(1) var<storage,read_write> output:array<Vertex>;
@group(0) @binding(2) var<storage,read> morphs:array<Morph>;
@group(0) @binding(3) var<storage,read> weights:array<f32>;
@group(0) @binding(4) var<storage,read> boneMatrices:array<mat4x4f>;
@group(0) @binding(5) var<storage,read> influences:array<vec4u>;
@group(0) @binding(6) var<storage,read> slots:array<Slot>;
@group(0) @binding(7) var<storage,read> work:array<vec2u>;
${skin.functions}
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) group:vec3u,@builtin(num_workgroups) groups:vec3u,@builtin(local_invocation_index) lane:u32) {
  let item=group.y*groups.x+group.x;
  if(item>=work[0].x){return;}
  let entry=work[item+1u];let s=slots[entry.x];let i=entry.y+lane;
  if(i>=s.count){return;}
  var v=source[s.source+i];
  for(var morphIndex=0u;morphIndex<s.targets;morphIndex++) {
    let m=morphs[s.morphs+morphIndex*s.count+i];let w=weights[s.weights+morphIndex];
    v.position+=vec4f(m.position.xyz*w,0);v.normal+=vec4f(m.normal.xyz*w,0);v.tangent+=vec4f(m.tangent.xyz*w,0);
  }
  if(s.joints>0u) {
    let at=s.influences+i*${extra ? 4 : 2}u;let joints=influences[at];let jointWeights=bitcast<vec4f>(influences[at+1u]);${
      extra ? 'let jointsExtra=influences[at+2u];let weightsExtra=bitcast<vec4f>(influences[at+3u]);' : ''
    }
    ${skin.blend}
  }
  v.normal=vec4f(normalize(v.normal.xyz),0);output[s.output+i]=v;
}
`;
}
