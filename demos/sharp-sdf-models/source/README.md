# Sharp SDF Models

An architectural maquette made from signed distance fields. Carve a stepped lightwell out of the ivory form, add the copper tool to the casting, or keep the volume shared by the two. Channel width changes the three rectangular parts of the tool in metres before the surface is regenerated. The bulb-shaped cavity stays constant. Turn the display to see the side and top openings. Show triangle edges overlays the actual contour mesh.

## Construction

- Two original bounded operands use the pinned Margo package’s axis-aligned boxes and sphere. Negative values describe the interior. With casting field `a` and tool field `b`, Carve uses `max(a,-b)`, Add uses `min(a,b)`, and Overlap uses `max(a,b)`.
- A module worker runs the published `@margoengine/procedural/sdf` Rust/Wasm modeler on a 38 × 38 × 38 grid. The app packs the resulting triangles with per-face normals and interpolated triangle-edge coordinates. The material tint shows which input field supplied a surface. The renderer drops exact and near-zero-area faces. It translates each result onto the display so the Overlap volume can be inspected as a standalone object.
- The engine’s FrameGraph renders the original model, display stand, ground and depth-map shadows. All model settings, geometry and materials are shared across WebGPU and Margo’s WebGL2 compatibility path. The worker runs the same independent WASM on both paths. Use `?backend=webgl2` to request compatibility.
- Uniform-grid dual contouring keeps sharp features through the Hermite tangent constraints. The grid determines the precision of corners and small details. The sample is a mesh demonstration and is unsuitable for fabrication measurements.

## Sources

- Tao Ju, Frank Losasso, Scott Schaefer and Joe Warren. *Dual Contouring of Hermite Data* (2002). Introduces the surface extraction and Hermite constraints used in the pinned Margo package. [SIGGRAPH paper](https://people.eecs.berkeley.edu/~jrs/meshpapers/JuLosassoSchaeferWarren.pdf)
- Scott Schaefer, Tao Ju and Joe Warren. *Manifold Dual Contouring* (2007). Explains the topology limits that motivate manifold-preserving extensions. This exhibit uses the pinned uniform-grid modeler. [IEEE paper](https://people.engr.tamu.edu/schaefer/research/index.html)
- John C. Hart. *Sphere Tracing: A Geometric Method for the Antialiased Ray Tracing of Implicit Surfaces* (1996). Defines signed distance bounds and implicit surfaces. The exhibit extracts geometry before rendering. [Author’s paper](https://graphics.stanford.edu/courses/cs348b-20-spring-content/uploads/hart.pdf)
