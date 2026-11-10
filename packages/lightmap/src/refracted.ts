// @margoengine/lightmap/refracted: caustics. Photons from finite lights refract and reflect through ideal convex glass
// (Snell, Fresnel, total internal reflection, Beer absorption, nested media) and land in the native atlas.
// Optics after PBRT 4e 9.3 (https://pbr-book.org/4ed/Reflection_Models/Specular_Reflection_and_Transmission); rough
// glass, dispersion and the receiver bounce are in rough.ts and below.
import type { BakeLight } from '@margoengine/bvh/bake';
import { MeshBVH } from '@margoengine/bvh/tree';
import type { RectAreaLight } from '@margoengine/math';
import type { TransmissionOptions, VolumeOptions } from '@margoengine/materials/transmission';
import type { MutableVec3 as V3, Vec3 } from '@margoengine/math';
import { parseColor } from '@margoengine/math/color';
import { createRandom } from '@margoengine/math/mathutils';
import { add, cross, dot, length, normalize, scale, sub } from '@margoengine/math/vec3';
import { finiteVector } from '@margoengine/math/validate';
import { bake, checkpoint, fillGutters, inRange, quadIndices, unit } from './bake.js';
import type { Lightmap, LightmapOptions, LightmapQuads } from './index.js';
import { beer, clip, convexPlanes, fresnel, type Medium, mediumOf, type Plane, rectOf } from './optics.js';
import { cauchy, sampleVisibleNormal, smithG1, visible, wavelengthRgb } from './rough.js';

export { cauchy, sampleVisibleNormal, smithG1, wavelengthRgb } from './rough.js';

/**
 * A closed convex glass boundary as indexed triangles, outward wound with exactly shared edges. Volumes must be
 * strictly apart or strictly nested (no overlap or contact); a nested volume's IOR is absolute, and only the
 * innermost medium absorbs. `ior` and attenuation mean what they mean on the transmission material.
 */
export interface RefractedGlassVolume
  extends Pick<TransmissionOptions, 'ior' | 'dispersion'>,
    Pick<VolumeOptions, 'attenuationColor' | 'attenuationDistance'> {
  positions: Float32Array;
  indices: Uint32Array;
  /**
   * Surface roughness, 0 (ideal, default) to 1; GGX alpha is its square. Each boundary event samples a visible
   * microfacet normal for Fresnel and Snell, and Smith masking of the outgoing direction removes the share that would
   * scatter again on the microsurface (`diagnostics.masked`).
   */
  roughness?: number;
}

/**
 * A light for {@link bakeRefractedLightmap}, outside every glass volume:
 * - a point `BakeLight`: `color * intensity` is the irradiance at one unit, so it emits 4 pi times that in all;
 * - a directional `BakeLight` limited to `aperture`, a parallelogram perpendicular to `direction` (toward the light,
 *   as always); `color * intensity` is the irradiance across the beam;
 * - a clustered `RectAreaLight` with `type: 'area'`, emitting `color * intensity` radiance from its face(s).
 * Point and directional `distance` and `decay` are ignored: photons fall off physically.
 */
export type RefractedEmitter =
  | (BakeLight & { type: 'point' })
  | (BakeLight & { type: 'directional'; aperture: { corner: Vec3; edgeU: Vec3; edgeV: Vec3 } })
  | (RectAreaLight & { type: 'area' });

/** Options of {@link bakeRefractedLightmap}: the atlas options of `bakeLightmap` plus the photon transport. */
export interface RefractedLightmapOptions
  extends Pick<
    LightmapOptions,
    | 'texelsPerUnit'
    | 'padding'
    | 'maxAtlasSize'
    | 'maxCharts'
    | 'maxSamples'
    | 'maxRays'
    | 'maxBytes'
    | 'seed'
    | 'signal'
  > {
  /** At most 32 volumes with at most 128 triangles in all. */
  glassVolumes: readonly RefractedGlassVolume[];
  /** 1 to 16 lights. */
  emitters: readonly RefractedEmitter[];
  /** Photons shared by the emitters, at least one each, at most 1,048,576. Default 65,536. */
  photons?: number;
  /** Most reflections and refractions per photon, 1 to 32; the rest of its power counts as truncated. Default 8. */
  maxEvents?: number;
  /** Also deposit light that reaches a receiver without touching glass. Default false (caustics only). */
  includeDirect?: boolean;
  /**
   * Diffuse bounces after glass, 0 to 4. Default 0. A photon that touched glass deposits where it lands, then
   * continues cosine-weighted from that receiver with its power times the quad's albedo (`diagnostics.reflected`).
   */
  bounces?: number;
  /** Called with photons done and photons in all, every 256 photons. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Where the emitted power went (RGB watts; the seven terminal terms add up to `emitted` plus `reflected`), and work
 * counts.
 */
export interface RefractedDiagnostics {
  emitted: V3;
  /** Sent on again by receivers after a deposit (`bounces`); a source term, not a terminal one. */
  reflected: V3;
  /** Landed on a receiver after at least one glass event. */
  deposited: V3;
  /** Left the scene. */
  escaped: V3;
  /** Absorbed inside glass. */
  absorbed: V3;
  /** Still travelling after `maxEvents`. */
  truncated: V3;
  /** Reached a receiver's front without touching glass; in the atlas only with `includeDirect`. */
  unrefracted: V3;
  /** Hit a receiver's back face, which is opaque. */
  blocked: V3;
  /** Lost to Smith masking at rough glass (light the microsurface would scatter again). */
  masked: V3;
  photons: number;
  /** Receiver ray casts and glass boundary tests the photons made. */
  rays: number;
  reflections: number;
  refractions: number;
  totalInternalReflections: number;
  /** Diffuse bounces off receivers. */
  bounced: number;
}

/** What {@link bakeRefractedLightmap} returns. */
export interface RefractedLightmap {
  /** The native atlas (materials, UVs, white AO) with the caustic irradiance in its lightmap texture. */
  atlas: Lightmap;
  /** RGB irradiance per atlas pixel, W per square world unit; gutters repeat chart edges. */
  irradiance: Float64Array;
  /** Photons deposited per atlas pixel (chart interiors only). */
  hits: Uint32Array;
  diagnostics: RefractedDiagnostics;
}

interface Volume extends Medium {
  /** GGX alpha; 0 for ideal glass. */
  alpha: number;
  /** The index at a wavelength in nm, when the volume disperses. */
  dispersive?: (nanometres: number) => number;
  planes: Plane[];
  vertices: V3[];
  edges: V3[];
  size: number;
}

/** Light leaving a source: start point and direction, from two stratified numbers and the random stream. */
type Source = { power: V3; emit(u: number, v: number, random: () => number): [V3, V3] };

const label = 'bakeRefractedLightmap';

/** Separating-axis test for convex point sets; a gap within rounding of contact counts as touching. */
function separate(a: V3[], an: V3[], ae: V3[], b: V3[], bn: V3[], be: V3[]): boolean {
  const apart = (axis: V3) => {
    const l = length(axis);
    if (!(l > 0)) return false;
    const n = scale(axis, 1 / l),
      range = (points: V3[]) => {
        const d = points.map((p) => dot(n, sub(p, a[0])));
        return [Math.min(...d), Math.max(...d)];
      },
      [amin, amax] = range(a),
      [bmin, bmax] = range(b),
      error = 128 * Number.EPSILON * Math.max(...[...a, ...b].map((p) => length(sub(p, a[0]))));
    return bmin - amax > error || amin - bmax > error;
  };
  return an.some(apart) || bn.some(apart) || ae.some((x) => be.some((y) => apart(cross(x, y))));
}

function volumesOf(input: readonly RefractedGlassVolume[]) {
  if (!Array.isArray(input) || input.length > 32)
    throw new RangeError(`${label} glassVolumes must hold at most 32 volumes`);
  if (input.reduce((sum, v) => sum + (v?.indices?.length ?? 0) / 3, 0) > 128)
    throw new RangeError(`${label} glass allows at most 128 triangles in all`);
  const volumes = input.map((value): Volume => {
    if (
      !(value?.positions instanceof Float32Array) ||
      !(value.indices instanceof Uint32Array) ||
      value.indices.length % 3
    )
      throw new TypeError(`${label} glass needs Float32Array positions and Uint32Array triangle indices`);
    const corner = (i: number): V3 => {
        if (i * 3 + 2 >= value.positions.length)
          throw new RangeError(`${label} glass index out of range; use an index of refraction of 1 or more`);
        const p = [...value.positions.subarray(i * 3, i * 3 + 3)] as V3;
        if (!p.every(Number.isFinite)) throw new RangeError(`${label} glass positions must be finite`);
        return p;
      },
      triangles = Array.from({ length: value.indices.length / 3 }, (_, t) =>
        [0, 1, 2].map((k) => corner(value.indices[t * 3 + k])),
      ),
      vertices = [...new Map(triangles.flat().map((p) => [`${p}`, p])).values()],
      roughness = inRange(value.roughness ?? 0, 0, 1, `${label} glass roughness`, false),
      medium = mediumOf(value);
    return {
      ...medium,
      alpha: roughness * roughness,
      ...(medium.dispersion > 0 ? { dispersive: cauchy(medium.ior, 20 / medium.dispersion) } : {}),
      planes: convexPlanes(triangles, `${label} glass volume`),
      vertices,
      edges: triangles.flatMap(([a, b, c]) => [sub(b, a), sub(c, b), sub(a, c)]),
      size: Math.max(...vertices.map((p) => length(sub(p, vertices[0])))),
    };
  });
  // A volume's parent is its innermost container: the one inside the most others. Pairs are apart or nested.
  const inside = (outer: Volume, inner: Volume) =>
      outer.planes.every((p) => inner.vertices.every((v) => dot(p.normal, sub(v, p.point)) < -1e-7 * outer.size)),
    normals = (v: Volume) => v.planes.map((p) => p.normal),
    containers = volumes.map((inner, i) =>
      volumes.flatMap((outer, j) => {
        if (
          i === j ||
          separate(inner.vertices, normals(inner), inner.edges, outer.vertices, normals(outer), outer.edges)
        )
          return [];
        if (inside(outer, inner)) return [j];
        if (!inside(inner, outer))
          throw new RangeError(`${label} glass volumes must be strictly apart or nested, without overlap or contact`);
        return [];
      }),
    ),
    parents = containers.map((list) =>
      list.reduce((best, j) => (best < 0 || containers[j].length > containers[best].length ? j : best), -1),
    );
  return { volumes, parents };
}

function sourcesOf(emitters: readonly RefractedEmitter[], volumes: Volume[]): Source[] {
  if (!Array.isArray(emitters) || emitters.length < 1 || emitters.length > 16)
    throw new RangeError(`${label} needs 1 to 16 emitters`);
  const outside = (points: V3[], normals: V3[], edges: V3[]) => {
    for (const v of volumes)
      if (
        !separate(
          points,
          normals,
          edges,
          v.vertices,
          v.planes.map((p) => p.normal),
          v.edges,
        )
      )
        throw new RangeError(`${label} emitters must lie wholly outside glass, without contact`);
  };
  const rgbOf = (light: BakeLight) => {
    const rgb = scale(
      parseColor(light.color ?? [1, 1, 1]),
      inRange(light.intensity ?? 1, 0, Infinity, `${label} intensity`, false),
    );
    if (rgb.some((c) => !(c >= 0 && c < Infinity))) throw new RangeError(`${label} light color must be 0 or more`);
    return rgb;
  };
  return emitters.map((e): Source => {
    if (e?.type === 'point') {
      finiteVector(e.position!, 3, `${label} point position`);
      const position = [...e.position!] as V3;
      outside([position], [], []);
      return {
        power: scale(rgbOf(e), 4 * Math.PI),
        emit: (u, v) => {
          const y = 1 - 2 * u,
            r = Math.sqrt(Math.max(0, 1 - y * y));
          return [[...position], [r * Math.cos(2 * Math.PI * v), y, r * Math.sin(2 * Math.PI * v)]];
        },
      };
    }
    const rect =
      e?.type === 'area'
        ? rectOf(e, `${label} area light`)
        : e?.type === 'directional'
          ? (() => {
              for (const key of ['corner', 'edgeU', 'edgeV'] as const)
                finiteVector(e.aperture?.[key], 3, `${label} aperture ${key}`);
              const normal = unit(e.direction!, `${label} direction`),
                { corner, edgeU, edgeV } = e.aperture;
              if (
                Math.abs(dot(edgeU, normal)) > 1e-6 * length(edgeU) ||
                Math.abs(dot(edgeV, normal)) > 1e-6 * length(edgeV)
              )
                throw new RangeError(`${label} aperture must be perpendicular to the light direction`);
              return {
                corner: [...corner] as V3,
                u: [...edgeU] as V3,
                v: [...edgeV] as V3,
                normal,
                radiance: rgbOf(e),
                twoSided: false,
              };
            })()
          : null;
    if (!rect) throw new TypeError(`${label} emitter type must be 'point', 'directional' or 'area'`);
    const { corner, u, v, normal, twoSided } = rect,
      area = length(cross(u, v)),
      tangent = normalize(u),
      bitangent = cross(normal, tangent);
    if (!(area > 0)) throw new RangeError(`${label} emitter aperture must have area`);
    outside([corner, add(corner, u), add(add(corner, u), v), add(corner, v)], [normal], [u, v]);
    const beam = e.type === 'directional',
      along = scale(normal, -1);
    return {
      // A beam carries irradiance times area; a Lambertian face emits pi times radiance times area per side.
      power: scale(rect.radiance, area * (beam ? 1 : Math.PI * (twoSided ? 2 : 1))),
      emit: (a, b, random) => {
        const origin = add(add(corner, scale(u, a)), scale(v, b));
        if (beam) return [origin, [...along]];
        const s = random(),
          phi = 2 * Math.PI * random(),
          r = Math.sqrt(s),
          side = twoSided && random() < 0.5 ? -1 : 1;
        return [
          origin,
          normalize(
            add(
              add(scale(tangent, r * Math.cos(phi)), scale(bitangent, r * Math.sin(phi))),
              scale(normal, side * Math.sqrt(1 - s)),
            ),
          ),
        ];
      },
    };
  });
}

/** Van der Corput radical inverse in base 2, the second Hammersley coordinate. */
function radicalInverse(value: number) {
  let n = value >>> 0;
  n = ((n >>> 16) | (n << 16)) >>> 0;
  n = (((n & 0x55555555) << 1) | ((n & 0xaaaaaaaa) >>> 1)) >>> 0;
  n = (((n & 0x33333333) << 2) | ((n & 0xcccccccc) >>> 2)) >>> 0;
  n = (((n & 0x0f0f0f0f) << 4) | ((n & 0xf0f0f0f0) >>> 4)) >>> 0;
  n = (((n & 0x00ff00ff) << 8) | ((n & 0xff00ff00) >>> 8)) >>> 0;
  return n / 4294967296;
}

/** A unit direction cosine-weighted about the unit `normal`, from two uniform numbers (Malley's method). */
function cosineAbout(normal: V3, u1: number, u2: number): V3 {
  const t = normalize(Math.abs(normal[0]) < 0.9 ? cross(normal, [1, 0, 0]) : cross(normal, [0, 1, 0])),
    b = cross(normal, t),
    r = Math.sqrt(u1),
    phi = 2 * Math.PI * u2,
    z = Math.sqrt(Math.max(0, 1 - u1));
  return normalize(add(add(scale(t, r * Math.cos(phi)), scale(b, r * Math.sin(phi))), scale(normal, z)));
}

/**
 * Bakes caustics: photons from `emitters` refract and reflect through convex glass (Fresnel picks reflection or
 * transmission, total internal reflection, Beer absorption on each bent path, nested media use their neighbours'
 * IORs) and deposit their flux at the first diffuse front face they reach after touching glass. A volume's
 * `roughness` makes it rough glass (GGX visible normals with Smith masking); its `dispersion` (20 / Abbe number) gives
 * each photon a stratified wavelength from 380 to 780 nm, a Cauchy index there and the linear sRGB of that
 * wavelength, normalized per emitter so the packets add up to its power. With `bounces`, receivers reflect the
 * deposited light on, diffusely and weighted by their albedo.
 * The returned atlas holds physical irradiance (W per square world unit) in its lightmap, with photon noise and
 * texel-sized box filtering; `diagnostics` accounts for every watt. Inputs are copied before the first await.
 */
export async function bakeRefractedLightmap(
  quads: LightmapQuads,
  options: RefractedLightmapOptions,
): Promise<RefractedLightmap> {
  const { signal, onProgress } = options,
    includeDirect = !!options.includeDirect,
    photons = inRange(options.photons ?? 65536, 1, 1048576, `${label} photons`),
    maxEvents = inRange(options.maxEvents ?? 8, 1, 32, `${label} maxEvents`),
    bounces = inRange(options.bounces ?? 0, 0, 4, `${label} bounces`),
    { volumes, parents } = volumesOf(options.glassVolumes),
    sources = sourcesOf(options.emitters, volumes);
  if (photons < sources.length) throw new RangeError(`${label} needs at least one photon per emitter`);
  const positions = quads?.positions?.slice(),
    albedo = quads?.albedo?.slice(),
    spectral = volumes.some((v) => v.dispersive),
    atlas = await bake(quads, { ...options, onProgress: undefined }, ({ pixels }) => ({
      unlit: true,
      rays: photons * (maxEvents + 1) * (bounces + 1) * (volumes.length + 1),
      // Irradiance (Float64 RGB) and hit counts per atlas pixel.
      bytes: pixels * 28,
    })),
    count = positions.length / 12,
    emitted: V3 = [0, 0, 0],
    diagnostics: RefractedDiagnostics = {
      emitted,
      deposited: [0, 0, 0],
      escaped: [0, 0, 0],
      absorbed: [0, 0, 0],
      truncated: [0, 0, 0],
      unrefracted: [0, 0, 0],
      blocked: [0, 0, 0],
      masked: [0, 0, 0],
      reflected: [0, 0, 0],
      photons,
      rays: 0,
      reflections: 0,
      refractions: 0,
      totalInternalReflections: 0,
      bounced: 0,
    },
    put = (to: V3, power: V3) => {
      for (let c = 0; c < 3; c++) to[c] += power[c];
    },
    irradiance = new Float64Array(atlas.width * atlas.height * 3),
    hits = new Uint32Array(atlas.width * atlas.height),
    opaque = MeshBVH.build({ positions, indices: quadIndices(Array.from({ length: count }, (_, q) => q)) }),
    random = createRandom(options.seed ?? 0);
  for (const source of sources) put(emitted, source.power);
  let done = 0;
  onProgress?.(0, photons);
  await checkpoint(signal);
  for (let s = 0; s < sources.length; s++) {
    const n = Math.floor(photons / sources.length) + (s < photons % sources.length ? 1 : 0),
      packet = scale(sources[s].power, 1 / n),
      shift = random(),
      // Stratified wavelengths (a rotated golden-ratio sequence) and their RGB, normalized over this emitter's photons.
      tint = spectral ? random() : 0,
      wavelength = (i: number) => visible[0] + (visible[1] - visible[0]) * ((tint + i * 0.6180339887498949) % 1),
      sum: V3 = [0, 0, 0];
    if (spectral) {
      for (let i = 0; i < n; i++) put(sum, wavelengthRgb(wavelength(i)));
      if (sources[s].power.some((p, c) => p > 0 && !(sum[c] > 0)))
        throw new RangeError(`${label} dispersion needs more photons per emitter to cover the spectrum`);
    }
    for (let i = 0; i < n; i++) {
      // Hammersley strata over the source with a seeded jitter and rotation.
      let [origin, direction] = sources[s].emit((i + random()) / n, (radicalInverse(i) + shift) % 1, random),
        power = [...packet] as V3,
        inside = -1,
        lastVolume = -1,
        lastPlane = -1,
        events = 0,
        bounce = 0,
        // The quad a bounce left from, which a ray off its plane cannot meet first.
        skipQuad = -1;
      const nm = spectral ? wavelength(i) : 0;
      if (spectral) {
        const rgb = wavelengthRgb(nm);
        power = [0, 1, 2].map((c) => (sum[c] > 0 ? (sources[s].power[c] * rgb[c]) / sum[c] : 0)) as V3;
      }
      const iorOf = (v: number) => (v < 0 ? 1 : (volumes[v].dispersive?.(nm) ?? volumes[v].ior));
      while (true) {
        const receiver = opaque.raycastFirst(
          { origin, direction },
          skipQuad < 0 ? { side: 'double' } : { side: 'double', includeFace: (f) => f >> 1 !== skipQuad },
        );
        let distance = receiver?.distance ?? Infinity,
          volume = -1,
          plane = -1;
        diagnostics.rays++;
        // Only the current medium's exit and its children's entries can come next.
        for (let j = 0; j < volumes.length; j++) {
          if (j !== inside && parents[j] !== inside) continue;
          diagnostics.rays++;
          const hit = clip(volumes[j].planes, origin, direction, lastVolume === j ? lastPlane : -1),
            at = j === inside ? hit?.exit : hit?.enter,
            crossed = j === inside ? hit?.leaving : hit?.entry;
          if (hit && at! > 0 && at! < distance && crossed! >= 0) {
            distance = at!;
            volume = j;
            plane = crossed!;
          }
        }
        if (!Number.isFinite(distance)) {
          put(inside < 0 ? diagnostics.escaped : diagnostics.truncated, power);
          break;
        }
        if (inside >= 0) {
          for (let c = 0; c < 3; c++) {
            const left = power[c] * beer(volumes[inside], c, distance);
            diagnostics.absorbed[c] += power[c] - left;
            power[c] = left;
          }
          if (power.every((x) => x === 0)) break;
        }
        if (volume < 0 && receiver) {
          if (!receiver.frontFace) {
            put(diagnostics.blocked, power);
            break;
          }
          put(events ? diagnostics.deposited : diagnostics.unrefracted, power);
          if (!events && !includeDirect) break;
          const quad = receiver.faceIndex >> 1;
          // The hit's barycentrics give the chart position: the quad's triangles are (0, 1, 2) and (0, 2, 3).
          const chart = atlas.charts[receiver.faceIndex >> 1],
            [, b1, b2] = receiver.barycoord,
            second = receiver.faceIndex & 1,
            x = Math.min(chart.width - 1, Math.floor((second ? b1 : b1 + b2) * chart.width)),
            y = Math.min(chart.height - 1, Math.floor((second ? b1 + b2 : b2) * chart.height)),
            pixel = (chart.y + Math.max(0, y)) * atlas.width + chart.x + Math.max(0, x);
          for (let c = 0; c < 3; c++) irradiance[pixel * 3 + c] += power[c];
          hits[pixel]++;
          if (!events || bounce === bounces) break;
          // Diffuse bounce: the receiver sends albedo times the deposit on, cosine-weighted about its front.
          power = [0, 1, 2].map((c) => power[c] * (albedo ? albedo[quad * 4 + c] : 1)) as V3;
          if (power.every((x) => x === 0)) break;
          put(diagnostics.reflected, power);
          bounce++;
          diagnostics.bounced++;
          origin = [...receiver.point];
          direction = cosineAbout(receiver.faceNormal, random(), random());
          skipQuad = quad;
          lastVolume = lastPlane = -1;
          continue;
        }
        if (events === maxEvents) {
          put(diagnostics.truncated, power);
          break;
        }
        const entering = inside !== volume,
          from = iorOf(inside),
          outer = parents[volume],
          to = iorOf(entering ? volume : outer),
          // The macro normal on the photon's side; a rough boundary bends about a sampled microfacet normal instead.
          macro = scale(volumes[volume].planes[plane].normal, entering ? 1 : -1),
          alpha = volumes[volume].alpha,
          normal = alpha > 0 ? sampleVisibleNormal(scale(direction, -1), macro, alpha, random(), random()) : macro,
          cosine = Math.max(0, Math.min(1, -dot(direction, normal))),
          reflectance = fresnel(cosine, from, to);
        origin = add(origin, scale(direction, distance));
        lastVolume = volume;
        lastPlane = plane;
        skipQuad = -1;
        events++;
        const reflect = reflectance >= 1 || random() < reflectance;
        if (reflect) {
          direction = normalize(add(direction, scale(normal, 2 * cosine)));
          diagnostics.reflections++;
          if (reflectance >= 1) diagnostics.totalInternalReflections++;
        } else if (from !== to) {
          const ratio = from / to,
            ct = Math.sqrt(Math.max(0, 1 - ratio * ratio * (1 - cosine * cosine)));
          direction = normalize(add(scale(direction, ratio), scale(normal, ratio * cosine - ct)));
        }
        if (alpha > 0) {
          // Smith masking of the way out, against the macro surface on the side the photon leaves by.
          const out = dot(direction, macro) * (reflect ? 1 : -1),
            kept = smithG1(out, alpha);
          for (let c = 0; c < 3; c++) {
            diagnostics.masked[c] += power[c] * (1 - kept);
            power[c] *= kept;
          }
          if (!(kept > 0)) break;
        }
        if (!reflect) {
          inside = entering ? volume : outer;
          diagnostics.refractions++;
        }
      }
      if (!(++done & 255)) {
        onProgress?.(done, photons);
        await checkpoint(signal);
      }
    }
  }
  // Flux over the texel's world area is irradiance.
  let maximum = 1;
  atlas.charts.forEach((c, q) => {
    const o = q * 12,
      texelArea =
        length(
          cross(
            sub(positions.subarray(o + 3, o + 6), positions.subarray(o, o + 3)),
            sub(positions.subarray(o + 9, o + 12), positions.subarray(o, o + 3)),
          ),
        ) /
        (c.width * c.height);
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const pixel = (c.y + y) * atlas.width + c.x + x;
        for (let k = 0; k < 3; k++) {
          const value = (irradiance[pixel * 3 + k] /= texelArea);
          if (!Number.isFinite(value)) throw new RangeError(`${label} irradiance overflow; lower the light power`);
          maximum = Math.max(maximum, value);
        }
      }
  });
  for (const c of atlas.charts)
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const pixel = (c.y + y) * atlas.width + c.x + x;
        for (let k = 0; k < 3; k++)
          atlas.textures.lightmap[pixel * 4 + k] = Math.round((irradiance[pixel * 3 + k] / maximum) * 255);
      }
  fillGutters(atlas.textures.lightmap, 4, atlas.charts, atlas.width);
  fillGutters(irradiance, 3, atlas.charts, atlas.width);
  atlas.radiometry = 'physical';
  atlas.lightmapScale = maximum;
  if (done & 255) onProgress?.(done, photons);
  signal?.throwIfAborted();
  return { atlas, irradiance, hits, diagnostics };
}
