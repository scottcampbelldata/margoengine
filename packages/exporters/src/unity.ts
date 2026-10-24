// Unity import bundle: the unchanged GLB and its atlas PNG plus a profile sidecar for the separately installed
// support package (glTFast import, colliders, clips). Native Unity/glTFast owns interpretation; the caller's encoded
// geometry, skin, clips and PNG are never rewritten.
import { ACCESSOR_WIDTHS } from './container.js';
import { splitGLB } from './glb.js';
import {
  type BundleEntry,
  type FileDigest,
  type Json,
  accessorReader,
  bundleFolder,
  byName,
  digests,
  encodeJSON,
  index,
  isObject,
  nodeParents,
  object,
  records,
  sha256,
  unsupportedFor,
  utf8,
  validateEmbeddedImportData,
} from './import-data.js';
import { UNITY_SUPPORT_PAYLOADS } from './unity-support.generated.js';

export type { BundleEntry, FileDigest } from './import-data.js';

/** Options for {@link createUnityImportBundle}. */
export interface UnityImportOptions {
  /** Project-relative folder under `Assets/`, such as `'Assets/Margo/Ranger'`. Copy it without renaming. */
  folder: string;
  /**
   * Generate a collider for every `-col`, `-colonly`, `-convcol` and `-convcolonly` mesh node; a helper that cannot
   * be generated exactly rejects the bundle. Default true.
   */
  colliders?: boolean;
}

/** The support package an asset bundle needs: its id, version and the SHA-256 of its `support-manifest.json`. */
export interface UnityImportSupport {
  package: 'com.margo.mesh';
  version: '0.3.0';
  manifestSHA256: string;
}

/** How the support package imports one mesh node. Indices refer to the unchanged source GLB. */
export interface UnityImportNode {
  nodeIndex: number;
  /** The node's `extras.id`. */
  id: string;
  meshIndex: number;
  name: string;
  /** False when the node or an ancestor has `KHR_node_visibility` `visible: false`. */
  sourceVisible: boolean;
  /** `sourceVisible`, and false for collider-only (`-colonly`, `-convcolonly`) nodes. */
  rendererVisible: boolean;
  /** From the name suffix: `-convcol*` is convex, `-col*` concave. */
  collider: 'none' | 'convex' | 'concave';
}

/** The `margo-profile.json` sidecar the support package reads; its import is ready only when every hash matches. */
export interface UnityImportProfile {
  schema: 1;
  profile: 'margo-unity-exact-v1';
  support: UnityImportSupport;
  source: {
    glb: 'model.glb';
    glbSHA256: string;
    png: 'atlas.png';
    pngSHA256: string;
    textureIndex: 0;
    width: number;
    height: number;
  };
  sampler: {
    magFilter: 9728;
    minFilter: 9728;
    wrapS: 33071;
    wrapT: 33071;
    dataColorSpace: 'srgb';
    mipmaps: false;
    anisotropy: 0;
  };
  /** {@link UnityImportOptions.colliders}. */
  generateColliders: boolean;
  nodes: UnityImportNode[];
  clips: { animationIndex: number; name: string; fps: number; loop: boolean }[];
}

/** The `margo-manifest.json` of an asset bundle; it does not list itself. */
export interface UnityImportManifest {
  schema: 1;
  profile: 'margo-unity-exact-v1';
  /** The bundle folder ({@link UnityImportOptions.folder}). */
  resourceDirectory: string;
  support: UnityImportSupport;
  files: FileDigest[];
}

/** The `support-manifest.json` of the support package; paths are package-relative and it does not list itself. */
export interface UnitySupportManifest {
  schema: 1;
  profile: 'margo-unity-exact-v1';
  package: 'com.margo.mesh';
  version: '0.3.0';
  requires: { unity: '6000.6.7f1'; gltfast: '6.20.0' };
  files: { path: string; bytes: number; sha256: string }[];
}

/** Result of {@link createUnityImportBundle}: asset files only, sorted by name; the support package is separate. */
export interface UnityImportBundle {
  /** `model.glb`, `atlas.png`, `margo-profile.json`, `README.txt` and `margo-manifest.json` under the folder. */
  entries: BundleEntry[];
  manifest: UnityImportManifest;
}

/** Result of {@link createUnityImportSupportPackage}: the `Packages/com.margo.mesh` files and a README, by name. */
export interface UnityImportSupportBundle {
  entries: BundleEntry[];
  manifest: UnitySupportManifest;
}

const UNITY = 'Unity',
  unsupported = unsupportedFor(UNITY),
  PROFILE = 'margo-unity-exact-v1',
  PACKAGE = 'com.margo.mesh',
  VERSION = '0.3.0',
  SUPPORT_ROOT = `Packages/${PACKAGE}`,
  // Source-validity envelope for four encoded Float32 components, never a native
  // fidelity tolerance. Delivery does not normalize or rewrite weights/quaternions.
  F32_UNIT_ROUNDOFF = 4 * 2 ** -24;

const folderName = (value: unknown) =>
  bundleFolder(value, UNITY, 'Assets/Margo/Ranger', 'Assets', 'editor|resources|plugins|streamingassets|cvs|');

function pngSize(data: Uint8Array): { width: number; height: number } {
  if (data.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => data[i] === v))
    throw new TypeError('Unity atlas must be an embedded PNG; export it through encodePNG or paletteTexture');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (
    view.getUint32(8) !== 13 ||
    view.getUint32(12) !== 0x49484452 ||
    data[24] !== 8 ||
    data[25] !== 6 ||
    data[26] !== 0 ||
    data[27] !== 0 ||
    data[28] !== 0
  )
    unsupported('needs the ordinary noninterlaced RGBA8 PNG profile; keep other image formats in general GLB');
  const width = view.getUint32(16),
    height = view.getUint32(20),
    powerOfTwo = (n: number) => n > 0 && n <= 16384 && (n & (n - 1)) === 0;
  if (!powerOfTwo(width) || !powerOfTwo(height))
    unsupported(
      'needs a power-of-two atlas up to 16384 per axis without resizing; retain larger source atlases in general GLB',
    );
  return { width, height };
}

const supportReadme =
  'Margo Unity exact import support 0.3.0\n\nInstall this immutable Packages/com.margo.mesh folder once into a Unity 6000.6.7f1 project with official glTFast 6.20.0 already installed. Do not replace a different existing package without reviewing that separate upgrade. Manual extraction can overwrite destination files; this archive is not a preflight installer. Asset exports are separate asset-only archives.\n\nVersion 0.3.0 uses owner schema 2. Prior 0.2.0/schema 1 targets require a fresh target folder; this package does not migrate, delete or adopt their generated resources. Version 0.3.0 processes only exact margo-profile.json sidecars. It does not auto-generate companions for every Margo GLB. Missing or mismatched support/profile/source readiness is not an accepted import. Preserve the fixed folder and inspect the owned report before using the generated prefab. Generic/Humanoid/cross-rig or other runtime profiles require their own native acceptance.\n';

/** Fresh support payload bytes, sorted by package-relative path. */
const supportPayload = () =>
  UNITY_SUPPORT_PAYLOADS.map((file) => ({ name: file.name, data: utf8.encode(file.text) })).sort(byName);

// The payload is constant, so its digests and manifest are computed once per module; a failure is not cached.
let supportDigest: Promise<{ manifest: UnitySupportManifest; json: Uint8Array; sha256: string }> | undefined;
function supportIdentity() {
  if (supportDigest) return supportDigest;
  supportDigest = (async () => {
    const files = (await digests(supportPayload(), UNITY)).map(({ name: path, ...digest }) => ({ path, ...digest }));
    const manifest: UnitySupportManifest = {
      schema: 1,
      profile: PROFILE,
      package: PACKAGE,
      version: VERSION,
      requires: { unity: '6000.6.7f1', gltfast: '6.20.0' },
      files,
    };
    const json = encodeJSON(manifest);
    return { manifest, json, sha256: await sha256(json, UNITY) };
  })();
  supportDigest.catch(() => {
    supportDigest = undefined;
  });
  return supportDigest;
}

/**
 * The support package every Unity asset bundle needs, installed once per project: the Editor and Runtime C# sources
 * under `Packages/com.margo.mesh/`, its `support-manifest.json` and a `README.txt`. Each call returns new, owned
 * bytes. Never installs anything, opens a project or runs Unity; extracting over an existing folder overwrites it.
 * @throws MargoError `unsupported` in a runtime without Web Crypto.
 */
export async function createUnityImportSupportPackage(): Promise<UnityImportSupportBundle> {
  const { manifest, json } = await supportIdentity();
  const entries: BundleEntry[] = supportPayload().map((file) => ({
    name: `${SUPPORT_ROOT}/${file.name}`,
    data: file.data,
  }));
  entries.push(
    { name: `${SUPPORT_ROOT}/support-manifest.json`, data: json.slice() },
    { name: 'README.txt', data: utf8.encode(supportReadme) },
  );
  return { entries: entries.sort(byName), manifest: structuredClone(manifest) };
}

const isFloatArray = (value: unknown, size: number) =>
  Array.isArray(value) && value.length === size && value.every((v) => typeof v === 'number' && Number.isFinite(v));

/** The parsed source the policy checks share. */
interface Source {
  nodes: Json[];
  skins: Json[];
  accessors: Json[];
  /** One reader per accessor. Safe only because validateEmbeddedImportData proved every accessor's byte range. */
  readers: ((element: number, component: number) => number)[];
  /** Each node and its ancestors, nearest first. */
  chains: number[][];
  /** Nodes some clip animates. */
  animated: Set<number>;
}

/** TRS, unit rotations and unique `extras.id` on every node; returns each node's ancestor chain. */
function nodeChains(document: Json, nodes: Json[]): number[][] {
  const parents = nodeParents(nodes, UNITY),
    ids = new Set<string>();
  nodes.forEach((node, i) => {
    if (node.matrix !== undefined)
      unsupported(
        'needs authored TRS nodes; native matrix decomposition can lose shear, so retain matrix scenes in general GLB',
      );
    if (isObject(node.extensions) && node.extensions.EXT_mesh_gpu_instancing !== undefined)
      unsupported('has no instance-inventory contract in this profile; retain instanced art in general GLB');
    for (const [key, size] of [
      ['translation', 3],
      ['rotation', 4],
      ['scale', 3],
    ] as const)
      if (node[key] !== undefined && !isFloatArray(node[key], size))
        throw new TypeError(`Unity node ${i} ${key} needs ${size} finite numbers; repair the GLB`);
    if (
      node.rotation !== undefined &&
      Math.abs((node.rotation as number[]).reduce((sum, v) => sum + v * v, 0) - 1) > F32_UNIT_ROUNDOFF
    )
      throw new RangeError(
        `Unity node ${i} rotation is not a unit quaternion; repair the source rotation (export does not normalize it)`,
      );
    const id = isObject(node.extras) ? node.extras.id : undefined;
    if (typeof id !== 'string' || !id || ids.has(id))
      throw new TypeError(
        `Unity node ${i} needs a nonempty extras.id unique among all nodes; give every mesh, bone and empty an id`,
      );
    ids.add(id);
  });
  // nodeParents proved the hierarchy acyclic.
  const chains = nodes.map((_, i) => {
    const chain: number[] = [];
    for (let at = i; at !== -1; at = parents[at]) chain.push(at);
    return chain;
  });
  const scenes = records(document.scenes, 'Unity scenes');
  if (scenes.length !== 1 || document.scene !== 0 || !Array.isArray(scenes[0].nodes))
    unsupported('needs one complete default scene; keep alternate scenes in general GLB');
  const listed = scenes[0].nodes as unknown[],
    roots = new Set(listed.map((v) => index(v, nodes.length, 'Unity scene root')));
  if (
    roots.size !== listed.length ||
    [...roots].some((i) => parents[i] !== -1) ||
    chains.some((chain) => !roots.has(chain[chain.length - 1]))
  )
    unsupported('needs every authored node retained in the complete default scene');
  return chains;
}

/** An accessor index, checked here rather than trusted from earlier validation. */
const accessorAt = (accessors: Json[], value: unknown, label: string) =>
  index(value, accessors.length, `Unity ${label} accessor`);

/** One clip's metadata, after checking its STEP keys and TRS channels; adds its targets to `source.animated`. */
function clipPolicy(
  clip: Json,
  animationIndex: number,
  names: Set<string>,
  source: Source,
): UnityImportProfile['clips'][0] {
  const { accessors, readers } = source,
    extra = object(clip.extras, 'Unity animation extras'),
    { fps, loop } = extra,
    name = clip.name;
  if (
    typeof name !== 'string' ||
    !name ||
    typeof fps !== 'number' ||
    !Number.isFinite(Math.fround(fps)) ||
    Math.fround(fps) <= 0 ||
    typeof loop !== 'boolean'
  )
    return unsupported(
      'needs explicit clip name, finite positive native Float32 extras.fps and boolean extras.loop; author the metadata before export',
    );
  if (names.has(name)) unsupported('needs unique clip names for unambiguous native playback');
  names.add(name);
  const samplers = records(clip.samplers, 'Unity animation samplers');
  if (!samplers.length) unsupported('needs nonempty authored animation samplers');
  for (const sampler of samplers) {
    if (sampler.interpolation !== 'STEP')
      unsupported('initially supports STEP clips only; keep other curves in general GLB');
    const at = accessorAt(accessors, sampler.input, 'animation input'),
      input = accessors[at],
      output = accessors[accessorAt(accessors, sampler.output, 'animation output')];
    if (
      input.type !== 'SCALAR' ||
      input.componentType !== 5126 ||
      input.normalized ||
      output.componentType !== 5126 ||
      output.normalized ||
      output.count !== input.count
    )
      unsupported('needs complete matching Float32 STEP input/output keys');
    const read = readers[at];
    for (let i = 0, previous = -1; i < (input.count as number); i++) {
      const time = read(i, 0);
      if (time < 0 || time <= previous)
        throw new RangeError(
          `Unity clip ${JSON.stringify(name)} STEP times must be nonnegative and strictly increasing; repair the clip`,
        );
      previous = time;
    }
  }
  const channels = records(clip.channels, 'Unity animation channels');
  if (!channels.length) unsupported('needs nonempty authored animation channels');
  const targets = new Set<string>();
  for (const channel of channels) {
    const sampler = samplers[index(channel.sampler, samplers.length, 'Unity channel sampler')],
      target = object(channel.target, 'Unity channel target');
    source.animated.add(index(target.node, source.nodes.length, 'Unity animation target node'));
    if (!['translation', 'rotation', 'scale'].includes(String(target.path)))
      unsupported('needs ordinary node TRS animation; keep other animation paths in general GLB');
    const key = `${target.node}/${target.path}`;
    if (targets.has(key))
      throw new TypeError(`Unity clip ${JSON.stringify(name)} animates ${key} twice; author one curve per path`);
    targets.add(key);
    if (
      accessors[accessorAt(accessors, sampler.output, 'animation output')].type !==
      (target.path === 'rotation' ? 'VEC4' : 'VEC3')
    )
      unsupported('needs matching TRS animation output arity');
  }
  return { animationIndex, name, fps, loop };
}

/** Unique joints and one Float32 inverse bind per joint. */
function checkSkin(skin: Json, { nodes, accessors }: Source): void {
  if (!Array.isArray(skin.joints) || !skin.joints.length)
    throw new TypeError('Unity skin needs a nonempty joint inventory; export the skin with its joints');
  const joints = skin.joints.map((v) => index(v, nodes.length, 'Unity skin joint'));
  if (new Set(joints).size !== joints.length)
    throw new TypeError('Unity skin lists a joint twice; export each joint once');
  if (skin.skeleton !== undefined) index(skin.skeleton, nodes.length, 'Unity skin skeleton');
  const bind = accessors[index(skin.inverseBindMatrices, accessors.length, 'Unity inverse binds')];
  if (bind.type !== 'MAT4' || bind.componentType !== 5126 || bind.count !== joints.length)
    unsupported('needs one exact Float32 inverse-bind matrix per joint');
}

/** Every vertex's joints exist in `skin` and its four Float32 weights lie in [0, 1] and sum to 1. */
function checkSkinWeights(attributes: Json, vertices: unknown, skin: Json, { accessors, readers }: Source): void {
  const w = accessorAt(accessors, attributes.WEIGHTS_0, 'skin weights'),
    j = accessorAt(accessors, attributes.JOINTS_0, 'skin joint indices'),
    weights = accessors[w],
    joints = accessors[j];
  if (
    weights.type !== 'VEC4' ||
    weights.componentType !== 5126 ||
    weights.count !== vertices ||
    weights.normalized ||
    joints.type !== 'VEC4' ||
    ![5121, 5123].includes(joints.componentType as number) ||
    joints.normalized ||
    joints.count !== vertices
  )
    unsupported('needs complete ordinary joint/Float32-weight attributes without quantization');
  const jointCount = (skin.joints as unknown[]).length,
    readJoint = readers[j],
    readWeight = readers[w];
  for (let v = 0; v < (weights.count as number); v++) {
    let total = 0;
    for (let c = 0; c < 4; c++) {
      const weight = readWeight(v, c);
      if (readJoint(v, c) >= jointCount)
        throw new RangeError(`Unity vertex ${v} joint index exceeds its skin's ${jointCount} joints; repair the GLB`);
      if (weight < 0 || weight > 1)
        throw new RangeError(`Unity vertex ${v} skin weight ${weight} is outside [0, 1]; repair the source weights`);
      total += weight;
    }
    if (total <= 0 || Math.abs(total - 1) > F32_UNIT_ROUNDOFF)
      throw new RangeError(
        `Unity vertex ${v} skin weights sum to ${total}, not 1; repair the source (export does not normalize them)`,
      );
  }
}

/** Triangle count of one atlas-bound, Float32 primitive, after checking its attributes, skin and indices. */
function primitiveTriangles(primitive: Json, skin: Json | undefined, meshIndex: number, source: Source): number {
  const { accessors, readers } = source;
  if ((primitive.mode ?? 4) !== 4 || primitive.targets !== undefined)
    unsupported('needs ordinary triangle primitives without morph targets; retain other geometry in general GLB');
  if (primitive.material !== 0) unsupported('needs every primitive bound to the single atlas material');
  const attributes = object(primitive.attributes, 'Unity mesh attributes'),
    vertices = accessors[accessorAt(accessors, attributes.POSITION, 'POSITION')].count as number;
  for (const [key, type] of [
    ['POSITION', 'VEC3'],
    ['NORMAL', 'VEC3'],
    ['TEXCOORD_0', 'VEC2'],
  ] as const) {
    const accessor = accessors[accessorAt(accessors, attributes[key], key)];
    if (accessor.type !== type || accessor.componentType !== 5126 || accessor.normalized || accessor.count !== vertices)
      unsupported('needs source-exact Float32 position/normal/UV attributes with matching vertex counts');
  }
  if (skin) checkSkinWeights(attributes, vertices, skin, source);
  let corners = vertices;
  if (primitive.indices !== undefined) {
    const at = accessorAt(accessors, primitive.indices, 'index'),
      accessor = accessors[at],
      read = readers[at];
    if (
      accessor.type !== 'SCALAR' ||
      ![5121, 5123, 5125].includes(accessor.componentType as number) ||
      accessor.normalized
    )
      unsupported('needs ordinary integer triangle indices');
    corners = accessor.count as number;
    for (let i = 0; i < corners; i++)
      if (read(i, 0) >= vertices)
        throw new RangeError('Unity triangle index exceeds its source vertices; repair the GLB');
  }
  if (corners % 3)
    throw new TypeError(`Unity mesh ${meshIndex} has ${corners} triangle corners, not a multiple of 3; repair the GLB`);
  return corners / 3;
}

/** The import policy of one mesh node: visibility from its chain, collider from its name suffix. */
function meshNodePolicy(
  node: Json,
  nodeIndex: number,
  meshes: Json[],
  colliders: boolean,
  source: Source,
): UnityImportNode {
  const meshIndex = index(node.mesh, meshes.length, 'Unity node mesh');
  const skin =
    node.skin === undefined ? undefined : source.skins[index(node.skin, source.skins.length, 'Unity node skin')];
  if (typeof node.name !== 'string' || !node.name) unsupported('needs stable nonempty mesh node names');
  const name = node.name as string,
    primitives = records(meshes[meshIndex].primitives, 'Unity mesh primitives');
  if (!primitives.length) unsupported('needs nonempty mesh primitives');
  let triangles = 0;
  for (const primitive of primitives) triangles += primitiveTriangles(primitive, skin, meshIndex, source);
  const chain = source.chains[nodeIndex],
    suffix = /-((?:conv)?col(?:only)?)$/i.exec(name)?.[1].toLowerCase() ?? '',
    collider: UnityImportNode['collider'] = suffix.startsWith('conv') ? 'convex' : suffix ? 'concave' : 'none';
  if (colliders && collider !== 'none') {
    if (
      node.skin !== undefined ||
      node.weights !== undefined ||
      (isObject(node.extensions) && node.extensions.EXT_mesh_gpu_instancing !== undefined)
    )
      unsupported('cannot generate this skinned/morphed/instanced collider; author a static physics helper');
    if (collider === 'concave' && chain.some((i) => source.animated.has(i)))
      unsupported('cannot generate an animated concave collider; author a separate supported physics helper');
    if (collider === 'convex' && triangles > 255)
      unsupported(
        'cannot generate a convex collider above 255 source triangles; author a smaller dedicated physics helper without reducing visible art',
      );
  }
  const sourceVisible = chain.every((i) => {
    const extensions = isObject(source.nodes[i].extensions) ? source.nodes[i].extensions : {};
    const visibility = isObject(extensions.KHR_node_visibility) ? extensions.KHR_node_visibility : {};
    if (visibility.visible !== undefined && typeof visibility.visible !== 'boolean')
      throw new TypeError(`Unity node ${i} KHR_node_visibility.visible must be boolean; repair the GLB`);
    return visibility.visible !== false;
  });
  return {
    nodeIndex,
    id: (node.extras as Json).id as string,
    meshIndex,
    name,
    sourceVisible,
    rendererVisible: sourceVisible && !suffix.endsWith('only'),
    collider,
  };
}

/**
 * The node and clip policy of a Margo Mesh Studio GLB; every check reads the encoded data without changing it.
 * Precondition: validateEmbeddedImportData(document, bin) has passed (createUnityImportBundle runs it first), so
 * accessor byte ranges are trusted; every index this policy follows is still checked where it is used.
 */
function sourcePolicy(
  document: Json,
  bin: Uint8Array,
  colliders: boolean,
): Pick<UnityImportProfile, 'nodes' | 'clips'> {
  if (object(document.asset, 'Unity asset').generator !== 'Margo Mesh Studio')
    unsupported('requires the explicit Margo Mesh Studio source profile; use general GLB for other generators');
  const nodes = records(document.nodes, 'Unity nodes'),
    meshes = records(document.meshes, 'Unity meshes');
  if (!nodes.length || !meshes.length) unsupported('needs authored mesh nodes; export a nonempty asset');
  const chains = nodeChains(document, nodes),
    accessors = records(document.accessors, 'Unity accessors'),
    views = records(document.bufferViews, 'Unity bufferViews'),
    source: Source = {
      nodes,
      skins: records(document.skins, 'Unity skins'),
      accessors,
      readers: accessors.map((accessor) => accessorReader(accessor, views, bin)),
      chains,
      animated: new Set(),
    };
  accessors.forEach((accessor, a) => {
    if (accessor.componentType !== 5126) return;
    const read = source.readers[a],
      components = ACCESSOR_WIDTHS[accessor.type as string];
    for (let i = 0; i < (accessor.count as number); i++)
      for (let c = 0; c < components; c++)
        if (!Number.isFinite(read(i, c)))
          throw new RangeError(`Unity accessor ${a} holds a non-finite Float32; repair the attributes, binds or keys`);
  });
  const names = new Set<string>(),
    clips = records(document.animations, 'Unity animations').map((clip, i) => clipPolicy(clip, i, names, source));
  for (const skin of source.skins) checkSkin(skin, source);
  const inventory: UnityImportNode[] = [];
  nodes.forEach((node, i) => {
    if (node.mesh !== undefined) inventory.push(meshNodePolicy(node, i, meshes, colliders, source));
  });
  if (!inventory.length) unsupported('needs mesh instances referenced by authored nodes');
  return { nodes: inventory, clips };
}

/**
 * A Unity asset bundle under `options.folder`: a byte-exact, owned copy of `glb`, its embedded atlas as `atlas.png`,
 * the `margo-profile.json` sidecar, a `README.txt` and the `margo-manifest.json` hashes. The support package from
 * {@link createUnityImportSupportPackage} must be installed in the project; it imports the asset through glTFast and
 * reports when the generated prefab is current. The profile accepts one Margo Mesh Studio GLB with a single
 * base-color atlas (NEAREST, clamped, power-of-two RGBA8 PNG), TRS nodes with unique `extras.id`, STEP clips with
 * `extras.fps` and `extras.loop`, and unit-sum skin weights; anything else rejects rather than being reduced.
 * No project file, package installation or Unity process is touched.
 * @throws TypeError for a non-GLB input, an unsafe folder, a non-boolean `colliders` or malformed glTF; RangeError for a
 * missing reference, an out-of-range accessor, non-finite data or bad key times or weights; MargoError `unsupported`
 * for data the profile cannot carry exactly, or a runtime without Web Crypto.
 */
export async function createUnityImportBundle(
  glb: Uint8Array,
  options: UnityImportOptions,
): Promise<UnityImportBundle> {
  if (!(glb instanceof Uint8Array))
    throw new TypeError('Unity import bundle needs GLB bytes as a Uint8Array; pass exportGLB output');
  const config = object(options, 'Unity import options'),
    folder = folderName(config.folder),
    colliders = config.colliders === undefined ? true : config.colliders;
  if (typeof colliders !== 'boolean') throw new TypeError('Unity colliders must be a boolean; pass true or false');
  const owned = Uint8Array.from(glb),
    { json: document, bin } = splitGLB(owned);
  validateEmbeddedImportData(document, bin, UNITY);
  const materials = records(document.materials, 'Unity materials'),
    textures = records(document.textures, 'Unity textures'),
    images = records(document.images, 'Unity images'),
    samplers = records(document.samplers, 'Unity samplers');
  if (materials.length !== 1 || textures.length !== 1 || images.length !== 1 || samplers.length !== 1)
    unsupported(
      'needs one material, one texture, one embedded PNG and one explicit sampler; keep other profiles in general GLB',
    );
  const material = materials[0],
    pbr = object(material.pbrMetallicRoughness, 'Unity PBR material'),
    base = object(pbr.baseColorTexture, 'Unity base-color texture');
  if (
    base.index !== 0 ||
    (base.texCoord ?? 0) !== 0 ||
    base.extensions !== undefined ||
    material.normalTexture !== undefined ||
    material.occlusionTexture !== undefined ||
    material.emissiveTexture !== undefined ||
    pbr.metallicRoughnessTexture !== undefined ||
    material.extensions !== undefined
  )
    unsupported(
      'supports the single untransformed base-color atlas profile; retain other material maps/extensions in general GLB',
    );
  if (textures[0].source !== 0 || textures[0].sampler !== 0 || textures[0].extensions !== undefined)
    unsupported('needs direct source0/sampler0 atlas ownership');
  const sampler = samplers[0];
  if (sampler.magFilter !== 9728 || sampler.minFilter !== 9728 || sampler.wrapS !== 33071 || sampler.wrapT !== 33071)
    unsupported('needs explicit NEAREST/NEAREST CLAMP_TO_EDGE sampling; author compatible sampler metadata');
  if (!bin) return unsupported('needs the atlas embedded in the BIN chunk; export a self-contained GLB');
  const views = records(document.bufferViews, 'Unity bufferViews'),
    view = views[index(images[0].bufferView, views.length, 'Unity atlas bufferView')],
    offset = (view.byteOffset ?? 0) as number,
    png = bin.slice(offset, offset + (view.byteLength as number)),
    size = pngSize(png),
    policy = sourcePolicy(document, bin, colliders);
  const [glbSHA256, pngSHA256, support] = await Promise.all([
    sha256(owned, UNITY),
    sha256(png, UNITY),
    supportIdentity(),
  ]);
  const dependency: UnityImportSupport = { package: PACKAGE, version: VERSION, manifestSHA256: support.sha256 };
  const profile: UnityImportProfile = {
    schema: 1,
    profile: PROFILE,
    support: dependency,
    source: { glb: 'model.glb', glbSHA256, png: 'atlas.png', pngSHA256, textureIndex: 0, ...size },
    sampler: {
      magFilter: 9728,
      minFilter: 9728,
      wrapS: 33071,
      wrapT: 33071,
      dataColorSpace: 'srgb',
      mipmaps: false,
      anisotropy: 0,
    },
    generateColliders: colliders,
    nodes: policy.nodes,
    clips: policy.clips,
  };
  const entries: BundleEntry[] = [
    { name: `${folder}/model.glb`, data: owned },
    { name: `${folder}/atlas.png`, data: png },
    { name: `${folder}/margo-profile.json`, data: encodeJSON(profile) },
    {
      name: `${folder}/README.txt`,
      data: utf8.encode(
        'Margo Unity exact asset profile\n\nCopy this folder at its exact declared Assets path into a project with the separately installed matching Margo support package and official glTFast. Manual extraction can overwrite destination files and has no preflight conflict protection. This asset-only archive never contains shared Packages files or fabricated .meta GUIDs.\n\nUse the generated model.Margo/model.prefab only after its owned report says ready/current for this exact source, profile and support tuple. Missing, rejected, generating, partial or stale state is not acceptance. A clean reimport is required after a partial generation; earlier output may have been modified. No raw-import zero-cleanup, Humanoid or cross-rig portability is implied. Other export profiles retain their original source quality.\n',
      ),
    },
  ].sort(byName);
  const manifest: UnityImportManifest = {
    schema: 1,
    profile: PROFILE,
    resourceDirectory: folder,
    support: { ...dependency },
    files: await digests(
      entries,
      UNITY,
      new Map([
        [owned, glbSHA256],
        [png, pngSHA256],
      ]),
    ),
  };
  entries.push({ name: `${folder}/margo-manifest.json`, data: encodeJSON(manifest) });
  return { entries: entries.sort(byName), manifest };
}
