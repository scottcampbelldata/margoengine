# Temporal Upscaling

An original mountain cableway provides narrow handrails, suspended ropes, ladder rungs and closely spaced steelwork to compare at native and reconstructed resolution. The viewpoint, camera sweep and scene geometry are shared by all three modes.

- **Native** renders the scene into the output-sized target at one raster sample per pixel.
- **Half-size spatial** renders half the width and height, then enlarges each individual frame with Margo’s Lanczos reconstruction.
- **Half-size temporal** renders the same smaller target with Margo’s jittered TAAUpscale and reprojects previous frames using camera motion and depth. The display stays at full size. The effect gathers 32 jitter phases at this scale. A static view continues rendering through its history accumulation.

The raster and output dimensions follow the live canvas. Half width by half height is one-quarter as many scene raster pixels before rounding. Total cost also includes the history, depth, and full-size resolve. Pause the sweep to compare one viewpoint, or move the camera to examine what happens at thin silhouettes. The authored tram and structure stay stationary so camera reprojection is the controlled variable. Differences from native can include softness, temporal flicker, and disocclusion. TAAUpscale in this exhibit rejects via depth and colour and does not use per-object motion vectors.

The same view controls and scene run on WebGPU and Margo’s full WebGL2 compatibility layer. This temporal package requires the half-float compatibility tier for its history. The sky is drawn as part of the 3D view and uses the same camera and jitter as the modeled cableway.

## References

- Lei Yang, Shiqu Liu and Marco Salvi, [A Survey of Temporal Antialiasing Techniques](https://onlinelibrary.wiley.com/doi/full/10.1111/cgf.14018), 2020. Temporal sampling, accumulation and history validation.
- Brian Karis, [High Quality Temporal Supersampling](https://advances.realtimerendering.com/s2014/), 2014. Subpixel camera jitter and temporal history.
- Lei Yang, Diego Nehab, Pedro V. Sander, Pitchaya Sitthi-amorn, Jason Lawrence and Hugues Hoppe, [Amortized Supersampling](https://w3.impa.br/~diego/publications/YanEtAl09.pdf), 2009. Reconstruction across samples and frames.
- Swiss Museum of Transport, [Engi mountain station model](https://sammlung.verkehrshaus.ch/en/collection/item/134812/) and [Engelberg–Gerschnialp running gear](https://sammlung.verkehrshaus.ch/en/collection/item/117566/). References for the structure and suspended carriage. The illustrated cableway is fictional.
- [TAAUpscale at the verified public Margo Engine pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/taa#upscaling-taaupscale). Includes the documented options and compatibility tier.
