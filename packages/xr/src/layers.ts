// Composition layers, video layers, haptics and teleport locomotion for an XR session. Written from the W3C WebXR
// Layers Module (quad, cylinder, equirect and cube layers, layouts, isStatic and needsRedraw, the renderState layers
// array composited in order with source-over, XRMediaBinding video layers and their aspect ratio rule), the WebXR/WebGPU
// Binding draft (XRGPUBinding.createQuadLayer and friends, getSubImage per eye, array layer per eye and cube face order
// +X, -X, +Y, -Y, +Z, -Z), the WebXR Device API (getOffsetReferenceSpace multiplies the origin offset, XRRigidTransform),
// the Gamepad spec (vibrationActuator.playEffect 'dual-rumble') and the Gamepad Extensions draft (hapticActuators,
// pulse(value, duration)).
import { margoError } from '../../shared/errors.js';
import type { XRController } from './controller.js';
import type { XRFrameState, XRInputSource, XRNativeFrame, XRNativeSession, XRSpace } from './types.js';

/** What layers and locomotion need of an `XR`; `XR` itself fits. */
export interface XRLayersHost {
  readonly session: XRNativeSession | null;
  readonly referenceSpace: XRSpace | undefined;
  /** The session's WebGPU binding and device; undefined without an immersive session. */
  readonly layerBinding: { binding: XRLayerBinding; device: GPUDevice } | undefined;
  onFrame(callback: (state: XRFrameState) => void): () => void;
  /** Shows `below`, then the scene's projection layer, then `above`. */
  setLayers(below: readonly object[], above: readonly object[]): void;
  /** Replaces the space of frame poses, controllers and hits (a teleport or a turn). */
  useReferenceSpace(space: XRSpace): void;
}
/** The layer half of an `XRGPUBinding` (WebXR/WebGPU Binding, section 5.9). */
export interface XRLayerBinding {
  getPreferredColorFormat(): GPUTextureFormat;
  createQuadLayer?(init: object): XRCompositionLayer;
  createCylinderLayer?(init: object): XRCompositionLayer;
  createEquirectLayer?(init: object): XRCompositionLayer;
  createCubeLayer?(init: object): XRCompositionLayer;
  getSubImage?(
    layer: XRCompositionLayer,
    frame: XRNativeFrame,
    eye?: 'none' | 'left' | 'right',
  ): {
    colorTexture: GPUTexture;
    viewport: { x: number; y: number; width: number; height: number };
    getViewDescriptor(): GPUTextureViewDescriptor;
  };
}
/** A WebXR composition layer (WebXR Layers, section 3.4). */
export interface XRCompositionLayer {
  readonly layout?: string;
  readonly needsRedraw?: boolean;
  opacity?: number;
  space?: XRSpace;
  destroy(): void;
}
/** Where a layer sits: a position in metres and an orientation quaternion in `space` (default the XR reference space). */
export interface LayerPlacement {
  /** Default [0, 1.5, -2] for quads and cylinders, [0, 0, 0] otherwise. */
  position?: readonly [number, number, number];
  /** Unit quaternion [x, y, z, w]. Default [0, 0, 0, 1]. */
  orientation?: readonly [number, number, number, number];
  /** The space the layer is placed in. Default the XR reference space, followed through teleports. */
  space?: XRSpace;
  /** Composited under the scene (shown where the scene draws nothing) or over it. Default 'above' for quads, cylinders and video, 'below' for equirect and cube layers. */
  order?: 'below' | 'above';
}
/** An image the layer copies each frame it draws (WebGPU `copyExternalImageToTexture` sources). */
export type LayerImage =
  | ImageBitmap
  | ImageData
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | VideoFrame;
/** What a layer draws: one image for both eyes, one per eye, or a function that draws with WebGPU. */
export type LayerContent = LayerImage | { left: LayerImage; right: LayerImage } | ((target: LayerTarget) => void);
/** One eye's (or one cube face's) texture view of a layer, for a drawing function. */
export interface LayerTarget {
  readonly device: GPUDevice;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly viewport: { x: number; y: number; width: number; height: number };
  readonly eye: 'none' | 'left' | 'right';
  /** Cube face 0 to 5 (+X, -X, +Y, -Y, +Z, -Z); 0 for other layers. */
  readonly face: number;
}
interface Common extends LayerPlacement {
  /** Texture size of each eye's (or face's) image in pixels. */
  pixels: readonly [number, number];
  content: LayerContent;
  /** 'mono' (default), 'stereo' (an image per eye), 'stereo-left-right' or 'stereo-top-bottom' (one image holding both eyes). */
  layout?: 'mono' | 'stereo' | 'stereo-left-right' | 'stereo-top-bottom';
  /** Draw once (and again after the compositor asks with needsRedraw) instead of every frame. Default false. */
  isStatic?: boolean;
  /** Layer opacity 0 to 1. Default 1. */
  opacity?: number;
}
/** Options for {@link XRLayers.quad}. */
export interface QuadLayerOptions extends Common {
  /** Size in metres. Default [1, 1]. */
  size?: readonly [number, number];
}
/** Options for {@link XRLayers.cylinder}. */
export interface CylinderLayerOptions extends Common {
  /** Default 2 metres. */
  radius?: number;
  /** Visible arc in radians. Default PI / 4. */
  centralAngle?: number;
  /** Width over height of the visible arc. Default 2. */
  aspectRatio?: number;
}
/** Options for {@link XRLayers.equirect}. */
export interface EquirectLayerOptions extends Common {
  /** Sphere radius in metres; 0 is an infinite sphere (a sky). Default 0. */
  radius?: number;
  /** Default 2 PI. */
  centralHorizontalAngle?: number;
  /** Default PI / 2. */
  upperVerticalAngle?: number;
  /** Default -PI / 2. */
  lowerVerticalAngle?: number;
}
/** Options for {@link XRLayers.cube}: `pixels` is one face, square. */
export interface CubeLayerOptions extends Omit<Common, 'content' | 'layout' | 'position'> {
  /** Six faces in the order +X, -X, +Y, -Y, +Z, -Z, or a drawing function called per face. */
  content: readonly LayerImage[] | ((target: LayerTarget) => void);
  layout?: 'mono' | 'stereo';
}
/** Options for {@link XRLayers.video}. */
export interface VideoLayerOptions extends LayerPlacement {
  /** 'quad' (default), 'cylinder' or 'equirect'. */
  shape?: 'quad' | 'cylinder' | 'equirect';
  layout?: 'mono' | 'stereo-left-right' | 'stereo-top-bottom';
  /** Quad width in metres; the height follows the video's aspect ratio. Default 1. */
  width?: number;
  /** Cylinder or equirect radius in metres. Defaults 2 and 0. */
  radius?: number;
  /** Cylinder arc in radians. Default PI / 4. */
  centralAngle?: number;
  invertStereo?: boolean;
}
/** A layer shown by {@link XRLayers}. */
export interface XRPanel {
  readonly layer: XRCompositionLayer;
  /** Replaces what the layer draws; a static layer draws it on the next frame. */
  content: LayerContent | readonly LayerImage[] | null;
  /** Draws a static layer again on the next frame. */
  redraw(): void;
  /** Removes the layer from the session and destroys it. */
  dispose(): void;
}

const RENDER_ATTACHMENT = 0x10,
  COPY_DST = 0x02;
const unsupported = (what: string) =>
  margoError(
    'unsupported',
    `${what} needs the WebXR Layers module; request the session with optionalFeatures: ['layers'] on a browser whose XRGPUBinding creates layers`,
  );

interface Entry extends XRPanel {
  readonly order: 'below' | 'above';
  readonly follow: boolean;
  readonly stereo: boolean;
  readonly faces: number;
  readonly isStatic: boolean;
  dirty: boolean;
  drawn: boolean;
}

/**
 * The session's composition layers: crisp panels (quad, cylinder), 360 images and skies (equirect, cube) and video, each
 * shown by the compositor at its own rate and resolution. Attach after `xr.requestSession` with the 'layers' feature;
 * the layers go with the session. `using` or `dispose()` removes them.
 */
export class XRLayers {
  private readonly entries: Entry[] = [];
  private readonly stop: () => void;
  private space: XRSpace | undefined;
  private disposed = false;

  /** @throws MargoError 'state' without an immersive session; 'unsupported' without the 'layers' feature. */
  static attach(xr: XRLayersHost): XRLayers {
    const session = xr.session;
    if (!session || !xr.layerBinding)
      throw margoError(
        'state',
        'XRLayers needs an immersive session; await xr.requestSession(mode, { optionalFeatures: ["layers"] }) first',
      );
    if (session.enabledFeatures && !session.enabledFeatures.includes('layers')) throw unsupported('XRLayers');
    return new XRLayers(xr, session);
  }
  private constructor(
    private readonly xr: XRLayersHost,
    private readonly session: XRNativeSession,
  ) {
    this.space = xr.referenceSpace;
    this.stop = xr.onFrame((state) => this.frame(state.frame));
    session.addEventListener('end', this.ended);
  }
  /** A flat panel, sharp text and UI drawn once at full resolution. Faces +Z; only its front shows. */
  quad(options: QuadLayerOptions): XRPanel {
    const [width, height] = options.size ?? [1, 1];
    return this.add('createQuadLayer', options, 'above', [0, 1.5, -2], {
      width: positive(width, 'size[0]'),
      height: positive(height, 'size[1]'),
    });
  }
  /** A curved panel: part of a cylinder around its centre, seen from inside. */
  cylinder(options: CylinderLayerOptions): XRPanel {
    return this.add('createCylinderLayer', options, 'above', [0, 1.5, 0], {
      radius: positive(options.radius ?? 2, 'radius'),
      centralAngle: positive(options.centralAngle ?? Math.PI / 4, 'centralAngle'),
      aspectRatio: positive(options.aspectRatio ?? 2, 'aspectRatio'),
    });
  }
  /** An equirectangular image on the inside of a sphere: a 360 photo, or a sky with radius 0. */
  equirect(options: EquirectLayerOptions): XRPanel {
    return this.add('createEquirectLayer', options, 'below', [0, 0, 0], {
      radius: Math.max(0, options.radius ?? 0),
      centralHorizontalAngle: options.centralHorizontalAngle ?? 2 * Math.PI,
      upperVerticalAngle: options.upperVerticalAngle ?? Math.PI / 2,
      lowerVerticalAngle: options.lowerVerticalAngle ?? -Math.PI / 2,
    });
  }
  /** A cube map sky around the viewer; only its orientation counts. */
  cube(options: CubeLayerOptions): XRPanel {
    const [w, h] = options.pixels;
    if (w !== h) throw new RangeError(`cube layer faces must be square, got ${w} by ${h}; pass pixels: [size, size]`);
    const content = options.content;
    if (typeof content !== 'function' && (!Array.isArray(content) || content.length !== 6))
      throw new TypeError(
        'cube layer content needs six faces (+X, -X, +Y, -Y, +Z, -Z) or a drawing function; pass an array of six images',
      );
    return this.add('createCubeLayer', { ...options, content: content as LayerContent }, 'below', [0, 0, 0], {}, true);
  }
  /** A video shown by the compositor at the video's frame rate (XRMediaBinding); play and pause the element yourself. */
  video(video: HTMLVideoElement, options: VideoLayerOptions = {}): XRPanel {
    this.live();
    const Media = (
      globalThis as {
        XRMediaBinding?: new (
          session: XRNativeSession,
        ) => Record<string, (video: HTMLVideoElement, init: object) => XRCompositionLayer>;
      }
    ).XRMediaBinding;
    if (!Media) throw unsupported('XRLayers.video');
    const shape = options.shape ?? 'quad',
      { space, follow } = this.placementSpace(options),
      init: Record<string, unknown> = {
        space,
        layout: options.layout ?? 'mono',
        invertStereo: options.invertStereo ?? false,
        transform: rigid(options.position ?? (shape === 'quad' ? [0, 1.5, -2] : [0, 0, 0]), options.orientation),
      };
    if (shape === 'quad') init.width = positive(options.width ?? 1, 'width');
    if (shape === 'cylinder') {
      init.radius = positive(options.radius ?? 2, 'radius');
      init.centralAngle = positive(options.centralAngle ?? Math.PI / 4, 'centralAngle');
    }
    if (shape === 'equirect') init.radius = Math.max(0, options.radius ?? 0);
    const create = { quad: 'createQuadLayer', cylinder: 'createCylinderLayer', equirect: 'createEquirectLayer' }[shape];
    if (!create)
      throw new TypeError(`video shape '${shape}' is not one of 'quad', 'cylinder' or 'equirect'; pass one of those`);
    const layer = new Media(this.session)[create](video, init);
    return this.track(layer, null, options.order ?? 'above', follow, false, 1, true);
  }
  /** Removes every layer. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.session.removeEventListener('end', this.ended);
    const entries = this.entries.splice(0);
    if (this.xr.session === this.session) this.show();
    for (const entry of entries) entry.layer.destroy();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private readonly ended = (): void => this.dispose();
  private live(): void {
    if (this.disposed || this.xr.session !== this.session)
      throw margoError('state', 'XRLayers belongs to a session that ended; attach a new XRLayers to the new session');
  }
  private placementSpace(options: LayerPlacement): { space: XRSpace; follow: boolean } {
    const space = options.space ?? this.xr.referenceSpace;
    if (!space) throw margoError('state', 'XRLayers has no reference space; attach after xr.requestSession resolves');
    return { space, follow: !options.space };
  }
  private add(
    create: 'createQuadLayer' | 'createCylinderLayer' | 'createEquirectLayer' | 'createCubeLayer',
    options: Common | CubeLayerOptions,
    order: 'below' | 'above',
    position: readonly [number, number, number],
    extra: Record<string, unknown>,
    cube = false,
  ): XRPanel {
    this.live();
    const { binding } = this.xr.layerBinding!;
    if (!binding[create] || !binding.getSubImage) throw unsupported(`XRLayers ${create.slice(6, -5).toLowerCase()}`);
    const [w, h] = options.pixels ?? [];
    if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0))
      throw new RangeError(
        `layer pixels must be two positive whole numbers, got ${String(options.pixels)}; pass pixels: [width, height]`,
      );
    const layout = options.layout ?? 'mono',
      { space, follow } = this.placementSpace(options),
      init: Record<string, unknown> = {
        colorFormat: binding.getPreferredColorFormat(),
        textureUsage: RENDER_ATTACHMENT | COPY_DST,
        space,
        viewPixelWidth: w,
        viewPixelHeight: h,
        layout,
        isStatic: options.isStatic ?? false,
        ...extra,
      };
    if (cube) init.orientation = point(options.orientation ?? [0, 0, 0, 1]);
    else init.transform = rigid((options as Common).position ?? position, options.orientation);
    const layer = binding[create]!(init);
    if (options.opacity !== undefined) layer.opacity = Math.min(1, Math.max(0, options.opacity));
    return this.track(
      layer,
      options.content as LayerContent,
      options.order ?? order,
      follow,
      layout === 'stereo',
      cube ? 6 : 1,
      options.isStatic ?? false,
    );
  }
  private track(
    layer: XRCompositionLayer,
    content: LayerContent | null,
    order: 'below' | 'above',
    follow: boolean,
    stereo: boolean,
    faces: number,
    isStatic: boolean,
  ): XRPanel {
    const self = this,
      entry: Entry = {
        layer,
        content,
        order,
        follow,
        stereo,
        faces,
        isStatic,
        dirty: true,
        drawn: false,
        redraw() {
          entry.dirty = true;
        },
        dispose() {
          const i = self.entries.indexOf(entry);
          if (i < 0) return;
          self.entries.splice(i, 1);
          if (self.xr.session === self.session) self.show();
          layer.destroy();
        },
      };
    let current = content;
    Object.defineProperty(entry, 'content', {
      get: () => current,
      set: (value: LayerContent | null) => {
        current = value;
        entry.dirty = true;
      },
    });
    this.entries.push(entry);
    this.show();
    return entry;
  }
  private show(): void {
    this.xr.setLayers(
      this.entries.filter((e) => e.order === 'below').map((e) => e.layer),
      this.entries.filter((e) => e.order === 'above').map((e) => e.layer),
    );
  }
  private frame(frame: XRNativeFrame): void {
    if (this.disposed || frame.session !== this.session) return;
    const space = this.xr.referenceSpace;
    const moved = space !== this.space;
    this.space = space;
    const host = this.xr.layerBinding;
    if (!host) return;
    for (const entry of this.entries) {
      if (moved && entry.follow && space) entry.layer.space = space;
      const content = entry.content as LayerContent | readonly LayerImage[] | null;
      if (!content) continue;
      // A layer joins the render state at the next frame (WebXR Layers 11.2), so it draws from then on.
      if (!entry.drawn) {
        entry.drawn = true;
        continue;
      }
      if (entry.isStatic && !entry.dirty && !entry.layer.needsRedraw) continue;
      entry.dirty = false;
      const eyes = entry.stereo ? (['left', 'right'] as const) : (['none'] as const);
      for (const eye of eyes) {
        const image = host.binding.getSubImage!(entry.layer, frame, eye),
          descriptor = image.getViewDescriptor(),
          base = descriptor.baseArrayLayer ?? 0;
        for (let face = 0; face < entry.faces; face++) {
          const source = pick(content, eye, face);
          if (typeof source === 'function') {
            source({
              device: host.device,
              texture: image.colorTexture,
              view: image.colorTexture.createView({ ...descriptor, baseArrayLayer: base + face }),
              viewport: image.viewport,
              eye,
              face,
            });
          } else {
            const { x, y, width, height } = image.viewport,
              size = imageSize(source);
            host.device.queue.copyExternalImageToTexture(
              { source: source as GPUCopyExternalImageSource },
              { texture: image.colorTexture, origin: [x, y, base + face] },
              [Math.min(width, size[0]), Math.min(height, size[1])],
            );
          }
        }
      }
    }
  }
}

function pick(
  content: LayerContent | readonly LayerImage[],
  eye: 'none' | 'left' | 'right',
  face: number,
): LayerImage | ((target: LayerTarget) => void) {
  if (typeof content === 'function') return content;
  if (Array.isArray(content)) return content[face];
  if ('left' in (content as object) && 'right' in (content as object)) {
    const pair = content as { left: LayerImage; right: LayerImage };
    return eye === 'right' ? pair.right : pair.left;
  }
  return content as LayerImage;
}
function imageSize(source: LayerImage): [number, number] {
  const s = source as {
    videoWidth?: number;
    videoHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width: number;
    height: number;
  };
  if (s.videoWidth) return [s.videoWidth, s.videoHeight!];
  if (s.displayWidth) return [s.displayWidth, s.displayHeight!];
  if (s.naturalWidth) return [s.naturalWidth, s.naturalHeight!];
  return [s.width, s.height];
}
function positive(value: number, name: string): number {
  if (!(Number.isFinite(value) && value > 0))
    throw new RangeError(`layer ${name} must be a positive number, got ${value}; pass a size above 0`);
  return value;
}
const point = ([x, y, z, w]: readonly number[]) => ({ x, y, z, w });
function rigid(position: readonly number[], orientation: readonly number[] = [0, 0, 0, 1]): unknown {
  const Rigid = (globalThis as { XRRigidTransform?: new (p: object, o: object) => unknown }).XRRigidTransform;
  if (!Rigid) throw margoError('unsupported', 'XRRigidTransform is missing; run inside a WebXR browser');
  return new Rigid({ x: position[0], y: position[1], z: position[2], w: 1 }, point(orientation));
}

/**
 * Plays a short vibration on a controller: Gamepad Extensions `hapticActuators[0].pulse` where present, else the
 * Gamepad `vibrationActuator` 'dual-rumble' effect. Resolves true once played, false when the controller has no
 * actuator. `intensity` 0 to 1 (default 0.5), `milliseconds` default 50.
 */
export async function pulse(input: XRController | XRInputSource, intensity = 0.5, milliseconds = 50): Promise<boolean> {
  if (!(Number.isFinite(intensity) && Number.isFinite(milliseconds) && milliseconds >= 0))
    throw new RangeError(
      `pulse needs a finite intensity and a duration of 0 ms or more, got ${intensity} and ${milliseconds}; pass pulse(controller, 0.5, 50)`,
    );
  const source = 'source' in input ? input.source : input,
    pad = source.gamepad as
      | (Gamepad & { hapticActuators?: readonly { pulse?(value: number, duration: number): Promise<boolean> }[] })
      | null
      | undefined;
  const value = Math.min(1, Math.max(0, intensity));
  const actuator = pad?.hapticActuators?.[0];
  if (actuator?.pulse) return actuator.pulse(value, milliseconds);
  const vibration = (
    pad as
      | {
          vibrationActuator?: {
            effects?: readonly string[];
            playEffect?(type: string, params: object): Promise<string>;
          };
        }
      | null
      | undefined
  )?.vibrationActuator;
  if (vibration?.playEffect && (!vibration.effects || vibration.effects.includes('dual-rumble'))) {
    const result = await vibration.playEffect('dual-rumble', {
      duration: milliseconds,
      strongMagnitude: value,
      weakMagnitude: value,
    });
    return result === 'complete';
  }
  return false;
}

/** Options for {@link teleportArc}. */
export interface TeleportArcOptions {
  /** Launch speed in metres per second. Default 7. */
  speed?: number;
  /** Downward acceleration in metres per second squared. Default 9.81. */
  gravity?: number;
  /** Time step between samples in seconds. Default 0.02. */
  step?: number;
  /** Longest flight in seconds. Default 2. */
  maxTime?: number;
  /** The ground: a height, or a function of (x, z) giving the height there or null for no ground. Default 0. */
  ground?: number | ((x: number, z: number) => number | null);
}
/** A teleport arc: the sampled points [x, y, z, ...] up to the landing point, and where it lands (null when it does not). */
export interface TeleportArc {
  points: Float32Array;
  count: number;
  hit: [number, number, number] | null;
}

/**
 * The parabola a teleport pointer draws from `origin` along `direction` (a controller's target ray): points under
 * constant gravity, ending where it first passes below the ground. Allocation free when `out` is passed back.
 */
export function teleportArc(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  options: TeleportArcOptions = {},
  out?: TeleportArc,
): TeleportArc {
  const speed = options.speed ?? 7,
    gravity = options.gravity ?? 9.81,
    step = options.step ?? 0.02,
    maxTime = options.maxTime ?? 2,
    ground = options.ground ?? 0;
  if (![speed, gravity, step, maxTime].every(Number.isFinite) || step <= 0 || maxTime <= 0)
    throw new RangeError(
      'teleportArc needs finite speed and gravity and a positive step and maxTime; pass numbers such as { speed: 7, step: 0.02 }',
    );
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1,
    vx = (direction[0] / length) * speed,
    vy = (direction[1] / length) * speed,
    vz = (direction[2] / length) * speed,
    samples = Math.ceil(maxTime / step) + 1;
  const arc =
    out && out.points.length >= samples * 3 ? out : { points: new Float32Array(samples * 3), count: 0, hit: null };
  arc.count = 0;
  arc.hit = null;
  const height = (x: number, z: number) => (typeof ground === 'number' ? ground : ground(x, z));
  let px = origin[0],
    py = origin[1],
    pz = origin[2];
  for (let i = 0; i < samples; i++) {
    const t = Math.min(i * step, maxTime),
      x = origin[0] + vx * t,
      y = origin[1] + vy * t - 0.5 * gravity * t * t,
      z = origin[2] + vz * t,
      floor = height(x, z);
    if (floor !== null && y <= floor && i > 0) {
      // Linear crossing between the last sample above the ground and this one.
      const before = height(px, pz) ?? floor,
        above = py - before,
        below = floor - y,
        f = above + below > 0 ? above / (above + below) : 1,
        hx = px + (x - px) * f,
        hz = pz + (z - pz) * f;
      arc.hit = [hx, height(hx, hz) ?? floor, hz];
      arc.points.set(arc.hit, arc.count * 3);
      arc.count++;
      return arc;
    }
    arc.points[arc.count * 3] = x;
    arc.points[arc.count * 3 + 1] = y;
    arc.points[arc.count * 3 + 2] = z;
    arc.count++;
    px = x;
    py = y;
    pz = z;
  }
  return arc;
}

/**
 * Moves the player without moving their body: teleport to a floor point and snap turn, by offsetting the XR reference
 * space (WebXR `getOffsetReferenceSpace`). Poses, controllers, hits and world-locked layers all follow the new space.
 */
export class Locomotion {
  private readonly stop: () => void;
  private readonly feet = [0, 0, 0];
  /** The floor's height in the current space: 0 in the session's own space, the target's height after a teleport. */
  private floor = 0;
  private tracked = false;

  static attach(xr: XRLayersHost): Locomotion {
    return new Locomotion(xr);
  }
  private constructor(private readonly xr: XRLayersHost) {
    this.stop = xr.onFrame((state) => {
      const p = state.viewer?.transform.position;
      if (!p) return;
      this.feet[0] = p.x;
      this.feet[1] = this.floor;
      this.feet[2] = p.z;
      this.tracked = true;
    });
  }
  /**
   * Puts the player's feet at `target` (in the current space), turned by `yaw` radians (positive turns left, as seen
   * from above). Uses the last tracked viewer position; before the first frame it moves the space origin.
   */
  teleport(target: readonly [number, number, number], yaw = 0): void {
    if (!target.every(Number.isFinite) || !Number.isFinite(yaw))
      throw new RangeError('teleport needs a finite [x, y, z] target and yaw; pass a floor point such as arc.hit');
    this.offset(this.tracked ? this.feet : [0, this.floor, 0], target, yaw);
    // The feet are at the target in the new space from now on, before the next frame reports them.
    this.feet[0] = target[0];
    this.feet[1] = this.floor = target[1];
    this.feet[2] = target[2];
    this.tracked = true;
  }
  /** Turns the player by `yaw` radians about where they stand (positive turns left). */
  turn(yaw: number): void {
    if (!Number.isFinite(yaw))
      throw new RangeError(`turn needs a finite angle in radians, got ${yaw}; pass Math.PI / 6`);
    const here = this.tracked ? [...this.feet] : [0, this.floor, 0];
    this.offset(here, here, yaw);
  }
  dispose(): void {
    this.stop();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /**
   * Poses in the new space are t^-1 times poses in the old one, so t^-1 = T(target) R(yaw) T(-feet) carries the feet
   * to the target turned by yaw; t = T(feet) R(-yaw) T(-target) = T(feet - R(-yaw) target) R(-yaw).
   */
  private offset(feet: readonly number[], target: readonly number[], yaw: number): void {
    const space = this.xr.referenceSpace as (XRSpace & { getOffsetReferenceSpace?(t: unknown): XRSpace }) | undefined;
    if (!this.xr.session || !space?.getOffsetReferenceSpace)
      throw margoError(
        'state',
        'Locomotion needs an active XR session with a reference space; call it after xr.requestSession resolves',
      );
    const c = Math.cos(-yaw),
      s = Math.sin(-yaw),
      // R(-yaw) about +Y applied to the target.
      rx = c * target[0] + s * target[2],
      rz = -s * target[0] + c * target[2];
    const transform = rigid(
      [feet[0] - rx, feet[1] - target[1], feet[2] - rz],
      [0, Math.sin(-yaw / 2), 0, Math.cos(-yaw / 2)],
    );
    this.xr.useReferenceSpace(space.getOffsetReferenceSpace(transform));
  }
}
