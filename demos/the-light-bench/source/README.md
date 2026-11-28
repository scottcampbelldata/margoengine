# The Light Bench

Turn the steel mask while watching its three bands move across the plaster fold, bench and screen. **Open beam** swings the mask out on its hinge so the sculpture's own silhouette appears. **Close-up** moves in on the plaster's tooling marks. **Reset** returns the bench to its first composition. The angle slider accepts touch, pointer and arrow keys.

The copper spotlight, mask, calibration board, plaster and ceramic samples are original procedural geometry built with Margo. The slot openings are holes in the mask mesh. A Margo clustered spotlight casts the mask, sculpture and fixture shadows into one 1,024-pixel perspective map. The small studio uses geometric occlusion from this spotlight and a cool fill. Camera framing fits the viewport while the materials, geometry and shadow resolution stay the same on both renderers.

The showcase build in the parent directory serves the demo at `/the-light-bench/`. It uses native WebGPU first and Margo's WebGL2 compatibility layer when a native adapter is unavailable. Open `?backend=webgl2` to exercise that layer directly.

## References

- Electronic Theatre Controls. *Source Four Pattern Sizes, Image Diameters and Focal Lengths*, 2018. The fixture's pattern-holder layout and stage-light scale informed the original bench. [ETC technical support](https://support.etcconnect.com/ETC/Fixtures/Source_Four/Source_Four_Pattern_Sizes%2C_Image_Diameters_and_Focal_Lengths)
- Getty APPEAR Project. *Raking Light*, accessed 2026. Raking light informed the plaster test piece. [Getty Conservation Institute](https://www.getty.edu/projects/appear-project/methodology/)
- William T. Reeves, David H. Salesin and Robert L. Cook. *Rendering Antialiased Shadows with Depth Maps*, 1987. Percentage-closer filtering underlies the engine's integrated spotlight shadow. [SIGGRAPH paper](https://graphics.pixar.com/library/ShadowMaps/paper.pdf)
