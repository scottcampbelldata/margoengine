// gltf-pro PBRInstances vertex data, one 96-byte row per instance: model matrix columns (node space), RGBA tint and
// UV scale (xy) + offset (zw). Depth-only passes (shadows, staging) read it with the same locations as gltf-pro's shader.
export const instanceLayout = {
  arrayStride: 96,
  stepMode: 'instance',
  attributes: [5, 6, 7, 8, 9, 10].map((shaderLocation, i) => ({ shaderLocation, offset: i * 16, format: 'float32x4' })),
};
const instanceInput =
  '@location(5) m0:vec4f,@location(6) m1:vec4f,@location(7) m2:vec4f,@location(8) m3:vec4f,@location(9) tint:vec4f,@location(10) uvt:vec4f';
/** A depth/occluder shader whose vertex is `o.clip=f.camera*f.model*vec4f(i.position.xyz,1)` with 80-byte PBR input, drawn per instance. */
export const instancedDepth = (code) =>
  code
    .replace('@location(4) color:vec4f', '@location(4) color:vec4f,' + instanceInput)
    .replace('f.model*vec4f(', 'f.model*mat4x4f(i.m0,i.m1,i.m2,i.m3)*vec4f(')
    .replace('o.alpha=i.color.a;', 'o.uv=o.uv*i.uvt.xy+i.uvt.zw;o.alpha=i.color.a*i.tint.a;');
/** World matrix of instance `k` (node matrix times the instance's node-space matrix) into `out`. */
export function instanceMatrix(node, data, k, out) {
  const o = k * 24;
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] =
        node[r] * data[o + c * 4] +
        node[4 + r] * data[o + c * 4 + 1] +
        node[8 + r] * data[o + c * 4 + 2] +
        node[12 + r] * data[o + c * 4 + 3];
  return out;
}
