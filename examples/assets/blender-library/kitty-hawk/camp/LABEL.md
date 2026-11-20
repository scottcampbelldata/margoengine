# The Wright camp, December 1903 (film assets)

- What: the buildings, launching rail and props of the Wright brothers' camp at Kill Devil Hills on 17 December 1903,
  for the animated film "Kitty Hawk: Twelve Seconds on the Sand". Each asset is its own GLB with a hero build (LOD 0)
  and a wide-shot build (`-lod1`, 1K textures, no nail heads).
- Made: 2026-11-17, by script, `build_camp.py` with `../lib/kh_common.py`, in Blender 5.3.0 run headless
  (`blender -b --factory-startup --python build_camp.py -- --part all --lod 0`; `--lod 1` for the wide-shot builds;
  `--part hangar|shed|rail|props|station` for one). No add-on; the exporter is Blender 5.3.0's bundled glTF 2.0 add-on.
- Where: the asset files are never committed (Scott, 2026-11-16). They live in `Assets/blender-library/kitty-hawk/`
  two folders above the checkout, one folder per asset: `hangar-1903/`, `shed-1901/`, `launch-rail/`,
  `lifesaving-station/`, `camp-props/<prop>/`, the shared textures in `camp-textures/`, and copies of this file and the scripts. Dev servers
  serve the library at `/asset-library/` (root `vite.config.mjs`).

## Assets and their nodes (glTF space: +Y up, metres, ground centre at the origin)

| Asset | File | Nodes the film can drive |
| --- | --- | --- |
| 1903 hangar, 44 x 16 ft, board and batten on a 2 x 4 frame, tar-paper roof in 36 in courses under laths, both end doors hinged at the top and raised as awnings on two props each | `hangar-1903/hangar-1903.glb` | `hangar_1903_door_east`, `hangar_1903_door_west` (turn about local Y; built raised 70 degrees, 0 is shut), `..._props` (hide when shut) |
| 1901 shed, the living quarters from 1902 (25 ft plus the 10 ft added in 1902, 16 ft wide, 7 ft eaves), weathered silver-grey board and batten, faded tar paper, the workshop end door raised as an awning, a plank side door, two four-light windows, a stove pipe | `shed-1901/shed-1901.glb` | `shed_1901_door_east`, `shed_1901_side_door` (turns about local Z), `shed_1901_window_glow` (a lamp-lit card behind each window, emissive warm white; show it at dusk and night, hide it by day) |
| Launching rail: four 15 ft lengths of 2 x 4 on edge, 60 ft, capped with a thin iron strip, on levelling blocks; the stake and wire that held the truck | `launch-rail/launch-rail.glb` | `truck` (slides along local -Z in glTF, along the rail; the machine's skids rest on its cross-beam) |
| Kill Devil Hills Life-Saving Station, seen only at a distance: a storey-and-a-half frame station of the 1876 type, 44 x 20 ft, steep gable roof, the boat room door on the east gable raised as an awning, a side door, three windows, a stove pipe, a lookout deck with a rail on the ridge and a flagpole | `lifesaving-station/lifesaving-station.glb` | `lifesaving_station_window_glow` (as the shed's), `lifesaving_station_door_east` |
| Signal cloth on a pole: a 2 x 2 in pole 4.2 m tall with three cord guys to stakes, a muslin cloth nailed along it, rippled as in a strong wind | `camp-props/signal-pole/signal-pole.glb` | `signal_cloth` (sway or swap it) |
| Sawhorse, the wing-rest bench, a long-handled shovel, a tin can, a hand anemometer, the glass-plate field camera on its wooden tripod (`camera-tripod`, a generic 5 x 7 in folding view camera: the make is not confirmed), a shipping crate, a 30 gallon oak barrel with iron hoops | `camp-props/<name>/<name>.glb` (`sawhorse`, `bench`, `shovel`, `tin-can`, `hand-anemometer`, `camera-tripod`, `crate`, `barrel`) | none |

The rail runs from the origin along glTF -Z, matching the dune-coast scene, whose rail runs north from (0, 0).

## How it is built

Every board, timber, tar-paper course, lath, hinge and nail head is its own piece at its real size: 1 in boards
dressed to 3/4 in and 8 in wide, battens 2 1/2 in, framing 2 x 4 in at 24 in centres (sawn full size, as in 1903),
8d nail heads. Each board takes one plank of the wood scan (a random plank and start for each board, broad faces,
edges and end grain mapped apart), and sits a millimetre or two and a fraction of a degree off true, as boards nailed
up by eye do. The 1903 hangar is new pine two months into the coastal weather; the shed, two summers older, is
silver-grey and its tar paper faded.

## Sources

- National Park Service, "1903 Hangar" (Wright Brothers National Memorial): the hangar 44 by 16 ft, built in 1903
  for the powered machine; rebuilt to more exact specifications in 1984 and again in 1993.
  https://www.nps.gov/places/000/1903-hangar.htm
- National Park Service, "1903 Workshop / Living Quarters": the 1901 wood-frame workshop and storage building, 10 ft
  added in 1902 for living quarters. https://home.nps.gov/places/000/1903-workshop-living-quarters.htm
- The 1901 building's 25 by 16 ft plan and 7 ft eaves, and the 1953 reconstruction from research and the Wrights'
  photographs: the park's history as summarised at https://en.wikipedia.org/wiki/Wright_Brothers_National_Memorial
  (EBSCO Research Starters, "Wright Brothers National Memorial", agrees).
- Library of Congress, Wright Brothers negatives (public domain): LC-W86-35, the first flight (the rail, the bench
  under the right wing, the shovel and can on the sand), and the December 1903 camp negatives (the buildings, the
  raised doors). https://www.loc.gov/pictures/collection/wri/
- The rail, truck and bicycle hubs, the camera and John T. Daniels of the Kill Devil Hills Life-Saving Station
  pressing its bulb: Orville Wright's diary for 17 December 1903 and the Wrights' published accounts (public domain).
- The signal: Orville's diary for 17 December 1903 records that they put up a signal for the men at the station;
  its colour and size are not recorded, so the cloth is plain muslin. The station: built 1878-79 as an 1876-type
  station (US Life-Saving Service); its siding, colour and exact proportions follow the type, not a measured
  drawing of this station, which is acceptable only because the film sees it at a distance.
- Not documented and so not modelled: the life-saving crew's cart or boat at the flight; the hangar's exact siding
  and hinge hardware follow the NPS reconstruction, not a surviving drawing.

## Textures (third-party, all CC0)

| File(s) in `camp-textures/` | Source | Licence |
| --- | --- | --- |
| `pine_*` | Poly Haven "Hinoki Planks" (4K), regraded to pine two months weathered | CC0, https://polyhaven.com/a/hinoki_planks |
| `greywood_*` | Poly Haven "Wood Planks Grey" (4K), regraded silver-grey | CC0, https://polyhaven.com/a/wood_planks_grey |
| `tarpaper_*`, `tarpaper_old_*` | Poly Haven "Bitumen" (4K), regraded to tar paper, new and faded | CC0, https://polyhaven.com/a/bitumen |

The downloads, unchanged, are kept in the library's `kitty-hawk/downloads/` (`polyhaven/`, `ambientcg/`, with their
own LABEL.md), md5 checked against Poly Haven's API.

## Exports

- `<asset>.glb`: glTF 2.0 binary, uncompressed geometry, JPEG textures (base colour, normal, occlusion and
  roughness), metallic-roughness PBR, no extensions. `<asset>-lod1.glb`: the same nodes, 1K textures, no nail heads.
- `<asset>.blend` and `<asset>-lod1.blend`: the asset's own objects, meshes and materials (textures linked from
  `../camp-textures/`), for Blender.
- `<asset>.summary.json`: bytes, nodes, materials, triangle count of each build; `previews/`: Blender checks.
