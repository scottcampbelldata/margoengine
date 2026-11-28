# The Noise Lab

One lab instrument displays three different noise fields. Frequency changes the scale of the active field and carries across all three specimens. The second control preserves a separate setting per specimen.

- **Terrain · 2D.** Five octaves of the pinned procedural package’s seeded `simplex2` create the height field, with an authored island envelope. Margo draws 5,408 surface triangles. Relief scales the elevations and changes shoreline shading. The engraved contours follow interpolated height at intervals of 1/18 display units.
- **Cloud · 3D.** Four octaves of spatial `simplex` produce scalar density in a 48 × 30 × 40 lattice. Each view ray takes 32 midpoint samples between its entry and exit faces. Exponential extinction and one offset density probe give the cloud depth and directional highlights. The horizontal analysis plane samples the exact same density lattice. Directional color approximates local lighting and the cloud represents a sculpted field rather than a weather simulation.
- **Tile · 4D.** Three octaves of the public `shader/noise` 4D simplex graph shade six copies of one texture. Two pairs of sine and cosine coordinates map the square to a torus, so a positive full-period shift along either texture axis returns the same coordinates. An engine-owned 128 × 128 periodic wood texture from `procedural/textures` shades the glaze. The same texture bake runs through native WebGPU and through Margo’s WebGL2 compatibility compute path. The movement comes from sampling the live field at the visitor’s new phase.

The plinth, relief, stage, camera, lighting and material shaders were authored for this exhibit. There are no imported assets. The full art and model run on phones and desktops with the same sample counts and meshes. Wide screens leave more room around the display. WebGPU is tried first. Automatic compatibility and `?backend=webgl2` use the complete Margo compatibility route.

## Sources

- Ken Perlin. *An Image Synthesizer* (1985). Introduced procedural noise as an image-synthesis primitive. [ACM paper](https://doi.org/10.1145/325334.325247)
- Ken Perlin. *Improving Noise* (2002). Explains gradient quality and continuity concerns in procedural noise. [SIGGRAPH paper](https://www.cs.rpi.edu/~cutler/classes/advancedgraphics/S23/papers/perlin_improving_noise_2002.pdf)
- Stefan Gustavson. *Simplex Noise Demystified* (2005). Explains the simplex construction used in the engine. [Author’s publication page](https://www.itn.liu.se/~stegu76/simplexnoise/DSOnoises.html)
- Stefan Gustavson and Ian McEwan. *Tiling Simplex Noise and Flow Noise in Two and Three Dimensions* (2022). Shows other periodic simplex constructions. This exhibit uses the circular-coordinate construction above. [Journal of Computer Graphics Techniques](https://jcgt.org/published/0011/01/02/)
- James T. Kajiya and Brian P. Von Herzen. *Ray Tracing Volume Densities* (1984). Provides the formulation for integrating densities along a viewing ray. [SIGGRAPH paper](https://courses.cs.duke.edu/spring03/cps296.8/papers/RayTracingVolumeDensities.pdf)
- Nelson Max. *Optical Models for Direct Volume Rendering* (1995). Describes the exponential absorption model and slice visualization. [IEEE paper](https://courses.cs.duke.edu/cps296.8/spring03/papers/max95opticalModelsForDirectVolumeRendering.pdf)
- NASA Earth Observatory. *How to Interpret a Satellite Image* (2013). Art reference for visual separation of terrain, water and clouds. [NASA Science](https://science.nasa.gov/earth/earth-observatory/how-to-interpret-a-satellite-image/)
