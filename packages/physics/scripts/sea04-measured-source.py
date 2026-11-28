"""Freeze DHI F1 incident-only inputs or decode the separate held-out gauge."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.request
import xml.etree.ElementTree as ET
from zipfile import ZipFile

# The arguments are read first: help and a mistyped word end the run before anything is imported, fetched or written.
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SEA-04 measured comparison. Only `fetch` downloads.")
    parser.add_argument("command", nargs="?", choices=("fetch", "plan", "score"))
    parser.add_argument("variant", nargs="?", default="", choices=("", "crest", "upstream"))
    ARGS, unknown = parser.parse_known_args()
    # Named before a missing command is, so a mistyped flag is the thing the message shows.
    if unknown:
        parser.error("unrecognized arguments: " + " ".join(unknown))
    if ARGS.command is None:
        parser.error("choose fetch, plan or score")

import numpy as np
from scipy.special import hankel1, h1vp, jv, jvp

HERE = Path(__file__).resolve().parents[3] / "test-results/sea04-measured"
INCIDENT_HASH = "d8a3bd21e90894d8c4e0b5f345da9c9bd26782f9b520afd6168c05d3c327f07b"
HOLDOUT_HASH = "486475d8556a7a715036565f0267cad545bb990d24fefbad8ab87cab7d16ff29"
CATALOG = "https://www.ccp-wsi.ac.uk/catalogue/test_cases/test_case_008/"
BASE_URL = "https://www.ccp-wsi.ac.uk/wp-content/uploads/2022/06/"
DEPTH = .505
RADIUS = .125
GAUGE = .127
G = 9.81
FRANGE = (.35, 1.65)
FOCUS = 40.0
START = 37.5
PERIOD = 1.22
RATE = 60
SCORE = (FOCUS-PERIOD, FOCUS+PERIOD)
VARIANT = ARGS.variant if __name__ == "__main__" else ""
SUFFIX = "-"+VARIANT if VARIANT else ""
ORIGIN = (-2.5, -5.0)
DOMAIN = (5.0, 8.0)
# Chen et al. (2014), §3.1 and Fig. 5: WG1 is 0.77 m from the paddle, the cylinder centre is 7.52 m.
UPSTREAM_GAUGE = .77 - 7.52


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()



def fetch():
    HERE.mkdir(parents=True, exist_ok=True)
    for filename,address,expected in (
        ("dhi-incident.xlsx", "F1.F3.-.incoming.wave_.data_.xlsx", INCIDENT_HASH),
        ("dhi-holdout.xlsx", "F1.F3.-.with_.cylinder.in_.place_.xlsx", HOLDOUT_HASH),
    ):
        target = HERE / filename
        if target.exists():
            assert sha(target) == expected
            continue
        request = urllib.request.Request(BASE_URL+address, headers={"User-Agent":"Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read()
        assert hashlib.sha256(raw).hexdigest() == expected
        target.write_bytes(raw)
    print("DHI incident and holdout hashes verified.")



def sheet(path, gauge_name="WG9"):
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rel = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relations = {v.get("Id"):v.get("Target") for v in rel}
        gauge = next(v for v in workbook.iter(ns+"sheet") if v.get("name") == gauge_name)
        key = next(value for name,value in gauge.attrib.items() if name.endswith("}id"))
        location = relations[key]
        location = location.lstrip("/") if location.startswith("/") else "xl/"+location
        strings = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        strings = ["".join(v.text or "" for v in s.iter(ns+"t")) for s in strings]
        root = ET.fromstring(archive.read(location)).find(ns+"sheetData")
    header = {}
    columns = {}
    relevant = {"t(s)", "f1_crest", "f1_trough"}
    for node in root[0]:
        raw = node.findtext(ns+"v")
        if raw is None:
            continue
        label = strings[int(raw)] if node.get("t") == "s" else raw
        label = label.strip().lower().replace(" ", "")
        col = re.match("[A-Z]+", node.get("r")).group()
        header[col] = label
        if label in relevant:
            columns[label] = []
    assert set(columns) == relevant, header
    for row in list(root)[1:]:
        line = {}
        for node in row:
            col = re.match("[A-Z]+", node.get("r")).group()
            label = header.get(col)
            if label in columns:
                raw = node.findtext(ns+"v")
                if raw is not None:
                    line[label] = float(raw)
        if line:
            assert set(line) == relevant
            for label,numbers in columns.items():
                numbers.append(line[label])
    t,crest,trough = (np.asarray(columns[k]) for k in ("t(s)","f1_crest","f1_trough"))
    assert len(t)>3000 and np.all(np.diff(t)>0.)
    return t,crest,trough


def gravity_k(omega):
    lo, hi = np.zeros_like(omega), 8.+2.*omega**2/G
    for _ in range(55):
        mid = .5*(lo+hi)
        less = G*mid*np.tanh(mid*DEPTH)<omega**2
        lo,hi = np.where(less,mid,lo),np.where(less,hi,mid)
    return .5*(lo+hi)


def circular_transfer(omega):
    k = gravity_k(omega)
    m = np.arange(20)[:,None]
    weight = np.where(m==0,1.,2.)*(1j)**m*(-1.)**m
    scatter = jvp(m,k*RADIUS)/h1vp(m,k*RADIUS)
    direct = jv(m,k*GAUGE)
    incident = (weight*direct).sum(0)*np.exp(1j*k*GAUGE)
    assert np.max(abs(incident-1.))<1e-13
    wall_derivative = jvp(m,k*RADIUS)-scatter*h1vp(m,k*RADIUS)
    assert np.max(abs(wall_derivative))<1e-13
    total = (weight*(direct-scatter*hankel1(m,k*GAUGE))).sum(0)
    return (total*np.exp(1j*k*GAUGE)).conj()


def input_plan():
    upstream = VARIANT == "upstream"
    path = HERE / ("dhi-holdout.xlsx" if upstream else "dhi-incident.xlsx")
    assert sha(path) == (HOLDOUT_HASH if upstream else INCIDENT_HASH)
    t,crest,trough = sheet(path, "WG1" if upstream else "WG9")
    data = crest.copy() if VARIANT else .5*(crest-trough)
    quiet = (t>=1.)&(t<20.)
    quiet_mean = float(np.mean(data[quiet]))
    quiet_max = float(np.max(abs(data[quiet]-quiet_mean)))
    dt = .01
    start, end, taper = (24., 42., 2.) if upstream else (30., 50., 4.)
    bins = start + np.arange(round((end-start)/dt))*dt
    window = np.clip(np.minimum(bins-start, end-bins)/taper,0.,1.)
    data = (np.interp(bins,t,data)-quiet_mean)*np.sin(np.pi/2*window)**2
    freq = np.fft.rfftfreq(len(data),dt)
    ft = np.fft.rfft(data)
    keep = (freq>=FRANGE[0])&(freq<=FRANGE[1])
    omega = 2.*np.pi*freq[keep]
    coef = 2.*ft[keep]/len(data)*np.exp(1j*omega*(FOCUS-bins[0]))
    if upstream:
        # Transfer the separately measured incoming signal to the WG9 plane, without comparing to WG9.
        coef *= np.exp(-1j*gravity_k(omega)*(-GAUGE-UPSTREAM_GAUGE))
    seconds = START + np.arange(round((SCORE[1]-START)*RATE)+2)/RATE
    phasor = np.exp(1j*omega[:,None]*(seconds-FOCUS))
    plane_trace = np.real(coef @ phasor)
    transfer = circular_transfer(omega)
    circular_trace = np.real((coef*transfer) @ phasor)
    incident_file = "F1.F3.-.with_.cylinder.in_.place_.xlsx" if upstream else "F1.F3.-.incoming.wave_.data_.xlsx"
    incident_proxy = ("same-run upstream WG1 crest, propagated by the finite-depth dispersion relation"
                      if upstream else "single crest, independent no-cylinder WG9 workbook, fixed trigger time"
                      if VARIANT else "half crest minus trough, independent no-cylinder WG9 workbook, fixed trigger time")
    payload = {"source":CATALOG,"incident_source":BASE_URL+incident_file,
               "heldout_source":BASE_URL+"F1.F3.-.with_.cylinder.in_.place_.xlsx",
               "incident_xlsx_sha256":sha(path),"heldout_xlsx_sha256":HOLDOUT_HASH,
               "case":"F1 WG9","gravity":G,"depth":DEPTH,"cylinder_radius":RADIUS,
               "gauge":[0.,-GAUGE],"focus_s":FOCUS,"start_s":START,"rate":RATE,
               "score_s":SCORE,"frequency_hz":FRANGE,"incident_window_s":[start,end],
               "incident_linear_proxy":incident_proxy,
               "source_band_energy_fraction":float(np.sum(abs(ft[keep])**2)/np.sum(abs(ft[1:])**2)),
               "background_max_incident_m":quiet_max,"origin_m":ORIGIN,"domain_m":DOMAIN,"sponge_m":1.,
               "sponge_rate":4.,
               "grids":{"coarse":{"dx":.0625,"layers":4},"fine":{"dx":.03125,"layers":6}},
               "reference":"MacCamy-Fuchs full-depth linear circular diffraction at exact WG9 position",
               "score_method":("raw crest-run elevation versus incident-band prediction at fixed timestamps"
                               if VARIANT else "raw odd component, fixed timestamps, measured half-difference versus prediction")+
                               ". Report quiet input noise, two-grid delta and analytic-to-numeric RMS separately.",
               "modes":[[float(o),float(a.real),float(a.imag)] for o,a in zip(omega,coef)],
               "time_s":seconds.tolist(),"analytical_incident_m":plane_trace.tolist(),
               "analytical_cylinder_m":circular_trace.tolist()}
    if upstream:
        payload["incident_gauge_m"] = UPSTREAM_GAUGE
    target = HERE/("sea04-measured-plan"+SUFFIX+".json")
    target.write_text(json.dumps(payload,indent=2)+"\n")
    print("frozen plan",sha(target),"retained energy",payload["source_band_energy_fraction"],
          "background m",quiet_max,"duration",seconds[-1]-seconds[0])


def score():
    plan_file = HERE/("sea04-measured-plan"+SUFFIX+".json")
    plan = json.loads(plan_file.read_text())
    seen = HERE/"dhi-holdout.xlsx"
    assert sha(seen) == plan["heldout_xlsx_sha256"]
    manifest = HERE/("sea04-measured-frozen-predictions"+SUFFIX+".json")
    files = json.loads(manifest.read_text())
    assert files["plan_sha256"] == sha(plan_file)
    for name,digest in files["prediction_sha256"].items():
        assert sha(HERE/name) == digest
    t,c,r = sheet(seen)
    arr = np.asarray(plan["time_s"])
    keep = (arr>=plan["score_s"][0])&(arr<=plan["score_s"][1])
    decision = arr[keep]
    assert t[0]<=decision[0]<decision[-1]<=t[-1]
    obs = np.interp(decision,t,c if VARIANT else .5*(c-r))
    peak=(float(np.max(obs)),float(decision[np.argmax(obs)]))
    expected=np.asarray(plan["analytical_cylinder_m"])[keep]
    incoming=np.asarray(plan["analytical_incident_m"])[keep]
    results={}
    rms=lambda a:float(np.sqrt(np.mean(a*a)))
    predictions={}
    for path in files["prediction_sha256"]:
        data = json.loads((HERE/path).read_text())
        assert data["plan_sha256"] == sha(plan_file)
        for name,run in data["results"].items():
            computed = np.asarray(run["cylinder"]["height_m"])[keep]
            control = np.asarray(run["open"]["height_m"])[keep]
            predictions[name]=computed
            residual = computed-obs
            results[name] = {"signed_rms_m":rms(residual),"bias_m":float(np.mean(residual)),
                             "predicted_crest_m":float(np.max(computed)),
                             "predicted_crest_t":float(decision[np.argmax(computed)]),
                             "measured_crest_m":peak[0],"measured_crest_t":peak[1],
                             "maximum_error_m":float(np.max(abs(residual))),
                             "open_numeric_vs_incoming_rms_m":rms(control-incoming),
                             "numerical_vs_exact_circle_rms_m":rms(computed-expected),
                             "measured_m":obs.tolist(),"predicted_m":computed.tolist()}
    pair = rms(predictions["fine"]-predictions["coarse"]) if set(predictions)=={"fine","coarse"} else None
    report={"measured_xlsx_sha256":sha(seen),"prediction_freeze_sha256":sha(manifest),
            "score_s":plan["score_s"],"observed_trigger_start_s":float(t[0]),
            "observed_sample_dt_s":float(np.median(np.diff(t))),
            "analytical_circle_vs_measurement_rms_m":rms(expected-obs),
            "incident_background_max_m":plan["background_max_incident_m"],"two_grid_delta_rms_m":pair,
            "sample_times_s":decision.tolist(),"grid_results":results,
            "qualification":"Three separate uncertainty indicators. The study does not publish WG9 instrument uncertainty. No fitted shift, gain, or obstacle parameter."}
    (HERE/("sea04-measured-score"+SUFFIX+".json")).write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({**{k:v for k,v in report.items() if k not in ("sample_times_s","grid_results")},
                      "grid_results":{k:{a:b for a,b in n.items() if not a.endswith("_m") or np.isscalar(b)}
                                      for k,n in results.items()}},indent=2))


if __name__ == "__main__":
    {"fetch":fetch,"plan":input_plan,"score":score}[ARGS.command]()
