# The UV Unwrapper

Unwrap an original double-wall ventilation manifold with different seam layouts. The checker is evaluated with the exact UV coordinates used to draw the atlas. Use Lightmap UVs to view a separate, texel-aligned layout for baked lighting. Drag the 3D view to inspect the inside corners and the back cut.

The manifold is procedural with one continuous closed surface. Its draft strip causes uneven checker proportions through the bend. Margo's public `unwrapMesh` and `meshLightmapUVs` run on the original mesh after a real input. The render and atlas use the results directly. Texture layout uses a 1024 × 1024 atlas with four texels of chart padding. The independent lightmap set uses 256 × 256 and three texels. The displayed stretch is the largest within-chart triangle scale ratio reported by Margo. A value of 1 means uniformly scaled triangles within that chart. The checker is a synthetic inspection texture and the lightmap set has no baked lighting.

- Bruno Lévy, Sylvain Petitjean, Nicolas Ray and Jérôme Maillot. [Least Squares Conformal Maps for Automatic Texture Atlas Generation](https://www.cs.jhu.edu/~misha/ReadingSeminar/Papers/Levy02.pdf), SIGGRAPH 2002.
- Kun Zhou, John Snyder, Baining Guo and Heung-Yeung Shum. [Iso-Charts: Stretch-Driven Mesh Parameterization Using Spectral Analysis](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/isochart-elec.pdf), 2004. The paper gives context on why chart partitioning affects stretch.
