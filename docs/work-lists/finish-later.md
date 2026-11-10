# Finish later

Build phase (Scott, 2026-11-10): what a job left unfinished, one line each, `| <batch.job> | <package> | <what is left> |`.

| Job | Package | What is left |
| --- | --- | --- |
| 54.8 | lightmap | refracted: multiple-scattering rough glass (Heitz et al. 2016) instead of dropping masked light; anisotropic roughness; Walter et al. 2007 still to read |
| 54.8 | lightmap | refracted: Sellmeier dispersion and spectral Beer absorption; hero-wavelength sampling to cut colour noise |
| 54.8 | lightmap | refracted: bounces use quad albedo only (no `surface` callback or textures) and are diffuse only; glossy receivers |
| 54.8 | lightmap | refracted: no picture yet of a rainbow or rough caustic from a real scene; GPU photon path |
| 54.6 | lightmap | directional lightmaps: a WGSL apply path (decode the direction and directional maps, evaluate with the mapped and vertex normals) belongs with the draw-time apply entry (54.3); only the CPU reference `directionalIrradiance` exists |
| 54.6 | lightmap | directional lightmaps: an SH (L1) or H-basis option per texel for several strong lights; Habel and Wimmer 2010 (H-basis) still to read |
| 54.6 | lightmap | directional lightmaps: directional ambient (bent normal from the AO rays) and bounce light with a direction; quads (`bakeLightmap`) have no directional mode |
| 54.6 | lightmap | directional lightmaps: proven on stand-in meshes only, no real glTF file with a normal map baked |
| 52.3 | @margoengine/clustered | Shadows from sphere, disc and tube lights (LocalShadows has no shaped-light faces yet). |
| 52.3 | @margoengine/clustered | GPU timing of ShapeLights per light and a picture check against a rival's sphere and tube lights. |
| 52.3 | @margoengine/clustered | Cluster culling or a range for shaped lights (every fragment evaluates all 64 today). |
| 54.7 | lightmap | probes: load the baked SH into `@margoengine/environment/probes` `LightProbes` (it bakes its own on the GPU and has no import path), so draws use them on the GPU |
| 54.7 | lightmap | probes: Chebyshev visibility per probe against leaks through thin walls, as the environment volume has; windowing (Sloan 2008) against SH ringing |
| 54.7 | lightmap | probes: emissive surfaces, area lights and quad bakes (`bakeLightmap` atlases) as bounce sources; several rooms per bake |
| 54.7 | lightmap | probes: Greger et al. 1998 (The Irradiance Volume) still to read in full |
| 54.4 | @margoengine/lightmap | ./denoise runs on the CPU only; a GPU compute version should follow @margoengine/lightmap/gpu (54.2) once it is on main |
| 54.4 | @margoengine/lightmap | ./denoise filters each atlas chart alone; filtering across world neighbours (quads sharing an edge) would help small voxel charts |
| 54.4 | @margoengine/lightmap | ./denoise has no firefly clamp and no per-texel variance from the bakers; the bakes could output sample variance for the luminance weight |
| 54.4 | @margoengine/lightmap | SVGF (Schied et al. 2017) equations of sections 4.2 to 4.4 did not extract from the PDF; read them from a clean copy and recheck the variance filter |
| 54.4 | @margoengine/lightmap | ./denoise not measured on a real scene or against a rival denoiser (OIDN, OptiX); only synthetic and hand-made scenes |
| 54.5 | @margoengine/lightmap | path bounces run on the CPU only; move them to the GPU baker (@margoengine/lightmap/gpu, 54.2) once it is on main |
| 54.5 | @margoengine/lightmap | path bounces for triangle meshes (./mesh) and light through glass on bounce paths are not built |
| 54.5 | @margoengine/lightmap | path mode not compared with Cycles on the Cornell scene (rival-bench.mjs runs quad mode); Kajiya 1986 not read this job |
| 54.3 | @margoengine/lightmap | apply: a core mesh in a scene other than the default draws its stand-in in the default scene (createMesh takes no scene); pass the scene through once materials can |
| 54.3 | @margoengine/lightmap | apply: core mesh textures (base colour, ORM) are not copied to the stand-in; colour, roughness, metalness and sidedness only |
| 54.3 | @margoengine/lightmap | apply: glTF-pro records with a material extension already (clearcoat) are refused; needs a way to chain two extensions |
| 54.3 | @margoengine/lightmap | apply: glTF-pro models need WebGPU (the extension hook binds a GPU texture); no WebGL2 path yet |
| 52.8 | @margoengine/clustered | Stochastic lights: sample the unshadowed loop too (RIS over a few candidates of the cluster list) so thousands of lights in one cluster cost a handful of BRDF evaluations, not only of shadow lookups. |
| 52.8 | @margoengine/clustered | Stochastic lights: temporal reservoir reuse with motion vectors (ReSTIR section 3) and a screen-space denoiser; today only the 2 x 2 quad sum and @margoengine/taa average the noise. |
| 52.8 | @margoengine/clustered | Stochastic lights: GPU timing against the exact loop at 16, 64 and 256 shadowed lights; skip lights whose LocalShadows slot is beyond maxLights (they are sampled with visibility 1). |
| 52.8 | @margoengine/clustered | Stochastic lights: physical lobes (clearcoat, sheen) of sampled lights stay unshadowed; scale clusterLobeLight by the same ratio. |
| list2-fix.L | @margoengine/webgl2-compat | the index-buffer unbind-before-bind fix in drawIndexed is proven by the sciviz glyph compat run (fails 3 of 3 without it in the full sciviz browser chain on the M6 Mac mini); a deterministic compat-level reproduction of the stale element binding is not built |
| list2-fix.L | @margoengine/sciviz | sciviz export-media: tiled export (tileSize 64) differs from full export by 1 in red at 164 scattered pixels on Metal (per-tile projection interpolation rounding, not seams). The exact-match claim from 3e6479d7e needs a media-tiles design change (every tile drawn with one projection) or a rescoped claim from its owner. |
| 51.2 | environment | exr-tiled: multi-part and deep EXR still refused; PXR24, B44 and DWA in tiled mip levels (exr-codecs, a331427a0, reads only the full-resolution level) |
| 107.2 | @margoengine/inspector | Live shader editing: run shaders-browser.mjs on the WebGL2 compatibility device and add a pixel readback that the edit changes the drawn colour; edit NodeMaterial graphs and built-in generated shaders (today read only). |
| 52.4 | @margoengine/clustered | Shadow atlas: hysteresis on point/spot size classes, so a camera crossing a power-of-two coverage boundary does not move and redraw a light's tiles back and forth. |
| 52.4 | @margoengine/clustered | Shadow atlas: per-face caching for LocalShadows' texture array too (today any caster change redraws every layer there), and bounds for instanced and displaced casters so they stop redrawing every face. |
| 52.4 | @margoengine/clustered | Shadow atlas: defragment when stable placement fails (today every face is placed afresh and redrawn), and keep a light's tiles when the light list is reordered (tiles are keyed by list index). |
| 52.4 | @margoengine/clustered | Shadow atlas: GPU timing of cached against full redraws with many still lights on this Mac and the dev PC; only work counts are claimed. |
| 64.5 | @margoengine/scatter | simplify: lock the blade root and tip so a collapse can never lower a grass mesh's top (Scatter blades need it above the root); pick ring ratios from a target on-screen error instead of fixed fractions; GPU picture proof of the rings in a Scatter. |
| 67.1 | @margoengine/water | Bodies: holes and islands in an outline; per-body foam, flow and coastal settings; a Water grid that centres on `bodies.bounds` (needs a grid origin shared with WaveQuery's capture); river ends are round caps, not authored mouths; GPU time per body count not measured. |
| 64.6 | @margoengine/scatter | grass: picture proof of the shadow pass and the WebGL2 compatibility backend; GrassScatter with the interact (trampling) and imposter entries in one class; per-blade tip shade from each blade's own height; shape uniforms so the shape can change without new pipelines. |

Scott (2026-11-10): build to about 95%, push and move on. Each job lists here, one line each, what it left unfinished.

| Job | Package | What is left |
|---|---|---|
| 52.5 | @margoengine/clustered | area-texture: read the LTC paper's textured-light section and the Hill and Heitz 2016 slides (not fetchable this job) and compare the lookup and level rule with theirs |
| 52.5 | @margoengine/clustered | area-texture: prove against a path-traced reference of a detailed image under rough and sharp lobes, and measure the error of the single filtered lookup |
| 52.5 | @margoengine/clustered | area-texture: clip the vector form factor at the horizon as the scalar integral is, and filter anisotropically for lobes stretched along one axis of the light |
| 52.5 | @margoengine/clustered | area-texture: images from GPU textures or video (today CPU RGBA8 pixels, copied and filtered on setTextures) |
| 66.5 | @margoengine/water | underwater: the surface seen from below keeps its above-water shading; add a total-internal-reflection and Snell-window term (the parked batch 234 screen trace banded on FFT scenes) |
| 66.5 | @margoengine/water | underwater: waterline uses one probe plane under the camera; sample a row across the near plane so a crest crossing the lens bends the line |
| 66.5 | @margoengine/water | underwater: per-view uniform so split-screen views each get their own probe (today the last view's camera wins, as caustics) |
| 66.5 | @margoengine/water | underwater: GPU cost of the 24-step shaft march at 1080p, and a half-resolution march option |
| 67.2 | @margoengine/water | Scatter: a real thickness (depth to the bottom or a baked map) instead of the height proxy; point and spot lights; scatter in the SSR capture and the reflector; GPU time not measured. |
| 107.3 | @margoengine/inspector | Remote inspection: drive a real phone or headset browser against the relay, reconnect a dropped relay stream, and edit the remote hierarchy (transforms, visibility) as the local Inspector does. |
