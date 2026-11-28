"""Cut-surface weak transport and independent conservation checks for SEA-04."""
from argparse import ArgumentParser
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix, diags

path = Path(__file__).with_name("sea04-stem-tow-radiation.py")
spec = spec_from_file_location("stem_radiation", path)
radiating = module_from_spec(spec)
spec.loader.exec_module(radiating)
t = radiating.t


def weak_faces(graph, x, z, body):
    dx = x[1] - x[0]
    cut = t.half_breadth(x[1:-1, None], 0) if body else 0
    open_width = np.maximum(0, z[None,1:] - np.maximum(z[None,:-1], cut))
    left, right, open_width = np.broadcast_arrays(graph.surface[:-1], graph.surface[1:], open_width)
    paired = (left >= 0) & (right >= 0) & (open_width > t.AREA_EPS)
    west, east, width = left[paired], right[paired], open_width[paired]
    count = len(west)
    n = len(graph.top_area)
    row = np.repeat(np.arange(count), 2)
    columns = np.column_stack((west, east)).ravel()
    gradient = coo_matrix((np.tile([-1/dx,1/dx],count), (row,columns)), shape=(count,n)).tocsr()
    average = coo_matrix((np.full(2 * count,.5), (row,columns)), shape=(count,n)).tocsr()
    edge_mass = dx * width
    mass = diags(edge_mass)
    return gradient, average, mass


def contact_equation(graph, x, z, body, speed, sigma, centered):
    gradient, average, mass = weak_faces(graph,x,z,body)
    integrated_gradient = average.T @ mass @ gradient
    second_moment = gradient.T @ mass @ gradient
    dx = x[1]-x[0]
    exterior = np.zeros(len(graph.top_area))
    ends = np.r_[graph.surface[0], graph.surface[-1]]
    exterior[ends] = graph.top_area[ends] / dx**2
    convective = (diags(sigma**2 * graph.top_area)
                  + sigma * speed * (integrated_gradient.T - integrated_gradient)
                  - speed**2 * (second_moment + diags(exterior)))
    # Elevation is inferred from available face gradients along the wet x run.
    # No sliver-height division enters pressure or the local gradient estimate.
    lengths = average.T @ mass.diagonal()
    reciprocal = np.divide(1,lengths,out=np.zeros_like(lengths),where=lengths>0)
    sample = (diags(reciprocal) @ integrated_gradient).tolil()
    end_rows = centered.tolil()
    for row in ends:
        sample.rows[row] = end_rows.rows[row]
        sample.data[row] = end_rows.data[row]
    return convective, sample.tocsr()


def controls():
    x,y,z=radiating.c.geometry("coarse")
    dx=x[1]-x[0]
    speed=.267*np.sqrt(t.G*t.LENGTH)
    sigma=.005*speed/(2*np.pi/t.stationary_wave(speed,y[-1]))
    cut_graph=t.geometry(x,y,z,True)
    gradient,average,mass=weak_faces(cut_graph,x,z,True)
    c=average.T@mass@gradient
    k=gradient.T@mass@gradient
    ends=np.r_[cut_graph.surface[0],cut_graph.surface[-1]]
    relevant=np.ones(len(cut_graph.top_area),dtype=bool)
    relevant[ends]=False
    flux=c.T-c
    xc=(x[:-1]+x[1:])/2
    trace=np.broadcast_to(xc[:,None],cut_graph.exposed.shape)[cut_graph.exposed]
    constant=np.ones_like(trace)
    field=np.sin(3.2*trace)+.4*np.cos(6.1*trace)
    current,sampler=contact_equation(cut_graph,x,z,True,speed,sigma,cut_graph.d_x)
    active=(average.T@mass.diagonal()>0)&relevant
    linear_error=np.max(abs((sampler@trace)[active]-1))
    cut_const=max(np.max(abs(c@constant)),np.max(abs(k@constant)))
    skew_work=float(field@(flux@field))
    face_energy=(gradient@field)@mass@(gradient@field)
    work_error=abs(float(field@k@field)-face_energy)
    outer=np.zeros_like(trace)
    outer[ends]=cut_graph.top_area[ends]/dx**2
    weak_energy=(sigma**2 * (field**2)@cut_graph.top_area
                 - speed**2 * (face_energy+outer@(field**2)))
    energy_error=abs(float(field@current@field)-weak_energy)
    control={"wet_linear_gradient_error":float(linear_error),"constant_error":float(cut_const),
             "skew_absorption_work":skew_work,"face_energy_error":float(work_error),
             "weak_energy_error":float(energy_error),"surface_fields":len(trace),
             "no_axial_face_cells":int(np.count_nonzero(~active & relevant)),
             "positive_face_energy":float(face_energy)}
    print(control)
    t.save("weak-energy-controls",control)
    assert linear_error < 1e-12
    assert cut_const < 1e-12
    assert abs(skew_work) < 1e-12
    assert work_error < 1e-11
    assert energy_error < 1e-11
    assert face_energy > 1



def projected_trace(graph, x, z):
    """Remove traces nominally inside the solid by reproducing affine water values."""
    xc, zc = (x[:-1]+x[1:])/2, (z[:-1]+z[1:])/2
    inside=zc[None,:] < t.half_breadth(xc[:,None],0)
    cut_cells=np.argwhere(graph.exposed & inside)
    targets=[]
    nodes,weights=np.polynomial.legendre.leggauss(12)
    for i,j in cut_cells:
        valid=np.flatnonzero(graph.exposed[i] & ~inside[i] & (np.arange(len(zc)) > j))[:2]
        if len(valid) < 2:
            raise ValueError("Expose two wet centres beside each reconstructed hull trace.")
        left,right=x[i:i+2]
        breaks=[left,right]
        for bound in z[j:j+2]:
            root=(t.LENGTH/2)*np.sqrt(max(0,1-2*bound/t.BEAM))
            breaks.extend(np.clip([-root,root],left,right))
        ends=np.sort(breaks)
        half=.5*np.diff(ends)
        xi=(.5*(ends[1:]+ends[:-1]))[:,None]+half[:,None]*nodes
        lower=np.maximum(z[j],t.half_breadth(xi,0))
        width=np.maximum(0,z[j+1]-lower)
        centroid=(half @ ((width*.5*(lower + z[j+1])) @ weights)) / (half @ (width @ weights))
        alpha=(centroid-zc[valid[0]])/(zc[valid[1]]-zc[valid[0]])
        assert -.99 < alpha <= 0
        targets.append((int(graph.surface[i,j]), graph.surface[i,valid], np.array([1-alpha,alpha]), centroid))
    return targets


def tie_trace(graph, x, z, body, size):
    if not body:
        return None, {"removed_traces":0}
    links=projected_trace(graph,x,z)
    top=len(graph.body_rhs)
    excluded=np.array([top+row for row,_,_,_ in links],dtype=np.int32)
    retained=np.ones(size,dtype=bool)
    retained[excluded]=False
    ids=np.full(size,-1,dtype=np.int32)
    ids[retained]=np.arange(retained.sum())
    row=[np.flatnonzero(retained)]
    column=[ids[retained]]
    effect=[np.ones_like(row[0],dtype=float)]
    for cut,support,weights,_ in links:
        row.append(np.full(len(support),top+cut))
        column.append(ids[top+support])
        effect.append(weights)
    mapped=coo_matrix((np.concatenate(effect),(np.concatenate(row),np.concatenate(column))),
                      shape=(size,int(retained.sum()))).tocsr()
    count=len(links)
    return mapped,{"removed_traces":count,"max_affine_coefficient":max(abs(weights).max() for _,_,weights,_ in links) if count else 1.0}


def trace_controls():
    x,y,z=radiating.c.geometry("coarse")
    graph=t.geometry(x,y,z,True)
    size=len(graph.body_rhs)+len(graph.top_area)
    trace,proof=tie_trace(graph,x,z,True,size)
    cells=projected_trace(graph,x,z)
    zc=(z[:-1]+z[1:])/2
    zfield=np.broadcast_to(zc[None,:],graph.exposed.shape)[graph.exposed].copy()
    excluded=[cut for cut,_,_,_ in cells]
    keep=np.ones(size,dtype=bool)
    keep[len(graph.body_rhs)+np.asarray(excluded)]=False
    expected=np.r_[np.ones(len(graph.body_rhs)),zfield]
    for at,_,_,centroid in cells:
        expected[len(graph.body_rhs)+at]=centroid
    affine_error=float(np.max(abs(trace@expected[keep]-expected)))
    constant_error=float(np.max(abs(trace@np.ones(trace.shape[1])-1)))
    result={**proof,"affine_transverse_error_m":affine_error,"constant_error":constant_error}
    t.save("weak-tied-trace-controls",result)
    print(result)
    assert affine_error < 1e-13 and constant_error < 1e-13 and proof["removed_traces"] > 0

def source_control():
    x,y,z = radiating.c.geometry("coarse")
    actual_body = t.geometry(x,y,z,True)
    result = {}
    for froude in t.FROUDE:
        speed = froude * np.sqrt(t.G*t.LENGTH)
        physical = speed * actual_body.body_rhs
        dense = np.zeros(actual_body.cells.shape)
        dense[actual_body.wet] = physical
        _, solved = radiating.full_response(x,y,z,speed,False,
                                          contact_operator=contact_equation,
                                          bulk_force=dense.ravel())
        result[str(froude)] = {**solved, "source_sum":float(physical.sum()),
                              "source_absolute_m3_s":float(abs(physical).sum())}
        assert solved["linear_gate_passed"]
    t.save("weak-uncut-identical-source",result)
    print(result)

def simulate(grid, froude, tied):
    x, y, z = radiating.c.geometry(grid)
    speed = froude * np.sqrt(t.G * t.LENGTH)
    elevation, proof = radiating.full_response(x, y, z, speed, True, contact_operator=contact_equation, trace_projection=tie_trace if tied else None)
    xc, zc = (x[:-1] + x[1:]) / 2, (z[:-1] + z[1:]) / 2
    result = {**proof, "grid": grid, "froude": froude, "weak_source": t.digest(Path(__file__)),
              "radiation_source": t.digest(path),
              "station_geometry": [t.probe(xc, zc, elevation, p) for p in t.STATIONS]}
    tag = 'weak-tied' if tied else 'weak'
    t.save(f"{tag}-{grid}-{froude:.3f}", result)
    print(result)
    assert proof["linear_gate_passed"]


if __name__ == "__main__":
    cli = ArgumentParser(description=__doc__)
    cli.add_argument("action", choices=("controls", "predict", "source-control"))
    cli.add_argument("--grid", choices=t.GRIDS, default="coarse")
    cli.add_argument("--froude", type=float, choices=t.FROUDE, default=t.FROUDE[0])
    cli.add_argument('--tied', action='store_true')
    args = cli.parse_args()
    if args.action == "controls":
        controls()
        trace_controls()
        radiating.mapped_control(contact_equation, "weak-mapped-control")
    elif args.action == "source-control":
        source_control()
    else:
        simulate(args.grid, args.froude, args.tied)
