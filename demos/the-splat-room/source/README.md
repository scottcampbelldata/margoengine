# The Splat Room

Explore Columbia, the Apollo 11 command module. Paint or erase the visible scan from any of four cabin views, or choose Look to adjust the camera. Brush width is a percentage of the shorter image edge. Select the canvas and press Enter to apply the active brush at its center. In Look mode the arrow keys turn the camera. Undo removes the last finished stroke. Restore scan returns the original capture in the current view.

## Captured data

The Smithsonian Institution's National Air and Space Museum and Digitization Program Office captured the real Columbia interior. The included derivative samples the original photogrammetry mesh and its texture into anisotropic Gaussian surface elements. Each element's thin axis follows the scanned triangle's normal. Its color comes from the photographed texture at its barycentric UV coordinate. The conversion retains the scan's positions, orientation and color; it carries no learned view-dependent radiance coefficients. The cabin views use different near clip distances to open up the cramped scan. The web scene applies edits to a local working copy. [Smithsonian record](https://www.si.edu/object/3d/command-module-apollo-11%3Ad8c63e8a-4ebc-11ea-b77f-2e728ce88125).

The compact 5,600-element opening view and the progressive 158,000-element detail derive from the same selective area-weighted surface sampler. The compact cloud favours the opening flight-deck view. Editing works on both levels. If detail arrives during a gesture, the switch waits for the completed stroke. Earlier brush strokes replay in their original camera coordinates on the finer cloud. The brush selects a projected screen region, so it may affect more than one surface at the same screen position.

The rendering and brush use Margo Engine at `0efd9cff8230507a32deb49907ecd499d46925f5` through the public Splats, PLY data, editing and OrbitControls entries. WebGPU is preferred, with the full Margo WebGL2 compatibility layer available on supported browsers. Use `?backend=webgl2` to verify that path.

## Reproduce the derivative

Download the 29.7 MB interior GLB from the CC0 archive, verify its MD5 against the record, and run `python tools/prepare-columbia.py path/to/columbia-interior.glb` with NumPy and Pillow installed. The generator reads standard glTF 2.0 transforms and texture coordinates and writes two gzip assets and a SHA-256 manifest. [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html). [Zenodo archive and CC0 license](https://doi.org/10.5281/zenodo.10348690).

Bernhard Kerbl, Georgios Kopanas, Thomas Leimkühler and George Drettakis, *3D Gaussian Splatting for Real-Time Radiance Field Rendering*, SIGGRAPH 2023, gives the Gaussian rendering background. The kernel here renders samples of the credited surface data. [Paper](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/).
