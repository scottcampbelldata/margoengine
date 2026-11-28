# The Differential

An interactive Margo Engine exhibit of a symmetric open automotive differential on a scale bench. Change steering to vary the two axle speeds around a constant 60 rpm carrier. The three readouts show the model rates. The slow presentation speed makes the relative gear motion visible. The gears are stepped by the physics solver (`differentialRig` in `@margoengine/machinery/rigs`): the carrier turns, a road under the left wheel runs at the steering's speed, and the right wheel and the pinion are what the bevel meshes make of it. "Physics against exact" is the largest gap between those angles and the closed form.

The chassis follows a circular path with a 1.54 m track and no wheel slip. The slider controls signed curvature with a 2.25 m minimum centreline radius. The pinion spins on its cross shaft at the side-gear-to-pinion tooth ratio. All four pitch-cone contacts begin with a half-tooth phase between mating gears, and the two axle angles remain symmetric about the carrier. The display uses educational tooth profiles. The exhibit models kinematics.

Run from the gallery repository with `node build.mjs the-differential` and serve `dist/` over HTTP. Append `?backend=webgl2` to exercise Margo's compatibility renderer. Both renderers use the same exhibit geometry, materials and camera framing.

## References

- Anna Albinsson, *Applied Mechanics*, Jönköping University, section 10.7, [Bevel gears](https://mechanics.ju.se/MachineElements/bevel-gears.html). Intersecting pitch cones and the automotive drive arrangement.
- War Department, *Automotive Power Transmission Units*, TM 10-585, 1941, [differential chapter](https://www.govinfo.gov/content/pkg/GOVPUB-W-6dfc6e0375832e323235f7e009fd2f76/html/GOVPUB-W-6dfc6e0375832e323235f7e009fd2f76.htm). Pinion and axle behavior on straight paths and bends.
- KHK, *ABC's of Gears*, [practical guide](https://khkgears.us/media/jlhiv5n4/abcs-of-gearing-c.pdf). Bevel gear profiles and physical cutaway reference.
