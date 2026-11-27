# The Projector

Brief 79. An original lantern gallery, carved heron, mechanical lens housing and three procedurally drawn slide designs. The slide selector changes the colour projected on the actual three-dimensional statue and plaster wall. The bird and its plinth cast a real shadow in the projector’s own perspective.

The renderer creates a single spot and gives its image to the public Margo Clustered Projector Lights package. The projected RGBA image filters and scales the light with perspective, which lets it wrap across the curved statue and fall on the wall. The spot uses inverse-square attenuation. Margo Clustered’s local shadow atlas evaluates the real sculpted mesh and plinth from the spot’s point of view. The native WebGPU and full WebGL2 compatibility modes use the same materials, models, slide resolution and 832 × 832 shadow map. Compatibility opens with the live projector and selectable slides, then attaches the shadow atlas to that same scene so compiling the shadow shader stays off the first-slide path.

The slide artwork and installed object are invented for the exhibit. The designs depict an eclipse rim, a stylized contour study, and a fictional star chart. The camera and projector are fixed. The visual model omits variable focus, lens distortion, and dust in the air.

## References

- Catherine Shteynberg, [Understanding the Magic Lantern](https://siarchives.si.edu/blog/understanding-magic-lantern), Smithsonian Institution Archives, 2009. Painted glass and opaque mounting frames.
- E. Leybold’s Nachfolger, [Scientific Instrument Catalogue](https://www.sil.si.edu/DigitalCollections/trade-literature/scientific-instruments/pdf/sil14-52546.pdf), Smithsonian Libraries and Archives, figure 2132A. Mechanical reference for brass lens collars, slide gate, and protective housing.
- The Metropolitan Museum of Art, [Recent Acquisitions, 1996–1997](https://resources.metmuseum.org/resources/metpublications/pdf/Recent_Acquisitions_A_Selection_1996_1997_The_Metropolitan_Museum_of_Art_Bulletin_v_55_no_2_1997.pdf), 1997, page 75. Gallery reference for the use of a plinth and an abstracted bird silhouette at human scale. The model geometry is original.
- Khronos Group, [KHR_lights_punctual](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_lights_punctual). Spotlights, inverse-square attenuation and cones.
- [Margo Clustered projector and local shadow documentation](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/clustered#projector-lights), exact pinned public engine.
