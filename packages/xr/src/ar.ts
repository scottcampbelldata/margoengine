// AR understanding of the room: detected planes (WebXR Plane Detection Module), depth (WebXR Depth Sensing Module,
// CPU-optimized data) and light (WebXR Lighting Estimation API), each in the session's reference space and ready to
// place content, hide it behind real things or light it like the room. The planes' meshes come from ear clipping
// (Meisters, "Polygons have ears", 1975); the light estimate's spherical harmonics use @margoengine/math's SH3 layout,
// which is the order the Lighting Estimation API gives ([C00, C1-1, C10, C11, C2-2, C2-1, C20, C21, C22]).
import { Geometry, type EngineKernel, type Mesh, type PbrMaterial } from '@margoengine/core';
import { SH3 } from '@margoengine/math/sh';
import { margoError } from '../../shared/errors.js';
import type { XRFrameState, XRNativeFrame, XRNativeSession, XRPose, XRSpace, XRView } from './types.js';

/** What the AR helpers need of an `XR`. */
export interface ARHost {
  readonly session: XRNativeSession | null;
  readonly referenceSpace: XRSpace | undefined;
  onFrame(callback: (state: XRFrameState) => void): () => void;
}
/** The browser's XRPlane, as far as Margo reads it. */
export interface XRPlaneLike {
  readonly planeSpace: XRSpace;
  readonly polygon: readonly { x: number; y: number; z: number }[];
  readonly orientation?: 'horizontal' | 'vertical' | null;
  readonly lastChangedTime: number;
  readonly semanticLabel?: string | null;
}
/** One detected plane this frame. */
export interface DetectedPlane {
  /** The browser's plane; the same object every frame while it is tracked. */
  readonly plane: XRPlaneLike;
  /** Column-major pose of the plane's centre in the reference space; its y axis is the plane's normal. */
  readonly matrix: Float32Array;
  /** The outline, x and z per point in the plane's own space (y is always 0 there). */
  readonly polygon: Float32Array;
  readonly orientation: 'horizontal' | 'vertical' | null;
  /** What the device says the plane is, such as 'floor', 'wall' or 'table'; empty when it does not say. */
  readonly label: string;
  /** False while the plane's pose is unknown this frame. */
  tracked: boolean;
}
/** Options for {@link ARPlanes.create}. */
export interface ARPlanesOptions {
  /** Called when a plane is first seen. */
  onAdd?: (plane: DetectedPlane) => void;
  /** Called when a plane's outline, orientation or label changes. */
  onChange?: (plane: DetectedPlane) => void;
  /** Called when the device stops tracking a plane. */
  onRemove?: (plane: DetectedPlane) => void;
  /** Draws each plane as a mesh with this material; default none. */
  show?: { engine: EngineKernel; material: PbrMaterial };
}

/**
 * Triangles of a simple polygon given as x, z pairs, by ear clipping; works for both windings and for concave outlines.
 * Every triangle winds counter-clockwise seen from +y (its right-hand normal is +y), whichever way the outline runs.
 * @throws RangeError for fewer than 3 points or a non-finite one.
 */
export function triangulate(polygon: ArrayLike<number>): Uint32Array {
  const n = polygon.length / 2;
  if (!Number.isInteger(n) || n < 3)
    throw new RangeError('triangulate needs 3 or more x, z points; pass a plane outline');
  for (let i = 0; i < polygon.length; i++)
    if (!Number.isFinite(polygon[i])) throw new RangeError('triangulate needs finite points; pass a plane outline');
  const x = (i: number) => polygon[i * 2],
    z = (i: number) => polygon[i * 2 + 1];
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += x(j) * z(i) - x(i) * z(j);
  const sign = area >= 0 ? 1 : -1,
    cross = (a: number, b: number, c: number) => ((x(b) - x(a)) * (z(c) - z(a)) - (z(b) - z(a)) * (x(c) - x(a))) * sign,
    left = Array.from({ length: n }, (_, i) => i),
    out: number[] = [];
  let guard = 0;
  while (left.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let k = 0; k < left.length; k++) {
      const a = left[(k + left.length - 1) % left.length],
        b = left[k],
        c = left[(k + 1) % left.length];
      if (cross(a, b, c) <= 0) continue;
      let inside = false;
      for (const p of left)
        if (p !== a && p !== b && p !== c && cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) {
          inside = true;
          break;
        }
      if (inside) continue;
      out.push(a, b, c);
      left.splice(k, 1);
      clipped = true;
      break;
    }
    // A degenerate outline (repeated or collinear points) has no ear; drop a middle point and go on.
    if (!clipped) left.splice(1, 1);
  }
  if (left.length === 3 && cross(left[0], left[1], left[2]) > 0) out.push(left[0], left[1], left[2]);
  // The ears follow the outline's own winding. A positive area in (x, z) is clockwise seen from +y (x right, z towards
  // the viewer's bottom), so that winding is reversed; a negative one already faces +y.
  if (sign > 0) for (let i = 0; i < out.length; i += 3) [out[i + 1], out[i + 2]] = [out[i + 2], out[i + 1]];
  return Uint32Array.from(out);
}

/** A flat mesh of a plane outline (x, z pairs), in the plane's space, normal +y. */
export function planeGeometry(polygon: ArrayLike<number>): Geometry {
  const n = polygon.length / 2,
    indices = triangulate(polygon),
    positions = new Float32Array(n * 3),
    normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = polygon[i * 2];
    positions[i * 3 + 2] = polygon[i * 2 + 1];
    normals[i * 3 + 1] = 1;
  }
  // triangulate winds counter-clockwise from +y: core's front faces, seen from above the plane.
  return new Geometry(positions, normals, indices);
}

const active = (session: XRNativeSession | null, feature: string): boolean =>
  !session?.enabledFeatures || session.enabledFeatures.includes(feature);

/**
 * The planes an AR device has found, kept in step every frame. Start the session with the 'plane-detection' feature.
 * `planes` holds this frame's planes; `onAdd`, `onChange` and `onRemove` tell what changed; `show` draws them.
 * @throws MargoError 'state' without a session, 'unsupported' when the session has no 'plane-detection'.
 */
export class ARPlanes {
  /** This frame's planes by the browser's plane object. */
  readonly planes = new Map<XRPlaneLike, DetectedPlane>();
  private readonly changed = new Map<XRPlaneLike, number>();
  private readonly meshes = new Map<XRPlaneLike, Mesh>();
  private readonly unsubscribe: () => void;
  private constructor(
    private readonly host: ARHost,
    private readonly options: ARPlanesOptions,
  ) {
    this.unsubscribe = host.onFrame((state) => this.update(state.frame));
  }
  static create(xr: ARHost, options: ARPlanesOptions = {}): ARPlanes {
    if (!xr?.session) throw margoError('state', 'ARPlanes needs an active XR session; await xr.requestSession first');
    if (!active(xr.session, 'plane-detection'))
      throw margoError(
        'unsupported',
        "The XR session has no 'plane-detection' feature; ask for it when starting the session",
      );
    return new ARPlanes(xr, options);
  }
  /** Reads `frame.detectedPlanes`; runs from the XR frame hook. */
  update(frame: XRNativeFrame): void {
    const space = this.host.referenceSpace,
      set = (frame as { detectedPlanes?: ReadonlySet<XRPlaneLike> }).detectedPlanes;
    if (!space || !set) return;
    for (const [plane, entry] of this.planes)
      if (!set.has(plane)) {
        this.planes.delete(plane);
        this.changed.delete(plane);
        this.meshes.get(plane)?.dispose();
        this.meshes.delete(plane);
        this.options.onRemove?.(entry);
      }
    for (const plane of set) {
      const pose = frame.getPose(plane.planeSpace, space);
      let entry = this.planes.get(plane);
      const fresh = !entry,
        edited = !fresh && plane.lastChangedTime > (this.changed.get(plane) ?? -Infinity);
      if (fresh || edited) {
        const polygon = new Float32Array(plane.polygon.length * 2);
        plane.polygon.forEach((point, i) => {
          polygon[i * 2] = point.x;
          polygon[i * 2 + 1] = point.z;
        });
        entry = {
          plane,
          matrix: entry?.matrix ?? new Float32Array(16),
          polygon,
          orientation: plane.orientation ?? null,
          label: plane.semanticLabel ?? '',
          tracked: false,
        };
        this.planes.set(plane, entry);
        this.changed.set(plane, plane.lastChangedTime);
      }
      entry = entry!;
      entry.tracked = !!pose;
      if (pose) entry.matrix.set(pose.transform.matrix);
      if (fresh) this.options.onAdd?.(entry);
      else if (edited) this.options.onChange?.(entry);
      if (this.options.show) this.draw(entry, pose, fresh || edited);
    }
  }
  private draw(entry: DetectedPlane, pose: XRPose | null, outline: boolean): void {
    const { engine, material } = this.options.show!;
    let mesh = this.meshes.get(entry.plane);
    if (!mesh) this.meshes.set(entry.plane, (mesh = engine.createMesh().setMaterial(material)));
    if (outline && entry.polygon.length >= 6) mesh.setGeometry(planeGeometry(entry.polygon));
    mesh.visible = !!pose;
    if (pose) {
      const { position: p, orientation: o } = pose.transform;
      mesh.setPosition([p.x, p.y, p.z]).setQuaternion([o.x, o.y, o.z, o.w]);
    }
  }
  /** Stops following the planes and removes their meshes. */
  dispose(): void {
    this.unsubscribe();
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    this.planes.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** The browser's XRCPUDepthInformation, as far as Margo reads it. */
export interface XRDepthLike {
  readonly width: number;
  readonly height: number;
  readonly rawValueToMeters: number;
  readonly normDepthBufferFromNormView: { readonly matrix: Float32Array };
  getDepthInMeters(x: number, y: number): number;
  /** XRViewGeometry of the sensor, where it differs from the view. */
  readonly projectionMatrix?: Float32Array;
  readonly transform?: XRView['transform'];
}
/** What `depthSensing` to start an AR session with, for {@link ARDepth}: CPU data, 32-bit floats or 16-bit integers. */
export const DEPTH_SENSING = {
  usagePreference: ['cpu-optimized'],
  dataFormatPreference: ['float32', 'luminance-alpha', 'unsigned-short'],
} as const;

/**
 * Real-world depth in an AR session started with the 'depth-sensing' feature and `init: {depthSensing: DEPTH_SENSING}`:
 * distances at points of a view, and the world points behind them, to place things on real surfaces or test whether
 * something is behind a real object.
 * @throws MargoError 'state' without a session, 'unsupported' without depth sensing or with GPU-optimized depth.
 */
export class ARDepth {
  private constructor(private readonly host: ARHost) {}
  static create(xr: ARHost): ARDepth {
    const session = xr?.session as (XRNativeSession & { depthUsage?: string }) | null;
    if (!session) throw margoError('state', 'ARDepth needs an active XR session; await xr.requestSession first');
    if (!active(session, 'depth-sensing'))
      throw margoError(
        'unsupported',
        "The XR session has no 'depth-sensing' feature; ask for it with init: {depthSensing}",
      );
    // depthUsage throws InvalidStateError on a session without depth sensing (Depth Sensing Module, XRSession).
    let usage: string | undefined;
    try {
      usage = session.depthUsage;
    } catch (cause) {
      throw Object.assign(
        margoError(
          'unsupported',
          'The XR session has no depth sensing; start it with init: {depthSensing: DEPTH_SENSING}',
        ),
        { cause },
      );
    }
    if (usage !== undefined && usage !== 'cpu-optimized')
      throw margoError(
        'unsupported',
        "ARDepth reads CPU depth; start the session with usagePreference ['cpu-optimized']",
      );
    return new ARDepth(xr);
  }
  /** This frame's depth information for `view`, or null while the device has none. */
  information(frame: XRNativeFrame, view: XRView): XRDepthLike | null {
    const get = (frame as { getDepthInformation?(view: XRView): XRDepthLike | null }).getDepthInformation;
    return get ? (get.call(frame, view) ?? null) : null;
  }
  /**
   * Metres from the sensor to the real world at (`x`, `y`) of `view`, in normalized view coordinates (0 to 1, from the
   * top left), or null without depth this frame.
   * @throws RangeError for a point outside 0 to 1.
   */
  depthAt(frame: XRNativeFrame, view: XRView, x: number, y: number): number | null {
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1))
      throw new RangeError('ARDepth points run from 0 to 1 from the top left of the view; pass normalized coordinates');
    return this.information(frame, view)?.getDepthInMeters(x, y) ?? null;
  }
  /**
   * The real-world point at (`x`, `y`) of `view`, in the reference space, or null without depth this frame. The depth
   * is taken along the sensor's view axis.
   */
  pointAt(frame: XRNativeFrame, view: XRView, x: number, y: number): [number, number, number] | null {
    const info = this.information(frame, view);
    if (!info) return null;
    const depth = info.getDepthInMeters(x, y);
    if (!(depth > 0)) return null;
    const p = info.projectionMatrix ?? view.projectionMatrix,
      m = (info.transform ?? view.transform).matrix,
      // A perspective projection maps a view-space ray (rx, ry, -1) to clip x = p0 rx + p8 (-1), w = 1, so on the
      // screen at ndc: rx = (ndc + p8) / p0. Normalized view y grows downwards.
      ndcX = 2 * x - 1,
      ndcY = 1 - 2 * y,
      rx = (ndcX + p[8]) / p[0],
      ry = (ndcY + p[9]) / p[5],
      vx = rx * depth,
      vy = ry * depth,
      vz = -depth;
    return [
      m[0] * vx + m[4] * vy + m[8] * vz + m[12],
      m[1] * vx + m[5] * vy + m[9] * vz + m[13],
      m[2] * vx + m[6] * vy + m[10] * vz + m[14],
    ];
  }
}

/** The light of the room this frame, in the reference space. */
export interface LightEstimate {
  /**
   * Nine RGB spherical harmonics coefficients of the room's light, coefficient-major (the order of @margoengine/math
   * SH3), turned from the light probe's space into the reference space.
   */
  readonly sh: Float32Array;
  /** Unit direction towards the brightest light. */
  readonly direction: [number, number, number];
  /** The brightest light's RGB intensity. */
  readonly intensity: [number, number, number];
}
/**
 * The parts of `engine.lighting` that {@link ARLight} sets: `direction` xyz towards the sun with w its strength,
 * `radiance` rgb the sun's colour with w the ambient strength, `ambient` the ambient colour.
 */
export interface LightingLike {
  direction: Float32Array | number[];
  radiance: Float32Array | number[];
  ambient: Float32Array | number[];
}
/** The spherical harmonic basis Y00, 1 / (2 sqrt(pi)): the light from every direction, averaged, is C00 Y00. */
const Y00 = 0.28209479177387814;

/**
 * Light estimation in an AR session started with the 'light-estimation' feature: each frame's estimate in `estimate`,
 * and, with `lighting` given (such as `engine.lighting`), the engine's sun turned to the room's brightest light and its
 * ambient set to the room's average light, so virtual things are lit like the real ones next to them.
 * @throws MargoError 'state' without a session, 'unsupported' without the feature or the browser's light probes.
 */
export class ARLight {
  /** This frame's estimate, or null while the device has none. */
  estimate: LightEstimate | null = null;
  private readonly unsubscribe: () => void;
  private readonly sh = new SH3();
  private readonly turn = { x: 0, y: 0, z: 0, w: 1 };
  private readonly value = {
    sh: new Float32Array(27),
    direction: [0, 1, 0] as [number, number, number],
    intensity: [0, 0, 0] as [number, number, number],
  };
  private constructor(
    private readonly host: ARHost,
    private readonly probe: { probeSpace: XRSpace },
    private readonly lighting?: LightingLike,
  ) {
    this.unsubscribe = host.onFrame((state) => this.update(state.frame));
  }
  static async create(xr: ARHost, { lighting }: { lighting?: LightingLike } = {}): Promise<ARLight> {
    const session = xr?.session as
      | (XRNativeSession & { requestLightProbe?(init?: object): Promise<{ probeSpace: XRSpace }> })
      | null;
    if (!session) throw margoError('state', 'ARLight needs an active XR session; await xr.requestSession first');
    if (!active(session, 'light-estimation') || !session.requestLightProbe)
      throw margoError(
        'unsupported',
        "The XR session has no 'light-estimation' feature; ask for it when starting the session",
      );
    return new ARLight(xr, await session.requestLightProbe(), lighting);
  }
  /** Reads this frame's estimate and applies it; runs from the XR frame hook. */
  update(frame: XRNativeFrame): void {
    const get = (
        frame as {
          getLightEstimate?(
            probe: object,
          ): {
            sphericalHarmonicsCoefficients: Float32Array;
            primaryLightDirection: { x: number; y: number; z: number };
            primaryLightIntensity: { x: number; y: number; z: number };
          } | null;
        }
      ).getLightEstimate,
      found = get?.call(frame, this.probe),
      space = this.host.referenceSpace;
    if (!found || !space) {
      this.estimate = null;
      return;
    }
    const v = this.value,
      d = found.primaryLightDirection,
      pose = frame.getPose(this.probe.probeSpace, space),
      m = pose?.transform.matrix;
    // The estimate is relative to the probe's space (Lighting Estimation API, XRLightProbe): turn it into the reference
    // space, the harmonics by the probe's orientation and the direction by its matrix.
    this.sh.fromArray(found.sphericalHarmonicsCoefficients);
    if (pose) {
      const o = pose.transform.orientation;
      this.turn.x = o.x;
      this.turn.y = o.y;
      this.turn.z = o.z;
      this.turn.w = o.w;
      this.sh.rotate(this.turn);
    }
    this.sh.toArray(v.sh);
    v.direction[0] = m ? m[0] * d.x + m[4] * d.y + m[8] * d.z : d.x;
    v.direction[1] = m ? m[1] * d.x + m[5] * d.y + m[9] * d.z : d.y;
    v.direction[2] = m ? m[2] * d.x + m[6] * d.y + m[10] * d.z : d.z;
    const i = found.primaryLightIntensity;
    v.intensity[0] = i.x;
    v.intensity[1] = i.y;
    v.intensity[2] = i.z;
    this.estimate = v;
    const lighting = this.lighting;
    if (!lighting) return;
    const peak = Math.max(i.x, i.y, i.z);
    // Core: direction xyz towards the sun with w its intensity, radiance rgb its colour; with no estimated light the
    // intensity is 0, and the sun goes out.
    lighting.direction[0] = v.direction[0];
    lighting.direction[1] = v.direction[1];
    lighting.direction[2] = v.direction[2];
    lighting.direction[3] = peak;
    if (peak > 0) {
      lighting.radiance[0] = i.x / peak;
      lighting.radiance[1] = i.y / peak;
      lighting.radiance[2] = i.z / peak;
    }
    // Core's ambient term is albedo x radiance.w x ambient.rgb. Under light of average radiance L a Lambertian surface
    // sends back albedo x L, and L is C00 Y00, so the strength becomes 1 and the colour that average.
    lighting.radiance[3] = 1;
    for (let c = 0; c < 3; c++) lighting.ambient[c] = Math.max(0, v.sh[c] * Y00);
  }
  dispose(): void {
    this.unsubscribe();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
