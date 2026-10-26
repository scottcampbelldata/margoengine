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
    'o.normal=(f.normalMatrix*vec4f(i.normal.xyz,0)).xyz;',
    'o.normal=mat3x3f(cross(margoI[1].xyz,margoI[2].xyz),cross(margoI[2].xyz,margoI[0].xyz),cross(margoI[0].xyz,margoI[1].xyz))*i.normal.xyz*margoS;',
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
