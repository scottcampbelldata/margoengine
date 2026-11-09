"""Rebuild the small real-data sciviz assets. See examples/assets/sciviz/README.md.

Run from the repo root with Python, numpy, nibabel and netCDF4 installed.
Downloads stay in this worktree's ignored test-results folder. No source code
from another project is used; only published scientific data are downloaded.
"""
import argparse
import csv
import gzip
import hashlib
import json
from pathlib import Path
import urllib.request
import urllib.parse

import nibabel as nib
import netCDF4
import numpy as np

OUT = Path("examples/assets/sciviz")
CACHE = Path("test-results/sciviz-data")
OUT.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)


def download(url, name):
    dest = CACHE / name
    if not dest.exists():
        with urllib.request.urlopen(url, timeout=120) as response:
            dest.write_bytes(response.read())
    return dest


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_sources(name, sources):
    manifest = OUT / (name + ".json")
    if manifest.exists():
        pinned = json.loads(manifest.read_text(encoding="utf-8"))["sourceSHA256"]
        expected = pinned if isinstance(pinned, list) else [pinned]
        actual = list(map(sha, sources))
        if actual != expected:
            raise ValueError(f"{name}: source bytes differ from the frozen manifest. "
                             "Keep the original cache to reproduce it exactly; review any new dataset before replacing it.")


def record(name, value):
    (OUT / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    print(name, json.dumps(value))


def mri():
    url = "https://s3.amazonaws.com/openneuro.org/ds000030/sub-10159/anat/sub-10159_T1w.nii.gz"
    source = download(url, "sub-10159_T1w.nii.gz")
    check_sources("head", [source])
    image = nib.as_closest_canonical(nib.load(source))
    # Canonical RAS axes, every second voxel, no invented samples or intensity scaling.
    data = np.asarray(image.dataobj)[::2, ::2, ::2].astype("<u2")
    spacing = np.asarray(image.header.get_zooms()[:3]) * 2
    dims = list(data.shape)
    header = ("NRRD0005\n# OpenNeuro ds000030 sub-10159 T1w, CC0\n"
              "type: ushort\ndimension: 3\nsizes: " + " ".join(map(str, dims)) +
              "\nspacings: " + " ".join(map(str, spacing)) +
              "\nencoding: gzip\nendian: little\n\n")
    dest = OUT / "head.nrrd"
    dest.write_bytes(header.encode("ascii") + gzip.compress(data.tobytes(order="F"), mtime=0))
    record("head", {"source": url, "sourceSHA256": sha(source), "sha256": sha(dest),
                   "license": "CC0-1.0", "dims": dims, "spacing": spacing.tolist(),
                   "range": [int(data.min()), int(data.max())], "bytes": dest.stat().st_size})


def wind():
    urls = [f"https://downloads.psl.noaa.gov/Datasets/ncep.reanalysis.dailyavgs/surface/{c}wnd.sig995.2024.nc"
            for c in ["u", "v"]]
    sources = [download(url, url.rsplit("/", 1)[1]) for url in urls]
    check_sources("wind", sources)
    with netCDF4.Dataset(sources[0]) as ds:
        lat = np.asarray(ds["lat"][:])
        lon = (np.asarray(ds["lon"][:]) + 180) % 360 - 180
    # North Atlantic, January 1-8 2024, all native 2.5 degree samples in this box.
    yi = np.flatnonzero((lat >= 20) & (lat <= 65))[::-1]
    xi = np.flatnonzero((lon >= -100) & (lon <= 20))
    xi = xi[np.argsort(lon[xi])]
    fields = []
    for source, name in zip(sources, ["uwnd", "vwnd"]):
        with netCDF4.Dataset(source) as ds:
            fields.append(np.asarray(ds[name][:8, yi, xi], dtype="<f4"))
    # x fastest, then y, then component (u,v), then day. Values stay physical m/s.
    data = np.stack(fields, axis=1)
    assert np.isfinite(data).all()
    dest = OUT / "wind.bin"
    dest.write_bytes(gzip.compress(data.tobytes(), mtime=0))
    record("wind", {"sources": urls, "sourceSHA256": list(map(sha, sources)), "sha256": sha(dest),
                    "license": "public domain (US government)", "dims": [len(xi), len(yi)],
                    "bounds": [-100, 20, 20, 65], "days": 8, "start": "2024-01-01",
                    "range": [float(data.min()), float(data.max())], "bytes": dest.stat().st_size})


def stars():
    query = ("SELECT TOP 1000000 ra,dec,j_m,k_m,cntr FROM fp_psc "
             "WHERE ph_qual='AAA' AND cc_flg='000' AND MOD(cntr,100)=0")
    url = "https://irsa.ipac.caltech.edu/TAP/sync?" + urllib.parse.urlencode(
        {"QUERY": query, "FORMAT": "csv", "LANG": "ADQL", "MAXREC": "1000000"})
    source = download(url, "2mass.csv")
    check_sources("stars", [source])
    with source.open(newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    assert len(rows) == 1_000_000, f"Expected 1,000,000 sources, got {len(rows)}"
    # Planar columns: RA, Dec, J-Ks, Ks, all in published units (degrees/magnitudes).
    ra = np.asarray([float(row["ra"]) for row in rows], dtype="<f4")
    dec = np.asarray([float(row["dec"]) for row in rows], dtype="<f4")
    colour = np.asarray([float(row["j_m"]) - float(row["k_m"]) for row in rows], dtype="<f4")
    magnitude = np.asarray([float(row["k_m"]) for row in rows], dtype="<f4")
    dest = OUT / "stars.bin"
    dest.write_bytes(gzip.compress(np.stack([ra, dec, colour, magnitude]).tobytes(), mtime=0))
    record("stars", {"source": url, "query": query, "sourceSHA256": sha(source),
                     "sha256": sha(dest), "count": len(rows), "license": "public domain",
                     "columns": ["ra_deg", "dec_deg", "j_minus_ks_mag", "ks_mag"],
                     "ranges": [[float(col.min()), float(col.max())] for col in [ra, dec, colour, magnitude]],
                     "bytes": dest.stat().st_size})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("only", choices=["mri", "wind", "stars", "all"], default="all", nargs="?")
    args = parser.parse_args()
    if args.only in ["mri", "all"]:
        mri()
    if args.only in ["wind", "all"]:
        wind()
    if args.only in ["stars", "all"]:
        stars()
