# Compute Textures

Switch between three Gray–Scott recipes. Choose **Step** to advance one iteration from a paused frame, or **Restart** to use the same reproducible seed again. Tap or drag inside the plate to add reagent. With the plate focused, Enter adds reagent at its center. Motion defaults to paused if the operating system requests reduced motion.

Each recipe sets feed and removal for the same two-component model. A step samples eight neighbours and the current cell. The four axial neighbours have weight 0.20 each, the four diagonal neighbours weight 0.05 each, and the center weight −1. The species diffuse at relative rates 0.99 and 0.495. The simulation uses periodic boundaries, so a reaction crossing one edge continues at the other.

Both paths update a 192 × 192 pair of RGBA16F GPU textures and draw the new surface with a gradient relief shader. WebGPU uses Margo ComputePass and the shader compute-texture ping-pong target. The Margo WebGL2 preview runs the same discrete equation by rendering each update to a half-float framebuffer and swapping it. The color and height on the plate come from the current second species concentration. The sheen is part of the presentation and has no role in the equations. Presets retain a deterministic seed. Small numeric differences can accumulate between GPU drivers.

## Sources

- John E. Pearson. *Complex Patterns in a Simple System*, 1993. [Paper](https://arxiv.org/abs/patt-sol/9304003)
- Karl Sims. *Reaction-Diffusion Tutorial*. [Model notes](https://www.karlsims.com/rd.html)
- Robert P. Munafo. *Stable localized moving patterns in the 2-D Gray–Scott model*, 2015. [Paper](https://arxiv.org/abs/1501.01990)
