"""Clean-room, finite-depth Wigley tow-frame check. Requires NumPy and SciPy."""
from argparse import ArgumentParser
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.optimize import brentq
from scipy.sparse import bmat, coo_matrix, diags
from scipy.sparse.linalg import spsolve


G = 9.8
LENGTH, BEAM, DRAFT = 2.5, 0.25, 0.156
DEPTH, HALF_TANK_WIDTH = 2.35, 1.75
FROUDE = (0.267, 0.316)
STATIONS = tuple(-1 + 0.05 * i for i in range(9))
GRIDS = {"coarse": 0.10, "fine": 0.05}
ROOT = Path(__file__).resolve().parents[3]
RESULTS = ROOT / "test-results" / "sea04-stem"
BEFORE = "a3556082c2306ce770204b44803efee771cdd7eec09a4cb39628bfc91efd9ee3"
AREA_EPS = 1e-14


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, result):
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / f"tow-{name}.json").write_text(
        json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )


def read(name):
    return json.loads((RESULTS / f"tow-{name}.json").read_text(encoding="utf-8-sig"))


def rms(values):
    return float(np.sqrt(np.mean(np.square(values))))


def half_breadth(x, depth):
    return 0.5 * BEAM * np.maximum(0, 1 - (2 * x / LENGTH) ** 2) * np.maximum(0, 1 - (depth / DRAFT) ** 2)


def positive_primitive(q, p, length, z):
    """Integral from zero to q of max(z - p(1-(x/length)^2)_+, 0)."""
    ratio = np.divide(z, p, out=np.ones(np.broadcast_shapes(z.shape, p.shape)), where=p > 0)
    first = length * np.sqrt(np.maximum(0, 1 - ratio))
    endpoint = np.maximum(first, np.minimum(q, length))
    return ((z - p) * (endpoint - first)
            + p * (endpoint**3 - first**3) / (3 * length**2)
            + z * np.maximum(0, q - length))


def face_areas(x, y, z, body):
    """One shared water aperture per face, with the full plane at the tank ends."""
    if not body:
        dims = (len(y) - 1, len(x) - 1, len(z) - 1)
        return (
            np.broadcast_to(np.diff(y)[:, None, None] * np.diff(z)[None, None, :],
                            (dims[0], dims[1] + 1, dims[2])),
            np.broadcast_to(np.diff(x)[None, :, None] * np.diff(z)[None, None, :],
                            (dims[0] + 1, dims[1], dims[2])),
            np.broadcast_to(np.diff(y)[:, None, None] * np.diff(x)[None, :, None],
                            (dims[0], dims[1], dims[2] + 1)),
        )
    axial_primitive = positive_primitive(
        y[:, None, None], half_breadth(x, 0)[None, :, None], DRAFT, z[None, None, :]
    )
    vertical_primitive = np.sign(x)[None, :, None] * positive_primitive(
        np.abs(x)[None, :, None], half_breadth(0, y)[:, None, None], LENGTH / 2, z[None, None, :]
    )
    ax = np.maximum(0, np.diff(np.diff(axial_primitive, axis=0), axis=2))
    ay = np.maximum(0, np.diff(np.diff(vertical_primitive, axis=1), axis=2))

    # On a constant-z face, split each x interval at both depth-edge cuts
    # before Gauss integration. Thus no subcell aperture is missed near a tip.
    left, right = x[:-1, None, None], x[1:, None, None]
    nodes, weights = np.polynomial.legendre.leggauss(12)
    az = np.empty((len(y) - 1, len(x) - 1, len(z)))
    for k, (top, bottom) in enumerate(zip(y[:-1], y[1:])):
        limits = [np.broadcast_to(left, (len(x) - 1, len(z), 1)),
                  np.broadcast_to(right, (len(x) - 1, len(z), 1))]
        for depth in (top, bottom):
            centre_breadth = float(half_breadth(0, depth))
            root = (LENGTH / 2) * np.sqrt(np.maximum(0, 1 - z / centre_breadth)) if centre_breadth else np.zeros_like(z)
            for sign in (-1, 1):
                limits.append(np.clip(sign * root[None, :, None], left, right))
        cuts = np.sort(np.concatenate(limits, axis=2), axis=2)
        interval = 0.5 * np.diff(cuts, axis=2)
        abscissa = (0.5 * (cuts[:, :, 1:] + cuts[:, :, :-1]))[..., None] + interval[..., None] * nodes
        widest = half_breadth(abscissa, 0)
        fraction = np.divide(z[None, :, None, None], widest, out=np.ones_like(widest), where=widest > 0)
        first_water = DRAFT * np.sqrt(np.maximum(0, 1 - fraction))
        open_depth = np.maximum(0, bottom - np.maximum(top, first_water))
        az[k] = np.sum(interval * (open_depth @ weights), axis=2)
    return ax, ay, az


def stencil(ids, opened, spacing):
    """Differentiate along connected wet x runs without looking across the hull."""
    rows, columns, coefficients = [], [], []
    for j in range(ids.shape[1]):
        indices = np.flatnonzero(ids[:, j] >= 0)
        splits = np.flatnonzero((np.diff(indices) != 1) | ~opened[indices[1:], j]) + 1
        for run in np.split(indices, splits):
            if len(run) < 2:
                continue
            active = ids[run, j]
            for i, row in enumerate(active):
                if len(active) == 2:
                    neighbours, weights = active, [-1, 1]
                elif i == 0:
                    neighbours, weights = active[:3], [-1.5, 2, -0.5]
                elif i == len(active) - 1:
                    neighbours, weights = active[-3:], [0.5, -2, 1.5]
                else:
                    neighbours, weights = active[i - 1:i + 2:2], [-0.5, 0.5]
                rows.extend([row] * len(weights))
                columns.extend(neighbours)
                coefficients.extend(weights)
    return coo_matrix((np.asarray(coefficients) / spacing, (rows, columns)),
                      shape=(np.count_nonzero(ids >= 0),) * 2).tocsr()


@dataclass
class Graph:
    bulk: object
    vertical: object
    d_x: object
    top_conductance: np.ndarray
    top_area: np.ndarray
    body_rhs: np.ndarray
    cells: np.ndarray
    surface: np.ndarray
    wet: np.ndarray
    exposed: np.ndarray


def geometry(x, y, z, body):
    ax, ay, az = face_areas(x, y, z, body)
    wet = (ax[:, :-1] + ax[:, 1:] + ay[:-1] + ay[1:] + az[:, :, :-1] + az[:, :, 1:]) > AREA_EPS
    exposed = ay[0] > AREA_EPS
    cells = np.full(wet.shape, -1, dtype=np.int32)
    cells[wet] = np.arange(np.count_nonzero(wet), dtype=np.int32)
    surface = np.full(exposed.shape, -1, dtype=np.int32)
    surface[exposed] = np.arange(np.count_nonzero(exposed), dtype=np.int32)
    yc = 0.5 * (y[:-1] + y[1:])
    x_step, z_step = x[1] - x[0], z[1] - z[0]
    rows, columns, coefficients = [], [], []
    def pairs(left, right, conductance):
        left, right, conductance = np.broadcast_arrays(left, right, conductance)
        connected = (conductance > AREA_EPS) & (left >= 0) & (right >= 0)
        a, b, c = left[connected], right[connected], conductance[connected]
        rows.extend((a, a, b, b))
        columns.extend((a, b, a, b))
        coefficients.extend((c, -c, -c, c))
    pairs(cells[:, :-1], cells[:, 1:], ax[:, 1:-1] / x_step)
    pairs(cells[:-1], cells[1:], ay[1:-1] / np.diff(yc)[:, None, None])
    pairs(cells[:, :, :-1], cells[:, :, 1:], az[:, :, 1:-1] / z_step)
    nc, ns = int(wet.sum()), int(exposed.sum())
    top_area = ay[0][exposed]
    top_cond = top_area / yc[0]
    top_cell_ids = cells[0][exposed]
    rows.append(top_cell_ids)
    columns.append(top_cell_ids)
    coefficients.append(top_cond)
    bulk = coo_matrix((np.concatenate(coefficients),
                       (np.concatenate(rows), np.concatenate(columns))), shape=(nc, nc)).tocsr()
    vertical = coo_matrix((top_cond, (top_cell_ids, np.arange(ns))), shape=(nc, ns)).tocsr()
    b = half_breadth(x[:, None], 0) if body else 0
    surface_open = z[None, 1:] - np.maximum(z[None, :-1], b) > AREA_EPS
    if not body:
        surface_open = np.broadcast_to(surface_open, (len(x), len(z) - 1))
    return Graph(bulk, vertical, stencil(surface, surface_open, x_step), top_cond, top_area,
                 (ax[:, :-1] - ax[:, 1:])[wet], cells, surface, wet, exposed)


def stationary_wave(speed, depth):
    return brentq(lambda k: G * np.tanh(k * depth) / k - speed**2, 1e-8, 2 * G / speed**2)


def damping(x, speed, wavelength, attenuation=0.05, interior=0.005):
    fringe = 2 * wavelength
    distance = np.minimum(x - x[0], x[-1] - x)
    s = np.maximum(0, 1 - distance / fringe)
    smooth = s**3 * (10 - 15 * s + 6 * s**2)
    return speed / wavelength * (interior - np.log(attenuation) * smooth)


def solve(x, y, z, speed, body, top_rhs=None, interior=0.005):
    graph = geometry(x, y, z, body)
    xc = 0.5 * (x[:-1] + x[1:])
    k = stationary_wave(speed, y[-1])
    wavelength = 2 * np.pi / k
    sigma = np.broadcast_to(damping(xc, speed, wavelength, interior=interior)[:, None],
                            graph.exposed.shape)[graph.exposed]
    material = diags(sigma) - speed * graph.d_x
    top = diags(graph.top_conductance) + diags(graph.top_area / G) @ material @ material
    operator = bmat([[graph.bulk, -graph.vertical], [-graph.vertical.T, top]], format="csc")
    body_rhs = speed * graph.body_rhs
    if top_rhs is None:
        top_rhs = np.zeros(len(graph.top_area))
    rhs = np.concatenate((body_rhs, top_rhs))
    solution = spsolve(operator, rhs)
    residual = operator @ solution - rhs
    residual_ratio = np.linalg.norm(residual) / np.linalg.norm(rhs)
    elevation = np.full(graph.surface.shape, np.nan)
    elevation[graph.exposed] = -(material @ solution[len(body_rhs):]) / G
    return graph, elevation, {
        "work": {"bulk_cells": int(graph.wet.sum()), "surface_cells": int(graph.exposed.sum()),
                 "matrix_nnz": int(operator.nnz)},
        "relative_residual": float(residual_ratio),
        "body_flux_m3_s": {"positive": float(body_rhs[body_rhs > 0].sum()),
                            "negative": float(body_rhs[body_rhs < 0].sum()),
                            "sum": float(body_rhs.sum())},
        "top_peak_elevation_m": float(np.nanmax(elevation)),
        "top_min_elevation_m": float(np.nanmin(elevation)),
        "wavelength_m": float(wavelength),
        "sigma_interior_s_inv": float(interior * speed / wavelength),
        "fringe_width_m": float(2 * wavelength),
    }


def controls():
    speed, depth = 1.4, 1.3
    k = stationary_wave(speed, depth)
    wavelength = 2 * np.pi / k
    wave_errors = []
    for divisions in (16, 32):
        edges = np.linspace(-2 * wavelength, 2 * wavelength, 4 * divisions + 1)
        x = 0.5 * (edges[:-1] + edges[1:])
        ids = np.arange(len(x))[:, None]
        derivative = stencil(ids, np.ones((len(edges), 1), bool), edges[1] - edges[0])
        trace = np.cos(k * x)
        exact_normal = k * np.tanh(k * depth) * trace
        exact_eta = -speed * k / G * np.sin(k * x)
        normal_error = rms((exact_normal + speed**2 / G * (derivative @ (derivative @ trace)))[2:-2])
        elevation_error = rms((speed / G * (derivative @ trace) - exact_eta)[2:-2])
        wave_errors.append({"cells_per_wavelength": divisions, "normal_rms": normal_error,
                            "elevation_rms": elevation_error})
    assert wave_errors[0]["normal_rms"] / wave_errors[1]["normal_rms"] > 3.6
    assert wave_errors[0]["elevation_rms"] / wave_errors[1]["elevation_rms"] > 3.6

    x = np.linspace(-10 * wavelength, 10 * wavelength, 481)
    xc = 0.5 * (x[:-1] + x[1:])
    y = np.r_[0, np.geomspace(wavelength / 72, depth, 25)]
    z = np.array([0, 0.1])
    width = .25 * wavelength
    forcing = 2e-4
    source = forcing * (xc / wavelength) * np.exp(-0.5 * (xc / width) ** 2)
    forcing_density = forcing / ((x[1] - x[0]) * (z[1] - z[0]))
    dispersion_slope = np.tanh(k * depth) + k * depth / np.cosh(k * depth)**2 - 2 * speed**2 * k / G
    spectrum = (forcing_density / wavelength * np.sqrt(2 * np.pi)
                * width**3 * k * np.exp(-0.5 * (k * width)**2))
    far_field_rms = 2 * speed * k / G * abs(spectrum / dispersion_slope) / np.sqrt(2)
    graph, eta, checks = solve(x, y, z, speed, False, top_rhs=source)
    behind = (xc < -2 * wavelength) & (xc > -5 * wavelength)
    ahead = (xc > 2 * wavelength) & (xc < 5 * wavelength)
    downstream = rms(eta[behind, 0])
    upstream = rms(eta[ahead, 0])
    zero_crossings = np.count_nonzero(np.diff(np.signbit(eta[behind, 0])))
    result = {"plane_wave": wave_errors, "radiating_channel": {
        **checks, "downstream_m": downstream, "upstream_m": upstream, "downstream_zero_crossings": int(zero_crossings), "undamped_residue_rms_m": float(far_field_rms)}}
    save("controls", result)
    print(json.dumps(result))
    assert checks["relative_residual"] < 1e-8
    assert abs(downstream / far_field_rms - 1) < 0.10
    assert upstream < downstream / 5
    assert 4 <= zero_crossings <= 8


def probe(xc, zc, elevation, station):
    target = -station * LENGTH / 2
    upper = int(np.searchsorted(xc, target))
    lateral = []
    for i in (upper - 1, upper):
        indices = np.flatnonzero(np.isfinite(elevation[i]))[:2]
        a, b = indices
        waterline = float(half_breadth(xc[i], 0))
        heights = elevation[i, indices]
        lateral.append(float(heights[0] + (waterline - zc[a]) * (heights[1] - heights[0]) / (zc[b] - zc[a])))
    return float(np.interp(target, xc[upper-1:upper+1], lateral))


def forecast(grid, froude, extra=0.0, interior=0.005):
    dx = GRIDS[grid]
    speed = froude * np.sqrt(G * LENGTH)
    x = np.arange(round((-3 * LENGTH - extra) / dx), round((2.5 * LENGTH + extra) / dx) + 1) * dx + 0.25 * dx
    z = np.linspace(0, HALF_TANK_WIDTH, int(np.ceil(HALF_TANK_WIDTH / dx)) + 1)
    y_body = np.linspace(0, DRAFT, (4 if grid == "coarse" else 8) + 1)
    y = np.r_[y_body, DRAFT + np.array([0.045, 0.105, 0.19, 0.32, 0.5, 0.75, 1.05, 1.43, 1.83]), DEPTH]
    graph, eta, checks = solve(x, y, z, speed, True, interior=interior)
    xc, zc = (x[:-1] + x[1:]) / 2, (z[:-1] + z[1:]) / 2
    result = {"module_sha": digest(Path(__file__)), "grid": grid, "froude": froude,
              "geometry_m": {"x": list(x[[0, -1]]), "depth": float(y[-1]), "half_width": float(z[-1]),
                             "dx": dx, "dz": float(z[1] - z[0]), "vertical_faces": list(y)},
              "speed_m_s": float(speed), "extra": extra, "interior": interior,
              "stations": [{"published_x": p, "eta_m": probe(xc, zc, eta, p)} for p in STATIONS],
              **checks}
    output_name = name(grid, froude, extra, interior)
    save(output_name, result)
    print(json.dumps(result))
    assert checks["relative_residual"] < 1e-8
    assert abs(checks["body_flux_m3_s"]["sum"]) < 1e-12
    assert checks["body_flux_m3_s"]["positive"] > 0
    return result


def name(grid, froude, extra=0.0, interior=0.005):
    return f"{grid}-{froude:.3f}-{extra:g}-{interior:g}"


def freeze():
    keys = [name(grid, froude) for grid in GRIDS for froude in FROUDE]
    keys += [name("coarse", .267, extra=1.25), name("coarse", .267, interior=.0025)]
    source_hash = digest(Path(__file__))
    for key in keys:
        run = read(key)
        assert run["module_sha"] == source_hash
        assert run["relative_residual"] < 1e-8
    fixture = Path(__file__).with_name("sea04-stem-observations.json")
    save("freeze", {"source": source_hash, "observations_sha": digest(fixture),
                    "controls": digest(RESULTS / "tow-controls.json"),
                    "packets": {key: digest(RESULTS / f"tow-{key}.json") for key in keys},
                    "comparison": "Nine original UT rows, before predictions from the frozen legacy receipt. No fit, phase shift or gain."})


def score():
    frozen = read("freeze")
    assert frozen["source"] == digest(Path(__file__))
    for key, sha in frozen["packets"].items():
        assert digest(RESULTS / f"tow-{key}.json") == sha
    fixture = Path(__file__).with_name("sea04-stem-observations.json")
    assert digest(fixture) == frozen["observations_sha"]
    legacy = RESULTS / "sea04-stem-score.json"
    assert digest(legacy) == BEFORE
    data = json.loads(fixture.read_text(encoding="utf-8"))
    before = json.loads(legacy.read_text(encoding="utf-8-sig"))
    result = []
    for key in frozen["packets"]:
        run = read(key)
        col = 1 + FROUDE.index(run["froude"])
        rows = data["rows"]
        actual = [row[col] * run["speed_m_s"]**2 / G for row in rows]
        predicted = [row["eta_m"] for row in run["stations"]]
        comparison = {item["variant"]: {"stem_m": item["predictedStem_m"], "rms_m": item["bowProfileRms_m"]}
                      for item in before["scores"] if item["grid"] == "fine" and item["froude"] == run["froude"]}
        result.append({"packet": key, "actual_stem_m": actual[0], "predicted_stem_m": predicted[0],
                       "profile_rms_m": rms(np.array(actual) - predicted), "legacy_fine": comparison,
                       "actual_m": actual, "predicted_m": predicted})
    save("score", {"frozen": frozen, "scores": result})
    for run in result:
        print(run["packet"], "stem predicted/actual (mm)", 1000 * run["predicted_stem_m"], 1000 * run["actual_stem_m"],
              "profile RMS (mm)", 1000 * run["profile_rms_m"], "legacy", run["legacy_fine"])


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("controls", "predict", "freeze", "score"))
    parser.add_argument("--grid", choices=GRIDS, default="coarse")
    parser.add_argument("--froude", type=float, choices=FROUDE, default=FROUDE[0])
    parser.add_argument("--extra", type=float, default=0.0)
    parser.add_argument("--interior", type=float, default=0.005)
    args = parser.parse_args()
    if args.action == "predict":
        forecast(args.grid, args.froude, args.extra, args.interior)
    else:
        {"controls": controls, "freeze": freeze, "score": score}[args.action]()
