# The Mirror Hall

Tilt two matched cameras down through an original travertine gallery. The direct view of the vermilion sculpture leaves the frame. Its centered reflection remains in the right-hand mirror because that panel can see the gallery along a reflected ray.

## How the images are made

The left view runs Margo's stock SSR on both renderers. The right view on WebGPU runs stock RTReflections, which adds scene-BVH rays where the screen-space solution misses. It traces the same 191 placements used for the direct image.

The right view on Margo WebGL2 runs a specialized single-bounce trace for the flat mirror. It reconstructs each visible mirror point from the live view's depth and tests the specular ray against a one-level BVH built by Margo from the same transformed geometry. The reflected fragments share the gallery's source materials, face normals and directional and ambient lighting. The mirror applies Schlick Fresnel weighting and uses the same PBR Neutral output curve. The reflected light comes from the geometry even while the sculpture is outside the camera's field of view. Depth-first skip links and packed triangle edges keep the WebGL2 shader compact. The WebGL2 path treats this mirror as ideally smooth and traces the entire visible pool. The native path combines screen-space hits and traced hits with the stock pass's fades. Both show one reflection bounce from the same camera and at the same canvas resolution.

The views each render into an independent full-viewport target. A final presentation pass places those targets side by side without changing either image's perspective. This keeps ray reconstruction centered in each panel.

## Verification

Cold WebGL2 initializes the compact trace program asynchronously while rendering the first screen-space pass. The tilt control becomes ready after both views render. The GPU shader disk cache can be disabled to reproduce genuinely cold shader startup. Run `node qa-output/the-mirror-hall/check.mjs` with `MARGO_ENGINE_CHECKOUT` set to the verified engine checkout. The harness checks a trusted camera tilt under the 390 × 844, 150 ms RTT, 1.6 Mbps, fourfold CPU slowdown profile. Set `MIRROR_HALL_COLD=1` and run `mobile`, `mobile-auto` and `mobile-compat` in separate invocations for independent cold browser processes. The companion pixel check confirms the direct sculpture is identical in both panels and the geometry-traced right panel retains the off-camera reflection.

## References

- Morgan McGuire and Michael Mara, [*Efficient GPU Screen-Space Ray Tracing*](https://jcgt.org/published/0003/04/04/), JCGT, 2014.
- Turner Whitted, [*An Improved Illumination Model for Shaded Display*](https://doi.org/10.1145/358876.358882), Communications of the ACM, 1980.
- Brian Smits, [*Efficiency Issues for Ray Tracing*](https://doi.org/10.1080/10867651.1998.10487488), Journal of Graphics Tools, 1998.
- Tomas Möller and Ben Trumbore, [*Fast, Minimum Storage Ray-Triangle Intersection*](https://doi.org/10.1080/10867651.1997.10487468), Journal of Graphics Tools, 1997.
- Eric Heitz, [*Understanding the Masking-Shadowing Function in Microfacet-Based BRDFs*](https://jcgt.org/published/0003/02/03/), JCGT, 2014.
- Khronos Group, [*PBR Neutral Tone Mapper Specification*](https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/README.md).
- [Chichu Art Museum, Benesse Art Site](https://benesse-artsite.jp/en/art/chichu.html) and [Negozio Olivetti, FAI](https://fondoambiente.it/luoghi/negozio-olivetti) provided material and architectural references. All gallery forms are original.
- [Public Margo Engine pin `0efd9cff8230507a32deb49907ecd499d46925f5`](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).
