# Real scientific demo data

`sciviz-lic.html` reuses the exact `wind.bin` reduction and `wind.json` provenance below: NOAA PSL NCEP-NCAR
Reanalysis 1 daily near-surface wind, January 1-8, 2024, US-government public domain. SHA-256:
`e6ab31d5a3816b68f1c22e9c3563230bcb7e574aaaa90bb6513e34280ee93edd`.
Equirectangular projection at 42.5 N corrects longitudinal velocity by latitude; scalar colour uses the
original measured speed (0..35 m/s). Noise seed 171 is a drawing aid. Animation indicates steady-field
direction, not elapsed physical time or observed parcel tracks. No source data or licence changed.

These are scientific measurements and reanalysis data, not generated example shapes.
The binary assets use Git LFS. Run `git lfs pull` after cloning.
Each adjacent JSON records source URLs, source and asset SHA-256, dimensions and byte size.

| Asset | Source | Terms | Reduction |
| --- | --- | --- | --- |
| `head.nrrd` | [OpenNeuro ds000030](https://openneuro.org/datasets/ds000030), UCLA CNP, subject 10159, T1w | [CC0](https://creativecommons.org/publicdomain/zero/1.0/), explicitly stated in the dataset description | Reorient to canonical RAS, retain every second sample along each axis, store uint16 intensities without rescaling in gzip NRRD. 88 x 128 x 128, 2 mm spacing. |
| `stars.bin` | [2MASS All-Sky Point Source Catalog](https://irsa.ipac.caltech.edu/Missions/2mass.html), IRSA TAP `fp_psc` | [Public-domain US government data](https://catalog.data.gov/dataset/2mass-all-sky-point-source-catalog) | One million rows with `ph_qual='AAA'`, `cc_flg='000'`, `MOD(cntr,100)=0`. Four float32 columns: RA degrees, Dec degrees, J-Ks magnitude, Ks magnitude. |
| `wind.bin` | [NOAA PSL NCEP-NCAR Reanalysis 1](https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.html), daily `uwnd.sig995.2024.nc`, `vwnd.sig995.2024.nc` | [Public domain, no copyright](https://www.cpc.ncep.noaa.gov/products/wesley/data.html) | January 1-8, 2024; 100 W to 20 E, 20 N to 65 N; all native 2.5 degree samples. Float32 `[day][component u,v][latitude ascending][longitude ascending]`, 8 x 2 x 19 x 49. |

The `.bin` files are gzip streams of little-endian float32. They deliberately have no `.gz` suffix:
Vite serves `.gz` with `Content-Encoding: gzip`, which makes browsers decompress it before the explicit
`DecompressionStream` in the example. An ordinary binary extension gives consistent bytes in development and builds.

2MASS sky positions and colour are plotted directly, not converted into an invented distance. The sample spans
the sky but is a biased demonstration subset, not a complete, random or volume-limited star survey. The query's
`TOP` has no sort; the frozen response is pinned by its hash, and a fresh archive query can return another order
or subset. Keep the cached `test-results/sciviz-data/2mass.csv` to reproduce the exact bytes. Gaia was considered
but its [current archive terms](https://www.cosmos.esa.int/web/gaia-users/license) are CC BY-NC 3.0 IGO.

Wind positions use an equirectangular projection centred at 40 W, 42.5 N. For latitude phi, projected direction is
`(u cos(42.5 N) / cos(phi), v)`. Both components are rescaled together to the original `hypot(u,v)`, so arrow
direction follows the projection and colour and arrow length still encode physical speed. Interpolation is
bilinear between native samples. Streamlines are instantaneous daily mean field traces, not parcel trajectories.
No forecast skill or performance claim is made.

The **Moving wind** example reuses this exact `wind.bin` and `wind.json` hash manifest (no new download).
For physical-time integration it converts native m/s to projected km/s, using
`(u / 1000 * cos(42.5 N) / cos(phi), v / 1000)` **without** the instantaneous display's speed rescaling.
Daily snapshots at seconds 0 through 604800 are interpolated linearly in time and bilinearly in space.
GPU particles use 600 s RK4 steps, 32 history samples, fixed deterministic seeds and a two-day endpoint lifetime;
domain exits respawn at those seeds. The gold pathline follows a January 1 release to January 3; the pink
streakline observes January 3 particles released every three hours at the same seed. They are distinct numerical
constructions and remain fixed reference curves during particle playback. Daily means omit subdaily variability;
these are projected numerical trajectories, not measured parcel paths, forecasts or great-circle transport.
The original public-domain NOAA credit, input hashes and asset hash apply unchanged.

Rebuild from the repository root with Python and `numpy`, `nibabel`, `netCDF4` installed:

```sh
python scripts/prepare-sciviz-data.py
```

Downloads are cached under this worktree's `test-results/sciviz-data/`, never in another checkout. The script records
the raw download hashes and derived asset hashes and refuses source bytes that differ from the frozen manifests.
The checked-in assets were prepared with Python 3.15, NumPy 2.5.4, nibabel 5.4.2 and netCDF4 1.7.5.1.post1.
`head.json` and `wind.json` pin the original inputs; changing
an input or reduction requires reviewing the recorded hashes and rerunning the structure and browser checks.

Credit: UCLA Consortium for Neuropsychiatric Phenomics, Poldrack et al. (2016),
[doi:10.1038/sdata.2016.110](https://doi.org/10.1038/sdata.2016.110).
2MASS is a joint project of the University of Massachusetts and IPAC/California Institute of Technology,
funded by NASA and NSF. NCEP-NCAR Reanalysis 1 data provided by NOAA PSL, Boulder, Colorado, USA.
