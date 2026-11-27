
# Golden Hour

Exhibit 74 in the Margo Web Demos brief. The four daylight settings illuminate a single sandstone basin. **Display look** switches Margo Tonemap among Khronos PBR Neutral, AgX and Margo's fitted ACES presentation curve while holding the chosen daylight.

## Artwork and rendering

- The landscape is original. `terrain.js` authors an incised dry wash, nineteen eroded formations, a sandstone arch, talus and shrubs at metre scale. The view uses the same geometry, shading and sky source on phone and desktop, with framing adjusted for viewport width.
- The scene adopts Margo's `SCENE_PRESETS` and `dayPreset` values, adjusting sun angles, selected exposures, cloud fraction and density for the basin. At runtime Margo Sky's `dayLight` computes the direct sun's direction, atmospheric color and transmitted strength. Margo Environment applies depth-dependent haze to the live 3D geometry. Authored ambient fill completes the lighting.
- The four interchangeable sky textures were rendered with Margo Sky's Preetham, Clouds and Look features. Each shows the sky alone. The displayed sector is reprojected from a 90° capture onto a cylinder so the sky rays remain correctly aligned on either viewport. Keeping these four source images under 26 KB total avoids compiling the atmospheric shaders on the opening path. The basin, lights, fog, camera and HDR tone mapping remain interactive.
- The vista has a fixed viewpoint. The backdrop stores the direction range seen from that viewpoint. The diffuse fill and ground haze are art-directed and the scene uses directional surface lighting.

For a fresh sky bake, serve `tools/bake-sky.html` via the same Vite package resolver and verified public checkout. At a 768 × 768 viewport, call `await window.bake(key)` for each of `golden`, `clear`, `haze` and `overcast`, then capture only the canvas as `sky-<key>.png`. Run `python tools/reproject.py INPUT_DIRECTORY assets` from the exhibit folder with Pillow and NumPy installed. The resulting WebP files are the exhibit's only image assets.

## References

- U.S. National Park Service. [Geology of Capitol Reef National Park](https://www.nps.gov/care/learn/nature/geology.htm). Sandstone spires, layered deposition and erosion.
- U.S. Geological Survey. [Geology of Canyonlands National Park](https://www.usgs.gov/geology-and-ecology-of-national-parks/geology-canyonlands-national-park). Rock layering, canyon erosion and arches.
- Preetham, A. J., Peter Shirley, and Brian Smits. 1999. [A Practical Analytic Model for Daylight](https://doi.org/10.1145/311535.311545). *SIGGRAPH '99*. Atmospheric model used for the authored sky captures.
- [Margo Engine verified public pin 0efd9cff](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5). Sky day and scene presets, image backdrop, fog, geometry and live display transforms.
