"""Independent staggered-symbol check and SEA-04 tow-frame follow-up."""
from argparse import ArgumentParser
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys

import numpy as np
from scipy.optimize import brentq
from scipy.sparse import bmat, coo_matrix, diags
from scipy.sparse.linalg import spsolve

path = Path(__file__).with_name("sea04-stem-tow.py")
spec = spec_from_file_location("stem_tow", path)
tow = module_from_spec(spec)
sys.modules[spec.name] = tow
spec.loader.exec_module(tow)


def wet_x_laplacian(ids, opened, dx):
    """Second derivative along each wet run, with second-order end rows."""
    rows, columns, coefficients = [], [], []
    for j in range(ids.shape[1]):
        x = np.flatnonzero(ids[:, j] >= 0)
        splits = np.flatnonzero((np.diff(x) != 1) | ~opened[x[1:], j]) + 1
        for run in np.split(x, splits):
            cells = ids[run, j]
            for i, row in enumerate(cells):
                if len(cells) < 3:
                    continue
                if len(cells) == 3:
                    indices, weights = cells, [1, -2, 1]
                elif i == 0:
                    indices, weights = cells[:4], [2, -5, 4, -1]
                elif i == len(cells) - 1:
                    indices, weights = cells[-4:], [-1, 4, -5, 2]
                else:
                    indices, weights = cells[i - 1:i + 2], [1, -2, 1]
                rows.extend([row] * len(weights))
                columns.extend(indices)
                coefficients.extend(weights)
    n = int(np.count_nonzero(ids >= 0))
    return coo_matrix((np.asarray(coefficients) / dx**2, (rows, columns)), shape=(n, n)).tocsr()


def vertical_admittance(k, dx, y):
    dy = np.diff(y)
    half = dy[0] / 2
    q2 = (2 * np.sin(k * dx / 2) / dx) ** 2
    effective = dy[-1] * q2
    for layer in range(len(dy) - 2, -1, -1):
        resistance = (dy[layer] + dy[layer + 1]) / 2
        effective = dy[layer] * q2 + effective / (1 + resistance * effective)
    return effective / (1 + half * effective)


def symbols(y, dx, speed):
    exact = tow.stationary_wave(speed, y[-1])
    def roots(square_twice):
        def residual(k):
            laplacian = (np.sin(k * dx) / dx)**2 if square_twice else (2 * np.sin(k * dx / 2) / dx)**2
            return vertical_admittance(k, dx, y) - speed**2 * laplacian / tow.G
        x = np.linspace(exact / 10, np.pi / dx, 513)
        crossing = np.flatnonzero(np.diff(np.signbit([residual(k) for k in x])))
        return [brentq(residual, x[i], x[i + 1]) for i in crossing]
    original, face = roots(True), roots(False)
    assert len(original) == 2
    assert len(face) == 1
    assert abs(face[0] - exact) < abs(original[0] - exact)
    return {"exact_per_m": exact, "original_per_m": original, "face_per_m": face}


def geometry(grid, shift=0.25):
    dx = tow.GRIDS[grid]
    x = np.arange(round(-3 * tow.LENGTH / dx), round(2.5 * tow.LENGTH / dx) + 1) * dx + shift * dx
    z = np.linspace(0, tow.HALF_TANK_WIDTH, int(np.ceil(tow.HALF_TANK_WIDTH / dx)) + 1)
    layers = 4 if grid == "coarse" else 8
    y = np.r_[np.linspace(0, tow.DRAFT, layers + 1), tow.DRAFT + np.array([
        .045, .105, .19, .32, .5, .75, 1.05, 1.43, 1.83]), tow.DEPTH]
    return x, y, z


def solve(x, y, z, speed, body, top_rhs=None):
    graph = tow.geometry(x, y, z, body)
    k = tow.stationary_wave(speed, y[-1])
    xc = (x[:-1] + x[1:]) / 2
    sigma = tow.damping(xc, speed, 2 * np.pi / k)
    sigma = diags(np.broadcast_to(sigma[:, None], graph.exposed.shape)[graph.exposed])
    bound = tow.half_breadth(x[:, None], 0) if body else np.zeros((len(x), 1))
    opened = z[None, 1:] - np.maximum(z[None, :-1], bound) > tow.AREA_EPS
    d_xx = wet_x_laplacian(graph.surface, opened, x[1] - x[0])
    d_x = graph.d_x
    material = sigma - speed * d_x
    material_squared = sigma @ sigma - speed * (sigma @ d_x + d_x @ sigma) + speed**2 * d_xx
    top = diags(graph.top_conductance) + diags(graph.top_area / tow.G) @ material_squared
    operator = bmat([[graph.bulk, -graph.vertical], [-graph.vertical.T, top]], format="csc")
    if top_rhs is None:
        top_rhs = np.zeros(len(graph.top_area))
    rhs = np.concatenate((speed * graph.body_rhs, top_rhs))
    solution = spsolve(operator, rhs)
    relative_residual = np.linalg.norm(operator @ solution - rhs) / np.linalg.norm(rhs)
    elevation = np.full(graph.surface.shape, np.nan)
    elevation[graph.exposed] = -(material @ solution[len(graph.body_rhs):]) / tow.G
    return elevation, {"relative_residual": float(relative_residual), "nnz": int(operator.nnz),
                       "surface_min_m": float(np.nanmin(elevation)), "surface_max_m": float(np.nanmax(elevation))}


def controls():
    result = {}
    for grid in tow.GRIDS:
        _, y, _ = geometry(grid)
        for froude in tow.FROUDE:
            result[f"{grid}-{froude}"] = symbols(y, tow.GRIDS[grid], froude * np.sqrt(tow.G * tow.LENGTH))
    speed, depth = 1.4, 1.3
    k = tow.stationary_wave(speed, depth)
    length = 2 * np.pi / k
    x = np.linspace(-10 * length, 10 * length, 481)
    xc = (x[1:] + x[:-1]) / 2
    y = np.r_[0, np.geomspace(length / 72, depth, 25)]
    z = [0, .1]
    width = .25 * length
    density = 2e-4 / ((x[1] - x[0]) * (z[1] - z[0]))
    slope = np.tanh(k * depth) + k * depth / np.cosh(k * depth)**2 - 2 * speed**2 * k / tow.G
    spectrum = density / length * np.sqrt(2 * np.pi) * width**3 * k * np.exp(-0.5 * (k * width)**2)
    reference = 2 * speed * k / tow.G * abs(spectrum / slope) / np.sqrt(2)
    source = 2e-4 * xc / length * np.exp(-0.5 * (xc / width)**2)
    eta, proof = solve(x, y, np.asarray(z), speed, False, source)
    downstream = tow.rms(eta[(xc < -2 * length) & (xc > -5 * length), 0])
    upstream = tow.rms(eta[(xc > 2 * length) & (xc < 5 * length), 0])
    result["channel"] = {**proof, "residue_rms_m": reference, "downstream_rms_m": downstream, "upstream_rms_m": upstream}
    tow.save("contact-controls", result)
    print(result)
    assert proof["relative_residual"] < 1e-8
    assert abs(downstream / reference - 1) < .1
    assert upstream < downstream / 5


def run(grid, froude, shift):
    x, y, z = geometry(grid, shift)
    speed = froude * np.sqrt(tow.G * tow.LENGTH)
    eta, proof = solve(x, y, z, speed, True)
    xc, zc = (x[:-1] + x[1:]) / 2, (z[:-1] + z[1:]) / 2
    stations = [tow.probe(xc, zc, eta, point) for point in tow.STATIONS]
    result = {**proof, "module_sha": tow.digest(Path(__file__)), "base_sha": tow.digest(path),
              "grid": grid, "froude": froude, "phase_cells": shift, "speed_m_s": speed, "stations_m": stations}
    tow.save(packet_name(grid, froude, shift), result)
    print(result)
    assert proof["relative_residual"] < 1e-8


def packet_name(grid, froude, shift):
    return f"contact-{grid}-{froude:.3f}-{shift:g}"


def seal():
    packets = [packet_name(grid, f, 0.25) for grid in tow.GRIDS for f in tow.FROUDE]
    packets += [packet_name(grid, tow.FROUDE[0], 0) for grid in tow.GRIDS]
    for packet in packets:
        result = tow.read(packet)
        assert result["module_sha"] == tow.digest(Path(__file__))
        assert result["relative_residual"] < 1e-8
    tow.save("contact-seal", {p: tow.digest(tow.RESULTS / f"tow-{p}.json") for p in packets})


def score():
    import json
    fixture = path.with_name("sea04-stem-observations.json")
    assert tow.digest(fixture) == tow.read("freeze")["observations_sha"]
    rows = json.loads(fixture.read_text(encoding="utf-8"))["rows"]
    result = []
    for name, sha in tow.read("contact-seal").items():
        assert tow.digest(tow.RESULTS / f"tow-{name}.json") == sha
        run = tow.read(name)
        col = 1 + tow.FROUDE.index(run["froude"])
        expected = np.array([row[col] for row in rows]) * run["speed_m_s"]**2 / tow.G
        rms = tow.rms(expected - run["stations_m"])
        result.append({**run, "profile_rms_m": rms})
        print(name, "stem mm", 1000 * run["stations_m"][0], "profile RMS mm", 1000 * rms)
    tow.save("contact-score", result)


if __name__ == "__main__":
    cli = ArgumentParser(description=__doc__)
    cli.add_argument("action", choices=("controls", "predict", "seal", "score"))
    cli.add_argument("--grid", choices=tow.GRIDS, default="coarse")
    cli.add_argument("--froude", type=float, choices=tow.FROUDE, default=tow.FROUDE[0])
    cli.add_argument("--shift", type=float, choices=(0., .25), default=.25)
    args = cli.parse_args()
    if args.action == "predict":
        run(args.grid, args.froude, args.shift)
    else:
        {"controls": controls, "seal": seal, "score": score}[args.action]()
