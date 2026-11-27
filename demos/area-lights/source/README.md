
# Area Lights

Exhibit 78 in the Margo Web Demos brief. Choose a sphere, disc, tube or line, then slide it along the measured rail to see how the highlight changes across polished nickel, satin brass and glazed ceramic. The three receivers share their geometry and use different Margo PBR material properties.

## Optical model

- The selected source has 520 lumens of modeled output and a fixed exposure scaling. Its warm linear RGB color is normalized to unit luminance. The studio fill panels stay fixed while the source moves.
- The sphere uses Margo Clustered's finite-radius spherical light. The line uses eight finite-radius sources placed and weighted by Margo's `lineLights` Gauss–Legendre rule. Its individual contributions can be resolved on the smooth finish.
- The disc uses eleven one-sided, coplanar strips over a circular aperture. The tube uses ten tangential Lambertian panels around its luminous cylindrical wall. Margo Clustered AreaLights integrates each panel with linearly transformed cosines for glossy surfaces. The disc boundary and circumference are sampled, and the source luminance is calibrated from the summed panel area. The rounded ends of the tube model are fixture geometry.
- These light models, geometry, camera art and exposure are shared across WebGPU and Margo's WebGL2 compatibility renderer. The visualizer shows direct light from the selected source and fixed studio lights on the three materials. The studio is authored procedurally in metres.

## References

- Heitz, Eric, Jonathan Dupuy, Stephen Hill and David Neubelt. 2016. [Real-Time Polygonal-Light Shading with Linearly Transformed Cosines](https://eheitzresearch.wordpress.com/415-2/). *ACM Transactions on Graphics* 35(4).
- Heitz, Eric, and Stephen Hill. 2017. [Real-Time Line- and Disk-Light Shading with Linearly Transformed Cosines](https://eheitzresearch.wordpress.com/757-2/).
- Snyder, John. 1996. [Area Light Sources for Real-Time Graphics](https://www.microsoft.com/en-us/research/publication/area-light-sources-for-real-time-graphics/). Microsoft Research MSR-TR-96-11.
- [Margo Engine verified public pin 0efd9cff](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5). The runtime uses public Core and Clustered Area, line and photometry APIs.
