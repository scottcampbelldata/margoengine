"""Scratch exact uniform-column radiation proof for the SEA-04 steady tow."""
import importlib.util
from pathlib import Path
import numpy as np
from scipy.linalg import eig
from scipy.sparse import bmat, coo_matrix, csr_matrix, diags, eye, kron
from scipy.sparse.linalg import spsolve

p = importlib.util.spec_from_file_location("contact", "packages/physics/scripts/sea04-stem-tow-contact.py")
c = importlib.util.module_from_spec(p)
p.loader.exec_module(c)
t = c.tow


def columns(dx, y, dz, qz, speed, sigma):
    dy = np.diff(y)
    top_area = dx * dz
    m = len(y)
    left, middle, right = (np.zeros((m, m)) for _ in range(3))
    bulk_face = dy * dz / dx
    left[np.arange(m-1), np.arange(m-1)] = -bulk_face
    right[np.arange(m-1), np.arange(m-1)] = -bulk_face
    middle[np.arange(m-1), np.arange(m-1)] = 2 * bulk_face + top_area * dy * qz**2
    for at, distance in enumerate((dy[:-1] + dy[1:]) / 2):
        i = at + np.arange(2)
        middle[np.ix_(i, i)] += top_area / distance * np.array([[1, -1], [-1, 1]])
    middle[np.ix_([0,m-1],[0,m-1])] += 2*top_area/dy[0]*np.array([[1, -1], [-1, 1]])
    left[-1,-1] = top_area/t.G * (speed**2/dx**2 + sigma*speed/dx)
    right[-1,-1] = top_area/t.G * (speed**2/dx**2 - sigma*speed/dx)
    middle[-1,-1] += top_area/t.G * (sigma**2 - 2*speed**2/dx**2)
    return left,middle,right


def radiation(left, middle, right):
    n=len(middle)
    zero, identity=np.zeros_like(middle),np.eye(n)
    companion=np.block([[-middle,-left],[identity,zero]])
    weight=np.block([[right,zero],[zero,identity]])
    z, v=eig(companion,weight)
    interior=v[n:,:]
    assert np.all(np.isfinite(z))
    passive=abs(z)<1
    assert np.any(passive) and np.any(~passive) and np.all(abs(abs(z)-1)>5e-12)
    denominator=np.linalg.norm(left)+np.linalg.norm(middle)+np.linalg.norm(right)
    residuals=[]
    for i,value in enumerate(z):
        scaled=left/value + middle + right*value
        residuals.append(np.linalg.norm(scaled@interior[:,i])/(denominator*np.linalg.norm(interior[:,i])*(1+abs(value)+1/abs(value))))
    assert max(residuals)<1e-11
    def ghost(mode, multiplier):
        base=interior[:,mode]
        phase=z[mode]
        # A complex-conjugate pair is two real modal amplitudes.
        states, ghosts = [], []
        for i,value in enumerate(phase):
            if value.imag < -1e-10:
                continue
            state=base[:,i]
            factor=multiplier[i]
            states.append(state.real)
            ghosts.append((state*factor).real)
            if value.imag > 1e-10:
                states.append(state.imag)
                ghosts.append((state*factor).imag)
        return np.column_stack(states),np.column_stack(ghosts)
    before,before_ghost=ghost(~passive,1/z[~passive])
    after,after_ghost=ghost(passive,z[passive])
    return (before,before_ghost),(after,after_ghost),{
        "stable_left_count": int((~passive).sum()),
        "stable_right_count": int(passive.sum()),
        "left_outgoing_root_magnitudes": sorted(abs(1/z[~passive]).tolist(),reverse=True)[:4],
        "right_outgoing_root_magnitudes": sorted(abs(z[passive]).tolist(),reverse=True)[:4],
        "pencil_residual": float(max(residuals)),
        "modal_basis_condition": float(max(np.linalg.cond(before),np.linalg.cond(after))),
    }


def response(x,y,z,mode,speed,sigma,forcing):
    n,m=len(x),len(y)
    dx,dz=x[1]-x[0],z[1]-z[0]
    dqn=2*np.sin(mode*np.pi*dz/(2*z[-1]))/dz
    left,middle,right=columns(dx,y,dz,dqn,speed,sigma)
    (before,left_ghost),(after,right_ghost),checks=radiation(left,middle,right)
    matrix=kron(eye(n), middle)+kron(diags(np.ones(n-1),-1),left)+kron(diags(np.ones(n-1),1),right)
    enter_left=coo_matrix((np.ones(m),(np.arange(m),np.arange(m))),shape=(n*m,m)).tocsr()
    enter_right=coo_matrix((np.ones(m),((n-1)*m+np.arange(m),np.arange(m))),shape=(n*m,m)).tocsr()
    exact=bmat([
        [matrix, enter_left @ csr_matrix(left @ left_ghost), enter_right @ csr_matrix(right @ right_ghost)],
        [enter_left.T, -csr_matrix(before), None],
        [enter_right.T, None, -csr_matrix(after)],
    ],format='csc')
    rhs=np.zeros((n,m))
    rhs[:,-1]=forcing
    result=spsolve(exact,np.r_[rhs.ravel(),np.zeros(2*m)])
    field=result[:n*m].reshape(n,m)
    split=n*m+before.shape[1]
    closure=np.r_[(left_ghost@result[n*m:split])[-1],field[:,-1],(right_ghost@result[split:])[-1]]
    eta=(-sigma*closure[1:-1]+speed*(closure[2:]-closure[:-2])/(2*dx))/t.G
    return field[:,-1],eta,checks


def run():
    x,y,z=c.geometry('coarse')
    x=(x-x.mean())*.73
    z=z[::2]
    speed=.267*np.sqrt(t.G*t.LENGTH)
    wavelength=2*np.pi/t.stationary_wave(speed,y[-1])
    sigma=.005*speed/wavelength
    xc=(x[:-1]+x[1:])/2
    dx=xc[1]-xc[0]
    forcing=2e-4*xc/wavelength*np.exp(-.5*(xc/(.25*wavelength))**2)
    probe=1e-4*np.exp(-.5*((xc-1.2*wavelength)/(.25*wavelength))**2)
    zc = (z[:-1] + z[1:]) / 2
    rows=[]
    for mode in (0,4,6,8):
        modal_source = forcing[:, None] * np.cos(mode * np.pi * zc[None, :] / z[-1])
        old, _ = c.solve(x, y, z, speed, False, modal_source.ravel())
        original_upstream = float(np.max(abs(old[xc > xc[-1] - 1.25 * wavelength])))
        phi,eta,check=response(xc,y,z,mode,speed,sigma,forcing)
        field,_,_=response(xc,y,z,mode,-speed,sigma,probe)
        extend=32
        more=(np.arange(-extend,len(xc)+extend))*dx+xc[0]
        _,expanded,_=response(more,y,z,mode,speed,sigma,np.pad(forcing,extend))
        residual=np.max(abs(expanded[extend:-extend]-eta))/np.max(abs(eta))
        outer=np.max(abs(eta[xc>xc[-1]-1.25*wavelength]))
        near=np.max(abs(eta[abs(xc)<2*wavelength]))
        a,b=phi@probe,field@forcing
        reciprocity=abs(a-b)/max(abs(a),abs(b))
        row={"mode":mode,**check,"extension_relative_error":float(residual),"modified_tow_reversal_relative_error":float(reciprocity),
             "near_peak_m":float(near),"upstream_outer_peak_m":float(outer),
             "old_upstream_outer_peak_m":original_upstream}
        rows.append(row)
        print(row)
    t.save("end-closure-transparent",rows)
    for row in rows:
        assert row["extension_relative_error"] < 1e-8
        assert row["modified_tow_reversal_relative_error"] < 1e-8
        assert row["upstream_outer_peak_m"] < row["near_peak_m"] / 10






def coupled_end(end_ids, modes, size, modal_blocks, side):
    """Match outgoing mode amplitudes to the grid-end potential trace."""
    m, nz = end_ids.shape
    transform = np.broadcast_to(modes.T[:, None, :], (nz, m, nz))
    physical = np.broadcast_to(end_ids, transform.shape)
    mode_depth = np.broadcast_to(np.arange(nz * m).reshape(nz, m, 1), transform.shape)
    match = coo_matrix((transform.ravel(), (mode_depth.ravel(), physical.ravel())),
                       shape=(m * nz, size)).tocsr()
    columns, ghost_rows, ghost_values, basis_rows, basis_columns, basis_values = [], [], [], [], [], []
    ghost_surface = []
    offset = 0
    for k, (left, right, left_basis, right_basis) in enumerate(modal_blocks):
        basis, ghost, axial = (*left_basis, left) if side == "left" else (*right_basis, right)
        count = basis.shape[1]
        indices = np.arange(offset, offset + count)
        modal_surface = modes[:, k, None] * ghost[-1]
        ghost_surface.append(modal_surface)
        weighted = (axial @ ghost)[:, None, :] * modes[None, :, k, None]
        columns.append(np.broadcast_to(indices, weighted.shape).ravel())
        ghost_rows.append(np.broadcast_to(end_ids[..., None], weighted.shape).ravel())
        ghost_values.append(weighted.ravel())
        basis_rows.append(np.broadcast_to((k * m + np.arange(m))[:, None], basis.shape).ravel())
        basis_columns.append(np.broadcast_to(indices, basis.shape).ravel())
        basis_values.append(-basis.ravel())
        offset += count
    couple = coo_matrix((np.concatenate(ghost_values), (np.concatenate(ghost_rows), np.concatenate(columns))),
                        shape=(size, offset)).tocsr()
    close = coo_matrix((np.concatenate(basis_values), (np.concatenate(basis_rows), np.concatenate(basis_columns))),
                       shape=(m * nz, offset)).tocsr()
    return couple, match, close, np.concatenate(ghost_surface, axis=1)


def full_response(x, y, z, speed, body, force=None, contact_operator=None, trace_projection=None, bulk_force=None):
    graph = t.geometry(x, y, z, body)
    dx, dz = x[1] - x[0], z[1] - z[0]
    xc = (x[:-1] + x[1:]) / 2
    m, nz = len(y), len(z) - 1
    n_bulk, n_top = len(graph.body_rhs), len(graph.top_area)
    n = n_bulk + n_top
    wavelength = 2 * np.pi / t.stationary_wave(speed, y[-1])
    sigma = .005 * speed / wavelength
    b = t.half_breadth(x[:, None], 0) if body else np.zeros((len(x), 1))
    opened = z[None, 1:] - np.maximum(z[None, :-1], b) > t.AREA_EPS
    d1, d2 = graph.d_x.tolil(), c.wet_x_laplacian(graph.surface, opened, dx).tolil()
    exterior_bulk = np.zeros(n_bulk)
    end_ids = []
    for at, neighbor, sign in ((0,1,1),(-1,-2,-1)):
        surface = graph.surface[at]
        end_ids.append(np.vstack((graph.cells[:, at], n_bulk + surface)))
        assert np.all(graph.cells[:, at] >= 0) and np.all(surface >= 0)
        exterior_bulk[graph.cells[:, at]] = np.broadcast_to(np.diff(y)[:, None] * dz / dx, (m - 1, nz))
        for own, adjacent in zip(surface, graph.surface[neighbor]):
            d1.rows[own] = [adjacent]
            d1.data[own] = [sign / (2 * dx)]
            d2.rows[own] = [own, adjacent]
            d2.data[own] = [-2 / dx**2, 1 / dx**2]
    d1, d2 = d1.tocsr(), d2.tocsr()
    surface_main = sigma**2 * eye(n_top) - 2 * sigma * speed * d1 + speed**2 * d2
    if contact_operator is None:
        transport = diags(graph.top_area / t.G) @ surface_main
    else:
        transport, d1 = contact_operator(graph, x, z, body, speed, sigma, d1)
        transport = transport / t.G
    top = diags(graph.top_conductance) + transport
    interior = bmat([[graph.bulk + diags(exterior_bulk), -graph.vertical], [-graph.vertical.T, top]]).tocsr()
    mode = np.arange(nz)
    modes = np.cos(np.pi * (np.arange(nz)[:, None] + .5) * mode[None, :] / nz) * np.sqrt(2 / nz)
    modes[:, 0] /= np.sqrt(2)
    modal_blocks, proofs = [], []
    for number in mode:
        qz = 2 * np.sin(number * np.pi / (2 * nz)) / dz
        left, middle, right = columns(dx,y,dz,qz,speed,sigma)
        before, after, proof = radiation(left,middle,right)
        modal_blocks.append((left, right, before, after))
        proofs.append(proof)
    outer_left = coupled_end(end_ids[0], modes, n, modal_blocks, "left")
    outer_right = coupled_end(end_ids[1], modes, n, modal_blocks, "right")
    operator = bmat([
        [interior, outer_left[0], outer_right[0]],
        [outer_left[1], outer_left[2], None],
        [outer_right[1], None, outer_right[2]],
    ],format="csc")
    forcing = speed * graph.body_rhs if bulk_force is None else np.asarray(bulk_force)
    rhs = np.r_[forcing, np.zeros(n_top) if force is None else force, np.zeros(2*m*nz)]
    projection, projection_receipt = (None, {}) if trace_projection is None else trace_projection(graph, x, z, body, operator.shape[0])
    if projection is None:
        solution = spsolve(operator,rhs)
        balance = operator @ solution - rhs
        rhs_residual = rhs
    else:
        reduced = (projection.T @ operator @ projection).tocsc()
        rhs_residual = projection.T @ rhs
        reduced_solution = spsolve(reduced, rhs_residual)
        solution = projection @ reduced_solution
        balance = reduced @ reduced_solution - rhs_residual
    residual = np.linalg.norm(balance) / np.linalg.norm(rhs_residual)
    surface_phi = solution[n_bulk:n]
    elevation = np.full(graph.surface.shape,np.nan)
    elevation[graph.exposed] = (speed * (d1 @ surface_phi) - sigma * surface_phi) / t.G
    split = n + outer_left[2].shape[1]
    elevation[0] -= speed * (outer_left[3] @ solution[n:split]) / (2 * dx * t.G)
    elevation[-1] += speed * (outer_right[3] @ solution[split:]) / (2 * dx * t.G)
    peak_x, peak_z = np.unravel_index(np.nanargmax(abs(elevation)), elevation.shape)
    peak_id = graph.surface[peak_x, peak_z]
    streamwise_cell = float(xc[peak_x])
    transverse_cell = float((z[peak_z] + z[peak_z + 1]) / 2)
    aperture_fraction = float(graph.top_area[peak_id] / (dx * dz))
    return elevation, {**projection_receipt, "linear_residual": float(residual), "sigma_s_inv": float(sigma),
                       "bulk_cells": n_bulk, "surface_cells": n_top, "nnz": int(operator.nnz),
                       "active_modes": nz, "pencil_max_residual": max(row["pencil_residual"] for row in proofs),
                       "max_basis_condition": max(row["modal_basis_condition"] for row in proofs),
                       "far_upstream_peak_m": float(np.max(abs(elevation[xc>xc[-1]-wavelength]))),
                       "surface_peak_m": float(np.nanmax(abs(elevation))),
                       "peak_cell": {"x_m": streamwise_cell, "z_m": transverse_cell,
                                     "aperture_fraction": aperture_fraction},
                       "linear_gate_passed": bool(residual < 1e-8),
                       "end_mode_counts": [outer_left[2].shape[1], outer_right[2].shape[1]]}


def mapped_control(contact_operator=None, receipt_name="radiation-mapped-control"):
    x,y,z=c.geometry("coarse")
    x=(x-x.mean())*.73
    z=z[::2]
    speed=.267*np.sqrt(t.G*t.LENGTH)
    wavelength=2*np.pi/t.stationary_wave(speed,y[-1])
    sigma=.005*speed/wavelength
    xc,zc=(x[:-1]+x[1:])/2,(z[:-1]+z[1:])/2
    forcing=2e-4*xc/wavelength*np.exp(-.5*(xc/(.25*wavelength))**2)
    shape=np.cos(4*np.pi*zc/z[-1])
    _,modal,_=response(xc,y,z,4,speed,sigma,forcing)
    mapped,receipt=full_response(x,y,z,speed,False,(forcing[:,None]*shape[None,:]).ravel(), contact_operator)
    exact=modal[:,None]*shape[None,:]
    error=np.max(abs(mapped-exact))/np.max(abs(exact))
    receipt["modal_mapping_relative_error"]=float(error)
    print(receipt)
    t.save(receipt_name,receipt)
    assert error<1e-8 and receipt["linear_gate_passed"]


def predict(grid,froude):
    x,y,z=c.geometry(grid)
    speed=froude*np.sqrt(t.G*t.LENGTH)
    eta,proof=full_response(x,y,z,speed,True)
    xc,zc=(x[:-1]+x[1:])/2,(z[:-1]+z[1:])/2
    result={**proof,"grid":grid,"froude":froude,"speed_m_s":float(speed),"module_sha":t.digest(Path(__file__)),
            "stations_m":[t.probe(xc,zc,eta,station) for station in t.STATIONS]}
    key=f"radiation-{grid}-{froude:.3f}"
    print(result)
    t.save(key,result)
    assert proof['linear_gate_passed']


def seal_and_score():
    import json
    fixture=Path(__file__).with_name("sea04-stem-observations.json")
    assert t.digest(fixture) == t.read("freeze")["observations_sha"]
    names=[f"radiation-{grid}-{froude:.3f}" for grid in t.GRIDS for froude in t.FROUDE]
    for name in names:
        assert t.read(name)["module_sha"] == t.digest(Path(__file__))
    seal={name:t.digest(t.RESULTS/f"tow-{name}.json") for name in names}
    t.save("radiation-seal",{"predictions":seal,"observations":t.digest(fixture),
                              "mapping_control":t.digest(t.RESULTS/"tow-radiation-mapped-control.json")})
    actual=json.loads(fixture.read_text(encoding="utf-8"))["rows"]
    scores={}
    for name in names:
        run=t.read(name)
        col=1+t.FROUDE.index(run["froude"])
        measured=np.array([row[col] for row in actual])*run["speed_m_s"]**2/t.G
        scores[name]={"predicted_stem_m":run["stations_m"][0],"observed_stem_m":float(measured[0]),
                      "profile_rms_m":t.rms(np.array(run["stations_m"])-measured),
                      "upstream_peak_m":run["far_upstream_peak_m"],
                      "linear_residual":run["linear_residual"],
                      "linear_gate_passed":run["linear_gate_passed"],
                      "global_surface_amplitude_over_draft":run["surface_peak_m"]/t.DRAFT,
                      "peak_cell":run["peak_cell"]}
    t.save("radiation-score",scores)
    print(scores)


if __name__ == "__main__":
    from argparse import ArgumentParser
    parser=ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=("modal","mapping","predict","score"))
    parser.add_argument("--grid",choices=t.GRIDS,default="coarse")
    parser.add_argument("--froude",choices=t.FROUDE,type=float,default=t.FROUDE[0])
    args=parser.parse_args()
    if args.action=="predict":
        predict(args.grid,args.froude)
    else:
        {"modal":run,"mapping":mapped_control,"score":seal_and_score}[args.action]()
