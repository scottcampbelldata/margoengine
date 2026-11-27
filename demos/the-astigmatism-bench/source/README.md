# The Astigmatism Bench

Slide **Image plane distance** to move the ground-glass carriage. Use **Focal separation** to change the strength of the astigmatism. **Tangential**, **Least blur** and **Sagittal** move the receiver to the exact calculated stations. The receiver follows the selected station as the focal separation changes. **Inspect the spot** brings the glass into close view. The copper and ice-blue guides belong to two perpendicular ray fans.

## Optical model

The lens represents first-order differential power in two perpendicular meridians for a collimated circular bundle with a 105 mm pupil radius. Its arithmetic mean focal length is 420 mm. Half of the selected separation is subtracted to obtain the tangential focal length and added to obtain the sagittal focal length. For pupil points `(u,v)` and image distance `d`, the meridional intercepts are `u × (1 − d/fS)` and `v × (1 − d/fT)`. The geometric spot is the image of a circular pupil under that map. A vanishing semiaxis yields a line focus. Equal absolute scales between the foci give a circle of least confusion at `2 fS fT / (fS + fT)`. With zero separation both line foci coincide at a point. The reported width and height are geometric diameters in millimeters.

The two powers stand in for astigmatic ray fans. The bench omits off-axis field dependence, diffraction, magnification effects beyond first order, dispersion and higher-order aberrations. A 1.2 mm display floor on each radius approximates the visibility of a line or point on the ground glass. It never enters the readouts or ray intercepts. Guide colors identify the perpendicular fans. They do not encode wavelength.

## References and provenance

- John E. Greivenkamp, *Geometrical and Instrumental Optics*, lecture 25, “Aberrations” (2018 course material). Meridional ray fans, perpendicular line foci and circle of least confusion. [University of Arizona](https://wp.optics.arizona.edu/jgreivenkamp/wp-content/uploads/sites/11/2018/12/201-202-25-Aberrations.pdf)
- University of Arizona, *OPTI202L Lab 2: Aberrations* (2015), §2.2.2 and Fig. 2.5. Measuring the line foci by translating a screen. [Wyant College of Optical Sciences](https://wp.optics.arizona.edu/mnofziger/wp-content/uploads/sites/31/2016/05/OPTI202L-Lab2-Aberrations-SP15.pdf)
- University of California, Berkeley, *Lenses & Imaging*, EE119 (2009). Bench practice for observing aberrations using an image plane. [EECS teaching lab](https://inst.eecs.berkeley.edu/~ee119/archive/sp09/lenses%20%26%20imaging.post.pdf)
- Edmund Optics, *Comparison of Optical Aberrations*. Bench-ray and spot examples for comparison. [Edmund Optics](https://www.edmundoptics.com/knowledge-center/application-notes/optics/comparison-of-optical-aberrations/)

The instrument, silicon-bronze track, collimator, lens body, scale and frosted-glass carriage were designed and modeled for this exhibit. Margo Engine renders the same geometry, materials, shadow settings, guides and procedural screen on desktop and mobile. It attempts native WebGPU first and dynamically loads the Margo WebGL2 compatibility backend when native WebGPU is unavailable. Append `?backend=webgl2` to select compatibility directly.
