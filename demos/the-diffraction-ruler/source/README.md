# The Diffraction Ruler

Change **Wavelength** to move the paired spots away from or toward the straight-through center spot. Choose another **Groove density** to change the distance between grating lines. **View from above** makes it easier to compare the angular fan and read the scale. The readout gives the first-order angle on both sides and the number of spots inside the ruler.

This is an ideal transmission grating with monochromatic light at normal incidence. For groove spacing d and integer diffraction order m, the angle satisfies sin θₘ = mλ/d. Orders with |mλ/d| > 1 do not propagate. The ruler shows the propagating orders within its physical ±70° arc. Every spot is placed at its calculated angle on the same radius around the grating. The central spot is the zero order and stays at 0° for any setting.

The narrow paths illustrate the calculated directions. Spot size and brightness are set for visibility. They do not represent groove efficiency, beam spread, finite-grating width, or optical power. The light color is an approximate sRGB rendering of the selected wavelength, with chromaticity estimated from the CIE 1931 observer and normalized for visibility. The grating holder shows a magnified ruling to make its function visible.

The same art, angle model, and settings run on phone and desktop. Margo renders every object, path, and spot. WebGPU is preferred and the Margo WebGL2 compatibility layer runs where WebGPU is unavailable. Add `?backend=webgl2` to test that path directly. The gallery builds from the verified [public Margo Engine checkout](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

## Research

- Christopher Palmer, *Diffraction Grating Handbook*, eighth edition (2020), Chapter 2. Grating equation, groove spacing, and propagating orders. [MKS/Newport](https://www.newport.com/medias/sys_master/npresources/h30/h1b/9954522529822/MKS%20Diffraction%20Grating%20Handbook/MKS-Diffraction-Grating-Handbook.pdf)
- PASCO Scientific, *Student Spectrometer Manual* (SP-9268A). Practical layout, grating holder, collimator, and mechanical angle measurement. [PASCO](https://cdn.pasco.com/product_document/Student-Spectrometer-Manual-SP-9268A.pdf)
- Thorlabs, *Optomechanics*. Dovetail rails and precision carriers. [Thorlabs](https://www.thorlabs.com/catalogpages/v20/186.pdf)
- Chris Wyman, Peter-Pike Sloan, and Peter Shirley, *Simple Analytic Approximations to the CIE XYZ Color Matching Functions* (2013). Observer fitting parameters, Table 1. [Journal of Computer Graphics Techniques](https://jcgt.org/published/0002/02/01/)
- Randima Fernando, *Percentage-Closer Soft Shadows* (2005). Contact-hardening directional shadows. [NVIDIA](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/PCSS.pdf)
