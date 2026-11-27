# @margoengine/procedural

## Coral colonies (`margoengine/procedural/coral`)

`coralGeometry` returns closed, seeded Y-up geometry with a flat attachment at Y = 0, projected UVs and outward
normals. Use the branching, table or brain forms across the reef. The diameter parameter scales in metres, and
`resolution` controls the number of samples along the longest axis (default 100, range 48–128). Cache colonies by
form, seed and resolution when placing them in a scene. Choose fewer samples for distant colonies and a higher
resolution for close-ups where the surface grooves matter.

```ts
import { coralGeometry } from 'margoengine/procedural/coral';
const colony = coralGeometry({ form: 'branching', seed: 8, diameter: 0.65, resolution: 76 });
console.log(colony.indices.length / 3);
```

The branched forms use tapered, smoothly joined growing tips and small-scale surface relief. The massive form
cuts an irregular field of grooves into a basal dome. These are procedural approximations of growth forms.
References for crown, plate and groove morphology are [Kaandorp et al., Morphogenesis of the Branching Reef
Coral Madracis mirabilis (2005)](https://pmc.ncbi.nlm.nih.gov/articles/PMC1634949/), [Kaandorp et al.,
Macroscopic Modelling of Environmental Influence on Growth and Form of Sponges and Corals Using the Accretive
Growth Model (2013)](https://doi.org/10.1155/2013/159170) and the [Smithsonian 3D coral collection](https://3d.si.edu/corals/).

Procedural cabins, foliage, grass, humanoids, Marching Cubes surfaces, seeded 2D/3D/4D noise, L-systems, Voronoi fracture and a bounded voxel expression language.

Import `margoengine/procedural` from the `margoengine` package, or `@margoengine/procedural` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

For minimum-spaced placement, import the optional [`/poisson` entry](#poisson-disk-placement).

`generateCabinMesh(height, position = [0,0])` builds a 6 × 8 m timber cabin,
35° roof, recessed windows/door and terrain-sunk stone/porch supports. `position`
is the world XZ origin used for terrain sampling. It returns `floorElevation` (world Y) and `parts` containing `siding`,
`roof`, `foundation` and `glass` geometry. Every value in `parts` is geometry;
geometry remains local to that origin and floor. The old scalar `floor` field and
flat part fields are replaced by this explicit placement/parts contract.
Supply your own PBR materials and instance transform. Every terrain sample is
validated, and split architectural normals and UV-derived tangents are preserved.
Plank seams are closed, exterior window/door casings sit flush with the siding,
corner trim stands clear and overlapping roof courses have separate depth planes,
avoiding pinholes, fragmented thin edges and z-fighting. Solid gables meet the
siding faces and overlap the roof underside, closing the joint from elevated and
oblique views at both ends. Hidden
plank caps are omitted; trim closes the wall skin. Enterable cabin interiors would
need dedicated wall returns.
Porch post heights and the pitched crossbeam derive from the canopy underside,
keeping the supports below the roof while their bases follow terrain.

```ts
import { Engine, Geometry } from '@margoengine/core';
import { generateCabinMesh } from '@margoengine/procedural';
const engine = await Engine.create(document.querySelector('canvas')!);
const position = [10, 20] as const;
const cabin = generateCabinMesh(() => 2, position);
for (const data of Object.values(cabin.parts)) {
  engine.createMesh().setGeometry(new Geometry(data.positions, data.normals, data.indices))
    .setPosition([position[0], cabin.floorElevation, position[1]]);
}
engine.dispose();
```

`generateLogWall({ courses, diameter = 0.3, bottom = diameter / 2, openings = [], segments = 14, sill = true })` builds a log
wall as one geometry: round logs along local X, stacked one diameter apart from `bottom` (the centre of the first
course), Z the wall's thickness. `courses` lists each course's `[start, end]`, bottom first; an empty course (`[0, 0]`)
ends a gable early. `openings` are `[x0, x1, y0, y1]` rectangles cut out exactly (a door's sill is `-Infinity`):
a log wholly inside one is cut away, and a log the opening's top or bottom edge crosses keeps the part outside it,
notched flat along the edge, so a door 2.15 m high in 0.3 m courses opens to 2.15 m, not to the 2.4 m top of the log
it cuts into. Openings must not overlap. Chinking runs along every course line where both logs exist: a faceted log's flat sits
`r (1 - cos(pi / segments))` inside its circle, so bare stacked logs leave a slit straight through the wall (0.75 cm
for 0.3 m logs of 14 segments), which showed the sky as one-pixel lines. The chinking, the strip log builders pack
between courses (B. D. Bomberger, "The Preservation and Repair of Historic Log Buildings", NPS Preservation Brief 26,
1991), lies inside the logs' inscribed circles, so it fills the slit and is hidden everywhere else. Pieces shorter
than a tenth of the diameter are dropped. A wall standing on the ground (its bottom course less than a diameter up) is
closed down to y = 0 by default: notched corners set two of a cabin's four walls half a log higher, and builders
start those walls on a sill log hewn flat underneath, the half-log starter course (B. A. Mackie, "Building with Logs",
1971; sill logs on the foundation in Bomberger 1991), so `generateLogWall` puts one under the bottom course, cut at
y = 0 and chinked to the course above, and chinks a bottom course that rests on y = 0 to the ground under its facets.
Without it the room's light showed on the snow under Cabin Hearth's side walls. `sill: false` leaves the gap for a
foundation built up to the bottom course (stone piers or a raised foundation); a wall a diameter or more up, such as a
gable set on another wall, never gets a sill.

```ts
import { Engine, Geometry } from '@margoengine/core';
import { generateLogWall } from '@margoengine/procedural';
const engine = await Engine.create(document.querySelector('canvas')!);
// A 6 m wall of nine 0.3 m courses with a window and a door, and a gable that shortens toward the ridge.
const front = generateLogWall({
  courses: Array.from({ length: 9 }, () => [-3.25, 3.25] as const),
  openings: [
    [0.6, 1.8, 0.95, 2.05],
    [-2.1, -1.1, -Infinity, 2.15],
  ],
});
const gable = generateLogWall({ courses: [[-2.75, 2.75], [-2.2, 2.2], [-1.6, 1.6], [0, 0]], bottom: 2.85 });
// A side wall half a log up, notched over the front wall's corners: it stands on a sill log hewn flat at y = 0.
const side = generateLogWall({ courses: Array.from({ length: 9 }, () => [-2.75, 2.75] as const), bottom: 0.3 });
for (const data of [front, gable, side])
  engine.createMesh().setGeometry(new Geometry(data.positions, data.normals, data.indices));
engine.dispose();
```

`generateWindowPane({ width, height, thickness = 0.004, glazing = 'clear', frost = 1, lites = [1, 1], barWidth = 0.03, barDepth = 0.035 })`
builds a window's glass and its glazing bars, centred on the origin with its outdoor face toward +Z: `clear` and
`frosted` geometry, `bars` and `frostedShare`, the frosted share of the glass's area. `lites` divides the pane into
`lites[0] x lites[1]` panes of glass with glazing bars (muntins), `barWidth` wide and `barDepth` deep, in the glass's
plane: the glass stops at them, so from outside they read as dark bars against backlit frost, and from inside they
shade the frost behind them. The bars are one mesh with no overlaps (the columns run the full height, the rows between
them); give them the sash's wood. `glazing: 'frosted'` is a pane frosted over on its room side, as a winter window is.
Frost forms where the glass is coldest, first at each lite's edges, where the frame and the bars carry heat out (the
edge-of-glass zone that NFRC 100 rates apart from the centre of glass), so `frost` (0 to 1) is how far it has grown in:
a border `frost x min(liteWidth, liteHeight) / 2` wide is frosted round a clear middle, and 1 frosts the whole lite.
Frost is ice, which scatters light and absorbs almost none (Warren and Brandt, J. Geophys. Res. 113, D14220, 2008), so
as a shadow caster the frosted part stops a lamp's beam, and its light leaves diffusely instead: `openingLight` and
`glazingSurface` (`@margoengine/clustered/area`, "Frosted glazing") take the same `glazing`, `frost`, `lites`,
`barWidth`, `barDepth` and `thickness` and give the window's light and the pane's two faces, brightest nearest the lamp.
The frosted geometry has two groups: 0, its outdoor face, and 1, its room face and edges; its UVs are the pane's (u from
the left edge, v down from the top), where `glazingSurface`'s `emissiveMap` lies.

```ts
import { generateWindowPane } from '@margoengine/procedural';
const pane = generateWindowPane({ width: 1.2, height: 1.1, glazing: 'frosted' });
console.log(pane.frostedShare, pane.frosted.groups?.length); // 1 2: frosted over
const edges = generateWindowPane({ width: 1.2, height: 1.1, glazing: 'frosted', frost: 0.4 });
console.log(edges.frostedShare.toFixed(2)); // 0.62: a frosted border, the middle still clear
const cross = generateWindowPane({ width: 1.2, height: 1.1, glazing: 'frosted', lites: [2, 2], barWidth: 0.045, barDepth: 0.05 });
console.log(cross.bars.indices.length / 36); // 3: a column and the two halves of the row, 12 triangles each
```

`createIslandHeight(seed = 731)` returns the coastal island preset's world-height
sampler. `generateGrassMesh(blades = 3)` returns crossed, tapered grass ribbons;
use 3/2/1 blades for scatter LODs with a double-sided material. Lower LODs remove
blades from the same ordered set, preserving the positions, normals, UVs and
tangents of surviving blades. Both are shared implementations used by the sandbox.

`createHumanoid(engine, [bodyMaterial, trimMaterial, visorMaterial])` creates a
jointed primitive rig and returns `root`, `focus`, `joints`, `knees` and `parts`.
Register `parts` with your shadow module. `poseHumanoid(rig, position, heading,
phase, speed)` writes a walk pose into the existing transforms in place.
The sandbox supplies phase/speed from the shared controls module.

`generateRockMesh(seed = 1, form?)` builds a 180-triangle fieldstone centered at the origin, +Y up. It uses broad
fracture faces, clipped corners and fine weathering. Choose `block`, `slab`, `wedge`, `shard` or `pebble`, or omit
the form to let the unsigned 32-bit seed select it. The default seed selects a block. The same seed and form give
the same positions, averaged normals, UV seams and tangent frames. Rotate and instance a few seeded meshes for
scatter. For close-up stone shading use `@margoengine/terrain/rock-surface` with the rock type of the site.

```ts
import { generateRockMesh } from 'margoengine/procedural';
const fieldstones = [generateRockMesh(17, 'slab'), generateRockMesh(32, 'wedge'), generateRockMesh(53, 'block')];
```

The overall form, edge rounding and surface texture are separate shape properties in the [Geological Survey of India
*Rock Texture Atlas*](https://gsi.gov.in/RockTextureAtlas/TexturesInSedimentaryRocks/).
The plane cuts and edge wear are a compact approximation informed by [A. Peytavie, E. Galin, J. Grosjean and S. Mérillou,
*Procedural Generation of Rock Piles using Aperiodic Tiling* (2009)](https://perso.liris.cnrs.fr/eric.galin/Articles/2009-aperiodic.pdf)
and [A. Paris, A. Peytavie, E. Guérin, J.-M. Dischler and E. Galin, *Modeling Rocky Scenery using Implicit Blocks*
(2020)](https://perso.liris.cnrs.fr/aparis/public_html/projects/paris2020_Blocks.html).

`generateFernMesh()` produces seven curved, tapered ribbon fronds; use a
double-sided material. Both return `GeometryData` and are deterministic.
For the biome presets there are more plants: `generatePalmMesh()`, `generateBirchMesh()`, `generateAcaciaMesh()` and
`generateSnagMesh()` (a dead standing tree, empty canopy) return `{ trunk, canopy }` like `generateTreeMesh`, and
`generateCactusMesh()`, `generateReedMesh(stems = 9)` (double sided) and `generateTundraShrubMesh()` return one
`GeometryData`; each is rooted at the origin, +Y up, in metres.
Mesh levels for distance: `generateTreeMesh(kind, options)`, `generateShrubMesh`, `generateTundraShrubMesh`,
`generatePalmMesh`, `generateBirchMesh` and `generateAcaciaMesh` take `{ detail: 0 | 1 | 2 }` (default 2, the full
mesh, unchanged byte for byte). Level 1 keeps the shape with coarser lobes (a broadleaf canopy goes from 6,240 to
3,180 triangles); level 0 merges lobes into a few coarse ones for the far rings (400 triangles).
Level 1 keeps each axis of the canopy box within 20 percent of level 2; level 0 is stretched to level 2's box (conifer,
broadleaf, palm, birch, acacia and shrub canopies, within 10 percent on every axis), so far trees keep their size. An
invalid level throws a `RangeError`.

```ts
import {generateTreeMesh} from 'margoengine/procedural';
const rings = ([2, 1, 0] as const).map((detail) => generateTreeMesh('broadleaf', {detail})); // near, middle, far
```

Beyond the last ring, `generateTreeStandIn(kind)` from `@margoengine/procedural/standin` gives a far tree of 14
triangles (`'broadleaf'`, `'conifer'` or `'palm'`; another kind throws a `RangeError`): an open three-sided trunk prism
and an eight-face crown with the height and canopy width of the full mesh, every triangle facing out, so a
single-sided material shows it whole from any side. Draw it through `Scatter` where a tree is a few pixels.

```ts
import {Geometry} from '@margoengine/core';
import {generateTreeStandIn} from '@margoengine/procedural/standin';
const far = generateTreeStandIn('conifer');
const geometry = new Geometry(far.positions, far.normals, far.indices); // 14 triangles
```

For a cove scene there are two waterfront props, each one `GeometryData` mesh with UVs, tangents and unit normals,
local origin at the water surface (y = 0), +Y up, in metres, deterministic by `seed` (an integer, default 1):

| Call | Options (defaults) | Triangles at `detail` 2 / 1 / 0 |
| --- | --- | --- |
| `generateJettyMesh(options?)` | `length` 4..120 (24), `width` 1..8 (2.2), `height` above the water 0.3..4 (1.1), `ladder` (true), `seed`, `detail` | 2,768 / 1,680 / 508 |
| `generateBoatMesh(options?)` | `length` 1.5..12 (3.6), `seats` 0..4 (3), `oars` (true), `seed`, `detail` | 1,884 / 812 / 372 |

The jetty runs along +X from the shore end at x = 0, with planks, stringers, posts and a ladder at the far end. The
boat is a rowing boat centred on the origin with its bow toward +X. A wrong type throws a `TypeError` and a value out of
range a `RangeError`; the message names the range to pass.

```ts
import {generateJettyMesh, generateBoatMesh} from 'margoengine/procedural';
const jetty = generateJettyMesh({length: 28, seed: 3}); // place it with its shore end on the beach
const boat = generateBoatMesh({seed: 7, oars: false}); // moor it beside the jetty, y = 0 is the waterline
```

`contactAO(y, groundY)` gives bounded ground-contact occlusion, and
`radialAO(x,y,z,center,radius)` shades enclosed canopy volumes. Use their output
with `pbrVertexStream()` from geometry to bake ambient occlusion into vertex alpha
at initialization. `ScatterInstances` applies it to ambient lighting; direct light
and material albedo remain independent.

Seeded 3D simplex, gradient Perlin and exact nearest-feature Worley noise, CPU Marching Cubes geometry, and standalone tree/shrub generators.

```ts
import {Noise, marchingCubes} from 'margoengine/procedural';
const noise = new Noise(123);
const geometry = marchingCubes((x,y,z) => x*x+y*y+z*z-0.5, {resolution: [32,32,32]});
```

### Metaballs

`Metaballs` is the live metaball object: add, move and remove balls, then call `geometry()` for the current surface.
Each ball pulls with the finite-support cubic of Wyvill, McPheeters and Wyvill (1986), exactly zero past its `radius`; a
negative `strength` carves. The surface sits where the summed pull equals `threshold` (default 0.5); the polygonizer is
`marchingCubes` below.

```ts
import {Metaballs} from 'margoengine/procedural';

const blobs = new Metaballs({resolution: [40, 40, 40], bounds: [[-2, -2, -2], [2, 2, 2]]});
const a = blobs.add([-0.4, 0, 0], {radius: 0.9});
blobs.add([0.4, 0, 0], {radius: 0.9});
a.position[0] += 0.1; // balls are plain objects you edit between calls
const geometry = blobs.geometry(); // Geometry | null
```

Surface extraction is the package's own Marching Cubes (Lorensen and Cline 1987; it replaced the `isosurface` dependency, and since 2026-11-16 the earlier marching tetrahedra): vertices lie on the grid's own axis edges, and each cube's polygons are traced on its faces, where a face whose corners alternate inside and outside is split by the asymptotic decider (Nielson and Hamann 1991), so both cubes on a face agree (the paper's own test: the corners below the level join when the saddle value lies below it, and a saddle value exactly at the level joins the upper pair) and the indexed mesh is closed wherever the surface stays inside the grid. With a density function each vertex is the function's own root on its edge (an Illinois regula falsi, Dowell and Jarratt 1971), so it lies on the exact surface to float32 precision; with a grid it is linear between the two samples. Tetrahedra put vertices on face and body diagonals too, up to 1.73 cells long, where linear interpolation of a curved field strays furthest: a 1 / d^2 metaball came out 1.229 times its radius at resolution 28, against 1.073 on cube edges and exact with the function. Negative density is inside; gradient normals and triangle winding face outward. A surface through a grid point (a sample at the level, or within float32 precision of it) gets one vertex on that point, shared by every edge from it, with no zero-area triangles (the corner snapping of Treece, Prager and Gee's regularised marching tetrahedra, 1998). Body ambiguities (Chernyaev 1995, Marching Cubes 33) are not resolved: a cube whose inside corners meet only through its interior gets the separated polygons. Empty surfaces return null. Resolution is 3..128 on each axis, with a bounded output geometry. Worley searches a sufficient five-cell neighborhood per axis for F1. Sampling/extraction are CPU work, not frame-time GPU voxel meshing.

For a surface that changes every frame (metaballs, sculpting), pass the samples instead of a function: a grid of
`resolution[0] * [1] * [2]` values, x fastest, then y, then z, sampled at the grid points of `bounds`. Writing each
blob only into the samples near it is far cheaper than a function that sums every blob at every grid point.

```ts
import {marchingCubes} from 'margoengine/procedural';
const n = 48, grid = new Float32Array(n * n * n).fill(1); // 1: outside
for (let z = 0, i = 0; z < n; z++)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++, i++) grid[i] = Math.hypot(x - 24, y - 24, z - 24) / 16 - 1; // a sphere
const sphere = marchingCubes(grid, {resolution: [n, n, n]}); // normals from the grid's gradient
```

`marchingCubes` is also its own entry, `@margoengine/procedural/marching-cubes`, for code that only polygonizes (the
cliffs and sea rocks of `@margoengine/terrain/rocks` use it): it loads none of the root's generators.

```ts
import {marchingCubes} from 'margoengine/procedural/marching-cubes';
const ball = marchingCubes((x, y, z) => Math.hypot(x, y, z) - 0.8, {resolution: [24, 24, 24]});
```

```ts
import {Engine, Geometry} from '@margoengine/core';
import {generateTreeMesh} from '@margoengine/procedural';
const engine = await Engine.create(document.querySelector('canvas')!);
const tree = generateTreeMesh('broadleaf');
for (const data of [tree.trunk, tree.canopy]) {
  engine.createMesh().setGeometry(new Geometry(data.positions, data.normals, data.indices))
    .setPosition([4, 0, 7]); // Both parts share this rooted transform.
}
engine.dispose();
```

For a complete tree in one call, import the optional `/tree` entry. `createTree`
creates a root plus both child meshes, with a brown trunk and a green canopy (a broadleaf) or the needles' measured
colour, `CONIFER_NEEDLES` (a conifer). Options: `position` defaults to [0,0,0], `detail` to 2, `height` (metres, 0.1
to 200) to the mesh's own, scaling the whole tree evenly; `branches` (conifer, default true here) builds each tier as
a whorl of drooping branch sprays; `shootDistance` (conifer with branches, metres, default 30) is how near the camera a
conifer must be for its sprays to show their shoots rather than the same shoots coarse, 0 always coarse and Infinity
always the shoots (`shoots: true` or `'coarse'` forces either, `false` the plain solid sprays); `diameter` (metres,
0.005 to 3) is the stem's diameter at breast height, default `spruceDiameter(height)` for a conifer and the mesh's
trunk for a broadleaf; `flare` (1 to 2.5) is the trunk's diameter at the ground over its diameter at breast height,
default `SPRUCE_FLARE` (1.3) for a conifer and the historical trunk for a broadleaf; `trunkMaterial` and `canopyMaterial`
optionally borrow your PbrMaterials. Trees of one shape share their geometry, so core draws them as one batch.
Move/rotate/scale `root` to transform both parts. Dispose the returned tree to remove all three nodes.

```ts
import {Engine} from '@margoengine/core';
import {createTree} from '@margoengine/procedural/tree';
const engine = await Engine.create(document.querySelector('canvas')!);
using tree = createTree(engine, 'broadleaf', {position: [4, 0, 7]});
tree.root.position.x = 8;
const spruce = createTree(engine, 'conifer', {position: [-3, 0, 5], height: 11});
// A far ridge of spruces that never needs the shoots, open-grown: a thicker stem on a heavier, older butt flare.
const ridge = createTree(engine, 'conifer', {position: [60, 0, -80], height: 18, shootDistance: 0, diameter: 0.4, flare: 1.45});
ridge.dispose();
spruce.dispose();
tree.dispose();
engine.dispose();
```

A conifer seen up close (`branches: true` on `generateTreeMesh('conifer', ...)`, the default in `createTree`) has 7
main branches a whorl and 5 shorter ones between whorls, each a lanceolate, cupped spray drooping toward its tip, with
the sky between them, after the spruce habit in Weber and Penn 1995 ("Creation and rendering of realistic trees",
SIGGRAPH) and Deussen and Lintermann 2005 (Digital Design of Nature, ch. 6). Its normals mix the spray's surface with
the direction from the trunk and tilt each vertex by up to 0.3 rad, the spread of needle orientation in a shoot. The
skirts (`branches` false, the `generateTreeMesh` default) close the crown and cost about a third of the triangles, for
mid and far trees. `CONIFER_NEEDLES` is linear sRGB [0.0245, 0.051, 0.0215], albedo 0.044: needle reflectance and
transmittance measured for Norway spruce and Scots pine (Lukes et al. 2013, Remote Sensing Letters 4(7)) less the light
a shoot's needles recollide, recollision probability 0.47 (Smolander and Stenberg 2003, Remote Sensing of Environment 88).

Seen from 1 to 30 m a spray needs its twigs, ragged needle edges and gaps, or it reads as a smooth dark blade. With
`shoots: true` (the `createTree` default within `shootDistance`) each spray is built as the branch it stands for: a
twig axis from the trunk to the tip, lateral shoots every 0.075 m alternating sides about 55 degrees forward (the
spruce's flat two-ranked branch system; Weber and Penn 1995; Deussen and Lintermann 2005), each shoot a band of needles
with a serrated edge of forward-swept tufts, about 30 mm a side (Norway spruce needles are 10 to 25 mm, Farjon 2010, A
Handbook of the World's Conifers), and the sky between the shoots, all inside the plain spray's outline, so a switch
does not move the silhouette. Seen from the side, 42 percent of the crown is sky: a measured young Norway spruce's needle
area (Pokorný and Tomášková 2007, Journal of Forest Science 53(12): 1.1083 H^1.9771 or 12.79 dbh - 50.65 m2 of needles in
a cone 6.5 m long and 2.5 m across) with its shoots' silhouette (STAR = (1 - 0.47) / 4, Smolander and Stenberg 2003)
leaves 26 to 43 percent through the same crown by Poisson's law (Nilson 1971, Agricultural Meteorology 8), where the
plain sprays leave 16 (test/conifer-lod.test.js). About 37,000 triangles a tree at detail 2 (9,600 at detail 1), so
`createTree` shows them only within `shootDistance` (default 30 m, where an 8 cm shoot still spans 2 pixels in a
1080-pixel, 60 degree view), picked at creation and before each frame with 10 percent hysteresis.

Beyond it a tree shows the same branches coarse (`shoots: 'coarse'`, about 5,700 triangles at detail 2 and 3,300 at
detail 1, against 3,500 and 700 for the plain sprays): the laterals 1.5 times as far apart and 1.55 times as wide at
detail 2, the needle teeth folded into each band's mean width, so the projected area and the normals, and with them the
colour and the snow, are the shoots'. A coarser level of aggregate detail keeps what the eye averages: the expected
projected area and the distribution of normals (R. L. Cook, J. Halstead, M. Planck and D. Ryu 2007, "Stochastic
simplification of aggregate detail", SIGGRAPH; D. Lacewell, B. Edwards, P. Shirley and W. B. Thompson 2006, "Stochastic
billboard clouds for interactive foliage rendering", Journal of Graphics Tools 11(1); E. Bruneton and F. Neyret 2012,
"Real-time realistic rendering and lighting of forests", Computer Graphics Forum 31(2); O. Deussen, C. Colditz,
M. Stamminger and G. Drettakis 2002, "Interactive visualization of complex plant ecosystems", IEEE Visualization). Seen
from four elevations and eight sides, the coarse level's coverage and lit, snow-covered luminance stay within the
shoots' own change for a 45 degree turn of the tree (under 4 percent), where the plain sprays differ by 17 to 190
percent; the plain sprays covered all of their outline against the shoots' 56 percent, so a tree changed species as it
crossed 30 m (KB-CABIN-FGTREE3).
The crown's top is built the same way, near and coarse alike: the youngest whorl, its reach closing the crown from the
last tier's to the tip, and above it the leader, this year's 0.5 m terminal shoot with its needle tufts and no side shoots
yet, as a spruce grows (a growth unit a year from the terminal bud, a whorl of lateral buds at each unit's top: Hallé,
Oldeman and Tomlinson 1978, Tropical Trees and Forests: An Architectural Analysis; Fabrika et al. 2019, BioResources,
young Norway spruce crown architecture). The leader's normals are the crown cone's at its apex, so it takes snow as the
crown's outline does. Its gap fraction, snow and lit colour lie within the range the tiers' tenths span
(test/conifer-leader.test.js); it was a solid, snowless cone that read as a black spike (KB-CABIN-LEADER1).
Core materials take no textures, so the needle detail is geometry and vertex normals, not alpha-tested cards or a
normal map; it needs no alpha test, so early depth rejection stays on.

The trunk's butt flare follows measured spruce stems: the diameter at the stump is 1.25 d + 2 cm (d at breast height),
1.30 to 1.45 times d for 40 to 10 cm stems, at a stump 1 percent of the height up in Finnish pine and spruce
(Laasasenaho's 1982 approximation as Repola 2009 uses it, "Biomass equations for Scots pine and Norway spruce in
Finland", Silva Fennica 43(4)), and 1.10 to 1.20 times inside the bark at a 1 ft stump in
northeastern spruce and fir (Wharton 1984, "Predicting diameter at breast height from stump diameters for northeastern
tree species", USDA Forest Service Research Note NE-322). `flare` sets the ratio at the ground against 1.3 m of the
placed tree (`generateTreeMesh` takes it with `breastHeight` in mesh metres, default 1.3); the swell dies away over the
lowest 0.25 m. Unset in `generateTreeMesh`, the trunk keeps its historical ring, about 2.1 times the breast-height
diameter.

A placed spruce's stem follows Näslund's height curve for Norway spruce, h = 1.3 + d^3 / (1.811 + 0.308 d)^3 (d in cm),
the mean of 64 southern Finnish spruce stands (J. Siipilehto 2000, "A comparison of two parameter prediction methods for
stand structure in Finland", Silva Fennica 34(4), Fig. 2): `spruceDiameter(height)` inverts it, 7.8 cm at breast height
for the 7.6 m default tree and 12 cm at 12 m, where the mesh's own trunk was 0.55 m. Measured 7.0 m Czech spruces
averaged 8.4 cm (Pokorný and Tomášková 2007); an open-grown tree is stouter, so pass `diameter`. `generateTreeMesh` takes
it as `breastDiameter` in mesh metres and scales the trunk across, keeping its taper and flare.

```ts
import {spruceDiameter, SPRUCE_HEIGHT_CURVE} from '@margoengine/procedural/tree';
const stem = spruceDiameter(12); // 0.124 m at 1.3 m on a 12 m spruce
console.log(stem.toFixed(3), SPRUCE_HEIGHT_CURVE.a, SPRUCE_HEIGHT_CURVE.b);
```

Trees return separate `trunk` and `canopy` GeometryData plus canopy `center` and
`radius`. Six-tier pines keep their timber supports enclosed inside the foliage;
broadleaf canopies are fifteen lumpy lobes plus 24 opaque, double-sided leaf
clumps per lobe (diamond cards rooted inside the lobe and reaching up to about
0.5 m past it) that break the smooth outline; all their normals radiate from the
collective centroid. The clumps add 1,440 triangles to the 4,800 of the lobes
and need no alpha test, so they keep early depth rejection on phone GPUs.
Shrubs use three compact, asymmetric hemispherical lobes with smooth normals.
All meshes have contiguous Float32 positions, normals, UVs and tangents, and
Uint32 indices. Tangents are xyzw, with `cross(normal, tangent.xyz) * w` pointing toward increasing v; `meshTree`
writes w = -1 on the base cap of each bark tube, whose UV disc is mirrored as seen from below. Trunks of the palm,
birch, acacia and snag taper from a wide root to a narrow tip, and the cactus's ribs follow each column's own axis.
Generation is deterministic, initialization-only CPU work, with
no asset downloads. Pack them into your scene's 80-byte vertex stream, then
upload and release CPU arrays. The gameplay sandbox
uses these exports with `ScatterInstances` and `PlacementLayout` from scatter.

## Noise (`@margoengine/procedural/noise`, 2.3 kB min+gzip)

```ts
import {Noise, fbm, ridged, domainWarp} from 'margoengine/procedural/noise';
const noise = new Noise(42);
const hills = fbm((x, y) => noise.simplex2(x, y), {octaves: 6});           // about [-1, 1]
const peaks = ridged((x, y, z = 0) => noise.simplex(x, y, z), {octaves: 5}); // [0, 1], sharp crests
const swirl = domainWarp(hills, {strength: 0.8, dimensions: 2});
const clouds = (x: number, y: number, z: number, t: number) => noise.simplex4(x, y, z, t); // 3D animated along w
```

`worley(x, y, z)` returns the exact F1 distance over the 5 x 5 x 5 cells around the point (one seeded feature per
cell, Worley 1996). It visits the 27 nearest cells first and hashes a cell only while the gap to its box is below the
nearest distance found so far, so most of the outer shell is never hashed; the value is the same bit for bit as
checking every cell:

```ts
import {Noise} from '@margoengine/procedural/noise';

const cells = new Noise(7);
const d = cells.worley(1.25, -3.5, 0.75);
console.log(d >= 0 && d < Math.sqrt(3)); // true: the point's own cell holds a feature
```

`Noise` has seeded `simplex2`, `simplex` (3D) and `simplex4`, plus `perlin` and `worley` (3D). The package has no
third-party runtime dependencies. Simplex is its own, written from Perlin (2001) and Gustavson's "Simplex noise
demystified": one kernel `(0.5 - |d|^2)^4 (g . d)` per simplex corner, radius^2 0.5 in every dimension, so the field is
continuous across simplex faces (no seams); values stay inside (-1, 1) (`SIMPLEX_SCALE`).

**Breaking change (5l.v):** `Noise.simplex` used to come from simplex-noise 4.0.3, whose 3D kernel (0.6) leaves small
jumps on simplex faces. The same seed now gives a different (seamless) field; `perlin` and `worley` are unchanged. A world
that must reproduce old simplex output pins `@margoengine/procedural` from before 5l.v. Diagnostic speed against the old
dependency: `examples/package-benchmarks/proofs/procedural-deps.proof.js`, a dated record (`fff47af`); re-running it needs
the two old packages installed, otherwise it reports HISTORICAL.

`fbm` divides by the total amplitude (the range stays the field's), `ridged` sums `(1 - |n|)^2`,
`domainWarp` offsets each axis by `strength * warp(p + o)` (o = `WARP_OFFSETS`). The same names in
`@margoengine/shader/noise` are WGSL twins of `simplex2`, `simplex`, `perlin` and the three combinators; the same seed gives
the same field on the GPU within f32 rounding. Coordinates are limited to |v| <= 1e7.

## L-systems (`@margoengine/procedural/lsystem`, 2.3 kB min+gzip)

```ts
import {createStage} from 'margoengine';
import {expand, interpret, tubes} from 'margoengine/procedural/lsystem';
const stage = await createStage('#app');
const rules = {
  X: [{successor: 'F[+X][-X]&[^X]!FX', weight: 3}, {successor: 'F!X', weight: 1}],    // stochastic: weighted choices
  A: {condition: (l: number) => l > 0.1, successor: (l: number) => `F(${l})[+A(${l * 0.6})]A(${l * 0.8})`}, // parametric, guarded
  F: 'FF',
};
const branches = interpret(expand('X', rules, 5, {seed: 7}), {angle: 24, step: 0.12, radius: 0.08});
stage.mesh(tubes(branches, {radialSegments: 6}));         // or new Line({mode: 'segments', positions: branches.positions})
```

`expand` rewrites in parallel, seeded (rule choice uses one xorshift stream), with a module budget (default 1,000,000).
Successors are module text (`F(1.5)[+X]`) or functions of the matched parameters returning text or modules. Not supported:
context-sensitive rules and parameter expressions inside successor text (use a function). `interpret` is a 3D turtle
(heading +Y, up +Z): `F`/`G` draw, `f`/`g` move, `+ -` yaw, `& ^` pitch, `\ /` roll, `|` turn around, `[ ]` push/pop, `!`
shrinks the radius; a parameter overrides the default length, angle or radius. `tubes` shares the joint ring between a
segment and its same-depth continuation (tilted to the bisector, so stems bend without gaps); side branches start inside
their parent and tips taper to `tipScale`. Tube ends are open; normals are radial (no cone slope).

## Voronoi and fracture (`@margoengine/procedural/voronoi`, 4.8 kB min+gzip)

```ts
import {createStage, sphere} from 'margoengine';
import {voronoi2, voronoi3, fractureMesh} from 'margoengine/procedural/voronoi';
const stage = await createStage('#app');
const points = Array.from({length: 200}, () => Math.random() * 100), points3 = Array.from({length: 300}, () => Math.random() * 10);
const {cells, edges, delaunay} = voronoi2(points, [0, 0, 100, 100]);   // cells[i].polygon, .edgeSites, .neighbors
const rooms = voronoi3(points3, [0, 0, 0, 10, 10, 10]);                 // convex cells: vertices, faces, faceSites, volume
for (const {geometry, center} of fractureMesh(sphere(1, 48), 24, {seed: 3}))   // 24 seeded sites
  stage.mesh(geometry, {position: [center[0] * 0.2, center[1] * 0.2, center[2] * 0.2]}); // pushed apart along their sites
```

`delaunay2`/`delaunay3` are Bowyer-Watson (O(n^2), up to 100,000 points; fine for levels and fracture, not for millions).
A cavity facet the new point does not strictly see drops its cell from the cavity, so co-circular grids and rounding
never produce overlapping triangles; duplicate points are skipped (empty cell). Voronoi cells are the bounds clipped by
the bisectors of the Delaunay neighbours, each edge/face tagged with the site across it (-1 on the bounds).
`fractureMesh` welds by position, then clips the mesh by each cell's planes, closing every cut with a flat cap
(triangulated with holes, so a torus fractures correctly). Chunk volumes add up to the mesh volume (1e-5 relative in the
tests; 240 fractures of a box, icosphere, UV sphere and torus checked closed). Needs a closed mesh; chunks are non-indexed;
caps get flat normals and no UVs; all CPU work, meant for load time or a loading step, not per frame.

## Gears and gear trains (`@margoengine/procedural/gears`, 1.9 kB min+gzip)

Spur wheels with true involute teeth, and the search for the gear train that turns an output at a wanted ratio:
clocks, orreries, gearboxes and machines that must turn at the right rate. Pure maths, no GPU code.

```ts
import {createStage} from 'margoengine';
import {Shape, Path, extrudeGeometry, toGeometry} from 'margoengine/geometry';
import {involuteOutline, gearRadii, designCompoundTrain, compoundRatio, compoundWheelAngles} from 'margoengine/procedural/gears';
const stage = await createStage('#app');
// A 30-tooth wheel of module 2 mm, 6 mm thick, with a 5 mm bore.
const wheel = new Shape(involuteOutline(30, 0.002));
const bore = new Path(); bore.absarc(0, 0, 0.005, 0, Math.PI * 2, true);
wheel.holes.push(bore);
stage.mesh(toGeometry(extrudeGeometry(wheel, {depth: 0.006, bevelEnabled: false})));
console.log(gearRadii(30, 0.002)); // {pitch: 0.03, tip: 0.032, root: 0.0275, base: 0.0282}
// A minute-to-hour train (1 to 12) on three arbors 4 cm and 5 cm apart.
const frame = {drive: [0.05, 0.04], stud: [0.05, 0], output: [0, 0]} as const;
const train = designCompoundTrain(1 / 12, frame); // {a, b, c, d}
console.log(compoundRatio(train), compoundWheelAngles(train, Math.PI / 2, frame).d);
```

| Export | Does |
| --- | --- |
| `involuteOutline(teeth, module, options?)` | counterclockwise `[x, y]` loop, tooth 0 on +x: involute flanks from the base circle (radial below it), tip lands, a three-point root; `flankPoints` (default 6) per flank |
| `gearRadii(teeth, module, form?)` | `pitch` (m z / 2), `tip`, `root`, `base` |
| `designCompoundTrain(ratio, frame, {tolerance})` | the two-stage train (a on the drive meshes b on the stud; c with b meshes d on the output) whose tooth counts come closest to `ratio`, every wheel fitting the frame; within `tolerance` (default 2e-6) the coarsest finer module wins |
| `compoundTrainMisfit(train, frame)` | why a train does not fit (`'a has 11 teeth'`, `'c reaches the drive arbor'`, ...), or null |
| `compoundModules(train, frame)`, `compoundRatio(train)` | the modules the centre distances give each mesh; output turns per drive turn |
| `compoundWheelAngles(train, drive, frame)` | every wheel's angle for a drive angle, teeth interleaved at both meshes |
| `meshAngle(driver, driverTeeth, drivenTeeth, toward)`, `toothPhase(angle, teeth, dir)` | the driven wheel's angle that puts a gap where the driver has a tooth; how far a wheel's tooth sits from a direction, in pitches |
| `involute(a)` | tan a - a |

Tooth form (`pressureAngle`, `addendum`, `dedendum`) defaults to the ISO 53 basic rack: 20 degrees, 1 and 1.25
modules. The frame takes the three centres and, all defaulting to 0 or unbounded, the tooth range (default 15 to 140),
module range, the radius of what turns on the output (`outputBundle`), the `arbor` radius, the running `clearance`, the
room wheel d needs round the bundle (`outputHub`) and the metal each pinion needs over its arbor (`pinionHub`). The
search tries every a, b and c in the tooth range with the two nearest d (about 4 million trains for 15 to 140), so
it suits a build step, not a frame. Wheels with fewer than about 17 teeth at 20 degrees are
undercut on a real cutter; the outline draws the full involute regardless. An invalid count, module or ratio throws a
`RangeError` that names the fix; no fitting train throws a `MargoError` with code `failed`. The Orrery example
(`examples/orrery`) turns eight planets with trains from this search.

## Voxel expressions (`@margoengine/procedural/expression`, 4.5 kB min+gzip)

A small, bounded expression language evaluated for every cell of an indexed voxel grid: Margo Voxel Studio's original
expression language (version 1), so its saved expression text gives the same grids. It is not GLSL, WGSL or a
JavaScript runtime: it evaluates only its own syntax tree, with no host access.

```ts
import {runVoxelExpression, VoxelExpressionError} from 'margoengine/procedural/expression';
const signal = AbortSignal.timeout(30_000);
const grid = {voxels: new Uint8Array(64 * 32 * 64)};
const {voxels} = runVoxelExpression({
  source: 'noise(x * f, y * f, z * f) > 0.5 ? tone : color', // one expression per cell
  size: [64, 32, 64], voxels: grid.voxels,                    // voxel-edit layout: x + sx * (z + sz * y), Y up
  parameters: {f: 0.2, tone: 24}, seed: 7, iterations: 1,
}, signal);                                                  // checked every 1,024 cells
```

- **Values.** Numbers (`12`, `1.5`, `.5`, `1e3`); variables `x y z` (the cell), `sx sy sz` (grid size), `color` (the
  cell's palette index), `frame`, `iteration`, `seed`, `pi`, `e`, `true` (1), `false` (0) and up to 32 named
  parameters (finite, within ±1e9). `//` comments run to the end of the line.
- **Operators**, loosest first: `a ? b : c`, `||`, `&&`, `== !=`, `< <= > >=`, `+ -`, `* / %`, `**` (right to left);
  unary `+ - !` bind tighter than `**` (`-2**2` is 4). `&&`, `||` and `?:` evaluate only the branch they need;
  comparisons and logic give 0 or 1.
- **Functions** (`VOXEL_EXPRESSION_FUNCTIONS` lists arity and cost): `abs floor ceil round sqrt sin cos tan pow`,
  `min max` (2-8 arguments), `clamp(v, a, b)`, `mix(a, b, t)`, `smoothstep(e0, e1, v)`, `length(x, y, z)`, signed
  distances `sphere(x, y, z, r)`, `box(x, y, z, hx, hy, hz)`, `torus(x, y, z, R, r)`; `hash(x, y, z)` and
  `noise(x, y, z)` (seeded by `seed`); `voxel(x, y, z)` reads the current iteration's input and `prev(x, y, z)` the
  `previous` frame (integer cells; outside the grid, or without `previous`, they read 0).
- **Results.** Each cell's value must be an integer palette index 0-255. `iterations` (1-32) run the expression
  again on the previous pass's output; every pass reads an immutable snapshot, and the input arrays are never changed.
- **Exact noise.** `voxelHash(x, y, z, seed)` and `voxelNoise(x, y, z, seed)` are exported with their formulas in the
  TSDoc: a 32-bit integer lattice hash in [0, 1] and smoothstep-blended value noise over it. They are not
  `@margoengine/procedural/noise`'s hash, whose constants differ; that module and its defaults are unchanged.
- **Bounds**, all checked before output is allocated (`VOXEL_EXPRESSION_LIMITS`): 8,192 source characters, 4,096
  tokens, 2,048 syntax nodes, depth 64, 32 parameters, 32 iterations, 1024 per axis and 16,777,216 cells, 64 MiB of
  buffers and 67,108,864 work units (`cells * iterations * workPerCell`; a node costs 1, `noise` 32 more).
- **Errors.** Text that does not parse, names an unknown variable or function, or exceeds a token, node or depth
  bound throws `VoxelExpressionError` (`code` `'syntax'` or `'limit'`, 1-based `line` and `column`, `detail` without
  the location); a non-finite value, an invalid function argument or a bad output throws it with `code: 'evaluation'`
  at the operator. Inputs of the wrong shape throw TypeError, values out of range or over a budget RangeError.
  `compileVoxelExpression` and `validateVoxelExpressionInput` check without evaluating.

Compatibility with Studio (`test/expression.test.js`): its own tests and presets, and a generated corpus of 400
programs whose grids and error locations hash to the digest Studio's interpreter produced. In a differential run,
15,000 random programs gave identical grids or identical errors (line, column and message), and 90,000 random token
sequences parsed identically with one deliberate difference: a JavaScript object-prototype name used as an infix
operator (`x toString 1`) was accepted by Studio's parser and failed only when evaluated, and is now a syntax error.
`sin`, `cos`, `tan`, `pow`, `**` and the distance functions (`Math.hypot`) use the host's `Math`, which JavaScript
engines may round differently in the last bit; every other operation, `hash` and `noise` included, is exact. Closure compilation makes it 1.7 to 3.3 times faster than
Studio's tree walker (96 x 96 x 96 cells: sphere 162 ms, noise 177 ms, recolor 26 ms in Node 26).

## Examples

`examples/lsystem.html` and `examples/voronoi.html` (Vite at the repository root after `npm run build:packages`).

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/procedural

## Poisson disk placement

Optional `@margoengine/procedural/poisson`: 1,290 B min+gzip JavaScript and one lazy Rust/Wasm file,
29,914 B raw / 13,192 B gzip. Importing the entry fetches nothing. The factory loads the shipped artifact;
applications need no Rust toolchain. WebGPU and WebGL2 use the same CPU sampler.

```ts
import {createPoissonSampler} from 'margoengine/procedural/poisson';
using sampler = await createPoissonSampler();
const trees = sampler.rectangle([0, 0, 40, 30], {radius: 2, seed: 7}); // packed XY
const onSlope = sampler.surface(new Float32Array([
  0, 0, 0,  10, 0, 0,  0, 10, 10,
]), {radius: 0.8, seed: 11}); // packed XYZ, on this triangle
console.log(trees.positions.length / 2, onSlope.positions.length / 3);
```

`rectangle` takes `[minX,minY,maxX,maxY]`, with positive extents. `surface` takes `Float32Array` or
`Float64Array` triangle soup, nine numbers per triangle, at most 65,536 triangles. Triangle choices are weighted
by area. Empty or zero-area surfaces return no points. Separation is ambient Euclidean distance, including
across nearby disconnected faces, rather than distance along a surface. Coordinates must be finite and within
+/-1,000,000. Output arrays are fresh float64 coordinates; converting them to float32 can reduce spacing.

`radius` is required, 0.000001..1,000,000. Other defaults: `seed: 1` (uint32, zero shares one's stream),
`maxPoints: 4096` (0..65,536), `attempts: 100000` (0..2,000,000). Zero points or attempts returns empty output.
Bounded dart throwing guarantees separation, not a maximal covering or the point limit. Inspect result
`attempts` (candidates actually considered), `comparisons` (neighbour distance tests) and `dimensions` (2 or 3).
Triangles whose cross products round to zero carry no probability. No spectral or frame-time guarantee is made.

The factory accepts `{signal}` for loading; sampling options accept `signal`, checked before synchronous work.
Use a worker for cancellation in flight. `dispose()` and `Symbol.dispose` are idempotent, preserve returned arrays
and release the instance. Later work throws code `disposed`; invalid input throws code `failed`, with a help link.
No rendering resources are owned; device/context loss leaves sampling usable.

The Rust hash and a float64 all-pairs oracle accept identical output for 3,000 fixed candidate points, using 3,329
versus 3,445,553 distance tests. This proves less rejection work, not a language or wall-clock speedup. Native tests:
`npm run test:poisson-kernel --workspace @margoengine/procedural`. Rebuild the committed artifact with
`npm run build:poisson --workspace @margoengine/procedural` (Rust target `wasm32-unknown-unknown`, simd128 enabled;
no SIMD speed claim). Browser proof: `npm run test:gpu --workspace @margoengine/procedural`, including a production
consumer below a non-root base, lazy Wasm requests and values on WebGPU/WebGL2 after device/context loss.

## Dungeon layouts

The optional `@margoengine/procedural/dungeon` entry makes seeded BSP rooms and corridors with no input assets.
Use `margoengine/procedural/dungeon` through the umbrella package. Each room is inside its own partition;
one centre-to-centre corridor joins the two child layouts at each split. This constructs a connected layout
without retries or a repair pass. Coordinates and dimensions are integer grid cells, with X fastest.

```ts
import { createDungeonGenerator } from '@margoengine/procedural/dungeon';
using generator = await createDungeonGenerator();
const layout = generator.generate({ width: 64, height: 48, seed: 19 });
console.log(layout.rooms.length, layout.corridors.length);
console.log(layout.cells[20 * layout.width + 30]); // 0 wall, 1 walkable
```

| Option | Default | Limits |
| --- | --- | --- |
| width | 64 | Integer 6..1024; at least minRoomSize + 4 |
| height | 48 | Integer 6..1024; at least minRoomSize + 4 |
| seed | 1 | uint32; zero uses seed one's stream |
| minRoomSize | 4 | Integer 2..64, in cells |
| maxRooms | 32 | Integer 1..256; an upper bound, small grids can fit fewer |
| signal | absent | Factory load is abortable; generation checks before synchronous work |

`rooms` hold x/y/width/height, `corridors` hold from/to room indices and an orthogonal bend. Each corridor
is one cell wide. Crossings with rooms or other corridors are allowed. The link graph is a tree; crossings
can introduce loops in the raster. The outer border is always wall. Every floor cell is reachable using
four-neighbour movement. `cells` is an owned Uint8Array; layouts survive later calls and disposal.
`rasterVisits` counts written room/corridor cells including repeated writes, excluding zero initialization.
The independent test oracle checks every cell against every room and corridor segment with identical output.
This is a work-count proof, not a timing or Wasm/SIMD speed claim.

The factory loads one feature-local Rust/Wasm asset lazily; importing downloads no Wasm. WebGPU and WebGL2
use the same CPU generator, which remains usable after device/context loss. `dispose()` and `Symbol.dispose`
release the instance and are idempotent. Bad settings and use after disposal throw coded errors with help links.
Use a worker for interruption of work in flight. Build the checked-in artifact with `npm run build:dungeon`
in this package; `npm run test:dungeon-kernel` runs the native Rust tests. SIMD compilation is enabled;
its benefit has not been measured. Layouts are blockouts, without rendering, doors, stairs, gameplay
furnishing, 3D meshes or navigation clearance guarantees (LIM-628). All proof maps are generated stand-ins.

## Space colonisation trees and roots

The optional `@margoengine/procedural/trees` entry grows a branching skeleton towards attraction points.
Use `margoengine/procedural/trees` through the umbrella package. With no settings it creates a seeded crown
of 512 points inside a sphere of radius 2 metres, centred 3 metres above the root. The crown samples use
normalized cube directions and a uniform radial distance; they are not a uniform volume distribution.
Every influenced node grows one segment along the normalized sum of normalized attraction directions.
Reached points are consumed, while equidistant nodes use the lowest insertion index.

```ts
import { createTreeGenerator } from '@margoengine/procedural/trees';
using generator = await createTreeGenerator();
const tree = generator.generate({ seed: 19 });
console.log(tree.positions.length / 3, tree.parents.length, tree.stopped);
const roots = generator.generate({
  attractionPoints: new Float64Array([0, -2, 0, -1, -3, 0, 1, -3, 0]),
  root: [0, 0, 0],
});
console.log(roots.remainingAttractions);
```

| Option | Default | Limits |
| --- | --- | --- |
| attractionPoints | seeded crown | Float64Array of XYZ triples, at most 8192 points, coordinates finite within +/-1e6; empty gives only the root |
| root | [0, 0, 0] | Three finite coordinates within +/-1e6; generated crown may extend 5 metres beyond a root coordinate |
| attractionCount | 512 | Integer 1..8192; ignored when custom points are present |
| seed | 1 | uint32; zero uses seed one's stream |
| segmentLength | 0.2 | 0.0001..10000 metres |
| influenceRadius | 3 | 0.0001..1e6 metres |
| killRadius | 0.3 | segmentLength/2..influenceRadius |
| maxNodes | 2048 | Integer 1..16384, including the root |
| maxIterations | 128 | Integer 1..512 growth rounds |
| signal | absent | Factory load is abortable; generation checks before synchronous work |

The attraction point count times maxNodes times maxIterations must not exceed 134,217,728. This bounds
nearest-distance work; it is not a generation-time guarantee. A point influences its nearest node within
influenceRadius, including the boundary. Points at or within killRadius are consumed. Direction sums with
length at most 1e-12 do not grow a segment. A node never grows a second child at the position of one it already
has: the published rule (Runions et al. 2007, eq. 2) would regrow it every round while the points that pulled it
stay nearer the parent (each lies less than D/2 along the growth direction), so those points stop growth instead
of filling the skeleton with stacked copies (the default crown of seed 1 had 315 of 682 nodes duplicated). Symmetrically balanced or unreachable clouds can stop without
consuming all points. `stopped` is `complete`, `stalled`, `maxNodes` or `maxIterations`; `remainingAttractions`
records unreached points. The generator also consumes reached points after its final growth round.

`positions` and `attractionPoints` are owned Float64Arrays. `parents` is an owned Int32Array with -1 for the
root and an earlier node index for every other node, so every node is connected to the same root and the
parent graph has no cycles. `iterations` counts growth rounds. `distanceTests` counts complete squared-distance
tests in nearest-node queries, including final consumption. A spatial grid with conservative cell bounds
avoids testing distant nodes. The fixed seed 19 crown, influenceRadius 1.5, uses 218,405 distance tests versus
821,423 in the exhaustive independent reference, producing identical 674-node positions and parents.
This generated stand-in proves less distance work, without a wall-time, language or SIMD speed claim.

The factory lazily loads its own Rust/Wasm file; importing the entry fetches no asset. The CPU data generator
has the same behaviour on WebGPU and WebGL2 and survives device/context loss. Idempotent `dispose()` and
`Symbol.dispose` release the instance; previously returned data remains valid. Bad inputs and disposed use
throw coded errors with help links. Use a worker for interruption of generation in flight.
`npm run build:trees` rebuilds the committed Wasm; `npm run test:trees-kernel` runs its native tests.
These skeletons do not include bark/foliage meshes, smoothing, branch radii, species calibration or intersection
guarantees. Procedural evidence is stand-in only (LIM-631).

The Poisson, dungeon and tree factories preserve the caller's exact AbortSignal reason. Other loading
failures use code `failed` with a help link and the original error as `cause`; existing HTTP and CSP
faults retain their specific help. This covers file reads, fetch/body errors and malformed Wasm bytes.

## Sharp SDF models

`@margoengine/procedural/sdf` contours a bounded signed-distance expression with
uniform-grid dual contouring. Tangent planes place one vertex per active cell;
their constrained quadratic error minimum retains box corners and sharp CSG edges.
The default model is a box, so no user-supplied field or asset is required.

```ts
import { Geometry } from '@margoengine/core';
import { createSdfModeler } from '@margoengine/procedural/sdf';
using modeler = await createSdfModeler();
const mesh = modeler.mesh({
  type: 'difference',
  a: { type: 'box', halfSize: [0.8, 0.7, 0.6] },
  b: { type: 'sphere', center: [0.5, 0, 0], radius: 0.4 },
}, { resolution: 32 });
const geometry = new Geometry(mesh.positions, mesh.normals, mesh.indices);
console.log(geometry.indices.length / 3);
```

`mesh(shape?, options?)` returns owned Float64 XYZ `positions`, unit outward SDF
gradient `normals` at those vertices, and Uint32 triangle `indices`, in outward
order. Pass them directly to core `Geometry`. For sharp shading, expand indexed
triangles and compute one normal per face. No UVs or material assignments are generated. `edgeSolves` counts unique sign-changing grid
edges; `cellEdgeUses` counts the four cell uses per edge on an enclosed surface.
Sharing Hermite roots removes three of four root solves with identical inputs and
output, without a wall-time or SIMD speed claim.

Shapes are spheres (`radius`, optional `center`, default [0,0,0]), axis-aligned boxes
(`halfSize`, optional `center`, default [0,0,0]), and binary `union`, `intersection`
or `difference` (`a` and `b`, difference subtracts b from a). At most 63 nodes are
accepted. All coordinates must be finite within +/-10000; radii and half sizes are
0.0001..10000. CSG uses min/max, whose zero surfaces are correct but whose field
values need not be exact distances. Arbitrary callbacks, imported sampled fields,
rotated primitives, adaptive octrees and manifold repair are not implemented.

Options: `resolution` is cells per axis, integer 4..64, default 24; `bounds` is two
strictly increasing XYZ corners. When omitted, bounds derive from the analytic
tree: primitive AABBs, union enclosure, intersection overlap and the minuend of
a difference, plus 10% of each axis extent on both sides (at least 0.0001). A
disjoint intersection uses an operand enclosure and produces empty output. Bounds
that cannot fit the supported coordinate/extent limits give linked code `failed`
and ask for explicit bounds. Explicit bounds have
extent 0.0001..10000 per axis and coordinates within +/-10000. A nonpositive sampled
boundary value throws code `failed` and asks for larger bounds. An empty sampled
field returns empty arrays. Features smaller than the grid, multiple crossings of
one edge, tangent surfaces and disconnected components inside one cell may be lost
or become nonmanifold. CSG may produce zero-area triangles where surfaces touch. A
sample within 2^-40 of a step of zero counts as exactly on the surface (outside), so
a surface through a grid point, such as a default-bounds sphere's poles at a
resolution that is a multiple of 12, meshes without slivers.
Each dual quad splits along the diagonal that keeps both triangles facing along its
edge, so smooth surfaces and most seams do not fold; there is no topology guarantee for arbitrary expressions. Normals are analytical
primitive gradients selected through CSG, with deterministic axis ties on box edges.
Roots use 40 bisections; rank-deficient QEFs use the Hermite mass point with a 1e-10
absolute eigenvalue cutoff on the unit-normal system and bounded face/edge/corner
minimization. These are approximation rules, not exact CAD operations.

The factory lazily loads one independent Rust/Wasm asset, accepts `signal`, and
has no import-time work. Generation checks `signal` before synchronous work; use a
worker for in-flight interruption. `dispose()` and `Symbol.dispose` are idempotent;
owned results survive disposal. Errors carry codes and help links. CPU output is
identical on WebGPU and WebGL2, including after real device/context loss.
`npm run build:sdf` rebuilds the committed asset; `npm run test:sdf-kernel` runs
native tests. The external Khronos Box proves all eight sharp corners, planar
surface, winding, closed edges and volume; sphere/CSG/extreme controls are generated
stand-ins. No production model, render-quality or timing claim (LIM-632).

## Tileable GPU textures

`@margoengine/procedural/textures` bakes periodic noise, bricks, tiles, wood-like
bands and rust-like patches directly into owned RGBA8 GPU textures. It accepts a
WebGPU device or a Margo engine. On native WebGL2 it compiles a fragment pipeline
on the engine canvas, with all five patterns and the same options. Pass the engine
itself on that route; its `gpu` is null. Each RGBA8 colour channel agrees within
one quantization step on the tested GPU. Mortar exactly on a threshold may vary
with floating-point rasterization. No CPU pixel loop, asset fetch or Wasm is used.
The WebGL2 chunk loads only when that backend is selected.

```ts
import { createTextureBaker } from '@margoengine/procedural/textures';
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error('WebGPU adapter required');
const device = await adapter.requestDevice();
{
  using baker = await createTextureBaker(device);
  using baked = await baker.bake({ pattern: 'bricks', width: 128, height: 128 });
  console.log(baked.texture.format, baked.width, baked.height);
}
device.destroy();
await device.lost;
```

| Bake option | Default | Limits |
| --- | --- | --- |
| pattern | bricks | noise, bricks, tiles, wood, rust |
| width, height | 256 each | Integers 16..2048, at most maxTextureDimension2D (WebGPU) or MAX_TEXTURE_SIZE (WebGL2) |
| seed | 1 | Unsigned 32-bit integer, including zero |
| repeat | [4,8] | Integer columns/rows 1..64; bricks require even rows to repeat the alternate offset |
| detail | 0.2 | 0..1; per-texel brick/tile variation, wood phase warp, rust threshold softness; ignored by noise |
| grout | 0.08 | 0..0.45, half mortar width as a cell fraction; bricks/tiles only |
| stagger | 0.5 | 0..1, alternate brick-row horizontal offset as a cell fraction; bricks only |
| color | [0.55,0.2,0.08] | Primary linear RGB, each 0..1 |
| secondary | [0.15,0.12,0.1] | Mortar/secondary linear RGB, each 0..1 |
| offset | [0,0] | UV phase, finite within +/-1024; integer parts discarded |
| signal | absent | Cancels compilation/bake waits; caller's exact reason is preserved |

Native WebGPU outputs have `backend: 'webgpu'` and a `GPUTexture`. Native WebGL2
outputs have `backend: 'webgl2'`, a `WebGLTexture` and its owning `gl` context. They
are native handles for their renderer; neither can be used on another context.
The fragment pass restores GL state before yielding. Recreate the baker after
WebGL2 context loss/restoration. Disposal releases every retained output.

```ts
import {Engine} from '@margoengine/core';
import {webglRenderer} from '@margoengine/webgl2-compat/preview';
import {createTextureBaker} from '@margoengine/procedural/textures';
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgl2', fallback: webglRenderer});
using baker = await createTextureBaker(engine);
using baked = await baker.bake({pattern: 'bricks', width: 256, height: 256});
console.log(baked.backend, baked.width, baked.height);
baked.dispose(); baker.dispose(); engine.dispose();
```

All presets use the same caller-controlled palette. `noise` is four-octave periodic
value noise with lattice periods 4,8,16,32 and weights 8,4,2,1, quintic interpolation
and an integer seed hash. Brick/tile mortar is a hard threshold without filtering.
Wood is periodic wavy longitudinal bands; rust is thresholded periodic noise. These
are stylized patterns, without wood anatomy, corrosion simulation or PBR maps.
`repeat` controls brick/tile cells and wood bands; noise/rust use fixed octave
periods. Bake enough pixels per cell to avoid aliasing. No mipmaps are generated.
The format is linear `rgba8unorm`, alpha 1, with TEXTURE_BINDING, STORAGE_BINDING and
COPY_SRC. Each channel is rounded to the nearest of the 255 steps in the shader: WebGPU leaves
that rounding to the GPU, and GPUs differ near a half step (an RTX A6000 stored 133 where
a Radeon 680M stored 134). Use a sampler with repeat addressing on both axes. Pixel centres on
opposite edges need not match: the underlying function repeats continuously, and
the adjacent pixel across a repeat boundary is the next sample of that function.

`bake()` resolves after submission completes. Each output is owned and disposable;
baker disposal destroys retained outputs and cancels pending work. Abort, disposal,
allocation failure and device loss clean up incomplete outputs. Create a fresh
baker on a replacement device. The entry does no work on import. Validation and
compile/driver failures use coded errors with help links and retain original causes;
shader errors name their source line. CPU lifecycle controls use stand-ins, while
the actual shader, 44,415 pixel/channel checks, seam-crossing phase shifts, real
abort/loss/disposal and replacement run on WebGPU. Native WebGL2 runs the same
shader oracle and also verifies state restoration, cancellation, disposal and
actual context loss/restoration.
The downloaded Lefebvre/Poulin 2000 figure 1(d) supplies a measured running-bond
offset for a calibrated structural check only. Generated numerical controls remain
stand-ins; no photograph reconstruction, wood/rust realism, material quality,
cross-device byte identity or timing is claimed (LIM-639).

GPU wait promises are observed before checking cancellation, and loss/cancellation
is checked again after completion. An already lost factory and a cancelled queue
cannot leave a later GPU rejection unhandled; the original abort reason still wins.

## PBR material maps (`@margoengine/procedural/textures-pbr`)

`createPBRTextureBaker(engine or device)` bakes four linear `rgba8unorm` maps on the GPU (albedo, normal, roughness,
height) with full filtered mip chains, on WebGPU or the full WebGL2 compatibility layer. Patterns: `noise`, `bricks`,
`tiles`, `wood`, `rust`, `marble`, `cloud`, `grass`, `fire`, `starfield`, `road`, `stone` and `soot`.

```ts
import { Engine } from '@margoengine/core';
import { createPBRTextureBaker } from '@margoengine/procedural/textures-pbr';

const engine = await Engine.create(document.querySelector('canvas')!);
using baker = await createPBRTextureBaker(engine);
using stone = await baker.bake({ pattern: 'stone', repeat: [6, 6], chip: 0.4 });
using bricks = await baker.bake({ pattern: 'bricks', tint: 0.2, chip: 0.5, width: 1024, height: 1024 });
using soot = await baker.bake({ pattern: 'soot', width: 128, height: 256, mipmaps: false });
console.log(stone.mipLevelCount, bricks.width, soot.heightPixels);
```

| Option | Default | Meaning |
| --- | --- | --- |
| pattern | bricks | One of the thirteen above |
| normalStrength | 1 | 0..8, tangent-space normal multiplier |
| heightScale | 0.05 | 0..1, height amplitude per UV tile |
| roughness | 0.7 | 0..1, base perceptual roughness |
| roughnessVariation | 0.3 | 0..1, roughness that follows the height |
| tint | 0.25 for stone, 0 otherwise | 0..1, per-cell colour of bricks, tiles and stone: each cell's colour times a seeded 1 +- tint; mortar untouched |
| chip | 0 | 0..1, chipped edges of bricks, tiles and stone: a rounded bevel with a broken, noisy edge for close-ups |
| time | 0 | 0..1e6 seconds; rebake to animate cloud, fire and starfield |
| mipmaps | true | Complete chain to 1x1, area filtered, normals renormalized |

The size, seed, repeat, detail, grout, stagger, colour and offset options are those of `/textures` above. With `tint`
and `chip` at 0 the bricks and tiles maps are the same as before the options existed.

`stone` is irregular cells with mortar (Worley 1996): each texel finds its nearest and second-nearest jittered cell
point, (F2 - F1) / 2 is about the distance to the mortar line, and each stone gets its own height (0.8 to 1 of the
range) and, through `tint`, its own colour. `grout` sets the mortar width; `repeat` the stones per tile (default
[4, 8], so pass a square count for a square texture). It repeats like the other patterns.

`soot` is a smoke mask, not a repeating pattern: a plume rises from the middle of the v = 0 edge, its half-width
growing linearly with height and its density falling as (b0 / b)^(5/3), the shape of a buoyant plume (Morton, Taylor
and Turner 1956); `detail` (default 0.2) adds vertical streaks. Use it with clamp addressing. Its default colours are
white `secondary` and near-black `color`, so the albedo is a multiply atlas for `@margoengine/post/decals` (see
`sootDecal` in `@margoengine/materials/soot`) and the height map is the darkness itself.

Sources: Worley, "A Cellular Texture Basis Function", SIGGRAPH 1996, https://dl.acm.org/doi/10.1145/237170.237267;
Morton, Taylor and Turner, "Turbulent gravitational convection from maintained and instantaneous sources", Proc. R.
Soc. A 234, 1956, https://doi.org/10.1098/rspa.1956.0011; Lefebvre and Poulin, "Analysis and synthesis of structural
textures", Graphics Interface 2000 (bricks and tiles).

## Board sheds and a launch rail (`@margoengine/procedural/sheds`)

`generatePlankShed(options?)` builds a board-built gabled shed: horizontal lapped boards (clapboard) or vertical
boards on the walls, door and window openings that cut the boards they cross, door leaves (`closed`, `open` on a
side hinge, or `awning`, hinged at the top and propped up 75 degrees), two board roof slopes with an overhang, fascia
and a ridge board, and corner boards. It returns `{parts: {siding, roof, trim}, ridge,
inside: {faces, floor, daylight}}`, one `GeometryData` per material with UVs, tangents and unit normals.
`inside.faces` holds the faces turned into the shed (the insides of the walls and closed leaves, the roof's underside)
and `inside.floor` a thin floor; `inside.daylight` is the average daylight factor inside (0 to 1, Crisp and Littlefair 1984), to scale their ambient light by (an `aoMap` of that value),
so an open door reads dark. The UVs run with the grain, one column of `shedBoardMap` to a board and one repeat to 2 m:
`shedBoardMap({color, variation, seed})` returns sixteen weathered boards (own tones, silvering, grain, knots, dirt in
the joints; their mean is `color`) as 256 by 512 sRGB RGBA8 data. Render the parts and the inside (the walls' inner faces
are only in `inside.faces`); the origin is on the ground at the middle of the floor and the ridge
runs along x. The default is the Wright brothers' 1903 hangar at Kill Devil Hills: 13.4 by 4.9 m (44 by 16 ft), low
roof, a wide awning door on the front. `generateLaunchRail(options?)` lays a straight timber rail along +x, timbers on
edge capped with a thin metal strip, following `ground(x)`: the default is their 60 ft rail of 2 by 4s in four
lengths. Both are seeded (`seed`, `weathering` 0 to 1 for small tilts, uneven ends and gaps).

```ts
import {generateLaunchRail, generatePlankShed, shedBoardMap} from 'margoengine/procedural/sheds';
const boards = shedBoardMap({color: [0.26, 0.2, 0.15], seed: 2}); // new Texture(boards, {colorSpace: 'srgb', wrapS: 'repeat', wrapT: 'repeat'})
console.log(boards.width, boards.height); // 256 512
const hangar = generatePlankShed(); // the 1903 hangar
const shed = generatePlankShed({length: 7.6, pitch: 30, siding: 'vertical', openings: [
  {wall: 'front', at: -1.6, width: 0.9, height: 1.95, leaf: 'closed'},
  {wall: 'front', at: 1.5, width: 0.8, height: 0.7, bottom: 1}]});
const rail = generateLaunchRail({ground: (x) => x * 0.02});
console.log(hangar.ridge.toFixed(2), shed.parts.siding.indices.length > 0, rail.parts.metal !== undefined); // 3.20 true true
```

| Option | Default | Range | Meaning |
| --- | --- | --- | --- |
| `length`, `width` | 13.4, 4.9 | 1.5 to 40, 1.2 to 16 m | along the ridge (x) and across it (z) |
| `eaves` | 2.4 | 1.5 to 8 m | wall height |
| `pitch` | 18 | 5 to 60 degrees | roof slope |
| `siding` | `'horizontal'` | `'horizontal'`, `'vertical'` | lapped boards or boards side by side |
| `board` | 0.15 | 0.08 to 0.4 m | board face width (lap siding is about 6 inches) |
| `overhang` | 0.2 | 0 to 1 m | roof past the walls |
| `openings` | one awning door 3.6 by 2.1 m on the front | | `{wall, at, width, height, bottom, leaf}`; `wall` is `front` (+z), `back`, `left` (-x gable) or `right` |
| `weathering` | 0.5 | 0 to 1 | small tilts, uneven ends and gaps |
| `seed` | 1 | integer | the same seed gives the same boards |

`shedBoardMap` options: `color` (linear RGB, default [0.258, 0.205, 0.147]), `variation` 0 to 1 (0.5; 0 is one flat
colour), `seed` (1).

Rail options: `length` 1 to 60 m (18.3), `sections` 1 to 12 (4), `timber` width and height in metres ([0.038, 0.089],
a dressed 2 by 4 on edge), `strip` (true), `ground(x)` (flat 0), `seed`. A wrong type throws a `TypeError`, a
value out of range or an opening that does not fit its wall a `RangeError` naming what to pass.

Sources: US Forest Products Laboratory 2010, *Wood Handbook: Wood as an Engineering Material*, FPL-GTR-190
(https://www.fpl.fs.usda.gov/documnts/fplgtr/fpl_gtr190.pdf), lap siding widths and laps and dressed lumber sizes;
Crisp and Littlefair 1984, "Average daylight factor prediction", CIBSE National Lighting Conference (after Lynes 1979,
https://doi.org/10.1177/14771535790110020101), the daylight factor inside;
Library of Congress Wright Brothers negatives LC-W86-15 and LC-W86-21 (public domain,
https://www.loc.gov/pictures/collection/wri/), the 1903 camp buildings and the launching track; McFarland (ed.) 1953,
*The Papers of Wilbur and Orville Wright* (McGraw-Hill), the hangar's size and the rail.

## Building rules and period styles (`@margoengine/procedural/building-rules`)

`generateBuilding(options?)` makes a whole building from rules: the footprint is split into storeys, each side into a
whole number of bays, and each bay into wall, window or door, inside walls of real thickness, under a roof. Roofs are
`hip`, `gable`, `hip-gable` (the Japanese irimoya), `shed` or `flat` (with a parapet); a `falseFront` stands over the
front wall and always clears the roof behind it. Windows sit back by the `reveal` with jambs through the wall, frames
(sliding, double-hung or strip), sills, casings or stone lintels; doors are panelled, glazed or roller doors; a front
`porch` gets posts, a shed roof, railings and steps, a raised door without one gets a stoop and steps (a ramp for a
vehicle door), and a `balcony` gets a 1.1 m railing and a full height sash onto it. Roofs carry courses of tile (with
pan and roll at `near` detail), shingle or standing seam metal, ridge and hip caps, gutters and downspouts, knee
braces and a chimney that clears the roof by the building code. `detail` (`far`, `mid`, `near`) sets how much small
geometry there is, so a whole town can be `mid` and the hero house `near`.

It returns `{parts, palette, options, floors, eaves, top, openings, footprint, roofHeight(x, z), chimney, steps,
railings, rooms, furniture, doorways, stairs}`: one `GeometryData` per part (`walls`, `interior`, `furniture`,
`stairs`, `fixtures`, `metalwork`, `fabric`, `mats`, `trim`, `roof`, `glass`, `frames`, `doors`, `base`,
`porch`, `awning`, `chimney`, `gutters`; a part with nothing in it is left out), all in world space with UVs in metres
for tiling textures and tangents, plus a suggested material for each part. The origin is on the ground under the middle
of the footprint, the front faces +z turned by `yaw`.

Style sets (`style`), each a full set of defaults that any option overrides:

| Style | What it is |
| --- | --- |
| `japan-2011-house` (default) | Two storey wooden house on the 910 mm module, 9.1 by 7.28 m, tiled hip roof at 4.5 sun, ceramic siding, aluminium sliding windows, a second floor veranda, gutters |
| `japan-2011-concrete` | Four storey reinforced concrete public building, strip windows, slab edge bands, a flat roof with a 1.1 m parapet |
| `japan-2011-warehouse` | Fish market shed or harbour warehouse: one 6.5 m storey, corrugated metal, low metal gable, two roller doors and ramps |
| `western-1910-house` | Front-gabled frame house: clapboard, corner boards, casings, double-hung sash, full width porch, brick chimney, shingles at 10 in 12 |
| `western-1910-false-front` | Two storey store on a 25 ft lot: square or stepped false front with a cornice, storefront and transoms, awning |
| `western-1910-brick` | Three storey brick commercial block: storefronts, tall double-hung windows with stone lintels, belt courses, parapet and dentil cornice |
| `western-1910-depot` | One storey rail depot: long hip roof with 1.8 m bracketed eaves, clapboard, two doors |

`townBuildings(lots, {styles, margin, detail, seed, override})` turns the lots of a settlement layout (the `houses` of
`layoutSettlements` from `@margoengine/biomes/settlements`, `pattern: 'grid'`) into one building's options each: a style
drawn by weight, the lot less the margin, the front to its street, the floor on the pad, and seeded variety in storeys,
roof shape, pitch and door bay.

```ts
import {generateBuilding, townBuildings} from 'margoengine/procedural/building-rules';
const house = generateBuilding();
const shop = generateBuilding({style: 'western-1910-false-front', origin: [20, 0, 0]});
console.log(house.eaves.toFixed(2), house.top.toFixed(2), shop.openings.filter((o) => o.kind === 'shop').length); // 6.30 8.16 2
const lots = [{centre: [0, 0], size: [14, 18], along: [1, 0], floor: 1.2, front: [0, 1]}] as const;
const town = townBuildings(lots, {styles: {'japan-2011-house': 3, 'japan-2011-concrete': 1}}).map((o) => generateBuilding(o));
console.log(town.length, Object.keys(town[0].parts).length > 5); // 1 true
```

| Option | Default (`japan-2011-house`) | Range | Meaning |
| --- | --- | --- | --- |
| `width`, `depth` | 9.1, 7.28 | 3 to 120 m | footprint along the front (x) and front to back (z) |
| `storeys` | [2.9, 2.9] | 1 to 60 of 2.2 to 8 m | floor to floor height of each storey from the ground up |
| `plinth` | 0.5 | 0 to 2 m | ground floor height over the ground |
| `wall`, `reveal` | 0.15, 0.08 | 0.08 to 1, 0.02 to 0.5 m | wall thickness; how far glass and doors sit back (at most 0.9 of the wall) |
| `roof` | `hip` | `flat`, `gable`, `hip`, `hip-gable`, `shed` | roof shape |
| `pitch` | 24.2 | 2 to 60 degrees | roof slope |
| `ridge` | `auto` | `auto`, `x`, `z` | ridge direction (a shed roof's high edge); hips always run along the longer side |
| `gableInset` | 0.5 | 0.1 to 0.9 | hip-gable: where the small gable stands, as a share of half the depth |
| `overhang` | 0.6 | 0 to 3 m | eaves and verges past the walls |
| `roofing` | `tile` | `tile`, `shingle`, `metal`, `membrane` | covering, courses and caps |
| `parapet` | 0 | 0 to 3 m | flat roofs: parapet height |
| `falseFront`, `falseFrontShape` | 0, `square` | 0 to 8 m; `square`, `stepped` | false front over the eaves |
| `cladding` | `siding` | `clapboard`, `siding`, `brick`, `concrete`, `plaster`, `metal` | lap courses at `near` for clapboard and siding, corrugation for metal, lintels for brick |
| `bayWidth` | 2.73 | 1 to 12 m | target bay width |
| `window`, `sill` | [1.69, 1.17], 0.9 | 0.3 to 6 m; 0 to 3 m | window size; sill over its floor |
| `windowKind` | `sliding` | `sliding`, `double-hung`, `strip` | sash type |
| `sideWindows` | true | | windows on the end sides |
| `door`, `doors` | [0.9, 2.1], [-1] | 0.6 to 8 m; bay indices, -1 the middle | door size and which front ground floor bays hold one |
| `storefront`, `awning` | false, false | | shop windows over a bulkhead with transoms; a canvas awning |
| `porch`, `porchWidth` | 0, 1 | 0 to 5 m; 0.2 to 1 | front porch depth and width share |
| `balcony`, `balconyFloor`, `balconyWidth` | 0.91, 1, 0.6 | 0 to 3 m; 1 to 59; 0.2 to 1 | front balcony |
| `chimney`, `chimneyAt` | false, [0.4, 0] | -0.9 to 0.9 each | a chimney and its place as shares of the half width and depth |
| `gutters`, `cornerBoards`, `casings`, `bands`, `cornice`, `brackets` | true, false, false, false, false, false | | trim |
| `detail` | `mid` | `far`, `mid`, `near` | small geometry |
| `interior` | `rooms` (`cells` at `far`) | `rooms`, `cells`, `none` | what stands behind the windows |
| `stairs` | true | | stairs between the storeys of furnished rooms, with their wells and guards |
| `fixtures` | true | | kitchen, bathroom and toilet rooms with their fixtures |
| `softFurnishings` | true | | tatami, rugs, curtains, bedding and cushions in homes |
| `origin`, `yaw`, `seed` | [0, 0, 0], 0, 1 | | placement and the seed of small differences |

Measured sizes the tests hold (packages/procedural/test/building-rules.test.js): Japan's Building Standard Law
Enforcement Order art. 21 (2.1 m ceilings), art. 22 (a wooden floor 45 cm over the ground) and art. 126 (a 1.1 m
balcony railing); tile roofs at 4 sun or steeper (JIS A 5208 J-shape tiles, 265 by 235 mm a tile); the International
Residential Code R311.7.5 (risers at most 7 3/4 in, treads at least 10 in) and R1003.9 (a chimney 3 ft over where it
leaves the roof and 2 ft over any roof within 10 ft); 1910 ceilings of 8 1/2 to 9 ft, roofs of 6 to 12 in 12 and
commercial ground floors of 12 to 15 ft. A wrong type throws a `TypeError`, a value out of range a `RangeError`.

Sources: Wonka, Wimmer, Sillion and Ribarsky 2003, "Instant Architecture" (https://doi.org/10.1145/882262.882324);
Mueller, Wonka, Haegler, Ulmer and Van Gool 2006, "Procedural Modeling of Buildings"
(https://doi.org/10.1145/1141911.1141931); Aichholzer, Aurenhammer, Alberts and Gaertner 1995, "A Novel Type of
Skeleton for Polygons" (https://doi.org/10.3217/jucs-001-12-0752); Kelly and Wonka 2011, "Interactive Architectural
Modeling with Procedural Extrusions" (https://doi.org/10.1145/1944846.1944854); Parish and Mueller 2001, "Procedural
Modeling of Cities" (https://doi.org/10.1145/383259.383292).

Behind the windows, `interior` builds `rooms` (the default at `mid` and `near`): each storey is split into rooms two
ken or 12 ft wide on the bay lines, with partition walls and doorways (fusuma openings of 0.86 by 1.8 m, or 32 by 80 in
doors) and furnishing blocks of the period (chabudai, zabuton and tansu; table, chairs, sideboard, bed and wardrobe; a
shop counter and shelves; office desks; stacked crates), each placed only where it blocks no window, doorway or door.
`cells` (the default at `far`) builds one five-faced room cell behind each window instead, the cell that interior
mapping traces (van Dongen 2008) made as geometry, ten triangles a window; `none` keeps the inner wall faces and
floors only. The result lists `rooms` (use, floor rectangle, level, clear height, area), `furniture` (kind and box),
`doorways` and `stairs`, all in local metres.

Between the storeys of furnished rooms stands a stair: a dog-leg of two flights and a half landing, stacked from floor
to floor (or, between two floors where that does not fit, one straight flight), with treads, risers, stringers, a
handrail with balusters, the floor above open over it and a guard round the well. Its steps keep the International
Residential Code R311.7 (36 in wide, risers at most 7 3/4 in, treads at least 10 in, 6 ft 8 in of headroom) and R312
(a guard of at least 36 in with openings under a 4 in sphere), or Japan's Building Standard Law Enforcement Order
art. 23 (concrete public buildings 0.9 or 1.2 m wide with risers of 0.18 m at most; wooden houses 0.78 m wide with
0.21 m), the going set by Blondel's rule. It stands in one room on every floor, with a way past it, clear of doorways
and outer doors, and clear of the windows where the plan allows (else it passes one, as a stair window does). A
partition that would run into an outer door stops 1.2 m short of it, leaving an entry.

Every storey is reached. Where no room holds the stair, partitions come down to make a stair hall. A plan too small for
that gets a `spiral` stair (IRC spiral stairways: 26 in wide, treads at least 6 3/4 in at 12 in from the narrow edge,
risers at most 9 1/2 in; in Japan art. 23, measured 30 cm from the narrow end), and one too small for a spiral a fixed
`ladder` through hatches (US 29 CFR 1910.23: 16 in between the rails, rungs at most 14 in apart, rails 42 in above the
floor). Each entry of `stairs` gives its `kind`, footprint, and the `foot` and `head` points where a walker steps on
and off.

With `fixtures`, a home's ground floor (a shop block's first floor) has a kitchen at the back (a fitted counter with
sink, hob and a refrigerator in the 2011 house; a cast iron range with its flue, a legged sink and an ice box in 1910)
and a bathroom (tub, water closet and washbasin, the 1910 closet with a high tank), upstairs when the ground floor has
only two rooms; a concrete public building has a toilet room on each floor. A fixture keeps clear floor in front of it,
and a water closet the room beside it that IRC R307.1 asks for. With `softFurnishings`, Japanese homes are laid with
Edo-ma tatami (no four corners meeting) and sleep on futons, western homes have a rug and made beds with pillows and
blankets, and the windows of living rooms and bedrooms have a pair of curtains. Nothing taller than a sill stands
before a window.

```ts
import {generateBuilding} from 'margoengine/procedural/building-rules';
const house = generateBuilding({style: 'western-1910-house'});
console.log(house.rooms.length, house.furniture.some((f) => f.kind === 'range')); // 8 true
console.log(house.stairs[0].kind, house.stairs[0].risers, house.parts.stairs !== undefined); // dog-leg 16 true
```

Sources for the interiors: Blondel 1675-1683, Cours d'architecture; Merrell, Schkufza, Li, Koltun and Agrawala 2011,
"Interactive Furniture Layout Using Interior Design Guidelines" (https://doi.org/10.1145/2010324.1964982); Germer and
Schwarz 2009, "Procedural Arrangement of Furniture for Real-Time Walkthroughs"
(https://doi.org/10.1111/j.1467-8659.2009.01351.x); International Code Council 2021, International Residential Code,
R307.1, R311.7 and R312; Japan, Building Standard Law Enforcement Order, art. 23.

## City generator (`@margoengine/procedural/city`)

`generateCity(options)` plans a whole town from one seed: streets and avenues in a `grid`, `organic` or `radial`
layout, the blocks between them, parks and land use by distance from the centre, lots along the streets, the options of
one rule-built building per lot and places for street trees and lamps. It is plain data in metres, Y up, and the same
options give the same city. `buildCity(city, options)` turns it into meshes merged by material and by square chunk:
road surface, lane lines, zebra crossings, kerbs, pavements, ground, trees, lamps and every building at a level of
detail set by its distance from `focus`.

```ts
import {generateCity, buildCity} from 'margoengine/procedural/city';

const city = generateCity({layout: 'radial', width: 300, depth: 300, seed: 5});
const meshes = await buildCity(city, {focus: [0, 0]});
console.log(city.blocks.length > 10, city.buildings.length > 100, meshes.parts.length > 50); // true true true
```

Drawing it is one mesh per part:

```ts
import {createStage, Geometry, PbrMaterial} from 'margoengine';
import {generateCity, buildCity} from 'margoengine/procedural/city';
import {addShadows} from 'margoengine/stage/shadows';

const app = await createStage('#scene', {camera: {position: [230, 150, 250], target: [0, 0, 10], near: 1, far: 3000}});
const {parts} = await buildCity(generateCity({seed: 3}), {focus: [60, 60]});
for (const {geometry, material} of parts)
  app.engine
    .createMesh()
    .setGeometry(new Geometry(geometry.positions, geometry.normals!, geometry.indices!))
    .setMaterial(new PbrMaterial({...material, doubleSided: false}));
await addShadows(app);
```

| `generateCity` option | Default | Range | Meaning |
| --- | --- | --- | --- |
| `width`, `depth` | 400, 400 | 60 to 4000 m | size between the middles of the edge streets |
| `outline` | none | convex, 3 to 64 corners | the town's shape instead of a rectangle |
| `layout` | `grid` | `grid`, `organic`, `radial` | street pattern |
| `blockWidth`, `blockDepth` | 90, 60 | 30 to 500 m | target block size |
| `angle` | 0 | +/-2pi | turn of the grid or first spoke |
| `irregularity` | 0.25 | 0 to 1 | how uneven streets and lots are |
| `streetWidth`, `avenueWidth` | 8, 16 | 4 to 30 m; street width to 60 m | kerb to kerb |
| `avenueEvery` | 4 | 0 to 100 | every this many streets or rings is an avenue; `organic`: the first cuts; 0 none |
| `spokes` | 8 | 3 to 24 | `radial` spoke streets |
| `sidewalk`, `curb` | 2.5, 0.15 | 0 to 8 m; 0 to 0.5 m | pavement width and height |
| `lotFrontage`, `lotDepth` | 18, 26 | 6 to 200 m; 8 to 120 m | target lot (downtown 1.4, houses 0.8, industry 2 times the width) |
| `setback`, `spacing` | 2 for houses else 0; 0 downtown else 1 | 0 to 20 m | smallest gap to the street; between neighbours |
| `centre`, `downtownRadius` | middle; 0.22 of the smaller size | inside the outline; 0 to 4000 m | where downtown is and how far it reaches |
| `minStoreys`, `maxStoreys` | 2, 24 (4 in 1910) | 1 to 60 | downtown and commercial heights, tallest at the centre |
| `parks`, `industry` | 0.08, 0.15 | 0 to 1 | share of blocks that are parks; share of the outer ring that is industry |
| `era` | `modern` | `modern`, `western-1910` | the building styles |
| `styles` | by era | weights per use | replaces the styles of a use, for example `{residential: {'western-1910-house': 1}}` |
| `treeSpacing`, `lampSpacing` | 11, 30 | 0 (none) or 1 m up | street furniture |
| `origin`, `seed`, `signal` | `[0, 0, 0]`, 1, none | | world position of the zero point; the town drawn; abort |

The result lists `nodes` and `roads` (each with its two nodes, width, `avenue` or `street` and length), `blocks` (kerb
and inner polygons, use, centre, area), `lots` (a `BuildingLot` with its polygon, so `townBuildings` takes them too),
`buildings` (options for `generateBuilding`), `trees`, `lamps` and the asphalt `edge`. Porches, steps, balconies and
eaves stay inside their lot.

| `buildCity` option | Default | Meaning |
| --- | --- | --- |
| `detail` | `auto` | `auto`, or one of `massing`, `far`, `mid`, `near` for every building |
| `focus`, `distances` | the centre; `[25, 70, 260]` | `auto`: nearer than each distance takes near, mid, far; past the last, massing |
| `chunk` | 120 m | mesh chunk size, so a renderer can cull |
| `markings`, `furniture` | true, true | lane lines and crossings; tree and lamp meshes |
| `variants` | 4 | wall colours per style, 1 to 8 |
| `maxTriangles` | 20,000,000 | stops with a `MargoError` past it |
| `onProgress`, `signal` | none | called per building; abort |

The work yields to the event loop about every 12 ms. On a rebuild around a moving camera, call `buildCity` again with
the new `focus`. The ground is flat and the roads are straight; see [limits](../../docs/limits.md). The sliders are
`CITY_SETTINGS`, `citySettingDefaults` and `cityOptionsFromSettings` of `@margoengine/procedural/building-settings`.

The method follows Parish and Müller, [Procedural Modeling of Cities](https://doi.org/10.1145/383259.383292)
(SIGGRAPH 2001: streets, blocks, lots, buildings by land use and distance); Chen, Esch, Wonka, Müller and Zhang,
[Interactive Procedural Street Modeling](https://doi.org/10.1145/1360612.1360702) (ACM TOG 2008: grid and radial
patterns, major and minor roads); Yang, Wang, Vouga and Wonka,
[Urban Pattern: Layout Design by Hierarchical Domain Splitting](https://doi.org/10.1145/2508363.2508405) (ACM TOG 2013:
streets as recursive cuts); and Vanegas, Kelly, Weber, Halatsch, Aliaga and Müller,
[Procedural Generation of Parcels in Urban Modeling](https://doi.org/10.1111/j.1467-8659.2012.03047.x) (CGF 2012: lots
from the oriented box, each on a street).

## Joined plans, dormers and towers (`@margoengine/procedural/building-plans`)

`generateBuildingPlan(options?)` builds a house or hall on an `L`, `T`, `U` or `cross` plan (or `rect`), from the
building rules: the main block takes every `generateBuilding` option, each wing is a block of its own (`wingWidth`,
`wingLength`, `wingSide`, or `wings` given by hand with `at` and `turn`), `dormers` stand on the main roof's long
slopes (`gable`, `shed` or `hip`, each with a glazed window sized to the IRC escape opening and a sill over the 4 in
step flashing), and a `tower` rises at a corner with a pyramid roof. The blocks are joined: every part of a block that
lies inside another block (under its roof, or in its roof slab past the walls) is cut away, so roofs meet in valleys
where their planes cross (45 degrees in plan between equal pitches), walls open into each other at the junction, the
main roof is cut open behind each dormer, and nothing hidden is left to draw. A dormer is left out where a wing or the
tower already covers that part of the slope, or where the roof is too low for one.

Every storey is reached on foot. The main block's stair serves the floors it shares; a tower that climbs higher is a
stair tower, entered from the main block, with the whole stack of its flights inside it; a wing given by hand that has
floors the main block lacks, or stands apart from it, gets its own stair (a wing's own `stairs` option overrides
this). Where every ground floor door is inside another block, the tower or a wing gets a door.

A wing given by hand with its own `plinth` or `storeys` may stand at other floor levels than the main block. A change of
one riser or less stays an open step. A larger one is walled, with a doorway and a flight of steps at the join wherever
one fits under the ceiling (`joinSteps`): risers at most 7 3/4 in, treads at least 10 in and 36 in wide in the western
sets (International Residential Code 2021, R311.7, with a handrail from four risers and a guard over 30 in), and at
most 23 cm, 15 cm and 75 cm or more in the Japanese ones (Order art. 23), the house and concrete sets using their own
narrower limits. Between two ground floors a flight is sunk into the higher floor where the lower ceiling is too low to
climb under. Where no flight fits, the join is walled off and the wing gets its own door, so no floor ends in an open
ledge. Furniture keeps off the steps and their landings.

```ts
import {generateBuildingPlan} from 'margoengine/procedural/building-plans';
const split = generateBuildingPlan({style: 'western-1910-house', width: 12, depth: 8, storeys: [3.2, 3.2],
  wings: [{at: [6.5, 0], width: 5, depth: 6, plinth: 0.2, storeys: [2.9, 2.9]}]});
console.log(split.joinSteps.map((s) => `${s.risers} risers to ${s.to.toFixed(2)} m`)); // [ '3 risers to 0.60 m' ]
```

It returns `{parts, palette, blocks, top, openings, dormers, rooms, furniture, doorways, stairs, joinSteps,
roofHeight(x, z), insideBlock(i, x, y, z)}` with the same parts and palette as `generateBuilding`; `roofHeight` is the upper envelope of
the blocks' roofs. `BUILDING_PLAN_SETTINGS` and `buildingPlanOptionsFromSettings` in
`@margoengine/procedural/building-settings` are its slider rows.

```ts
import {generateBuildingPlan} from 'margoengine/procedural/building-plans';
const farmhouse = generateBuildingPlan({style: 'western-1910-house', plan: 'L', wingSide: 'back', ridge: 'x', width: 11, depth: 8, dormers: 2});
console.log(farmhouse.blocks.map((b) => b.kind).join(' ')); // main wing dormer dormer
```

## Period vehicles (`@margoengine/procedural/vehicles`)

A 1910 steam locomotive and tender, 1910 freight cars, a 1910 touring car, a Japanese kei truck and a Japanese drink
vending machine, built from published dimensions. Each returns `parts` (one geometry per material), a `palette` of
material hints and its measured `size` [length, width, height]; +x forward, +y up, the rail top or ground at y = 0.

- `generateLocomotive({arrangement, driver, stack, tender, fuel})`: Whyte `2-8-0` (default, a Consolidation with 52 in
  drivers on a 15 ft driving wheelbase), `4-4-0`, `2-6-0` or `4-6-0` on standard gauge (1.435 m, wheel back-to-back
  1.356 m, 1 in flanges), a diamond or straight stack about 15 ft above the rail, domes, bell, headlight, rods and
  crossheads, air pump, cab and a tender of cordwood or coal on two arch bar trucks. Returns `wheels` (every wheel
  set's x, diameter and kind), `drivingWheelbase`, `gauge`, `backToBack`, `coupler` (34 in) and `length` over the
  couplers. Everything stays inside AAR Plate B (10 ft 8 in by 15 ft 6 in).
- `generateWagon({kind, length, seed})`: `boxcar` (default, the 36 ft MCB box car), `flatcar`, `log-car` (logs chained
  between stakes) or `gondola` (heaped coal), with truss rods, grab irons, a brake wheel and two arch bar trucks of
  5 ft wheelbase on 33 in wheels.
- `generateTouringCar({top})`: a five seat touring car in the manner of the 1910 Ford Model T: 100 in wheelbase, 56 in
  track, 30 in artillery wheels, brass radiator and lamps, a folding top `up` or `down`.
- `generateKeiTruck({gates, color})`: a cab-over kei truck at the Suzuki Carry DA63T's catalogue sizes (3,395 by 1,475
  by 1,765 mm, inside the kei class's 3.40 by 1.48 by 2.00 m without the door mirrors), 145R12 tyres, a 1.94 by 1.41 m
  bed at 0.65 m with 0.29 m drop sides `closed` or `open`, and a guard frame.
- `generateVendingMachine({width, rows, seed})`: an outdoor drink machine 1.83 m high and 0.72 m deep, sample cans and
  bottles in a lit window, a button under each, and the coin slot, bill slot and change return inside the ADA 2010
  forward reach (0.381 to 1.219 m).
- `VEHICLE_SETTINGS`, `vehicleSettingDefaults()` and `vehicleOptionsFromSettings(values)`: slider rows on the shared
  shape (`locomotive.arrangement`, `wagon.kind`, `kei.gates` and the rest) and their mapping to each generator.

```ts
import {generateKeiTruck, generateLocomotive, generateWagon, vehicleBounds} from 'margoengine/procedural/vehicles';
const engine = generateLocomotive();
console.log(engine.arrangement, engine.wheels.length, engine.drivingWheelbase.toFixed(2)); // 2-8-0 9 4.56
const truck = generateKeiTruck({gates: 'open'});
const body = vehicleBounds(truck.parts, ['cab']);
console.log((body.hi[1] - body.lo[1]).toFixed(2), Object.keys(truck.parts).length); // 1.34 10
console.log(generateWagon({kind: 'log-car'}).wheels.length); // 4
```

Sources: Whyte's wheel notation (1900); Master Car Builders' Association standards (gauge, back-to-back, flange, coupler
height, the 1910 box car) and AAR Plate B; Forney 1906, *Locomotive Dictionary*, and Baldwin Locomotive Works record
cards 1905-1912; Ford Motor Company Model T specifications 1909-1910; Japan's Road Transport Vehicle Act kei class and
the Suzuki Carry DA63T catalogue; ADA Standards 2010, 308.2.1.

## Harbour pieces (`@margoengine/procedural/harbour`)

Sea walls, tetrapods, quays, breakwaters, slipways, mooring posts and a coastal fishing boat. Walls, quays and
breakwaters run along +x with the sea on +z; heights are metres above sea level (y = 0).

- `generateTetrapod({mass, segments})`: four truncated cone legs on tetrahedral axes, one straight up; the size follows
  the mass (2.3 t/m3) and the Shore Protection Manual's V = 0.28 H^3. Returns `{geometry, height, volume, mass, legs,
  centre}`.
- `placeTetrapods({mass, length, slope, crest, toe, crestWidth, z, layers, placement, seed})`: one or more layers of
  tetrapods on a slope (cot) and crest, at n k_D (1 - P) / V^(2/3) units per m2 (k_D 1.04, P 50 %). With
  `placement: 'settled'` (the default) each unit is lowered over its spot, from the toe up and layer by layer, in the
  placing attitudes it tries (standing on three legs, or turned over with a leg down between the units under it) and
  rests on the bed or the units under it, none overlapping; `settling` reports the least clearance, the units at rest,
  and the layer thickness and porosity measured on the units (the default armour measures 3.73 m against the Shore
  Protection Manual's 3.39 m, porosity 56 % against 50 %). `placement: 'pattern'` sets randomly turned units on the
  layer lines instead (fast, for far views; units may cross). Returns instance `matrices` for one tetrapod mesh,
  `count`, `area`, `density`, the layer `thickness` (n k_D V^(1/3)), `placement` and `settling`.
- `generateSeaWall({length, crest, toe, land, crown, batter, landBatter, recurve, joints, stairs, toeTetrapods, detail})`:
  a gravity concrete wall, default 6 m (the Sanriku coast walls stand 5 to 10 m), with a recurved wave return,
  expansion joints, land side stairs with handrails and an optional row of toe tetrapods. Parts `concrete`, `trim`,
  `stairs`, `rails`.
- `generateQuay({length, width, crest, bottom, bollards, fenders, ladders, detail})`: a block quay with a kerb, bollards
  every 15 m, rubber fenders and ladders. Parts `concrete`, `kerb`, `bollards`, `fenders`, `ladders`.
- `generateBreakwater({length, crest, bottom, crestWidth, slope, harbourSlope, armour, crownWall, seed})`: a rubble
  mound core, a crown wall and two layers of tetrapods on the seaward slope (`armour` instances).
- `generateSlipway({width, top, foot, gradient, detail})`, `generateMooringPost({height, radius, segments})`.
- `generateFishingBoat({length, beamRatio, draft, freeboard, bulwark, wheelhouse, mast, lamps, stations, seed})`: a
  V-bottom FRP coastal boat, 14.5 m by default, length to beam about 4.1, with a flared raked bow, transom, bulwark,
  wheelhouse with windows all round, mast and stay, rubbing strake and an optional row of fishing lamps. The hull below
  the waterline is its own part (`bottom`, for antifouling); origin on the waterline at midships, bow toward +x.

```ts
import {generateFishingBoat, generateSeaWall, generateTetrapod, placeTetrapods} from 'margoengine/procedural/harbour';
const wall = generateSeaWall({length: 200, crest: 6});
const armour = placeTetrapods({mass: 20, length: 120});
console.log(wall.crest, generateTetrapod({mass: 20}).height.toFixed(2), armour.count); // 6 3.14 420
console.log(armour.placement, armour.settling!.minGap >= 0); // settled true
const boat = generateFishingBoat();
console.log((boat.length / boat.beam).toFixed(2), Object.keys(boat.parts).length); // 4.08 7
```

Sources: US Army Corps of Engineers 1984, *Shore Protection Manual*, vol. II ch. 7 (tetrapod volume, armour layer
thickness, placing density and slopes); US Army Corps of Engineers 2002, *Coastal Engineering Manual* EM 1110-2-1100,
part VI ch. 5 (rubble mound and seawall sections); CIRIA, CUR and CETMEF 2007, *The Rock Manual* C683, ch. 6 and 9
(placing armour from the toe up); Visscher and Bolsterli 1972, "Random packing of equal and unequal spheres in two and
three dimensions", Nature 239, 504-507 (https://doi.org/10.1038/239504a0); Jodrey and Tory 1985, "Computer simulation of
close random packing of equal spheres", Phys. Rev. A 32, 2347 (https://doi.org/10.1103/PhysRevA.32.2347); Mirtich 1996,
*Impulse-based Dynamic Simulation of Rigid Body Systems*, PhD thesis, UC Berkeley (conservative advancement); Danel 1953, "Tetrapods", Proc. 4th Coastal Engineering Conference
(https://doi.org/10.9753/icce.v4.28); Gulbrandsen 2004, *Fishing Boat Designs: 2. V-bottom Boats*, FAO Fisheries
Technical Paper 134 rev. 2; Fyson (ed.) 1985, *Design of Small Fishing Vessels* (FAO / Fishing News Books).

## Building and harbour sliders (`@margoengine/procedural/building-settings`)

`BUILDING_SETTINGS` and `HARBOUR_SETTINGS` are slider rows on the shared shape (name, group, kind, default, range,
step, unit, about, live). None is live: each rebuilds geometry. `buildingOptionsFromSettings(values)` and
`harbourOptionsFromSettings(values)` turn a panel's values into generator options, setting only the names given so the
chosen style keeps its own defaults; `buildingSettingDefaults()` and `harbourSettingDefaults()` give a fresh panel.
`CITY_SETTINGS`, `citySettingDefaults()` and `cityOptionsFromSettings(values)` do the same for `generateCity`.

```ts
import {buildingOptionsFromSettings} from 'margoengine/procedural/building-settings';
import {generateBuilding} from 'margoengine/procedural/building-rules';
const block = generateBuilding(buildingOptionsFromSettings({style: 'western-1910-brick', storeys: 2, cornice: 'on'}));
console.log(block.floors.length); // 2
```

## Northern Rockies conifers (`@margoengine/procedural/conifers`)

Western white pine, western larch, western red cedar, Douglas-fir and grand fir, the timber of the 1910 Big Burn country,
at any age, live, as snags or fire-killed. Sizes are measured forestry, not guesses: height and diameter follow the
Wykoff height-diameter equation, crown width Crookston's crown width equation (both with the Inland Empire coefficients
of the Forest Vegetation Simulator), the live crown ratio falls with age and rises with shade tolerance (larch shortest,
cedar longest), and the branches stand in annual whorls on the species' height growth curve, wide apart low on the stem
and close at the top of an old tree (cedar spirals, its branches sweep down and up, its leader nods). Bark ridges are as
deep as the species' bark (thick plated larch and furrowed Douglas-fir, thin white pine) and the butt flares (cedar's
buttress most).

- `coniferForm(species, {age, height, basalArea})` (also in `/conifer-species`, a small data entry): `{height, dbh,
  crownRatio, crownLength, crownBase, crownWidth, whorlSpacing, barkThickness}` in metres. `age` is years or
  `'sapling'` (15), `'pole'` (40), `'mature'` (100, the default) or `'old'` (250).
- `generateConiferMesh(species, {age, height, basalArea, detail, condition, seed})`: `{trunk, canopy, form, whorls}`,
  standing on y = 0. `detail` 2 (near: limbs, sprays and cross bands, at most about 12,000 triangles), 1 (middle, about
  1,000) or 0 (crown tiers). `condition` `'live'`, `'snag'` (broken top, branch stubs, no needles) or `'burnt'`
  (bare limbs, a fire scar at the butt).
- `generateConiferImposter(mesh, {size, needles, bark, cards})`: three crossed cards and an RGBA image of the tree's
  silhouette baked side on (needles and bark, darker deeper in the crown, alpha the coverage); the right half of the
  image is the needle colour solid, for the nearer levels (`solidUv`).
- `coniferLevels(species, options)`: the three scatter LOD rings, near, middle and imposter, with the canopy's
  `textures` (draw the canopy white: its colour is in the image). Dead trees draw their stem at detail 0 far out.
- `parseConiferKey(key)`: what a biome mesh key names. `@margoengine/biomes` draws `procedural:<species>`,
  `procedural:<species>/<age>`, `procedural:<species>/snag`, `procedural:<species>/burnt`, `procedural:conifer-snag`
  and `procedural:burnt-trunk` with these levels; the rockies presets use the `/pole` keys. Each part takes the wind and
  the burnt and flooded plant states like any other.

### Textured fir foliage

`@margoengine/procedural/fir-sprays` builds near, middle and far foliage meshes around a fir's stem. Give the generator
normalized rectangles from a needle-spray atlas and use that atlas as a masked material. UVs run from the stem at the
bottom to the tip at the top of each rectangle. The rings share whorl heights and main branch directions. A denser near
mesh adds side sprays and curved sections. The far ring thins the lower whorls and keeps the crown tip.

```ts
import { generateFirSprayLevels } from '@margoengine/procedural/fir-sprays';

const [near, middle, far] = generateFirSprayLevels({
  height: 12,
  crownBase: 3.5,
  radius: 2.1,
  regions: [[0, 0, 0.5, 1], [0.5, 0, 1, 1]],
});
console.log(near.uvs.length, middle.indices.length, far.indices.length);
```

Dimensions are in metres. The defaults are 18.64 m tall with a 5.5 m crown base and 3.29 m radius.
Base and radius scale with height when omitted. The seed (default 730956) sets the branch directions and atlas
selection. A missing atlas layout uses the full texture. The entry creates geometry and leaves textures and placement
to the caller. Its branching follows the whorled fir growth descriptions in Burns and Honkala,
[Silvics of North America](https://www.srs.fs.usda.gov/pubs/misc/ag_654/table_of_contents.htm) (1990).
The textured levels draw on Fabrice Neyret's
[Rendering Forest Scenes in Real-Time](https://doi.org/10.2312/EGWR/EGSR04/093-102) (2004) and Éric Bruneton and
Fabrice Neyret's [Real-Time Realistic Rendering and Lighting of Forests](https://doi.org/10.1111/j.1467-8659.2012.03016.x) (2012).

```ts
import {coniferLevels, generateConiferMesh, parseConiferKey} from 'margoengine/procedural/conifers';
const fir = generateConiferMesh('douglas-fir', {age: 'mature'});
console.log(fir.form.height.toFixed(1), (fir.form.dbh * 100).toFixed(0), fir.form.crownWidth.toFixed(1)); // 28.6 55 6.9
const larch = coniferLevels('western-larch', {age: 'pole'});
console.log(larch.canopy.length, larch.textures?.baseColor.width); // 3 256
console.log(parseConiferKey('procedural:western-red-cedar/old')?.age); // old
```

`CONIFER_SETTINGS` (`@margoengine/procedural/conifer-settings`) are the slider rows on the shared shape (species, age,
basal area, condition, seed, imposter size; all rebuild); `coniferOptionsFromSettings(values)` gives the species and
the options.

```ts
import {coniferOptionsFromSettings} from 'margoengine/procedural/conifer-settings';
const {species, options} = coniferOptionsFromSettings({species: 'grand-fir', age: 250, condition: 'snag'});
console.log(species, options.age, options.condition); // grand-fir 250 snag
```

Sources: Wykoff, Crookston and Stage 1982, *User's guide to the Stand Prognosis Model*, USDA Forest Service INT-GTR-133;
Keyser (comp.), *Inland Empire (IE) Variant Overview, Forest Vegetation Simulator*, USDA Forest Service (Tables 4.1.1,
4.1.2 and 4.4.1; Crookston 2003 crown width); Burns and Honkala (tech. coords.) 1990, *Silvics of North America, Vol. 1,
Conifers*, Agriculture Handbook 654; Minore 1979, *Comparative autecological characteristics of northwestern tree
species*, PNW-GTR-87; Kozak 1988, "A variable-exponent taper equation", Can. J. For. Res. 18(11); Richards 1959, "A
flexible growth function for empirical use", J. Exp. Bot. 10(2); Hallé, Oldeman and Tomlinson 1978, *Tropical Trees and
Forests*; Décoret, Durand, Sillion and Dorsey 2003, "Billboard clouds for extreme model simplification", ACM TOG 22(3).

## The 1903 Wright Flyer and its four flights (`@margoengine/procedural/flyer`)

`generateWrightFlyer(options?)` builds the 1903 Wright Flyer from its published dimensions: double-covered cambered
wings (camber 1 in 20, peaking at 30 % of the chord) with the tips drooped 10 in, the struts between them, two skids
running forward and up to the biplane elevator, twin rudders behind, a rib every foot over and under each wing, the
crossed bracing wires in every bay, the engine right of centre (crankcase, four forward-pointing cylinders, flywheel,
sprocket, the upright flat-tube radiator and the fuel tank) with its chains and chain tubes, the pilot's hip cradle
left of centre and two pusher propellers 8 ft 6 in across. Each part is its own `GeometryData` so fabric, wood and
metal get their own materials: `wings`, `frame`, `ribs`, `wires`, `engine`, `cradle`, and the
moving parts `elevator`, `rudder` and `propellers` as `{geometry, pivot, axis}` (each propeller adds `spin` about +Z, -1 for
the left and +1 for the right: they turn opposite ways, each with blades pitched to pull the Flyer forward when it turns
its own way). The Flyer's own space is glTF's: +Z forward (the elevator end), +Y up and the skids' lowest point on
y = 0, so the prone pilot's right is -X. The engine sits at -X, right of the pilot as in 1903; the cradle, `pilot`
(where a prone pilot lies) and the left propeller (`propellers[0]`) are at +X.

`wrightFlightPose(n, t, options?)` is the pose of flight `n` (1 to 4) at `t` seconds after release: the run of about
40 ft on the 60 ft rail, uniformly accelerated to the flight's groundspeed; in the air a nearly level flight, as the
1903 photograph shows it: the skids ease up off the rail over 4 s to a band just under the flight's height (about
10 ft), undulate gently in it every 3 s or so (the "up and down" course of the diaries; damped on the long fourth
flight) and ease down to the sand over the last 2.5 s; pitch is a 4 degree angle of attack plus the climb angle
through the air (at most about 9 degrees, no hard nose-high climb) and the wings rock at most 1.1 degrees (no bank);
then a short slide. It returns `{position, pitch, roll,
elevator, propeller, phase, duration}`; `position` is `[0, height of the skids, distance from the rail's start]`.
`WRIGHT_FLIGHTS_1903` holds the flights (120 ft in 12 s, 175 ft in 12 s, 200 ft in 15 s, 852 ft in 59 s) and
`WRIGHT_RAIL` the rail.

The film's other parts: `lever` is the elevator hand lever at the pilot's left hand (a moving part about +X through its
foot; turn it with the elevator), and `restraint.tie` the point at the rear of the skids where the restraining wire was
hooked. `restrainingWire(tie, stake, slack?, ground?, segments?)` draws that wire to a stake as steel segments: `slack`
0 taut (held before release), 1 hanging an eighth of its length at the middle (let go), lying on `ground` where it would
dip below it. `generateWrightFlyer({wrecked: true, seed?})` is the Flyer after the gust of 17 December: about a third
of the right wings' ribs broken out, the right panels crushed down and swept back, outer uprights and the right
propeller snapped, the engine tipped 14 degrees and slid back on its bed with its chain tubes; the same seed gives the
same wreck. `wrightGustRoll(t, options?)` is that gust: the left wing lifts over `lift` seconds (1.2), then the Flyer
turns over its right tip `turns` times (1) in `seconds` (4), its centre at half the span times |sin roll| above the
sand, carried sideways and drifting back; it returns `{position, pitch, roll, yaw, phase, duration}` in the Flyer's
own axes (`phase` standing, rolling or rest).

```ts
import {generateWrightFlyer, wrightFlightPose, wrightGustRoll, restrainingWire, WRIGHT_FLIGHTS_1903} from 'margoengine/procedural/flyer';
const flyer = generateWrightFlyer();
const pose = wrightFlightPose(1, 12);
console.log(flyer.size[0].toFixed(2), flyer.propellers[0].spin, pose.phase, WRIGHT_FLIGHTS_1903.length); // 12.29 -1 air 4
const wreck = generateWrightFlyer({wrecked: true});
const wire = restrainingWire(flyer.restraint.tie, [0, 0.25, flyer.restraint.tie[2] - 3], 1, 0);
console.log(wrightGustRoll(10).phase, wreck.ribs.indices.length < flyer.ribs.indices.length, wire.indices.length > 0); // rest true true
```

| Option | Default | Range | Meaning |
| --- | --- | --- | --- |
| `span` | 12.29 | 4 to 30 m | wingspan (40 ft 4 in) |
| `chord`, `gap` | 1.98, 1.88 | 0.5 to 5 m | wing chord (6 ft 6 in) and the gap between the wings (6 ft 2 in) |
| `camber` | 0.05 | 0 to 0.15 | camber as a share of the chord |
| `droop` | 0.254 | 0 to 1 m | how far the tips sit below the centre |
| `propeller` | 2.59 | 0.5 to 5 m | propeller diameter |
| `segments` | 48 | 8 to 128 | spanwise segments of each wing |
| `wrecked` | false | | the Flyer as the gust of 17 December left it |
| `seed` | 1903 | | the wreck's broken ribs and crumpling |

Flight options: `wind` (12.07 m/s, 27 mph), `railTop` (0.2 m, the skids' height on the rail), `rpm` (350), `warmup`
(4 s of propeller turning before release). A value out of range or a flight that is not 1 to 4 throws a `RangeError`.
Limits: chains are plain runs (no links), the engine has no valve gear or pipework, wing warping is not modelled,
the wreck is a seeded deformation (normals are kept from the whole Flyer), the gust roll is a kinematic path, not a
simulation, and the flight path is a smooth fit to the recorded distances and times, not a flight simulation.

Sources: National Air and Space Museum, *1903 Wright Flyer*, object A19610048000
(https://airandspace.si.edu/collection-objects/1903-wright-flyer/nasm_A19610048000), span, length, height, weight and
the layout; National Park Service, *1903: The First Flight* (https://www.nps.gov/wrbr/learn/historyculture/thefirstflight.htm),
the wind, the rail, the distances and times and the first flight's groundspeed and airspeed; Jakab, P. L. 1990,
*Visions of a Flying Machine: The Wright Brothers and the Process of Invention* (Smithsonian Institution Press), chord,
gap, camber, droop and the propellers; Hobbs, L. S. 1971, *The Wright Brothers' Engines and Their Design*
(Smithsonian Annals of Flight 5), the engine's layout; McFarland, M. W. (ed.) 1953, *The Papers of Wilbur and Orville Wright*
(McGraw-Hill), Orville's diary of 17 December 1903; Daniels, J. T. 1903, *First flight, 120 feet in 12 seconds, 10:35
a.m.; Kitty Hawk, North Carolina* (Library of Congress, LC-DIG-ppprs-00626, https://www.loc.gov/pictures/item/00652085/),
the nearly level attitude a few feet over the sand at lift-off.

## Rectangular building shape grammar

The optional `@margoengine/procedural/buildings` entry applies a restricted,
declarative shape grammar: footprint -> floor splits -> four facade components ->
repeated equal bays -> centred window insets -> flat or gable roof. Changing simple
data changes the shell and its floor/bay scopes. It is not a general CGA parser.

```ts
import { createBuildingGenerator } from '@margoengine/procedural/buildings';

using buildings = await createBuildingGenerator();
const mesh = buildings.generate({
  width: 18, depth: 10, floorHeights: [4, 3, 3], bayWidth: 3,
  window: [0.55, 0.6], roof: 'gable', roofHeight: 2,
});
console.log(mesh.positions.length / 3, mesh.indices.length / 3, mesh.bays.length / 8);
```

Metres, Y up. Defaults: width12, depth8, origin[0,0,0] (bottom centre), yaw0,
floorHeights[3,3,3], bayWidth3, window[.55,.6], roof'flat', roofHeight2 (ignored
for flat), no signal. Width/depth .1..1000; bayWidth .1..1000; each side uses
ceil(length/bayWidth) equal bays, 1..256; at most4096 bays overall. Floor heights
are1..64 values of .1..100 with total<=5000; window fractions .05...95; gable rise
.1..100; origin coordinates +/-10000 and yaw +/-2pi. All numbers must be finite.

Positions are owned Float64 XYZ; normals Float32; indices Uint32; materials Uint8
per triangle (0 wall,1 window,2 roof/gables,3 base). Floors pack bottom/height;
bays pack floor,side,start,bottom,width,height,windowWidth,windowHeight. Facade
sides run +X at -Z, +Z at +X, -X at +Z, -Z at -X. Roof ridge runs along local Z.
Wall rings and flush panes partition the shell without overlapping faces. There
are no interior slabs, doors, wall thickness, collision data, UVs, arbitrary
footprints, recursive user productions or context/occlusion queries. Each planar
face shares its vertices, and every face is cut at the same bay, window, floor and
eave lines, so each edge meets exactly one opposite edge: no T junctions, and
welding by position gives a closed 2-manifold solid.

One lazy buildings.wasm; no import-time fetch. Independent of GPU resources and
identical on WebGPU/WebGL2 before and after loss. Synchronous generation checks
signal before work; use a worker for interruption. Dispose is idempotent and owned
outputs survive disposal. Errors are coded with help links. JS 1502 B gzip;
Wasm 38840 B raw / 15526 B gzip. Native and browser area/volume, partition,
ownership and hostile-input tests; real Montreal CityJSON supplies measured
envelope dimensions only. Generated facades and other controls remain stand-ins.
Two shared sine/cosine evaluations equal the per-vertex transform oracle with
fewer trig calls; no timing, SIMD gain or architecture-realism claim (LIM-642).

A downloaded real CMP facade photo and its annotation XML additionally calibrate
four windows in a 2x2 region. Measured floor splits preserve the row heights;
generated bounds agree within1.89 source pixels against the fixed2-pixel bar.
Source hashes, licence (publisher CC BY-SA, no version stated), measurements and
method are in test/fixtures/buildings/facade-reference.json. This limited calibrated
layout test does not recover the whole facade, its ornamentation or material.

## Cellular automata caves and islands

The optional `@margoengine/procedural/caves` entry generates seeded binary 2D or
3D grids. A synchronous Moore rule counts the 8 or 26 neighbours, excluding the
centre: state 0 becomes 1 at `birth` occupied neighbours, state 1 survives at
`survival` occupied neighbours. The defaults retain the previous state on a tie.
Interpret 1 as rock/land and 0 as floor/water. Caves have a fixed rock boundary;
islands have a fixed water boundary, including Z faces in 3D.

```ts
import { createCaveGenerator } from '@margoengine/procedural/caves';

using caves = await createCaveGenerator();
const cave = caves.generate({ width: 64, height: 48, seed: 7 });
const islands = caves.generate({ width: 64, height: 48, mode: 'islands', seed: 9 });
const volume = caves.generate({ width: 32, height: 32, depth: 32, seed: 7 });
console.log(cave.cells.length, islands.cells.length, volume.cells.length);
```

| Option | Default | Bounds and meaning |
| --- | --- | --- |
| width, height | 64, 48 | Integer 3..1024 cells each |
| depth | 1 | 1 for 2D, otherwise integer 3..256; total cells <= 1,048,576 |
| seed | 1 | Unsigned 32-bit, zero has its own stream |
| steps | 5 | Integer 0..64; total cells times steps <= 16,777,216 |
| fill | 0.45 | Probability of state 1, finite 0..1; validated but unused with initial |
| mode | caves | caves or islands; controls the fixed outermost cell layer |
| birth, survival | 5, 4 (2D); 14, 13 (3D) | Integer 0..8 or 0..26, inclusive thresholds |
| initial | absent | Optional owned Uint8Array, exact grid length, binary 0/1; copied and boundary replaced |
| signal | absent | Abort checked before synchronous generation; use a worker to interrupt in flight |

Owned `cells` index X fastest, then Y, then Z: `(z * height + y) * width + x`.
Zero steps returns initialization with the fixed boundary. The LCG advances once
per grid cell, including boundary cells: unsigned `1664525 * state + 1013904223`,
occupied when state / 2^32 < fill. There is no automatic component pruning, route
carving, connectivity, navigability, minimum land/floor area, chunk continuity,
meshing or guarantee that either state survives a selected rule. 3D controls are
stand-ins; no measured geological realism is claimed (LIM-643).

One lazy caves.wasm, no import-time work, no GPU required. Identical values on
actual WebGPU/WebGL2 before and after device/context loss. Dispose is idempotent;
owned maps survive disposal. Loading accepts AbortSignal; errors have codes and
help links. Real public-domain Natural Earth land polygons provide a Madagascar
mask tested against a separate scalar automaton, without claiming geographic
reconstruction. Its original bytes, source, hash and licence are test fixtures.
Separable integer sums reduce stencil input reads against a direct Moore stencil
with identical output; tiny grids select the direct stencil when cheaper. Counts
include intermediate and centre reads, exclude initialization, copies, allocation
and compilation. No elapsed-time, SIMD gain or rival-speed claim is made.

Caves entry: 1433 B min+gzip (ceiling 1680 B); caves.wasm 27405 B raw / 11564 B gzip. Core plus stage 25149 B gzip, strictly below 25150 B.

## Baked textures after a device restore

A baked texture (`WebGPUBakedTexture.texture`, and the four maps of a `PBRTextureSet`) is made by the baker on the device the baker was created
with, and you own it until you call `dispose()`. A baker ends when its device is lost: its next `bake` rejects with a `'failed'` error that says to
create a baker on the replacement device. After `engine.rebootDevice()` create a new baker from `engine` and bake again; nothing of the lost
device is carried over.

## Texture baker and WebGL2 tiers

`createTextureBaker` now has a native fragment route on the small `/preview` engine, added on main while the attachment contract was being checked. It stays on that tier without escalation. The full `webgl2-compat` layer reports `backend: 'webgpu'` and runs the compute route. `packages/webgl2-compat/test/package-tiers-browser.mjs` exercises both complete tiers and verifies the real preview route stays on WebGL2. The original no-device refusal was correct for the former GPU-only baker.
