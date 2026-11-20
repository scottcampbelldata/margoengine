# 1903 Wright Flyer (film asset)

- What: the Wright brothers' 1903 Flyer as it stood at Kill Devil Hills on 17 December 1903, for the animated film
  "Kitty Hawk: Twelve Seconds on the Sand". Hero model (LOD 0) and a wide-shot model (LOD 1).
- Made: 2026-11-17, by script, `build_flyer.py` with `../lib/kh_common.py`, in Blender 5.3.0 run headless
  (`blender -b --factory-startup --python build_flyer.py -- --lod 0`; `--lod 1` for the wide-shot model). No add-on is
  used; the exporter is Blender's bundled glTF 2.0 add-on (io_scene_gltf2) of Blender 5.3.0.
- Where: the asset files are never committed (Scott, 2026-11-16). They live in
  `Assets/blender-library/kitty-hawk/flyer-1903/` (two folders above the checkout): `flyer-1903.blend`, `flyer-1903.glb`,
  `flyer-1903-lod1.glb`, `textures\`, `previews\`, and copies of this file and the scripts. The repository holds only
  this LABEL.md and the scripts, under `examples/assets/blender-library/kitty-hawk/`.

## How it is built

Every part is generated from measurements: no sculpting, no other model, drawing file or code. The fabric surfaces
are one sheet per surface pair, wrapped round the leading edge, with the rib-to-rib sag of unsealed muslin (6 mm on
the upper skins, 4 mm on the lower), the scalloped trailing edge between rib tips, the wing's camber (1 in 20, peak at
0.3 chord) and its 10 in droop at the tips. Timber is swept along its centre line as rounded sections; castings are
turned profiles; the chains are separate links on 1/2 in pitch where they leave their guide tubes.

Nodes the engine can drive (glTF space: +Z forward, +Y up, starboard -X):

| Node | Motion |
| --- | --- |
| `propeller_right`, `propeller_left` | turn about local Z; `spin` extra = +1 / -1 (opposite ways, the left chain crossed) |
| `engine_crank` | flywheel and drive sprockets, about local Z, 23/8 times the propellers' rate |
| `elevator` | about local X (pitch) |
| `rudder` | about local Y (both rudders together) |
| `hip_cradle` | slides along X, about +-0.10 m |
| morph target `warp` | on `wing_upper`, `wing_lower`, `airframe_wood`, `airframe_wires`, `airframe_fittings`: weight -1 to 1 twists the outer bays (+1 lowers the starboard trailing edge 4.5 degrees) |
| `pilot_hips` | an empty at the prone pilot's hips, for the people asset |

Materials: unbleached muslin (unique 8192 x 4096 planform colour map per wing on the second UV set, Terlenka weave
normal and roughness tiled on the bias on the first, sheen, and `KHR_materials_diffuse_transmission` with a texture
whose alpha drops over spars, ribs and the doubled bias seams), spruce, ash, propeller spruce with muslin-covered tips,
cast aluminium, cast iron, brass, steel wire, steel tube, tinned sheet steel, oiled chain, rubber hose, dial enamel.

## Sources (measurements and appearance)

- National Air and Space Museum, 1903 Wright Flyer, object A19610048000: span 40 ft 4 in, length 21 ft 1 in, height
  9 ft 3 in, 12 hp engine, two pusher propellers. https://airandspace.si.edu/collection-objects/1903-wright-flyer/nasm_A19610048000
- National Air and Space Museum, Fabric, Aircraft, 1903 Wright Flyer (A20090031000, A19810147000): the original
  unbleached "Pride of the West" muslin, unsealed, the trailing edge seam with the rib ends tied to the trailing edge
  wire. https://www.si.edu/object/fabric-aircraft-1903-wright-flyer:nasm_A20090031000
- National Park Service, Wright Brothers National Memorial Historical Handbook 34, engine and propellers: four
  horizontal cylinders 4 in bore and stroke, aluminium crankcase and water jacket, 0.4 gallon tank, low-tension
  magneto friction-driven by the flywheel, vertical sheet-steel radiator on the central forward upright, propellers
  8 ft 6 in on tubular shafts about 10 ft apart, three laminations of spruce, canvas-covered tips, one chain crossed
  in a figure eight. https://npshistory.com/handbooks/historical/34/hh34k.htm
- Wright-brothers.org, 1903 engine: the firing chambers on the engine's left side, nearest the pilot; the tank hung
  from a wing strut, fuel by gravity. https://wright-brothers.org/Information_Desk/Just_the_Facts/Engines_&_Props/1903_Engine.htm
- Jakab, P. L. 1990, Visions of a Flying Machine (Smithsonian Institution Press): chord 6 ft 6 in, gap 6 ft 2 in,
  camber 1 in 20, the 10 in droop, the biplane elevator ahead and the twin movable rudders.
- Hobbs, L. S. 1971, The Wright Brothers' Engines and Their Design (Smithsonian Annals of Flight 5): engine layout.
- Library of Congress, Wright Brothers negatives (public domain), LC-W86-35 "First flight, 120 feet in 12 seconds,
  10:35 a.m.; Kitty Hawk, North Carolina" and the December 1903 camp negatives: overall look, strut and wire layout.
  https://www.loc.gov/pictures/item/00652085/
- Rejected source: the Smithsonian 3D scan of the Flyer (3d.si.edu, CC0) is one fused scan mesh with museum lighting
  baked in and no separable moving parts, so the film cannot rig its propellers, elevator, rudders or warp; it was not
  used.

## Textures (third-party, all CC0)

| File(s) in `textures\` | Source | Licence |
| --- | --- | --- |
| `spruce_*` | Poly Haven "White Maple Veneer" (4K), regraded to aged spruce | CC0, https://polyhaven.com/a/white_maple_veneer |
| `ash_*` | Poly Haven "Ash Veneer" (4K), regraded | CC0, https://polyhaven.com/a/ash_veneer |
| `weave_*` | Poly Haven "Terlenka" (4K) normal and roughness | CC0, https://polyhaven.com/a/terlenka |
| `aluminium_*` | ambientCG Metal050C (4K) | CC0, https://ambientcg.com/a/Metal050C |
| `iron_*` | ambientCG Metal052C (4K), regraded darker | CC0, https://ambientcg.com/a/Metal052C |
| `steel_*` | ambientCG Metal038 (4K) normal and roughness (also the fine normal of the brass fittings, whose colour is a measured brass reflectance) | CC0, https://ambientcg.com/a/Metal038 |
| `muslin_*_color`, `muslin_*_transmission` | made by `build_flyer.py` (own) | own work |

The downloads, unchanged, are kept in the library's `kitty-hawk/downloads/` (`polyhaven/`, `ambientcg/`, with their
own LABEL.md), md5 checked against Poly Haven's API.

## Exports

- `flyer-1903.glb`: glTF 2.0 binary, uncompressed geometry, JPEG/PNG textures, morph target `warp`, extensions
  `KHR_materials_sheen`, `KHR_materials_diffuse_transmission`, `KHR_texture_transform` if the exporter adds it.
- `flyer-1903-lod1.glb`: the same nodes with about a third of the surface samples, no chain links, 1K textures.
- `flyer-1903.summary.json`: bytes, nodes, materials, triangle count of each build.
