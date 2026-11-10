# Staging parity, batch 272

## Textured stills

`@margoengine/staging/pathtrace-materials` exports `TexturedStill` and
`texturedSceneFromGLTF`. Convert a loaded gltf-pro model to an owned
`PBRMeshTraceScene`, then pass it as `scene` to `TexturedStill.attach`.
The model can be disposed after conversion. The adapter preserves current
geometry, interpolated normals, UV sets, tangents, vertex colours, transforms,
instances, glTF factors, texture addressing and transforms, base colour,
normal, metallic/roughness, emission and binary alpha coverage. Transport is
the existing optional `voxel-pathtracer/mesh-pbr` feature in a composed tracer;
no second material evaluator or shader is introduced.

The ordinary still controller owns camera motion detection, raster fallback,
the idle interval (0.25 seconds), order 19/20/21 camera handoff, history reset,
scene replacement, device restoration and disposal. Capture retains the
integrator's linear image/AOV and PNG, tiled rendering and AbortSignal APIs.
Options keep the ordinary still defaults. Changes to the raster model do not
change an owned snapshot; convert and setScene again after edits.

The requested rival row is compared against public three-gpu-pathtracer
material behaviour: interpolated normals, base colour/normal/roughness maps,
alpha cutouts and glTF conversion. `pathtrace-materials-browser` checks base
texture versus independently decoded linear factors, metal/roughness versus
independent scalar factors, a normal map versus independently normalized
vertex normals and cutouts versus absent geometry. It also converts the
licensed FlightHelmet mobile fixture with real maps, disposes the source,
compares textured and untextured pixels and checks identical image capture
after actual device replacement on WebGPU and WebGL2 compatibility. These
are standards-based image oracles, not a numerical rival-renderer comparison
or a claim about every feature of that renderer. No benchmark or speed claim.

Limits follow mesh-pbr: OPAQUE/MASK only, no alpha BLEND; static snapshots,
no automatic animation tracking; spatial nearest/linear texture sampling,
no ray-differential mip selection. Compressed/streamed images need the
adapter's imagePixels decoder. Native WebGL2 preview refuses with linked
unsupported; install the full compatibility layer instead. A single view
is required. Neither core nor stage is modified.

Entry measurements for job 1: ordinary pathtrace 1398 B gzip (previous budget 1469 B), new pathtrace-materials 1560 B, new ceiling 1816 B. Core plus stage remains 24209 B. No existing ceiling is raised. Keeping the PBR factory and adapter together adds 162 B over the ordinary controller and avoids a duplicate integrator.
