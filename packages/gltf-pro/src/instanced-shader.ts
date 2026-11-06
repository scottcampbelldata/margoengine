import { margoError } from '../../shared/errors.js';
// Instanced vertex stage, patched after lighting and material effects (shader NodeMaterial's vertex nodes keep their anchor):
// the node matrix times the instance matrix, normals by its cofactor matrix (the inverse-transpose up to a positive scale,
// normalized per fragment), per-instance handedness for facing and tangents, tint and UV scale/offset.
const instancedCode = new Map<string, string>();
/** Patches a PBR shader's WGSL source so it reads per-instance transforms; results are cached by source text. */
export function instancedShader(code: string): string {
  let out = instancedCode.get(code);
  if (out !== undefined) return out;
  const edit = (from: string | RegExp, to: string) => {
    const next = out!.replace(from, to);
    if (next === out)
      throw margoError(
        'failed',
        'PBR instancing patch target missing; the shader source changed, update the patch: ' + from,
      );
    out = next;
  };
  out = code;
  edit(/(struct Out \{[^}]*?)\n\}/, '$1, @location(5) @interpolate(flat) mirror:f32\n}');
  edit(
    '@vertex fn vertex(i:Input)->Out {',
    `struct Instance {@location(5) m0:vec4f, @location(6) m1:vec4f, @location(7) m2:vec4f, @location(8) m3:vec4f, @location(9) tint:vec4f, @location(10) uvt:vec4f}
@vertex fn vertex(i:Input,k:Instance)->Out {
  let margoI=f.model*mat4x4f(k.m0,k.m1,k.m2,k.m3); let margoS=select(-1.0,1.0,dot(margoI[0].xyz,cross(margoI[1].xyz,margoI[2].xyz))>0);`,
  );
  edit('let p=f.model*vec4f(', 'let p=margoI*vec4f(');
  edit(
    // margoNormal: a shader node graph's normal after its positionNode.
    /o\.normal=\(f\.normalMatrix\*vec4f\((i\.normal\.xyz|margoNormal),0\)\)\.xyz;/,
    'o.normal=mat3x3f(cross(margoI[1].xyz,margoI[2].xyz),cross(margoI[2].xyz,margoI[0].xyz),cross(margoI[0].xyz,margoI[1].xyz))*$1*margoS;',
  );
  edit(
    '(f.model*vec4f(i.tangent.xyz,0)).xyz,i.tangent.w*f.coordsB.y)',
    '(margoI*vec4f(i.tangent.xyz,0)).xyz,i.tangent.w*margoS)',
  );
  // `vec4f(1)`: a materials Material with vertexColors false.
  edit(
    /o\.uv=i\.uv; o\.color=(i\.color|vec4f\(1\));/,
    'o.uv=i.uv*k.uvt.xyxy+k.uvt.zwzw; o.color=$1*k.tint; o.mirror=margoS;',
  );
  edit('let facing=front==(f.coordsB.y>0);', 'let facing=front==(i.mirror>0);');
  if (instancedCode.size >= 64) instancedCode.clear();
  instancedCode.set(code, out);
  return out;
}
/** Uniform blocks of `floats` floats one 64 KiB uniform binding holds (the WebGPU minimum of maxUniformBufferBindingSize). */
export const rowsPerBinding = (floats: number): number => Math.floor(65536 / (floats * 4));
const rowsCode = new Map<string, string>(),
  frameDeclaration = '@group(0) @binding(0) var<uniform> f:Frame;';
/**
 * Patches a finished instanced PBR shader (`instancedShader`, then every later edit) so each instance reads its own
 * uniform block: binding 0 becomes an array of `count` blocks, every `f.` read becomes a read of block `margoK`, and
 * the vertex stage and every fragment entry set `margoK` (`instance_index % count`, passed flat). A draw of more
 * instances binds one array per `count` of them and starts each at a multiple of `count` (`firstInstance`). The reads
 * go to the uniform array itself: copying the block into a private struct put its dynamically indexed UV rows in local
 * memory and cost 1.5 ms of GPU time on 4,096 boxes. Undefined when the shader uses `f` other than as `f.field` (a
 * local of that name, or `f` passed whole): such draws keep their own uniforms.
 */
export function rowsShader(code: string, count: number): string | undefined {
  const key = count + ':' + code;
  let out = rowsCode.get(key);
  if (out !== undefined) return out || undefined;
  out = code.includes(frameDeclaration) ? code.replace(/(?<![\w.])f\.(?=[A-Za-z_])/g, 'margoRows[margoK].') : '';
  if (out && /(?<![\w.])f(?!\w)/.test(out.replace(frameDeclaration, ''))) out = '';
  if (out) {
    const edit = (from: string | RegExp, to: string | ((match: string, ...groups: string[]) => string)) => {
      const next = out!.replace(from, to as string);
      if (next === out)
        throw margoError(
          'failed',
          'PBR instance rows patch target missing; the shader source changed, update the patch: ' + from,
        );
      out = next;
    };
    edit(
      frameDeclaration,
      `@group(0) @binding(0) var<uniform> margoRows:array<Frame,${count}>;\nvar<private> margoK:u32;`,
    );
    // The block's index travels to the fragment stage at the first free location.
    edit(/(struct Out \{[^}]*?)\n\}/, (_, body: string) => {
      let next = 0;
      for (const [, n] of body.matchAll(/@location\((\d+)\)/g)) next = Math.max(next, +n + 1);
      return `${body}, @location(${next}) @interpolate(flat) margoK:u32\n}`;
    });
    edit(
      '@vertex fn vertex(i:Input,k:Instance)->Out {',
      `@vertex fn vertex(i:Input,k:Instance,@builtin(instance_index) margoN:u32)->Out {margoK=margoN%${count}u;`,
    );
    edit('o.mirror=margoS;', 'o.mirror=margoS; o.margoK=margoK;');
    edit(/@fragment fn \w+\(i:Out[^)]*\)[^{]*\{/g, (head: string) => head + 'margoK=i.margoK;');
  }
  if (rowsCode.size >= 64) rowsCode.clear();
  rowsCode.set(key, out);
  return out || undefined;
}
