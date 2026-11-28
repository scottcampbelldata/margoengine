# The Cut House

A two-storey house authored as an original IFC4 model for this exhibit. Move the section plane to cut across the house or down through a storey. Margo closes the intersected solids with amber section caps and draws their exact cut edges. Use the element picker to highlight one of the cut objects and read its IFC class, expressID and GlobalId. The room records are the five IfcSpace entries in the same file.

The house includes lime-concrete walls with trimmed openings, bronze frames and glazing, two roof elevations, an oak mezzanine and staircase, and furniture. IFC measurements and section values use meters. The axial section offset is measured along the model's front-to-back coordinate. The plan value is the height above the IFC datum.

## Reproduction

Run `node tools/prepare.mjs` with `MARGO_ENGINE_CHECKOUT` pointing to the verified public engine build. Margo's IFC adapter uses the installed `web-ifc@0.0.78` decoder during asset preparation. It reads `assets/cut-house.ifc` and saves the exact tessellation, placements and IFC identifiers in the compressed `assets/building.bin` with the source SHA-256. The shipped page trims the opaque IFC triangles against the selected half-space, uses `@margoengine/ifc/section` to generate the caps and contours, and draws the whole section in Margo. The IFC glazing and studio soft shadows load after the first working section on both phone and desktop. The original IFC is available from the page.

## References

- buildingSMART International, *IFC4 ADD2 TC1 documentation*. [IfcWall](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/FINAL/HTML/schema/ifcsharedbldgelements/lexical/ifcwall.htm).
- buildingSMART International, *Industry Foundation Classes 4.3.2.0*. [IfcSpace](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcSpace.htm), [Spatial composition](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/concepts/Object_Composition/Aggregation/Spatial_Composition/content.html).
- Ivan E. Sutherland and Gary W. Hodgman, *Reentrant Polygon Clipping* (1974). [Paper](https://doi.org/10.1145/360767.360802).
- Rodrigo Minetto, Neri Volpato, Jorge Stolfi, Rodrigo M. M. H. Gregori and Murilo V. G. da Silva, *An Optimal Algorithm for 3D Triangle Mesh Slicing* (2017). [Paper](https://doi.org/10.1016/j.cad.2017.07.001).
