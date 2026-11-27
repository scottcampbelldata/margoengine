# The Lighting Store

Queue entry 77. Two matching test bays compare measured asymmetric-narrow and extra-wide GE Evolve EFNB floodlights. Adjust the distance and compare direct illuminance at the optical axis and 0.75 m below it. Equal lumens sets both profiles to 3,000 lm. Lab output uses each source's absolute candela distribution.

## Measured profiles and attribution

| Bay | GE test | Fixture and distribution | Original fixture |
| --- | --- | --- | --- |
| A | 15050713 | EFNB B2740, asymmetric narrow | [Type B - 03.ies](https://raw.githubusercontent.com/lfaynshteyn/ies_rescale/bf2e6a6a/test/test_ies_profiles/Type%20B%20-%2003.ies) |
| B | 15050813 | EFNB DE730, 100° extra wide | [Type B - 04.ies](https://raw.githubusercontent.com/lfaynshteyn/ies_rescale/bf2e6a6a/test/test_ies_profiles/Type%20B%20-%2004.ies) |

Both optical webs are 73 × 73 Type B laboratory measurements credited to GE Lighting Solutions in Hendersonville, North Carolina, dated November 1, 2016. The source publication is [Lev Faynshteyn’s MIT-licensed IES fixture release](https://github.com/lfaynshteyn/ies_rescale/tree/bf2e6a6a/test/test_ies_profiles). The pinned Margo repository documents the use and source of the same narrow test in its [third-party notice](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/THIRD-PARTY-NOTICES.md). Only the measured table and essential test metadata are shipped, with the [MIT notice](profiles/LICENSE.txt). The browser build serves that notice from the exhibit’s source section.

The text files normalize numeric formatting and retain all angular samples, candela readings and measurement multipliers. The QA preparation script verifies that parsing the original and distributed versions produces identical candela arrays. The original SHA-256 values are:

- Narrow `78aebb2377ce9a981b4cc98684a09b18a7b77957cb3adac4dd65c3a5d51821af`
- Wide `f6f15d206f2e68d31c27aceea98fb76b600900892c5b2b6713b6fd8542235e9c`

## Photometry

The two side-by-side Margo scenes use `Clustered`, `IESLights`, `parseIES`, `iesCandela` and the physical units entry. Each bay has the same neutral light color, art-direction fill, surface, room geometry, exposure and camera framing. The 3D housings and test jigs are original illustrative models. The fill lights the room for visibility and is excluded from the direct lux readouts.

If the lens-to-wall distance is `d`, the straight-line distance to a wall sample `r`, and the profiled intensity `I` in that direction, direct illuminance of the sample is `I × (d / r) / r²`. The normal-incidence term comes from Margo's `candelaToLux()`. Equal-flux mode uses Margo's integrated profile flux to convert 3,000 lm to the appropriate peak candela. Raw absolute mode uses the tested candela values. Margo integrates 5,874 lm and 9,576 lm for these profiles. The source files report rounded values of 5,871 lm and 9,573 lm.

The numerical probes model direct illumination of a planar wall by a point emitter from far-field photometry. The material, common light and display exposure affect pixels. They do not affect the lux numbers. Neither the original color temperature nor measured room reflections are represented.

- [Illuminating Engineering Society, Learn About IES Files](https://ies.org/education/learn-about-ies-files/) explains the measurements and file format.
- [Davide Gadia, Vincenzo Lombardo, Dario Maggiorini and Antonio Natilla, Implementing Many-Lights Rendering with IES-Based Lights, Applied Sciences, 2024](https://doi.org/10.3390/app14031022) gives the context for applying laboratory distributions in rendered scenes.
- [Margo clustered lighting, IES profiles and units, public pin 0efd9cff8230507a32deb49907ecd499d46925f5](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/clustered/README.md) documents peak-normalized profiles and engine photometric conversions.

## Local verification

Build from the gallery checkout with the verified package resolver, including this slug in the gallery conditional-preload set. With `MARGO_ENGINE_CHECKOUT` set, run `node qa-output/the-lighting-store/check.mjs` at the gallery root. Native desktop and cold 390-CSS-pixel trusted touch, automatic WebGL2 fallback, forced WebGL2, near/far slider, both output modes and the distributed license are covered. The harness accepts `LIGHT_STORE_URL` for hosted checks. `qa-output/the-lighting-store/measure.py` verifies the sampled wall's rendered brightness at the matching probe positions in all five profiles, from browser screenshots.

At 1.60 m with both emitting 3,000 lm, the numeric center readings are 325 and 301 lx. Below the optical axis they are 53 and 239 lx. The tests verify the much brighter extra-wide lower footprint on the wall and verify that both beams brighten when using their respective tested output.
