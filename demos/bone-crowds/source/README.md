# Bone Crowds

Entry **158** in Scott Campbell’s 200-demo build list. Blackwater Crossing is an original interpretation of an autumn caribou migration through a braided river valley. Choose **Follow the herd** for a view close to the leading caribou, vary the number of animals and pause to inspect their gait.

Every caribou is drawn by Margo’s stock `SkinnedCrowd` engine package using the same original 14-bone rig. The phase of each walk is independent. The walking clip uses a four-beat lateral sequence with an inverse-kinematic stance. The far representation uses lower polygon detail and fewer pose samples. Turning off adaptive detail submits the whole herd in one instanced draw; with adaptive detail enabled, the scene can use two draws for the herd. The count excludes terrain, water, sky, foliage and separate soft contact shading. Rendered motion and mesh detail use the same Margo passes on native WebGPU and Margo’s WebGL2 compatibility layer.

The small printed atlas colors the original caribou rigs. The terrain height, strata, distant mountains, ripples, vegetation and caribou models are authored specifically for this exhibit. The simulated herd paths and measured walk represent creative direction for the scene.

## References

- Bryan Dudash, *Animated Crowd Rendering*, 2007. [GPU Gems 3 chapter](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-2-animated-crowd-rendering)
- Milton Hildebrand, *The Adaptive Significance of Tetrapod Gait Selection*, 1980. [Paper](https://www.originalwisdom.com/wp-content/uploads/bsk-pdf-manager/2019/03/Hildebrand_1980_The-Adaptive-Significance-of-Tetrapod-Gait-Selection.pdf)
- National Park Service, *History, Purpose, and Status of Caribou Movements in Northwest Alaska*. [Field profile and migration reference](https://www.nps.gov/articles/aps-17-1-7.htm)
