# The Camera Obscura

Move **Pinhole to plate** to slide the ground glass along the rails. The image grows and its center gets dimmer as the distance increases. **Show ray paths** traces three selected points on the harbor through the aperture. **View the plate** turns the camera to inspect the projection.

The harbor is an original layered object built from colored polygons at measured depths. To make the image, each vertex of those same polygons is projected through the same pinhole. A source point (u, v) at distance Z in front of the aperture lands at (−Du/Z, −Dv/Z) on a rear plate at distance D. Nearer layers occlude farther ones along the projected rays. Both coordinates change sign, so the harbor is upside down and reversed.

The ideal irradiance follows cos⁴(θ)/D² for a fixed aperture, normalized at the center when D is 160 mm. The rendered preview samples the angular falloff at the center of each colored region. The inspection model enlarges the physical hole for visibility. The projection itself uses a point aperture. Diffraction, finite-aperture blur, glass scattering, and exposure adaptation are outside the model.

Margo Engine renders the 3D lightbox, camera, moving plate, and its projection. WebGPU is preferred, with the same artwork and settings on phone and desktop. The Margo WebGL2 compatibility path is also available with `?backend=webgl2`. The gallery builds packages from the verified [public Margo Engine checkout](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

## Research

- Delft University of Technology, *Interactive Optics*, “Optical Instruments.” Pinhole projection and inversion. [TU Delft](https://interactivetextbooks.tudelft.nl/tn2421/content/Chap3_Optical_Instrument/Optical_instruments_2022_01Clean.html)
- Cornell University, *CS 6630 Radiometry* course notes (2009), “Radiance falloff in a pinhole camera.” Inverse-square center exposure and cosine-fourth falloff. [Cornell University](https://www.cs.cornell.edu/courses/cs6630/2009fa/notes/02radiometry.pdf)
- Smithsonian National Museum of American History, *Camera Obscura*. Extant telescoping wood construction with a pinhole and ground-glass plate. [Smithsonian](https://www.si.edu/object/camera-obscura%3Anmah_1184229)
- George Eastman Museum, *How to Turn a Room into a Camera Obscura* (2020). Demonstration of real, inverted projection. [George Eastman Museum](https://www.youtube.com/watch?v=hsXo4gD7iWI)
- Randima Fernando, *Percentage-Closer Soft Shadows* (2005). Contact-hardening studio shadows. [NVIDIA](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/PCSS.pdf)
