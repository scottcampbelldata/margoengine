"""Transcribe the published Drähne et al. boundary and holdout.

Pass the original jmse-04-00001-s001.zip supplement and optionally the
case T20_H2 or T30_H2 (default).
The output uses micrometres and micrometres per second for the gauged series.
Camera positions, measurement times, and missing values are unchanged.
"""

import hashlib
import json
import math
from pathlib import Path
import sys
import zipfile


URL = "https://mdpi-res.com/d_attachment/jmse/jmse-04-00001/article_deploy/jmse-04-00001-s001.zip"
SHA256 = "85bae342afed7f2adefe5e377c765d5a15f985d4ce30528279c31dd421efeb28"
STRIDE = 5  # Keep inputs on a 0.05 s lattice after centering the 1 s filter.
HALF_WINDOW = 50
CASES = {"T20_H2": ("T020H2", 40, 52), "T30_H2": ("T030H2", 40, 57)}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def rows(data):
    return [[float(value) for value in line.split()] for line in data.splitlines()[1:]]


def centred_mean(values, tick):
    # Trapezoidal integration of the original piecewise-linear signal over
    # [t - 0.5 s, t + 0.5 s]. Before t=0 the tank is at rest.
    low, high = tick - HALF_WINDOW, tick + HALF_WINDOW
    start = values[low] if low >= 0 else 0.0
    centre = math.fsum(values[max(low + 1, 0):high])
    return (0.5 * start + centre + 0.5 * values[high]) / (2 * HALF_WINDOW)


def series_error(values, lattice):
    max_error = 0.0
    for tick, exact in enumerate(values):
        knot, remainder = divmod(tick, STRIDE)
        cooked = lattice[knot] * 1e-6
        if remainder:
            cooked += (lattice[knot + 1] - lattice[knot]) * remainder / STRIDE * 1e-6
        max_error = max(max_error, abs(cooked - exact))
    return max_error


def transcribe(gauge_data, camera_data, start, end):
    last_tick = 100 * end  # Inclusive end of the score interval, in 0.01 s ticks.
    gauge_rows = rows(gauge_data)[:last_tick + HALF_WINDOW + 1]
    assert len(gauge_rows) == last_tick + HALF_WINDOW + 1
    assert all(row[0] == i / 100 for i, row in enumerate(gauge_rows))
    metres = [row[3] * 0.01 for row in gauge_rows]
    outward_speed = [-row[6] * 0.01 for row in gauge_rows]
    heights = [centred_mean(metres, i) for i in range(last_tick + 1)]
    speeds = [centred_mean(outward_speed, i) for i in range(last_tick + 1)]
    eta = [round(value * 1e6) for value in heights[::STRIDE]]
    velocity = [round(value * 1e6) for value in speeds[::STRIDE]]
    gauges = [
        [round(row[4] * 10000), round(row[5] * 10000)]
        for row in gauge_rows[:last_tick + 1:STRIDE]
    ]
    camera = [
        [time, position if math.isfinite(position) else None]
        for time, position, _ in rows(camera_data)
        if start <= time <= end
    ]
    return {
        "gaugeSha256": sha(gauge_data),
        "cameraSha256": sha(camera_data),
        "etaMicrometres": eta,
        "outwardVelocityMicrometresPerSecond": velocity,
        "holdoutGaugeMicrometres": gauges,
        "holdoutShorelineSecondsMetres": camera,
        "maxInputHeightResampleErrorMetres": series_error(heights, eta),
        "maxInputVelocityResampleErrorMetresPerSecond": series_error(speeds, velocity),
    }


wave = sys.argv[2] if len(sys.argv) > 2 else "T30_H2"
if wave not in CASES:
    raise SystemExit("Choose T20_H2 or T30_H2.")
prefix, start, end = CASES[wave]
with Path(sys.argv[1]).open("rb") as archive:
    if sha(archive.read()) != SHA256:
        raise SystemExit("Use the original publisher supplement named in the source URL.")
    archive.seek(0)
    with zipfile.ZipFile(archive) as data:
        runs = [
            transcribe(data.read(f"data/{prefix}Exp{run}.txt"), data.read(f"data/{prefix}RunupExp{run}.txt"), start, end)
            for run in range(1, 7)
        ]
print(json.dumps({
    "doi": "10.3390/jmse4010001",
    "source": URL,
    "archiveSha256": SHA256,
    "wave": wave,
    "scoreIntervalSeconds": [start, end],
    "secondsPerSample": STRIDE / 100,
    "runs": runs,
}, separators=(",", ":"), allow_nan=False))
