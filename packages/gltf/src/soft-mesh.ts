/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/gltf/soft-mesh: draws a soft body of @margoengine/physics/soft (cloth, a closed surface, a skinned solid) as a
// PBR mesh that follows its particles every frame, with normals and tangents recomputed and texture coordinates from the
// cloth's grid. One call: `drawSoftBody(engine, body, options)`. `SoftSurface` is the CPU half on its own, for an app that
// draws the vertices itself. It reads the body through its public API only, so physics is a type import here.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { GPUCloth } from '@margoengine/physics/gpu-cloth';
import type { SoftBody } from '@margoengine/physics/soft';
import { GLTFAsset, type GLTFDocument, type GLTFImage } from './asset.js';
import { PBRModel } from './model.js';

/** Floats of one packed PBR vertex: position + 1, normal + 0, tangent, uv0, uv1, colour. */
const STRIDE = 20;
let serial = 0;

/** A glTF 2.0 material (`materials[i]` of a glTF file). */
export type SoftMeshMaterial = NonNullable<GLTFDocument['materials']>[number];

/** Options for {@link SoftSurface}. */
export interface SoftSurfaceOptions {
  /**
   * Texture coordinates, two a particle (two a skin vertex for a skinned body, two a vertex of the source mesh for a body
   * made by `SoftBodyDesc.volume`). Default: a `volume` body's own (its mesh's `uvs` or `TEXCOORD_0`), the grid of a body built by
   * `cloth`, `clothAnisotropic` or `clothTube` (particle (i, j) at (i / (nu - 1), j / (nv - 1)), a tube's seam doubled so
   * u runs 0 to 1 around it), else the body's shape where the surface is made, laid flat on the plane of its two largest
   * extents and scaled to 0..1.
   */
  uvs?: ArrayLike<number>;
}

/**
 * The surface of a soft body as packed PBR vertices (`STRIDE` = 20 floats: position and 1, normal and 0, tangent with
 * its handedness, two UV sets, colour) and triangles. `update()` copies the particles (or the skin) and recomputes the
 * normals, each the area-weighted sum of its triangles' normals, and the tangents from the UVs (Lengyel 2001).
 */
export class SoftSurface {
  /** 20 floats a vertex, in the layout `PBRModel` draws. */
  readonly vertices: Float32Array;
  /** Three vertex indices a triangle, wound as the body's triangles are. */
  readonly indices: Uint32Array;
  /** Two floats a vertex. */
  readonly uvs: Float32Array;
  /** The particle each vertex copies (a tube's seam vertices copy the first ring); empty for a skinned body. */
  private readonly source: Uint32Array;
  /** Pairs of vertices that are one particle (a tube's first ring and its seam copy). */
  private readonly twins: Uint32Array;
  private readonly skinned: boolean;
  /** For a body made by `SoftBodyDesc.volume`, each particle's normal: the copies of a welded vertex share it. */
  private readonly particleNormals: Float32Array | null;
  private readonly scratch: Float32Array;
  private readonly normal: Float32Array;
  private readonly tangent: Float32Array;
  private readonly bitangent: Float32Array;

  constructor(
    readonly body: SoftBody,
    { uvs: given }: SoftSurfaceOptions = {},
  ) {
    if (!body.valid) throw new MargoError('state', 'Soft body was removed; draw a body that is still in its world.');
    this.skinned = body.meshIndices().length > 0;
    const triangles = this.skinned ? body.meshIndices() : body.triangles();
    if (triangles.length === 0)
      throw new TypeError(
        'This soft body has no triangles to draw (a rope or a bare particle set); draw a rope with @margoengine/lines, or build the body with cloth, trimesh, sphere or setSkin.',
      );
    // A body made by SoftBodyDesc.volume draws the mesh it came from: each vertex follows its welded particle, or on the
    // 'cells' tier rides in its cell as the skin; either way with the mesh's own texture coordinates.
    const welded = this.skinned ? null : body.sourceMesh,
      uvs = given ?? body.sourceMesh?.uvs ?? undefined,
      count = this.skinned ? body.meshVertices().length / 3 : welded ? welded.particles.length : body.numParticles(),
      grid = this.skinned || uvs || welded ? null : body.grid;
    let source: Uint32Array, indices: Uint32Array, flat: Float32Array;
    if (grid?.wrap) {
      // A tube: the seam column (i = nu) is a second copy of column 0, so u runs from 0 to 1 around without wrapping back.
      const { nu, nv } = grid;
      source = new Uint32Array((nu + 1) * nv);
      flat = new Float32Array(source.length * 2);
      for (let i = 0; i <= nu; i++)
        for (let j = 0; j < nv; j++) {
          source[i * nv + j] = (i % nu) * nv + j;
          flat[(i * nv + j) * 2] = i / nu;
          flat[(i * nv + j) * 2 + 1] = j / (nv - 1);
        }
      indices = new Uint32Array(triangles.length);
      // Each triangle that crosses the seam (a corner in column nu - 1 and one in column 0) takes the seam copy.
      for (let t = 0; t < triangles.length; t += 3) {
        const columns = [0, 1, 2].map((k) => Math.floor(triangles[t + k]! / nv)),
          crosses = columns.includes(nu - 1) && columns.includes(0);
        for (let k = 0; k < 3; k++)
          indices[t + k] = crosses && columns[k] === 0 ? nu * nv + (triangles[t + k]! % nv) : triangles[t + k]!;
      }
    } else {
      source = this.skinned
        ? new Uint32Array(0)
        : welded
          ? welded.particles.slice()
          : Uint32Array.from({ length: count }, (_, i) => i);
      indices = welded ? welded.indices.slice() : triangles;
      if (uvs) {
        if (uvs.length !== count * 2)
          throw new RangeError(`Soft surface uvs need two numbers a vertex: ${count * 2}, not ${uvs.length}.`);
        flat = Float32Array.from(uvs);
        if (!flat.every(Number.isFinite)) throw new RangeError('Soft surface uvs must be finite numbers.');
      } else if (grid) {
        flat = new Float32Array(count * 2);
        for (let i = 0; i < grid.nu; i++)
          for (let j = 0; j < grid.nv; j++) {
            flat[(i * grid.nv + j) * 2] = i / (grid.nu - 1);
            flat[(i * grid.nv + j) * 2 + 1] = j / (grid.nv - 1);
          }
      } else {
        const p = this.skinned ? body.meshVertices() : body.particlePositions();
        flat = planarUVs(
          welded ? Float32Array.from({ length: count * 3 }, (_, i) => p[source[(i / 3) | 0]! * 3 + (i % 3)]!) : p,
        );
      }
    }
    this.source = source;
    this.particleNormals = welded ? new Float32Array(body.numParticles() * 3) : null;
    const twins: number[] = [];
    if (grid?.wrap) for (let j = 0; j < grid.nv; j++) twins.push(j, grid.nu * grid.nv + j);
    this.twins = Uint32Array.from(twins);
    this.indices = indices;
    this.uvs = flat;
    const vertices = (this.vertices = new Float32Array((flat.length / 2) * STRIDE));
    for (let v = 0; v < flat.length / 2; v++) {
      const o = v * STRIDE;
      vertices[o + 3] = 1;
      vertices[o + 12] = vertices[o + 14] = flat[v * 2]!;
      vertices[o + 13] = vertices[o + 15] = flat[v * 2 + 1]!;
      vertices[o + 16] = vertices[o + 17] = vertices[o + 18] = vertices[o + 19] = 1;
    }
    this.scratch = new Float32Array((this.skinned ? count : body.numParticles()) * 3);
    this.normal = new Float32Array((flat.length / 2) * 3);
    this.tangent = new Float32Array(this.normal.length);
    this.bitangent = new Float32Array(this.normal.length);
    this.update();
  }

  /** The number of vertices (a tube has one more ring of them than of particles around). */
  get vertexCount(): number {
    return this.uvs.length / 2;
  }

  /** Copies the body's particles (or its skin) into the vertices and recomputes the normals and tangents. */
  update(): this {
    if (!this.body.valid)
      throw new MargoError('state', 'Soft body was removed; draw the bodies that replaced it with drawSoftBody.');
    const p = this.skinned ? this.body.meshVertices() : this.body.particlePositions(this.scratch),
      out = this.vertices,
      n = this.normal,
      t = this.tangent,
      b = this.bitangent,
      uv = this.uvs,
      index = this.indices,
      count = this.vertexCount;
    for (let v = 0; v < count; v++) {
      const s = (this.skinned ? v : this.source[v]!) * 3,
        o = v * STRIDE;
      out[o] = p[s]!;
      out[o + 1] = p[s + 1]!;
      out[o + 2] = p[s + 2]!;
    }
    n.fill(0);
    t.fill(0);
    b.fill(0);
    for (let k = 0; k < index.length; k += 3) {
      const i0 = index[k]!,
        i1 = index[k + 1]!,
        i2 = index[k + 2]!,
        a = i0 * STRIDE,
        e1x = out[i1 * STRIDE]! - out[a]!,
        e1y = out[i1 * STRIDE + 1]! - out[a + 1]!,
        e1z = out[i1 * STRIDE + 2]! - out[a + 2]!,
        e2x = out[i2 * STRIDE]! - out[a]!,
        e2y = out[i2 * STRIDE + 1]! - out[a + 1]!,
        e2z = out[i2 * STRIDE + 2]! - out[a + 2]!,
        // The cross product is twice the triangle's area along its normal, so the sum weights each face by its area.
        fx = e1y * e2z - e1z * e2y,
        fy = e1z * e2x - e1x * e2z,
        fz = e1x * e2y - e1y * e2x,
        du1 = uv[i1 * 2]! - uv[i0 * 2]!,
        dv1 = uv[i1 * 2 + 1]! - uv[i0 * 2 + 1]!,
        du2 = uv[i2 * 2]! - uv[i0 * 2]!,
        dv2 = uv[i2 * 2 + 1]! - uv[i0 * 2 + 1]!,
        det = du1 * dv2 - du2 * dv1,
        // The directions of increasing u and v on the triangle (Lengyel, "Computing Tangent Space Basis Vectors for an
        // Arbitrary Mesh", 2001); a triangle whose UVs span no area gives none.
        r = det === 0 ? 0 : 1 / det,
        tx = (e1x * dv2 - e2x * dv1) * r,
        ty = (e1y * dv2 - e2y * dv1) * r,
        tz = (e1z * dv2 - e2z * dv1) * r,
        bx = (e2x * du1 - e1x * du2) * r,
        by = (e2y * du1 - e1y * du2) * r,
        bz = (e2z * du1 - e1z * du2) * r;
      for (const i of [i0, i1, i2]) {
        n[i * 3] = n[i * 3]! + fx;
        n[i * 3 + 1] = n[i * 3 + 1]! + fy;
        n[i * 3 + 2] = n[i * 3 + 2]! + fz;
        t[i * 3] = t[i * 3]! + tx;
        t[i * 3 + 1] = t[i * 3 + 1]! + ty;
        t[i * 3 + 2] = t[i * 3 + 2]! + tz;
        b[i * 3] = b[i * 3]! + bx;
        b[i * 3 + 1] = b[i * 3 + 1]! + by;
        b[i * 3 + 2] = b[i * 3 + 2]! + bz;
      }
    }
    // A seam vertex and the particle's own vertex are one point of the surface: both take the sum of the two sides, so
    // the light does not break along the seam.
    for (let s = 0; s < this.twins.length; s += 2) {
      const a = this.twins[s]! * 3,
        c = this.twins[s + 1]! * 3;
      for (const sum of [n, t, b]) for (let k = 0; k < 3; k++) sum[a + k] = sum[c + k] = sum[a + k]! + sum[c + k]!;
    }
    // The copies of a welded vertex are one point of the surface, as the solver sees it: each takes the normal summed over
    // every triangle round its particle, so the light does not break along the source mesh's seams. Tangents stay each
    // vertex's own, as its texture coordinates are.
    const shared = this.particleNormals;
    if (shared) {
      shared.fill(0);
      for (let v = 0; v < count; v++)
        for (let k = 0; k < 3; k++) shared[this.source[v]! * 3 + k] = shared[this.source[v]! * 3 + k]! + n[v * 3 + k]!;
      for (let v = 0; v < count; v++) for (let k = 0; k < 3; k++) n[v * 3 + k] = shared[this.source[v]! * 3 + k]!;
    }
    for (let v = 0; v < count; v++) {
      const o = v * STRIDE;
      let nx = n[v * 3]!,
        ny = n[v * 3 + 1]!,
        nz = n[v * 3 + 2]!;
      const length = Math.hypot(nx, ny, nz);
      // A vertex in no triangle, or only in triangles squashed to a line, keeps the normal it had.
      if (length > 0) {
        nx /= length;
        ny /= length;
        nz /= length;
      } else {
        nx = out[o + 4]!;
        ny = out[o + 5]!;
        nz = out[o + 6]! || (nx === 0 && ny === 0 ? 1 : 0);
      }
      out[o + 4] = nx;
      out[o + 5] = ny;
      out[o + 6] = nz;
      // Gram-Schmidt: the tangent less its part along the normal; the handedness from the bitangent's side.
      let tx = t[v * 3]!,
        ty = t[v * 3 + 1]!,
        tz = t[v * 3 + 2]!;
      const along = tx * nx + ty * ny + tz * nz;
      tx -= nx * along;
      ty -= ny * along;
      tz -= nz * along;
      let tl = Math.hypot(tx, ty, tz);
      if (!(tl > 1e-12)) {
        // No usable UV gradient: any direction across the normal.
        [tx, ty, tz] = Math.abs(nx) < 0.9 ? [0, -nz, ny] : [nz, 0, -nx];
        tl = Math.hypot(tx, ty, tz);
      }
      out[o + 8] = tx / tl;
      out[o + 9] = ty / tl;
      out[o + 10] = tz / tl;
      const cx = ny * tz - nz * ty,
        cy = nz * tx - nx * tz,
        cz = nx * ty - ny * tx;
      out[o + 11] = cx * b[v * 3]! + cy * b[v * 3 + 1]! + cz * b[v * 3 + 2]! < 0 ? -1 : 1;
    }
    return this;
  }
}

/** Texture coordinates of points laid flat on the plane of their two largest extents, scaled to 0..1. */
function planarUVs(p: Float32Array): Float32Array {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, p[i]!);
    max[i % 3] = Math.max(max[i % 3]!, p[i]!);
  }
  const size = [0, 1, 2].map((a) => max[a]! - min[a]!),
    [ua, va] = [0, 1, 2].sort((a, b) => size[b]! - size[a]! || a - b),
    out = new Float32Array((p.length / 3) * 2);
  for (let v = 0; v < p.length / 3; v++) {
    out[v * 2] = size[ua!]! > 0 ? (p[v * 3 + ua!]! - min[ua!]!) / size[ua!]! : 0;
    out[v * 2 + 1] = size[va!]! > 0 ? (p[v * 3 + va!]! - min[va!]!) / size[va!]! : 0;
  }
  return out;
}

/** Options for {@link drawSoftBody}. */
export interface SoftBodyMeshOptions extends SoftSurfaceOptions {
  /**
   * The glTF material it is drawn with. Default `{doubleSided: true, pbrMetallicRoughness: {metallicFactor: 0,
   * roughnessFactor: 0.8}}`: a matte sheet seen from both sides. `doubleSided` stays true unless the material says false.
   * Its textures name `images` by index: texture `i` is image `i`.
   */
  material?: SoftMeshMaterial;
  /** The images its textures read (an `ImageBitmap`, or `{width, height, data}` RGBA8 pixels). Default none. */
  images?: readonly GLTFImage[];
}

/**
 * A soft body drawn as a PBR mesh: each frame, before the engine draws, the vertices follow the body (when it is awake)
 * and upload in place. Make it after the body's `Physics` is on the engine, so the frame's step runs first. A body that is
 * removed (or splits on a tear) stops it at its last pose: draw the pieces with `drawSoftBody` from `soft.onTear`.
 */
export class SoftBodyMesh implements EnginePlugin {
  readonly name = 'soft-mesh:' + serial++;
  /**
   * Copies the particles after physics has stepped them this frame (physics is a `late` plugin, KB-PHYS-FRAMEORDER1):
   * a late plugin added after the physics world runs after it, so the mesh drawn is the step just taken, not the one
   * before (KB-SOFTMESH-LAG1).
   */
  readonly late = true;
  /** The model it draws with: `model.setVisible`, picking and the PBR model API work on it. */
  readonly model: PBRModel;
  /** The CPU surface it uploads. */
  readonly surface: SoftSurface;
  private engine?: Engine;
  private disposed = false;
  /** The vertices the model holds, and the array the next frame writes. */
  private held: Float32Array;
  private spare: Float32Array;

  constructor(engine: EngineKernel, body: SoftBody, { material, images = [], ...options }: SoftBodyMeshOptions = {}) {
    this.surface = new SoftSurface(body, options);
    this.held = this.surface.vertices.slice();
    this.spare = this.surface.vertices.slice();
    this.model = sheetModel(engine, this.held, this.surface.indices, material, images);
    engine.use(this.model);
    try {
      engine.use(this);
    } catch (error) {
      this.model.dispose();
      throw error;
    }
  }
  setup(engine: Engine): void {
    this.engine = engine;
  }
  onPreUpdate(): void {
    const body = this.surface.body;
    if (this.disposed || !body.valid || body.sleeping) return;
    this.sync();
  }
  /** Moves the mesh to where the body is now, at once (the frame does this by itself). */
  sync(): this {
    if (this.disposed)
      throw new MargoError('disposed', 'SoftBodyMesh is disposed; draw the body again with drawSoftBody.');
    this.surface.update();
    // Two arrays taken in turn: the model gets a new array object each frame (which refreshes what it caches by identity,
    // the picking BVH among them) and nothing is allocated.
    const next = this.spare;
    next.set(this.surface.vertices);
    this.model.writeGeometry([{ vertices: next, indices: this.surface.indices }], {
      start: 0,
      count: this.surface.vertexCount,
    });
    this.spare = this.held;
    this.held = next;
    return this;
  }
  /** Removes the mesh from the engine and frees its buffers. The body is not touched. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.model.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Draws a soft body with one call: `const mesh = drawSoftBody(engine, cloth, {material})`. The mesh follows the body every
 * frame with recomputed normals and tangents and grid texture coordinates; `mesh.dispose()` (or `using`) removes it.
 */
export function drawSoftBody(engine: EngineKernel, body: SoftBody, options?: SoftBodyMeshOptions): SoftBodyMesh {
  return new SoftBodyMesh(engine, body, options);
}

/** Options for {@link drawGPUCloth}: the material and images, as {@link drawSoftBody} takes them. */
export type GPUClothMeshOptions = Pick<SoftBodyMeshOptions, 'material' | 'images'>;

/** The glTF document of a one-primitive mesh drawn with `material` (default a matte sheet seen from both sides). */
function sheetModel(
  engine: EngineKernel,
  vertices: Float32Array,
  indices: Uint32Array,
  material: SoftMeshMaterial | undefined,
  images: readonly GLTFImage[],
): PBRModel {
  const textures = images.map((_, source) => ({ source }));
  return new PBRModel(
    engine,
    new GLTFAsset(
      {
        asset: { version: '2.0' },
        materials: [
          { doubleSided: true, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.8 }, ...material },
        ],
        ...(textures.length ? { textures, images: images.map(() => ({})) } : {}),
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        nodes: [{ mesh: 0 }],
      },
      [],
    ),
    images,
    [[{ vertices, indices }]],
  );
}

/**
 * A `GPUCloth` of `@margoengine/physics/gpu-cloth` drawn as a PBR mesh. On WebGPU the model draws the vertex buffer the
 * cloth's compute writes (as a skin's output is drawn): no readback, no upload. On the WebGL2 compatibility layer the cloth
 * steps on the CPU and the mesh uploads its vertices when they change.
 */
export class GPUClothMesh implements EnginePlugin {
  readonly name = 'gpu-cloth-mesh:' + serial++;
  /** After the cloth (a late plugin), so a CPU step of this frame is the one uploaded. */
  readonly late = true;
  /** The model it draws with: `model.setVisible`, picking and the PBR model API work on it. */
  readonly model: PBRModel;
  private engine?: Engine;
  private disposed = false;
  private seen = -1;
  private held: Float32Array;
  private spare: Float32Array;

  constructor(
    engine: EngineKernel,
    readonly cloth: GPUCloth,
    { material, images = [] }: GPUClothMeshOptions = {},
  ) {
    if (!(cloth?.vertices instanceof Float32Array) || !(cloth.indices instanceof Uint32Array))
      throw new MargoError('unsupported', 'drawGPUCloth takes a GPUCloth of @margoengine/physics/gpu-cloth.');
    this.held = cloth.vertices.slice();
    this.spare = cloth.vertices.slice();
    this.model = sheetModel(engine, this.held, cloth.indices, material, images);
    engine.use(this.model);
    try {
      engine.use(this);
    } catch (error) {
      this.model.dispose();
      throw error;
    }
  }
  setup(engine: Engine): void {
    this.engine = engine;
  }
  onPreUpdate(): void {
    if (!this.disposed) this.sync();
  }
  /** Points the model at the cloth's GPU vertices, or uploads its CPU vertices when they changed (the frame does this). */
  sync(): this {
    if (this.disposed)
      throw new MargoError('disposed', 'GPUClothMesh is disposed; draw the cloth again with drawGPUCloth.');
    const buffer = this.cloth.vertexBuffer;
    if (buffer) {
      for (const p of this.model.primitives)
        if (p.deformed !== buffer) {
          p.deformed = buffer;
          p.deformedOffset = 0;
        }
      return this;
    }
    for (const p of this.model.primitives) p.deformed = undefined;
    if (this.cloth.revision === this.seen) return this;
    this.seen = this.cloth.revision;
    const next = this.spare;
    next.set(this.cloth.vertices);
    this.model.writeGeometry([{ vertices: next, indices: this.cloth.indices }], { start: 0, count: this.cloth.count });
    this.spare = this.held;
    this.held = next;
    return this;
  }
  /** Removes the mesh from the engine and frees its buffers. The cloth is not touched. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.model.primitives) p.deformed = undefined;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.model.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Draws a GPU cloth with one call: `const mesh = drawGPUCloth(engine, cloth, {material})`. Attach it after the cloth;
 * `mesh.dispose()` (or `using`) removes it.
 */
export function drawGPUCloth(engine: EngineKernel, cloth: GPUCloth, options?: GPUClothMeshOptions): GPUClothMesh {
  return new GPUClothMesh(engine, cloth, options);
}
