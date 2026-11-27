# The Stepping Stones

Shift the small brass-marked basalt and cross the stream. The surveyor rocks off a fixed toe contact, swings, touches down on a fixed heel, and rolls the boot flat. The foot trajectory uses the fitted boot dimensions, and Margo Animator solves the joints toward those world-space targets. The pelvis transfers weight to the supporting foot. Its height is planned ahead against the reachable leg lengths, so it lowers before a long step and recovers gradually. The upper body and hands follow with slightly staggered timing, then settle after the last footfall.

The gait is kinematic, with rigid boot contact references and no calculation of ground forces. The regression checks continuity at lift-off and landing, ankle reach over the stone adjustment range, the vertical speed of the pelvis, and the settled pose. Run it from this demo folder with `node --test test/gait.test.mjs`. The browser diagnostics under `?verify-motion` expose the solved ankles, torso angle, and planted heel/toe errors for live renderer checks. Add `&side-view` to inspect the stride from the side.

The creek, stone edges, banks, sedge and fern leaves are original procedural Margo geometry. Sam is an original character generated for this scene from MakeHuman core assets (base mesh, rig, skin, footwear, casual clothing and hair), available under CC0. The unbranded field jacket and footwear use the core male_casualsuit05 and shoes02 assets, with an original color treatment and the soles fitted to the rig. The authoring script bakes the MakeHuman body masks before animation so skin covered by clothing never intersects the outer garments. It requires MPFB 2.0.18 and the MakeHuman core asset pack.

Run these commands from the demo source folder to regenerate the mesh. Float32 positions preserve deformation and the last command restores the authored Float32 motion tracks on the Meshopt-packed character.

~~~sh
blender --factory-startup -b --python tools/make-walker.py -- raw.glb
npx gltfpack -i raw.glb -o packed.glb -cc -kn -km -si 0.7 -vpf
node pack-animation.mjs raw.glb packed.glb walker.glb
~~~

- Stelian Coros, Philippe Beaudoin, KangKang Yin, and Michiel van de Panne. Synthesis of Constrained Walking Skills, 2008. [Project paper and stepping-stone examples](https://www.cs.ubc.ca/~van/papers/2008-TOG-constrainedWalking/index.html)
- Lucas Kovar, John Schreiner, and Michael Gleicher. Footskate Cleanup for Motion Capture Editing, 2002. [Paper](https://graphics.cs.wisc.edu/Papers/2002/KSG02/)
- Jia-chi Wu and Zoran Popović. Terrain-Adaptive Bipedal Locomotion Control, 2010. [Research](https://grail.cs.washington.edu/projects/loco/)
- United States National Park Service. Park and Recreation Structures, 1938. [Platt National Park crossing reference](https://npshistory.com/publications/park_recreation_structures/images/plate1l.pdf)
- Jonathan S. Matthis, Sean L. Barton, and Brett R. Fajen. The critical phase for visual control of human walking over complex terrain, 2017. [Precision-stepping experiment](https://pmc.ncbi.nlm.nih.gov/articles/PMC5558990/)
- Steven H. Collins, Peter G. Adamczyk, and Arthur D. Kuo. Dynamic arm swinging in human walking, 2009. [Arm and leg coordination experiment](https://pmc.ncbi.nlm.nih.gov/articles/PMC2817299/)
- Peter G. Adamczyk and Arthur D. Kuo. Redirection of center-of-mass velocity during the step-to-step transition of human walking, 2009. [Center of mass measurements](https://pubmed.ncbi.nlm.nih.gov/19648412/)
- MakeHuman Community. [Core asset license](https://static.makehumancommunity.org/about/license.html)
