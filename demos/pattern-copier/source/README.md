# Pattern Copier

A small drawing and texture-synthesis exhibit. Draw a 12 × 12 sample with five thread colours. The public `@margoengine/wfc/overlapping` model produces a 48 × 36 field from it. Each output 3 × 3 window matches a window learned from the current sample. The model learns across the sample's wrapped boundaries, keeps the drawn orientation, and uses open edges on output.

Choose Ledger, Selvedge, Basket, or Blank. A finished stroke generates from the edited sample at the current seed. New seed explores a different collapse order. The seed field accepts any integer in range, so the same input and seed can be reproduced. The work runs in a dedicated worker with finite backtracking and restart budgets. A search failure keeps the last visible field and reports the search limit.

The output texture contains the actual palette indices returned by the solver. A Margo fragment pass draws the woven surface from those indices with simulated over-under thread relief. Margo uses native WebGPU first and the full WebGL2 compatibility layer when required. Append `?backend=webgl2` to choose it directly. Both routes use the same shader, palette and CPU result.

## References

- Isaac Karth and Adam M. Smith. *WaveFunctionCollapse: Content Generation via Constraint Solving and Machine Learning*. ACM Transactions on Graphics, 2021. [Paper](https://adamsmith.as/papers/tog-wfc.pdf)
- Alexei A. Efros and Thomas K. Leung. *Texture Synthesis by Non-parametric Sampling*. ICCV, 1999. [Paper](https://www2.eecs.berkeley.edu/Research/Projects/CS/vision/papers/efros-iccv99.pdf)
- Art Institute of Chicago. *Weaving Structures*. Reference for the visual relationship between crossing warp and weft. [Museum reference](https://archive.artic.edu/divineart/weavingstruc/)

The presets, palette and weave visualization are original to this exhibit.
