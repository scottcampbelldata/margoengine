# Edit and Save BIM

Tern Garden Pavilion is an original IFC4 architectural model with a timber canopy, pale terrace, planted rain gardens and two individually modeled door occurrences. The view uses the geometry and surface colors extracted from that same IFC. Select a door to inspect its frame and hardware.

## Try the editor

1. Choose **Garden entrance** or **Plant room**. Move the acoustic rating slider or change **Self-closing**. The selected door's amber frame marks an edit queued for export.
2. Use **Prepare IFC**. The live editor opens the source file, changes the requested IFC4 occurrence properties with the public Margo IFC writer, saves new bytes, opens them again and checks both door records.
3. Use **Download revised IFC** for the verified Part 21 file. **Reset door** restores the selected door’s original recorded values. Editing after export clears the previous download so the file can't be confused with a newer revision.

The original garden entrance records Rw 30 dB and self-closing true. The plant room records Rw 38 dB and false. The acoustic labels are IFC information values. The example uses a bounded selection from Rw 24 dB through Rw 48 dB.

## Build and proof

Set `MARGO_ENGINE_CHECKOUT` to the built public Margo Engine revision `0efd9cff8230507a32deb49907ecd499d46925f5`. Run `node src/edit-and-save-bim/generate.mjs` from the gallery root to generate the original IFC and compressed rendered geometry. The generator also performs a live edit, then reads the saved file to compare door GlobalIds, settings, product styles, complete geometric coordinates and triangle topology. The source model has 2,444 triangles and 12 distinct modeled colors.

The exhibit uses Margo WebGPU first and its full WebGL2 compatibility route. Both render the same geometry. The optional browser IFC peer loads on the first **Prepare IFC** action and permits repeated exports from the original unedited source. See [Third-party notices](./THIRD-PARTY-NOTICES.md). Use the gallery's two Web IFC resolver aliases and compatibility module preloads when building the exhibit.

The isolated browser test `qa-output/edit-and-save-bim/check.mjs` changes the rating through a trusted pointer input and toggles self-closing, visits both model doors, prepares and downloads the actual file, opens the downloaded bytes independently in Margo, and verifies both doors and exact model geometry. It restores the original selection and checks that the previous download clears. Cold mobile timing uses a 390 px Chrome emulation, 150 ms round trip, 1.6 Mbps downstream and 4× CPU slowdown. The first changed 3D frame arrived at 0.981 s on phone WebGPU, 1.700 s on forced WebGL2 and 1.865 s on automatic WebGL2. Desktop WebGPU reached it in 0.198 s. The first full verified export fetched the separate IFC runtime and took 10.52–10.57 s on the mobile network profile and 0.179 s on the unthrottled desktop.

## References

- buildingSMART International. *IfcDoor and Pset_DoorCommon*, IFC4 Addendum 2 Technical Corrigendum 1. [IFC4 door definition and properties](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/schema/ifcsharedbldgelements/lexical/ifcdoor.htm)
- buildingSMART International. *Property Sets for Objects*. [IFC4 property relationship template](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/schema/templates/property-sets-for-objects.htm)
- ISO 10303-21:2016. *Product data representation and exchange*. [Part 21 clear-text encoding](https://www.iso.org/standard/63141.html)
- Helen & Hard. *Vennesla Library*, 2011. Studied the contrast between repeated timber elements and hard glazing. Tern’s design, dimensions and elements are original. [Architect’s project record](https://helenhard.no/work/vennesla-library/)
