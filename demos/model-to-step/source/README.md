# Model to STEP

Set the Aster indexing flange’s spindle bore from Ø22 to Ø40 mm. Download the current solid as STEP and open that file from the drop area. Toggle between Model and Imported to compare the same view. The solid is a 108 mm turned flange with a chamfered spindle bore and four counterbored mounting holes on an 88 mm bolt circle. The graduated rest, studio and circular tool finish are display geometry.

## Model and file exchange

The public Margo B-rep kernel revolves an exact stepped section, then subtracts cylinders for the mounting holes and counterbores. It validates the closed boundary before tessellating it. The initial 56,456-byte mesh comes from the default Ø28 mm solid. While you move the slider, its bore and bevel open by the selected dimension and the volume updates from the subtracted cylindrical and conical volumes. A worker rebuilds and displays the exact boundary model when input settles.

Download calls Margo’s **bodiesToSTEP** on the current dimensions. It writes an AP214 STEP file with coordinates in metres. Import uses **parseSTEP** and **bodiesFromSTEP** on the supplied bytes, checks the recovered boundary and tessellates the recovered solid for the Imported view. The importer accepts one closed solid up to 500 faces in a file up to 2 MB.

A round-trip match requires the same face count and tessellated triangles at 0.1 µm coordinate quantization, volume within 0.0001 cm³, surface area within 0.000001 cm² and centroid within 0.0001 mm. The triangle comparison uses this kernel’s tessellation, so a different tessellation can produce a difference even where the numerical properties agree.

## Reproduction and verification

From this directory, run **node generate.mjs** with **MARGO_ENGINE_CHECKOUT** pointing at the built public pin **0efd9cff8230507a32deb49907ecd499d46925f5**. The default **aster-flange.mesh** has SHA-256 **7f7690a375204c36f40da55dcee84fb72e6a221b329c97bf8e6290aad8b97fe4**.

All 19 diameters produced valid 23-face solids and matched their own STEP round trips. The browser checks changed the actual bore, downloaded a 124,764-byte Ø37 mm file, reimported it and verified the numerical comparison and matching in-engine framebuffer area at the same view. Desktop additionally checked file drop, a different diameter and malformed input.

| Browser profile | First rendered bore control |
| --- | ---: |
| 390 px phone, native WebGPU | 1.047 s |
| 390 px phone, automatic WebGL2 | 1.143 s |
| 390 px phone, forced WebGL2 | 1.108 s |
| 1440 px desktop, native WebGPU | 0.263 s |

Phone checks used cold Chrome emulation with a 150 ms connection, 1.6 Mbps downstream and fourfold CPU slowdown. WebGL2 uses the public Margo preview renderer. CAD computation and file exchange use the same kernel on both graphics backends.

## References

- ISO 10303-214, *Core data for automotive mechanical design processes*, 2010. [ISO](https://committee.iso.org/standard/43669.html?browse=ics)
- Library of Congress, *STEP-file, ISO 10303-21*. [Format description](https://www.loc.gov/preservation/digital/formats/fdd/fdd000448.shtml)
- National Institute of Standards and Technology, *STEP File Analyzer User’s Guide*, version 4. [Geometric validation properties](https://nvlpubs.nist.gov/nistpubs/ams/NIST.AMS.200-4.pdf)
- Scott Campbell, Margo Engine B-rep package. [Public source at the verified pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/brep)