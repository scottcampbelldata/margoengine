"""Package a reviewed NASA Exoplanet Archive TAP CSV for Chart Wall."""
from argparse import ArgumentParser
from csv import DictReader
from hashlib import sha256
from pathlib import Path
import gzip
import json

parser = ArgumentParser(description=__doc__)
parser.add_argument("csv", type=Path)
args = parser.parse_args()
source = args.csv.read_bytes()
groups = ("Transit", "Radial Velocity")
metrics = []
details = []
with args.csv.open(newline="", encoding="utf-8") as stream:
    for row in DictReader(stream):
        method = row["discoverymethod"]
        group = groups.index(method) if method in groups else 2
        v = lambda key: float(row[key]) if row[key] else None
        metrics.append([int(row["disc_year"]), group, v("pl_orbper"), v("pl_rade")])
        details.append([row["pl_name"], method, *[v(key) for key in ("pl_orbpererr1", "pl_orbpererr2", "pl_radeerr1", "pl_radeerr2")]])
if len(details) != len({row[0] for row in details}) or any(not 1992 <= row[0] <= 2024 for row in metrics):
    raise ValueError("The snapshot must contain one row per named planet in 1992 to 2024.")
folder = Path(__file__).resolve().parent
def write_asset(name, rows, fields):
    encoded = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()
    packed = gzip.compress(encoded, compresslevel=9, mtime=0)
    (folder / name).write_bytes(packed)
    return {"filename": name, "sha256": sha256(packed).hexdigest(), "bytes": len(packed), "fields": fields}
history = []
for year in range(1992, 2025):
    counts = [0, 0, 0]
    plotted = 0
    for found, method, period, radius in metrics:
        if found != year:
            continue
        counts[method] += 1
        if period is not None and radius is not None and .1 <= period <= 10000 and 0 < radius <= 24:
            plotted += 1
    history.append([*counts, plotted])
(folder / "history.json").write_text(json.dumps(history, separators=(",", ":")) + "\n", encoding="utf-8")
record = {
    "dataset": "Planetary Systems Composite Parameters (PSCompPars)",
    "provider": "NASA Exoplanet Archive, NExScI/Caltech",
    "doi": "10.26133/NEA13",
    "snapshotDate": "2026-11-27",
    "url": "https://exoplanetarchive.ipac.caltech.edu/TAP/sync",
    "query": "select pl_name,disc_year,discoverymethod,pl_orbper,pl_rade,pl_orbpererr1,pl_orbpererr2,pl_radeerr1,pl_radeerr2 from pscomppars where disc_year between 1992 and 2024 order by disc_year,pl_name",
    "sourceSha256": sha256(source).hexdigest(),
    "rowCount": len(metrics),
    "metrics": write_asset("planets.bin", metrics, ["discoveryYear", "methodIndex", "periodDays", "radiusEarth"]),
    "details": write_asset("detail.bin", details, ["name", "discoveryMethod", "periodUpper", "periodLower", "radiusUpper", "radiusLower"]),
    "methods": ["Transit", "Radial Velocity", "Other"],
    "missing": "null",
}
(folder / "source.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(json.dumps(record, indent=2))
