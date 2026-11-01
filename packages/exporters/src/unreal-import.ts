// Unreal collision names and UV flipbook materials from a scene, from Unreal's public documentation on FBX static mesh
// collision naming and its Python API. Strings only; the script runs in the Unreal editor.
import { collisionNodes, uvClips } from './uv-clips.js';
import type { ExportScene } from './scene.js';

/** The primitive a convex collision node should import as. Default `'convex'`. */
export type UnrealCollisionShape = 'convex' | 'box' | 'sphere';

/** What a node of the scene becomes in Unreal. */
export interface UnrealCollisionEntry {
  /** The node's name in the scene, with its `-col` suffix. */
  node: string;
  /** Name to give the node in the exported file: `UCX_`, `UBX_` or `USP_`, the mesh and a two-digit number. */
  importName: string;
  /** The static mesh it collides for. */
  mesh: string;
}
/** A UV clip as the flipbook graph needs it: cels on a regular grid, each shown as long. */
export interface UnrealFlipbook {
  clip: string;
  material: string;
  /** Frames per second. */
  fps: number;
  frames: number;
  columns: number;
  /** UV size of a cel. */
  scale: [number, number];
  /** UV of the first cel. */
  origin: [number, number];
  /** UV step between cels across and down. */
  step: [number, number];
}

const NEAR = 1e-4,
  close = (a: number, b: number): boolean => Math.abs(a - b) <= NEAR;
const py = (text: string): string => JSON.stringify(text);

/**
 * Names for a scene's collision nodes as Unreal's importer reads them. `-convcol` and `-convcolonly` become `UCX_<mesh>_NN`,
 * or `UBX_` and `USP_` through `shapes` (by node name). A concave `-col` or `-colonly` has no such primitive, because
 * Unreal's collision parts are convex: a `-col` mesh uses its own triangles through {@link createUnrealImportScript}, and a
 * `-colonly` is refused. Rename the nodes to `importName` before writing the file you import.
 * @example
 * ```ts
 * import {unrealCollisionNames} from 'margoengine/exporters/unreal-import';
 * const scene = {nodes: [{name: 'crate-convcolonly'}]};
 * const [{importName}] = unrealCollisionNames(scene, {shapes: {'crate-convcolonly': 'box'}});
 * ```
 * @throws RangeError for a `-colonly` node, which needs convex pieces; TypeError for an unknown shape.
 */
export function unrealCollisionNames(
  scene: ExportScene,
  { shapes = {} }: { shapes?: Readonly<Record<string, UnrealCollisionShape>> } = {},
): UnrealCollisionEntry[] {
  const counts = new Map<string, number>(),
    prefixes: Record<UnrealCollisionShape, string> = { convex: 'UCX', box: 'UBX', sphere: 'USP' };
  return collisionNodes(scene).flatMap(({ name, base, convex, visible }) => {
    if (!convex) {
      if (!visible)
        throw new RangeError(
          `Node ${name} is a concave collider, which Unreal cannot hold; split it into -convcolonly pieces`,
        );
      return [];
    }
    const shape = shapes[name] ?? 'convex',
      prefix = Object.hasOwn(prefixes, shape) ? prefixes[shape] : undefined;
    if (!prefix) throw new TypeError(`Node ${name} has shape ${shape}; pass convex, box or sphere`);
    const number = counts.get(base) ?? 0;
    counts.set(base, number + 1);
    return [{ node: name, importName: `${prefix}_${base}_${String(number).padStart(2, '0')}`, mesh: base }];
  });
}

/**
 * A scene's UV clips as flipbook parameters, one per clip and material. Unreal's graph steps a regular grid at one rate.
 * @throws TypeError for a channel that is not a STEP base-color offset or scale; RangeError for cels of unequal times or
 * sizes or off a regular grid, naming the fix.
 */
export function unrealFlipbooks(scene: ExportScene): UnrealFlipbook[] {
  return uvClips(scene).map(({ clip, materialName, keys }) => {
    const refuse = (why: string): never => {
      throw new RangeError(`UV clip ${clip} on ${materialName} ${why}; lay the cels out as a regular grid at one rate`);
    };
    if (keys.length < 2) refuse('has one cel');
    const interval = keys[1].time - keys[0].time,
      [scaleX, scaleY] = keys[0].scale,
      [startX, startY] = keys[0].offset;
    if (!keys.every((key, i) => close(key.time - keys[0].time, i * interval))) refuse('has cels of unequal times');
    if (!keys.every(({ scale }) => close(scale[0], scaleX) && close(scale[1], scaleY)))
      refuse('has cels of unequal sizes');
    // The first row runs until the offset leaves it; every later cel must land on that grid in reading order.
    let columns = keys.findIndex(({ offset }) => !close(offset[1], startY));
    if (columns < 0) columns = keys.length;
    const stepX = columns > 1 ? keys[1].offset[0] - startX : 0,
      stepY = columns < keys.length ? keys[columns].offset[1] - startY : 0;
    keys.forEach(({ offset }, i) => {
      if (
        !close(offset[0], startX + (i % columns) * stepX) ||
        !close(offset[1], startY + Math.floor(i / columns) * stepY)
      )
        refuse('steps off a grid');
    });
    return {
      clip,
      material: materialName,
      fps: +(1 / interval).toFixed(6),
      frames: keys.length,
      columns,
      scale: [scaleX, scaleY],
      origin: [startX, startY],
      step: [stepX, stepY],
    };
  });
}

/**
 * Python for the Unreal editor, run after importing the file: it sets complex-as-simple collision on every `-col` mesh and
 * builds one Material per UV clip, a Time, Fmod and Floor graph that steps a cel grid on the base color (no Flipbook
 * function asset needed). Assign each `M_<clip>_<material>` to its mesh; set `BaseTexture` on the Material.
 * @example
 * ```ts
 * import {createUnrealImportScript} from 'margoengine/exporters/unreal-import';
 * const python: string = createUnrealImportScript({nodes: []}, {contentPath: '/Game/Hero'});
 * ```
 * @param contentPath The content folder the file was imported into. Default `/Game/Imported`.
 * @throws TypeError or RangeError as {@link unrealCollisionNames} and {@link unrealFlipbooks}, and for a path outside `/`.
 */
export function createUnrealImportScript(
  scene: ExportScene,
  { contentPath = '/Game/Imported' }: { contentPath?: string } = {},
): string {
  if (!/^\/[\w/]+$/.test(contentPath))
    throw new RangeError(`Unreal content path ${contentPath} is invalid; pass a path like /Game/Imported`);
  unrealCollisionNames(scene);
  const complex = collisionNodes(scene)
      .filter((node) => !node.convex && node.visible)
      .map((node) => node.base),
    flipbooks = unrealFlipbooks(scene);
  return `import unreal

CONTENT = ${py(contentPath)}
COMPLEX_MESHES = ${JSON.stringify(complex)}
FLIPBOOKS = ${JSON.stringify(flipbooks)}


def set_complex_collision(name):
    path = CONTENT + "/" + name
    mesh = unreal.EditorAssetLibrary.load_asset(path)
    if mesh is None:
        raise RuntimeError("Static mesh " + path + " is missing; import the file into " + CONTENT + " first")
    setup = mesh.get_editor_property("body_setup")
    setup.set_editor_property("collision_trace_flag", unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE)
    unreal.EditorAssetLibrary.save_loaded_asset(mesh)


def build_flipbook(book):
    lib = unreal.MaterialEditingLibrary
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    name = "M_" + book["clip"] + "_" + book["material"]
    material = tools.create_asset(name, CONTENT, unreal.Material, unreal.MaterialFactoryNew())

    def node(kind):
        return lib.create_material_expression(material, kind)

    def const(value):
        out = node(unreal.MaterialExpressionConstant)
        out.set_editor_property("r", value)
        return out

    def binary(kind, a, b):
        out = node(kind)
        lib.connect_material_expressions(a, "", out, "A")
        lib.connect_material_expressions(b, "", out, "B")
        return out

    def vector(x, y):
        out = node(unreal.MaterialExpressionConstant2Vector)
        out.set_editor_property("r", x)
        out.set_editor_property("g", y)
        return out

    add = unreal.MaterialExpressionAdd
    multiply = unreal.MaterialExpressionMultiply
    fmod = unreal.MaterialExpressionFmod
    divide = unreal.MaterialExpressionDivide
    floor = unreal.MaterialExpressionFloor
    time = node(unreal.MaterialExpressionTime)
    frames = const(float(book["frames"]))
    columns = const(float(book["columns"]))
    index = node(floor)
    lib.connect_material_expressions(binary(fmod, binary(multiply, time, const(book["fps"])), frames), "", index, "")
    column = binary(fmod, index, columns)
    row = node(floor)
    lib.connect_material_expressions(binary(divide, index, columns), "", row, "")
    append = node(unreal.MaterialExpressionAppendVector)
    lib.connect_material_expressions(column, "", append, "A")
    lib.connect_material_expressions(row, "", append, "B")
    step = binary(multiply, append, vector(*book["step"]))
    uvs = node(unreal.MaterialExpressionTextureCoordinate)
    scaled = binary(multiply, uvs, vector(*book["scale"]))
    coordinates = binary(add, binary(add, scaled, vector(*book["origin"])), step)
    texture = node(unreal.MaterialExpressionTextureSampleParameter2D)
    texture.set_editor_property("parameter_name", "BaseTexture")
    lib.connect_material_expressions(coordinates, "", texture, "UVs")
    lib.connect_material_property(texture, "RGB", unreal.MaterialProperty.MP_BASE_COLOR)
    lib.recompile_material(material)
    unreal.EditorAssetLibrary.save_loaded_asset(material)


for mesh_name in COMPLEX_MESHES:
    set_complex_collision(mesh_name)
for flipbook in FLIPBOOKS:
    build_flipbook(flipbook)
unreal.log("Margo import: " + str(len(COMPLEX_MESHES)) + " complex meshes, " + str(len(FLIPBOOKS)) + " flipbook materials")
`;
}
