# The Weather Radar

Explore eight base-reflectivity sweeps from the NOAA NEXRAD Twin Lakes radar near Oklahoma City. The exhibit uses a single Level II volume that began at 20:08:11 UTC on 20 May 2013, during the Moore supercell. Each elevation button displays its archived sweep and acquisition time. The antenna collected its higher sweeps later in that volume. [NOAA event record](https://www.weather.gov/oun/events-20130520).

Select an antenna elevation to compare the reflectivity field. In **Plan** view, tap the field or use the arrow keys to probe the closest range gate. The readout gives dBZ, azimuth, slant range and modeled height above the antenna. The color scale shows returns from 5 to 70 dBZ. **Oblique** shows the same samples following the curved beam. **Scan grid** uses Margo Sciviz's mapped curvilinear volume and coordinate slice to render the selected elevation from the eight-sweep grid. Heights in both oblique modes are vertically exaggerated by 4×.

The source records 250 m gates and 0.5° or 1° azimuth sampling. The display keeps alternate range gates and selects the closest measured radial to each whole degree of azimuth, preserving the measured radial elevation and 0.5 dBZ coding. It shows the first 47.625 km of slant range from the antenna. The scan grid uses a 3° by 1.5 km subset of these samples. Gates flagged missing or range folded are masked. The visualization uses the standard four-thirds Earth radius approximation with a 6,371 km reference Earth and tracks each beam's modeled center, so real atmospheric refraction and terrain clearance can differ. This is an archived reflectivity observation. [Doviak and Zrnić, 1993](https://www.sciencedirect.com/book/9780122214226/doppler-radar-and-weather-observations), [NWS reflectivity glossary](https://forecast.weather.gov/glossary.php?word=reflectivity).

## Data credit

- NOAA National Centers for Environmental Information and the NWS Radar Operations Center. *NEXRAD Level II archive, Twin Lakes KTLX, 20 May 2013, volume KTLX20130520_200811_V06*. The source is a U.S. government public-domain dataset. [Source volume](https://unidata-nexrad-level2.s3.amazonaws.com/2013/05/20/KTLX/KTLX20130520_200811_V06.gz), [NCEI dataset description](https://www.ncei.noaa.gov/products/radar/next-generation-weather-radar), [NOAA data reuse policy](https://www.noaa.gov/office-education/outreach-communication/faq).
- NOAA WSR-88D Radar Operations Center. *Interface Control Document for the Archive II/User* (2020) and *Interface Control Document for the RDA/RPG* (2023), Message Type 31 and Reflectivity Data Moment. [Archive II format](https://www.roc.noaa.gov/public-documents/icds/2620010H.pdf), [Digital radar data specification](https://www.roc.noaa.gov/public-documents/icds/2620002W.pdf).

The source SHA-256 is `a052275e8e58e5d8eeecd3ab2d0676fe9def0fe8c06d5428b8e0c84e30f9db2f`. To rebuild the two compressed packets, download the source volume and run:

```sh
python extract-radar.py KTLX20130520_200811_V06.gz assets/ktlx-20130520.deflate
```
