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
| 51.3 | environment | Fog multiple scattering: spread into shadowed froxels, clustered lights, a check against a reference renderer, and a re-read of Hillaire 2020 sec. 5.5 in full; GPU cost not timed. |
| 52.2 | clustered | Integrated maps (`ClusteredOptions.shadows`) still reject `drawShadow` sources; only `LocalShadows` takes the `drawLocalShadow` hook |
| 52.2 | clustered | Hook sources (`drawLocalShadow`) are not culled by bounds: every re-rendered layer calls the hook |
| 66.8 | @margoengine/water | rivers: add a bed-slope source term (subcell reconstruction) so chute fronts on beds steeper than the depth per cell run at the slope's gravity component (about 2 m/s on a 0.5 slope today), and check it against an analytic dam break on a slope |
| 66.8 | @margoengine/water | rivers: Manning bed friction; only the shared 0.12 /s flux decay today |
| 66.8 | @margoengine/water | rivers: cost measured only on a 256 x 256 map on the M6 Mac mini; measure 1024 x 1024 and substep scaling |
| 66.8 | @margoengine/water | rivers: drive water/flow surface shading from the solver's pipe flux instead of a separate flow field |
| 67.3 | @margoengine/water | Rain: splash radius is not checked against the Ripples cell until the frame renders (Ripples keeps its cell private); rings on WaterBodies do not follow body wave shares; no rain in the SSR capture or the reflector; GPU time not measured. |
| 67.3 | @margoengine/water | rain.browser.mjs first ran on the M6 Mac mini (Metal): with cell 0.4 the 2 cm rings were faded out by the footprint at the test view, so the frame test uses cell 2; its change floors were first-run guesses (rings 0.5, splashes 0.2) and are set from that run (measured 0.279 and 0.077, floors 0.1 and 0.03). Light the test scene so rings and splashes show above the original floors, and recheck on the dev PC. |
| 52.7 | @margoengine/clustered | layers: layer area lights and directional lights (only point and spot lights carry masks today) |
| 52.7 | @margoengine/clustered | layers: per-mesh masks for core meshes (they are fixed to layer 0; needs a core per-mesh slot, outside this package) |
| 52.7 | @margoengine/clustered | layers: masks for local shadow casters (a light's shadow map still sees every caster) and a per-instance mask without a shader per receiver |
| 52.5 | @margoengine/clustered | area-texture: scripts/clustered-light-images-gpu-check.js "split image" fails on the Mac (0 red, 0 green, 340 wrong): the level rule's footprint for the 16 x 8 image under the 2 x 1 light at 1.5 m is about 22 texels, past the 16-texel image, so the floor reads the 1 x 1 mean (uniform yellow, test-results/clustered-light-images-area-split.png). Either the Lambert lobe's level is too coarse or the scene needs a nearer light or a larger image; the script also lacked `await` on decodePNG, fixed in 52.7, so it never ran past the first frame before |
| 63.2 | @margoengine/biomes | view flow: lines past the 16th get no inflow; merge tributaries or let water/rivers take more sources |
| 63.2 | @margoengine/biomes | view flow: discharge is one number per view; derive it per line from the hydrology's accumulation |
| 53.1 | clustered | `ContactLights` marches the canvas's first view's depth only: other views and render targets reuse it (needs a depth copy per view id) |
| 53.1 | clustered | Contact march timing on a real scene (many lights per cluster x steps) not measured; no half-resolution depth option |
| 53.1 | clustered | A moving caster's contact trails it by one frame (previous-frame depth); no motion-vector reprojection |
| 53.1 | clustered | GPU check (scripts/clustered-shadow-gpu-check.js) fails 'contact: points on the light side, beside, far away and on top keep it exactly' on Metal: the point on the pebble's top gets factor 0 (ratios [1,1,1,0]); likely self-shadowing where one depth texel's step at the 45-degree view exceeds the 0.01 normal bias; needs a slope-scaled or texel-footprint bias |
| 53.1 | clustered | GPU check's shadow-off baseline (test-results/clustered-shadow/baseline.json, local) predates main's LTC and textured-light shader changes; regenerate it with --baseline on main before comparing |
| 53.2 | clustered | Culling tests every light per cluster: no coarse pre-cull (per-tile or BVH) for tens of thousands of lights; not timed at those counts |
| 53.2 | clustered | Area lights are not clustered: a range or per-cluster list for many area lights; only the first 64 may cast shadows |
| 53.2 | clustered | IES, projector and contact per-light settings stop at index 1,024 |
| 53.2 | clustered | area-texture images reach only the first 64 area lights (its MAX_LIGHTS); lights past 64 under a raised AreaLightOptions.maxLights draw untextured |
| 132 | dof | Read in full: Potmesil & Chakravarty 1981 (ACM, paywalled), Vogel 1979 (Elsevier), Eldar et al. 1997 (IEEE); measure the 1% / 0.001 and 5% depth tolerances of the gather |
| 132 | splines | Read in full: Yuksel et al. 2011 manuscript (PDF text not extractable on the Mac), Wang et al. 2008, Kochanek and Bartels 1984, Schneider 1990; help links on the 66 RangeError and TypeError throws; Spline.tangent from the exact derivative |
| 121 | docs | `tests/claims-file.test.js` is red on main: cells missing in claims.md LIM-646 (from 6d64a8732) and the `lightmap/refracted` row at line 2976 (from 42c1cbdac), and limits.md rows Tiled EXR, Stochastic many-light shadows, Contact shadows of local lights and Raised local light caps; the owning lanes restore the cells they meant (never pad), and claims.md has two extra `#` titles (Batch 204, Batch 185 job 2) |
| 132 | worker | browser-check native pointer lock on the Mac: Chromium 156 rejects requestPointerLock with WrongDocumentError for any element (main thread too, headless and headed) when launched by the test harness; find a launch that makes the browser the active app, then rerun the steps after it |
