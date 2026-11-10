// Texture mip streaming for @margoengine/gltf-pro/progressive, loaded only with the `textures` option: KTX2 images open
// through @margoengine/decoders/ktx2-stream with just their smallest levels, and finer levels load by the size each texture
// has on screen. Files keep the smallest mip first, so a stream starts from a small read of the head of each image.
import type { EngineKernel, EnginePlugin } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { KTX2Streamer, colorTwin } from '@margoengine/decoders/ktx2-stream';
import type { KTX2StreamerOptions, StreamedKTX2 } from '@margoengine/decoders/ktx2-stream';
import { measureSurface, scaleOf, type Surface } from '../../shared/texture-density.js';
import { textureCoordinates } from './texture-coordinates.js';
import type { GLTFDocument, GLTFStreamedImage, GLTFStreamSource, GLTFTextureOpener } from './asset.js';
import type { PBRModel, PBRMaterial, PBRPrimitive } from './index.js';
type Engine = ReturnType<typeof engineRuntime>;

/** `textures` of `loadGLTFProgressive`: the memory budget and loading of its KTX2 textures. */
export interface GLTFTextureStreamOptions
  extends Pick<KTX2StreamerOptions, 'budgetBytes' | 'concurrency' | 'headBytes' | 'decoder' | 'hdrDecoder'> {
  /** Called when a finer level fails to load; the texture keeps the levels it has. Default: `console.error`. */
  onError?: (error: unknown) => void;
}

// One map of a material: the image, UV set, and how many times the texture repeats per UV unit.
interface MapUse {
  image: StreamedImage;
  set: number;
  repeat: number;
}
const REFRESH = 0.2,
  surfaces = new WeakMap<object, Surface>();
let plugins = 0;

const place = (m: ArrayLike<number>, x: number, y: number, z: number, o = 0): [number, number, number] => [
  m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12],
  m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13],
  m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14],
];

/** Pixels one world unit covers at the nearest point of a sphere, on the nearest camera that sees it; 0 when none does. */
function pixelsPerUnit(engine: Engine, centre: readonly number[], radius: number): number {
  const views = engine.views?.length ? engine.views : [undefined],
    height = engine.canvas.height;
  let best = 0;
  for (const view of views) {
    const camera = view?.camera ?? engine.camera,
      planes = camera.planes;
    let visible = true;
    if (planes.some((v) => v !== 0))
      for (let j = 0; j < 24; j += 4)
        if (planes[j] * centre[0] + planes[j + 1] * centre[1] + planes[j + 2] * centre[2] + planes[j + 3] < -radius)
          visible = false;
    if (!visible) continue;
    const eye = camera.position,
      distance = Math.max(Math.hypot(centre[0] - eye[0], centre[1] - eye[1], centre[2] - eye[2]) - radius, camera.near);
    best = Math.max(best, height / 2 / (distance * Math.tan((camera.fov * Math.PI) / 360)));
  }
  return best;
}

/** One image of a model: a stream that hands the current view to whoever draws it. */
class StreamedImage implements GLTFStreamedImage {
  readonly streamed = true;
  readonly users = new Set<{ rebindStreamed(image: GLTFStreamedImage): void }>();
  stream?: StreamedKTX2;
  width = 1;
  height = 1;
  /** On-screen size for the next update. */
  wanted = 0;
  private views = new Map<boolean, GPUTextureView>();
  constructor(
    private readonly owner: GLTFTextureStream,
    readonly source: GLTFStreamSource,
  ) {}
  view(device: GPUDevice, srgb: boolean): GPUTextureView | undefined {
    const stream = this.stream;
    if (!stream || this.owner.device !== device) return undefined;
    let view = this.views.get(srgb);
    if (!view) {
      const linear = stream.format.replace(/-srgb$/, '') as GPUTextureFormat,
        format = srgb && colorTwin(linear) ? colorTwin(linear)! : linear;
      this.views.set(srgb, (view = stream.texture.createView({ format })));
    }
    return view;
  }
  viewSize(): { width: number; height: number; levels: number } | undefined {
    const texture = this.stream?.texture;
    return texture ? { width: texture.width, height: texture.height, levels: texture.mipLevelCount } : undefined;
  }
  /** Takes on a newly opened stream and tells the models. */
  use(stream: StreamedKTX2): void {
    this.stream = stream;
    this.width = stream.width;
    this.height = stream.height;
    stream.onChange = () => this.changed();
    this.changed();
  }
  private changed(): void {
    this.views.clear();
    for (const model of [...this.users]) model.rebindStreamed(this);
  }
  /** Lets go of the stream only, for a restart on a new device. */
  drop(): void {
    this.stream?.dispose();
    this.stream = undefined;
    this.views.clear();
  }
  close(): void {
    this.drop();
    this.owner.forget(this);
  }
}

/**
 * The live texture side of one progressive load (`load.textures`). It reads how large each KTX2 texture is on screen about
 * five times a second and asks for the levels that need, inside `budgetBytes`, for as long as the model lives.
 */
export class GLTFTextureStream implements GLTFTextureOpener {
  private readonly engine: Engine;
  private readonly name = `gltf-pro-textures-${++plugins}`;
  private readonly images = new Set<StreamedImage>();
  private readonly models = new Set<PBRModel>();
  private readonly uses = new WeakMap<object, MapUse[]>();
  private streamer!: KTX2Streamer;
  private since = 0;
  private closed = false;
  // The plugin registered for refreshes and device restore.
  private plugin!: EnginePlugin;

  /** Creates the stream on `engine` (preferred over the constructor); the `textures` option of `/progressive` calls this. */
  static attach(engine: EngineKernel, options: GLTFTextureStreamOptions = {}, signal?: AbortSignal): GLTFTextureStream {
    return new GLTFTextureStream(engine, options, signal);
  }
  constructor(
    instance: EngineKernel,
    private readonly options: GLTFTextureStreamOptions = {},
    private readonly signal: AbortSignal = new AbortController().signal,
  ) {
    this.engine = engineRuntime(instance);
    this.start();
    const self = this;
    this.engine.use(
      (this.plugin = {
        name: this.name,
        setup() {},
        onPreUpdate(delta) {
          self.since += delta;
          if (self.since >= REFRESH) self.update();
        },
        onDeviceRestored() {
          self.restart();
        },
      }),
    );
  }
  private start(): void {
    this.streamer = new KTX2Streamer({
      ...this.options,
      device: this.engine.gpu!,
      onError: (error) => (this.options.onError ?? console.error)(error),
    });
  }
  /** The device the streams live on. */
  get device(): GPUDevice {
    return this.streamer.device;
  }
  /** Most bytes of GPU memory the textures may hold; lower it under memory pressure. */
  get budgetBytes(): number {
    return this.streamer.budgetBytes;
  }
  set budgetBytes(bytes: number) {
    this.streamer.budgetBytes = bytes;
  }
  /** GPU bytes the textures hold now. */
  get usedBytes(): number {
    return this.streamer.usedBytes;
  }
  /** Textures streaming, with the finest level each holds (0 is full size), its level count and size on screen in pixels. */
  get textures(): { width: number; height: number; level: number; levels: number; pixels: number }[] {
    return [...this.images].flatMap(({ stream, width, height, wanted }) =>
      stream ? [{ width, height, level: stream.residentLevel, levels: stream.levels, pixels: wanted }] : [],
    );
  }

  private async begin(image: StreamedImage): Promise<void> {
    const { source } = image,
      { streamer } = this,
      options = { signal: this.signal, colorViews: true },
      stream =
        'bytes' in source
          ? await streamer.open(source.bytes, options)
          : await streamer.open(source.url, { ...options, offset: source.offset, length: source.length });
    if (this.closed || !this.images.has(image) || streamer !== this.streamer) stream.dispose();
    else image.use(stream);
  }
  /** Opens one image; resolves once its smallest levels are on the GPU. */
  async open(source: GLTFStreamSource): Promise<GLTFStreamedImage> {
    const image = new StreamedImage(this, source);
    this.images.add(image);
    for (const model of this.models) image.users.add(model);
    await this.begin(image);
    return image;
  }
  /** Follows `model`, which then rebinds as its textures change. */
  attach(model: PBRModel): void {
    this.models.add(model);
    for (const image of this.images) image.users.add(model);
    model.onDispose(() => {
      this.models.delete(model);
      if (!this.models.size && !this.images.size) this.dispose();
    });
  }
  /** Forgets a closed image; with the last one gone, the stream closes. */
  forget(image: StreamedImage): void {
    this.images.delete(image);
    if (!this.images.size) this.dispose();
  }
  private mapsOf(model: PBRModel, doc: GLTFDocument, material: PBRMaterial): MapUse[] {
    let list = this.uses.get(material);
    if (!list) {
      list = material.maps.flatMap((map) => {
        const texture = map && doc.textures?.[map.index],
          source = texture?.extensions?.KHR_texture_basisu?.source ?? texture?.source,
          image = source === undefined ? undefined : model['images'][source];
        if (!(image instanceof StreamedImage)) return [];
        const { texCoord, transform } = textureCoordinates(map!),
          repeat = transform
            ? Math.min(Math.hypot(transform[0], transform[4]), Math.hypot(transform[1], transform[5]))
            : 1;
        return [{ image, set: texCoord, repeat: repeat || 1 }];
      });
      // A material with no maps yet is the bare stand-in of a load in progress.
      if (material.maps.some(Boolean)) this.uses.set(material, list);
    }
    return list;
  }
  private measure(model: PBRModel, p: PBRPrimitive): void {
    const uses = this.mapsOf(model, model['asset'].doc, p.material);
    if (!uses.length) return;
    let surface = surfaces.get(p.vertices);
    if (!surface) surfaces.set(p.vertices, (surface = measureSurface(p.vertices, p.indices, p.uvs)));
    const { centre, radius, spans } = surface,
      node = p.node.matrix,
      nodeScale = scaleOf(node),
      see = (world: readonly number[], scale: number) => {
        const pixels = pixelsPerUnit(this.engine, world, radius * scale) * scale;
        for (const use of uses)
          use.image.wanted = Math.max(use.image.wanted, (pixels * (spans[use.set] ?? 0)) / use.repeat);
      };
    const instances = p.instances;
    if (!instances) see(place(node, ...centre), nodeScale);
    else
      for (let i = 0, count = instances.count; i < count; i++) {
        const local = place(instances.data, ...centre, i * 24);
        see(place(node, ...local), nodeScale * scaleOf(instances.data, i * 24));
      }
  }
  /** Reads every texture's size on screen and starts the loads that calls for; runs by itself about five times a second. */
  update(): void {
    this.since = 0;
    if (this.closed) return;
    for (const image of this.images) image.wanted = 0;
    for (const model of this.models) {
      if (model.disposed) this.models.delete(model);
      else for (const p of model.primitives) this.measure(model, p);
    }
    for (const image of this.images) image.stream?.want(image.wanted);
    this.streamer.update();
  }
  // The old device took its textures with it: the same files open again on the new one.
  private restart(): void {
    if (this.closed) return;
    for (const image of this.images) image.drop();
    this.streamer.dispose();
    this.start();
    for (const image of this.images) this.begin(image).catch((error) => (this.options.onError ?? console.error)(error));
  }
  /** Stops loading and frees every texture; disposing the model does this. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const image of this.images) image.drop();
    this.images.clear();
    this.streamer.dispose();
    // The scene the stream was attached to, not whichever scene is active now.
    this.engine.sceneOf(this.plugin)?.removePlugin(this.name);
  }
}
