# The Building Checker

Kestrel Archive Annex is an original two-storey IFC4 architectural model with a brick spine, a cantilevered reading deck, a stair and four hinged doors. The display omits the roof and two exterior walls through BCF visibility exceptions so both floors can be inspected at once.

Select **Ground archive** or **Mezzanine study** to open the saved BCF 3.0 viewpoint. Margo resolves the selected product from the IFC GlobalId, restores the view camera and renders a visible-surface highlight. **Overview** returns to the cutaway and shows both flagged doors. **Run IDS checks** starts a local worker, opens the original IFC through Margo and evaluates the IDS XML again. The same worker supports repeated fresh model opens.

The example specifies two information requirements for each of the four doors. Six of eight checks pass. The Ground archive door records EI30 where the example calls for EI60. The Mezzanine study door records false where the example calls for a true self-closing property. These are project information requirements. Fire testing and building code compliance are outside their scope.

## Reproduction

Set `MARGO_ENGINE_CHECKOUT` to the built public Margo Engine revision `0efd9cff8230507a32deb49907ecd499d46925f5`. Run `node src/the-building-checker/generate.mjs` from the gallery root. The generator creates the original IFC and IDS, then opens them through the pinned Margo IFC API, checks both specifications and calculates the BCF issue camera, visibility and selection data. It opens the BCF ZIP again and checks both target IDs. It also checks that fixing both original values yields a pass and that a missing rating fails. The display mesh contains 24,520 triangles extracted from the real IFC by the same engine package. The 10.8 KB startup representation keeps face positions to 0.1 mm and shares the same geometry and lighting on desktop and phone.

The scene archive is fetched alongside the viewer JavaScript and the source BCF archive. The issue panel begins with the saved, reproducible evaluation. The peer reader and its WebAssembly are fetched on the first **Run IDS checks** action. They do not block opening either real BCF issue viewpoint. The gallery Vite resolver maps the worker-only `web-ifc` and `web-ifc/web-ifc.wasm?url` imports to the v0.0.78 peer installed in the verified engine checkout. For the public peer source and license, see [Third-party notices](./THIRD-PARTY-NOTICES.md).

Browser evidence lives in the isolated `qa-output/the-building-checker` directory. The browser harness uses an uncached 390 px emulation with a trusted touch, 150 ms latency, 1.6 Mbps and 4× CPU. It checks both actual viewpoints and selection masks, returns to overview, runs the original IFC and IDS twice, compares all eight results and records render and input timestamps. The first full live recheck fetches the separate reader and takes about 11 seconds under that throttling. Subsequent model checks in the initialized worker take about 0.2 seconds under the same profile.

## References

- buildingSMART International. *Information Delivery Specification 1.0*, 2024. [Standard](https://www.buildingsmart.org/standards/bsi-standards/information-delivery-specification-ids/)
- buildingSMART International. *BIM Collaboration Format XML 3.0*. [Standard](https://technical.buildingsmart.org/standards/bcf/)
- buildingSMART International. *IfcDoor and Pset_DoorCommon*, IFC4 Addendum 2 Technical Corrigendum 1. [IFC4 documentation](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/schema/ifcsharedbldgelements/lexical/ifcdoor.htm)
- 6a architects. *The Perimeter*, 2017. Studied the relationship between an archive, open landings and display rooms. The site model, dimensions, stair and interior are original to this demo. [Architect's project record](https://6a.co.uk/projects/more/the-perimeter)
