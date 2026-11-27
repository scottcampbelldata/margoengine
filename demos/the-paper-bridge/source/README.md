# The Paper Bridge

The bench shows two card spans receiving the same central load. Increase the weight, change the folds on the test sheet, then compare their midspan deflections and peak bending stresses. **Inspect the folds** moves the camera to the test sheet's cross-section. **Show stress** colors the computed compressive and tensile bending stresses with a common scale, using the peak stress of the flat test at 30 g as the scale endpoint. The two samples deflect at true scale.

## Mechanical model

Both samples are 0.50 mm thick, 204 mm long, and have a 96 mm developed width. Supports are 180 mm apart. The modeled card has a 2.6 GPa spanwise Young's modulus. It is an illustrative stock value. Fiber direction and moisture can change it. For a chosen crest-to-valley depth, the folded sample's projected width shrinks so the length of its cross-section centerline stays fixed. The section calculation integrates area moments over the same closed, finite-thickness cross-section that the scene renders.

The model uses the Euler–Bernoulli solution for a simply supported beam with a central point force P. Midspan deflection is P L³ / (48 E I). Signed longitudinal stress is −M(x)(y − ȳ) / I. Each cross-section follows the deflected centerline and rotates with its slope. The displayed weights represent the additional applied load. The instrument fixtures and paper's own weight are omitted from the force model.

This is an elastic bending comparison. Local buckling, flattening of the corrugations, transverse loading, yield, and differences in grain or sheet moisture are outside its model. The stiffness ratio describes the modeled load case and is not a failure-strength ratio.

## References

- David Roylance, *Mechanics of Materials: Beam Displacements*, Massachusetts Institute of Technology, 2000. Three-point elastic beam deflection. [Beam displacements](https://ocw.mit.edu/courses/3-11-mechanics-of-materials-fall-1999/13534abb67b86d2fb8ee11a1f4f2b8c4_MIT3_11F99_bdisp.pdf)
- A. Biaglow, *Simply-Supported Beam Slopes and Deflections*, U.S. Military Academy, 2023. Deflection and slope relationships. [Beam formula reference](https://abiaglow.github.io/CH365/references/FE-Handbook-10-3.pdf)
- Gabriela Kmita-Fudalej and Leszek Czechowski, *Experimental and Numerical Studies of Two- and Three-Layer Corrugated Boards in Bending Test*, 2025. Measured corrugation and material properties for manufactured paperboard. [Materials, 18, 4351](https://doi.org/10.3390/ma18184351)
- Instron, *Flex Testing*, 2024. Instrument reference for three-point roller supports and a central loading nose. [Fixture reference](https://www.instron.com/en/resources/test-types/flexural-testing/)

## Build

From the gallery checkout, with the pinned Margo Engine worktree selected in `MARGO_ENGINE_CHECKOUT`, run `node build.mjs the-paper-bridge`. Both renderers use the same geometry, materials, light, and analytical model. The original procedural bench and card geometry load with no external assets.
