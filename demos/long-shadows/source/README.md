# Long Shadows

An original Alpine railway crosses a 4,700 by 5,400 metre terrain. The platform, stone viaduct and ridge viewpoints share the same geography, sun and three-car train. Thin overhead fixtures cast across the station slabs, while the masonry arches and mountain ridges cast farther into the valley.

Margo's directional virtual shadow map scans camera-visible receivers and fills a bounded pool of 128-texel pages at eight clipmap levels. The page counter reports actual residency. The physical pool is 1,024 texels square and the exhibit caps residency at 40 pages. The WebGL2 path uses four 1,024² directional cascades with PCF, covering the same 740-metre local reach. Both renderers use the same distance shadow effect beyond that reach and shade the same valley, bridge, and terrain. The remaining difference is the local map filter and edge sampling.

The mountains are generated in a worker. The far effect takes a separate 84 by 96 metre-scale sampling of the same terrain surface and finds the sunward horizon at each cell in a GPU pass. Small railway details cast through the near depth maps. The far field represents mountain terrain and blends in over the last 26% of the local reach. Terrain color blends meadow, rock, and snow as a function of elevation, slope, and geology in the Margo lighting pass.

## References

- Markus Giegl and Michael Wimmer, *Queried Virtual Shadow Maps*, 2007. https://www.cg.tuwien.ac.at/research/publications/2007/GIEGL-2007-QV1/
- Fan Zhang, Hanqiu Sun, Leilei Xu, and Lee Kit Lun, *Parallel-Split Shadow Maps for Large-scale Virtual Environments*, 2006. https://doi.org/10.1145/1128923.1128975
- James Stewart, *Fast Horizon Computation at All Points of a Terrain With Visibility and Shading Applications*, 1998. https://research.cs.queensu.ca/home/jstewart/papers/tvcg97.html
- UNESCO World Heritage Centre, *Rhaetian Railway in the Albula / Bernina Landscapes*. The original scene takes its railway and landscape cues from the site photographs. https://whc.unesco.org/en/list/1276/gallery
