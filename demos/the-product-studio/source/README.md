# The Product Studio

The Relay B‑07 is an original portable field receiver on a continuous blue-grey cyclorama. Set the camera angle, start a still and save the finished canvas as a PNG. Return to preview to compare the accumulated shadow with the real PCSS shadow catcher.

## Geometry and lighting

The receiver is procedural and authored for this exhibit. The enamel housing and metal panels are bevelled solid profiles with separate fasteners, a telescoping antenna, a stitched fabric handle and a machined tuning dial. The speaker cover has 200 modeled openings and a recessed backing. The labels and scale are engraved-style mesh strokes. The sweep is Margo’s geometric cyclorama with a curved floor-to-wall transition. There are no external product assets, textures or image plates.

Margo’s procedural studio generates the four rectangular HDR softboxes in linear light. Environment lighting uses prefiltered GGX specular and spherical-harmonic irradiance. The warm directional key positions ground visibility and specular light. Khronos PBR Neutral maps the linear scene to the display.

The opening preview uses a short disk-light shadow estimate. A take clears that history and averages 128 actual samples of the disk’s projected visibility; each sample uses the receiver meshes as occluders. The live counter reads the completed Margo accumulator. The render holds the converged frame and the downloadable PNG comes from that canvas. This is accumulated area-light visibility on the floor with a rasterized PBR subject. The image-based softboxes are distant and the disk samples receive equal visibility weights. Indirect light comes from the studio environment. Returning to preview loads the separate directional, percentage-closer soft-shadow program and its transparent receiver for comparison.

## Runtime

This module is built against the package exports at [the verified public engine pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5). It opens on WebGPU and uses Margo’s WebGL2 compatibility adapter with half-float framebuffer support if native WebGPU is unavailable. `?backend=webgl2` explicitly selects that path. Both routes use the complete authored geometry, studio lighting, tone mapping, accumulation and preview shadow. The camera framing adapts to the viewport, and the PNG uses the current canvas dimensions.

## Methods

- Robert L. Cook, *Stochastic Sampling in Computer Graphics*, 1986. [Sampling an area light to form smooth penumbrae](https://graphics.pixar.com/library/StochasticSampling/paper.pdf).
- Randima Fernando, *Percentage-Closer Soft Shadows*, 2005. [Blocker search and variable PCF footprint](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/PCSS.pdf).
- The Khronos Group, *Khronos PBR Neutral Tone Mapper*, 2024. [Color reproduction and highlight roll-off for product visualization](https://www.khronos.org/news/press/khronos-pbr-neutral-tone-mapper-released-for-true-to-life-color-rendering-of-3d-products).
- Margo Engine, *Procedural studio environment* and *Accumulated soft shadows*, runtime reference at the pinned revision. [Environment](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/environment/README.md#procedural-studio-environment) and [Studio](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/studio/README.md#accumulated-soft-shadows).
