// @margoengine/lightmap/global: the plain bake plus rectangle lights, emissive surfaces, diffuse bounces and straight
// coloured shadows through convex glass. The lightmap stays irradiance: receiver albedo is never multiplied in.
import { type BakeLight, bakeVertexColors } from '@margoengine/bvh/bake';
import { MeshBVH } from '@margoengine/bvh/tree';
import type { RectAreaLight } from '@margoengine/math';
import type { TransmissionOptions, VolumeOptions } from '@margoengine/materials/transmission';
import type { MutableVec3 as V3 } from '@margoengine/math';
import { createRandom } from '@margoengine/math/mathutils';
import { cross, dot, length, scale, sub } from '@margoengine/math/vec3';
import { type BakeInput, bake, checkpoint, inRange, type Occluders, type Plan, quadIndices } from './bake.js';
import type { Lightmap, LightmapOptions, LightmapQuads } from './index.js';
import { beer, clip, convexPlanes, fresnel, type Medium, mediumOf, type Plane, type Rect, rectOf } from './optics.js';

export type { RectAreaLight } from '@margoengine/math';

/**
 * A closed convex glass volume made of bake quads, outward wound with exactly shared edges. Its quads still get
 * charts but cast coloured shadows (Fresnel at each boundary, Beer absorption inside) instead of opaque ones, and do
 * not occlude AO. `factor` (default 1 here), `ior` and attenuation mean what they mean on the transmission material.
 */
export interface LightmapGlassVolume
  extends Pick<TransmissionOptions, 'factor' | 'ior'>,
    Pick<VolumeOptions, 'attenuationColor' | 'attenuationDistance'> {
  /** 4 to 64 quad indices; a quad belongs to at most one volume. */
  quads: readonly number[];
}

/** Options of {@link bakeGlobalLightmap}: those of `bakeLightmap` plus the extra light. */
export interface GlobalLightmapOptions extends LightmapOptions {
  /** Rectangle lights, the same objects the clustered `AreaLights` takes; baked shadows are always traced. */
  areaLights?: readonly RectAreaLight[];
  /** Shadow rays per texel per area light, 1 to 16, rounded up to a square grid. Default 4. */
  areaSamples?: number;
  /** Emissive quads light the others; with a `surface` callback each emitting texel is its own small light. */
  emissiveLights?: boolean;
  /** Diffuse bounces after the direct light: 0 to 2, or 0 to 8 with `bounceMode: 'path'`. Default 0. */
  bounces?: number;
  /** Cosine rays per texel per bounce (paths per texel with `bounceMode: 'path'`), 1 to 32. Default 8. */
  bounceRays?: number;
  /**
   * How indirect light is gathered. 'quad' (default): coarse radiosity, each bounce ray reads the mean light of the
   * quad it hits. 'path': each ray continues as a diffuse path of up to `bounces` segments, and every vertex reads the
   * direct, area and emissive light of the exact texel it reaches (next-event estimation cached per texel), so
   * indirect light varies across a quad as its light source does.
   */
  bounceMode?: 'quad' | 'path';
  /** Quads whose albedo alpha is below 1 cast no shadows (bounce rays still see them). Default false. */
  transmission?: boolean;
  /** At most 32 convex glass volumes; light passes through them in straight lines, without refraction. */
  glassVolumes?: readonly LightmapGlassVolume[];
}

/** What the extra pass reads per texel, in bake order, and the bake's occluders. */
interface Texels extends Occluders {
  light: Float64Array;
  emitted: Float64Array;
  albedo: Float64Array;
  metal: Float32Array;
  /** The quad of each texel. */
  owner: Uint16Array;
  points: Float32Array;
  normals: Float32Array;
  all: MeshBVH;
  raysLeft: number;
  physical: boolean;
  seed: number;
  signal?: AbortSignal;
}

interface Glass extends Medium {
  planes: Plane[];
  factor: number;
}

/** RGB share of light reaching `far` along a ray through the glass volumes. */
type Transport = (origin: ArrayLike<number>, direction: ArrayLike<number>, far: number) => V3;

function planGlass(input: readonly LightmapGlassVolume[], positions: Float32Array, count: number) {
  if (!Array.isArray(input) || input.length > 32)
    throw new RangeError('bakeGlobalLightmap glassVolumes must hold at most 32 volumes');
  const owned = new Set<number>(),
    volumes = input.map((value): Glass => {
      if (!Array.isArray(value?.quads) || value.quads.length < 4 || value.quads.length > 64)
        throw new RangeError('bakeGlobalLightmap glass volume needs 4 to 64 boundary quads');
      const triangles: V3[][] = [];
      for (const q of value.quads) {
        if (!Number.isInteger(q) || q < 0 || q >= count || owned.has(q))
          throw new RangeError('bakeGlobalLightmap glass quads must be valid quad indices, each in one volume only');
        owned.add(q);
        const c = [0, 1, 2, 3].map((i) => [...positions.subarray(q * 12 + i * 3, q * 12 + i * 3 + 3)] as V3);
        triangles.push([c[0], c[1], c[2]], [c[0], c[2], c[3]]);
      }
      return {
        ...mediumOf(value),
        planes: convexPlanes(triangles, 'bakeGlobalLightmap glass volume'),
        factor: inRange(value.factor ?? 1, 0, 1, 'bakeGlobalLightmap glass factor', false),
      };
    });
  const transport: Transport = (origin, direction, far) => {
    const out: V3 = [1, 1, 1];
    for (const v of volumes) {
      const hit = clip(v.planes, origin, direction);
      if (!hit) continue;
      const start = Math.max(0, hit.enter),
        end = Math.min(far, hit.exit);
      if (!(end > start)) continue;
      const cosine = (plane: number) => Math.min(1, Math.abs(dot(v.planes[plane].normal, direction)));
      // A ray starting inside has no entry boundary; a light inside the glass has no exit.
      let share = hit.enter >= 0 ? v.factor * (1 - fresnel(cosine(hit.entry), 1, v.ior)) : 1;
      if (hit.exit < far) share *= 1 - fresnel(cosine(hit.leaving), v.ior, 1);
      for (let c = 0; c < 3; c++) out[c] *= share * beer(v, c, end - start);
    }
    return out;
  };
  return { owned, transport };
}

/** Direct light with glass: each light's unshadowed term times its opaque visibility and its glass transport. */
function glassDirect(
  points: Float32Array,
  normals: Float32Array,
  lights: readonly BakeLight[],
  opaque: MeshBVH | null,
  includeFace: (face: number) => boolean,
  transport: Transport,
): Float64Array {
  const out = new Float64Array((points.length / 3) * 4);
  for (const light of lights) {
    if (light.visible === false) continue;
    const unshadowed = bakeVertexColors({ positions: points, normals }, null, { lights: [light], shadows: false });
    for (let i = 0; i < points.length / 3; i++) {
      if (!(unshadowed[i * 4] || unshadowed[i * 4 + 1] || unshadowed[i * 4 + 2])) continue;
      let visible: readonly number[] = [1, 1, 1];
      if (light.type !== 'ambient') {
        const p = points.subarray(i * 3, i * 3 + 3),
          directional = light.type === 'directional',
          origin = directional ? [0, 1, 2].map((a) => p[a] + normals[i * 3 + a] * 1e-3) : p,
          toward = directional ? light.direction! : sub(light.position!, p),
          far = directional ? Infinity : length(toward),
          direction = scale(toward, 1 / length(toward)),
          blocked = directional
            ? opaque?.raycastFirst({ origin, direction }, { far })
            : opaque?.intersectsSegment(origin, light.position!, { includeFace });
        visible = blocked ? [0, 0, 0] : transport(origin, direction, far);
      }
      for (let c = 0; c < 3; c++) out[i * 4 + c] += unshadowed[i * 4 + c] * visible[c];
    }
  }
  return out;
}

/**
 * A cosine-weighted direction about texel `i`'s normal: Malley's method (PBRT 4e sec. A.5) in a branchless basis (Duff
 * et al. 2017). Two random numbers per call, u then phi.
 */
function cosine(normals: Float32Array, i: number, random: () => number): number[] {
  const [rx, ry, rz] = normals.subarray(i * 3, i * 3 + 3),
    sign = rz >= 0 ? 1 : -1,
    k = -1 / (sign + rz || 1),
    m = rx * ry * k,
    u = random(),
    phi = 2 * Math.PI * random(),
    x = Math.sqrt(u) * Math.cos(phi),
    y = Math.sqrt(u) * Math.sin(phi),
    z = Math.sqrt(Math.max(0, 1 - u));
  return [
    (1 + sign * rx * rx * k) * x + m * y + rx * z,
    sign * m * x + (sign + ry * ry * k) * y + ry * z,
    -sign * rx * x - ry * y + rz * z,
  ];
}

/**
 * Path-traced bounces: from each texel, `bounceRays` cosine-sampled paths of up to `bounces` diffuse segments through
 * every quad. At each vertex the path adds its throughput times the outgoing radiance of the texel it hit (emission
 * and the reflected direct, area and emissive light of that texel: next-event estimation cached per texel, Kajiya
 * 1986), then continues from that texel with throughput times its diffuse albedo. Cosine sampling cancels the cosine
 * and the 1/pi of the Lambert BRDF, so irradiance is pi times the mean path radiance (legacy drops the pi, as the quad
 * gather does). The 1e-3 ray offset is Margo's.
 */
async function paths(
  t: Texels,
  input: BakeInput,
  o: { emissive: boolean; bounces: number; bounceRays: number },
  added: Float64Array,
  random: () => number,
) {
  const { light, emitted, albedo, metal, owner: quad, points, normals, physical } = t,
    samples = quad.length,
    radiance = new Float64Array(samples * 3),
    reflect = new Float64Array(samples * 3),
    gathered = new Float64Array(samples * 3);
  for (let i = 0; i < samples * 3; i++) {
    const texel = (i / 3) | 0;
    reflect[i] = albedo[i] * (1 - metal[texel]);
    const reflected = (light[i] + added[i]) * reflect[i];
    // Emissive rectangles already carried emission to the receivers; physical paths must not add it again.
    radiance[i] = (physical && o.emissive ? 0 : emitted[i]) + (physical ? reflected / Math.PI : reflected);
  }
  // Texel lookup: the hit's coordinates along p0 -> p1 and p0 -> p3 pick the texel of the quad's chart (bake order).
  const start = new Uint32Array(input.count),
    frame = new Float64Array(input.count * 9);
  for (let q = 0, at = 0; q < input.count; q++) {
    start[q] = at;
    at += input.frames[q].w * input.frames[q].h;
    for (let a = 0; a < 3; a++) {
      frame[q * 9 + a] = input.positions[q * 12 + a];
      frame[q * 9 + 3 + a] = input.positions[q * 12 + 3 + a] - input.positions[q * 12 + a];
      frame[q * 9 + 6 + a] = input.positions[q * 12 + 9 + a] - input.positions[q * 12 + a];
    }
  }
  const texelAt = (q: number, p: ArrayLike<number>) => {
    const f = frame.subarray(q * 9, q * 9 + 9),
      d = [p[0] - f[0], p[1] - f[1], p[2] - f[2]],
      uu = f[3] * f[3] + f[4] * f[4] + f[5] * f[5],
      uv = f[3] * f[6] + f[4] * f[7] + f[5] * f[8],
      vv = f[6] * f[6] + f[7] * f[7] + f[8] * f[8],
      du = d[0] * f[3] + d[1] * f[4] + d[2] * f[5],
      dv = d[0] * f[6] + d[1] * f[7] + d[2] * f[8],
      det = uu * vv - uv * uv,
      { w, h } = input.frames[q],
      x = Math.min(w - 1, Math.max(0, Math.floor(((du * vv - dv * uv) / det) * w))),
      y = Math.min(h - 1, Math.max(0, Math.floor(((dv * uu - du * uv) / det) * h)));
    return start[q] + y * w + x;
  };
  const through = [1, 1, 1];
  for (let i = 0; i < samples; i++) {
    if (!(i & 31)) await checkpoint(t.signal);
    for (let n = 0; n < o.bounceRays; n++) {
      let from = i,
        q = quad[i],
        origin = [0, 1, 2].map((a) => points[i * 3 + a] + normals[i * 3 + a] * 1e-3);
      through.fill(1);
      for (let depth = 0; depth < o.bounces; depth++) {
        const direction = cosine(normals, from, random),
          // No near cutoff: the origin is already off the surface, and a cutoff lets a ray born within it of a
          // neighbouring wall skip that wall and leak out at the corner (the furnace test's regression).
          hit = t.all.raycastFirst({ origin, direction }, { far: 1e6, side: 'double' }),
          seen = hit ? hit.faceIndex >> 1 : -1;
        // Opaque backs stop visibility too, but only the front emits or reflects toward the receiver.
        // A miss, or the path's own planar quad (only by rounding), also ends the path.
        if (seen < 0 || seen === q || !hit!.frontFace) break;
        const j = texelAt(seen, hit!.point);
        for (let c = 0; c < 3; c++) {
          gathered[i * 3 + c] += through[c] * radiance[j * 3 + c];
          through[c] *= reflect[j * 3 + c];
        }
        if (!(through[0] > 0 || through[1] > 0 || through[2] > 0)) break;
        from = j;
        q = seen;
        origin = [0, 1, 2].map((a) => hit!.point[a] + normals[j * 3 + a] * 1e-3);
      }
    }
  }
  const scale = (physical ? Math.PI : 1) / o.bounceRays;
  for (let i = 0; i < samples * 3; i++) added[i] += gathered[i] * scale;
}

/** Area, emissive and bounce light, added to the direct term in `t.light`. */
async function finish(
  t: Texels,
  input: BakeInput,
  o: {
    rects: Rect[];
    side: number;
    emissive: boolean;
    perTexel: boolean;
    bounces: number;
    bounceRays: number;
    path: boolean;
  },
  transport?: Transport,
) {
  const { light, emitted, albedo, metal, owner: quad, points, normals, physical } = t,
    samples = quad.length,
    added = new Float64Array(samples * 3),
    random = createRandom(t.seed);
  // Callback emission: count the emitting texels and check maxRays before building a light for each.
  if (o.perTexel) {
    let lit = 0;
    for (let i = 0; i < samples; i++) if (emitted[i * 3] > 0 || emitted[i * 3 + 1] > 0 || emitted[i * 3 + 2] > 0) lit++;
    const rays = samples * lit * o.side * o.side;
    if (rays > t.raysLeft)
      throw new RangeError(
        `bakeGlobalLightmap emissive texels need ${rays} more rays, over maxRays; emit from fewer texels`,
      );
  }
  // Each emitting texel (or quad) is a rectangle light that skips its own quad.
  const sources: [Rect, number][] = o.rects.map((rect) => [rect, -1]),
    edge = (q: number, from: number) =>
      [0, 1, 2].map((a) => input.positions[q * 12 + from + a] - input.positions[q * 12 + a]);
  if (o.emissive)
    for (let q = 0, texel = 0; q < input.count; q++) {
      const { w, h } = o.perTexel ? input.frames[q] : { w: 1, h: 1 },
        u = scale(edge(q, 3), 1 / w),
        v = scale(edge(q, 9), 1 / h),
        normal = scale(cross(u, v), 1 / length(cross(u, v)));
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++, texel++) {
          const radiance = (o.perTexel ? emitted.subarray(texel * 3) : input.emission?.subarray(q * 3)) ?? [0, 0, 0];
          if (!(radiance[0] > 0 || radiance[1] > 0 || radiance[2] > 0)) continue;
          const corner = [0, 1, 2].map((a) => input.positions[q * 12 + a] + u[a] * x + v[a] * y) as V3;
          sources.push([
            { corner, u, v, normal, radiance: [radiance[0], radiance[1], radiance[2]], twoSided: false },
            q,
          ]);
        }
    }
  // Direct form factor cos_i cos_j A / (pi r^2): Goral et al. 1984; Cohen & Wallace 1993.
  for (const [{ corner, u, v, normal, radiance, twoSided }, from] of sources) {
    const area = length(cross(u, v));
    for (let i = 0; i < samples; i++) {
      if (!(i & 31)) await checkpoint(t.signal);
      if (quad[i] === from) continue;
      const p = points.subarray(i * 3, i * 3 + 3),
        n = normals.subarray(i * 3, i * 3 + 3);
      for (let s = 0; s < o.side; s++)
        for (let r = 0; r < o.side; r++) {
          const a = (s + random()) / o.side,
            b = (r + random()) / o.side,
            target = [0, 1, 2].map((k) => corner[k] + u[k] * a + v[k] * b),
            toward = sub(target, p),
            distance = length(toward);
          if (!distance) continue;
          const l = scale(toward, 1 / distance),
            lambert = dot(n, l),
            facing = twoSided ? Math.abs(dot(normal, l)) : -dot(normal, l);
          if (!(lambert > 0 && facing > 0)) continue;
          if (
            t.shadow?.intersectsSegment(p, target, {
              side: 'double',
              includeFace: (face) => t.quad(face) !== quad[i] && t.quad(face) !== from,
            })
          )
            continue;
          const through = transport?.(p, l, distance) ?? [1, 1, 1],
            // Physical: L cos cos A / d^2 per sample; legacy keeps its historical extra 1/pi.
            weight = (lambert * facing * area) / (o.side * o.side * distance * distance * (physical ? 1 : Math.PI));
          for (let c = 0; c < 3; c++) added[i * 3 + c] += radiance[c] * weight * through[c];
        }
    }
  }
  if (o.path) {
    if (o.bounces) await paths(t, input, o, added, random);
    for (let i = 0; i < light.length; i++) light[i] += added[i];
    return;
  }
  // Coarse radiosity: each quad's mean outgoing radiance lights the texels whose bounce rays hit it.
  let outgoing = new Float64Array(input.count * 3);
  const weight = new Uint32Array(input.count);
  for (let i = 0; i < samples; i++) {
    const q = quad[i];
    weight[q]++;
    for (let c = 0; c < 3; c++) {
      // Emissive rectangles already carried emission to the receivers; physical bounces must not add it again.
      const reflected = (light[i * 3 + c] + added[i * 3 + c]) * albedo[i * 3 + c] * (1 - metal[i]),
        value = (physical && o.emissive ? 0 : emitted[i * 3 + c]) + (physical ? reflected / Math.PI : reflected);
      // A running mean keeps HDR sums from overflowing before the division.
      outgoing[q * 3 + c] += (value - outgoing[q * 3 + c]) / weight[q];
    }
  }
  for (let bounce = 0; bounce < o.bounces; bounce++) {
    const next = new Float64Array(input.count * 3),
      tried = new Uint32Array(input.count);
    for (let i = 0; i < samples; i++) {
      if (!(i & 31)) await checkpoint(t.signal);
      const origin = [0, 1, 2].map((a) => points[i * 3 + a] + normals[i * 3 + a] * 1e-3),
        q = quad[i];
      for (let n = 0; n < o.bounceRays; n++) {
        const direction = cosine(normals, i, random),
          hit = t.all.raycastFirst({ origin, direction }, { far: 1e6, side: 'double' }),
          seen = hit ? hit.faceIndex >> 1 : -1;
        tried[q]++;
        for (let c = 0; c < 3; c++) {
          // Cosine sampling: the mean incoming radiance times pi is irradiance (legacy drops the pi). A miss adds 0.
          const incoming = seen >= 0 && seen !== q && hit!.frontFace ? outgoing[seen * 3 + c] : 0;
          added[i * 3 + c] += (incoming / o.bounceRays) * (physical ? Math.PI : 1);
          // The next order's source: albedo times the mean over every ray, misses included.
          next[q * 3 + c] += (incoming * albedo[i * 3 + c] * (1 - metal[i]) - next[q * 3 + c]) / tried[q];
        }
      }
    }
    outgoing = next;
  }
  for (let i = 0; i < light.length; i++) light[i] += added[i];
}

/**
 * Bakes like `bakeLightmap` and adds rectangle lights, emissive quads (or texels), up to two diffuse bounces, alpha
 * shadow omission (`transmission`) and coloured shadows through convex glass. Physical radiometry integrates
 * L cos cos A / d^2 for rectangles; legacy keeps its historical /pi scaling. Bounces are per-quad means (coarse
 * radiosity) by default, or per-texel path-traced bounces with `bounceMode: 'path'`. Glass is straight-line visibility only: no refraction or caustics (see `@margoengine/lightmap/refracted`).
 * Every budget except the rays of callback emissive texels is checked before work starts; those are checked once the
 * callback has run, before any of them is traced.
 */
export async function bakeGlobalLightmap(quads: LightmapQuads, options: GlobalLightmapOptions = {}): Promise<Lightmap> {
  const mode = options.bounceMode ?? 'quad';
  if (mode !== 'quad' && mode !== 'path')
    throw new RangeError("bakeGlobalLightmap bounceMode must be 'quad' or 'path'");
  const area = (options.areaLights ?? []).map((light) => rectOf(light, 'bakeGlobalLightmap area light')),
    path = mode === 'path',
    bounces = inRange(options.bounces ?? 0, 0, path ? 8 : 2, 'bakeGlobalLightmap bounces'),
    bounceRays = inRange(options.bounceRays ?? 8, 1, 32, 'bakeGlobalLightmap bounceRays'),
    side = Math.ceil(Math.sqrt(inRange(options.areaSamples ?? 4, 1, 16, 'bakeGlobalLightmap areaSamples'))),
    emissive = !!options.emissiveLights,
    perTexel = emissive && !!options.surface;
  return bake(quads, options, (input): Plan => {
    const { positions, count, samples } = input,
      glass = options.glassVolumes?.length ? planGlass(options.glassVolumes, positions, count) : null,
      translucent = new Set<number>();
    if (options.transmission && input.albedo)
      for (let q = 0; q < count; q++) if (input.albedo[q * 4 + 3] < 1) translucent.add(q);
    let emitters = 0;
    if (emissive && !perTexel && input.emission)
      for (let q = 0; q < count; q++) if (input.emission.subarray(q * 3, q * 3 + 3).some((c) => c > 0)) emitters++;
    const extra = bounces || area.length || emissive,
      t = {
        albedo: new Float64Array(extra ? samples * 3 : 0),
        metal: new Float32Array(extra ? samples : 0),
        owner: new Uint16Array(extra ? samples : 0),
        points: new Float32Array(extra ? samples * 3 : 0),
        normals: new Float32Array(extra ? samples * 3 : 0),
        physical: options.radiometry === 'physical',
        seed: options.seed ?? 0,
        signal: options.signal,
      } as Texels,
      // Glass and alpha-omitted quads cast no opaque shadow; glass does not occlude AO either.
      without = (skip: Set<number>) => {
        const kept = Array.from({ length: count }, (_, q) => q).filter((q) => !skip.has(q));
        return {
          bvh: kept.length ? MeshBVH.build({ positions, indices: quadIndices(kept) }) : null,
          quad: (face: number) => kept[face >> 1],
        };
      };
    return {
      rays: samples * (bounces * bounceRays + (area.length + emitters) * side * side),
      // Per texel: albedo, metalness, quad, position and normal for the extra pass.
      bytes: extra ? samples * 54 : 0,
      occluders: (all) => {
        const shadow = translucent.size || glass ? without(new Set([...(glass?.owned ?? []), ...translucent])) : null;
        return Object.assign(t, {
          all,
          shadow: shadow ? shadow.bvh : all,
          quad: shadow ? shadow.quad : (face: number) => face >> 1,
          ao: glass ? (translucent.size ? without(glass.owned).bvh : shadow!.bvh) : all,
        });
      },
      texel: extra
        ? (i, q, position, normal, color, metalness) => {
            t.albedo.set([color[0], color[1], color[2]], i * 3);
            t.metal[i] = metalness;
            t.owner[i] = q;
            t.points.set(position, i * 3);
            t.normals.set(normal, i * 3);
          }
        : undefined,
      direct: glass
        ? (points, normals, lights, shadow, includeFace) =>
            glassDirect(points, normals, lights, shadow, includeFace, glass.transport)
        : undefined,
      finish: extra
        ? (light, emitted, raysLeft) =>
            finish(
              Object.assign(t, { light, emitted, raysLeft }),
              input,
              { rects: area, side, emissive, perTexel, bounces, bounceRays, path },
              glass?.transport,
            )
        : undefined,
    };
  });
}
