# The Cine Lens

An interactive lens study in an original, working-scale projection room. The projector, ribbon film path, chamfered housing, coated lens, stamped film tin, and the tungsten and teal practicals are all modeled and rendered in Margo. The closer tin, projector chassis and rear practicals put distinct readable surfaces at approximately 1.4 m, 2.2 m and 6.1 m from the virtual camera. The phone and desktop use the same scene, opaque surfaces, lighting, and lens passes. The FOV and aspect ratio are fit to each layout.

- **Autofocus.** The three direct targets set view-space focus and hand it to Margo's `Autofocus` world-target route. Tapping a visible surface reads the depth at that pixel through the same package. An empty pixel leaves the last distance.
- **Bokeh.** Stock `DOF` and `DOFLens` gather from linear HDR scene color and actual opaque depth. Round and six-blade pupils are selectable. Cat's eye clips the pupil with a second simulated barrel circle whose offset grows toward the corners. The central aperture is round. Near/far color is a finite image-space gather with a 32-pixel radius cap and cannot recover occluded geometry.
- **Aperture.** The 95 mm virtual lens spans f/1 to f/8. For a focus distance (z_f), sample depth (z), focal length (f), and f-number (N), the thin-lens signed circle-of-confusion diameter at the image plane is proportional to `f²(1 - z_f/z) / [N(z_f - f)]`. The app holds exposure while changing blur.
- **Tilt and shift.** Tilt sets the angle of the software focal plane and lets Margo recompute focus per pixel. Shift translates the principal point vertically by the stated number of millimeters in the off-axis perspective projection; the camera pose is fixed. This idealized model does not simulate a whole tilt-shift lens group or the compound errors of simultaneously tilted and shifted optics.

WebGPU is preferred. The full Margo WebGL2 compatibility route keeps the same stock DOF, DOFLens and Autofocus features. `?backend=webgl2` selects it directly. Devices lacking the package’s required HDR support display the engine error.

## References

- Michael Potmesil and Indranil Chakravarty. *A Lens and Aperture Camera Model for Synthetic Image Generation*, SIGGRAPH, 1981. Thin-lens image formation and signed defocus. [Paper](https://doi.org/10.1145/800224.806818)
- Craig Kolb, Don Mitchell and Pat Hanrahan. *A Realistic Camera Model for Computer Graphics*, SIGGRAPH, 1995. Optical stops and the limitations of a simple synthetic lens. [Paper](https://www.cs.drexel.edu/~deb39/Classes/Papers/Kolb_siggraph95.pdf)
- Michael Kass, Aaron Lefohn and John Owens. *Interactive Depth of Field Using Simulated Diffusion on a GPU*, 2006. Compared an image-space depth approach against tracing the optical system. [Paper](https://graphics.pixar.com/library/DepthOfField/paper.pdf)
- Harold M. Merklinger. *Focusing the View Camera*, 1993. Focus plane geometry and separate camera movements. [Author text](https://www.mr-alvandi.com/downloads/large-format/focusing-the-view-camera.pdf)
- Science Museum Group. *Bell & Howell Filmo Projector*, circa 1926, 1990-5036/3951. Visual reference for feed/takeup reels, sprockets, and a helical projection barrel. [Collection record](https://collection.sciencemuseumgroup.org.uk/objects/co8084594/bell-howell-filmo-projector)
- Mole-Richardson Co. *Type 407 Baby Solarspot*. Form reference for the two original studio lights. [Manufacturer's record](https://www.mole.com/407-baby-solarspot)

The references inform the model and original design. No photographs, meshes, fonts, or external assets are shipped.
