# Shared helpers for the Storm Light asset build: paths, coordinates,
# numpy noise, mesh building and mesh clean-up.
#
# Coordinates: the engine is Y up, metres, sea level y = 0. Blender is Z up.
# The glTF exporter (export_yup=True) maps Blender (bx, by, bz) to engine
# (bx, bz, -by). So engine (x, y, z) is Blender (x, -z, y). Use E() to go
# from engine to Blender and to_engine() for the way back.

import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
EXAMPLE = os.path.dirname(HERE)
ASSETS = os.path.join(EXAMPLE, "assets")


def _repo_root(start):
    # walk up to the folder holding .git so scratch files land in <repo>/.lane/blender
    d = start
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        up = os.path.dirname(d)
        if up == d:
            return os.path.dirname(os.path.dirname(EXAMPLE))
        d = up


REPO = _repo_root(HERE)
SCRATCH = os.path.join(REPO, ".lane", "blender")


def E(x, y, z):
    """Engine (x, y, z) to a Blender vector."""
    return Vector((x, -z, y))


def to_engine(v):
    return [round(float(v[0]), 4), round(float(v[2]), 4), round(float(-v[1]), 4)]


def log(*a):
    print("[storm-light]", *a, flush=True)


# ---------------------------------------------------------------- noise

_rng = np.random.RandomState(1871)
_PERM = np.concatenate([_rng.permutation(256)] * 2).astype(np.int64)
_GRAD = np.array(
    [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
     [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]], dtype=np.float64)


def _fade(t):
    return t * t * t * (t * (t * 6 - 15) + 10)


def perlin3(x, y, z):
    """Gradient noise, roughly -1..1. Inputs are numpy arrays of equal shape."""
    x = np.asarray(x, np.float64)
    y = np.asarray(y, np.float64)
    z = np.asarray(z, np.float64)
    xi0 = np.floor(x)
    yi0 = np.floor(y)
    zi0 = np.floor(z)
    xf = x - xi0
    yf = y - yi0
    zf = z - zi0
    xi = xi0.astype(np.int64) & 255
    yi = yi0.astype(np.int64) & 255
    zi = zi0.astype(np.int64) & 255
    u, v, w = _fade(xf), _fade(yf), _fade(zf)
    P = _PERM

    def g(ix, iy, iz, dx, dy, dz):
        h = P[P[P[ix] + iy] + iz] % 12
        gr = _GRAD[h]
        return gr[..., 0] * dx + gr[..., 1] * dy + gr[..., 2] * dz

    x1 = (xi + 1) & 255
    y1 = (yi + 1) & 255
    z1 = (zi + 1) & 255
    n000 = g(xi, yi, zi, xf, yf, zf)
    n100 = g(x1, yi, zi, xf - 1, yf, zf)
    n010 = g(xi, y1, zi, xf, yf - 1, zf)
    n110 = g(x1, y1, zi, xf - 1, yf - 1, zf)
    n001 = g(xi, yi, z1, xf, yf, zf - 1)
    n101 = g(x1, yi, z1, xf - 1, yf, zf - 1)
    n011 = g(xi, y1, z1, xf, yf - 1, zf - 1)
    n111 = g(x1, y1, z1, xf - 1, yf - 1, zf - 1)
    nx00 = n000 + u * (n100 - n000)
    nx10 = n010 + u * (n110 - n010)
    nx01 = n001 + u * (n101 - n001)
    nx11 = n011 + u * (n111 - n011)
    nxy0 = nx00 + v * (nx10 - nx00)
    nxy1 = nx01 + v * (nx11 - nx01)
    return nxy0 + w * (nxy1 - nxy0)


def fbm3(x, y, z, octaves=5, lac=2.0, gain=0.5):
    total = np.zeros(np.shape(x))
    amp = 1.0
    f = 1.0
    norm = 0.0
    for i in range(octaves):
        o = 17.3 * i
        total += amp * perlin3(x * f + o, y * f - o, z * f + 0.5 * o)
        norm += amp
        amp *= gain
        f *= lac
    return total / norm


def fbm2(x, z, octaves=5, seed=0.0):
    return fbm3(x, np.full(np.shape(x), 0.37 + seed), z, octaves)


def ridged3(x, y, z, octaves=4):
    total = np.zeros(np.shape(x))
    amp = 1.0
    f = 1.0
    norm = 0.0
    for i in range(octaves):
        n = 1.0 - np.abs(perlin3(x * f + 3.1 * i, y * f + 1.7 * i, z * f - 2.3 * i))
        total += amp * n * n
        norm += amp
        amp *= 0.5
        f *= 2.0
    return total / norm


def _hash3(ix, iy, iz):
    a = np.sin(ix * 127.1 + iy * 311.7 + iz * 74.7) * 43758.5453
    b = np.sin(ix * 269.5 + iy * 183.3 + iz * 246.1) * 43758.5453
    c = np.sin(ix * 113.5 + iy * 271.9 + iz * 124.6) * 43758.5453
    return a - np.floor(a), b - np.floor(b), c - np.floor(c)


def voronoi3(x, y, z):
    """Returns F1, F2 distances and a per-cell random value of the nearest cell."""
    cx, cy, cz = np.floor(x), np.floor(y), np.floor(z)
    f1 = np.full(np.shape(x), 9.0)
    f2 = np.full(np.shape(x), 9.0)
    cid = np.zeros(np.shape(x))
    for ox in (-1, 0, 1):
        for oy in (-1, 0, 1):
            for oz in (-1, 0, 1):
                ix, iy, iz = cx + ox, cy + oy, cz + oz
                hx, hy, hz = _hash3(ix, iy, iz)
                dx = ix + hx - x
                dy = iy + hy - y
                dz = iz + hz - z
                d = np.sqrt(dx * dx + dy * dy + dz * dz)
                closer = d < f1
                f2 = np.where(closer, f1, np.minimum(f2, d))
                cid = np.where(closer, hx * 0.7 + hy * 0.3, cid)
                f1 = np.where(closer, d, f1)
    return f1, f2, cid


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, np.float64) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def hash1(i):
    a = math.sin(i * 12.9898 + 78.233) * 43758.5453
    return a - math.floor(a)


# ---------------------------------------------------------------- scene / objects

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)


def link(ob, collection=None):
    (collection or bpy.context.scene.collection).objects.link(ob)
    return ob


def new_object(name, mesh, collection=None):
    ob = bpy.data.objects.new(name, mesh)
    return link(ob, collection)


def empty(name, loc=(0, 0, 0)):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_size = 1.0
    ob.location = loc
    return link(ob)


def select_only(obs):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    if not isinstance(obs, (list, tuple)):
        obs = [obs]
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]


def apply_modifiers(ob):
    select_only(ob)
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def mesh_from_numpy(name, verts, faces):
    """verts: (N,3) Blender coords, faces: (M,3) or (M,4) int array."""
    me = bpy.data.meshes.new(name)
    verts = np.asarray(verts, np.float32)
    faces = np.asarray(faces, np.int32)
    k = faces.shape[1]
    me.vertices.add(len(verts))
    me.vertices.foreach_set("co", verts.ravel())
    me.loops.add(faces.size)
    me.loops.foreach_set("vertex_index", faces.ravel())
    me.polygons.add(len(faces))
    me.polygons.foreach_set("loop_start", np.arange(0, faces.size, k, dtype=np.int32))
    me.update(calc_edges=True)
    me.validate()
    return me


def mesh_verts(me):
    a = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", a)
    return a.reshape(-1, 3).astype(np.float64)


def set_mesh_verts(me, v):
    me.vertices.foreach_set("co", np.asarray(v, np.float32).ravel())
    me.update()


def vert_normals(me):
    a = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("normal", a)
    return a.reshape(-1, 3).astype(np.float64)


def set_point_attr(me, name, values):
    if name in me.attributes:
        me.attributes.remove(me.attributes[name])
    at = me.attributes.new(name, "FLOAT", "POINT")
    at.data.foreach_set("value", np.asarray(values, np.float32))


def smooth_by_angle(me, angle_deg=35.0):
    """Smooth shading everywhere, with sharp edges above the angle."""
    bm = bmesh.new()
    bm.from_mesh(me)
    lim = math.radians(angle_deg)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < lim
        else:
            e.smooth = True
    bm.to_mesh(me)
    bm.free()
    me.update()


def tri_count(ob):
    me = ob.data
    return sum(len(p.vertices) - 2 for p in me.polygons)


def smart_uv(obs, angle=66.0, margin=0.003):
    if not isinstance(obs, (list, tuple)):
        obs = [obs]
    obs = [o for o in obs if o.type == "MESH"]
    select_only(obs)
    for o in obs:
        if not o.data.uv_layers:
            o.data.uv_layers.new(name="UVMap")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def decimate(ob, ratio, vgroup=None, vfactor=1.0):
    m = ob.modifiers.new("dec", "DECIMATE")
    m.decimate_type = "COLLAPSE"
    m.ratio = ratio
    m.use_collapse_triangulate = True
    if vgroup:
        m.vertex_group = vgroup
        m.vertex_group_factor = vfactor
    apply_modifiers(ob)


# ---------------------------------------------------------------- bmesh builder

class Builder:
    """Collects primitives into one bmesh. Each face gets an integer zone
    (stored as material_index while building, later as a float attribute)."""

    def __init__(self):
        self.bm = bmesh.new()

    def _zone(self, verts, zone):
        faces = set()
        for v in verts:
            faces.update(v.link_faces)
        for f in faces:
            f.material_index = zone
        return faces

    def box(self, size, m=Matrix(), zone=0, bevel=0.0, seg=1):
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=m @ Matrix.Diagonal((size[0], size[1], size[2], 1.0)))
        verts = r["verts"]
        if bevel > 0:
            edges = list({e for v in verts for e in v.link_edges})
            res = bmesh.ops.bevel(self.bm, geom=edges + list(verts), offset=bevel, segments=seg, affect="EDGES",
                                  profile=0.5, clamp_overlap=True)
            verts = list(verts) + list(res["verts"])
            verts = [v for v in verts if v.is_valid]
        self._zone(verts, zone)
        return verts

    def cyl(self, r1, r2, depth, segs, m=Matrix(), zone=0, cap=True):
        r = bmesh.ops.create_cone(self.bm, cap_ends=cap, cap_tris=False, segments=segs, radius1=r1, radius2=r2,
                                  depth=depth, matrix=m)
        self._zone(r["verts"], zone)
        return r["verts"]

    def sphere(self, radius, m=Matrix(), zone=0, subd=2):
        r = bmesh.ops.create_icosphere(self.bm, subdivisions=subd, radius=radius, matrix=m)
        self._zone(r["verts"], zone)
        return r["verts"]

    def uvsphere(self, radius, segs=16, rings=8, m=Matrix(), zone=0):
        r = bmesh.ops.create_uvsphere(self.bm, u_segments=segs, v_segments=rings, radius=radius, matrix=m)
        self._zone(r["verts"], zone)
        return r["verts"]

    def lathe(self, prof, segs, m=Matrix(), zone=0, cap_bottom=False, cap_top=False, zones=None, a0=0.0,
              a1=2 * math.pi):
        """prof: list of (radius, height) bottom to top. Revolved around local Z."""
        full = abs((a1 - a0) - 2 * math.pi) < 1e-6
        n = segs if full else segs + 1
        rings = []
        for (r, h) in prof:
            ring = []
            for i in range(n):
                a = a0 + (a1 - a0) * i / segs
                ring.append(self.bm.verts.new(m @ Vector((r * math.cos(a), r * math.sin(a), h))))
            rings.append(ring)
        faces = []
        for j in range(len(rings) - 1):
            zj = zones[j] if zones else zone
            for i in range(segs):
                i2 = (i + 1) % n
                if rings[j][i].co == rings[j + 1][i].co and rings[j][i2].co == rings[j + 1][i2].co:
                    continue
                f = self.bm.faces.new((rings[j][i], rings[j][i2], rings[j + 1][i2], rings[j + 1][i]))
                f.material_index = zj
                faces.append(f)
        if full and cap_bottom and prof[0][0] > 1e-6:
            f = self.bm.faces.new(list(reversed(rings[0])))
            f.material_index = zone
        if full and cap_top and prof[-1][0] > 1e-6:
            f = self.bm.faces.new(rings[-1])
            f.material_index = zones[-1] if zones else zone
        return rings

    def poly(self, pts, zone=0):
        vs = [self.bm.verts.new(p) for p in pts]
        f = self.bm.faces.new(vs)
        f.material_index = zone
        return vs

    def tube(self, path, radius, segs=8, zone=0, cap=True):
        """A round tube along a polyline of Blender points."""
        pts = [Vector(p) for p in path]
        rings = []
        for i, p in enumerate(pts):
            if i == 0:
                t = (pts[1] - pts[0]).normalized()
            elif i == len(pts) - 1:
                t = (pts[-1] - pts[-2]).normalized()
            else:
                t = ((pts[i + 1] - pts[i]).normalized() + (pts[i] - pts[i - 1]).normalized()).normalized()
            up = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
            a = t.cross(up).normalized()
            b = t.cross(a).normalized()
            ring = [self.bm.verts.new(p + radius * (math.cos(2 * math.pi * k / segs) * a +
                                                    math.sin(2 * math.pi * k / segs) * b)) for k in range(segs)]
            rings.append(ring)
        for j in range(len(rings) - 1):
            for k in range(segs):
                k2 = (k + 1) % segs
                f = self.bm.faces.new((rings[j][k], rings[j][k2], rings[j + 1][k2], rings[j + 1][k]))
                f.material_index = zone
        if cap:
            f = self.bm.faces.new(list(reversed(rings[0])))
            f.material_index = zone
            f = self.bm.faces.new(rings[-1])
            f.material_index = zone
        return rings

    def add_mesh(self, me, m=Matrix(), zone=None):
        tmp = bmesh.new()
        tmp.from_mesh(me)
        bmesh.ops.transform(tmp, matrix=m, verts=tmp.verts)
        if zone is not None:
            for f in tmp.faces:
                f.material_index = zone
        me2 = bpy.data.meshes.new("tmp")
        tmp.to_mesh(me2)
        tmp.free()
        self.bm.from_mesh(me2)
        bpy.data.meshes.remove(me2)

    def to_object(self, name, smooth_angle=35.0, collection=None):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        zone_from_material_index(me)
        smooth_by_angle(me, smooth_angle)
        return new_object(name, me, collection)


def zone_from_material_index(me):
    n = len(me.polygons)
    idx = np.empty(n, np.int32)
    me.polygons.foreach_get("material_index", idx)
    if "zone" in me.attributes:
        me.attributes.remove(me.attributes["zone"])
    at = me.attributes.new("zone", "FLOAT", "FACE")
    at.data.foreach_set("value", idx.astype(np.float32))
    me.polygons.foreach_set("material_index", np.zeros(n, np.int32))


def rot_y_engine(deg):
    """Rotation about engine Y (Blender Z). Engine yaw a turns +x toward -z."""
    return Matrix.Rotation(math.radians(deg), 4, "Z")


def T(x, y, z):
    """Translation matrix given engine coordinates."""
    return Matrix.Translation(E(x, y, z))
