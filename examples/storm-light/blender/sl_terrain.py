# Headland, seabed, far land, sea stacks and the shallow-water heightmap.
# The land is a heightfield (engine x, z -> y) built from a coastline
# polygon, remeshed into even voxels near the camera, then displaced in 3D
# so cliffs get strata, joints and overhang-like bulges, then decimated.

import math
import struct

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from sl_common import (E, apply_modifiers, decimate, fbm2, fbm3, log, mesh_from_numpy, mesh_verts, new_object,
                       ridged3, select_only, set_mesh_verts, set_point_attr, smooth_by_angle, smoothstep,
                       vert_normals, voronoi3)

# ---------------------------------------------------------------- layout (engine x, z)

SOUTH = [(-700, 230), (-450, 170), (-300, 112), (-200, 74), (-160, 58), (-120, 44), (-90, 35), (-60, 27),
         (-45, 22.5), (-30, 19.4), (-22, 18.4), (-12, 15.6), (0, 13.0)]
TIP = [(6.0, 11.8), (10.5, 8.6), (13.4, 3.8), (14.2, -1.5), (13.2, -7.0), (10.5, -12.5), (6.5, -18.0), (2.0, -23.0),
       (-4.0, -27.5)]
NORTH = [(-12, -30.5), (-20, -33), (-40, -38), (-60, -42), (-90, -48), (-120, -55), (-160, -64), (-200, -74),
         (-300, -100), (-450, -145), (-700, -210)]

LIGHTHOUSE = (0.0, 16.0, 0.0)
COTTAGE = (-17.0, 15.5, 5.5)
COTTAGE_HALF = (4.5, 2.75)
JETTY_X = -22.0
JETTY_Z0 = 16.0
JETTY_Z1 = 40.0
DECK_Y = 1.6
LANDING_Y = 1.45
RAMP_X0, RAMP_X1 = -23.0, -50.0

NEAR_X = (-112.0, 46.0)
WEST_SPLIT = -76.0  # near mesh faces west of this use the low-res land texture
NEAR_Z = (-62.0, 52.0)

# paths: (points, half width)
PATHS = [
    ([(-17, 9.0), (-14, 9.6), (-10.5, 7.2), (-7.2, 3.5), (-3.4, 1.65)], 0.75),
    ([(-17, 9.0), (-26, 12.0), (-38, 15.6), (-46.5, 18.3), (-50.5, 19.2)], 0.65),
    ([(-21.5, 4.0), (-35, 2.0), (-60, 0.0), (-90, -3.0), (-130, -8.0), (-180, -12.0), (-300, -20.0)], 1.1),
]


def _interp_coast(pts, x):
    xs = np.array([p[0] for p in pts], np.float64)
    zs = np.array([p[1] for p in pts], np.float64)
    order = np.argsort(xs)
    return np.interp(x, xs[order], zs[order])


def zs_at(x):
    return _interp_coast(SOUTH, np.minimum(x, 0.0))


def zn_at(x):
    pts = [(0, -27.0)] + NORTH
    return _interp_coast(pts, np.minimum(x, 0.0))


def _resample(pts, step):
    out = []
    for i in range(len(pts) - 1):
        a = np.array(pts[i], np.float64)
        b = np.array(pts[i + 1], np.float64)
        n = max(1, int(np.linalg.norm(b - a) / step))
        for k in range(n):
            out.append(a + (b - a) * k / n)
    out.append(np.array(pts[-1], np.float64))
    return np.array(out)


def coastline():
    """Closed coast polygon with natural wiggles (engine x, z)."""
    # south coast west to east, round the tip, north coast east to west
    pts = SOUTH + TIP + NORTH
    near = [p for p in pts]
    poly = []
    for i in range(len(near) - 1):
        a, b = near[i], near[i + 1]
        step = 1.0 if (a[0] > -220 and b[0] > -220) else 6.0
        seg = _resample([a, b], step)
        poly.extend(seg[:-1])
    poly.append(np.array(near[-1], np.float64))
    poly = np.array(poly)
    # closing loop far west
    poly = np.vstack([poly, [[-900.0, -210.0], [-900.0, 230.0]]])
    # wiggle along normals
    nxt = np.roll(poly, -1, 0)
    prv = np.roll(poly, 1, 0)
    t = nxt - prv
    nrm = np.stack([t[:, 1], -t[:, 0]], 1)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
    seg = np.linalg.norm(np.diff(poly, axis=0, prepend=poly[:1]), axis=1)
    s = np.cumsum(seg)
    amp = np.ones(len(poly)) * 2.2
    x = poly[:, 0]
    z = poly[:, 1]
    amp *= 1.0 - 0.75 * smoothstep(-6.0, 4.0, x)  # tip keeps its shape for the compound
    jetty = smoothstep(9.0, 3.0, np.abs(x - JETTY_X)) * (z > 0)
    ramp = ((x < RAMP_X0 + 4) & (x > RAMP_X1 - 6) & (z > 0)).astype(np.float64)
    amp *= 1.0 - np.maximum(jetty, ramp * 0.8)
    wig = amp * fbm2(s * 0.035, s * 0.0 + 3.0, 3) * 1.6 + 0.6 * amp * fbm2(s * 0.16, s * 0.0 + 9.0, 2)
    # broad bays and points away from the tip, the jetty and the ramp
    big = 1.0 - smoothstep(-45.0, -25.0, x)
    big *= 1.0 - np.maximum(jetty, ramp)
    wig += big * 24.0 * fbm2(s * 0.009, s * 0.0 + 21.0, 2)
    far = poly[:, 0] < -800
    wig[far] = 0
    poly = poly + nrm * wig[:, None]
    return poly


def poly_sdf(px, pz, poly):
    """Signed distance to the closed polygon, positive inside (on land)."""
    A = poly
    B = np.roll(poly, -1, axis=0)
    ax, az = A[:, 0][None], A[:, 1][None]
    ex, ez = (B[:, 0] - A[:, 0])[None], (B[:, 1] - A[:, 1])[None]
    ee = ex * ex + ez * ez + 1e-12
    out = np.empty(len(px))
    step = 1500
    for c in range(0, len(px), step):
        X = px[c:c + step, None]
        Z = pz[c:c + step, None]
        t = np.clip(((X - ax) * ex + (Z - az) * ez) / ee, 0.0, 1.0)
        dx = X - (ax + t * ex)
        dz = Z - (az + t * ez)
        dmin = np.sqrt((dx * dx + dz * dz).min(axis=1))
        cond = (az > Z) != ((az + ez) > Z)
        xint = ax + (Z - az) * ex / np.where(np.abs(ez) < 1e-12, 1e-12, ez)
        inside = ((cond & (X < xint)).sum(axis=1) % 2) == 1
        out[c:c + step] = np.where(inside, dmin, -dmin)
    return out


def _seg_dist(px, pz, pts):
    d = np.full(len(px), 1e9)
    for i in range(len(pts) - 1):
        ax, az = pts[i]
        bx, bz = pts[i + 1]
        ex, ez = bx - ax, bz - az
        t = np.clip(((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez), 0, 1)
        dx = px - (ax + t * ex)
        dz = pz - (az + t * ez)
        d = np.minimum(d, np.sqrt(dx * dx + dz * dz))
    return d


def path_mask(px, pz, extra=()):
    m = np.zeros(len(px))
    wob = 1.0 + 0.25 * fbm2(px * 0.3, pz * 0.3, 2, seed=5.0)
    for pts, hw in list(PATHS) + list(extra):
        d = _seg_dist(px, pz, pts)
        m = np.maximum(m, smoothstep(hw * wob, hw * 0.45 * wob, d))
    # gravel apron round the tower base
    r = np.hypot(px - LIGHTHOUSE[0], pz - LIGHTHOUSE[2])
    m = np.maximum(m, smoothstep(5.0, 4.4, r) * smoothstep(3.0, 3.3, r))
    return m


# ---------------------------------------------------------------- height function

def plateau(x, z):
    P = 15.4 + 1.1 * fbm2(x / 45.0, z / 45.0, 4, seed=1.0) + 1.6 * smoothstep(-15, -90, x)
    P -= 8.0 * smoothstep(-200, -480, x)
    # inland hills: a backdrop rising behind the cottage, seen from the sea
    P += 13.0 * np.exp(-((x + 175.0) / 60.0) ** 2) / (1.0 + (z / 85.0) ** 2)
    P += 5.0 * np.exp(-((x + 108.0) / 32.0) ** 2 - ((z + 22.0) / 30.0) ** 2)
    P += 7.0 * np.exp(-((x + 260.0) / 80.0) ** 2 - ((z - 60.0) / 90.0) ** 2)
    P += 0.25 * fbm2(x / 9.0, z / 9.0, 3, seed=2.0)
    r = np.hypot(x - LIGHTHOUSE[0], z - LIGHTHOUSE[2])
    lh = smoothstep(11.5, 8.5, r)
    P = P * (1 - lh) + LIGHTHOUSE[1] * lh
    dx = np.maximum(np.abs(x - COTTAGE[0]) - (COTTAGE_HALF[0] + 1.5), 0)
    dz = np.maximum(np.abs(z - COTTAGE[2]) - (COTTAGE_HALF[1] + 1.5), 0)
    ct = smoothstep(4.0, 0.0, np.hypot(dx, dz))
    P = P * (1 - ct) + COTTAGE[1] * ct
    return P


def cliffiness(x, z):
    zc = np.where(x < 0, 0.5 * (zs_at(x) + zn_at(x)), -7.0)
    side = smoothstep(-5.0, 5.0, z - zc)
    k_s = smoothstep(-82.0, -60.0, x)
    k_n = smoothstep(-26.0, -6.0, x)
    return side * k_s + (1 - side) * k_n, side


def ramp_weight(x, z):
    return smoothstep(RAMP_X0 + 2.5, RAMP_X0 - 0.5, x) * smoothstep(RAMP_X1 - 3.0, RAMP_X1, x) * (z > 0)


def ramp_height(x):
    t = np.clip((RAMP_X0 - x) / (RAMP_X0 - RAMP_X1), 0.0, 1.0)
    top = plateau(np.full_like(x, RAMP_X1), zs_at(np.full_like(x, RAMP_X1)) - 4.0)
    return 1.9 + (top - 1.9) * t


def height(x, z, d):
    """Engine height for positions x, z with signed coast distance d."""
    P = plateau(x, z)
    k, side = cliffiness(x, z)
    n1 = fbm2(x * 0.05, z * 0.05, 3, seed=11.0)
    n2 = fbm2(x * 0.22, z * 0.22, 3, seed=12.0)
    n3 = fbm2(x * 0.11, z * 0.11, 3, seed=13.0)
    n4 = fbm2(x * 0.07, z * 0.07, 2, seed=15.0)
    n5 = fbm2(x * 0.09, z * 0.09, 2, seed=16.0)
    tip = smoothstep(-10.0, 0.0, x)
    a = np.clip(2.6 + 2.2 * n1 + 1.6 * n3, 0.3, 6.0)
    a = a * (1 - tip) + np.clip(0.7 + 0.8 * n1 + 0.6 * n3, 0.2, 1.8) * tip
    rz = ramp_weight(x, z)
    jz = smoothstep(4.0, 2.0, np.abs(x - JETTY_X)) * (z > 0)
    a = a * (1 - np.maximum(rz, jz)) + 3.0 * np.maximum(rz, jz)
    wc = np.clip(3.2 + 2.4 * n4 + 1.5 * n3, 1.4, 8.0)
    wc = wc * (1 - tip) + np.clip(2.6 + 1.2 * n3, 1.6, 4.5) * tip
    wc = wc * (1 - rz) + np.minimum(wc, 2.6) * rz
    hm = 0.42 + 0.3 * n5
    ledge = np.clip(1.2 + 3.0 * n5 + 1.4 * n2, 0.0, 3.0) * (1 - rz) * (1 - jz)
    plat_top = 1.8 + 0.6 * n2 + 0.5 * n3
    plat = 0.8 + (plat_top - 0.8) * smoothstep(0.0, np.maximum(a, 0.3), d) + 0.3 * n2
    plat = plat * (1 - jz) + LANDING_Y * jz
    plat_top = plat_top * (1 - jz) + LANDING_Y * jz
    shelf = 1.7 * rz
    b = plat_top * (1 - rz) + ramp_height(x) * rz
    hmid = b + (P - b) * hm
    wc1 = wc * hm
    wc2 = wc * (1 - hm)
    t = d - a - shelf
    r1 = np.clip(t / wc1, 0.0, 1.0)
    r1 = r1 * r1 * (3 - 2 * r1)
    r2 = np.clip((t - wc1 - ledge) / wc2, 0.0, 1.0)
    r2 = r2 * r2 * (3 - 2 * r2)
    has_ledge = (ledge > 0.05).astype(np.float64)
    ledge_slope = 0.25 * np.clip((t - wc1) / np.maximum(ledge, 0.01), 0, 1) * has_ledge
    up = b + (hmid - b) * r1 + ledge_slope + (P - hmid - 0.25 * has_ledge) * r2
    lip = 0.35 * smoothstep(a + shelf + wc + ledge + 2.5, a + shelf + wc + ledge, d)
    cliff = np.where(d < a, plat + (b - plat_top) * smoothstep(a - 0.7, a, d), up - lip * (r2 > 0.99))
    seabed_c = 0.8 - 13.4 * (1 - np.exp(np.minimum(d, 0) / 9.0)) + 0.9 * n2
    cliff = np.where(d < 0, seabed_c, cliff)

    g = np.clip(d / np.maximum(22.0, 1.4 * P), 0.0, 1.0)
    g = g * g * (3 - 2 * g)
    shore = 0.5 + 0.7 * smoothstep(0.0, 4.0, d)
    gentle = shore + (P - shore) * g ** 0.9 + 0.2 * n2 * smoothstep(0, 6, d)
    seabed_g = 0.5 - 12.8 * (1 - np.exp(np.minimum(d, 0) / 13.0)) + 0.7 * n2
    gentle = np.where(d < 0, seabed_g, gentle)

    h = gentle * (1 - k) + cliff * k
    h = np.maximum(h, -14.5)
    # small hummocks on the land
    h += 0.12 * fbm2(x * 0.6, z * 0.6, 3, seed=20.0) * smoothstep(3.0, 6.0, h)
    h -= 0.07 * path_mask(x, z)
    return h


# ---------------------------------------------------------------- 3D rock displacement

def rock_displace(V, N, w, seed=0.0, strata_amp=1.0):
    """Displace vertices V (Blender coords) along normals N with weight w."""
    x, y, z = V[:, 0], V[:, 1], V[:, 2]
    big = fbm3(x * 0.07 + seed, y * 0.07, z * 0.09, 4)
    rid = ridged3(x * 0.22, y * 0.22 + seed, z * 0.3, 3)
    ze = z + 0.05 * x - 0.03 * y + 1.6 * fbm3(x * 0.05, y * 0.05, z * 0.02 + seed, 2)
    s = ze / 0.95
    fi = np.floor(s)
    fr = s - fi
    prof = smoothstep(0.0, 0.2, fr) * smoothstep(1.0, 0.78, fr)
    br = np.sin(fi * 12.9898 + seed * 7.0) * 43758.5453
    br = br - np.floor(br)
    strata = prof * (0.12 + 0.5 * br * br)
    f1, f2, cid = voronoi3(x * 0.42, y * 0.42, z * 0.2)
    crack = smoothstep(0.1, 0.0, f2 - f1)
    blocks = (cid - 0.5) * 0.35
    cmask = smoothstep(-0.1, 0.25, fbm3(x * 0.04, y * 0.04, z * 0.04 + seed, 2))
    disp = 1.5 * big + strata * strata_amp + 0.4 * rid + blocks - 0.45 * crack * cmask
    return V + N * (w * disp)[:, None]


def _steep_weight(N, V):
    steep = 1.0 - np.abs(N[:, 2])
    w = smoothstep(0.22, 0.55, steep)
    low = smoothstep(4.0, 1.2, V[:, 2]) * smoothstep(-6.0, -1.0, V[:, 2])
    return np.maximum(w, 0.6 * low)


# ---------------------------------------------------------------- mesh builders

def _grid(x0, x1, z0, z1, step):
    xs = np.arange(x0, x1 + 1e-6, step)
    zs = np.arange(z0, z1 + 1e-6, step)
    X, Z = np.meshgrid(xs, zs)
    return xs, zs, X.ravel(), Z.ravel()


def _grid_faces(nx, nz):
    i = np.arange(nx - 1)
    j = np.arange(nz - 1)
    I, J = np.meshgrid(i, j)
    a = (J * nx + I).ravel()
    return np.stack([a, a + 1, a + 1 + nx, a + nx], 1)


def boulders(poly, rng, count=90):
    """Rounded boulders scattered along the cliff foot and in the shallows (engine data)."""
    out = []
    tries = 0
    while len(out) < count and tries < 20000:
        tries += 1
        x = rng.uniform(-62.0, 30.0)
        z = rng.uniform(-40.0, 46.0)
        d = poly_sdf(np.array([x]), np.array([z]), poly)[0]
        k, _ = cliffiness(np.array([x]), np.array([z]))
        if k[0] < 0.5 or d > 2.6 or d < -7.0:
            continue
        if abs(x - JETTY_X) < 3.5 and z > 12:
            continue
        if math.hypot(x - 25, z - 12) < 6 or math.hypot(x - 31, z + 3) < 5:
            continue
        r = rng.uniform(0.45, 1.0) ** 2 * 2.1 + 0.35
        y = height(np.array([x]), np.array([z]), np.array([d]))[0]
        out.append((x, y, z, r))
    return out


def _boulder_mesh(rng, x, y, z, r):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
    V = np.array([v.co[:] for v in bm.verts])
    sx, sy, sz = rng.uniform(0.8, 1.3), rng.uniform(0.8, 1.3), rng.uniform(0.55, 0.85)
    off = rng.uniform(0, 100)
    n = fbm3(V[:, 0] * 1.2 + off, V[:, 1] * 1.2, V[:, 2] * 1.2, 3)
    V = V * (1 + 0.28 * n)[:, None]
    V = V * np.array([sx, sy, sz]) * r
    ang = rng.uniform(0, 2 * math.pi)
    c, s = math.cos(ang), math.sin(ang)
    V = np.stack([V[:, 0] * c - V[:, 1] * s, V[:, 0] * s + V[:, 1] * c, V[:, 2]], 1)
    b = E(x, y, z)
    V = V + np.array([b.x, b.y, b.z - r * 0.25])
    for v, p in zip(bm.verts, V):
        v.co = p
    return bm


_POLY = []


def cliff_edge_z(x):
    """Engine z of the south cliff top edge at x (first point going south that drops off the plateau)."""
    poly = _POLY[0]
    zz = np.linspace(4.0, 30.0, 521)
    xx = np.full_like(zz, x)
    d = poly_sdf(xx, zz, poly)
    h = height(xx, zz, d)
    P = plateau(xx, zz)
    i = int(np.argmax(h < P - 1.2))
    return float(zz[i])


def finalize_paths(poly):
    """Route the cliff path from the cottage to the top of the jetty ramp inland of the edge."""
    _POLY[:] = [poly]
    PATHS[1] = ([(-17, 9.0), (-17.5, 9.2)], 0.65)
    pts = [(-17.0, 9.0)]
    for x in (-23.0, -29.0, -35.0, -41.0, -46.0):
        pts.append((x, cliff_edge_z(x) - 2.6))
    top = ramp_line(poly)[0]
    pts.append((top[0], top[2]))
    PATHS[1] = (pts, 0.65)
    return pts


def build_headland(quick=False):
    import time
    t0 = time.time()
    rng = np.random.RandomState(42)
    poly = coastline()
    finalize_paths(poly)
    step = 0.7 if quick else 0.5
    xs, zs, X, Z = _grid(NEAR_X[0], NEAR_X[1], NEAR_Z[0], NEAR_Z[1], step)
    D = poly_sdf(X, Z, poly)
    H = height(X, Z, D)
    log("near heightfield", len(X), "points %.1f s" % (time.time() - t0))
    nx, nz = len(xs), len(zs)
    V = np.stack([X, -Z, H], 1)
    F = _grid_faces(nx, nz)
    me = mesh_from_numpy("HeadlandNear", V, F)
    bm = bmesh.new()
    bm.from_mesh(me)
    # close the block so the voxel remesher sees a solid
    bnd = [e for e in bm.edges if e.is_boundary]
    ext = bmesh.ops.extrude_edge_only(bm, edges=bnd)
    new_v = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
    for v in new_v:
        v.co.z = -22.0
    new_e = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMEdge) and g.is_boundary]
    bmesh.ops.holes_fill(bm, edges=new_e, sides=0)
    # boulders join the block and fuse in the remesh
    for (x, y, z, r) in boulders(poly, rng, 50 if quick else 95):
        b = _boulder_mesh(rng, x, y, z, r)
        tmp = bpy.data.meshes.new("b")
        b.to_mesh(tmp)
        b.free()
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    bm.to_mesh(me)
    bm.free()
    ob = new_object("HeadlandNear", me)
    RAMP_PATH[:] = [([(p[0], p[2]) for p in ramp_line(poly)], 0.55)]
    rm = ob.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = 0.42 if quick else 0.3
    rm.adaptivity = 0.0
    apply_modifiers(ob)
    log("remeshed", len(ob.data.vertices), "verts %.1f s" % (time.time() - t0))
    # drop the bottom and the side walls of the block
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    m = 0.9
    kill = [v for v in bm.verts if v.co.z < -16.5 or v.co.x < NEAR_X[0] + m or v.co.x > NEAR_X[1] - m
            or -v.co.y < NEAR_Z[0] + m or -v.co.y > NEAR_Z[1] - m]
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    # 3D displacement on cliffs and the shore
    V = mesh_verts(ob.data)
    N = vert_normals(ob.data)
    w = _steep_weight(N, V)
    steep = 1.0 - np.abs(N[:, 2])
    w = np.maximum(w, 0.7 * outcrops(V[:, 0], -V[:, 1]) * smoothstep(0.08, 0.25, steep))
    deep = smoothstep(-3.0, -8.0, V[:, 2])
    w = np.maximum(w * (1 - 0.6 * deep), 0.25 * deep)
    # fade all displacement out toward the west seam with the far land
    seam = smoothstep(NEAR_X[0] + 2.0, NEAR_X[0] + 12.0, V[:, 0])
    w = w * seam
    V2 = rock_displace(V, N, w)
    hum = 0.05 * fbm3(V[:, 0] * 0.9, V[:, 1] * 0.9, V[:, 2] * 0.9, 3)
    V2 = V2 + N * ((1 - w) * hum * seam)[:, None]
    # sink the seabed near the block edges so no straight shelf edge shows through the water
    de = np.minimum.reduce([V2[:, 0] - NEAR_X[0] + 40.0 * (V2[:, 2] > -3), NEAR_X[1] - V2[:, 0],
                            -V2[:, 1] - NEAR_Z[0], NEAR_Z[1] + V2[:, 1]])
    V2[:, 2] -= 11.0 * smoothstep(12.0, 0.0, de) * smoothstep(-4.0, -8.0, V2[:, 2])
    set_mesh_verts(ob.data, V2)
    log("displaced %.1f s" % (time.time() - t0))
    # decimate: protect what is above water
    vg = ob.vertex_groups.new(name="detail")
    keep = np.clip(smoothstep(-4.0, 0.5, V2[:, 2]) * 0.9 * (0.35 + 0.65 * smoothstep(-95.0, -70.0, V2[:, 0])) + 0.1,
                   0, 1)
    # the stage round the buildings gets the densest mesh
    core = np.hypot(V2[:, 0] + 10.0, V2[:, 1] - 4.0)
    keep = np.clip(keep + 0.6 * smoothstep(40.0, 20.0, core) * smoothstep(-2.0, 2.0, V2[:, 2]), 0, 1)
    for i, wv in enumerate(keep):
        vg.add([i], float(wv), "REPLACE")
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    target = 62000 if quick else 70000
    decimate(ob, min(1.0, target / max(tris, 1)), "detail", 1.0)
    ob.vertex_groups.clear()
    _attach_attrs(ob)
    # material parts: 0 main rock and land, 1 land west of the split, 2 seabed
    me = ob.data
    V = mesh_verts(me)
    idx = []
    for p in me.polygons:
        vz = [V[i][2] for i in p.vertices]
        cx = sum(V[i][0] for i in p.vertices) / len(p.vertices)
        if max(vz) < -1.8:
            idx.append(2)
        elif cx < WEST_SPLIT:
            idx.append(1)
        else:
            idx.append(0)
    me.polygons.foreach_set("material_index", np.array(idx, np.int32))
    smooth_by_angle(ob.data, 75.0)
    log("headland near tris", sum(len(p.vertices) - 2 for p in ob.data.polygons), "%.1f s" % (time.time() - t0))
    return ob, poly


def outcrops(ex, ez):
    return smoothstep(0.18, 0.42, fbm2(ex * 0.05, ez * 0.05, 3, seed=31.0))


def _attach_attrs(ob):
    V = mesh_verts(ob.data)
    N = vert_normals(ob.data)
    ex, ez = V[:, 0], -V[:, 1]
    set_point_attr(ob.data, "path", path_mask(ex, ez, RAMP_PATH))
    k, _ = cliffiness(ex, ez)
    steep = 1.0 - N[:, 2]
    out = outcrops(ex, ez) * smoothstep(0.1, 0.28, steep)
    rock = np.maximum.reduce([k * smoothstep(0.26, 0.48, steep), (1 - k) * smoothstep(0.45, 0.65, steep), out,
                              smoothstep(3.6, 2.4, V[:, 2])])
    set_point_attr(ob.data, "rock", np.clip(rock, 0, 1))


RAMP_PATH = []


def ramp_line(poly, n=28):
    """Points (engine x, y, z) along the middle of the jetty ramp shelf, west (top) to east (bottom)."""
    pts = []
    for x in np.linspace(RAMP_X1 + 1.0, RAMP_X0 - 0.2, n):
        zz = np.linspace(5.0, 30.0, 600)
        xx = np.full_like(zz, x)
        d = poly_sdf(xx, zz, poly)
        target = 3.0 + 0.85
        i = int(np.argmin(np.abs(d - target) + (d > 99) * 1e9))
        z = zz[i]
        y = float(ramp_height(np.array([x]))[0])
        pts.append((float(x), y, float(z)))
    return pts


def build_far_land(poly, quick=False):
    step = 3.0 if quick else 2.5
    xs, zs, X, Z = _grid(-560.0, NEAR_X[0] + 3.0, -230.0, 260.0, step)
    D = poly_sdf(X, Z, poly)
    H = height(X, Z, D) - 0.04
    V = np.stack([X, -Z, H], 1)
    F = _grid_faces(len(xs), len(zs))
    keep = (H[F].max(axis=1) > -12.8)
    F = F[keep]
    me = mesh_from_numpy("HeadlandFar", V, F)
    ob = new_object("HeadlandFar", me)
    bm = bmesh.new()
    bm.from_mesh(me)
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(me)
    # drop the ragged outer seabed edge of the far land steeply below -20 m
    for v in bm.verts:
        if v.is_boundary and v.co.z < -6.0:
            v.co.z = -23.0
    bm.to_mesh(me)
    bm.free()
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    decimate(ob, min(1.0, (9000 if quick else 9000) / tris))
    _attach_attrs(ob)
    smooth_by_angle(ob.data, 89.0)
    log("far land tris", sum(len(p.vertices) - 2 for p in ob.data.polygons))
    return ob


STACKS = [  # engine x, z, top height, base radius
    (25.0, 12.5, 12.0, 3.0),
    (31.5, -3.0, 4.6, 2.4),
    (21.0, 21.0, 1.7, 1.7),
]


def build_stacks(quick=False):
    bm = bmesh.new()
    for si, (x, z, top, r0) in enumerate(STACKS):
        segs = 44
        hs = np.linspace(-10.0, top, 40)
        rows = []
        rot = 0.7 * si + 0.4
        for hi, hgt in enumerate(hs):
            base = r0 * (1.0 + 1.0 * smoothstep(-2.0, -9.0, hgt)) * (1.0 - 0.3 * smoothstep(0.0, top, hgt))
            base *= 1.0 + 0.22 * fbm3(np.array([hgt * 0.2]), np.array([si * 5.0]), np.array([1.0]), 2)[0]
            base *= 1.0 - 0.14 * smoothstep(-0.5, 0.6, hgt) * smoothstep(2.2, 1.0, hgt)
            ring = []
            for k in range(segs):
                a = 2 * math.pi * k / segs
                cx, cz = math.cos(a), math.sin(a)
                n = fbm3(np.array([cx * 1.1 + si * 10]), np.array([cz * 1.1]), np.array([hgt * 0.09]), 3)[0]
                rr = base * (1.0 + 0.45 * n)
                lx, lz = rr * cx, rr * cz * 0.72
                ring.append(bm.verts.new(E(x + lx * math.cos(rot) - lz * math.sin(rot), hgt,
                                           z + lx * math.sin(rot) + lz * math.cos(rot))))
            rows.append(ring)
        for j in range(len(rows) - 1):
            for k in range(segs):
                k2 = (k + 1) % segs
                bm.faces.new((rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]))
        topc = bm.verts.new(E(x, top + 0.35, z))
        for k in range(segs):
            bm.faces.new((rows[-1][k], rows[-1][(k + 1) % segs], topc))
        bm.faces.new(list(reversed(rows[0])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("SeaStacks")
    bm.to_mesh(me)
    bm.free()
    ob = new_object("SeaStacks", me)
    rm = ob.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = 0.3 if quick else 0.22
    apply_modifiers(ob)
    V = mesh_verts(ob.data)
    N = vert_normals(ob.data)
    w = 0.8 + 0.2 * smoothstep(0.3, 0.6, 1 - np.abs(N[:, 2]))
    V2 = rock_displace(V, N, w * 0.8, seed=3.3, strata_amp=0.55)
    set_mesh_verts(ob.data, V2)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    kill = [v for v in bm.verts if v.co.z < -11.0]
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    decimate(ob, min(1.0, (8000 if quick else 8500) / tris))
    set_point_attr(ob.data, "path", np.zeros(len(ob.data.vertices)))
    N = vert_normals(ob.data)
    V = mesh_verts(ob.data)
    set_point_attr(ob.data, "rock", 1.0 - smoothstep(0.8, 0.92, N[:, 2]) * (V[:, 2] > 3.0))
    smooth_by_angle(ob.data, 75.0)
    log("stacks tris", sum(len(p.vertices) - 2 for p in ob.data.polygons))
    return ob


# ---------------------------------------------------------------- queries on the built terrain

class Ground:
    """Raycasts down onto the terrain meshes (engine coordinates)."""

    def __init__(self, objs):
        dg = bpy.context.evaluated_depsgraph_get()
        self.trees = [BVHTree.FromObject(o, dg) for o in objs]

    def y(self, x, z, top=80.0):
        best = None
        for t in self.trees:
            hit = t.ray_cast(E(x, top, z), Vector((0, 0, -1)))
            if hit[0] is not None:
                yy = hit[0].z
                best = yy if best is None else max(best, yy)
        return best


def write_heightmap(path, ground, poly):
    nx = nz = 256
    vals = np.empty((nz, nx), np.float32)
    xs = -160.0 + np.arange(nx) + 0.5
    zs = -128.0 + np.arange(nz) + 0.5
    X, Z = np.meshgrid(xs, zs)
    D = poly_sdf(X.ravel(), Z.ravel(), poly)
    fallback = height(X.ravel(), Z.ravel(), D).reshape(nz, nx)
    for j, z in enumerate(zs):
        for i, x in enumerate(xs):
            y = ground.y(float(x), float(z))
            if y is None:
                y = min(float(fallback[j, i]), -6.0)
            vals[j, i] = y
    with open(path, "wb") as f:
        f.write(vals.astype("<f4").tobytes())
    log("heightmap", path, "min %.2f max %.2f" % (vals.min(), vals.max()))
    return vals
