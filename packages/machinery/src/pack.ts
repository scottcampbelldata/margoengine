import type { Batch, DrawOptions, Engine, Geometry, Mesh, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import { featureEdges } from './edges.js';

declare const GPUBufferUsage: { VERTEX: number; INDEX: number; UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Store inputs that place one entity relative to its parent: x, y, z, qx, qy, qz, qw, sx, sy, sz, parent. */
const lanes = 11;
/** A packed part: its index range in the pack and the transform inputs its root-space vertices were baked from. */
interface Part {
  mesh: Mesh;
  geometry: Geometry;
  batch: Batch;
  first: number;
  count: number;
  base: number;
  /** Entity ids from the part up to, not including, the pack root. */
  chain: number[];
  stamp: Float32Array;
  live: boolean;
}
/** Small static parts with equal material values under one root, baked into root space and drawn with the root's matrix. */
interface Pack {
  root: Mesh;
  /** The parts' material values (color, roughness, metalness, double-sided) when baked. */
  material: Float32Array;
  parts: Part[];
  live: number;
  vertex: GPUBuffer;
  index: GPUBuffer;
  instance: GPUBuffer;
  count: number;
  /** One instance per part: root matrix, material, part mesh id (core's 24-float instance layout). */
  instances: Float32Array;
  shadow: PackShadowPrimitive;
}
/** One pack as a `@margoengine/shadows` caster: root-space position + normal vertices drawn with `node`'s matrix. */
export interface PackShadowPrimitive {
  node: Mesh;
  vertex: GPUBuffer;
  index: GPUBuffer;
  count: number;
  stride: 24;
}

/**
 * Packs small static parts that share a material into root-space GPU buffers and draws each pack once inside every
 * core `context.draw` call (same pipeline and bindings), so section clips, caps, bloom and SSAO see packed triangles as
 * core triangles. Packed parts stay ordinary visible meshes; only their batches are claimed. A part leaves its pack for
 * good when it moves, hides, changes material or geometry, or another visible mesh starts sharing its geometry.
 */
export class PartPacks {
  readonly stats = { packs: 0, packed: 0 };
  shadowPrimitives: readonly PackShadowPrimitive[] = [];
  private engine?: Engine;
  private packs: Pack[] = [];
  private built = false;
  private frame?: GPUBuffer;
  private readonly frameData = new Float32Array(32);
  private readonly closed = new WeakMap<Geometry, boolean>();
  private readonly variants: [string, string, GPURenderPipeline][] = [];
  private readonly groups = new WeakMap<GPURenderPipeline, { bindings: GPUBindGroupEntry[]; group: GPUBindGroup }>();
  private readonly colors: GPURenderPassColorAttachment[] = [];
  private readonly depth: GPURenderPassDepthStencilAttachment = { view: undefined! };
  private readonly pass: GPURenderPassDescriptor = {
    colorAttachments: this.colors,
    depthStencilAttachment: this.depth,
  };
  private readonly inverse = new Float32Array(16);
  private readonly relative = new Float32Array(16);
  private readonly partInverse = new Float32Array(16);
  private readonly workspace = new Float64Array(52);

  constructor(
    private readonly partVertices: number,
    private readonly packVertices: number,
  ) {}
  setup(engine: Engine): void {
    this.engine = engine;
  }
  /** Rebuilds from the current meshes on the next frame. */
  refresh(): void {
    this.release();
  }
  /** One frame: build once, release changed parts, refresh instances and wrap `draw`. WebGPU only. */
  execute(c: Context, enabled: boolean): void {
    const engine = this.engine;
    if (!engine) return;
    if (!enabled) {
      if (this.built) this.release();
      return;
    }
    if (!this.built) this.build(engine, c);
    if (this.validate(engine) && !this.packs.length) return;
    const frame = (this.frame ??= c.device.createBuffer({
        size: 128,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })),
      data = this.frameData,
      lighting = engine.lighting;
    // The same frame values core writes into its own uniform at binding 0.
    data.set(c.camera.matrix);
    data.set(c.camera.position, 16);
    data.set(lighting.direction, 20);
    data.set(lighting.radiance, 24);
    data.fill(1, 28, 31);
    if (lighting.ambient) data.set(lighting.ambient, 28);
    c.device.queue.writeBuffer(frame, 0, data as Float32Array<ArrayBuffer>);
    for (const pack of this.packs) this.instances(c.device, pack);
    const inner = c.draw;
    c.draw = (options: DrawOptions = {}) => {
      inner(options);
      this.draw(c, options);
    };
  }
  /** Unclaims every packed batch and frees the pack buffers. The next enabled frame builds again. */
  release(): void {
    for (const pack of this.packs) this.drop(pack);
    this.packs = [];
    this.shadowPrimitives = [];
    this.built = false;
    this.stats.packs = this.stats.packed = 0;
    this.invalidateShadows();
  }
  dispose(): void {
    this.release();
    this.frame?.destroy();
    this.frame = undefined;
    this.variants.length = 0;
  }
  /** GPU resources belong to the lost device; the batches survive and are claimed again by the rebuild. */
  onDeviceRestored(): void {
    this.release();
    this.frame = undefined;
    this.variants.length = 0;
  }
  private build(engine: Engine, c: Context): void {
    this.built = true;
    const store = engine.store,
      users = new Map<Geometry, number>(),
      batches = new Map<Geometry, Batch>(),
      groups = new Map<Mesh, Map<string, Mesh[]>>();
    for (const batch of c.batches ?? []) batches.set(batch.geometry, batch);
    for (const mesh of engine.meshes.values())
      if (mesh.geometry) users.set(mesh.geometry, (users.get(mesh.geometry) ?? 0) + 1);
    for (const mesh of engine.meshes.values()) {
      const geometry = mesh.geometry;
      if (
        !geometry ||
        users.get(geometry) !== 1 ||
        geometry.vertices.length / 6 > this.partVertices ||
        !batches.has(geometry) ||
        store.constrained[mesh.id] ||
        store.parents[mesh.id] === -1
      )
        continue;
      let root = mesh.id,
        hidden = false;
      while (store.parents[root] !== -1) {
        hidden ||= !!store.hidden[root];
        root = store.parents[root];
      }
      if (hidden || !this.isClosed(geometry)) continue;
      const rootMesh = engine.meshes.get(root)!,
        byMaterial = groups.get(rootMesh) ?? new Map<string, Mesh[]>(),
        // Importers give each part its own material object; equal values share a pack.
        key = mesh.material.data.subarray(0, 7).join();
      groups.set(rootMesh, byMaterial);
      const list = byMaterial.get(key);
      if (list) list.push(mesh);
      else byMaterial.set(key, [mesh]);
    }
    for (const [root, byMaterial] of groups) {
      if (!invertMatrixStable(root.matrix, this.inverse, this.workspace)) continue;
      for (const meshes of byMaterial.values()) {
        let start = 0;
        while (start < meshes.length) {
          let end = start,
            vertices = 0;
          while (end < meshes.length && vertices + meshes[end].geometry!.vertices.length / 6 <= this.packVertices)
            vertices += meshes[end++].geometry!.vertices.length / 6;
          // Packing one part saves no draw.
          if (end - start > 1) this.bake(c.device, root, meshes.slice(start, end), batches);
          start = end;
        }
      }
    }
    this.shadowPrimitives = this.packs.map((pack) => pack.shadow);
    this.stats.packs = this.packs.length;
    this.stats.packed = this.packs.reduce((sum, pack) => sum + pack.live, 0);
    if (this.packs.length) this.invalidateShadows();
  }
  /** Same closed-solid test SectionPlanes caps by: open shells keep their own draw. */
  private isClosed(geometry: Geometry): boolean {
    let closed = this.closed.get(geometry);
    if (closed === undefined) this.closed.set(geometry, (closed = featureEdges(geometry, 180).length === 0));
    return closed;
  }
  private bake(device: GPUDevice, root: Mesh, meshes: Mesh[], batches: Map<Geometry, Batch>): void {
    const store = this.engine!.store,
      t = store.transforms,
      relative = this.relative,
      inverse = this.partInverse;
    let vertexCount = 0,
      indexCount = 0;
    for (const mesh of meshes) {
      vertexCount += mesh.geometry!.vertices.length / 6;
      indexCount += mesh.geometry!.indices.length;
    }
    const vertices = new Float32Array(vertexCount * 6),
      indices = new Uint32Array(indexCount),
      parts: Part[] = [];
    let base = 0,
      first = 0;
    for (const mesh of meshes) {
      const geometry = mesh.geometry!,
        source = geometry.vertices,
        index = geometry.indices;
      multiplyMatrices(this.inverse, mesh.matrix, relative);
      if (!invertMatrixStable(relative, inverse, this.workspace)) continue;
      const r = relative,
        mirror =
          r[0] * (r[5] * r[10] - r[6] * r[9]) -
            r[4] * (r[1] * r[10] - r[2] * r[9]) +
            r[8] * (r[1] * r[6] - r[2] * r[5]) <
          0;
      for (let v = 0; v < source.length; v += 6) {
        const x = source[v],
          y = source[v + 1],
          z = source[v + 2],
          nx = source[v + 3],
          ny = source[v + 4],
          nz = source[v + 5],
          o = base * 6 + v;
        vertices[o] = r[0] * x + r[4] * y + r[8] * z + r[12];
        vertices[o + 1] = r[1] * x + r[5] * y + r[9] * z + r[13];
        vertices[o + 2] = r[2] * x + r[6] * y + r[10] * z + r[14];
        // Inverse-transpose, as core's shader applies the root's cofactor matrix on top.
        vertices[o + 3] = inverse[0] * nx + inverse[1] * ny + inverse[2] * nz;
        vertices[o + 4] = inverse[4] * nx + inverse[5] * ny + inverse[6] * nz;
        vertices[o + 5] = inverse[8] * nx + inverse[9] * ny + inverse[10] * nz;
      }
      for (let k = 0; k < index.length; k += 3) {
        indices[first + k] = base + index[k];
        indices[first + k + 1] = base + index[mirror ? k + 2 : k + 1];
        indices[first + k + 2] = base + index[mirror ? k + 1 : k + 2];
      }
      const chain: number[] = [];
      for (let id = mesh.id; id !== root.id; id = store.parents[id]) chain.push(id);
      const stamp = new Float32Array(chain.length * lanes);
      chain.forEach((id, j) => {
        const o = j * lanes;
        stamp[o] = t.x[id];
        stamp[o + 1] = t.y[id];
        stamp[o + 2] = t.z[id];
        stamp[o + 3] = t.qx[id];
        stamp[o + 4] = t.qy[id];
        stamp[o + 5] = t.qz[id];
        stamp[o + 6] = t.qw[id];
        stamp[o + 7] = t.sx[id];
        stamp[o + 8] = t.sy[id];
        stamp[o + 9] = t.sz[id];
        stamp[o + 10] = store.parents[id];
      });
      parts.push({
        mesh,
        geometry,
        batch: batches.get(geometry)!,
        first,
        count: index.length,
        base,
        chain,
        stamp,
        live: true,
      });
      base += source.length / 6;
      first += index.length;
    }
    if (parts.length < 2) return;
    const limit = device.limits.maxBufferSize;
    if (vertices.byteLength > limit || indices.byteLength > limit || parts.length * 96 > limit) return;
    const upload = (data: Float32Array | Uint32Array, usage: number) => {
      const buffer = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
      return buffer;
    };
    const vertex = upload(vertices, GPUBufferUsage.VERTEX),
      index = upload(indices.subarray(0, first), GPUBufferUsage.INDEX),
      instances = new Float32Array(parts.length * 24),
      instance = device.createBuffer({
        size: instances.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    parts.forEach((part, k) => (instances[k * 24 + 23] = part.mesh.id));
    // NaN never compares equal, so the first frame uploads the matrix and material.
    instances[0] = NaN;
    for (const part of parts) part.batch.claimed = true;
    this.packs.push({
      root,
      material: meshes[0].material.data.slice(0, 7),
      parts,
      live: parts.length,
      vertex,
      index,
      instance,
      count: first,
      instances,
      shadow: { node: root, vertex, index, count: first, stride: 24 },
    });
  }
  /** Releases parts whose pose, visibility, material, geometry or sharing changed. Returns true when nothing changed. */
  private validate(engine: Engine): boolean {
    const store = engine.store,
      t = store.transforms;
    let unchanged = true;
    for (let i = this.packs.length - 1; i >= 0; i--) {
      const pack = this.packs[i];
      if (engine.meshes.get(pack.root.id) !== pack.root) {
        this.drop(pack);
        this.packs.splice(i, 1);
        unchanged = false;
        continue;
      }
      for (const part of pack.parts) {
        if (!part.live) continue;
        const mesh = part.mesh;
        let still =
          engine.meshes.get(mesh.id) === mesh &&
          mesh.geometry === part.geometry &&
          this.sameMaterial(mesh, pack.material) &&
          !store.constrained[mesh.id] &&
          part.batch.count <= 1;
        for (let j = 0; still && j < part.chain.length; j++) {
          const id = part.chain[j],
            s = part.stamp,
            o = j * lanes;
          still =
            !store.hidden[id] &&
            t.x[id] === s[o] &&
            t.y[id] === s[o + 1] &&
            t.z[id] === s[o + 2] &&
            t.qx[id] === s[o + 3] &&
            t.qy[id] === s[o + 4] &&
            t.qz[id] === s[o + 5] &&
            t.qw[id] === s[o + 6] &&
            t.sx[id] === s[o + 7] &&
            t.sy[id] === s[o + 8] &&
            t.sz[id] === s[o + 9] &&
            store.parents[id] === s[o + 10];
        }
        if (still) continue;
        unchanged = false;
        this.unpack(pack, part);
      }
      if (!pack.live) {
        this.drop(pack);
        this.packs.splice(i, 1);
      }
    }
    if (!unchanged) {
      this.shadowPrimitives = this.packs.map((pack) => pack.shadow);
      this.stats.packs = this.packs.length;
      this.stats.packed = this.packs.reduce((sum, pack) => sum + pack.live, 0);
      this.invalidateShadows();
    }
    return unchanged;
  }
  /** Hands one part back to core's draw and collapses its triangles in the pack. */
  private unpack(pack: Pack, part: Part): void {
    part.live = false;
    part.batch.claimed = false;
    pack.live--;
    if (pack.live)
      this.engine!.gpu?.queue.writeBuffer(
        pack.index,
        part.first * 4,
        new Uint32Array(part.count).fill(part.base) as Uint32Array<ArrayBuffer>,
      );
  }
  private drop(pack: Pack): void {
    for (const part of pack.parts) if (part.live) part.batch.claimed = false;
    pack.live = 0;
    pack.vertex.destroy();
    pack.index.destroy();
    pack.instance.destroy();
  }
  /** Uploads every part's instance again when the root matrix changed. */
  private instances(device: GPUDevice, pack: Pack): void {
    const data = pack.instances,
      matrix = pack.root.matrix;
    let same = true;
    for (let i = 0; same && i < 16; i++) same = data[i] === matrix[i];
    if (same) return;
    for (let k = 0; k < pack.parts.length; k++) {
      data.set(matrix, k * 24);
      data.set(pack.material, k * 24 + 16);
    }
    device.queue.writeBuffer(pack.instance, 0, data as Float32Array<ArrayBuffer>);
  }
  /** Draws every pack after core's draw of the same call, with that call's pipeline, bindings and targets. */
  private draw(c: Context, options: DrawOptions): void {
    const store = this.engine!.store;
    let any = false;
    for (const pack of this.packs) any ||= !this.hiddenRoot(store, pack.root.id);
    if (!any) return;
    const pipeline = options.pipeline ?? this.variant(c),
      group = this.group(c.device, pipeline, options.bindings ?? c.bindings),
      colors = this.colors,
      depth = this.depth,
      stencil = c.descriptor.depthStencil!.format.includes('stencil');
    colors.length = 0;
    colors.push({ view: c.color, loadOp: 'load', storeOp: 'store' });
    for (const extra of options.colorAttachments ?? [])
      colors.push({ view: extra.view, resolveTarget: extra.resolveTarget, loadOp: 'load', storeOp: extra.storeOp });
    depth.view = c.depth;
    depth.depthLoadOp = 'load';
    depth.depthStoreOp = 'store';
    depth.stencilLoadOp = stencil ? 'load' : undefined;
    depth.stencilStoreOp = stencil ? 'store' : undefined;
    const pass = c.encoder.beginRenderPass(this.pass);
    if (options.viewport) pass.setViewport(...options.viewport, 0, 1);
    if (options.scissor) pass.setScissorRect(...options.scissor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    for (const pack of this.packs) {
      if (this.hiddenRoot(store, pack.root.id)) continue;
      pass.setVertexBuffer(0, pack.vertex);
      pass.setVertexBuffer(1, pack.instance);
      pass.setIndexBuffer(pack.index, 'uint32');
      // An id-writing draw (selection's pick capture) needs each part's own instance id.
      if (options.partIds) {
        for (let k = 0; k < pack.parts.length; k++) {
          const part = pack.parts[k];
          if (part.live) pass.drawIndexed(part.count, 1, part.first, 0, k);
        }
      } else pass.drawIndexed(pack.count, 1, 0, 0, 0);
    }
    pass.end();
  }
  private sameMaterial(mesh: Mesh, values: Float32Array): boolean {
    const data = mesh.material.data;
    for (let i = 0; i < 7; i++) if (data[i] !== values[i]) return false;
    return true;
  }
  private hiddenRoot(store: Engine['store'], id: number): boolean {
    for (; id !== -1; id = store.parents[id]) if (store.hidden[id]) return true;
    return false;
  }
  /** Core's variant for the frame shader: same descriptor, shader and target format as its own draw. */
  private variant(c: Context): GPURenderPipeline {
    const key = c.descriptor.multisample?.count + c.format + c.descriptor.depthStencil?.format;
    for (const variant of this.variants) if (variant[0] === c.shader && variant[1] === key) return variant[2];
    const module = c.device.createShaderModule({ code: c.shader }),
      pipeline = c.device.createRenderPipeline({
        ...c.descriptor,
        vertex: { ...c.descriptor.vertex, module },
        fragment: { ...c.descriptor.fragment!, module, targets: [{ format: c.format }] },
      });
    if (this.variants.length >= 64) this.variants.shift();
    this.variants.push([c.shader, key, pipeline]);
    return pipeline;
  }
  private group(device: GPUDevice, pipeline: GPURenderPipeline, bindings: GPUBindGroupEntry[]): GPUBindGroup {
    let cached = this.groups.get(pipeline);
    if (
      !cached ||
      cached.bindings.length !== bindings.length ||
      bindings.some((entry, i) => {
        const previous = cached!.bindings[i],
          resource = entry.resource as GPUBufferBinding,
          old = previous.resource as GPUBufferBinding;
        return (
          entry.binding !== previous.binding ||
          (resource.buffer
            ? resource.buffer !== old.buffer || resource.offset !== old.offset || resource.size !== old.size
            : resource !== old)
        );
      })
    ) {
      cached = {
        bindings: bindings.map(({ binding, resource }) => ({
          binding,
          resource: (resource as GPUBufferBinding).buffer ? { ...resource } : resource,
        })),
        group: device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: this.frame! } }, ...bindings],
        }),
      };
      this.groups.set(pipeline, cached);
    }
    return cached.group;
  }
  private invalidateShadows(): void {
    (this.engine?.plugins.get('shadows') as { invalidate?: () => void } | undefined)?.invalidate?.();
  }
}
