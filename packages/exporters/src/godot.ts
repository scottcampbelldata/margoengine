// Godot import bundle: the unchanged GLB plus a `.import` seed, a post-import script and a manifest. The supplied GLB
// is never rewritten; only Godot's public scene-import and convex-shape APIs interpret the profile.
import type { GodotFlipbookBinding } from './godot-flipbook.js';
import { splitGLB } from './glb.js';
import {
  type BundleEntry,
  type FileDigest,
  type Json,
  accessorReader,
  bundleFolder,
  digests,
  encodeJSON,
  index,
  isObject,
  nodeParents,
  object,
  records,
  unsupportedFor,
  utf8,
  validateEmbeddedImportData,
} from './import-data.js';

export type { BundleEntry, FileDigest } from './import-data.js';
export type { GodotFlipbookBinding } from './godot-flipbook.js';

/** Options for {@link createGodotImportBundle}. No project-wide configuration is written. */
export interface GodotImportOptions {
  /**
   * Project-root-relative folder of the bundle (ASCII letters, digits, `_`, `-`, separated by `/`), such as
   * `'margo_exports/waystone'`. Copy it into the project without renaming.
   */
  folder: string;
  /**
   * `extras.id` of every hidden static `-convcol` mesh node; Godot replaces each one's imported shape with an exact
   * convex hull. The list must name every such node exactly once. Default `[]`.
   */
  convexHelperIds?: readonly string[];
  /**
   * Godot's animation sampling rate, in frames per second. Default the `extras.fps` every clip declares; required when
   * clips declare different or no rates. Every STEP key time must fall on this grid.
   */
  fps?: number;
  /**
   * UV flipbooks to play in Godot: adds `flipbook-player.gd` (from `createGodotFlipbookPlayer`),
   * `flipbook-bindings.json` and `scene.tscn`, a Node3D named `appName` running the player with the GLB instanced as
   * its `Geometry` child. Binding `nodePath`s are relative to that Node3D (`Geometry/<GLB root>/...`).
   */
  flipbooks?: { appName: string; bindings: readonly GodotFlipbookBinding[] };
  /** Further files written into the bundle folder and its manifest, such as the application's own metadata. */
  files?: readonly { name: string; data: Uint8Array }[];
}

/** The `margo-godot-profile.json` written by {@link createGodotImportBundle}; it does not list itself. */
export interface GodotImportManifest {
  schema: 1;
  profile: 'margo-godot-exact-v1';
  testedGodotVersion: '4.7.2';
  /** The bundle folder ({@link GodotImportOptions.folder}). */
  resourceDirectory: string;
  glbSHA256: string;
  /** The sampling rate written to the seed, or null for a GLB without clips. */
  animationFPS: number | null;
  /** Where `animationFPS` came from: `options.fps`, the clips' `extras.fps`, or none (no clips). */
  animationFPSOrigin: 'explicit' | 'metadata' | 'none';
  animations: { name: string | null; declaredFPS: number | null; loop: boolean | null }[];
  helpers: { id: string; node: number; name: string }[];
  /** The `[params]` written to `model.glb.import`. */
  settings: Record<string, string | number | boolean | { nodes: Record<string, Record<string, boolean>> }>;
  files: FileDigest[];
}

/** Result of {@link createGodotImportBundle}: the bundle files and their manifest. */
export interface GodotImportBundle {
  /** `model.glb`, `model.glb.import`, `margo-import.gd`, `README.txt` and `margo-godot-profile.json`, in that order. */
  entries: BundleEntry[];
  manifest: GodotImportManifest;
}

const GODOT = 'Godot',
  unsupported = unsupportedFor(GODOT);

const folderName = (value: unknown) => bundleFolder(value, GODOT, 'margo_exports/waystone');

/** Float32 key times of a STEP sampler input; validateEmbeddedImportData proved its byte range. */
function keyTimes(accessors: Json[], views: Json[], bin: Uint8Array, input: number): number[] {
  const accessor = accessors[input];
  if (accessor.type !== 'SCALAR' || accessor.componentType !== 5126 || accessor.normalized)
    unsupported('requires ordinary Float32 SCALAR animation times; export an uncompressed GLB');
  const read = accessorReader(accessor, views, bin),
    times: number[] = [];
  for (let i = 0; i < (accessor.count as number); i++) {
    const time = read(i, 0);
    if (!Number.isFinite(time) || time < 0 || (i > 0 && time <= times[i - 1]))
      throw new RangeError(
        'Godot animation key times must be finite, nonnegative and strictly increasing; repair the clip',
      );
    times.push(time);
  }
  return times;
}

function animations(document: Json, bin: Uint8Array | null, suppliedFPS: unknown, nodes: Json[]) {
  const clips = records(document.animations, 'GLB animations');
  const metadata = clips.map((clip) => {
    const extras = isObject(clip.extras) ? clip.extras : {};
    return {
      name: typeof clip.name === 'string' ? clip.name : null,
      declaredFPS: typeof extras.fps === 'number' && Number.isFinite(extras.fps) && extras.fps > 0 ? extras.fps : null,
      loop: typeof extras.loop === 'boolean' ? extras.loop : null,
    };
  });
  if (suppliedFPS !== undefined) {
    if (typeof suppliedFPS !== 'number') throw new TypeError('Godot fps must be a number; pass frames per second');
    if (!Number.isFinite(suppliedFPS) || suppliedFPS <= 0)
      throw new RangeError(`Godot fps ${suppliedFPS} must be finite and positive; choose a compatible import clock`);
  }
  let fps = (suppliedFPS as number | undefined) ?? null;
  let origin: GodotImportManifest['animationFPSOrigin'] = fps === null ? 'none' : 'explicit';
  const animated = new Set<number>();
  if (!clips.length) return { fps, origin, metadata, animated };
  if (fps === null) {
    const declared = metadata[0].declaredFPS;
    if (declared === null || metadata.some((clip) => clip.declaredFPS !== declared))
      unsupported('has mixed or missing clip FPS; provide fps compatible with every encoded key time');
    fps = declared;
    origin = 'metadata';
  }
  const accessors = records(document.accessors, 'GLB accessors'),
    views = records(document.bufferViews, 'GLB bufferViews'),
    rate = fps as number;
  for (const clip of clips) {
    const samplers = records(clip.samplers, 'Godot animation samplers');
    for (const channel of records(clip.channels, 'Godot animation channels')) {
      const target = object(channel.target, 'Godot animation target');
      // KHR_animation_pointer channels (such as UV flipbooks on a material) target a property, not a node.
      const pointer = isObject(target.extensions) ? target.extensions.KHR_animation_pointer : undefined;
      if (target.path === 'pointer' && target.node === undefined) {
        if (!isObject(pointer) || typeof pointer.pointer !== 'string' || !pointer.pointer.startsWith('/'))
          throw new TypeError(
            'Godot pointer animation target needs a KHR_animation_pointer JSON pointer; repair the GLB',
          );
      } else animated.add(index(target.node, nodes.length, 'Godot animation target node'));
      index(channel.sampler, samplers.length, 'Godot animation sampler');
    }
    for (const sampler of samplers) {
      if (sampler.interpolation !== 'STEP')
        unsupported('supports STEP clips only; keep other interpolation in general GLB');
      // A sampler input is a validated accessor, and accessors exist only with the owned BIN chunk.
      for (const time of keyTimes(accessors, views, bin as Uint8Array, sampler.input as number)) {
        const frame = Math.round(time * rate);
        // A representable key is exactly the Float32 encoding of one unique grid
        // point. No visual tolerance hides a dropped fractional STEP transition.
        if (
          !Number.isSafeInteger(frame) ||
          Math.fround(frame / rate) !== time ||
          Math.fround((frame - 1) / rate) === time ||
          Math.fround((frame + 1) / rate) === time
        )
          unsupported(`cannot represent a STEP key at ${time}s on the ${rate} FPS grid; choose a compatible fps`);
      }
    }
  }
  return { fps, origin, metadata, animated };
}

function helpers(document: Json, nodes: Json[], parents: number[], ids: unknown, animated: Set<number>) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id))
    throw new TypeError('Godot convexHelperIds must be an array of nonempty exported extras.id strings');
  const requested = new Set<string>(ids);
  if (requested.size !== ids.length) throw new TypeError('Godot convexHelperIds has duplicates; list each helper once');
  const byID = new Map<string, number>();
  nodes.forEach((node, i) => {
    const id = isObject(node.extras) ? node.extras.id : undefined;
    if (id === undefined) return;
    if (typeof id !== 'string' || !id)
      throw new TypeError(`Godot node ${i} extras.id must be a nonempty string; repair node identities`);
    if (byID.has(id))
      throw new TypeError(`Godot exported extras.id ${JSON.stringify(id)} is duplicated; repair node identities`);
    byID.set(id, i);
  });
  const meshes = records(document.meshes, 'GLB meshes');
  const hiddenConvex = new Set<number>();
  nodes.forEach((node, i) => {
    const extensions = isObject(node.extensions) ? node.extensions : {};
    const visibility = isObject(extensions.KHR_node_visibility) ? extensions.KHR_node_visibility : {};
    if (visibility.visible === false && typeof node.name === 'string' && /-convcol$/i.test(node.name))
      hiddenConvex.add(i);
  });
  const selected = [...requested].sort().map((id) => {
    const i = byID.get(id),
      label = `Godot helper ${JSON.stringify(id)}`;
    if (i === undefined) throw new TypeError(`${label} is missing from this GLB; list only exported extras.id values`);
    const node = nodes[i];
    if (!hiddenConvex.has(i))
      throw new TypeError(`${label} needs a hidden mesh node named *-convcol; export it with retainedVisibility false`);
    const mesh = meshes[index(node.mesh, meshes.length, `${label} mesh`)];
    const primitives = records(mesh.primitives, 'Godot helper primitives');
    if (!primitives.length) throw new TypeError(`${label} has no mesh primitives; export its geometry`);
    if (
      node.skin !== undefined ||
      node.weights !== undefined ||
      (isObject(node.extensions) && node.extensions.EXT_mesh_gpu_instancing !== undefined)
    )
      unsupported(`helper ${JSON.stringify(id)} must be static and unskinned; author a separate static convex helper`);
    for (const primitive of primitives) {
      const attributes = object(primitive.attributes, 'Godot helper attributes');
      if ((primitive.mode ?? 4) !== 4 || attributes.POSITION === undefined)
        throw new TypeError(`${label} needs triangle POSITION geometry; export it as triangles`);
      if (primitive.targets !== undefined || attributes.JOINTS_0 !== undefined || attributes.WEIGHTS_0 !== undefined)
        unsupported(`helper ${JSON.stringify(id)} has deformation data; author a static helper`);
    }
    for (let p = i; p !== -1; p = parents[p])
      if (animated.has(p))
        unsupported(`helper ${JSON.stringify(id)} has animated ancestry; export static collision separately`);
    return { id, node: i, name: node.name as string };
  });
  if (selected.length !== hiddenConvex.size)
    throw new TypeError('Godot convexHelperIds must list every exported hidden -convcol node exactly once');
  return selected;
}

function nativeScript(ids: string[]): string {
  const allowlist = JSON.stringify(Object.fromEntries(ids.map((id) => [id, true])))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `@tool
extends EditorScenePostImport

# Generated by Margo Engine. Native target integration only; render data is untouched.
const HELPER_IDS := ${allowlist}

func descendants(node: Node) -> Array[Node]:
\tvar found: Array[Node] = [node]
\tfor child in node.get_children(): found.append_array(descendants(child))
\treturn found

func fail(scene: Node, replacements: Array, message: String) -> Object:
\treplacements.clear()
\tpush_error("Margo Godot profile: " + message)
\tscene.free()
\treturn null

func _post_import(scene: Node) -> Object:
\tvar applied := {}
\tvar replacements := []
\tfor node in descendants(scene):
\t\tif not node is MeshInstance3D or node.mesh == null: continue
\t\tvar extras = node.get_meta("extras", {})
\t\tif not extras is Dictionary: continue
\t\tvar identity := str(extras.get("id", ""))
\t\tif not HELPER_IDS.has(identity): continue
\t\tif applied.has(identity):
\t\t\treturn fail(scene, replacements, "duplicate helper identity " + identity)
\t\tvar shapes: Array[CollisionShape3D] = []
\t\tfor child in descendants(node):
\t\t\tif child is CollisionShape3D: shapes.append(child)
\t\tif shapes.size() != 1 or not shapes[0].shape is ConvexPolygonShape3D:
\t\t\treturn fail(scene, replacements, "expected one imported convex shape for " + identity)
\t\tvar relative := Transform3D.IDENTITY
\t\tvar current: Node = shapes[0]
\t\twhile current != node:
\t\t\tif current == null:
\t\t\t\treturn fail(scene, replacements, "detached shape for " + identity)
\t\t\tif current is Node3D: relative = current.transform * relative
\t\t\tcurrent = current.get_parent()
\t\tif relative != Transform3D.IDENTITY:
\t\t\treturn fail(scene, replacements, "nonidentity shape alignment is unsupported for " + identity)
\t\tvar exact: ConvexPolygonShape3D = node.mesh.create_convex_shape(false, false)
\t\tif exact == null or exact.points.size() < 4:
\t\t\treturn fail(scene, replacements, "native convex volume failed for " + identity)
\t\texact.margin = shapes[0].shape.margin
\t\treplacements.append({"node": shapes[0], "shape": exact})
\t\tapplied[identity] = true
\tif applied.size() != HELPER_IDS.size():
\t\treturn fail(scene, replacements, "imported helper inventory differs from the exported GLB")
\tfor replacement in replacements: replacement.node.shape = replacement.shape
\tprint("MARGO_GODOT_IMPORT_PROFILE helpers=", applied.size())
\treturn scene
`;
}

/**
 * A Godot 4 import bundle around a byte-exact, owned copy of `glb`: `model.glb`, its `model.glb.import` seed, a
 * `margo-import.gd` post-import script, a `README.txt` and the `margo-godot-profile.json` manifest, all under
 * `options.folder`. Copy the folder into the project root without renaming it, or pack `entries` with `encodeZIP`.
 * Godot makes its own UIDs and cache paths; no project-wide setting is written.
 *
 * Embedded PNGs import uncompressed without mipmaps. Each `convexHelperIds` node gets Godot's exact
 * `create_convex_shape(false, false)` hull, and only after its imported shape-to-mesh transform is identity; otherwise
 * the import aborts. STEP key times are never rewritten: each must be the Float32 encoding of one point on the `fps`
 * grid. Animated bundles turn off Godot's optimizer and compression on the generated `PATH:AnimationPlayer`. Buffer
 * view and accessor ranges are checked without decoding geometry; no Godot process runs.
 * @throws TypeError for a non-GLB input, an unsafe folder, malformed glTF or node identities, or an incomplete helper
 * list; RangeError for a bad `fps`, a missing reference, an out-of-range accessor or bad key times; MargoError
 * `unsupported` for data this profile cannot carry exactly (non-STEP clips, deformed helpers, compression, external
 * data) or a runtime without Web Crypto.
 */
export async function createGodotImportBundle(
  glb: Uint8Array,
  options: GodotImportOptions,
): Promise<GodotImportBundle> {
  if (!(glb instanceof Uint8Array))
    throw new TypeError('Godot bundle needs GLB bytes as a Uint8Array; pass exportGLB output');
  if (!isObject(options)) throw new TypeError('Godot bundle needs an options object; pass at least { folder }');
  const folder = folderName(options.folder),
    owned = Uint8Array.from(glb);
  const { json: document, bin } = splitGLB(owned);
  validateEmbeddedImportData(document, bin, GODOT);
  const nodes = records(document.nodes, 'GLB nodes'),
    parents = nodeParents(nodes, GODOT);
  const timing = animations(document, bin, options.fps, nodes);
  const inventory = helpers(
    document,
    nodes,
    parents,
    options.convexHelperIds === undefined ? [] : options.convexHelperIds,
    timing.animated,
  );
  if (timing.metadata.length && nodes.some((node) => node.name === 'AnimationPlayer'))
    unsupported(
      'cannot pin the generated AnimationPlayer path when a source node uses that name; rename that node or use general GLB',
    );
  const settings: GodotImportManifest['settings'] = {
    // Collision and helper nodes are named by suffix (-col, -convcol, ...); state the import that reads them.
    'nodes/use_name_suffixes': true,
    'nodes/use_node_type_suffixes': true,
    'meshes/force_disable_compression': true,
    'meshes/generate_lods': false,
    'meshes/create_shadow_meshes': false,
    ...(timing.fps === null ? {} : { 'animation/fps': timing.fps }),
    'animation/remove_immutable_tracks': false,
    'animation/trimming': false,
    'skins/use_named_skins': true,
    'gltf/embedded_image_handling': 3,
    'gltf/texture_map_mode': 1,
    'import_script/path': `res://${folder}/margo-import.gd`,
    ...(timing.metadata.length
      ? {
          _subresources: {
            nodes: { 'PATH:AnimationPlayer': { 'optimizer/enabled': false, 'compression/enabled': false } },
          },
        }
      : {}),
  };
  const seed =
    `[remap]\nimporter="scene"\ntype="PackedScene"\n\n[deps]\nsource_file="res://${folder}/model.glb"\n\n[params]\n` +
    Object.entries(settings)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
      .join('');
  const entries: BundleEntry[] = [
    { name: `${folder}/model.glb`, data: owned },
    { name: `${folder}/model.glb.import`, data: utf8.encode(seed) },
    { name: `${folder}/margo-import.gd`, data: utf8.encode(nativeScript(inventory.map((helper) => helper.id))) },
    {
      name: `${folder}/README.txt`,
      data: utf8.encode(
        `Margo Godot exact import profile v1\n\nCopy ${folder} into your Godot project root without renaming the folder. Godot imports model.glb using its sibling seed and generated post-import script; no CLI, Inspector cleanup or project settings changes are required.\n\nTested mechanism: Godot 4.7.2. This is a configured profile, not a claim about raw default import. Original GLB bytes and PNG payloads are unchanged. Native helper shapes preserve their imported margins and require identity shape-to-mesh alignment. Native geometry, pixels, STEP holds/loops and collision still require asset-specific acceptance; mixed clocks and other Godot versions are not blanket-certified.\n\nDo not replace an existing asset folder without reviewing its contents. Arbitrary folder relocation and copying while the editor is already importing require separate native acceptance.\n`,
      ),
    },
  ];
  if (options.flipbooks !== undefined) {
    const { appName, bindings } = options.flipbooks;
    const { createGodotFlipbookPlayer } = await import('./godot-flipbook.js');
    const player = createGodotFlipbookPlayer({ appName });
    if (!Array.isArray(bindings)) throw new TypeError('flipbooks.bindings must be an array of flipbook bindings');
    entries.push(
      { name: `${folder}/flipbook-player.gd`, data: utf8.encode(player) },
      {
        name: `${folder}/flipbook-bindings.json`,
        data: encodeJSON({ format: `${appName}Flipbook`, version: 1, bindings }),
      },
      {
        name: `${folder}/scene.tscn`,
        data: utf8.encode(
          `[gd_scene load_steps=3 format=3]\n\n[ext_resource type="PackedScene" path="res://${folder}/model.glb" id="1"]\n[ext_resource type="Script" path="res://${folder}/flipbook-player.gd" id="2"]\n\n[node name="${appName}" type="Node3D"]\nscript = ExtResource("2")\nbindings_path = "flipbook-bindings.json"\n\n[node name="Geometry" parent="." instance=ExtResource("1")]\n`,
        ),
      },
    );
  }
  for (const file of options.files ?? []) {
    if (
      !isObject(file) ||
      typeof file.name !== 'string' ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(file.name) ||
      !(file.data instanceof Uint8Array) ||
      entries.some((entry) => entry.name === `${folder}/${file.name}`) ||
      file.name === 'margo-godot-profile.json'
    )
      throw new TypeError(
        'Godot bundle files need distinct plain file names (letters, digits, _ . -) and Uint8Array data; rename the file',
      );
    entries.push({ name: `${folder}/${file.name}`, data: Uint8Array.from(file.data) });
  }
  const files = await digests(entries, GODOT);
  const manifest: GodotImportManifest = {
    schema: 1,
    profile: 'margo-godot-exact-v1',
    testedGodotVersion: '4.7.2',
    resourceDirectory: folder,
    glbSHA256: files[0].sha256,
    animationFPS: timing.fps,
    animationFPSOrigin: timing.origin,
    animations: timing.metadata,
    helpers: inventory,
    settings,
    files,
  };
  entries.push({ name: `${folder}/margo-godot-profile.json`, data: encodeJSON(manifest) });
  return { entries, manifest };
}
