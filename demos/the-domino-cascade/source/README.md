# The Domino Cascade

Tip the first domino to start the cascade. Follow the wave from the mounted camera, or keep the overview. Pause, resume and reset all work on the same simulation. Use the speed menu to adjust how quickly the simulation clock advances.

## Course and model

The route is 110.9 m long and contains 2,000 separate bodies with a 55.5 mm center pitch. Each piece has a 108 × 54 × 16.2 mm box collider fitted to its beveled geometry. The dominoes are modeled as pine with a colored enamel finish. The gravity, support and contact friction, and force on neighboring pieces come from Margo’s rigid-body solver. The start control applies one impulse near the top of the first body.

The five-turn spiral exits into a 17-riser stair. The contact boxes and bridge deck match the visible surfaces. Each stair edge is placed between two neighboring body centers to give both feet full initial support. The approach stays dynamic ahead of contact. Distant upcoming tiles stand at their authored poses until the wave is 23 places away. Sufficiently settled tiles far behind keep their last physical poses. They remain temporarily as fixed supports before leaving collision queries. Each domino participates as a dynamic rigid body where the wave reaches it. The scene renders two thousand tile poses through shared instanced geometry.

The counter marks a piece after its tilt exceeds 0.25 radians (about 14°). That angle exceeds the tipping threshold for a upright block with these proportions. Wave speed is measured from the distance gained by the leading tipped body over the simulation clock, averaged over successive windows of about 0.3 seconds. It measures the wave, not the center-of-mass speed of a falling tile. The chase camera follows the measured front with Margo’s damped cinematic rig.

WebGPU is preferred. Hardware with the necessary WebGL2 compatibility support gets the same course, materials, physics and shading. Use `?backend=webgl2` to select that path. The interface honors reduced motion by leaving the overview active until the user explicitly chooses the chase camera.

## Sources

- Ron Larham, **Validation of a Model of the Domino Effect?** (2008). Experimental tile dimensions, normalized spacing and wave speed. [arXiv](https://arxiv.org/abs/0803.2898)
- J. M. J. van Leeuwen, **The Domino Effect** (2004). Contact between successive falling bodies and the role of height, thickness and spacing. [arXiv](https://arxiv.org/abs/physics/0401018)
- David Cantor and Kajetan Wojtacki, **Effects of Friction and Spacing on the Collaborative Behavior of Domino Toppling** (2022). Friction and spacing ranges that sustain or break a wave. [Physical Review Applied](https://doi.org/10.1103/PhysRevApplied.17.064021)

The geometry, lighting and exhibition design are original. Margo Engine renders the hall and reads the same rigid-body state for both camera views.