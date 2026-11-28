# The City Generator

Exhibit 113 builds a miniature town from a seed, building era, and street pattern. Select **New city** for a different street, block and lot layout. Choose **Plan view** to see the same 3D model from above. The counts and seed describe the current town.

Two fictional settings use different rule families. The **1910 railway town** uses porches and gables for houses, false fronts and brick facades for commerce, and low depots when the plan calls for industrial lots. The **2011 coastal ward** uses tiled hip roofs, apartment balconies, concrete buildings with strip windows, low warehouses when applicable, and marked streets. The settings are inspired by built precedents and use the spacing, materials and building families of the exhibit. The model depicts a small district.

## Method

The worker calls public Margo Engine `generateCity` to calculate the street graph, blocks, lot polygons, styles and per-lot building dimensions. It then calls `buildCity` to generate and batch the architecture, pavements, kerbs, trees and era-specific street furniture. The package calls its own `generateBuilding` rules for each lot, including roofs, walls, storefronts and windows. Work is generated on demand in the browser. Transferred worker buffers drive Margo GPU geometry.

Grid, organic and radial street patterns use the corresponding Margo algorithms directly. Changing the pattern or era keeps the seed. With the same pattern and era, returning to a seed reproduces the geometry and readout. The two eras also change the planning parameters, including pavement and road widths. The plan covers 163 × 148 metres between the axes of the boundary streets. The varnished plinth, scale-bar inlay and workshop lighting were authored for the exhibit. One cached Margo shadow map covers the model in both views.

## Verification

From the showcase checkout with `MARGO_ENGINE_CHECKOUT` set to the pinned public checkout, run `node qa-output/the-city-generator/check.mjs`. Set `CITY_GENERATOR_URL` to test a deployed route. This uses a fresh desktop or phone browser profile for each backend and waits for the real first new city through GPU completion. For the phone it uses 390 × 844, DPR 2, 150 ms latency, 1.6 Mbps download and 4× CPU slowdown.

The test compares street, land parcel and building coordinates before and after the first trusted **New city** tap. It verifies the same geometry in both camera views, checks both period rule families and all three street algorithms, verifies reproduction when returning to a plan, and captures dressed model frames in Margo. Native WebGPU takes priority. Automatic and forced compatibility use the same Margo city code, mesh detail levels, light, camera and materials.

## References

- Yoav I. H. Parish and Pascal Müller (2001). *Procedural Modeling of Cities*. [SIGGRAPH](https://doi.org/10.1145/383259.383292)
- Guoning Chen, Gregory Esch, Peter Wonka, Pascal Müller and Eugene Zhang (2008). *Interactive Procedural Street Modeling*. [ACM Transactions on Graphics](https://doi.org/10.1145/1360612.1360702)
- Pascal Müller, Peter Wonka, Simon Haegler, Andreas Ulmer and Luc Van Gool (2006). *Procedural Modeling of Buildings*. [ACM Transactions on Graphics](https://doi.org/10.1145/1179352.1141931)
- National Register of Historic Places. *Miles City Main Street Historic District*. [National Park Service](https://npgallery.nps.gov/NRHP/GetAsset/69580c61-be3a-434c-a8cb-52ea9279d1ea)
- Sanborn Map Company (1910). *Sanborn Fire Insurance Map from Chicago, Cook County, Illinois*. [Library of Congress](https://www.loc.gov/item/sanborn01790_019/)
- Ministry of Land, Infrastructure, Transport and Tourism of Japan. *Road Development*. [MLIT](https://www.mlit.go.jp/hkb/road_e.html)
- Margo Engine public source at `0efd9cff8230507a32deb49907ecd499d46925f5`. [Procedural package](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/procedural)
