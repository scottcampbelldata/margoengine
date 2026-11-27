# The Road Builder

Add a hillside spur to join the main road, raise the banks on the curves or toggle the overhead plan. **Draw branch** opens the plan and marks the intersection. Start near the brass mark and drag north, leaving room for a gentle curve. The edit creates one branch that can be replaced or removed. The editor preserves the previous road if a stroke turns too tightly for a valid sweep.

The original terrain spans 194 by 150 metres. The main road and branch are sampled from Margo splines. Margo Road stitches a flat junction at the shared center. Approaches ramp from level junction arms into banked, curbed road meshes. Margo Road's terrain fit cuts or fills a shoulder around the combined deck. The visible heightfield is rebuilt from those samples in the worker.

Margo Road creates the dashed-mark descriptors. This exhibit places thin physical strips at the corresponding points and grades of the road, so the marks render on both paths. The viewer uses the same geometry on native WebGPU and Margo's lightweight WebGL2 renderer. The scene is a geometric exhibit. Real alignments require separate sight distance, grade, drainage and roadway design.

## References

- Éric Galin, Adrien Peytavie, Nicolas Maréchal and Éric Guérin. *Procedural Generation of Roads*, 2010. [Paper](https://perso.liris.cnrs.fr/egalin/Articles/2010-roads.pdf)
- Éric Galin, Adrien Peytavie, Éric Guérin and Bedřich Beneš. *Authoring Hierarchical Road Networks*, 2011. [Paper](https://www.cs.purdue.edu/cgvlab/www/resources/papers/Galin-Computer_Graphics_Forum-2011-Authoring_Hierarchical_Road_Networks.pdf)
- Enrico Bertolazzi and Marco Frego. *G1 Fitting with Clothoids*, 2015. [Paper](https://doi.org/10.1002/mma.3114)
