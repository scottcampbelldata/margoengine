# Ten Thousand Trees

Scrub the flight path or let it run. The camera follows a headwater creek through the forest and banks into the moraine saddle. The wind control changes the motion of the spruce and fir crowns. In reduced-motion mode the scene stays still until you use a control or start the flight.

The landscape is original and measured in metres. The tree forms and cold upper basin draw on Engelmann spruce and subalpine fir. The two stands have 6,200 and 3,800 deterministic tree positions. Margo’s public scatter readback captured all 10,000 seeded roots with a top-down native WebGPU camera. The opening renders those roots with the authored terrain, creek, wind direction and flight path. The two stand counts are encoded in draw order. The gzip placement file stores translation to 1/32 m horizontally and 1/64 m vertically, scale to 1/150, and yaw to 360/256 degrees. Its SHA-256 is 5024c1030fd139bd0841fe15ab782ef35dd528e2576adc945eb3e15a9f21e7b4.

The complete forest streams in a separate renderer worker. GPU scatter samples a height texture for the roots and performs view and distance tests. Across the west bank, distant spruce switch to octahedral imposters baked by Margo from the same tree geometry. Near and middle crowns use Margo’s procedural rooted wind and sway. Native WebGPU also uses the ground as a conservative Hi-Z occluder in the east stand. The WebGL2 compatibility layer keeps the same geometry, materials, wind, seed and flight and relies on view culling and ordinary depth. The sky, valley haze, detailed ground, imposter atlas and native Hi-Z appear together at the current view. The far imposter crowns are still. A browser without OffscreenCanvas initializes the full forest on the page thread.

The speed readout configures the visual wind input. It does not simulate the valley's weather. The sky, fog, flight and scene details were authored for this location. The source and browser load use public Margo Engine main at `0efd9cff8230507a32deb49907ecd499d46925f5`, with scatter, lod, culling, terrain and sky. Append `?backend=webgl2` to force the supported compatibility tier.

## Verification

| Browser profile | First rendered flight input | Complete forest |
| --- | ---: | ---: |
| 390 px phone, native WebGPU | 1.125 s | 3.149 s |
| 390 px phone, automatic WebGL2 | 1.097 s | 4.819 s |
| 390 px phone, forced WebGL2 | 1.087 s | 4.074 s |
| 1440 px desktop, native WebGPU | 0.321 s | 1.287 s |

Phone checks used cold Chrome emulation with 150 ms latency, 1.6 Mbps downstream and fourfold CPU slowdown. Actual touch moved the flight path during the opening. Browser checks verified the same camera selection after full detail arrived, then tested wind, flight, pause and reduced motion.

## References

- U.S. Forest Service, *Silvics of North America*, Engelmann spruce and subalpine fir, 1990. [Engelmann spruce](https://research.fs.usda.gov/silvics/engelmann-spruce), [Subalpine fir](https://research.fs.usda.gov/silvics/subalpine-fir).
- National Park Service, *Subalpine Ecosystem*, Rocky Mountain National Park. [Timberline and subalpine forest](https://www.nps.gov/romo/learn/nature/subalpine_ecosystem.htm).
- Ned Greene, Michael Kass and Gavin Miller, *Hierarchical Z-Buffer Visibility*, SIGGRAPH, 1993. [Paper](https://www.cs.princeton.edu/courses/archive/spr01/cs598b/papers/greene93.pdf).
- Zina Cigolle et al., *A Survey of Efficient Representations for Independent Unit Vectors*, JCGT, 2014. [Paper](https://jcgt.org/published/0003/02/01/).
- Renaldas Zioma, *GPU-Generated Procedural Wind Animations for Trees*, GPU Gems 3, 2007. [Chapter](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees).
- A. J. Preetham, Peter Shirley and Brian Smits, *A Practical Analytic Model for Daylight*, SIGGRAPH, 1999. [Paper](https://doi.org/10.1145/311535.311545).
