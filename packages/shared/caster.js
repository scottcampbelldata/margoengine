// Depth-only caster drawing shared by @margoengine/shadows (cascades), @margoengine/clustered (local and clustered
// shadow maps), @margoengine/staging (contact shadows) and @margoengine/selection (picking): the vertex layout of core
// (24-byte) and gltf-pro (80-byte) geometry, the displacement bind group, the per-draw uniform and the draw itself.
import { instanceLayout } from './instances.js';
import { clipDeclaration, clipDistances, sectionShader } from './section.js';
import { meshRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';

/**
 * Vertex buffers of a caster with `stride` 24 (core: position) or 80 (gltf-pro: position, uv for `displaced`,
 * skin joints and weights), plus the per-instance matrices when `instanced`.
 */
export function casterBuffers(stride, displaced = false, instanced = false) {
  return [
    {
      arrayStride: stride,
      attributes:
        stride === 80
          ? [
              { shaderLocation: 0, offset: 0, format: 'float32x4' },
              ...(displaced ? [{ shaderLocation: 1, offset: 16, format: 'float32x4' }] : []),
              { shaderLocation: 3, offset: 48, format: 'float32x4' },
              { shaderLocation: 4, offset: 64, format: 'float32x4' },
            ]
          : [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
    },
    ...(instanced ? [instanceLayout] : []),
  ];
}

/** A depth-only caster pipeline (`layout: 'auto'`, less-equal depth into depth32float, line lists for `lines`). */
export const casterPipeline = (device, module, stride, displaced, instanced, lines) =>
  device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertex', buffers: casterBuffers(stride, displaced, instanced) },
    fragment: { module, entryPoint: 'fragment', targets: [] },
    ...(lines ? { primitive: { topology: 'line-list' } } : {}),
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
  });

/** The per-primitive draw records of `node` in `draws`, created empty on first use. */
export function nodeRecords(draws, node) {
  let records = draws.get(node);
  if (!records) draws.set(node, (records = new Map()));
  return records;
}

/**
 * The runtime object of a caster `source` (a core mesh handle or a shadowPrimitives source): a disposed source throws
 * MargoError 'disposed' (`noun` names it in the message), a core mesh of another engine than `engine` 'attached'.
 */
export function casterRuntime(source, engine, noun) {
  if ('disposed' in source && source.disposed) throw new MargoError('disposed', `${noun} is disposed; add a live mesh`);
  const runtime = 'id' in source ? meshRuntime(source) : source;
  if ('id' in runtime) {
    runtime.check();
    if (engine && runtime.engine !== engine)
      throw new MargoError('attached', 'Shadow mesh belongs to another engine; use objects created by the same engine');
  }
  return runtime;
}

/** The bind group of a displaced caster (shared/displacement.js): its feature uniform, map and sampler; else undefined.
 * `layout` is called only when there is a displacement. A node graph's displacement can read none of its bindings (a
 * constant move). An automatic layout (`pipeline.getBindGroupLayout`) then has no such group, since a default pipeline
 * layout stops at the highest group the shader uses (WebGPU 10.1.1), so no group is made: WebKit refuses that layout,
 * where Chromium hands back an empty one. `explicit` says `layout` is a group of the caller's own pipeline layout, which
 * needs a bind group even when it is empty. */
export const displacementGroup = (device, layout, displacement, explicit = false) => {
  if (!displacement) return undefined;
  const entries = displacement.entries?.() ?? [
    { binding: 0, resource: { buffer: displacement.buffer } },
    { binding: 1, resource: displacement.view },
    { binding: 2, resource: displacement.sampler },
  ];
  return entries.length || explicit ? device.createBindGroup({ layout: layout(), entries }) : undefined;
};

/**
 * WGSL of a material's opacity map (materials `alphaMap`, green channel, its own UV rows 0 and 1 of the feature uniform):
 * the uniform, view and sampler at bindings `first` to `first` + 2 of `group`, and `margoOpacityAt` of both UV sets.
 */
export const opacityCode = (group, first = 4) => `struct MargoOpacity {values:vec4f,uvt:array<vec4f,8>}
@group(${group}) @binding(${first}) var<uniform> margoOpacity:MargoOpacity;
@group(${group}) @binding(${first + 1}) var margoOpacityMap:texture_2d<f32>;
@group(${group}) @binding(${first + 2}) var margoOpacitySampler:sampler;
fn margoOpacityAt(uv:vec4f)->f32 {let a=margoOpacity.uvt[0]; let p=vec3f(select(uv.xy,uv.zw,a.w>0.5),1); return textureSampleLevel(margoOpacityMap,margoOpacitySampler,vec2f(dot(a.xyz,p),dot(margoOpacity.uvt[1].xyz,p)),0.0).g;}
`;

/**
 * A caster shader (80-byte PBR vertices, the fragment reading its alpha map at `i.uv` or a local `uv`) whose cut-out also
 * multiplies by a material's opacity map, bound at 4-6 of `group`. Apply it after `instancedDepth`.
 */
export function opacityDepth(code, group) {
  const out = code
    .replace(/struct (\w*Out) \{/, 'struct $1 {@location(3) margoUV:vec4f,')
    .replace('o.uv=select(', 'o.margoUV=i.uv;o.uv=select(')
    .replace('o.uv=o.uv*i.uvt.xy+i.uvt.zw;', '$&o.margoUV=o.margoUV*i.uvt.xyxy+i.uvt.zwzw;')
    .replace(/textureSample(?:Level)?\(\w+,\w+,(?:i\.)?uv(?:,0)?\)\.a\*/, '$&margoOpacityAt(i.margoUV)*');
  if (!out.includes('o.margoUV=i.uv;') || !out.includes('margoOpacityAt(i.margoUV)*'))
    throw new TypeError('Opacity-mapped shadow casters need 80-byte vertices; draw them with a PBR depth shader');
  return opacityCode(group) + out;
}

/**
 * A caster shader whose fragment discards what uniform `name`'s planes cut away, bound at `binding` of group 0. The vertex
 * stage must place `o.clip=f.camera*...` and the output struct be `Out`, with location 2 free. Apply it last. `hardware`
 * cuts by `clipDistances` instead, for a union of planes on a device with the feature.
 */
export const clippedDepth = (code, binding, name, hardware = false) =>
  hardware
    ? clipDistances(clipDeclaration(0, binding, name) + code.replace(/o.clip=f.camera\*([^;]+);/, 'let world=$1;o.clip=f.camera*world;'), name, 'world.xyz')
    : sectionShader(
        code
          .replace('struct Out {', 'struct Out {@location(2) position:vec3f,')
          .replace(/o.clip=f.camera\*([^;]+);/, 'let world=$1;o.clip=f.camera*world;o.position=world.xyz;'),
        0,
        binding,
        name,
      );

/** The bind group entries of a caster's `opacity`, from binding `first` (see `opacityCode`). */
export const opacityEntries = (opacity, first = 4) => [
  { binding: first, resource: { buffer: opacity.buffer } },
  { binding: first + 1, resource: opacity.view },
  { binding: first + 2, resource: opacity.sampler },
];

/**
 * A caster shader that leaves vertex alpha out of its cut-out, for a primitive with `vertexAlpha: false` (materials
 * `vertexColors: false`, whose colour pass reads white, or gltf-pro vertices whose colour alpha is all 1). An instance's
 * tint still counts. Apply it after `instancedDepth`. The stage hands on 1 - alpha and the fragment reads 1 minus that:
 * interpolating a constant 0 is exact on every rasterizer, a constant 1 is not (0.99999994 in some pixels), which cut
 * texels whose alpha equals the cutoff (glTF 2.0 3.9.4 keeps them). Code writing `o.alpha` more than once keeps the plain
 * form.
 */
export const solidVertexDepth = (code) => {
  const solid = code.replace('o.alpha=i.color.a', 'o.alpha=1.0');
  if (solid.match(/\bo\.alpha=/g)?.length !== 1) return solid;
  return solid.replace(/\bo\.alpha=([^;]*);/, 'o.alpha=1.0-($1);').replace(/\bi\.alpha\b/g, '(1.0-i.alpha)');
};

/** A cleared depth-only pass descriptor; set `depthStencilAttachment.view` before each use. */
export const depthPassDescriptor = () => ({
  colorAttachments: [],
  depthStencilAttachment: { view: undefined, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
});

/**
 * Writes one caster draw's uniform (`values`: 36 floats, 44 with an alpha `transform`): the light's `view` matrix, the
 * node matrix, alpha, cutoff and texture coordinate set, then uploads it to `uniform` and draws primitive `p`.
 */
export function drawCaster(pass, device, pipeline, group, uniform, values, view, p, transform, displaced, instances) {
  values.set(view);
  values.set(p.node.matrix, 16);
  values[32] = p.alpha ?? 1;
  values[33] = p.cutoff ?? 0;
  values[34] = p.texCoord ?? 0;
  if (transform) values.set(transform, 36);
  device.queue.writeBuffer(uniform, 0, values);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  if (displaced) pass.setBindGroup(1, displaced);
  // No offset argument for a caster at its buffer's start: the call stays the one it always was.
  pass.setVertexBuffer(0, p.vertex, p.vertexOffset || undefined);
  pass.setIndexBuffer(p.index, 'uint32');
  if (instances) {
    pass.setVertexBuffer(1, instances.upload(device));
    pass.drawIndexed(p.count, instances.count);
  } else pass.drawIndexed(p.count);
}

/** Whether a caster's cached draw `record` no longer fits primitive `p` drawn with `pipeline` and `displacement`. */
export const staleCaster = (record, p, pipeline, displacement) =>
  !record ||
  record.vertex !== p.vertex ||
  record.pipeline !== pipeline ||
  record.alpha !== p.alphaTexture ||
  record.sampler !== p.alphaSampler ||
  record.displacement !== displacement ||
  record.opacity !== p.opacity;
