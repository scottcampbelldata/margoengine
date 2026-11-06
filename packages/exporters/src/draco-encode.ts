// The encoder side of compressDraco, free of worker globals: one call per mesh, on a Draco module loaded by a worker's
// importScripts or by require in Node.

/** Draco's own attribute kinds, by the names its module exports. */
export type DracoKind = 'POSITION' | 'NORMAL' | 'COLOR' | 'TEX_COORD' | 'GENERIC';

/** One attribute of a {@link DracoJob}: packed values and how to quantize them. */
export interface DracoJobAttribute {
  /** The glTF semantic, which keys the result's ids. */
  semantic: string;
  kind: DracoKind;
  values: Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array | Float32Array;
  width: number;
  normalized: boolean;
  /** Quantization bits, 0 for none. Only float attributes are quantized. */
  bits: number;
  /** A grid shared with the mesh's other primitives: its origin and the edge of its cube. */
  grid?: { origin: number[]; range: number };
}

/** One triangle mesh to encode. */
export interface DracoJob {
  indices: Uint32Array;
  points: number;
  attributes: DracoJobAttribute[];
  encodeSpeed: number;
  decodeSpeed: number;
}

/** What {@link encodeDracoMesh} returns. */
export interface DracoEncoded {
  data: Uint8Array;
  /** Draco's unique attribute id for each semantic. */
  ids: Record<string, number>;
  /** Points and faces in the stream; merging equal vertices can leave fewer than went in. */
  points: number;
  faces: number;
}

type Handle = object;
type AddAttribute = (mesh: Handle, kind: number, count: number, width: number, values: ArrayBufferView) => number;

/** The part of the Draco Emscripten module this encoder calls. */
export interface DracoEncoderModule {
  Mesh: new () => Handle;
  MeshBuilder: new () => Handle & {
    AddFacesToMesh(mesh: Handle, faces: number, indices: Uint32Array): boolean;
    SetNormalizedFlagForAttribute(mesh: Handle, id: number, normalized: boolean): boolean;
    AddInt8Attribute: AddAttribute;
    AddUInt8Attribute: AddAttribute;
    AddInt16Attribute: AddAttribute;
    AddUInt16Attribute: AddAttribute;
    AddUInt32Attribute: AddAttribute;
    AddFloatAttribute: AddAttribute;
  };
  ExpertEncoder: new (
    mesh: Handle,
  ) => Handle & {
    SetAttributeQuantization(id: number, bits: number): void;
    SetAttributeExplicitQuantization(
      id: number,
      bits: number,
      width: number,
      origin: Float32Array,
      range: number,
    ): void;
    SetSpeedOptions(encode: number, decode: number): void;
    SetTrackEncodedProperties(track: boolean): void;
    EncodeToDracoBuffer(deduplicate: boolean, out: Handle): number;
    GetNumberOfEncodedPoints(): number;
    GetNumberOfEncodedFaces(): number;
  };
  DracoInt8Array: new () => Handle & { GetValue(index: number): number };
  destroy(handle: Handle): void;
  POSITION: number;
  NORMAL: number;
  COLOR: number;
  TEX_COORD: number;
  GENERIC: number;
}

const adder = (values: DracoJobAttribute['values']) =>
  values instanceof Float32Array
    ? 'AddFloatAttribute'
    : values instanceof Uint32Array
      ? 'AddUInt32Attribute'
      : values instanceof Uint16Array
        ? 'AddUInt16Attribute'
        : values instanceof Int16Array
          ? 'AddInt16Attribute'
          : values instanceof Uint8Array
            ? 'AddUInt8Attribute'
            : 'AddInt8Attribute';

/** Encodes one mesh. Every handle made here is released, also on a failure. */
export function encodeDracoMesh(draco: DracoEncoderModule, job: DracoJob): DracoEncoded {
  const mesh = new draco.Mesh(),
    builder = new draco.MeshBuilder();
  let encoder: InstanceType<DracoEncoderModule['ExpertEncoder']> | undefined,
    out: InstanceType<DracoEncoderModule['DracoInt8Array']> | undefined;
  try {
    builder.AddFacesToMesh(mesh, job.indices.length / 3, job.indices);
    const ids: Record<string, number> = {},
      added = job.attributes.map((attribute) => {
        const id = builder[adder(attribute.values)](
          mesh,
          draco[attribute.kind],
          job.points,
          attribute.width,
          attribute.values,
        );
        if (attribute.normalized) builder.SetNormalizedFlagForAttribute(mesh, id, true);
        ids[attribute.semantic] = id;
        return { ...attribute, id };
      });
    encoder = new draco.ExpertEncoder(mesh);
    for (const { id, bits, grid, width, values } of added) {
      if (!bits || !(values instanceof Float32Array)) continue;
      if (grid) encoder.SetAttributeExplicitQuantization(id, bits, width, new Float32Array(grid.origin), grid.range);
      else encoder.SetAttributeQuantization(id, bits);
    }
    encoder.SetSpeedOptions(job.encodeSpeed, job.decodeSpeed);
    encoder.SetTrackEncodedProperties(true);
    out = new draco.DracoInt8Array();
    const length = encoder.EncodeToDracoBuffer(true, out);
    if (!length) throw new RangeError('Draco could not encode a mesh; check that its triangles name valid vertices');
    const data = new Uint8Array(length);
    for (let i = 0; i < length; i++) data[i] = out.GetValue(i);
    return { data, ids, points: encoder.GetNumberOfEncodedPoints(), faces: encoder.GetNumberOfEncodedFaces() };
  } finally {
    if (out) draco.destroy(out);
    if (encoder) draco.destroy(encoder);
    draco.destroy(builder);
    draco.destroy(mesh);
  }
}
