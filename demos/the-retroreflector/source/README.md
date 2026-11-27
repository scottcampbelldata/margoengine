# The Retroreflector

Move **Lamp azimuth** to slide the survey head and its receiver across a short arc. The amber guide approaches the target and the cool guide returns. **Trace three reflections** brings the corner cube close enough to see the three hits. The readout reports the order of the mirrors and the distance between the return point and the lamp at the receiver. In the model, the two rays are parallel in opposite directions and generally have different lines of travel.

## Optical model

The corner cube has three mutually perpendicular flat mirrors. Its open aperture joins the points 144 mm out on the three local axes. A fixed interior point on the entrance triangle receives the beam. The lamp moves along the visible −25° to +25° horizontal arc at a small fixed height offset.

The trace computes the nearest positive intersection from each mirror and the entrance plane, then reflects at the nearest mirror. At each hit the direction component along that mirror’s normal changes sign. After all three hits the outgoing direction is precisely the negative of the incoming direction. A second intersection with the aperture gives the exit point. The return offset is the separation in the plane through the source normal to that direction.

This is an open front-surface mirror model. The finite aperture and restricted slider are sized so the traced ray completes three reflections at every selectable position. Beam colors and width make the light paths visible. The trace omits glass refraction, polarization, diffraction, loss, beam divergence and weather.

## References and provenance

- NASA contractor report, NTRS 19660014382, 1966, Appendix II “Optical Path of Off-Axis Rays Through a Corner Cube Reflector.” Vector plane intersections and the six possible reflection orders. [NASA Technical Reports Server](https://ntrs.nasa.gov/api/citations/19660014382/downloads/19660014382.pdf)
- T. W. Murphy Jr. and S. D. Goodrow, “Polarization and far-field diffraction patterns of total internal reflection corner cubes,” 2013. Surveying applications and the six reflection paths. [Paper](https://arxiv.org/abs/1309.6649)
- U.S. Federal Highway Administration, *Guidelines for the Use of Raised Pavement Markers*, FHWA-RD-97-152, 1998, Chapter 2. Roadway context for retroreflective markers under wet and dry conditions. [FHWA](https://www.fhwa.dot.gov/publications/research/safety/97152/ch02.cfm)

The night survey road, hardware, front-surface mirrors, tripod and light guides were modeled for this exhibit. The Vite bundle uses public Margo Engine packages. Native WebGPU is selected first. Margo WebGL2 compatibility loads on demand or with `?backend=webgl2`. The same scene and optical model run on desktop and mobile.
