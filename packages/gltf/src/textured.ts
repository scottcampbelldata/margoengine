// Base colour maps and MASK cut-outs for the light loader. Core's meshes have one constant colour, so this entry keeps
// the mesh in core (bounds, picking, instances) and claims its batch: its own pass draws those instances with core's
// shader plus a UV input and a texture read, so a package that patches core's shader applies here too.
import { uploadRows, type Engine, type EnginePlugin, type FrameGraph, type Geometry, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { setGeometrySurface } from '../../shared/mesh-source.js';
import { generateMipmaps } from '../../shared/mipmaps.js';
import type { GLTFDocument, GLTFMaterial, GLTFSampler, GLTFTextureInfo } from '../../shared/gltf.js';
import { entry, integer, readAccessor } from './accessor.js';
import type { GLTFBuilt, GLTFExtension, GLTFFile, Model } from './index.js';

declare const GPUBufferUsage: { VERTEX: number; UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

const TRANSFORM = 'KHR_texture_transform',
  invalid = (what: string) =>
    new TypeError(`Invalid glTF ${what}; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`),
  refused = (what: string) =>
    new MargoError('unsupported', `${what} is not on the light path; load the file with @margoengine/gltf-pro`);

/** What a material draws with. `image` and `sampler` index the document; a MASK with no texture has neither. */
interface Surface {
  image?: number;
  sampler?: number;
  texCoord: number;
  /** Row-major 2x3 UV matrix from KHR_texture_transform. */
  transform?: readonly number[];
  alpha: number;
  cutoff: number;
}
function transformOf(info: GLTFTextureInfo): number[] | undefined {
  const names = Object.keys(info.extensions ?? {}).filter((name) => name !== TRANSFORM);
  if (names.length) throw refused(`Texture extension ${names[0]}`);
  const t = info.extensions?.[TRANSFORM] as
    | { offset?: number[]; rotation?: number; scale?: number[]; texCoord?: number }
    | undefined;
  if (!t) return undefined;
  const [sx, sy] = t.scale ?? [1, 1],
    [ox, oy] = t.offset ?? [0, 0],
    r = t.rotation ?? 0,
    values = [Math.cos(r) * sx, Math.sin(r) * sy, ox, -Math.sin(r) * sx, Math.cos(r) * sy, oy];
  if (!values.every(Number.isFinite)) throw invalid('texture transform');
  return values;
}
/** The surface of material `m`, or undefined for one the root loader takes as it is. */
function surfaceOf(doc: GLTFDocument, m: GLTFMaterial): Surface | undefined {
  const p = m.pbrMetallicRoughness ?? {},
    info = p.baseColorTexture,
    mask = m.alphaMode === 'MASK';
  // BLEND stays in the document, for the root to refuse.
  if ((!info && !mask) || (!mask && (m.alphaMode ?? 'OPAQUE') !== 'OPAQUE')) return undefined;
  const alpha = p.baseColorFactor?.[3] ?? 1,
    cutoff = mask ? (m.alphaCutoff ?? 0.5) : 0,
    surface: Surface = { texCoord: 0, alpha, cutoff };
  if (!(alpha >= 0 && alpha <= 1) || !(cutoff >= 0)) throw invalid('alpha');
  if (info) {
    const texture = entry(doc.textures, info.index, 'texture');
    if (texture.extensions && Object.keys(texture.extensions).length) throw refused('A compressed or WebP texture');
    surface.image = integer(texture.source, 'texture source');
    entry(doc.images, surface.image, 'image');
    if (texture.sampler !== undefined) entry(doc.samplers, (surface.sampler = texture.sampler), 'sampler');
    surface.transform = transformOf(info);
    const moved = info.extensions?.[TRANSFORM] as { texCoord?: number } | undefined;
    surface.texCoord = integer(moved?.texCoord ?? info.texCoord ?? 0, 'texCoord');
  }
  return surface;
}
/** The encoded bytes of image `id`: a bufferView, a `data:` URI, or `file.fetch` for anything else. */
async function imageBytes(file: GLTFFile, id: number): Promise<Uint8Array> {
  const image = entry(file.doc.images, id, 'image');
  if (image.bufferView !== undefined) {
    const view = entry(file.doc.bufferViews, image.bufferView, 'bufferView'),
      buffer = file.buffers[integer(view.buffer, 'buffer reference')],
      start = integer(view.byteOffset ?? 0, 'view offset'),
      length = integer(view.byteLength, 'view length', 1);
    if (!buffer || start + length > buffer.length) throw new RangeError('glTF image is outside its buffer; re-export the file');
    return buffer.subarray(start, start + length);
  }
  if (typeof image.uri !== 'string') throw invalid('image');
  const data = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.uri);
  if (data) return Uint8Array.from(atob(data[1]), (c) => c.charCodeAt(0));
  if (!file.fetch) throw new TypeError('glTF image URI needs the file location; use loadGLTF');
  return file.fetch(image.uri);
}
async function decode(bytes: Uint8Array): Promise<ImageBitmap> {
  // As stored: glTF colour is sRGB, and an alpha test needs the alpha the artist wrote.
  return createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
}
const addressMode = (wrap: unknown): GPUAddressMode =>
  wrap === 33071 ? 'clamp-to-edge' : wrap === 33648 ? 'mirror-repeat' : 'repeat';
const samplerOf = (s: GLTFSampler = {}): GPUSamplerDescriptor => {
  const min = s.minFilter;
  return {
    addressModeU: addressMode(s.wrapS),
    addressModeV: addressMode(s.wrapT),
    magFilter: s.magFilter === 9728 ? 'nearest' : 'linear',
    minFilter: min === 9728 || min === 9984 || min === 9986 ? 'nearest' : 'linear',
    mipmapFilter: min === 9984 || min === 9985 ? 'nearest' : 'linear',
    // 9728 and 9729 name no mip filter: the base level only.
    lodMaxClamp: min === 9728 || min === 9729 ? 0 : 32,
  };
};
/** Core's shader with a UV input and a base colour read. Throws when a package replaced what it patches. */
function texturedShader(shader: string): string {
  const code =
    '@group(1) @binding(0) var baseMap:texture_2d<f32>;@group(1) @binding(1) var baseSampler:sampler;@group(1) @binding(2) var<uniform> surface:vec4f;\n' +
    shader
      .replace('struct Input {', 'struct Input { @location(15) uv:vec2f,')
      .replace('struct Output {', 'struct Output { @location(14) uv:vec2f,')
      .replace(/(@vertex fn vertex\(i:Input\)[\s\S]*?)return o;/, '$1o.uv=i.uv;return o;')
      .replace(
        /@fragment fn fragment\(i:Output([^{]*)\{/,
        '@fragment fn fragment(source:Output$1{var i=source;let texel=textureSample(baseMap,baseSampler,i.uv);if(texel.a*surface.x<surface.y){discard;}i.color*=texel.rgb;',
      );
  if (!code.includes('o.uv=i.uv') || !code.includes('var i=source'))
    throw new MargoError('failed', 'A package replaced the core shader parts @margoengine/gltf/textured patches; remove that package or load the file with @margoengine/gltf-pro');
  return code;
}
/** One geometry this entry draws. */
interface Part {
  geometry: Geometry;
  uv: Float32Array;
  surface: Surface;
  bitmap?: ImageBitmap;
  sampler: GPUSamplerDescriptor;
  uvBuffer?: GPUBuffer;
  block?: GPUBuffer;
  /** 80-byte vertices of a cut-out, for shadow passes: positions, and uv where the depth shader reads it. */
  casterBuffer?: GPUBuffer;
  groups: WeakMap<GPURenderPipeline, GPUBindGroup>;
  /** False until the instances went to the GPU whole, and again after a device restore. */
  sent: boolean;
}
const draws = /* @__PURE__ */ new WeakMap<FrameGraph, TexturedDraw>();
/** The plugin that draws a scene's textured parts; there is one per scene and it leaves with its last part. */
class TexturedDraw implements EnginePlugin {
  readonly name = 'gltf-textured';
  readonly parts = new Map<Geometry, Part>();
  private engine!: Engine;
  private frame?: GPUBuffer;
  private readonly values = new Float32Array(32);
  private readonly textures = new Map<ImageBitmap, GPUTexture>();
  private mips = new Map<unknown, unknown>();
  private white?: GPUTexture;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly shaders = new Map<string, string>();
  private readonly frameGroups = new WeakMap<GPURenderPipeline, { group: GPUBindGroup; bindings: GPUBindGroupEntry[] }>();
  private readonly color: GPURenderPassColorAttachment = { view: null as unknown as GPUTextureView, loadOp: 'load', storeOp: 'store' };
  private readonly depth: GPURenderPassDepthStencilAttachment = { view: null as unknown as GPUTextureView };
  setup(engine: Engine): void {
    if (!engine.gpu) throw new MargoError('unsupported', 'Textured glTF requires WebGPU; use a WebGPU engine');
    this.engine = engine;
    this.frame = engine.gpu.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  registerPasses(graph: FrameGraph): void {
    // First in the frame: core must see the claim, and a culling package reads core's instance buffer.
    graph.add({
      name: 'gltf-textured:claim',
      order: -1_000_000,
      execute: (c) => {
        if (c.backend === 'webgpu') this.claim(c);
      },
    });
    graph.add({
      name: 'gltf-textured:draw',
      order: 0.5,
      joins: true,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  add(part: Part): void {
    this.parts.set(part.geometry, part);
    this.upload(part);
  }
  remove(part: Part): void {
    this.parts.delete(part.geometry);
    setGeometrySurface(part.geometry, undefined);
    part.uvBuffer?.destroy();
    part.block?.destroy();
    part.casterBuffer?.destroy();
    if (part.bitmap && ![...this.parts.values()].some((other) => other.bitmap === part.bitmap)) {
      this.textures.get(part.bitmap)?.destroy();
      this.textures.delete(part.bitmap);
    }
  }
  private texture(bitmap: ImageBitmap | undefined): GPUTexture {
    const device = this.engine.gpu!,
      known = bitmap ? this.textures.get(bitmap) : this.white;
    if (known) return known;
    const { width, height } = bitmap ?? { width: 1, height: 1 },
      limit = device.limits.maxTextureDimension2D;
    if (width > limit || height > limit)
      throw new RangeError(`glTF image is ${width} x ${height}, over this GPU's ${limit}; resize it`);
    const levels = Math.floor(Math.log2(Math.max(width, height))) + 1,
      texture = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm-srgb',
        mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    if (bitmap) {
      device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [width, height]);
      generateMipmaps(device, texture, levels, this.mips);
      this.textures.set(bitmap, texture);
    } else {
      device.queue.writeTexture({ texture }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
      this.white = texture;
    }
    return texture;
  }
  private upload(part: Part): void {
    const device = this.engine.gpu!,
      texture = this.texture(part.bitmap);
    setGeometrySurface(part.geometry, { uv: part.uv, caster: part.surface.cutoff > 0 ? this.caster(part, texture) : undefined });
    part.uvBuffer = device.createBuffer({
      size: part.uv.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(part.uvBuffer, 0, part.uv as Float32Array<ArrayBuffer>);
    part.block = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(part.block, 0, new Float32Array([part.surface.alpha, part.surface.cutoff, 0, 0]));
    part.groups = new WeakMap();
    part.sent = false;
  }
  /** What a shadow pass draws of a cut-out: core's vertices hold no uv, so its depth pass needs vertices that do. */
  private caster(part: Part, texture: GPUTexture): object {
    const device = this.engine.gpu!,
      points = part.geometry.vertices,
      count = points.length / 6,
      vertices = new Float32Array(count * 20);
    for (let i = 0; i < count; i++) {
      vertices.set(points.subarray(i * 6, i * 6 + 3), i * 20);
      vertices.set(part.uv.subarray(i * 2, i * 2 + 2), i * 20 + 12);
    }
    part.casterBuffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(part.casterBuffer, 0, vertices);
    return {
      vertex: part.casterBuffer,
      stride: 80,
      alphaTexture: texture.createView(),
      alphaSampler: device.createSampler(part.sampler),
      alpha: part.surface.alpha,
      cutoff: part.surface.cutoff,
      vertexAlpha: false,
    };
  }
  private claim(c: Context): void {
    const batches = c.batches ?? [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i],
        part = this.parts.get(batch.geometry);
      if (!part) continue;
      // Core counted this frame's draws before this first claim, and `draw` counts this batch.
      if (!batch.claimed && (batch.count || batch.redirect)) this.engine.stats.drawCalls--;
      batch.claimed = true;
      // Core uploads only what it draws, so its changed rows are this pass's to send and reset.
      uploadRows(c.device.queue, this.engine.geometryBuffers(batch.geometry)!.instance, batch, !part.sent);
      part.sent = true;
    }
  }
  private pipeline(c: Context): GPURenderPipeline {
    const d = c.descriptor,
      key = `${d.multisample?.count} ${c.format} ${d.depthStencil?.format} ${c.shader}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ code: this.shaderFor(c.shader) });
      pipeline = c.device.createRenderPipeline({
        ...d,
        vertex: {
          ...d.vertex,
          module,
          buffers: [
            ...d.vertex.buffers!,
            { arrayStride: 8, attributes: [{ shaderLocation: 15, offset: 0, format: 'float32x2' }] },
          ],
        },
        fragment: { ...d.fragment!, module, targets: [{ format: c.format }] },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  private shaderFor(shader: string): string {
    let code = this.shaders.get(shader);
    if (code === undefined) this.shaders.set(shader, (code = texturedShader(shader)));
    return code;
  }
  private frameGroup(c: Context, pipeline: GPURenderPipeline): GPUBindGroup {
    const held = this.frameGroups.get(pipeline),
      bindings = c.bindings;
    if (
      held &&
      held.bindings.length === bindings.length &&
      held.bindings.every((b, i) => b.binding === bindings[i].binding && b.resource === bindings[i].resource)
    )
      return held.group;
    const group = c.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.frame! } }, ...bindings],
    });
    this.frameGroups.set(pipeline, { group, bindings: [...bindings] });
    return group;
  }
  private surfaceGroup(c: Context, pipeline: GPURenderPipeline, part: Part): GPUBindGroup {
    let group = part.groups.get(pipeline);
    if (!group) {
      group = c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: this.texture(part.bitmap).createView() },
          { binding: 1, resource: c.device.createSampler(part.sampler) },
          { binding: 2, resource: { buffer: part.block! } },
        ],
      });
      part.groups.set(pipeline, group);
    }
    return group;
  }
  private draw(c: Context): void {
    const batches = c.batches ?? [];
    let pass: GPURenderPassEncoder | undefined, pipeline: GPURenderPipeline | undefined;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i],
        part = this.parts.get(batch.geometry);
      if (!part || (!batch.count && !batch.redirect)) continue;
      if (!pass) {
        pipeline = this.pipeline(c);
        const { direction, radiance, ambient } = this.engine.lighting,
          values = this.values;
        values.set(c.camera.matrix);
        values.set(c.camera.position, 16);
        values.set(direction, 20);
        values.set(radiance, 24);
        values.fill(1, 28, 31);
        if (ambient) values.set(ambient, 28);
        c.device.queue.writeBuffer(this.frame!, 0, values);
        const color = this.color,
          depth = this.depth,
          stencil = c.descriptor.depthStencil!.format.includes('stencil');
        color.view = c.color;
        color.loadOp = 'load';
        color.storeOp = 'store';
        color.resolveTarget = undefined;
        depth.view = c.depth;
        depth.depthLoadOp = 'load';
        depth.depthStoreOp = 'store';
        depth.stencilLoadOp = stencil ? 'load' : undefined;
        depth.stencilStoreOp = stencil ? 'store' : undefined;
        c.attach?.(color, depth, true);
        pass = c.encoder.beginRenderPass({ colorAttachments: [color], depthStencilAttachment: depth });
        const view = c.view;
        if (view) {
          pass.setViewport(...view.viewport, 0, 1);
          pass.setScissorRect(...(view.scissor ?? view.viewport));
        }
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.frameGroup(c, pipeline));
      }
      const buffers = this.engine.geometryBuffers(batch.geometry)!,
        redirect = batch.redirect;
      pass.setBindGroup(1, this.surfaceGroup(c, pipeline!, part));
      pass.setVertexBuffer(0, buffers.vertex);
      pass.setVertexBuffer(1, redirect?.instances ?? buffers.instance);
      pass.setVertexBuffer(2, part.uvBuffer!);
      pass.setIndexBuffer(buffers.index, 'uint32');
      if (redirect) pass.drawIndexedIndirect(redirect.args, 0);
      else pass.drawIndexed(batch.geometry.indices.length, batch.count);
      this.engine.stats.drawCalls++;
    }
    pass?.end();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
    for (const part of this.parts.values()) this.upload(part);
  }
  private release(): void {
    this.frame?.destroy();
    this.white?.destroy();
    this.white = undefined;
    for (const texture of this.textures.values()) texture.destroy();
    this.textures.clear();
    // A new map, not clear(): it also holds the old device's sampler as a property.
    this.mips = new Map();
    this.pipelines.clear();
  }
  dispose(): void {
    this.release();
    for (const part of this.parts.values()) {
      setGeometrySurface(part.geometry, undefined);
      part.uvBuffer?.destroy();
      part.block?.destroy();
      part.casterBuffer?.destroy();
    }
    this.parts.clear();
  }
}
/** A file's decoded images and surfaces, from `load` to `finish`. */
const files = /* @__PURE__ */ new WeakMap<GLTFFile, { images: Map<number, ImageBitmap>; surfaces: Map<number, Surface> }>();
/** The parts each loaded model draws here, for `texturedAlphaMasks`. */
const modelParts = /* @__PURE__ */ new WeakMap<Model, Part[]>();

/** Top-left row-major RGBA8 pixels, as `getImageData` gives. */
export interface TexturedPixels {
  width: number;
  height: number;
  data: ArrayLike<number>;
}
/** One cut-out's mask, in the shape `AlphaMask` of `@margoengine/bvh/alpha` reads. */
export interface TexturedAlphaMask extends TexturedPixels {
  cutoff: number;
  factor: number;
  wrap: readonly ['repeat' | 'mirror' | 'clamp', 'repeat' | 'mirror' | 'clamp'];
}
function canvasPixels(image: ImageBitmap): TexturedPixels {
  if (typeof OffscreenCanvas === 'undefined')
    throw new TypeError('texturedAlphaMasks needs OffscreenCanvas to read an image here; pass the pixels option.');
  const canvas = new OffscreenCanvas(image.width, image.height),
    brush = canvas.getContext('2d', { willReadFrequently: true })!;
  brush.drawImage(image, 0, 0);
  return brush.getImageData(0, 0, image.width, image.height);
}
const wrapOf = (mode: GPUAddressMode | undefined) =>
  mode === 'clamp-to-edge' ? ('clamp' as const) : mode === 'mirror-repeat' ? ('mirror' as const) : ('repeat' as const);

/**
 * The masks of a model loaded with {@link textured}, for `AlphaRaycaster.alphaMask` from `@margoengine/bvh/alpha`, so a
 * ray passes through the holes of its cut-outs. The GPU picks of `engine.pick` and `Picking` see a cut-out as solid. The
 * pixels are read once, here, so call it before `model.dispose`. Hits on anything else answer null.
 * @example ray.alphaMask = await texturedAlphaMasks(model);
 */
export async function texturedAlphaMasks(
  model: Model,
  { signal, pixels = canvasPixels }: { signal?: AbortSignal; pixels?: (image: ImageBitmap) => TexturedPixels | Promise<TexturedPixels> } = {},
): Promise<(hit: { mesh: object }) => TexturedAlphaMask | null> {
  const masks = new Map<Geometry, TexturedAlphaMask>(),
    read = new Map<ImageBitmap, TexturedPixels>();
  for (const part of modelParts.get(model) ?? []) {
    signal?.throwIfAborted();
    const { surface, bitmap, sampler, geometry } = part;
    if (!(surface.cutoff > 0)) continue;
    let image: TexturedPixels = { width: 1, height: 1, data: [255, 255, 255, 255] };
    if (bitmap) {
      const known = read.get(bitmap);
      image = known ?? (await pixels(bitmap));
      read.set(bitmap, image);
    }
    masks.set(geometry, {
      width: image.width,
      height: image.height,
      data: image.data,
      cutoff: surface.cutoff,
      factor: surface.alpha,
      wrap: [wrapOf(sampler.addressModeU), wrapOf(sampler.addressModeV)],
    });
  }
  signal?.throwIfAborted();
  return (hit) => masks.get((hit.mesh as { geometry?: Geometry }).geometry!) ?? null;
}

/**
 * Lets the light loader draw a base colour texture and MASK cut-outs: `baseColorTexture` on any TEXCOORD set, with
 * `KHR_texture_transform`, multiplied by `baseColorFactor`, and an alpha test against `alphaCutoff`. WebGPU only. Other
 * maps, BLEND and compressed textures stay refused. The mesh stays a core mesh, so transforms, picking and `dispose` work
 * as for any other. A cut-out casts its outline in `@margoengine/shadows`; GPU picks see it as solid, and a ray sees
 * through it with {@link texturedAlphaMasks}. Needs `loadGLTF` or `parseGLTFAsync`, since images decode asynchronously.
 * @example const model = await loadGLTF(engine, '/prop.glb', { extensions: [textured] });
 */
export const textured: GLTFExtension = {
  handles: [TRANSFORM],
  async load(file) {
    const surfaces = new Map<number, Surface>(),
      images = new Map<number, ImageBitmap>();
    files.set(file, { images, surfaces });
    (file.doc.materials ?? []).forEach((m, id) => {
      const surface = surfaceOf(file.doc, m);
      if (surface) surfaces.set(id, surface);
    });
    const used = new Set([...surfaces.values()].flatMap(({ image }) => (image === undefined ? [] : [image])));
    try {
      await Promise.all(
        [...used].map(async (id) => {
          images.set(id, await decode(await imageBytes(file, id)));
        }),
      );
    } catch (error) {
      for (const bitmap of images.values()) bitmap.close();
      throw error;
    }
  },
  read(file) {
    const { surfaces } = files.get(file)!;
    // The root sees constant opaque materials; the document the caller holds stays as it was.
    file.doc = {
      ...file.doc,
      materials: file.doc.materials?.map((m, id) => {
        if (!surfaces.has(id)) return m;
        const { alphaMode: _mode, alphaCutoff: _cutoff, ...rest } = m,
          { baseColorTexture: _texture, baseColorFactor: factor = [1, 1, 1, 1], ...values } = m.pbrMetallicRoughness ?? {};
        return { ...rest, pbrMetallicRoughness: { ...values, baseColorFactor: [factor[0], factor[1], factor[2], 1] } };
      }),
    };
  },
  finish(model: Model, file: GLTFFile, built: GLTFBuilt) {
    const { images, surfaces } = files.get(file)!,
      engine = built.engine,
      parts: Part[] = [];
    for (const { geometry, source, expanded } of built.primitives) {
      const surface = source.material === undefined ? undefined : surfaces.get(source.material);
      if (!surface) continue;
      const read = () => {
        if (surface.image === undefined) return new Float32Array((geometry.vertices.length / 6) * 2);
        const id = source.attributes?.[`TEXCOORD_${surface.texCoord}`];
        if (id === undefined) throw invalid(`primitive: its material needs TEXCOORD_${surface.texCoord}`);
        return readAccessor(
          file,
          id,
          2,
          (a) => a.type === 'VEC2' && [5126, 5120, 5121, 5122, 5123].includes(a.componentType),
        ) as Float32Array;
      };
      const stored = read(),
        count = geometry.vertices.length / 6,
        uv = new Float32Array(count * 2),
        t = surface.transform ?? [1, 0, 0, 0, 1, 0];
      for (let i = 0; i < count; i++) {
        const from = expanded ? expanded[i] : i,
          u = stored[from * 2],
          v = stored[from * 2 + 1];
        if (u === undefined || v === undefined) throw new RangeError('glTF TEXCOORD has fewer vertices than POSITION; re-export the file');
        uv[i * 2] = t[0] * u + t[1] * v + t[2];
        uv[i * 2 + 1] = t[3] * u + t[4] * v + t[5];
      }
      parts.push({
        geometry,
        uv,
        surface,
        bitmap: surface.image === undefined ? undefined : images.get(surface.image),
        sampler: samplerOf(surface.sampler === undefined ? undefined : file.doc.samplers?.[surface.sampler]),
        groups: new WeakMap(),
        sent: false,
      });
    }
    if (!parts.length) return;
    const graph = engine.frameGraph;
    let draw = draws.get(graph);
    if (!draw) {
      draw = new TexturedDraw();
      engine.use(draw);
      draws.set(graph, draw);
    }
    const owner = draw;
    for (const part of parts) owner.add(part);
    modelParts.set(model, parts);
    const dispose = model.dispose;
    let live = true;
    model.dispose = () => {
      if (live) {
        live = false;
        for (const part of parts) owner.remove(part);
        for (const bitmap of images.values()) bitmap.close();
        if (!owner.parts.size) {
          draws.delete(graph);
          engine.sceneOf(owner)?.removePlugin(owner.name);
        }
      }
      dispose();
    };
  },
};
