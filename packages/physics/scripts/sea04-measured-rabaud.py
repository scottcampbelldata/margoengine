"""Recover the 37 measured markers from Rabaud–Moisy Fig. 2, arXiv v1."""
from pathlib import Path
import argparse
import hashlib
import json
import math
import sys
import urllib.request

# The arguments are read first: help and a mistyped flag end the run before anything is imported, fetched or written.
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Recover the measured markers. Nothing is fetched without --download.")
    parser.add_argument("--download", action="store_true", help="fetch the pinned paper if it is not on this machine")
    ARGS = parser.parse_args()

import pymupdf

HERE = Path(__file__).resolve().parents[3] / "test-results/sea04-measured"
URL = "https://arxiv.org/pdf/1304.2653v1"
SHA = "3e6b54fd1ff39ed38944f45bf5b9cee90d79e8a224a5d3fba6a001349546928a"
FIGURE = {"plot_left": 104.35319519042969, "plot_right": 266.33380126953125,
          "plot_top": 502.26959228515625, "plot_bottom": 623.7471313476562,
          "froude_range": [0.1, 4.0], "angle_degrees_range": [3.0, 40.0]}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    HERE.mkdir(parents=True, exist_ok=True)
    source = HERE / "sea04-measured-rabaud-moisy.pdf"
    if not source.exists():
        if not ARGS.download:
            sys.exit(f"Missing {source} ({URL}). Nothing was fetched. To fetch it, run: "
                     "python packages/physics/scripts/sea04-measured-rabaud.py --download")
        request = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read()
        assert hashlib.sha256(raw).hexdigest() == SHA
        source.write_bytes(raw)
    assert digest(source) == SHA
    with pymupdf.open(source) as document:
        page = document[1]
        shapes = page.get_drawings()
    # Unstroked, pure-red four-Bezier discs are observations. The legend
    # has a stroked red symbol, and the numerical results are yellow squares.
    points = [path["rect"] for path in shapes
              if path["color"] is None and path["fill"] == (1.,0.,0.)
              and len(path["items"]) == 4]
    assert len(points) == 37
    x0,x1 = FIGURE["plot_left"],FIGURE["plot_right"]
    y0,y1 = FIGURE["plot_top"],FIGURE["plot_bottom"]
    segments = [path["items"][0] for path in shapes
                if path["color"] == (0.,0.,0.) and len(path["items"]) == 1
                and path["items"][0][0] == "l"]
    x_ticks = [a.x for _,a,b in segments if abs(a.y-y1)<.01 and abs(a.x-b.x)<.01 and abs(a.y-b.y)>3.]
    y_ticks = [a.y for _,a,b in segments if abs(a.x-x0)<.01 and abs(a.y-b.y)<.01 and abs(a.x-b.x)>3.]
    for target in [.1,.2,.4,.6,1.,2.,3.]:
        projected = x0+(x1-x0)*math.log(target/.1)/math.log(40.)
        assert min(abs(projected-n) for n in x_ticks)<.045
    for target in [3.,4.,6.,8.,10.,20.,40.]:
        projected = y1-(y1-y0)*math.log(target/3.)/math.log(40./3.)
        assert min(abs(projected-n) for n in y_ticks)<.045
    rows=[]
    for index,point in enumerate(points):
        x=(point.x0+point.x1)/2.
        y=(point.y0+point.y1)/2.
        assert x0<x<x1 and y0<y<y1
        fr=.1*math.exp((x-x0)/(x1-x0)*math.log(40.))
        angle=3.*math.exp((y1-y)/(y1-y0)*math.log(40./3.))
        rows.append({"plot_marker":index,"froude":fr,"half_angle_deg":angle,"centre_pdf_pt":[x,y]})
    cases=[]
    for wanted in (.42,1.03):
        chosen=min((row for row in rows if .35<=row["froude"]<=1.15),
                   key=lambda row: (abs(row["froude"]-wanted),row["plot_marker"]))
        cases.append({"plot_marker":chosen["plot_marker"],"froude":chosen["froude"],"selection_target":wanted})
    data={"source":URL,"source_sha256":SHA,"figure":2,"printed_page":2,
          "published_angle_uncertainty_deg":1.,"axis_calibration":FIGURE,
          "measured_markers":rows,
          "extraction":"Vector-centre reconstruction of the plotted measurements, sorted only at lookup. The publisher supplemental table was unavailable.",
          "velocity_input_qualification":"The authors computed speed from the wavelength, so these rows cannot independently validate dispersion."}
    body={"source":URL,"holdout_marker_range_froude":[.35,1.15],"cases":cases,
          "gravity":9.81,"hull_length_m":1.,"source_radius_over_hull_length":.5,
          "source_pressure_head_over_length":.001,"depth":"deep",
          "probe_angles_deg":[0.,26.,.25],"distance_centres_over_wavelength":[2.,3.,4.],
          "radial_window_radius_over_wavelength":.5,"radial_samples":41,
          "forcing_travel_over_wavelength":8.,"relative_x_extent":5.5,
          "relative_z_extent":10.5,"coarse_max_grid_over_hull_length":.25,
          "coarse_min_cells_per_transverse_wavelength":16,"grid_step_rate_hz":60,
          "sponge_width_over_wavelength":.6,"source_ramp_over_wavelength":1.,
          "angle_estimator":"Maximum positive elevation along each radial window, averaged between sides, then angle of the largest crest. Summary is median of the three windows.",
          "geometry_qualification":"A circular prescribed pressure footprint fixes the independent length scale. The photographs do not supply enough vessel shape or exposure to identify hull-specific source spectra."}
    for name,content in [("markers",data),("plan",body)]:
        path=HERE/f"sea04-measured-rabaud-{name}.json"
        path.write_text(json.dumps(content,indent=2)+"\n")
        print(name,digest(path))
    print("measurement count",len(rows),"planned Froudes",[case["froude"] for case in cases])


if __name__ == "__main__":
    main()
