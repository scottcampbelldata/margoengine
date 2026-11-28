# The Climate Globe

NASA GISS/GISTEMP v4 combined land–ocean temperature anomalies, 2° latitude by 2° longitude, with 1200 km smoothing and the NASA 1951–1980 baseline. This exhibit uses the NetCDF archive release marked 2026-11-10. Annual values are calculated from available monthly anomalies where at least ten months are present, then rounded to 0.02 °C for transport. Grid coverage describes available cells as a percentage of the grid. Data readouts are nearest grid cell values. Colours clamp to ±3 °C. Slate cells have no annual value.

Margo's public NetCDF classic reader and CF calendar decoder prepare the 146 annual fields. The globe uses its geographic projection for the WGS 84 ellipsoid and its globe navigation for rotation, zoom and surface picking. The coastline mask comes from Natural Earth at 1:50 million scale. There is no live feed or forecast.

- GISTEMP Team, 2026. [GISS Surface Temperature Analysis (GISTEMP), version 4](https://data.giss.nasa.gov/gistemp/). NASA Goddard Institute for Space Studies. Dataset accessed 2026-11-27.
- Lenssen, N., G. A. Schmidt, M. Hendrickson, P. Jacobs, M. Menne and R. Ruedy, 2024. [A GISTEMPv4 observational uncertainty ensemble](https://doi.org/10.1029/2023JD040179). Journal of Geophysical Research: Atmospheres.
- Made with [Natural Earth public-domain coastline data](https://www.naturalearthdata.com/about/terms-of-use/).
