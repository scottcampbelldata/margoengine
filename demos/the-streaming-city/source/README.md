# The Streaming City

Exhibit 129 flies between the four sectors of Cesium's bundled `Tileset with request volume` city sample. Tap **Fly to southeast** to see the first newly visible tile stream into the scene. The sector buttons select a direction, and **Overview** rises to show all four. Drag across the canvas to pan, or use the wheel or pinch to zoom.

The tile readout shows how many sectors are currently visible and how many are cached. Each sector contains ten sample buildings. The first view fetches only the southwest tile. The return flight uses the previously fetched tile from the engine cache.

## Implementation

Margo's `TilesRenderer` reads the original 3D Tiles 1.0 JSON and four `b3dm` payloads. It selects tiles from the actual camera frustum and handles asynchronous requests, cancellation and caching. The root manifest starts concurrently with the graphics device. The four binary payloads are fetched only in response to the tileset's requests. The app maps the manifest's relative URLs to the packaged assets without changing the manifest or payload bytes.

Margo's static glTF loader handles the sample payloads. The terrain grid, survey platform, material styling, facade/roof articulation, and little planted courts are original exhibition dressing around the sample. The sample itself provides simple boxes in fixed geospatial locations with a small number of sectors. The exhibit shows a sample survey district with no claim about actual local buildings.

Margo's `GeospatialControls` computes the flight in WGS84 geodetic coordinates and uses the tileset's local east-north-up frame for rendering. The camera can pan and zoom as well as move between fixed destinations. Eye altitude is reported relative to the survey datum. The 3D camera and scene are the same on native WebGPU and Margo WebGL2 compatibility. The four sector buttons and next-flight control respect reduced-motion preferences.

## Verification

From the showcase checkout set `MARGO_ENGINE_CHECKOUT` to the pinned public engine build and run `node qa-output/the-streaming-city/check.mjs`. Set `STREAMING_CITY_URL` for a hosted route. The audit runs the entire circuit with a trusted first flight action. It checks a multi-frame camera trajectory, waits for the destination tile and GPU fence, verifies all four sectors and Overview, and checks that the return flight triggers no additional asset request. Hosted and local served source payloads are verified against the approved SHA-256 digests in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

The phone emulation uses 390 × 844, DPR 2, 150 ms latency, 1.6 Mbps download and 4× CPU slowdown. Desktop and phone screenshots are from the live rendered exhibit.

## References

- Open Geospatial Consortium and Cesium. *3D Tiles Specification 1.0* (2019), in particular the bounding-volume, tile selection and refinement sections. [OGC 18-053r2](https://docs.ogc.org/cs/18-053r2/18-053r2.html)
- Charles F. F. Karney (2013). *Algorithms for geodesics*. [Journal of Geodesy](https://doi.org/10.1007/s00190-012-0578-z)
- National Geospatial-Intelligence Agency. *World Geodetic System 1984*. [NGA Geomatics](https://earth-info.nga.mil/?action=wgs84&dir=wgs84)
- Margo Engine public revision `0efd9cff8230507a32deb49907ecd499d46925f5`. [Tiles package](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/tiles)
