# glTF PBR scenes on RTX A6000: picture residuals that move between runs (draft, covered by KB3508)

Not filed. Margo row: KB3497 (anisotropy and iridescence picture residuals).

This is not a separate defect report. Two reference pictures (the anisotropy and iridescence cases of Margo's reference-rendering
suite, compared with the glTF Sample Viewer) missed their frozen error budgets by a few absolute channel units (anisotropy
819,207 to 819,210; iridescence 454,341 to 454,342) after a change that only rounds a light direction once in float64. The
cause of the residual was not isolated. Its pixels are blended, multisampled ones, so it may be the NVIDIA fault of KB3508 (the same scene
rendering to different bytes on the same GPU in repeated runs). The link is consistent with the evidence, not proven.

- Repro: `../KB3508/msaa-blend-repeat.html` (environment, steps and results in `../KB3508/report.md`; 299 of 299 frames differ on the
  RTX A6000 under WebGPU, 0 on the AMD iGPU).
- What would settle it: run the two scenes with the blended draws' sample mask at 7 (the KB3508 comparison) and see whether the
  residual disappears. Not done: it needs an engine change that is not wanted.
- Result on this PC (2026-11-11): the KB3508 page still reproduces; the two scene residuals were not re-measured.
