import { SkinnedMesh, type Skeleton2D } from './skeletal.js';
import { num, str, values, type SpineObject } from './spine-data.js';
import { point, RAD, rgba } from './spine-math.js';

/** A packed atlas region, in texels. Offsets are from the untrimmed image's bottom left. */
export interface SpineRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Packed rotation in degrees counterclockwise: 0, 90, 180 or 270. Default 0. */
  rotation?: number;
  originalWidth?: number;
  originalHeight?: number;
  offsetX?: number;
  offsetY?: number;
}
export interface Influence {
  bone: number;
  x: number;
  y: number;
  weight: number;
}
export interface AttachmentGeometry {
  influences: Influence[][];
  uvs: number[];
  indices: number[];
  deformLength: number;
  weighted: boolean;
  bone: number;
  sign: number;
  scale: number;
}
export function geometry(data: SpineObject, bone: number, sign: number, scale: number): AttachmentGeometry {
  const type = str(data.type, 'region');
  let vv: number[], uvs: number[], indices: number[];
  if (type === 'region') {
    const w = num(data.width),
      h = num(data.height),
      sx = num(data.scaleX, 1),
      sy = num(data.scaleY, 1),
      r = num(data.rotation) * RAD,
      c = Math.cos(r),
      s = Math.sin(r);
    vv = [];
    for (const [x, y] of [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ])
      vv.push(num(data.x) + x * sx * c - y * sy * s, num(data.y) + x * sx * s + y * sy * c);
    uvs = [0, 1, 1, 1, 1, 0, 0, 0];
    indices = [0, 1, 2, 2, 3, 0];
  } else if (type === 'point') {
    vv = [num(data.x), num(data.y)];
    uvs = [];
    indices = [];
  } else {
    vv = values(data.vertices);
    uvs = data.uvs === undefined ? [] : values(data.uvs);
    indices = data.triangles === undefined ? [] : values(data.triangles);
  }
  const n = type === 'region' ? 4 : type === 'point' ? 1 : uvs.length ? uvs.length / 2 : num(data.vertexCount);
  const weighted = vv.length !== n * 2,
    influences: Influence[][] = [];
  let at = 0,
    deformLength = 0;
  for (let i = 0; i < n; i++) {
    const list: Influence[] = [],
      count = weighted ? vv[at++] : 1;
    for (let j = 0; j < count; j++) {
      const joint = weighted ? vv[at++] : bone,
        x = vv[at++] * scale,
        y = vv[at++] * scale * sign,
        weight = weighted ? vv[at++] : 1;
      list.push({ bone: joint, x, y, weight });
      deformLength += 2;
    }
    influences.push(list);
  }
  return { influences, uvs, indices, weighted, deformLength, bone, sign, scale };
}
export function worldVertices(skeleton: Skeleton2D, g: AttachmentGeometry, deformation: Float64Array): Float64Array {
  const out = new Float64Array(g.influences.length * 2);
  let at = 0;
  for (let i = 0; i < g.influences.length; i++)
    for (const joint of g.influences[i]) {
      const p = point(skeleton.bones[joint.bone].world, joint.x + deformation[at++], joint.y + deformation[at++]);
      out[i * 2] += p[0] * joint.weight;
      out[i * 2 + 1] += p[1] * joint.weight;
    }
  return out;
}
function texels(g: AttachmentGeometry, region: SpineRegion): Float32Array {
  const out = new Float32Array(g.uvs.length),
    rotation = (((region.rotation ?? 0) % 360) + 360) % 360;
  for (let i = 0; i < out.length; i += 2) {
    const originalWidth = region.originalWidth ?? (rotation % 180 ? region.height : region.width),
      originalHeight = region.originalHeight ?? (rotation % 180 ? region.width : region.height);
    const width = rotation % 180 ? region.height : region.width,
      height = rotation % 180 ? region.width : region.height;
    let u = (g.uvs[i] * originalWidth - (region.offsetX ?? 0)) / width;
    let v = (g.uvs[i + 1] * originalHeight - (originalHeight - (region.offsetY ?? 0) - height)) / height;
    if (rotation === 90) [u, v] = [v, 1 - u];
    else if (rotation === 180) [u, v] = [1 - u, 1 - v];
    else if (rotation === 270) [u, v] = [1 - v, u];
    out[i] = region.x + u * region.width;
    out[i + 1] = region.y + v * region.height;
  }
  return out;
}
type Vertex = [number, number, number, number];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
// Ear clipping, followed by convex polygon clipping of each textured triangle. UVs interpolate at every cut.
function clipTriangles(polygon: Float64Array): number[][][] {
  const points: number[][] = [];
  for (let i = 0; i < polygon.length; i += 2) points.push([polygon[i], polygon[i + 1]]);
  const area = points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + p[0] * q[1] - p[1] * q[0];
  }, 0);
  if (area < 0) points.reverse();
  const out: number[][][] = [];
  while (points.length > 3) {
    let found = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length],
        b = points[i],
        c = points[(i + 1) % points.length];
      if (cross(a, b, c) <= 0) continue;
      if (
        points.some(
          (p) => p !== a && p !== b && p !== c && cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0,
        )
      )
        continue;
      out.push([a, b, c]);
      points.splice(i, 1);
      found = true;
      break;
    }
    if (!found) return []; // A collapsed pose has no clipping area.
  }
  if (points.length === 3 && cross(points[0], points[1], points[2]) > 0) out.push(points);
  return out;
}
function cut(
  vertices: Float64Array,
  uvs: Float32Array,
  indices: number[],
  polygon: Float64Array,
): { positions: Float64Array; uvs: Float32Array; indices: Uint32Array } {
  const positions: number[] = [],
    texture: number[] = [],
    triangles: number[] = [];
  for (const clip of clipTriangles(polygon))
    for (let at = 0; at < indices.length; at += 3) {
      let poly: Vertex[] = indices
        .slice(at, at + 3)
        .map((i) => [vertices[i * 2], vertices[i * 2 + 1], uvs[i * 2], uvs[i * 2 + 1]]);
      for (let edge = 0; edge < 3; edge++) {
        const a = clip[edge],
          b = clip[(edge + 1) % 3],
          next: Vertex[] = [];
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i],
            q = poly[(i + 1) % poly.length],
            dp = cross(a, b, p),
            dq = cross(a, b, q);
          if (dp >= 0) next.push(p);
          if (dp >= 0 !== dq >= 0) {
            const t = dp / (dp - dq);
            next.push(p.map((v, j) => v + (q[j] - v) * t) as Vertex);
          }
        }
        poly = next;
      }
      const base = positions.length / 2;
      for (const p of poly) {
        positions.push(p[0], p[1]);
        texture.push(p[2], p[3]);
      }
      for (let i = 1; i + 1 < poly.length; i++) triangles.push(base, base + i, base + i + 1);
    }
  return {
    positions: Float64Array.from(positions),
    uvs: Float32Array.from(texture),
    indices: Uint32Array.from(triangles),
  };
}

/** An imported attachment, including nonrendering paths, bounds, points and clipping polygons. */
export class SpineAttachment {
  /** Exported type; omitted types become region. */
  readonly type: string;
  /** Per-influence offsets for weighted attachments, per-vertex otherwise, in rig units. */
  readonly deformation: Float64Array;
  /** A SkinnedMesh usable by SkeletalLayer, absent for nonrendering attachment types. */
  readonly mesh?: SpineMesh;
  /** Current image sequence frame; setup index when no sequence timeline applies. */
  sequenceIndex: number;
  /** @internal */
  source: SpineAttachment = this;
  constructor(
    /** Exported attachment properties, retained without rewriting defaults. */
    readonly data: SpineObject,
    /** Owning skeleton. */
    readonly skeleton: Skeleton2D,
    /** @internal */ readonly geometry: AttachmentGeometry,
    /** @internal */ readonly region: (index: number) => SpineRegion,
  ) {
    this.type = str(data.type, 'region');
    this.deformation = new Float64Array(geometry.deformLength);
    this.sequenceIndex = data.sequence === undefined ? 0 : num((data.sequence as SpineObject).setup);
    if (['region', 'mesh', 'linkedmesh', 'weightedmesh', 'skinnedmesh'].includes(this.type))
      this.mesh = new SpineMesh(this);
  }
  /** All transformed vertices, x/y pairs. Points return a single pair; pointRotation gives their angle. */
  worldVertices(): Float64Array {
    if (this.type === 'region') {
      const g = this.geometry,
        fresh = regionGeometry(this.data, this.region(this.sequenceIndex), g.bone, g.sign, g.scale);
      g.influences = fresh.influences;
      g.uvs = fresh.uvs;
    }
    return worldVertices(this.skeleton, this.geometry, this.deformation);
  }
  /** World angle in radians for a point attachment, including bone reflection and attachment rotation. */
  get pointRotation(): number {
    const m = this.skeleton.bones[this.geometry.influences[0][0].bone].world,
      r = num(this.data.rotation) * RAD * this.geometry.sign;
    return Math.atan2(m[1] * Math.cos(r) + m[3] * Math.sin(r), m[0] * Math.cos(r) + m[2] * Math.sin(r));
  }
}

/** SkinnedMesh with exact exported per-influence bind positions, any number of influences, and deform keys. */
export class SpineMesh extends SkinnedMesh {
  /** Current render vertex count, including clipping intersections. */
  override vertexCount = 0;
  /** Current atlas texels, including rotated and trimmed regions. */
  override uvs: Float32Array = new Float32Array(0);
  /** Current triangles after clipping. */
  override indices: Uint32Array = new Uint32Array(0);
  private output: Float64Array = new Float64Array(0);
  constructor(/** The imported attachment that owns this mesh. */ readonly attachment: SpineAttachment) {
    super({
      skeleton: attachment.skeleton,
      positions: [0, 0, 0, 0, 0, 0],
      uvs: [0, 0, 0, 0, 0, 0],
      indices: [0, 1, 2],
      joints: new Array(12).fill(0),
      weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      jointPositions: new Array(24).fill(0),
    });
    const color = rgba(attachment.data.color);
    this.tint = Math.round(color[0] * 255) * 65536 + Math.round(color[1] * 255) * 256 + Math.round(color[2] * 255);
    this.alpha = color[3];
    this.prepare();
  }
  /** @internal Refresh before SkeletalLayer counts vertices, so clipping may change topology. */
  prepare(polygon?: Float64Array): void {
    const a = this.attachment,
      positions = a.worldVertices(),
      uvs = texels(a.geometry, a.region(a.sequenceIndex));
    if (polygon) {
      const result = cut(positions, uvs, a.geometry.indices, polygon);
      this.output = result.positions;
      this.uvs = result.uvs;
      this.indices = result.indices;
    } else {
      this.output = positions;
      this.uvs = uvs;
      this.indices = Uint32Array.from(a.geometry.indices);
    }
    this.vertexCount = this.output.length / 2;
  }
  /** Current skinned and clipped positions, computed during the skeleton's update. */
  override deform(): Float64Array {
    return this.output;
  }
}

export function sequenceIndex(data: SpineObject, key: SpineObject, time: number): number {
  const count = num(data.count),
    mode = str(key.mode, 'hold'),
    start = num(key.index),
    delay = num(key.delay, 1);
  let index = mode === 'hold' ? start : start + Math.floor((time - num(key.time)) / delay);
  const reverse = mode.endsWith('Reverse');
  if (mode.startsWith('pingpong')) {
    const period = Math.max(1, count * 2 - 2);
    index = ((index % period) + period) % period;
    if (index >= count) index = period - index;
  } else if (mode.startsWith('loop')) index = ((index % count) + count) % count;
  else index = Math.max(0, Math.min(count - 1, index));
  return reverse ? count - 1 - index : index;
}
export function regionGeometry(
  data: SpineObject,
  region: SpineRegion,
  bone: number,
  sign: number,
  scale: number,
): AttachmentGeometry {
  const g = geometry(data, bone, sign, scale);
  if (str(data.type, 'region') !== 'region') return g;
  const rotation = region.rotation ?? 0,
    packedW = rotation % 180 ? region.height : region.width,
    packedH = rotation % 180 ? region.width : region.height;
  const originalW = region.originalWidth ?? packedW,
    originalH = region.originalHeight ?? packedH;
  const x0 = (region.offsetX ?? 0) / originalW,
    y0 = (region.offsetY ?? 0) / originalH,
    x1 = x0 + packedW / originalW,
    y1 = y0 + packedH / originalH;
  const source = g.influences.map((v) => v[0]);
  const at = (u: number, v: number): Influence => ({
    ...source[0],
    x: source[0].x + (source[1].x - source[0].x) * u + (source[3].x - source[0].x) * v,
    y: source[0].y + (source[1].y - source[0].y) * u + (source[3].y - source[0].y) * v,
  });
  g.influences = [[at(x0, y0)], [at(x1, y0)], [at(x1, y1)], [at(x0, y1)]];
  g.uvs = [x0, 1 - y0, x1, 1 - y0, x1, 1 - y1, x0, 1 - y1];
  return g;
}
