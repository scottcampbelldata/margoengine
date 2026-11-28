# 2D Light and Shadow

Entry **154** in Scott Campbell's 200-demo build list. The same illustrated underground river chamber can be lit by a point source, a finite-area source, a projected grille, or first-bounce global illumination.

Drag the lantern or use **Move to next station** to compare the shadows cast by the same three limestone formations. **Return to entry** restores the original position and soft lighting.

The close ribs, strata, bridge, reflections, terraces and calcite shards are authored scene art. Margo renders the artwork, the positioned lantern and the light composite. The hard, soft, and grille modes use Margo’s `Lighting2D`, `SoftLighting2D` and `CookieLighting2D` passes. The two direct-light backends execute the same passes through native WebGPU or Margo’s translated WebGL2 compatibility path. The bounce mode uses the pinned CPU `RadianceCascade2D` implementation in a worker for both backends. It samples a 49 × 29 light field, compares no bounce and one bounce to verify an actual indirect contribution, then composites the full-resolution scene through the same Margo pixel stack. The river has a painted geological reflection and a position-driven, stylized lantern reflection.

## References

- Samuli Laine, Timo Aila, Ulf Assarsson, Jaakko Lehtinen and Tomas Akenine-Möller, *Soft Shadow Volumes for Ray Tracing*, 2005. [Paper](https://fileadmin.cs.lth.se/graphics/research/papers/soft2005/laine2005siggraph_paper.pdf)
- Charles Osborne and Alexander Sannikov, *Radiance cascades: a novel high-resolution formal solution for multidimensional non-LTE radiative transfer*, 2024. [Paper](https://doi.org/10.1093/rasti/rzae062)
- Rouli Freeman, Alexander Sannikov and Adrian Margel, *Holographic Radiance Cascades for 2D Global Illumination*, 2025. [Paper](https://arxiv.org/abs/2505.02041)
