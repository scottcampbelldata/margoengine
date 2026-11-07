// FBX 7.4 writer, binary and ASCII. Written from the Blender Foundation's public description of the binary layout
// (node records, typed and deflated arrays) and the public ASCII structure; see docs/clean-room.md.
import { collect, polygons, textureFiles } from '@margoengine/exporters/collect';
import type {
  ExportNode,
  ExportScene,
  ExportSource,
  Geo,
  Mat,
  Node,
  SceneOptions,
  TextureData,
} from '@margoengine/exporters/collect';
import { inverse, multiply } from './math.js';

/** Options of {@link exportFBX}, on top of the options shared by every scene exporter. */
export interface FBXExportOptions extends SceneOptions {
  /** Write the ASCII form instead of binary. Default false. */
  ascii?: boolean;
  /** Put texture bytes inside the file. false names them by a relative path and returns them in `textures`. Default true. */
  embedTextures?: boolean;
  /** Stops the export with the signal's reason. */
  signal?: AbortSignal;
  /** Largest file to write, up to 4 GiB less one byte (the format's offsets are 32 bits). Default 1 GiB. */
  maxBytes?: number;
}
/** What {@link exportFBX} resolves to. */
export interface FBXExportResult {
  /** The file: FBX 7.4 binary, or UTF-8 text with `ascii: true`. */
  fbx: Uint8Array;
  /** With `embedTextures: false`, each texture's relative path and bytes; save them beside the FBX. Otherwise empty. */
  textures: Map<string, Uint8Array>;
}

type Whole = { int: number } | { flag: number };
type Numbers = Float64Array | Float32Array | Int32Array | BigInt64Array;
type Prop = string | number | bigint | Uint8Array | Numbers | Whole;
type Rec = [name: string, props: Prop[], children?: Rec[]];
type Part = { geometry: Geo; material?: Mat };
type Corner = [Geo, number];
interface Keys {
  times: number[];
  values: number[];
}

const VERSION = 7400,
  TICKS = 46186158000,
  CM = 100,
  LINEAR_KEY = 4,
  STEP_KEY = 2,
  AXES = ['d|X', 'd|Y', 'd|Z'],
  // Euler keys between two rotation keys may leave the arc by 1 - cos(angle / 2): about 1e-3 radians.
  ARC_TOLERANCE = 1.25e-7,
  MAX_SPLITS = 6,
  CUBIC_STEPS = 8,
  DEFAULT_MAX_BYTES = 1024 * 1024 * 1024,
  FORMAT_MAX_BYTES = 0xffffffff,
  // Arrays below this size stay raw: deflate would not pay for its own header.
  DEFLATE_FROM = 128;
const hex = (text: string) => Uint8Array.from(text.match(/../g)!, (pair) => parseInt(pair, 16));
// Constants of the binary form, as they stand in any file with this creation time, so output is reproducible.
const CREATION_TIME = '1970-01-01 10:00:00:000',
  FILE_ID = hex('28b32aebb624ccc2bfc8b02aa92bfcf1'),
  FOOTER_ID = hex('fabcab09d0c8d466b176fb831cf7267e'),
  FOOTER_END = hex('f85a8c6adef5d97eece90ce3758f290b');
const encoder = new TextEncoder();
const int = (value: number): Whole => ({ int: value }),
  flag = (value: number): Whole => ({ flag: value }),
  objectName = (name: string | undefined, kind: string) => `${(name ?? '').replace(/[\0-\x1f]/g, '_')}\0\x01${kind}`,
  P = (name: string, type: string, label: string, flags: string, ...values: Prop[]): Rec => [
    'P',
    [name, type, label, flags, ...values],
  ],
  uneven = (s: ArrayLike<number>) => Math.abs(s[0] - s[1]) > 1e-7 || Math.abs(s[1] - s[2]) > 1e-7,
  notExported = () =>
    new TypeError(
      'Skin joint or animation target is not an exported scene node; include every joint and target node in the exported scene',
    );

/** A column-major matrix in metres as the same matrix in centimetres: only its translation changes. */
function centimetres(matrix: ArrayLike<number>): Float64Array {
  const out = Float64Array.from(matrix);
  for (let k = 12; k < 15; k++) out[k] *= CM;
  return out;
}

/** Fixed-axis XYZ Euler degrees (FBX RotationOrder 0: R = Rz Ry Rx) of a unit quaternion, near `near` when given. */
function eulerOf(q: ArrayLike<number>, near?: ArrayLike<number>): number[] {
  // Float32 keys are not quite unit length, which turns into wrong signs near a pole unless scaled first.
  const length = Math.hypot(q[0], q[1], q[2], q[3]),
    x = q[0] / length,
    y = q[1] / length,
    z = q[2] / length,
    w = q[3] / length,
    r20 = 2 * (x * z - y * w),
    r21 = 2 * (y * z + x * w),
    r22 = 1 - 2 * (x * x + y * y),
    degrees = 180 / Math.PI;
  if (Math.hypot(r21, r22) < 1e-7) {
    // At a pole only x + z or x - z counts: keep z where it was so that the curve does not jump.
    const up = r20 < 0,
      keep = near?.[2] ?? 0,
      base = Math.atan2(-2 * (y * z - x * w), 1 - 2 * (x * x + z * z)) * degrees + (up ? keep : -keep);
    const pole = [base, up ? 90 : -90, keep];
    return near ? [base + 360 * Math.round((near[0] - base) / 360), pole[1], keep] : pole;
  }
  const a = [
    Math.atan2(r21, r22) * degrees,
    Math.atan2(-r20, Math.hypot(r21, r22)) * degrees,
    Math.atan2(2 * (x * y + z * w), 1 - 2 * (y * y + z * z)) * degrees,
  ];
  if (!near) return a;
  const closest = (angles: number[]) => angles.map((v, k) => v + 360 * Math.round((near[k] - v) / 360)),
    distance = (angles: number[]) => angles.reduce((sum, v, k) => sum + Math.abs(v - near[k]), 0),
    first = closest(a),
    // The same rotation by the other Euler solution, which is the nearer one past a pole.
    second = closest([a[0] + 180, 180 - a[1], a[2] + 180]);
  return distance(second) < distance(first) ? second : first;
}

function quaternionOf(e: ArrayLike<number>): number[] {
  const half = Math.PI / 360,
    cx = Math.cos(e[0] * half),
    sx = Math.sin(e[0] * half),
    cy = Math.cos(e[1] * half),
    sy = Math.sin(e[1] * half),
    cz = Math.cos(e[2] * half),
    sz = Math.sin(e[2] * half);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

function slerp(a: number[], b: number[], alpha: number): number[] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  dot = Math.min(1, Math.abs(dot));
  let x = 1 - alpha,
    y = alpha;
  if (dot < 0.9995) {
    const angle = Math.acos(dot),
      s = Math.sin(angle);
    x = Math.sin((1 - alpha) * angle) / s;
    y = Math.sin(alpha * angle) / s;
  }
  const out = a.map((v, k) => v * x + b[k] * y * sign),
    length = Math.hypot(out[0], out[1], out[2], out[3]);
  return out.map((v) => v / length);
}

/** A channel's keys as plain STEP or LINEAR data: a CUBICSPLINE is sampled, as FBX cubic tangents do not map onto glTF's. */
function channelKeys(
  channel: { path: string; interpolation?: string; times: ArrayLike<number>; values: ArrayLike<number> },
  width: number,
): Keys {
  const { times, values, path } = channel,
    count = times.length,
    cubic = channel.interpolation === 'CUBICSPLINE';
  if (!count || values.length !== count * width * (cubic ? 3 : 1))
    throw new RangeError(`Animation channel ${path} needs ${width * (cubic ? 3 : 1)} values per key`);
  for (let i = 0; i < count; i++)
    if (!Number.isFinite(times[i]) || times[i] < 0 || (i && times[i] <= times[i - 1]))
      throw new RangeError(
        'Animation key times must be finite, not negative and strictly increasing; sort or fix them',
      );
  if (!cubic) return { times: Array.from(times), values: Array.from(values) };
  const out: Keys = { times: [], values: [] },
    at = (key: number, part: number, k: number) => values[(key * 3 + part) * width + k];
  for (let key = 0; key < count - 1; key++) {
    const dt = times[key + 1] - times[key];
    for (let step = 0; step < CUBIC_STEPS; step++) {
      const s = step / CUBIC_STEPS,
        s2 = s * s,
        s3 = s2 * s,
        sample: number[] = [];
      out.times.push(times[key] + s * dt);
      for (let k = 0; k < width; k++)
        sample.push(
          (2 * s3 - 3 * s2 + 1) * at(key, 1, k) +
            (s3 - 2 * s2 + s) * dt * at(key, 2, k) +
            (-2 * s3 + 3 * s2) * at(key + 1, 1, k) +
            (s3 - s2) * dt * at(key + 1, 0, k),
        );
      if (path === 'rotation') {
        const length = Math.hypot(sample[0], sample[1], sample[2], sample[3]);
        for (let k = 0; k < 4; k++) sample[k] /= length;
      }
      out.values.push(...sample);
    }
  }
  out.times.push(times[count - 1]);
  for (let k = 0; k < width; k++) out.values.push(at(count - 1, 1, k));
  return out;
}

/** Euler keys whose straight lines stay on each quaternion arc: extra keys where Euler interpolation would leave it. */
function rotationKeys(keys: Keys, step: boolean): Keys {
  const quaternion = (key: number) => keys.values.slice(key * 4, key * 4 + 4),
    out: Keys = { times: [keys.times[0]], values: eulerOf(quaternion(0)) };
  const visit = (t0: number, q0: number[], e0: number[], t1: number, q1: number[], e1: number[], depth: number) => {
    const onArc = (alpha: number) => {
      const curve = quaternionOf(e0.map((v, k) => v + (e1[k] - v) * alpha)),
        arc = slerp(q0, q1, alpha);
      return (
        1 - Math.abs(curve[0] * arc[0] + curve[1] * arc[1] + curve[2] * arc[2] + curve[3] * arc[3]) <= ARC_TOLERANCE
      );
    };
    if (depth < MAX_SPLITS && !(onArc(0.25) && onArc(0.5) && onArc(0.75))) {
      const middle = (t0 + t1) / 2,
        q = slerp(q0, q1, 0.5),
        e = eulerOf(q, e0);
      visit(t0, q0, e0, middle, q, e, depth + 1);
      visit(middle, q, e, t1, q1, eulerOf(q1, e), depth + 1);
      return;
    }
    out.times.push(t1);
    out.values.push(...e1);
  };
  for (let key = 1; key < keys.times.length; key++) {
    const q1 = quaternion(key),
      e0 = out.values.slice(-3);
    if (step) {
      out.times.push(keys.times[key]);
      out.values.push(...eulerOf(q1, e0));
    } else visit(keys.times[key - 1], quaternion(key - 1), e0, keys.times[key], q1, eulerOf(q1, e0), 0);
  }
  return out;
}

/** Builds the record tree of a scene; arrays stay typed so each encoder picks its own form. */
function buildTree(source: ExportSource, options: FBXExportOptions, files: ReturnType<typeof textureFiles>): Rec[] {
  const signal = options.signal,
    embed = options.embedTextures ?? true,
    roots = collect(source, options),
    scene = Array.isArray((source as ExportScene).nodes) ? (source as ExportScene) : undefined,
    clips = scene?.animations ?? [],
    objects: Rec[] = [],
    connections: Rec[] = [],
    counts = new Map<string, number>(),
    models = new Map<ExportNode, bigint>(),
    joints = new Set<ExportNode>(),
    stretched = new Set<ExportNode>(),
    sharedGeometry = new Map<object, bigint>(),
    materials = new Map<Mat, bigint>(),
    textures = new Map<TextureData, bigint>(),
    morphChannels = new Map<ExportNode, bigint[]>(),
    meshes: [Node, bigint][] = [];
  let nextId = 1000n;
  const add = (type: string, name: string | undefined, kind: string, subtype: string, children: Rec[]): bigint => {
      const id = nextId++;
      objects.push([type, [id, objectName(name, kind), subtype], children]);
      counts.set(type, (counts.get(type) ?? 0) + 1);
      return id;
    },
    link = (child: bigint, parent: bigint) => connections.push(['C', ['OO', child, parent]]),
    linkProperty = (child: bigint, parent: bigint, property: string) =>
      connections.push(['C', ['OP', child, parent, property]]);

  const scan = (node: Node) => {
    node.skin?.joints.forEach((joint) => joints.add(joint));
    node.children.forEach(scan);
  };
  roots.forEach(scan);
  for (const clip of clips)
    for (const channel of clip.channels)
      if (channel.path === 'scale')
        for (let i = 0; i + 2 < channel.values.length; i += 3)
          if (uneven([channel.values[i], channel.values[i + 1], channel.values[i + 2]])) stretched.add(channel.node);

  const texture = (value: TextureData): bigint => {
    let id = textures.get(value);
    if (id !== undefined) return id;
    const file = files.name(value),
      label = value.name ?? file,
      video = add('Video', label, 'Video', 'Clip', [
        ['Type', ['Clip']],
        ['Filename', [file]],
        ['RelativeFilename', [file]],
        ...(embed ? ([['Content', [value.image]]] as Rec[]) : []),
      ]);
    id = add('Texture', label, 'Texture', '', [
      ['Type', ['TextureVideoClip']],
      ['Version', [int(202)]],
      ['TextureName', [objectName(label, 'Texture')]],
      ['Media', [objectName(label, 'Video')]],
      ['FileName', [file]],
      ['RelativeFilename', [file]],
    ]);
    link(video, id);
    textures.set(value, id);
    return id;
  };

  const material = (value: Mat): bigint => {
    let id = materials.get(value);
    if (id !== undefined) return id;
    const [r, g, b, alpha = 1] = value.color,
      metal = value.metalness,
      // Inverse of the importer's roughness mapping (Walter et al. 2007 sec. 5.2): n = 2 / roughness^4 - 2.
      exponent =
        value.shading === 'phong'
          ? value.shininess
          : value.shading === 'lambert'
            ? 0
            : 2 / Math.max(value.roughness ** 4, 1e-4) - 2,
      specular = [r, g, b].map((v) => 0.04 + (v - 0.04) * metal);
    id = add('Material', value.name, 'Material', '', [
      ['Version', [int(102)]],
      ['ShadingModel', ['phong']],
      ['MultiLayer', [int(0)]],
      [
        'Properties70',
        [],
        [
          P('DiffuseColor', 'Color', '', 'A', r, g, b),
          P('DiffuseFactor', 'Number', '', 'A', 1),
          P('EmissiveColor', 'Color', '', 'A', value.emissive[0], value.emissive[1], value.emissive[2]),
          P('EmissiveFactor', 'Number', '', 'A', value.emissiveStrength),
          P('TransparentColor', 'Color', '', 'A', 1, 1, 1),
          P('TransparencyFactor', 'Number', '', 'A', 1 - alpha),
          P('Opacity', 'Number', '', 'A', alpha),
          P('SpecularColor', 'Color', '', 'A', specular[0], specular[1], specular[2]),
          P('Shininess', 'Number', '', 'A', exponent),
          P('ShininessExponent', 'Number', '', 'A', exponent),
          P('ReflectionFactor', 'Number', '', 'A', metal),
        ],
      ],
    ]);
    for (const [slot, map] of [
      ['DiffuseColor', value.baseColorTexture],
      ['NormalMap', value.normalTexture],
      ['EmissiveColor', value.emissiveTexture],
    ] as const)
      if (map) linkProperty(texture(map), id, slot);
    materials.set(value, id);
    return id;
  };

  const skin = (node: Node, geometryId: bigint, firstCorner: Corner[]) => {
    const data = node.skin!,
      binds = data.inverseBindMatrices,
      label = node.name ?? 'a node';
    if (binds.length !== data.joints.length * 16)
      throw new RangeError(`Skin of ${label} needs one 16-value inverse bind matrix per joint`);
    const deformer = add('Deformer', data.name ?? node.name, 'Deformer', 'Skin', [
      ['Version', [int(101)]],
      ['Link_DeformAcuracy', [50]],
    ]);
    link(deformer, geometryId);
    const influences = data.joints.map(() => new Map<number, number>());
    firstCorner.forEach(([base, v], control) => {
      if (!base.joints || !base.weights)
        throw new TypeError(`Skinned ${label} has a primitive without joints and weights; add them or remove the skin`);
      for (let k = 0; k < 4; k++) {
        const weight = base.weights[v * 4 + k],
          joint = base.joints[v * 4 + k];
        if (!weight) continue;
        if (!influences[joint])
          throw new RangeError(`Skin of ${label} names joint ${joint}, past its joint list; fix the vertex joints`);
        influences[joint].set(control, (influences[joint].get(control) ?? 0) + weight);
      }
    });
    const bindSpace = centimetres(node.world);
    data.joints.forEach((joint, index) => {
      const id = models.get(joint);
      if (id === undefined) throw notExported();
      const bind = centimetres(Float64Array.from({ length: 16 }, (_, k) => binds[index * 16 + k])),
        cluster = add('Deformer', joint.name, 'SubDeformer', 'Cluster', [
          ['Version', [int(100)]],
          ['Indexes', [Int32Array.from(influences[index].keys())]],
          ['Weights', [Float64Array.from(influences[index].values())]],
          // Mesh into joint at bind, which is the inverse bind matrix; link x Transform gives the mesh's world.
          ['Transform', [bind]],
          ['TransformLink', [multiply(bindSpace, inverse(bind))]],
        ]);
      link(cluster, deformer);
      link(id, cluster);
    });
  };

  const morphs = (node: Node, geometryId: bigint, firstCorner: Corner[], count: number) => {
    const deformer = add('Deformer', node.name, 'Deformer', 'BlendShape', [['Version', [int(100)]]]),
      channels: bigint[] = [];
    link(deformer, geometryId);
    for (let target = 0; target < count; target++) {
      signal?.throwIfAborted();
      const indexes: number[] = [],
        offsets: number[] = [],
        normalOffsets: number[] = [];
      let name: string | undefined;
      firstCorner.forEach(([base, v], control) => {
        const morph = base.morphs?.[target];
        if (!morph) return;
        name ??= morph.name;
        const delta = [0, 1, 2].map((k) => morph.positions[v * 3 + k]),
          normal = [0, 1, 2].map((k) => morph.normals?.[v * 3 + k] ?? 0);
        if (!delta.some(Boolean) && !normal.some(Boolean)) return;
        indexes.push(control);
        offsets.push(delta[0] * CM, delta[1] * CM, delta[2] * CM);
        normalOffsets.push(...normal);
      });
      const label = name ?? `target_${target}`,
        percent = (node.morphWeights?.[target] ?? 0) * 100,
        shape = add('Geometry', label, 'Geometry', 'Shape', [
          ['Version', [int(100)]],
          ['Indexes', [Int32Array.from(indexes)]],
          ['Vertices', [Float64Array.from(offsets)]],
          ['Normals', [Float64Array.from(normalOffsets)]],
        ]),
        channel = add('Deformer', label, 'SubDeformer', 'BlendShapeChannel', [
          ['Version', [int(100)]],
          ['DeformPercent', [percent]],
          ['FullWeights', [new Float64Array(indexes.length).fill(100)]],
        ]);
      link(shape, channel);
      link(channel, deformer);
      channels.push(channel);
    }
    if (node.source) morphChannels.set(node.source, channels);
  };

  /** One FBX Geometry from a node's primitives. Control points weld equal positions; corners keep each vertex's data. */
  const geometry = (node: Node, parts: readonly Part[], slots: Map<Mat | undefined, number>, key: object): bigint => {
    const bases = new Map<Geo, number>();
    let vertexCount = 0;
    for (const { geometry: g } of parts) {
      const base = g.base ?? g;
      if (!bases.has(base)) {
        bases.set(base, vertexCount);
        vertexCount += base.count;
      }
    }
    const list = [...bases.keys()],
      morphCount = Math.max(0, ...list.map((g) => g.morphs?.length ?? 0)),
      shareable = !node.skin && !morphCount,
      known = shareable ? sharedGeometry.get(key) : undefined;
    if (known !== undefined) return known;
    const normals = new Float64Array(vertexCount * 3),
      uvs = list.some((g) => g.uvs) ? new Float64Array(vertexCount * 2) : undefined,
      uvs1 = list.some((g) => g.uvs1) ? new Float64Array(vertexCount * 2) : undefined,
      colors = list.some((g) => g.colors) ? new Float64Array(vertexCount * 4).fill(1) : undefined,
      controlOf = new Int32Array(vertexCount),
      firstCorner: Corner[] = [],
      welded = new Map<string, number>(),
      points: number[] = [];
    for (const [base, offset] of bases) {
      signal?.throwIfAborted();
      for (let v = 0; v < base.count; v++) {
        const at = offset + v,
          position = [base.positions[v * 3], base.positions[v * 3 + 1], base.positions[v * 3 + 2]],
          identity: number[] = [...position];
        for (let k = 0; k < 3; k++) normals[at * 3 + k] = base.normals[v * 3 + k];
        // FBX V runs up the image, glTF's down.
        if (uvs && base.uvs) uvs.set([base.uvs[v * 2], 1 - base.uvs[v * 2 + 1]], at * 2);
        if (uvs1 && base.uvs1) uvs1.set([base.uvs1[v * 2], 1 - base.uvs1[v * 2 + 1]], at * 2);
        if (colors && base.colors)
          for (let k = 0; k < base.colorSize; k++) colors[at * 4 + k] = base.colors[v * base.colorSize + k];
        if (base.joints && base.weights)
          for (let k = 0; k < 4; k++) identity.push(base.joints[v * 4 + k], base.weights[v * 4 + k]);
        for (const morph of base.morphs ?? [])
          for (let k = 0; k < 3; k++) identity.push(morph.positions[v * 3 + k], morph.normals?.[v * 3 + k] ?? 0);
        const weldKey = identity.join();
        let control = welded.get(weldKey);
        if (control === undefined) {
          control = firstCorner.length;
          welded.set(weldKey, control);
          firstCorner.push([base, v]);
          points.push(position[0] * CM, position[1] * CM, position[2] * CM);
        }
        controlOf[at] = control;
      }
    }
    const corners: number[] = [],
      polygonVertex: number[] = [],
      polygonMaterial: number[] = [];
    for (const part of parts) {
      const offset = bases.get(part.geometry.base ?? part.geometry)!,
        slot = slots.get(part.material)!;
      for (const face of polygons(part.geometry.faceSizes, part.geometry.indices)) {
        face.forEach((vertex, i) => {
          const at = vertex + offset;
          corners.push(at);
          polygonVertex.push(i === face.length - 1 ? -controlOf[at] - 1 : controlOf[at]);
        });
        polygonMaterial.push(slot);
      }
    }
    const cornerIndex = Int32Array.from(corners),
      element = (type: string, index: number, mapping: string, values: Rec[]): Rec => [
        type,
        [int(index)],
        [
          ['Version', [int(101)]],
          ['Name', [type === 'LayerElementUV' ? `UVSet${index}` : '']],
          ['MappingInformationType', [mapping]],
          ['ReferenceInformationType', ['IndexToDirect']],
          ...values,
        ],
      ],
      entry = (type: string, index = 0): Rec => [
        'LayerElement',
        [],
        [
          ['Type', [type]],
          ['TypedIndex', [int(index)]],
        ],
      ],
      perCorner = (type: string, values: string, indexes: string, data: Float64Array, index = 0) =>
        element(type, index, 'ByPolygonVertex', [
          [values, [data]],
          [indexes, [cornerIndex]],
        ]);
    const body: Rec[] = [
        ['GeometryVersion', [int(124)]],
        ['Vertices', [Float64Array.from(points)]],
        ['PolygonVertexIndex', [Int32Array.from(polygonVertex)]],
        perCorner('LayerElementNormal', 'Normals', 'NormalsIndex', normals),
      ],
      layer: Rec[] = [['Version', [int(100)]], entry('LayerElementNormal')];
    if (colors) {
      body.push(perCorner('LayerElementColor', 'Colors', 'ColorIndex', colors));
      layer.push(entry('LayerElementColor'));
    }
    if (uvs) {
      body.push(perCorner('LayerElementUV', 'UV', 'UVIndex', uvs));
      layer.push(entry('LayerElementUV'));
    }
    const single = slots.size < 2;
    body.push(
      element('LayerElementMaterial', 0, single ? 'AllSame' : 'ByPolygon', [
        ['Materials', [Int32Array.from(single ? [0] : polygonMaterial)]],
      ]),
    );
    layer.push(entry('LayerElementMaterial'));
    body.push(['Layer', [int(0)], layer]);
    if (uvs1)
      body.push(perCorner('LayerElementUV', 'UV', 'UVIndex', uvs1, 1), [
        'Layer',
        [int(1)],
        [['Version', [int(100)]], entry('LayerElementUV', 1)],
      ]);
    const id = add('Geometry', node.name, 'Geometry', 'Mesh', body);
    if (shareable) sharedGeometry.set(key, id);
    if (node.skin) skin(node, id, firstCorner);
    if (morphCount) morphs(node, id, firstCorner, morphCount);
    return id;
  };

  const visit = (node: Node, parentId: bigint, inheritParentScale: boolean) => {
    signal?.throwIfAborted();
    const joint = !!node.source && joints.has(node.source),
      drawn = !!node.geometry || !!node.primitives?.length,
      id = add('Model', node.name, 'Model', drawn ? 'Mesh' : joint ? 'LimbNode' : 'Null', [
        ['Version', [int(232)]],
        [
          'Properties70',
          [],
          [
            P('Lcl Translation', 'Lcl Translation', '', 'A', node.t[0] * CM, node.t[1] * CM, node.t[2] * CM),
            P('Lcl Rotation', 'Lcl Rotation', '', 'A', ...eulerOf(node.r)),
            P('Lcl Scaling', 'Lcl Scaling', '', 'A', node.s[0], node.s[1], node.s[2]),
            // The default keeps a parent's scale out of the child's rotation. Under an uneven parent scale, the
            // product parent x local that a scene means is mode 1: parent R S, then child r s.
            ...(inheritParentScale ? [P('InheritType', 'enum', '', '', int(1))] : []),
          ],
        ],
        ['Shading', [flag(1)]],
        ['Culling', ['CullingOff']],
      ]);
    link(id, parentId);
    if (node.source) models.set(node.source, id);
    if (drawn) meshes.push([node, id]);
    else
      link(
        add('NodeAttribute', node.name, 'NodeAttribute', joint ? 'LimbNode' : 'Null', [
          ['TypeFlags', [joint ? 'Skeleton' : 'Null']],
        ]),
        id,
      );
    const passOn = inheritParentScale || uneven(node.s) || (!!node.source && stretched.has(node.source));
    for (const child of node.children) visit(child, id, passOn);
  };
  for (const root of roots) visit(root, 0n, false);

  for (const [node, id] of meshes) {
    const parts: readonly Part[] = node.primitives ?? [{ geometry: node.geometry!, material: node.material }],
      slots = new Map<Mat | undefined, number>();
    for (const part of parts) if (!slots.has(part.material)) slots.set(part.material, slots.size);
    link(geometry(node, parts, slots, node.primitives ? (node.primitivesKey ?? node.primitives) : node.geometry!), id);
    for (const value of slots.keys())
      if (value) link(material(value), id);
      else if (slots.size > 1)
        throw new TypeError(`Primitives of ${node.name ?? 'a node'} mix materials with none; give each one a material`);
  }

  const takes: Rec[] = [['Current', ['']]];
  for (const clip of clips) {
    signal?.throwIfAborted();
    let end = 0;
    const layer = add('AnimationLayer', clip.name, 'AnimLayer', '', []),
      stackProperties: Rec[] = [],
      stack = add('AnimationStack', clip.name, 'AnimStack', '', [['Properties70', [], stackProperties]]);
    link(layer, stack);
    const curve = (times: readonly number[], values: Float32Array, step: boolean, parent: bigint, axis: string) =>
        linkProperty(
          add('AnimationCurve', '', 'AnimCurve', '', [
            ['Default', [values[0]]],
            ['KeyVer', [int(4008)]],
            ['KeyTime', [BigInt64Array.from(times, (t) => BigInt(Math.round(t * TICKS)))]],
            ['KeyValueFloat', [values]],
            ['KeyAttrFlags', [Int32Array.of(step ? STEP_KEY : LINEAR_KEY)]],
            ['KeyAttrDataFloat', [new Float32Array(4)]],
            ['KeyAttrRefCount', [Int32Array.of(times.length)]],
          ]),
          parent,
          axis,
        ),
      track = (name: string, axes: string[], first: number[]): bigint => {
        const id = add('AnimationCurveNode', name, 'AnimCurveNode', '', [
          ['Properties70', [], axes.map((axis, i) => P(axis, 'Number', '', 'A', first[i]))],
        ]);
        link(id, layer);
        return id;
      };
    for (const channel of clip.channels) {
      const target = models.get(channel.node);
      if (target === undefined) throw notExported();
      const step = channel.interpolation === 'STEP';
      if (channel.path === 'weights') {
        const list = morphChannels.get(channel.node);
        if (!list)
          throw new TypeError(
            `Weight channel on ${channel.node.name ?? 'a node'} has no morph targets; add targets or drop the channel`,
          );
        const keys = channelKeys(channel, list.length);
        end = Math.max(end, keys.times[keys.times.length - 1]);
        list.forEach((morph, index) => {
          const values = keys.times.map((_, i) => keys.values[i * list.length + index] * 100),
            curveNode = track('DeformPercent', ['d|DeformPercent'], [values[0]]);
          linkProperty(curveNode, morph, 'DeformPercent');
          curve(keys.times, Float32Array.from(values), step, curveNode, 'd|DeformPercent');
        });
        continue;
      }
      const rotation = channel.path === 'rotation',
        keys = channelKeys(channel, rotation ? 4 : 3),
        baked = rotation ? rotationKeys(keys, step) : keys,
        factor = channel.path === 'translation' ? CM : 1,
        count = baked.times.length,
        curveNode = track(
          rotation ? 'R' : factor === CM ? 'T' : 'S',
          AXES,
          baked.values.slice(0, 3).map((v) => v * factor),
        );
      end = Math.max(end, baked.times[count - 1]);
      linkProperty(curveNode, target, rotation ? 'Lcl Rotation' : factor === CM ? 'Lcl Translation' : 'Lcl Scaling');
      for (let axis = 0; axis < 3; axis++) {
        const values = new Float32Array(count);
        for (let i = 0; i < count; i++) values[i] = baked.values[i * 3 + axis] * factor;
        curve(baked.times, values, step, curveNode, AXES[axis]);
      }
    }
    const span = BigInt(Math.round(end * TICKS));
    stackProperties.push(P('LocalStop', 'KTime', 'Time', '', span), P('ReferenceStop', 'KTime', 'Time', '', span));
    takes.push([
      'Take',
      [clip.name ?? ''],
      [
        ['FileName', [`${clip.name ?? 'take'}.tak`]],
        ['LocalTime', [0n, span]],
        ['ReferenceTime', [0n, span]],
      ],
    ]);
  }

  const setting = (name: string, value: number): Rec => P(name, 'int', 'Integer', '', int(value));
  return [
    [
      'FBXHeaderExtension',
      [],
      [
        ['FBXHeaderVersion', [int(1003)]],
        ['FBXVersion', [int(VERSION)]],
        ['EncryptionType', [int(0)]],
        ['Creator', ['Margo Engine fbx']],
      ],
    ],
    ['FileId', [FILE_ID]],
    ['CreationTime', [CREATION_TIME]],
    ['Creator', ['Margo Engine fbx']],
    [
      'GlobalSettings',
      [],
      [
        ['Version', [int(1000)]],
        [
          'Properties70',
          [],
          [
            setting('UpAxis', 1),
            setting('UpAxisSign', 1),
            setting('FrontAxis', 2),
            setting('FrontAxisSign', 1),
            setting('CoordAxis', 0),
            setting('CoordAxisSign', 1),
            P('UnitScaleFactor', 'double', 'Number', '', 1),
            P('OriginalUnitScaleFactor', 'double', 'Number', '', 1),
            P('TimeMode', 'enum', '', '', int(6)),
            P('CustomFrameRate', 'double', 'Number', '', 30),
          ],
        ],
      ],
    ],
    [
      'Documents',
      [],
      [
        ['Count', [int(1)]],
        ['Document', [1n, 'Scene', 'Scene'], [['RootNode', [0n]]]],
      ],
    ],
    ['References', []],
    [
      'Definitions',
      [],
      [
        ['Version', [int(100)]],
        ['Count', [int(objects.length)]],
        ...[...counts].map(([type, count]): Rec => ['ObjectType', [type], [['Count', [int(count)]]]]),
      ],
    ],
    ['Objects', [], objects],
    ['Connections', [], connections],
    ['Takes', [], takes],
  ];
}

/** A growing little-endian byte buffer that refuses to pass the file limit. */
class Out {
  bytes = new Uint8Array(1 << 16);
  view = new DataView(this.bytes.buffer);
  length = 0;
  constructor(private readonly limit: number) {}
  reserve(extra: number): number {
    const at = this.length;
    this.length += extra;
    if (this.length > this.limit)
      throw new RangeError(`FBX export is over ${this.limit} bytes; raise maxBytes or split the scene`);
    if (this.length > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.length, Math.min(this.bytes.length * 2, this.limit)));
      grown.set(this.bytes.subarray(0, at));
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    return at;
  }
  put(bytes: Uint8Array): void {
    this.bytes.set(bytes, this.reserve(bytes.length));
  }
  u32(value: number): void {
    this.view.setUint32(this.reserve(4), value, true);
  }
  zeros(count: number): void {
    this.bytes.fill(0, this.reserve(count), this.length);
  }
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream as ReadableStream<Uint8Array<ArrayBuffer>>).arrayBuffer());
}

async function writeProperty(out: Out, value: Prop): Promise<void> {
  const code = (char: string) => {
    out.bytes[out.reserve(1)] = char.charCodeAt(0);
  };
  if (typeof value === 'string' || value instanceof Uint8Array) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    code(typeof value === 'string' ? 'S' : 'R');
    out.u32(bytes.length);
    out.put(bytes);
  } else if (typeof value === 'number') {
    code('D');
    out.view.setFloat64(out.reserve(8), value, true);
  } else if (typeof value === 'bigint') {
    code('L');
    out.view.setBigInt64(out.reserve(8), value, true);
  } else if ('int' in value) {
    code('I');
    out.view.setInt32(out.reserve(4), value.int, true);
  } else if ('flag' in value) {
    code('C');
    out.bytes[out.reserve(1)] = value.flag;
  } else {
    const raw = new Uint8Array(value.length * value.BYTES_PER_ELEMENT),
      view = new DataView(raw.buffer);
    for (let i = 0; i < value.length; i++)
      if (value instanceof BigInt64Array) view.setBigInt64(i * 8, value[i], true);
      else if (value instanceof Float64Array) view.setFloat64(i * 8, value[i], true);
      else if (value instanceof Float32Array) view.setFloat32(i * 4, value[i], true);
      else view.setInt32(i * 4, value[i], true);
    const packed = raw.length >= DEFLATE_FROM ? await deflate(raw) : raw;
    code(
      value instanceof BigInt64Array
        ? 'l'
        : value instanceof Float64Array
          ? 'd'
          : value instanceof Float32Array
            ? 'f'
            : 'i',
    );
    out.u32(value.length);
    out.u32(packed === raw ? 0 : 1);
    out.u32(packed.length);
    out.put(packed);
  }
}

async function writeRecord(out: Out, [name, props, children]: Rec, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const head = out.reserve(13),
    nameBytes = encoder.encode(name);
  out.put(nameBytes);
  const start = out.length;
  for (const prop of props) await writeProperty(out, prop);
  const propertyBytes = out.length - start;
  // A nested list ends in a zero record, and a record with neither properties nor children holds just that record.
  if (children?.length || !props.length) {
    for (const child of children ?? []) await writeRecord(out, child, signal);
    out.zeros(13);
  }
  out.view.setUint32(head, out.length, true);
  out.view.setUint32(head + 4, props.length, true);
  out.view.setUint32(head + 8, propertyBytes, true);
  out.bytes[head + 12] = nameBytes.length;
}

async function encodeBinary(tree: Rec[], limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const out = new Out(limit);
  out.put(encoder.encode('Kaydara FBX Binary  \0\x1a\0'));
  out.u32(VERSION);
  for (const record of tree) await writeRecord(out, record, signal);
  out.zeros(13);
  out.put(FOOTER_ID);
  out.zeros(4);
  // Zeros up to the next 16-byte boundary, a full 16 when the file already sits on one.
  out.zeros(16 - (out.length % 16));
  out.u32(VERSION);
  out.zeros(120);
  out.put(FOOTER_END);
  return out.bytes.slice(0, out.length);
}

function asciiValue(value: Prop): string {
  if (typeof value === 'string') {
    const [name, kind] = value.split('\0\x01');
    return `"${(kind === undefined ? value : `${kind}::${name}`).replace(/"/g, '&quot;')}"`;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) {
    let text = '';
    for (let i = 0; i < value.length; i += 0x8000) text += String.fromCharCode(...value.subarray(i, i + 0x8000));
    return `"${btoa(text)}"`;
  }
  if ('int' in value) return String(value.int);
  return (value as { flag: number }).flag ? 'T' : 'F';
}

function encodeAscii(records: Rec[], depth: number, lines: string[], signal?: AbortSignal): void {
  const pad = '\t'.repeat(depth);
  for (const [name, props, children] of records) {
    signal?.throwIfAborted();
    const first = props[0] as Numbers | undefined;
    if (first?.BYTES_PER_ELEMENT && !(first instanceof Uint8Array)) {
      lines.push(`${pad}${name}: *${first.length} {`, `${pad}\ta: ${first.join(',')}`, `${pad}}`);
      continue;
    }
    const head = `${pad}${name}: ${props.map(asciiValue).join(', ')}`;
    if (!children?.length && props.length) {
      lines.push(head);
      continue;
    }
    lines.push(`${head}${props.length ? ' ' : ''}{`);
    encodeAscii(children ?? [], depth + 1, lines, signal);
    lines.push(`${pad}}`);
  }
}

/**
 * Writes a scene as FBX 7.4, binary by default or ASCII with `ascii: true`: `GlobalSettings` in centimetres and Y up,
 * meshes (polygons, normals, up to two UV sets, vertex colours, materials per polygon), the node hierarchy, Phong
 * materials with PNG or JPEG textures, node and morph-weight clips, skins and blend shapes.
 *
 * @throws TypeError on a joint or animation target outside the scene; RangeError over `maxBytes` or on malformed keys.
 * Aborts with `options.signal`.
 */
export async function exportFBX(source: ExportSource, options: FBXExportOptions = {}): Promise<FBXExportResult> {
  const { ascii = false, embedTextures = true, signal, maxBytes = DEFAULT_MAX_BYTES } = options;
  signal?.throwIfAborted();
  if (typeof ascii !== 'boolean' || typeof embedTextures !== 'boolean')
    throw new TypeError('ascii and embedTextures must be boolean; pass true or false');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > FORMAT_MAX_BYTES)
    throw new RangeError(`maxBytes must be a whole number from 1 to ${FORMAT_MAX_BYTES}, the format's largest offset`);
  const files = textureFiles(''),
    tree = buildTree(source, options, files),
    textures = embedTextures ? new Map<string, Uint8Array>() : files.files;
  if (!ascii) return { fbx: await encodeBinary(tree, maxBytes, signal), textures };
  const lines = ['; FBX 7.4.0 project file'];
  // FileId pairs with the footer, which only the binary form has.
  encodeAscii(
    tree.filter(([name]) => name !== 'FileId'),
    0,
    lines,
    signal,
  );
  const fbx = encoder.encode(`${lines.join('\n')}\n`);
  if (fbx.length > maxBytes)
    throw new RangeError(`FBX export is over ${maxBytes} bytes; raise maxBytes or split the scene`);
  return { fbx, textures };
}
