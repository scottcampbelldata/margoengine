# Shared helpers for the Kitty Hawk asset builds (Blender 5.3, run headless):
#   blender -b --factory-startup --python <build script> -- [--lod N] [--previews 0|1]
#
# Geometry is generated as plain arrays (vertices, faces, per-corner UVs, a material per face) so every part has
# exact real-world sizes, its own bevels and its own UVs; nothing is sculpted by hand and every run gives the same
# bytes. Units are metres. Blender is Z up; the glTF exporter (export_yup) writes Blender (x, y, z) as glTF
# (x, z, -y), so a model built facing Blender -Y faces glTF +Z, the glTF convention for an asset's front.
#
# Asset files (.blend, .glb, textures, previews) never go into the repository (Scott, 2026-11-16, "Assets will never
# go to git"): they are written under Assets/blender-library/<subject>/, two folders above the checkout (the
# development root beside Projects), or MARGO_ASSET_LIBRARY. Downloads are read from kitty-hawk/downloads/ in it,
# or MARGO_ASSET_DOWNLOADS. A copy of the scripts run from inside the library finds the library it sits in.

import json
import math
import os
import struct
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

def _roots():
    here = os.path.dirname(os.path.abspath(__file__))
    d = here
    while True:
        if os.path.isfile(os.path.join(d, "AGENTS.md")):  # the checkout: the development root is two folders up
            dev = os.path.normpath(os.path.join(d, "..", ".."))
            lib = os.path.join(dev, "Assets", "blender-library")
            return lib, os.path.join(lib, "kitty-hawk", "downloads")
        if os.path.basename(d) == "blender-library" and os.path.basename(os.path.dirname(d)) == "Assets":
            return d, os.path.join(d, "kitty-hawk", "downloads")
        up = os.path.dirname(d)
        if up == d:
            raise SystemExit("set MARGO_ASSET_LIBRARY and MARGO_ASSET_DOWNLOADS: no checkout or library above " + here)
        d = up


_LIB, _DL = _roots() if not (os.environ.get("MARGO_ASSET_LIBRARY") and os.environ.get("MARGO_ASSET_DOWNLOADS")) else ("", "")
LIBRARY = os.environ.get("MARGO_ASSET_LIBRARY") or _LIB
DOWNLOADS = os.environ.get("MARGO_ASSET_DOWNLOADS") or _DL
FT = 0.3048
IN = 0.0254


def log(*a):
    print("[kh]", *a, flush=True)


def cli(defaults):
    """Options after `--` on the Blender command line, as `--name value`, typed like the defaults."""
    out = dict(defaults)
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    i = 0
    while i < len(argv):
        k = argv[i].lstrip("-").replace("-", "_")
        if k not in out:
            raise SystemExit(f"unknown option --{k}; known: {', '.join(sorted(out))}")
        v = argv[i + 1]
        d = defaults[k]
        out[k] = type(d)(v) if not isinstance(d, bool) else v not in ("0", "false", "no")
        i += 2
    return out


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.unit_settings.system = "METRIC"
    s.unit_settings.scale_length = 1.0
    return s


# ---------------------------------------------------------------- deterministic noise (numpy)

class Noise:
    """Seeded value noise and fBm on numpy grids; the same seed gives the same field everywhere."""

    def __init__(self, seed):
        self.rng = np.random.RandomState(seed)
        self.tab = self.rng.rand(256, 256).astype(np.float64)

    def value(self, x, y):
        x = np.asarray(x, np.float64)
        y = np.asarray(y, np.float64)
        xi = np.floor(x).astype(np.int64)
        yi = np.floor(y).astype(np.int64)
        fx = x - xi
        fy = y - yi
        fx = fx * fx * (3 - 2 * fx)
        fy = fy * fy * (3 - 2 * fy)
        t = self.tab
        a = t[xi & 255, yi & 255]
        b = t[(xi + 1) & 255, yi & 255]
        c = t[xi & 255, (yi + 1) & 255]
        d = t[(xi + 1) & 255, (yi + 1) & 255]
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

    def fbm(self, x, y, octaves=5, gain=0.5):
        s = 0.0
        amp = 1.0
        tot = 0.0
        f = 1.0
        for o in range(octaves):
            s = s + amp * self.value(x * f + 17.3 * o, y * f - 9.1 * o)
            tot += amp
            amp *= gain
            f *= 2.03
        return s / tot  # 0..1


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- mesh accumulator

def _frame(d):
    """Two unit vectors perpendicular to d and to each other (u, v), so (u, v, d) is right handed."""
    d = Vector(d).normalized()
    helper = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
    u = helper.cross(d).normalized()
    v = d.cross(u).normalized()
    return u, v


def rounded_rect(w, h, r, segs=3):
    """Closed 2D outline of a w x h rectangle with corner radius r, counter-clockwise, as (a, b) pairs."""
    r = min(r, w / 2 - 1e-6, h / 2 - 1e-6)
    pts = []
    corners = [(w / 2 - r, h / 2 - r, 0.0), (-w / 2 + r, h / 2 - r, 0.5 * math.pi), (-w / 2 + r, -h / 2 + r, math.pi),
               (w / 2 - r, -h / 2 + r, 1.5 * math.pi)]
    for cx, cy, a0 in corners:
        for k in range(segs + 1):
            a = a0 + 0.5 * math.pi * k / segs
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def circle(r, segs):
    return [(r * math.cos(2 * math.pi * k / segs), r * math.sin(2 * math.pi * k / segs)) for k in range(segs)]


class Part:
    """Vertices, faces, per-corner UVs (UVMap and optionally UV1) and a material index per face."""

    def __init__(self, name):
        self.name = name
        self.V = []
        self.F = []
        self.UV = []
        self.UV1 = []
        self.M = []
        self.mats = []
        self.sharp = []  # per face: True = flat shaded

    def mat(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def vert(self, p):
        self.V.append((float(p[0]), float(p[1]), float(p[2])))
        return len(self.V) - 1

    def face(self, idx, uvs, m, uv1=None, flat=False):
        self.F.append(tuple(idx))
        self.UV.append([(float(a), float(b)) for a, b in uvs])
        self.UV1.append([(float(a), float(b)) for a, b in uv1] if uv1 else [(0.0, 0.0)] * len(idx))
        self.M.append(self.mat(m))
        self.sharp.append(flat)

    def grid(self, P, UV, m, closed_u=False, UV1=None, flip=False, flat=False):
        """A quad grid from rows P[i][j] of points (i along one direction, j along the other)."""
        ni, nj = len(P), len(P[0])
        ids = [[self.vert(P[i][j]) for j in range(nj)] for i in range(ni)]
        ju = nj if closed_u else nj - 1
        for i in range(ni - 1):
            for j in range(ju):
                j2 = (j + 1) % nj
                q = [ids[i][j], ids[i + 1][j], ids[i + 1][j2], ids[i][j2]]
                uv = [UV[i][j], UV[i + 1][j], UV[i + 1][j2 if j2 else nj] if closed_u else UV[i + 1][j2],
                      UV[i][j2 if j2 else nj] if closed_u else UV[i][j2]]
                uv1 = None
                if UV1 is not None:
                    uv1 = [UV1[i][j], UV1[i + 1][j], UV1[i + 1][j2], UV1[i][j2]]
                if flip:
                    q.reverse()
                    uv.reverse()
                    if uv1:
                        uv1.reverse()
                self.face(q, uv, m, uv1, flat)
        return ids

    def cap(self, ring_ids, center, m, uvs_of, flip=False):
        c = self.vert(center)
        n = len(ring_ids)
        for k in range(n):
            a, b = ring_ids[k], ring_ids[(k + 1) % n]
            tri = [c, a, b] if not flip else [c, b, a]
            self.face(tri, [uvs_of(i) for i in tri], m, flat=True)

    def sweep(self, outline, path, m, tile=1.0, caps=True, seed=0.0, scales=None, closed_path=False, ref=None):
        """Sweeps a closed 2D outline along a 3D polyline (parallel transport frames). UV: u around, v along."""
        n = len(path)
        pts = [Vector(p) for p in path]
        tans = []
        for i in range(n):
            if closed_path:
                t = pts[(i + 1) % n] - pts[i - 1]
            elif i == 0:
                t = pts[1] - pts[0]
            elif i == n - 1:
                t = pts[-1] - pts[-2]
            else:
                t = (pts[i + 1] - pts[i]).normalized() + (pts[i] - pts[i - 1]).normalized()
            tans.append(t.normalized())
        if ref is not None and (Vector(ref) - Vector(ref).dot(tans[0]) * tans[0]).length > 1e-6:
            u0 = (Vector(ref) - Vector(ref).dot(tans[0]) * tans[0]).normalized()
            v0 = tans[0].cross(u0)
        else:
            u0, v0 = _frame(tans[0])
        us, vs = [u0], [v0]
        for i in range(1, n):
            u = us[-1] - us[-1].dot(tans[i]) * tans[i]
            u.normalize()
            us.append(u)
            vs.append(tans[i].cross(u))
        per = [0.0]
        for k in range(len(outline)):
            a, b = outline[k], outline[(k + 1) % len(outline)]
            per.append(per[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        along = [0.0]
        for i in range(1, n):
            along.append(along[-1] + (pts[i] - pts[i - 1]).length)
        P, UV = [], []
        for i in range(n):
            s = scales[i] if scales else 1.0
            row, uvr = [], []
            for k, (a, b) in enumerate(outline):
                row.append(pts[i] + us[i] * (a * s) + vs[i] * (b * s))
                uvr.append((per[k] / tile + seed, along[i] / tile + seed * 1.7))
            uvr.append((per[-1] / tile + seed, along[i] / tile + seed * 1.7))
            P.append(row)
            UV.append(uvr)
        ids = self.grid(P, UV, m, closed_u=True, flip=True)
        if caps and not closed_path:
            def cuv(k, i):
                a, b = outline[k]
                s = scales[i] if scales else 1.0
                return (a * s / tile + seed, b * s / tile)
            ring0 = ids[0]
            c0 = self.vert(pts[0])
            for k in range(len(ring0)):
                k2 = (k + 1) % len(ring0)
                self.face([c0, ring0[k2], ring0[k]], [(seed, 0), cuv(k2, 0), cuv(k, 0)], m, flat=True)
            ring1 = ids[-1]
            c1 = self.vert(pts[-1])
            for k in range(len(ring1)):
                k2 = (k + 1) % len(ring1)
                self.face([c1, ring1[k], ring1[k2]], [(seed, 0), cuv(k, n - 1), cuv(k2, n - 1)], m, flat=True)
        return ids

    def beam(self, a, b, w, h, m, r=None, tile=1.0, seed=0.0, ref=None, segs=3, taper=None, chamfer=True):
        """A timber from a to b: w across (along ref if given), h the other way, rounded edges, eased ends."""
        a, b = Vector(a), Vector(b)
        L = (b - a).length
        if r is None:
            r = min(w, h) * 0.18
        out = rounded_rect(w, h, r, segs)
        e = min(r * 1.2, L * 0.2) if chamfer else 0.0
        d = (b - a).normalized()
        if e > 0:
            path = [a, a + d * e, b - d * e, b]
            sc = [0.82, 1.0, 1.0, 0.82]
        else:
            path, sc = [a, b], [1.0, 1.0]
        if taper:
            sc = [s * t for s, t in zip(sc, (taper[0], taper[0], taper[1], taper[1]) if e > 0 else taper)]
        return self.sweep(out, path, m, tile=tile, seed=seed, scales=sc, ref=ref)

    def rod(self, a, b, radius, m, segs=8, tile=1.0, caps=True):
        return self.sweep(circle(radius, segs), [a, b], m, tile=tile, caps=caps)

    def tube(self, path, radius, m, segs=10, tile=1.0, caps=True):
        return self.sweep(circle(radius, segs), path, m, tile=tile, caps=caps)

    def lathe(self, profile, center, axis, m, segs=32, tile=1.0, caps=(False, False), seed=0.0):
        """Turns a (radius, height) profile about axis through center. Caps close the first/last ring."""
        ax = Vector(axis).normalized()
        u, v = _frame(ax)
        c = Vector(center)
        P, UV = [], []
        along = [0.0]
        for i in range(1, len(profile)):
            along.append(along[-1] + math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]))
        for i, (rr, hh) in enumerate(profile):
            row, uvr = [], []
            for k in range(segs):
                t = 2 * math.pi * k / segs
                row.append(c + ax * hh + (u * math.cos(t) + v * math.sin(t)) * rr)
                uvr.append((k / segs * 2 * math.pi * max(rr, 0.01) / tile + seed, along[i] / tile))
            uvr.append((2 * math.pi * max(rr, 0.01) / tile + seed, along[i] / tile))
            P.append(row)
            UV.append(uvr)
        ids = self.grid(P, UV, m, closed_u=True, flip=True)
        for which, flip in ((0, False), (len(profile) - 1, True)):
            want = caps[0] if which == 0 else caps[1]
            if want and profile[which][0] > 0:
                ring = ids[which]
                cc = c + ax * profile[which][1]
                rr = profile[which][0]
                cv = self.vert(cc)
                for k in range(segs):
                    k2 = (k + 1) % segs
                    t1, t2 = 2 * math.pi * k / segs, 2 * math.pi * k2 / segs
                    uvs = [(0.5 / tile, 0.5 / tile), (rr * math.cos(t1) / tile, rr * math.sin(t1) / tile),
                           (rr * math.cos(t2) / tile, rr * math.sin(t2) / tile)]
                    tri = [cv, ring[k], ring[k2]]
                    if not flip:
                        tri = [cv, ring[k2], ring[k]]
                        uvs = [uvs[0], uvs[2], uvs[1]]
                    self.face(tri, uvs, m, flat=True)
        return ids

    def box(self, center, size, m, r=0.002, tile=1.0, rot=None, seed=0.0):
        """An axis box (sx, sy, sz) at center with rounded edges along its local Y; rot is a 3x3 Matrix."""
        sx, sy, sz = size
        R = rot or Matrix.Identity(3)
        c = Vector(center)
        a = c - R @ Vector((0, sy / 2, 0))
        b = c + R @ Vector((0, sy / 2, 0))
        return self.beam(a, b, sx, sz, m, r=r, tile=tile, seed=seed, ref=R @ Vector((1, 0, 0)))

    def extrude(self, outline, origin, normal, depth, m, ref=None, tile=1.0, bevel=0.0):
        """A flat 2D outline (in the plane through origin with this normal) given thickness depth along normal."""
        nrm = Vector(normal).normalized()
        if ref is None:
            u, v = _frame(nrm)
        else:
            u = (Vector(ref) - Vector(ref).dot(nrm) * nrm).normalized()
            v = nrm.cross(u)
        o = Vector(origin)
        path = [o - nrm * depth / 2, o + nrm * depth / 2]
        return self.sweep(outline, path, m, tile=tile, ref=u)

    def torus(self, center, axis, R, r, m, segs=24, rsegs=8):
        ax = Vector(axis).normalized()
        u, v = _frame(ax)
        c = Vector(center)
        path = [c + (u * math.cos(2 * math.pi * k / segs) + v * math.sin(2 * math.pi * k / segs)) * R for k in range(segs)]
        return self.sweep(circle(r, rsegs), path, m, closed_path=True, caps=False)

    def merge(self, other, M=None):
        off = len(self.V)
        for p in other.V:
            q = Vector(p)
            if M is not None:
                q = M @ q
            self.V.append((q.x, q.y, q.z))
        for f, uv, uv1, mi, fl in zip(other.F, other.UV, other.UV1, other.M, other.sharp):
            self.F.append(tuple(i + off for i in f))
            self.UV.append(uv)
            self.UV1.append(uv1)
            self.M.append(self.mat(other.mats[mi]))
            self.sharp.append(fl)

    def to_object(self, parent=None, smooth_angle=40.0, uv1=False, collection=None, recalc=True, weld=1e-6):
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(self.V, [], self.F)
        me.update(calc_edges=True)
        n = len(self.F)
        uvl = me.uv_layers.new(name="UVMap")
        flat = [c for uv in self.UV for c in uv]
        uvl.data.foreach_set("uv", np.array(flat, np.float32).ravel())
        if uv1:
            uvl1 = me.uv_layers.new(name="UV1")
            flat1 = [c for uv in self.UV1 for c in uv]
            uvl1.data.foreach_set("uv", np.array(flat1, np.float32).ravel())
        me.uv_layers.active_index = 0
        for mt in self.mats:
            me.materials.append(mt)
        me.polygons.foreach_set("material_index", np.array(self.M, np.int32))
        me.polygons.foreach_set("use_smooth", np.array([not s for s in self.sharp], bool))
        if weld or recalc:
            import bmesh
            bm = bmesh.new()
            bm.from_mesh(me)
            if weld:
                bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=weld)
            bmesh.ops.dissolve_degenerate(bm, dist=1e-7, edges=bm.edges)
            if recalc:
                bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            bm.to_mesh(me)
            bm.free()
        if smooth_angle is not None:
            me.set_sharp_from_angle(angle=math.radians(smooth_angle))
        me.validate(clean_customdata=False)
        ob = bpy.data.objects.new(self.name, me)
        (collection or bpy.context.scene.collection).objects.link(ob)
        if parent is not None:
            ob.parent = parent
        return ob


def empty(name, loc=(0, 0, 0), parent=None, collection=None):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_size = 0.1
    ob.location = loc
    (collection or bpy.context.scene.collection).objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


def tri_count(obs):
    t = 0
    for ob in obs:
        if ob.type == "MESH":
            t += sum(len(p.vertices) - 2 for p in ob.data.polygons)
    return t


# ---------------------------------------------------------------- images (numpy) and materials

def load_pixels(path):
    img = bpy.data.images.load(path, check_existing=False)
    img.colorspace_settings.name = "Non-Color"  # raw bytes as stored; colour maths below works in the file's space
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)


def save_pixels(arr, path, fmt="JPEG", quality=92):
    h, w = arr.shape[:2]
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], axis=2)
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=(fmt == "PNG"), float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.clip(arr, 0, 1).astype(np.float32).ravel())
    s = bpy.context.scene.render.image_settings
    s.file_format = fmt
    s.color_mode = "RGBA" if fmt == "PNG" else "RGB"
    s.color_depth = "8"
    if fmt == "JPEG":
        s.quality = quality
    if fmt == "PNG":
        s.compression = 60
    img.save_render(path, scene=bpy.context.scene)
    bpy.data.images.remove(img)
    return path


def resize(arr, w, h):
    """Box/bilinear resample with numpy (used for LOD texture sizes)."""
    H, W = arr.shape[:2]
    ys = (np.arange(h) + 0.5) * H / h - 0.5
    xs = (np.arange(w) + 0.5) * W / w - 0.5
    y0 = np.clip(np.floor(ys).astype(int), 0, H - 1)
    x0 = np.clip(np.floor(xs).astype(int), 0, W - 1)
    y1 = np.clip(y0 + 1, 0, H - 1)
    x1 = np.clip(x0 + 1, 0, W - 1)
    fy = (ys - np.floor(ys))[:, None, None]
    fx = (xs - np.floor(xs))[None, :, None]
    a = arr[y0][:, x0]
    b = arr[y0][:, x1]
    c = arr[y1][:, x0]
    d = arr[y1][:, x1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(np.asarray(c, np.float32), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def regrade(src_rgb_srgb, target_mean_srgb, keep_contrast=1.0, desat=0.0):
    """Moves an sRGB colour texture to a new mean colour, keeping its grain contrast (all in linear light)."""
    lin = srgb_to_lin(src_rgb_srgb[..., :3])
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    mean_l = float(lum.mean())
    rel = (lum / max(mean_l, 1e-4))[..., None]
    rel = 1.0 + (rel - 1.0) * keep_contrast
    tgt = srgb_to_lin(np.array(target_mean_srgb, np.float32) / 255.0)
    chroma = lin / np.maximum(lum[..., None], 1e-4)
    chroma = chroma * (1 - desat) + desat
    base = tgt[None, None, :] * rel
    tgt_chroma = tgt / max(float(tgt @ np.array([0.2126, 0.7152, 0.0722], np.float32)), 1e-4)
    # keep a little of the source's own colour variation around the target hue
    out = base * (0.85 + 0.15 * chroma / tgt_chroma[None, None, :])
    return lin_to_srgb(out)


_GLTF_GROUP = None


def gltf_output_group():
    """The 'glTF Material Output' node group the Blender glTF exporter reads occlusion (and thickness) from."""
    global _GLTF_GROUP
    if _GLTF_GROUP and _GLTF_GROUP.name in bpy.data.node_groups:
        return _GLTF_GROUP
    g = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    g.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    g.interface.new_socket(name="Thickness", in_out="INPUT", socket_type="NodeSocketFloat")
    g.nodes.new("NodeGroupInput")
    _GLTF_GROUP = g
    return g


def material(name, color=(0.8, 0.8, 0.8, 1.0), rough=0.5, metal=0.0, tex=None, normal_strength=1.0, double=False,
             sheen=None, emission=None):
    """A Principled BSDF material the glTF exporter writes as metallic-roughness PBR.

    tex: dict with optional 'color', 'rough', 'metal', 'normal', 'ao' image paths, and 'uv' (UV map name, default
    UVMap) or per-map uv names 'color_uv', etc. sheen: (r, g, b, roughness)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = not double
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = color
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    tex = tex or {}

    def image_node(key, colorspace):
        path = tex.get(key)
        if not path:
            return None
        img = bpy.data.images.load(path, check_existing=True)
        img.colorspace_settings.name = colorspace
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = img
        uvname = tex.get(key + "_uv", tex.get("uv", "UVMap"))
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = uvname
        nt.links.new(uvn.outputs["UV"], n.inputs["Vector"])
        return n

    c = image_node("color", "sRGB")
    if c:
        if tuple(color[:3]) != (0.8, 0.8, 0.8) and tex.get("tint", False):
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs["Factor"].default_value = 1.0
            nt.links.new(c.outputs["Color"], mix.inputs["A"])
            mix.inputs["B"].default_value = color
            nt.links.new(mix.outputs["Result"], p.inputs["Base Color"])
        else:
            nt.links.new(c.outputs["Color"], p.inputs["Base Color"])
    r = image_node("rough", "Non-Color")
    if r:
        nt.links.new(r.outputs["Color"], p.inputs["Roughness"])
    mt = image_node("metal", "Non-Color")
    if mt:
        nt.links.new(mt.outputs["Color"], p.inputs["Metallic"])
    n = image_node("normal", "Non-Color")
    if n:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.uv_map = tex.get("normal_uv", tex.get("uv", "UVMap"))
        nm.inputs["Strength"].default_value = normal_strength
        nt.links.new(n.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
    ao = image_node("ao", "Non-Color")
    if ao:
        grp = nt.nodes.new("ShaderNodeGroup")
        grp.node_tree = gltf_output_group()
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(ao.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Red"], grp.inputs["Occlusion"])
    if sheen:
        p.inputs["Sheen Weight"].default_value = 1.0
        p.inputs["Sheen Tint"].default_value = (sheen[0], sheen[1], sheen[2], 1.0)
        p.inputs["Sheen Roughness"].default_value = sheen[3]
    if emission:
        p.inputs["Emission Color"].default_value = emission[:3] + (1.0,)
        p.inputs["Emission Strength"].default_value = emission[3]
    return m


# ---------------------------------------------------------------- export and GLB post-processing

def export_glb(path, objects=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kw = dict(filepath=path, export_format="GLB", export_yup=True, export_apply=True, export_texcoords=True,
              export_normals=True, export_tangents=True, export_materials="EXPORT", export_cameras=False,
              export_lights=False, export_extras=True, export_morph=True, export_morph_normal=True,
              export_animations=False, export_skins=False, use_selection=objects is not None,
              export_draco_mesh_compression_enable=False, export_image_format="AUTO",
              export_copyright="Margo engine, CC0 textures credited in LABEL.md")
    if objects is not None:
        bpy.ops.object.select_all(action="DESELECT")
        for ob in objects:
            ob.select_set(True)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError:
        kw.pop("export_morph_normal", None)
        bpy.ops.export_scene.gltf(**kw)
    return path


def _read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, ver, total = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "not a GLB"
    off = 12
    js = None
    binc = b""
    while off < total:
        ln, typ = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + ln]
        if typ == 0x4E4F534A:
            js = json.loads(chunk.decode("utf-8"))
        elif typ == 0x004E4942:
            binc = chunk
        off += 8 + ln
    return js, bytearray(binc)


def _write_glb(path, js, binc):
    j = json.dumps(js, separators=(",", ":")).encode("utf-8")
    j += b" " * ((4 - len(j) % 4) % 4)
    while len(binc) % 4:
        binc.append(0)
    js["buffers"][0]["byteLength"] = len(binc)
    j = json.dumps(js, separators=(",", ":")).encode("utf-8")
    j += b" " * ((4 - len(j) % 4) % 4)
    total = 12 + 8 + len(j) + 8 + len(binc)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(j), 0x4E4F534A))
        f.write(j)
        f.write(struct.pack("<II", len(binc), 0x004E4942))
        f.write(bytes(binc))


def add_diffuse_transmission(path, material_names, factor, color, texture_path=None, texcoord=1):
    """Adds KHR_materials_diffuse_transmission to the named materials of a GLB, with an optional RGBA texture whose
    alpha is the transmitted share and RGB its colour (used for both the factor and the colour texture slots).
    Blender's exporter has no input for it, so the build writes it here; the engine's glTF PBR loader reads it."""
    js, binc = _read_glb(path)
    tex_index = None
    if texture_path:
        with open(texture_path, "rb") as f:
            img = f.read()
        while len(binc) % 8:
            binc.append(0)
        start = len(binc)
        binc.extend(img)
        js.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": start, "byteLength": len(img)})
        mime = "image/png" if texture_path.lower().endswith(".png") else "image/jpeg"
        js.setdefault("images", []).append({"bufferView": len(js["bufferViews"]) - 1, "mimeType": mime,
                                            "name": os.path.splitext(os.path.basename(texture_path))[0]})
        sampler = 0 if js.get("samplers") else None
        if sampler is None:
            js["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
            sampler = 0
        js.setdefault("textures", []).append({"sampler": sampler, "source": len(js["images"]) - 1})
        tex_index = len(js["textures"]) - 1
    hit = 0
    for m in js.get("materials", []):
        if m.get("name") in material_names:
            ext = {"diffuseTransmissionFactor": factor, "diffuseTransmissionColorFactor": list(color)}
            if tex_index is not None:
                ext["diffuseTransmissionTexture"] = {"index": tex_index, "texCoord": texcoord}
                ext["diffuseTransmissionColorTexture"] = {"index": tex_index, "texCoord": texcoord}
            m.setdefault("extensions", {})["KHR_materials_diffuse_transmission"] = ext
            hit += 1
    if hit != len(material_names):
        raise SystemExit(f"add_diffuse_transmission: found {hit} of {material_names}")
    used = js.setdefault("extensionsUsed", [])
    if "KHR_materials_diffuse_transmission" not in used:
        used.append("KHR_materials_diffuse_transmission")
    _write_glb(path, js, binc)


def glb_summary(path):
    js, binc = _read_glb(path)
    return {
        "bytes": os.path.getsize(path),
        "nodes": [n.get("name") for n in js.get("nodes", [])],
        "materials": [m.get("name") for m in js.get("materials", [])],
        "images": len(js.get("images", [])),
        "meshes": len(js.get("meshes", [])),
        "extensionsUsed": js.get("extensionsUsed", []),
    }


# ---------------------------------------------------------------- previews (EEVEE, for the builder's own checks)

def preview_setup(sun_dir=(0.4, -0.6, 0.55), strength=4.0):
    s = bpy.context.scene
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            s.render.engine = eng
            break
        except TypeError:
            continue
    s.render.resolution_x = 1920
    s.render.resolution_y = 1080
    s.render.film_transparent = False
    s.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in s.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"
    w = bpy.data.worlds.new("preview sky")
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.55, 0.62, 0.72, 1)
    bg.inputs["Strength"].default_value = 0.9
    s.world = w
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = strength
    sun.angle = math.radians(1.0)
    so = bpy.data.objects.new("sun", sun)
    s.collection.objects.link(so)
    d = Vector(sun_dir).normalized()
    so.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    ground = bpy.data.meshes.new("ground")
    ground.from_pydata([(-60, -60, -0.001), (60, -60, -0.001), (60, 60, -0.001), (-60, 60, -0.001)], [], [(0, 1, 2, 3)])
    gm = bpy.data.materials.new("sand")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.47, 0.36, 1)
    gm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.95
    ground.materials.append(gm)
    go = bpy.data.objects.new("preview ground", ground)
    s.collection.objects.link(go)
    return [so, go]


def preview_render(path, eye, target, lens=50):
    s = bpy.context.scene
    cam_data = bpy.data.cameras.new("preview cam")
    cam_data.lens = lens
    cam_data.clip_start = 0.02
    cam = bpy.data.objects.new("preview cam", cam_data)
    s.collection.objects.link(cam)
    cam.location = eye
    cam.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()
    s.camera = cam
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    return path
