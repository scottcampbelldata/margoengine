# The Meadow

A fictional high-country moraine frames a meadow of long grasses, granite boulders, conifers, and clusters of lupine and pale wildflowers. The terrain, plants, rocks, clouds, and backdrop are rendered in Margo. The scene uses the same geometry and interactive grass on WebGPU and Margo’s WebGL2 compatibility layer.

Use **Walk forward** to follow a curved first-person route and leave alternating footfalls ahead of the viewpoint. Pause the walk to watch the grass recover. **Press grass** bends a patch in front of the camera. Tapping the grass uses a camera ray against the authored ground to position the same kind of pressure. **Return** restores the initial viewpoint and clears trampling forces. Move the sun-elevation slider from 6° to 50° to see the live sky and landscape light change.

## Rendering

The public `@margoengine/creative/grass-terrain` composes a `TrampledScatter` with the authored clump geometry, a height map matching the landscape, a seeded density map, and a world tint raster. There are 17,100 candidate clumps with six tapered blades each. Scatter applies density, distance, slope and frustum tests, so the visible blade count varies with the viewpoint.

Each step applies a 0.70 m spherical interactor near the ground. The GPU applies the pressure to its moving vector field, and each affected clump tips about its own root. The maximum bend is 1.53 radians. The field decays to about five percent of its original strength 4.25 simulated seconds after release. Rooted wind moves the blades separately. These are exhibit-scale artistic settings. They illustrate local deformation and spring-back.

The initial sky is Margo’s live Preetham daylight model. A separately compiled Margo procedural cloud layer joins once interaction is available. Both stages use the current solar elevation. Reduced-motion settings hold the ambient wind and cloud drift while leaving deliberate walking and pressing available.

## References

- Klemens Jahrmann and Michael Wimmer, [Responsive Real-Time Grass Rendering for General 3D Scenes](https://www.cg.tuwien.ac.at/research/publications/2017/JAHRMANN-2017-RRTG/), 2017. Interactive geometric grass and deformation.
- Dimitris Papavasiliou, [Real-Time Grass (and Other Procedural Objects) on Terrain](https://jcgt.org/published/0004/01/02/), 2015. Terrain-rooted procedural vegetation.
- A. J. Preetham, Peter Shirley and Brian Smits, [A Practical Analytic Model for Daylight](https://doi.org/10.1145/311535.311545), 1999. Daylight sky model.
- U.S. National Park Service, [Mount Rainier plants and subalpine communities](https://www.nps.gov/mora/learn/nature/plants.htm) and [Discover Wildflowers](https://www.nps.gov/thingstodo/discover-wildflowers.htm). Reference for the combination of meadow grasses, lupine, pale flowers, conifers and glacial landforms.
- [Margo Engine at the verified public pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5), including [Scatter interaction](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/scatter#interaction-and-trampling-margoenginescatterinteract) and the [Windy Meadow example](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/examples/windy-meadow.ts). This exhibit has original art and combines the example’s weather premise with the public interactive terrain-grass path.
