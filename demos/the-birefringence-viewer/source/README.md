# The Birefringence Viewer

Increase **Compression force** to load the clear disc from opposite ends of its vertical diameter. **Rotate both filters** turns the crossed pair relative to the load, moving the dark bands tied to principal stress direction. **Use parallel filters** shows the complementary bright-field pattern. At zero load the crossed view is dark and the parallel view is bright.

The ideal specimen is a circular, linearly elastic disc of radius 143 mm and thickness 16 mm under diametric point loads. The model uses the sum of the two Flamant compression fields for the stress tensor difference and shear. The uniform correction for the circular boundary cancels from both quantities. The stress-optic relation gives an optical path difference C t (σ₁ − σ₂), using an illustrative polymer coefficient of 67 × 10⁻¹² Pa⁻¹. For light of wavelength λ, the transmitted fraction for crossed filters is sin²(2(φ − a)) sin²(π C t (σ₁ − σ₂) / λ), where φ is the principal stress direction and a is the first filter's axis. Parallel filters transmit the complement.

The shader samples a 2,048-entry color table made from 91 wavelength samples from 380 to 740 nm under a 6504 K blackbody. Analytic CIE 1931 observer curves convert the result to white-normalized sRGB. The masked neighborhoods under the jaws omit the point-load singularities. The optical model assumes plane stress and ideal polarizers. The moving shoe illustrates loading without simulating deformation, real contact pressure, materials' dispersion, or fracture. It is an exhibit rather than a calibrated stress instrument.

The artwork and the spectral display both render in Margo. The gallery builds from the verified [public Margo Engine checkout](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5). The same artwork runs on phone and desktop. WebGPU is preferred. Margo's compatibility layer runs on WebGL2 when WebGPU is unavailable and can be selected with `?backend=webgl2`.

## Research

- Marvin M. Frocht, *Photoelasticity*, Vol. II (1948), pp. 131–155. Diametric compression fields. The U.S. Bureau of Reclamation reproduces the reference axis formulas in *Developments for the Concrete Tensile Split Test*, Chapter 4 (2018). [Bureau of Reclamation](https://www.usbr.gov/damsafety/TechDev/DSOTechDev/DSO-2018-11.pdf)
- K.-M. Hung and C.-C. Ma, *Theoretical analysis and digital photoelastic measurement of circular disks subjected to partially distributed compressions* (2003). Experimental images and limits of the point-loading idealization. [National Taiwan University](https://scholars.lib.ntu.edu.tw/server/api/core/bitstreams/8d5df83d-88fe-4ef1-bbf1-e244e0f92967/content)
- Harvard Natural Sciences Lecture Demonstrations, *Photoelasticity*. White-light crossed-polarizer demonstration and material appearance. [Harvard University](https://sciencedemonstrations.fas.harvard.edu/presentations/photoelasticity)
- Chris Wyman, Peter-Pike Sloan, and Peter Shirley, *Simple Analytic Approximations to the CIE XYZ Color Matching Functions* (2013). Published observer fitting parameters in Table 1. [Journal of Computer Graphics Techniques](https://jcgt.org/published/0002/02/01/)
- Randima Fernando, *Percentage-Closer Soft Shadows* (2005). Contact-hardening directional shadows. [NVIDIA](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/PCSS.pdf)
