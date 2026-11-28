# Shortest Paths

Explore a real road graph in downtown and Southwest Washington, D.C. Click a junction to choose a start. Select **Pick destination** to set the other endpoint with the map, or use either junction selector. **Swap ends** reruns the directed search. The colored road network shows distance from the start to each reachable road midpoint. The red line shows the selected route, and the purple arrows show recorded one-way directions.

## Graph and rendering

The exhibit retains the largest weakly connected component within the mapped window. It contains 434 junctions, 556 physical road centerlines, and 925 permitted directional arcs. For directions relative to the original centerline, `OB` follows the stored geometry, `IB` reverses it, and `BD` adds both arcs. Only centerline endpoints within 0.85 m are joined. An overlapping crossing away from the endpoints never connects two roads. The published positive lengths are rounded to centimetres before evaluating paths.

Margo Compute runs Bellman–Ford from the selected start. Readback provides distances and predecessors. Each highlighted step is validated against a permitted directed arc and the reported distance before its stored centerline is drawn. WebGPU uses the GPU graph and Margo's line batches. The WebGL2 fallback draws the same world-space lines through a Margo FrameGraph pass, and uses the same Margo graph algorithm on the package's CPU backend. The current search backend is visible in the panel. Add `?backend=webgl2` to test that path.

This is a static routing study for a geographic crop. Its graph uses the published road lengths and directions. Turn restrictions, temporary closures, and travel time are outside the model. Some junctions in the component are unreachable from particular starts because the graph is directed. Grid north is up on the Maryland State Plane projection.

## Data and attribution

Roads from the District Department of Transportation Roadway Centerlines series. The exhibit queried the District's StreetCenterlines layer, kept street and service-road records with defined travel direction, cropped the region, and quantized the retained geometry to decimetres. [Exact District GIS layer and field schema](https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/POL_LAYERS/MapServer/6), [DDOT Roadway Centerlines catalog and license](https://catalog.data.gov/dataset/roadway-centerlines).

Water from the District GIS Waterbodies 2021 polygon layer. The exhibit simplified the polygon paths to 3 m on export and derived cropped outlines and hatching. [Exact District GIS water layer](https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Planimetrics_2021/MapServer/14), [Waterbodies catalog and license](https://catalog.data.gov/dataset/waterbodies-2021).

Road and water data are attributed to the District of Columbia under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). The adapted chart geometry and source hashes are embedded in `data.mjs`. No live map, geolocation, tiles, or external runtime requests are used.

To regenerate the packaged data, pass the two ArcGIS JSON responses to `node tools/prepare.mjs roads.json water.json` from this exhibit folder. Both requests used the intersects relation with a WGS84 envelope, output EPSG:26985 and features ordered by OBJECTID.

- Roads envelope `-77.043,38.879,-77.013,38.899`. Filter `ROADTYPE IN ('1','2') AND SUMMARYDIRECTION IN ('BD','IB','OB')`. Requested fields `OBJECTID,ROADTYPE,ROUTEID,ROUTENAME,FROMSTREET,TOSTREET,SUMMARYDIRECTION,LENGTH,NHSTYPE`. SHA-256 `a65a5c3889577d99ef924a60f60ffc39297cfa93a5ed301af215e53285fac04b`.
- Water envelope `-77.044,38.878,-77.012,38.900`. Filter `1=1`, fields `OBJECTID`, `maxAllowableOffset=3` and `geometryPrecision=2`. SHA-256 `de9666e2680f31f1e2a138fab80294a5b364a925e285e894d8748e7ac14b32b8`.

Richard Bellman, 1958, introduced the routing formulation underlying the compute search. [On a Routing Problem](https://doi.org/10.1090/qam/102435).

The print design draws on the fine linework of an early District atlas. It uses current GIS geometry for the roads and the stated 2021 water snapshot. [Map of the District of Columbia, 1901](https://www.loc.gov/item/87694449/).

Built against [the public Margo Engine pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).
