# Package research and quality audit (batch 132)

One row per package, lowest-level packages first, written by the helper that audited it (never its author). "Sources
read in full" names only papers and specs fetched and read end to end; anything read as an abstract, behind a paywall or
from memory is listed under "open". Losses stay in. Each row's commit hash is in `git log --grep="(<package>)"`.

| Package | Sources read in full | Checked | Found | Fixed | Open |
| --- | --- | --- | --- | --- | --- |
| dof | Demers, "Depth of Field: A Survey of Techniques", GPU Gems ch. 23 (2004) | CoC against the sensor-plane thin-lens form (signs, pixel scale H / (2 f tan(fov / 2)), maxRadius clamp in pixels); reversed-Z linearisation (d = 1 near, 0 far) and the orthographic mix; golden angle 2.39996323 = pi (3 - sqrt 5); tap tiers 2.26 / 3.19 px = sqrt(16 / pi), sqrt(32 / pi) (one tap per disk pixel); filmGauge focal length tan(fov / 2) = gauge / (2 f); CPU tests 22/22; Metal GPU lens check and WebGL2-compat check pass | Option doc and README said temporal DOF is WebGPU only and throws on the WebGL2 layer, while it runs there (temporal-compat test, compat GPU check); README claimed "about a quarter of the cost", never timed | Both doc claims corrected | Potmesil & Chakravarty 1981 (ACM paywall), Vogel 1979 (Elsevier paywall), Eldar et al. 1997 (IEEE paywall) and Hecht, Optics (book) not read in full. CoC uses the sensor-at-f convention, which overstates blur by S1 / (S1 - f) against the exact angular form (1% at defaults, large in macro); kept as the published convention, noted in clean-room D-02. Depth tolerances (1% / 0.001 near-far test, 5% coarse reuse) are Margo choices with no measurement on record |
