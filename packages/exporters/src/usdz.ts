import {
  collect,
  determinant3,
  drawables,
  normalizeMaterial,
  type Drawable,
  type ExportSource,
  type Geo,
  type Mat,
} from './scene.js';
import {
  boxSize,
  checkPlacement,
  emptyBox,
  growBoxWith,
  meshPrim,
  placedBox,
  placementOf,
  reflected,
  rootTransform,
  shapeOf,
  storedZIP,
  tuple,
  USDMaterials,
  type Shape,
  type USDZBox,
  type USDZOptions,
} from './usdz-write.js';

export type { USDZBox, USDZOptions } from './usdz-write.js';

/** What {@link measureUSDZ} returns. */
export interface USDZMeasure {
  /** Width, height and depth in metres: what AR Quick Look shows, as it draws a file at real size. */
  size: [number, number, number];
  /** Where the model sits in metres. */
  bounds: USDZBox;
  /** The even scale `height` asked for; 1 without it. */
  scale: number;
}

/** The world box of what `items` draw. */
function worldBox(items: readonly Drawable[]): USDZBox {
  const box = emptyBox();
  for (const { geometry, world } of items) growBoxWith(box, geometry.positions, world);
  return box;
}

/**
 * The size {@link exportUSDZ} writes the same source and options at, so a caller can see a 79 metre fox before it reaches a
 * phone.
 *
 * @example
 * ```ts
 * import { exportUSDZ, measureUSDZ } from '@margoengine/exporters/usdz';
 * import type { ExportSource } from '@margoengine/exporters';
 *
 * declare const scene: ExportSource;
 * const [, height] = measureUSDZ(scene).size;
 * const usdz = exportUSDZ(scene, height > 3 ? { height: 1.7, ground: true } : {});
 * ```
 *
 * @throws RangeError for an empty scene or a bad `height`; TypeError for a bad `ground`.
 */
export function measureUSDZ(source: ExportSource, options: USDZOptions = {}): USDZMeasure {
  checkPlacement(options);
  const items = drawables(collect(source, options));
  if (!items.length) throw new RangeError('USDZ requires at least one mesh');
  const rest = worldBox(items),
    placement = placementOf(rest, options),
    bounds = placedBox(rest, placement);
  return { size: boxSize(bounds), bounds, scale: placement.scale };
}

/**
 * The shape each node draws. A node with a reflection in its matrix draws the geometry's reflected shape through
 * {@link unreflected}, so every matrix in the file keeps a positive determinant, the winding is right in the file and
 * nothing depends on how a renderer treats a negative scale. Nodes that mirror one geometry share that shape too.
 */
function localShapes(items: readonly Drawable[], fallback: Mat, materials: USDMaterials): Map<Drawable, Shape> {
  const plain = new Map<Geo, Shape>(),
    mirrored = new Map<Geo, Shape>(),
    drawn = new Map<Drawable, Shape>();
  for (const item of items) {
    const { geometry, material = fallback, world } = item,
      determinant = determinant3(world);
    if (!determinant || !Number.isFinite(determinant))
      throw new RangeError('Singular transform; use a transform with a non-zero determinant');
    const known = determinant > 0 ? plain : mirrored;
    let shape = known.get(geometry);
    if (!shape) {
      shape = determinant > 0 ? shapeOf(geometry.positions, geometry.normals, geometry.indices) : reflected(geometry);
      known.set(geometry, shape);
    }
    shape.users++;
    materials.note(shape, material);
    drawn.set(item, shape);
  }
  return drawn;
}

/** `world` with its first axis negated: applied to a reflected shape it puts every vertex where `world` puts the geometry's. */
const unreflected = (world: Float64Array): Float64Array => world.map((v, i) => (i < 3 ? -v : v));

const OUTSIDE_FLOAT32 =
  'USDZ world position exceeds Float32 range; move the model closer to the origin or lower its scale';

/**
 * Static USD meshes with UsdPreviewSurface materials in a stored, 64-byte-aligned USDZ archive. Every mesh is written in
 * its own space, with the node's world matrix as `xformOp:transform`. A geometry drawn by several nodes is written once,
 * as a `class` prim each node's Mesh references. A node with a reflection in its matrix draws a reflected shape, written
 * once for the nodes that mirror that geometry, with the reflection taken out of its matrix. A material shared by several
 * nodes is written once.
 *
 * Material textures (`TextureData`, as the glTF writers take them) become `UsdUVTexture` readers of the mesh's
 * `primvars:st` (from `uvs`, V flipped) or `primvars:st1` (from `uvs1`): base color into `diffuseColor` scaled by the
 * color factor (its alpha into `opacity` for BLEND and MASK, with `opacityThreshold` set to `alphaCutoff` for MASK),
 * metal-rough green and blue into `roughness` and `metallic`, `normal`, `occlusion` red and `emissiveColor`. The images
 * are stored as given (PNG or JPEG) under `texturePrefix`. A `baseColorTextureTransform` becomes a `UsdTransform2d`
 * that samples the same texels as the glTF transform: its rotation in degrees with the same sign (the V flip turns
 * glTF's counter-clockwise-with-v-down into USD's counter-clockwise-with-t-up), the translation re-expressed in st.
 * @throws TypeError when a textured material's geometry lacks the UV set it samples, or when vertex colors meet a
 * base color texture (USD Preview Surface cannot multiply them); RangeError for an empty scene, a world position
 * outside Float32 range, a bad `height` or an archive over 4 GiB.
 *
 * AR Quick Look shows the file at real size. `height` sets that size in metres and `ground` stands the model on the floor,
 * both through one transform on the root prim; {@link measureUSDZ} says what size the file will be.
 */
export function exportUSDZ(source: ExportSource, options: USDZOptions = {}): Uint8Array {
  checkPlacement(options);
  const items = drawables(collect(source, options));
  if (!items.length) throw new RangeError('USDZ requires at least one mesh');
  const placement =
      options.height === undefined && !options.ground ? { scale: 1, lift: 0 } : placementOf(worldBox(items), options),
    materials = new USDMaterials(options.texturePrefix),
    fallback = normalizeMaterial({}),
    shapes = localShapes(items, fallback, materials);
  const lines = [
    '#usda 1.0',
    '(',
    '    defaultPrim = "Margo"',
    '    metersPerUnit = 1',
    '    upAxis = "Y"',
    ')',
    'def Xform "Margo" {',
    ...rootTransform(placement),
  ];
  for (let i = 0; i < items.length; i++) {
    const item = items[i],
      { geometry } = item,
      world = determinant3(item.world) > 0 ? item.world : unreflected(item.world),
      material = item.material ?? fallback,
      shape = shapes.get(item)!,
      bound = materials.bind(i, geometry, material);
    // The world position of every vertex lies inside the world box of the local bounds' corners.
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? shape.max[0] : shape.min[0],
        y = corner & 2 ? shape.max[1] : shape.min[1],
        z = corner & 4 ? shape.max[2] : shape.min[2];
      for (let r = 0; r < 3; r++)
        if (!Number.isFinite(Math.fround(world[r] * x + world[4 + r] * y + world[8 + r] * z + world[12 + r])))
          throw new RangeError(OUTSIDE_FLOAT32);
    }
    const row = (at: number): string => tuple([world[at], world[at + 1], world[at + 2], world[at + 3]]),
      transform = [
        `    matrix4d xformOp:transform = (${row(0)}, ${row(4)}, ${row(8)}, ${row(12)})`,
        '    uniform token[] xformOpOrder = ["xformOp:transform"]',
      ];
    meshPrim(lines, lines, i, item.name, geometry, shape, bound, { transform });
  }
  lines.push('}');
  const content = new TextEncoder().encode(lines.join('\n') + '\n');
  return storedZIP([['scene.usda', content], ...materials.files]);
}
