// Named per-vertex attributes in node materials (the `attribute()` of node material systems): a mesh's
// `geometry.attributes`, interleaved into one storage buffer per mesh and read by vertex index in whichever pass draws
// it, so the packed 80-byte PBR vertex and every pipeline's vertex layout stay as they are. Programmable vertex pulling:
// D. Rákos, "Programmable Vertex Pulling", OpenGL Insights, CRC Press, 2012; `vertex_index`: W3C WGSL, built-in values.
import { MargoError } from '@margoengine/math/errors';
import type {
  GeometryRange,
  MaterialMeshData,
  MeshGeometry,
  VertexAttribute,
  VertexAttributeType,
} from '@margoengine/materials';
import { StorageBuffer } from './compute.js';
import { Node, type Host, type Program, type Resource } from './node.js';
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/,
  type = /^(?:([fiu])32|vec([234])([fiu]))$/;
const components = (t: string): number => +(type.exec(t)![2] ?? 1);
const scalar = (t: string): 'f' | 'i' | 'u' => (type.exec(t)![1] ?? type.exec(t)![3]) as 'f';
/** The smallest and largest value a component of an integer attribute holds. */
const limits = { i: [-2147483648, 2147483647], u: [0, 4294967295] } as const;

/** @internal The attributes one program reads, in first-read order: its one storage binding. */
export class AttributeReads implements Resource {
  readonly prefix = 'ndat';
  readonly bindings = 1;
  private readonly list: { name: string; type: VertexAttributeType; offset: number }[] = [];
  /** Words a vertex takes: one per component of every attribute read. */
  private stride = 0;
  /** The word offset of `name` in a vertex, adding it on first read. */
  add(name: string, t: VertexAttributeType): void {
    const found = this.list.find((a) => a.name === name);
    if (found) {
      if (found.type !== t)
        throw new TypeError(`attribute('${name}') is read as ${found.type} and as ${t}; read it with one type`);
      return;
    }
    this.list.push({ name, type: t, offset: this.stride });
    this.stride += components(t);
  }
  declare(name: string, group: number, binding: number): string {
    return (
      `@group(${group}) @binding(${binding}) var<storage, read> ${name}:array<u32>;\n` +
      `const ${name}Stride:u32=${this.stride}u;\n` +
      this.list.map((a) => `const ${name}_${a.name}:u32=${a.offset}u;`).join('\n')
    );
  }
  entries(_device: GPUDevice, host: Host): GPUBindingResource[] {
    const data = host.meshData;
    if (!(data instanceof AttributeData) || data.reads !== this)
      throw new MargoError(
        'state',
        "A material that reads attribute() draws a mesh's own geometry; use it on a mesh from createMesh or createInstancedMesh",
      );
    return [{ buffer: data.words.buffer(_device) }];
  }
  /** The data of one mesh: `geometry`'s attributes, checked and interleaved. */
  read(geometry: MeshGeometry): MaterialMeshData {
    const data = new AttributeData(this);
    data.prepare(geometry)();
    return data;
  }
  /** Vertices `from` to `from + count` of `geometry` as this program's interleaved words; throws when they do not fit. */
  pack(geometry: MeshGeometry, from: number, count: number): Uint32Array {
    const total = geometry.positions.length / 3,
      words = new Uint32Array(count * this.stride),
      views = { f: new Float32Array(words.buffer), i: new Int32Array(words.buffer), u: words };
    for (const { name, type: t, offset } of this.list) {
      // A bare array (the loaders' extra per-vertex scalars, `attributes: {intensity: Float32Array}`) is one f32 a vertex.
      const raw = geometry.attributes?.[name],
        given = (raw && !('type' in raw) ? { data: raw, type: 'f32' } : raw) as VertexAttribute | undefined,
        size = components(t),
        kind = scalar(t);
      if (!given)
        throw new TypeError(
          `Mesh geometry has no attribute '${name}', which its material reads; add attributes: {${name}: {data, type: '${t}'}}`,
        );
      if (given.type !== t)
        throw new TypeError(
          `Mesh geometry attribute '${name}' is ${given.type}, and its material reads it as ${t}; use it as ${t}`,
        );
      if (given.data?.length !== total * size)
        throw new RangeError(
          `Mesh geometry attribute '${name}' needs ${total * size} values (${total} vertices of ${t}), not ${given.data?.length}`,
        );
      const view = views[kind];
      for (let v = 0; v < count; v++)
        for (let k = 0; k < size; k++) {
          const value = given.data[(from + v) * size + k]!;
          if (
            kind === 'f'
              ? !Number.isFinite(value)
              : !Number.isInteger(value) || value < limits[kind][0] || value > limits[kind][1]
          )
            throw new RangeError(
              `Mesh geometry attribute '${name}' holds ${value}; give ${kind === 'f' ? 'finite numbers' : `whole numbers that fit ${kind}32`}`,
            );
          view[v * this.stride + offset + k] = value;
        }
    }
    return words;
  }
  /** The words one vertex takes. */
  get words(): number {
    return this.stride;
  }
}

/** One mesh's attribute buffer. */
class AttributeData implements MaterialMeshData {
  words!: StorageBuffer<'u32'>;
  constructor(readonly reads: AttributeReads) {}
  prepare(geometry: MeshGeometry, range?: GeometryRange): () => void {
    const start = range?.start ?? 0,
      count = range?.count ?? geometry.positions.length / 3,
      chunk = this.reads.pack(geometry, start, count);
    return () => {
      if (!range && this.words?.data.length !== chunk.length) {
        this.words?.dispose();
        this.words = new StorageBuffer(chunk, 'u32');
        return;
      }
      const stride = this.reads.words;
      this.words.data.set(chunk, start * stride);
      this.words.update(range && { start: start * stride, count: count * stride });
    };
  }
  dispose(): void {
    this.words.dispose();
  }
}

/**
 * A per-vertex value of the mesh being drawn, by name: `createMesh(engine, {positions, normals, attributes: {heat:
 * {data, type: 'f32'}}}, new NodeMaterial({colorNode: mix(vec3(0, 0, 1), vec3(1, 0, 0), attribute('heat', 'f32'))}))`.
 * In `positionNode` and `normalNode`'s vertex work it reads the vertex; in the other slots it is interpolated across the
 * triangle (integer types take the first vertex's value). Every pass that draws the material reads it, shadows included,
 * and `mesh.setGeometry` updates it. NodeMaterial nodes only.
 */
export function attribute<T extends VertexAttributeType>(name: string, as: T): Node<T> {
  if (typeof name !== 'string' || !identifier.test(name))
    throw new TypeError(`attribute() needs a name of letters, digits and underscores, not '${name}'`);
  if (!type.test(as))
    throw new TypeError(
      `attribute('${name}') type '${as}' is not one to four of f32, i32 or u32; pass 'f32' to 'vec4u'`,
    );
  return new Node(as, `at:${name}:${as}`, [], (b, n) => {
    if (b.stage.kind === 'fragment') return b.stage.varying!(b, n);
    if (b.stage.kind !== 'vertex')
      throw new TypeError('attribute() reads a mesh vertex; use it in the nodes of a NodeMaterial');
    const program: Program = b.program,
      reads = (program.attributes ??= new AttributeReads()) as AttributeReads;
    reads.add(name, as);
    const buffer = b.resource(reads),
      first = `${b.builtin('vertexIndex')}*${buffer}Stride+${buffer}_${name}`,
      word = (k: number) => {
        const read = `${buffer}[${first}${k ? `+${k}u` : ''}]`;
        return scalar(as) === 'u' ? read : `bitcast<${scalar(as)}32>(${read})`;
      },
      size = components(as);
    return size === 1 ? word(0) : `${as}(${Array.from({ length: size }, (_, k) => word(k)).join(',')})`;
  });
}
