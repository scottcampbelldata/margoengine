# Height Streaming

Fly a topographic survey over Canyonlands National Park. The opening view looks southwest across a horseshoe bend of the Green River near Island in the Sky. The viewer uses a live rendering of public elevation and hydrography, with original lithographic colors, contour lines and atmospheric perspective.

Start survey advances the aircraft at a time-compressed survey pace. Hold the turning controls on a phone. WASD, R/F and the arrow keys provide free-flight movement, elevation and steering on desktop. The survey holds elevation during cruise, and Return to start restores the original view.

## Survey data

- Elevation is the USGS 3D Elevation Program (3DEP) digital elevation model distributed by The National Map ImageServer, requested as 1,792 × 1,792 float32 pixels in WGS 84 UTM zone 12N (EPSG:32612). The bounding rectangle is 580,000–608,000 m E and 4,223,000–4,251,000 m N. [Exact export request](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=580000,4223000,608000,4251000&bboxSR=32612&size=1792,1792&imageSR=32612&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image) · [USGS 3DEP standards](https://www.usgs.gov/ngp-standards-and-specifications/3d-elevation-program-standards-and-specifications).
- River coverage is rasterized from FCODE 46006 stream/river polygons returned by the USGS National Hydrography Dataset, Area – Large Scale, in the same rectangle and projection. Supersampling preserves fractional bank coverage. The colors and reflections are an authored map treatment. [ArcGIS query service](https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/9/query) · [USGS National Hydrography Dataset](https://www.usgs.gov/national-hydrography/national-hydrography-dataset).
- GeoTIFF cells are resampled bilinearly from pixel centers to the terrain lattice, without vertical exaggeration, then quantized at 0.25 m increments for storage. The exhibit distinguishes its sample spacing and storage quantization from the input survey’s accuracy. A tile represents 2 × 2 km and stores 128 × 128 samples at 15.625 m spacing. The 14 × 14 mosaic covers 784 km². The tile data is roughly 3.16 MB compressed.
- The opening location and cliff colors reference the natural Green River Overlook and Canyonlands geology. The 25 m isolines come from rendered elevation. Pigments are assigned from slope and elevation. [USGS Canyonlands geology](https://www.usgs.gov/geology-and-ecology-of-national-parks/geology-canyonlands-national-park) · [NPS Green River Overlook](https://www.nps.gov/places/green-river-overlook.htm).
- USGS-produced data is in the U.S. public domain. This exhibit redistributes processed numeric elevation and water coverage. [USGS copyrights and credits](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits).

The northwestern survey corner is local X/Z zero, +X east, +Z south, and Margo Y is measured relative to 1,180 m. The render uses equal physical scales on all three axes. The flight ceiling, minimum elevation and inner survey bounds keep the aircraft inside mapped terrain. River rendering uses polygon coverage and illustrative shading.

## Runtime

The 6 × 6 resident window spans about 12 × 12 km. Its initial records are sent over one gzip stream, ordered so the central nine tiles can finish before the remaining startup tiles. The opening control is enabled after Margo submits the central terrain. Subsequent travel requests independently addressable, compressed tiles by coordinate. The package scrolls the retained region on the GPU, evicts departing tiles, cancels their pending loads and uploads the new data with a 32,768-texel frame budget. The panel polls the package’s actual resident flags and the window follows the flight camera.

Margo WebGPU is the default. The official Margo WebGL2 compatibility backend runs the same terrain, survey data, sky, colors and flight controls on devices with half-float support. Append `?backend=webgl2` to explicitly test that backend. [Pinned engine source](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

## Reproduction and references

The build uses the included compressed data files and needs no external GIS network at runtime. To reproduce the preprocessing, supply the exact elevation export and NHD JSON (bounding rectangle, coordinate systems and geometry output per above, all FCODE values permitted in the request, maxAllowableOffset 8) to prepare-data.py with Python, Pillow and NumPy. The manifest records source and launch SHA-256 values. The tiles have a predictive elevation plane and packed pigment/coverage plane inside gzip, decoded losslessly after the stated 0.25 m quantization.

- Frank Losasso and Hugues Hoppe, *Geometry Clipmaps: Terrain Rendering Using Nested Regular Grids*, 2004. [Paper and source record](https://hhoppe.com/proj/geomclipmap/).
- Christopher C. Tanner, Christopher J. Migdal and Michael T. Jones, *The Clipmap: A Virtual Mipmap*, 1998. [ACM proceedings](https://doi.org/10.1145/280814.280855).
- Margo Engine, *Height streaming* and *Fly Controls* at the pinned revision. [Terrain stream](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/terrain/README.md#height-streaming-margoengineterrainstream) · [Fly controls](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/controls/README.md).
