"""Freeze public NOAA ISD-lite winds and EIA 2023 source-to-sector flows, no implementation inputs."""
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
sources = []


def download(url):
    with urlopen(url, timeout=60) as response:
        data = response.read()
    sources.append({"url": url, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
    return data


wind = []
raw = download("https://noaa-isd-pds.s3.amazonaws.com/isd-lite/data/2023/725030-14732-2023.gz")
for line in gzip.decompress(raw).decode("ascii").splitlines():
    row = [int(v) for v in line.split()]
    if row[1] != 1:
        continue
    # ISD-lite columns: year month day hour temperature dewpoint pressure direction speed ...
    if row[8] >= 0 and (0 <= row[7] <= 360 or row[8] < 5):
        wind.append({"date": f"{row[0]:04}-{row[1]:02}-{row[2]:02}T{row[3]:02}:00:00Z",
                     "direction": row[7] if row[7] >= 0 else None, "speed": row[8] / 10})

links = []
raw_rows = []
for table, sector in [("T02.02", "Residential"), ("T02.03", "Commercial"),
                      ("T02.04", "Industrial"), ("T02.05", "Transport"), ("T02.06", "Electric power")]:
    raw = download(f"https://www.eia.gov/totalenergy/data/browser/csv.php?tbl={table}")
    for row in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))):
        if row["YYYYMM"] == "202313" and row["MSN"][:2] in ["CL", "NN", "NG", "PA", "PM", "RE", "NU"]:
            raw_rows.append(row)
            try:
                value = float(row["Value"])
            except ValueError:
                continue  # Preserve unavailable source cells in provenance; never invent a value.
            if value > 0:
                source = {"CL": "Coal", "NN": "Natural gas", "NG": "Natural gas", "PA": "Petroleum", "PM": "Petroleum", "RE": "Renewables", "NU": "Nuclear"}[row["MSN"][:2]]
                links.append({"source": source, "target": sector, "value": value})

outputs = {}
for name, value in [("wind.json", wind), ("energy.json", {"links": links, "year": 2023, "unit": "trillion Btu"})]:
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    (ROOT / name).write_bytes(data)
    outputs[name] = hashlib.sha256(data).hexdigest()
(ROOT / "source.json").write_text(json.dumps({
    "sources": sources, "outputs": outputs, "license": "US government public-domain data, NOAA and US EIA credit retained",
    "wind": "JFK 725030-14732, January 2023 ISD-lite, valid speed in m/s, direction-from degrees. Missing direction allowed only for calm <0.5 m/s.",
    "energy": "2023 annual MER tables 2.2 through 2.6, five disjoint primary-source categories, original trillion Btu. No electricity sales or allocated losses double counting. Non-numeric and zero cells absent from links; original cells retained below. Rounding may leave differences at totals.",
    "energyCells": raw_rows,
    "preparation": "prepare.py; HTTPS downloads with 60-second timeouts, SHA-256 before reduction"
}, indent=2) + "\n", encoding="utf-8")
