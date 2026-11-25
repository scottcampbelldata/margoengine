import { Geometry, PbrMaterial, type EngineKernel, type EnginePlugin, type Mesh } from '@margoengine/core';
import { generateTreeMesh, type TreeMeshShapeOptions } from './foliage.js';
import { fault } from '../../shared/errors.js';

/**
 * Single-call tree placement; geometry detail defaults to 2, and a conifer's tiers are branch whorls by default
 * (`branches`, {@link TreeMeshShapeOptions}): a placed tree is often seen up close. Within `shootDistance` of the
 * camera a conifer's sprays show their shoots and needle fringes (`shoots`); beyond it, the same branches coarse
 * (`shoots: 'coarse'`), which cover as much of the crown and carry the same snow, so a tree does not change as it
 * switches.
 */
export interface TreeOptions extends TreeMeshShapeOptions {
  /** Root XYZ in metres, finite float32 coordinates. Default [0,0,0]. */
  position?: readonly [number, number, number];
  /**
   * Height of the tree's top above its root in metres, 0.1 to 200: the whole tree scales evenly to it (the root's
   * scale). Default the mesh's own, about 7.6 m for a conifer and 8.4 m for a broadleaf.
   */
  height?: number;
  /**
   * Conifer with `branches`, detail 1 and 2: the distance in metres from `engine.camera` to the root's position within
   * which the canopy shows its shoots (a twig axis, lateral shoots and serrated needle fringes with the sky between
   * them) and beyond which it shows them coarse (`shoots: 'coarse'`), a fraction of the triangles, covering the same
   * share of the crown with the same normals, so the same colour and snow. A shoot 8 cm wide spans 2 pixels at 30 m in
   * a 1080-pixel, 60 degree view. 0 always shows the coarse level, Infinity the shoots; `shoots: true` means Infinity,
   * `shoots: 'coarse'` 0, and `shoots: false` the plain solid sprays at every distance. The level is picked at creation
   * and before each frame of the scene the tree was made in, with 10 percent hysteresis. Default 30.
   */
  shootDistance?: number;
  /**
   * The stem's diameter at breast height (1.3 m) of the placed tree in metres, 0.005 to 3: the trunk is scaled across
   * to it and keeps its taper and flare. Default for a conifer {@link spruceDiameter} of its height (0.078 m for the
   * 7.6 m default tree); a broadleaf keeps its mesh trunk unless this is set.
   */
  diameter?: number;
  /** Borrowed material; default brown, roughness 0.9. */
  trunkMaterial?: PbrMaterial;
  /**
   * Borrowed material. Default for a broadleaf green, roughness 0.85; for a conifer {@link CONIFER_NEEDLES}, roughness
   * 0.75. Both double sided.
   */
  canopyMaterial?: PbrMaterial;
}

/**
 * A spruce or pine crown's colour, linear sRGB: measured needle reflectance (Norway spruce and Scots pine, about 0.09
 * at 550 nm, 0.045 red, 0.04 blue, with transmittance 0.05, 0.01 and 0.005; Lukes, Stenberg, Rautiainen, Mottus and
 * Vanhatalo 2013, Remote Sensing Letters 4(7)) lowered by the light a shoot's needles trade among themselves before it
 * leaves: reflectance times (1 - p) / (1 - p w), with w the needle's albedo and p = 0.47 the shoot's recollision
 * probability (Smolander and Stenberg 2003 and 2005, Remote Sensing of Environment 88 and 94). Albedo about 0.044.
 */
export const CONIFER_NEEDLES: readonly [number, number, number] = [0.0245, 0.051, 0.0215];
/**
 * A spruce's butt flare, its stem diameter at the ground over its diameter at breast height (1.3 m), and the `flare`
 * `createTree` gives a conifer: 1.25 + 2 / d (d the breast-height diameter in cm), 1.30 to 1.45 for 40 to 10 cm
 * stems, at a stump 1 percent of the height up in Finnish pine and spruce (the approximation 2 + 1.25 d of Laasasenaho
 * 1982, as Repola 2009 uses it, Silva Fennica 43(4));
 * 1.10 to 1.20 inside the bark at a 1 ft stump of northeastern spruce and fir (Wharton 1984, USDA Forest Service
 * Research Note NE-322, d.b.h. = 0.966 + 0.797 stump diameter, 337 trees). 1.3 is the middle of that range.
 */
export const SPRUCE_FLARE = 1.3;
/**
 * Näslund's height curve for Norway spruce, h = 1.3 + d^3 / (a + b d)^3 (h in metres, d the breast-height diameter in
 * cm), with the mean parameters of 64 southern Finnish spruce stands, a = 1.811 and b = 0.308 (Näslund 1936; Siipilehto
 * 2000, Silva Fennica 34(4), Fig. 2). It gives 7.2 cm at 7.0 m and 8.4 cm at 7.8 m; 34 measured 20-year-old Czech spruces
 * averaged 7.0 ± 0.2 m and 8.4 ± 0.4 cm (Pokorný and Tomášková 2007, Journal of Forest Science 53(12)).
 */
export const SPRUCE_HEIGHT_CURVE: { readonly a: number; readonly b: number } = { a: 1.811, b: 0.308 };
/**
 * A Norway spruce's breast-height diameter in metres for its height in metres, from {@link SPRUCE_HEIGHT_CURVE}
 * inverted: d = a x / (1 - b x), x = (h - 1.3)^(1/3). The curve holds for the fitted stands' heights, 2 to 25 m; below
 * 2 m and above 25 m the diameter is taken in proportion to the height from the curve's ends.
 * @throws RangeError when `height` is not a finite number above 0.
 */
export function spruceDiameter(height: number): number {
  if (!(typeof height === 'number' && height > 0 && height < Infinity))
    throw new RangeError('Invalid tree height; pass a number of metres above 0.');
  const { a, b } = SPRUCE_HEIGHT_CURVE,
    h = Math.min(25, Math.max(2, height)),
    x = Math.cbrt(h - 1.3);
  return (((a * x) / (1 - b * x)) * height) / h / 100;
}
/** One placed tree with both parts. Dispose this object to remove all three meshes. */
export interface PlacedTree {
  readonly root: Mesh;
  readonly trunk: Mesh;
  readonly canopy: Mesh;
  dispose(): void;
  [Symbol.dispose](): void;
}

interface TreePart {
  geometry: Geometry;
  /** The whole tree mesh's top in mesh metres. */
  top: number;
}
// One geometry per engine, shape and part, shared by every tree of that shape: a forest of one kind holds one copy of
// its vertices, and core draws the meshes of one geometry as one instanced batch.
const shapes = new WeakMap<EngineKernel, Map<string, TreePart>>();
function shape(
  engine: EngineKernel,
  kind: 'conifer' | 'broadleaf',
  options: TreeMeshShapeOptions,
  part: 'trunk' | 'canopy',
): TreePart {
  const key = `${part} ${kind} ${options.detail} ${options.branches} ${options.shoots} ${options.flare} ${options.breastHeight} ${options.breastDiameter}`;
  let byKey = shapes.get(engine);
  if (!byKey) shapes.set(engine, (byKey = new Map()));
  let found = byKey.get(key);
  if (!found) {
    const data = generateTreeMesh(kind, options),
      { positions, normals, indices } = data[part];
    let top = 0;
    for (const each of [data.trunk, data.canopy])
      for (let i = 1; i < each.positions.length; i += 3) top = Math.max(top, each.positions[i]);
    found = { geometry: new Geometry(positions, normals, indices), top };
    byKey.set(key, found);
  }
  return found;
}

interface Switching {
  root: Mesh;
  canopy: Mesh;
  far: Geometry;
  near: () => Geometry;
  distance: number;
  shown: boolean;
}
const PLUGIN = 'procedural:tree-shoots';
// The shooting trees of each scene, keyed by that scene's lighting object: `engine.lighting` is the lighting of the
// scene being set up, and EngineKernel names that scene no other way.
const switches = new WeakMap<object, Switching[]>();
function pick(engine: EngineKernel, tree: Switching): void {
  const [x, y, z] = engine.camera.position,
    p = tree.root.position,
    reach = tree.shown ? tree.distance * 1.1 : tree.distance,
    near = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2 < reach * reach;
  if (near === tree.shown) return;
  tree.shown = near;
  tree.canopy.setGeometry(near ? tree.near() : tree.far);
}
function watch(engine: EngineKernel, tree: Switching): () => void {
  const scene = engine.lighting;
  let list = switches.get(scene);
  if (!list || !engine.hasPlugin(PLUGIN)) {
    const own: Switching[] = [],
      step = (each: Switching) => pick(engine, each);
    switches.set(scene, (list = own));
    engine.use({
      name: PLUGIN,
      setup() {},
      // One distance test a tree a frame; only a tree whose level changes touches its mesh.
      onPreUpdate() {
        own.forEach(step);
      },
      dispose() {
        own.length = 0;
      },
    } satisfies EnginePlugin);
  }
  const own = list;
  own.push(tree);
  return () => {
    const at = own.indexOf(tree);
    if (at >= 0) own.splice(at, 1);
  };
}

/** Creates a rooted trunk and canopy together. Moving the root moves the complete tree. */
export function createTree(engine: EngineKernel, kind: 'conifer' | 'broadleaf', options: TreeOptions = {}): PlacedTree {
  const position = options.position ?? [0, 0, 0];
  if (position.length !== 3 || !Array.from(position).every((v) => Number.isFinite(Math.fround(v))))
    throw fault('failed', 'Tree position needs three finite float32 coordinates', 'procedural');
  for (const material of [options.trunkMaterial, options.canopyMaterial])
    if (material !== undefined && !(material instanceof PbrMaterial))
      throw fault('failed', 'Tree materials must be PbrMaterial instances', 'procedural');
  const height = options.height;
  if (height !== undefined && !(typeof height === 'number' && height >= 0.1 && height <= 200))
    throw fault('failed', 'Tree height must be a number of metres from 0.1 to 200', 'procedural');
  const flare = options.flare;
  if (flare !== undefined && !(typeof flare === 'number' && flare >= 1 && flare <= 2.5))
    throw fault('failed', 'Tree flare must be a ratio from 1 to 2.5', 'procedural');
  const diameter = options.diameter;
  if (diameter !== undefined && !(typeof diameter === 'number' && diameter >= 0.005 && diameter <= 3))
    throw fault('failed', 'Tree diameter must be a number of metres from 0.005 to 3', 'procedural');
  const shoots = options.shoots;
  if (shoots !== undefined && shoots !== true && shoots !== false && shoots !== 'coarse')
    throw fault('failed', "Tree shoots must be true, false or 'coarse'", 'procedural');
  const reach = options.shootDistance;
  if (reach !== undefined && !(typeof reach === 'number' && reach >= 0))
    throw fault('failed', 'Tree shootDistance must be 0 metres or more', 'procedural');
  const branches = options.branches ?? kind === 'conifer',
    detail = options.detail ?? 2,
    switching = kind === 'conifer' && branches && detail > 0 && shoots !== false,
    distance = !switching || shoots === 'coarse' ? 0 : shoots === true ? Infinity : (reach ?? 30),
    common = { detail, branches, flare: flare ?? (kind === 'conifer' ? SPRUCE_FLARE : undefined) },
    plain = shape(engine, kind, { ...common, shoots: switching ? ('coarse' as const) : false }, 'canopy'),
    near = () => shape(engine, kind, { ...common, shoots: true }, 'canopy').geometry,
    created: Mesh[] = [];
  try {
    const root = engine.createMesh();
    created.push(root);
    root.setPosition(position);
    // Both levels stay inside the plain sprays' outline and share the leader, so one scale holds at both.
    const scale = height === undefined ? 1 : height / plain.top;
    if (height !== undefined) root.setScale([scale, scale, scale]);
    // The flare is measured at 1.3 m of the placed tree; trunks are shared by trees within a centimetre of that.
    const breastHeight =
        common.flare === undefined ? undefined : Math.min(6, Math.max(0.3, Math.round(130 / scale) / 100)),
      // The stem for the tree's height, in mesh metres to a millimetre, so trees of about one size share a trunk.
      stem = diameter ?? (kind === 'conifer' ? spruceDiameter(plain.top * scale) : undefined),
      breastDiameter =
        stem === undefined ? undefined : Math.min(3, Math.max(0.005, Math.round((stem / scale) * 1000) / 1000));
    const trunk = engine.createMesh(root);
    created.push(trunk);
    trunk
      .setGeometry(shape(engine, kind, { ...common, shoots: false, breastHeight, breastDiameter }, 'trunk').geometry)
      .setMaterial(options.trunkMaterial ?? new PbrMaterial({ color: '#68462e', roughness: 0.9 }));
    const canopy = engine.createMesh(root);
    created.push(canopy);
    canopy
      .setGeometry(distance === Infinity ? near() : plain.geometry)
      .setMaterial(
        options.canopyMaterial ??
          (kind === 'conifer'
            ? new PbrMaterial({ color: [...CONIFER_NEEDLES], roughness: 0.75 })
            : new PbrMaterial({ color: '#4c7434', roughness: 0.85 })),
      );
    let unwatch = () => {};
    if (distance > 0 && distance < Infinity) {
      const tree: Switching = { root, canopy, far: plain.geometry, near, distance, shown: false };
      pick(engine, tree);
      unwatch = watch(engine, tree);
    }
    return {
      root,
      trunk,
      canopy,
      dispose() {
        unwatch();
        for (let i = created.length - 1; i >= 0; i--) created[i].dispose();
      },
      [Symbol.dispose]() {
        this.dispose();
      },
    };
  } catch (error) {
    for (let i = created.length - 1; i >= 0; i--) created[i].dispose();
    throw error;
  }
}
