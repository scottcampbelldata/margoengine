# Ten Thousand Trees

Scrub the flight path or let it run. The camera follows the creek up a northern Rockies valley, about 30 m over the
crowns, from the valley mouth to its head. The wind control changes how hard the firs, pines and cedars sway and how
fast. In reduced-motion mode the flight waits until you start it or move the slider.

## What draws it

Everything on screen comes from Margo Engine packages; the page only wires them to the controls.

- **The land and the forest**: `@margoengine/biomes`. `rockiesValleyWorld` is a mountain valley round Wallace, Idaho:
  a level floor with a creek falling west to the outlet, walls of about 30 degrees cut into side gulches, ridges up to
  1,000 m above the floor. Its three northern Rockies biomes (moist forest, dry forest and south-facing openings) place
  western white pine, western red cedar, grand fir, Douglas-fir and western larch, shrubs, rocks and grass.
  `coniferAge(biomes, 'mature')` draws the conifers at a hundred years, old timber, in place of the presets' pole stands.
  `BiomeView` streams the tiles round the camera onto a clipmap terrain with the biomes' ground materials (the needle
  litter darkened to a duff brown here), and carries the relief past the world's edge. The trees are
  `@margoengine/procedural/conifers` meshes in three rings, octahedral imposters far off, through `@margoengine/scatter`.
- **Sky, air and sun**: `@margoengine/sky` (Preetham sky lighting the scene, a late afternoon sun 26 degrees up in the
  west-southwest) and `@margoengine/sky/aerial` (aerial perspective, so far ridges turn blue).
- **Shadows**: `@margoengine/shadows`, four soft cascades to 1.6 km; every tree, shrub and rock casts.
- **Grade**: `@margoengine/post` bloom and `@margoengine/tonemap` AgX.
- **Flight**: `PathControls` of `@margoengine/controls/presentation` on a `@margoengine/splines` curve through the
  creek line, 72 m over the ground. The whole corridor is made before the flight starts, so a jump along the slider
  lands on finished ground.
- **Wind**: each swaying scatter's `wind` takes the slider's speed (km/h to m/s) as its mean speed and a bend strength
  up to full at 43 km/h. Past a gentle breeze the sway quickens with the Beaufort force, as `@margoengine/scatter`
  documents.

The readout counts every stored tree, shrub and rock the view holds on the GPU, which changes as tiles stream in.
Append `?backend=webgl2` to force the WebGL2 compatibility layer.

## Weak spots

- The creek runs dry: still water on an 8 m creek breaks into patches on the view's 8 m water grid (KB-BIOMES-RIVERSTEP1
  in docs/known-bugs.md), so the page leaves the water off until that is fixed.
- The valley floor is open ground: the presets keep woody plants 50 m from the creek, where a view can stand river water.
- Far ridges past the streamed radius carry the regional cover only and read smoother than the near slopes.

## References

- Pfister, Kovalchik, Arno and Presby, *Forest habitat types of Montana*, USDA Forest Service INT-34, 1977; Cooper,
  Neiman and Roberts, *Forest habitat types of northern Idaho: a second approximation*, INT-GTR-236, 1991 (which
  species stand where; cited by the biomes presets).
- Dixon, *Essential FVS: A User's Guide to the Forest Vegetation Simulator*, USDA Forest Service, 2002 (the Inland
  Empire variant's height, diameter and crown width equations behind the conifer ages).
- A. J. Preetham, Peter Shirley and Brian Smits, *A Practical Analytic Model for Daylight*, SIGGRAPH, 1999.
  [Paper](https://doi.org/10.1145/311535.311545).
- Sebastien Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*, EGSR, 2020
  (aerial perspective). [Paper](https://doi.org/10.1111/cgf.14050).
- Renaldas Zioma, *GPU-Generated Procedural Wind Animations for Trees*, GPU Gems 3, 2007.
  [Chapter](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees).
- National Park Service, *Subalpine Ecosystem*, Rocky Mountain National Park.
  [Timberline and subalpine forest](https://www.nps.gov/romo/learn/nature/subalpine_ecosystem.htm).
