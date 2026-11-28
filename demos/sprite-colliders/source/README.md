# Sprite Colliders

Paint a silhouette on the press’s ink plate, then drop it into the chamber. Draw and Erase work by mouse or touch. The arrow keys move the keyboard cursor and Space stamps the brush. Scoop, Ring and Fork provide editable starting shapes. Use Show collider to inspect boundaries and convex pieces, Undo to recover the previous edit, and Clear chamber to empty the press.

## Actual pixels and collisions

The editable mask is a 76 × 76 straight-alpha raster. Margo’s stock traceOutlines reads the same mask sent to outlineColliders. This exhibit uses alpha threshold 128, a simplification tolerance of 0.63 source pixels, and a minimum area of four square pixels. Transparent holes and separated solid islands pass through the same stock outline process. Each drop captures its source mask, and later editing leaves released cutouts intact.

The stock output supplies the convex polygons of one rigid body in Margo Physics2D. The body falls and rotates against the visible rails, guide wheels and anvil at a fixed 1/60 s step. The stock SpriteLayer displays the exact same mask at the resulting 2D pose. The inspection overlay uses the returned outlines and convex pieces with the same pivot, scale and rotation. The contact readout counts solver events for collider pairs and drives the lit contact indicator. A compound body can generate several contact-start events on one landing. The tray holds ten cutouts at a time.

## Rendering and kernel

The ink plate, brass fittings, stamped markings and coloured cutouts are original procedural artwork. Artwork is rasterized offscreen once into a texture atlas. Margo SpriteLayer renders the complete editor and chamber, including the changing sprite masks. WebGPU opens first and the Margo WebGL2 compatibility renderer uses the same atlas and sprites. Append '?backend=webgl2' to force that path.

The plate can accept edits while the physics kernel loads. A drop requested during preparation keeps its exact drawn mask and runs when the live solver becomes available. Both packed kernels decompress byte for byte to the official WASM artifacts of the pinned public engine. The selected stream enters the public Physics2D.load WASM response API. Rebuild the assets from this directory with a built checkout of the pinned revision.

```sh
node tools/pack-kernel.mjs /path/to/margoengine
```

The decoded SHA-256 values are d921119b281178f8b624dffabdb2a3fdbaf1810aa20bace5f53fa248987e1a33 for SIMD and c8aaf4cffc5c847dac18e852501c6a6998a7e0fd58070a2535bc63295a808dd8 for scalar.

## References

- [Pinned public Margo Engine revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5)
- Satoshi Suzuki and Keiichi Abe, *Topological Structural Analysis of Digitized Binary Images by Border Following*, 1985. [Boundaries and holes in digitized images](https://www2.ipcku.kansai-u.ac.jp/~yasumuro/M_InfoMedia/paper/Suzuki85.pdf).
- David H. Douglas and Thomas K. Peucker, *Algorithms for the Reduction of the Number of Points Required to Represent a Digitized Line or its Caricature*, 1973. [Polyline simplification context](https://doi.org/10.3138/FM57-6770-U75U-7727).
- Bernard Chazelle and David Dobkin, *Decomposing a Polygon into Its Convex Parts*, 1979. [Convex decomposition context](https://doi.org/10.1145/800135.804396).
