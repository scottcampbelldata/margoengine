"""Qualify a transparent boundary on a finite-ended, partially submerged quay.

Run from the repository root with NumPy and SciPy installed:
    python packages/physics/scripts/measure-finite-quay-outgoing.py

The exterior is an outgoing continuation of the eighth-order discrete
operator. The lateral walls are fixed and the free surface is harmonic.
"""
import json

import numpy as np
from scipy.linalg import eigh
from scipy.sparse import coo_matrix, diags
from scipy.sparse.linalg import spsolve

STENCIL_RADIUS = 4
CORRECTIONS = (1 / 12, 1 / 90, 1 / 560)
DEPTHS = np.array([0, 0.04, 0.09, 0.15, 0.24, 0.38, 0.52, 0.70, 0.93, 1.20])
LATERAL_CELLS = 12
CELL_SIZE = 0.15
WAVELENGTH = 1.2908700371131923


def laplacian(size, left, right, weights):
    count = len(left)
    values = np.tile(weights, 4) * np.repeat([1, 1, -1, -1], count)
    rows = np.concatenate((left, right, left, right))
    cols = np.concatenate((left, right, right, left))
    return coo_matrix((values, (rows, cols)), shape=(size, size)).tocsr()


def corrected(lap):
    power = lap
    result = lap
    for weight in CORRECTIONS:
        power = power @ lap
        result = result + weight * power
    return result


def outgoing_root(graph_symbol):
    # L acting on r^n has graph symbol 2-r-1/r.
    if abs(graph_symbol.imag) < 1e-10 and 0 < graph_symbol.real < 4:
        return np.exp(2j * np.arcsin(np.sqrt(graph_symbol.real) / 2))
    pair_sum = 2 - graph_symbol
    discriminant = np.sqrt(pair_sum * pair_sum - 4 + 0j)
    return min(((pair_sum + discriminant) / 2, (pair_sum - discriminant) / 2), key=abs)


def exterior_modes(thickness, surface_robin):
    interfaces = 2 / (thickness[1:] + thickness[:-1])
    vertical = np.diag(np.r_[0., interfaces] + np.r_[interfaces, 0.])
    vertical += np.diag(-interfaces, 1) + np.diag(-interfaces, -1)
    vertical[0, 0] -= surface_robin
    vertical_eigenvalues, vertical_modes = eigh(vertical, np.diag(thickness))

    orders = np.arange(LATERAL_CELLS) * np.pi / LATERAL_CELLS
    symbol = 4 * np.sin(orders / 2) ** 2
    lateral_eigenvalues = sum(
        weight * symbol ** degree
        for degree, weight in enumerate((1., *CORRECTIONS), start=1)
    ) / CELL_SIZE ** 2
    lateral_modes = np.cos((np.arange(LATERAL_CELLS)[:, None] + 0.5) * orders[None, :])
    lateral_modes *= np.sqrt(2 / LATERAL_CELLS)
    lateral_modes[:, 0] /= np.sqrt(2.)
    basis = np.kron(lateral_modes, vertical_modes)
    weighted = basis * np.tile(thickness, LATERAL_CELLS)[:, None]
    eigenvalues = (lateral_eigenvalues[:, None] + vertical_eigenvalues[None, :]).ravel()

    radius = STENCIL_RADIUS
    roots = np.empty((len(eigenvalues), radius), complex)
    maps = np.empty((len(eigenvalues), radius, radius), complex)
    for mode, eigenvalue in enumerate(eigenvalues):
        symbols = np.roots([*CORRECTIONS[::-1], 1., CELL_SIZE ** 2 * eigenvalue])
        factors = np.array([outgoing_root(value) for value in symbols])
        roots[mode] = factors[np.argsort(-abs(factors))]
        powers = roots[mode, None, :] ** np.arange(2 * radius)[:, None]
        maps[mode] = np.linalg.solve(powers[:radius].T, powers[radius:].T).T

    section = len(eigenvalues)
    ghost = np.empty((radius, section, radius, section), complex)
    for i in range(radius):
        for j in range(radius):
            ghost[i, :, j, :] = (basis * maps[:, i, j]) @ weighted.T
    propagating = np.abs(np.abs(roots[:, 0]) - 1) < 1e-10
    return ghost.reshape(radius * section, radius * section), basis, weighted, roots, propagating


def volume_operator(slots, thickness, closure_depth):
    # The closed faces are removed before raising the graph Laplacian
    # to a power, so even a wide stencil respects the finite wall.
    nx, ny, nz = slots.shape
    normal_faces = np.ones((nx - 1, ny, nz), bool)
    lower_layer = np.searchsorted(DEPTHS, closure_depth)
    normal_faces[nx // 2 - 1, 3:9, :lower_layer] = False
    weights = np.broadcast_to(thickness, normal_faces.shape)[normal_faces]
    normal = laplacian(slots.size, slots[:-1][normal_faces], slots[1:][normal_faces], weights)

    lateral_left = slots[:, :-1, :].ravel()
    lateral_right = slots[:, 1:, :].ravel()
    lateral = laplacian(slots.size, lateral_left, lateral_right, np.tile(thickness, len(lateral_left) // nz))
    mass = np.tile(thickness, nx * ny)
    inverse = diags(1 / mass)
    horizontal = diags(mass) @ (corrected(inverse @ normal) + corrected(inverse @ lateral))

    down = np.tile(2 * CELL_SIZE ** 2 / (thickness[1:] + thickness[:-1]), nx * ny)
    vertical = laplacian(slots.size, slots[:, :, :-1].ravel(), slots[:, :, 1:].ravel(), down)
    return horizontal, vertical


def waveguide(closure_depth, incoming_order, half_length):
    radius = STENCIL_RADIUS
    thickness = np.diff(DEPTHS)
    nz = len(thickness)
    nx = 2 * (half_length + radius)
    slots = np.arange(nx * LATERAL_CELLS * nz).reshape(nx, LATERAL_CELLS, nz)
    horizontal, vertical = volume_operator(slots, thickness, closure_depth)
    k = 2 * np.pi / WAVELENGTH
    surface = k * np.tanh(k * DEPTHS[-1])
    robin = surface / (1 - surface * thickness[0] / 2)
    top_diagonal = np.zeros_like(slots, dtype=float)
    top_diagonal[:, :, 0] = -CELL_SIZE ** 2 * robin
    cells = slots[radius:-radius].ravel()
    matrix = (horizontal + vertical + diags(top_diagonal.ravel()))[cells, :][:, cells].tocoo()
    rows = [matrix.row]
    columns = [matrix.col]
    values = [matrix.data]

    ghost, basis, weighted, roots, prop = exterior_modes(thickness, robin)
    incident = incoming_order * nz
    assert prop[incident]
    beta = np.angle(roots[:, 0]) / CELL_SIZE
    normal = CELL_SIZE * (np.arange(nx) - nx / 2 + 0.5)
    left = np.arange(2 * radius - 1, radius - 1, -1)
    right = np.arange(nx - 2 * radius, nx - radius)
    rhs = np.zeros(len(cells), complex)

    def signal(indices):
        phase = np.exp(1j * beta[incident] * normal[indices, None])
        return (phase * basis[:, incident]).ravel()

    boundaries = (
        (left, np.arange(radius - 1, -1, -1)),
        (right, np.arange(nx - radius, nx)),
    )
    for side, (inside, outside) in enumerate(boundaries):
        local = slots[inside].ravel()
        exchange = horizontal[local, :][:, slots[outside].ravel()]
        selected = local - cells[0]
        rows.append(np.repeat(selected, len(selected)))
        columns.append(np.tile(selected, len(selected)))
        values.append((exchange @ ghost).ravel())
        if side == 0:
            rhs[selected] = -exchange @ (signal(outside) - ghost @ signal(inside))

    shape = (len(cells), len(cells))
    system = coo_matrix((np.concatenate(values), (np.concatenate(rows), np.concatenate(columns))),
                        shape=shape).tocsc()
    solved = spsolve(system, rhs)
    residual = np.linalg.norm(system @ solved - rhs) / np.linalg.norm(rhs)
    solution = solved.reshape(nx - 2 * radius, -1)
    reflected = solution[left - radius] @ weighted
    reflected[:, incident] -= np.exp(1j * beta[incident] * normal[left])
    transmitted = solution[right - radius] @ weighted

    def propagating_coefficients(profile, index, direction):
        coefficients = np.zeros(len(beta), complex)
        for mode in np.flatnonzero(prop):
            powers = roots[mode, None, :] ** np.arange(radius)[:, None]
            value = np.linalg.solve(powers, profile[:, mode])[0]
            coefficients[mode] = value * np.exp(1j * direction * beta[mode] * normal[index])
        return coefficients

    reflection = propagating_coefficients(reflected, left[0], 1)
    transmission = propagating_coefficients(transmitted, right[0], -1)
    # Propagating power is proportional to the derivative of the
    # discrete normal symbol at each outgoing wavenumber.
    angle = beta * CELL_SIZE
    symbol = 4 * np.sin(angle / 2) ** 2
    flux = np.sin(angle) * (1 + symbol / 6 + symbol ** 2 / 30 + symbol ** 3 / 140)
    reflected_power = abs(reflection[prop]) ** 2 * flux[prop] / flux[incident]
    transmitted_power = abs(transmission[prop]) ** 2 * flux[prop] / flux[incident]
    energy_error = abs(sum(reflected_power + transmitted_power) - 1)
    assert energy_error < 2e-8 and residual < 2e-8
    return reflection, transmission, flux, {
        'reflectedPower': float(sum(reflected_power)),
        'diffractedPower': float(sum((reflected_power + transmitted_power)[np.flatnonzero(prop) != incident])),
        'energyError': float(energy_error),
        'residual': float(residual),
    }


def main():
    empty_r, empty_t, _, empty = waveguide(0., 0, 12)
    assert abs(empty_r[0]) < 1e-10 and abs(empty_t[0] - 1) < 1e-10
    r, t, flux, aperture = waveguide(0.52, 0, 12)
    r_far, t_far, _, _ = waveguide(0.52, 0, 18)
    _, _, _, sealed = waveguide(1.20, 0, 12)
    r_side, t_side, _, side = waveguide(0.52, 2, 12)

    boundary_error = max(np.max(abs(r - r_far)), np.max(abs(t - t_far)))
    assert boundary_error < 2e-8
    assert abs(aperture['reflectedPower'] - sealed['reflectedPower']) > 1e-5
    assert aperture['diffractedPower'] > 0.01
    other = 2 * (len(DEPTHS) - 1)
    scale = np.sqrt(flux[other] / flux[0])
    reciprocal_error = max(abs(r[other] * scale - r_side[0] / scale),
                           abs(t[other] * scale - t_side[0] / scale))
    assert reciprocal_error < 1e-9

    print(json.dumps({
        'empty': empty,
        'openAperture': aperture,
        'closedAperture': sealed,
        'alternateIncidentOrder': side,
        'boundaryError': float(boundary_error),
        'reciprocalError': float(reciprocal_error),
    }, indent=2))


if __name__ == '__main__':
    main()
