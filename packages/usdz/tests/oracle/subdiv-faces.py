# Stand-in face-varying cases and Blender's refined corners for every linear interpolation mode.
# blender --background --factory-startup --python cases.py -- out.usda truth.json levels
import sys, json, math, random
import bpy
from pxr import Usd, UsdGeom, Sdf, Vt, Gf
argv = sys.argv[sys.argv.index('--') + 1:]
usda, truthPath, levels = argv[0], argv[1], [int(x) for x in argv[2].split(',')]
MODES = {'none': 'SMOOTH_ALL', 'cornersOnly': 'PRESERVE_CORNERS', 'cornersPlus1': 'PRESERVE_CORNERS_AND_JUNCTIONS', 'cornersPlus2': 'PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE', 'boundaries': 'PRESERVE_BOUNDARIES', 'all': 'NONE'}
rng = random.Random(7)

def torus(nu, nv, R=2.0, r=0.8):
    pts = []
    for i in range(nu):
        for j in range(nv):
            a, b = 2 * math.pi * i / nu, 2 * math.pi * j / nv
            pts.append(((R + r * math.cos(b)) * math.cos(a) + 0.03 * math.sin(3 * j + i), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
    f = []; cell = []
    for i in range(nu):
        for j in range(nv):
            f.append([i * nv + j, ((i + 1) % nu) * nv + j, ((i + 1) % nu) * nv + (j + 1) % nv, i * nv + (j + 1) % nv]); cell.append((i, j))
    return pts, f, cell

def grid(n):
    pts = [(x + 0.11 * math.sin(3 * y), y + 0.07 * math.cos(2 * x), 0.2 * math.sin(x + 2 * y)) for y in range(n + 1) for x in range(n + 1)]
    f = []; cell = []
    for y in range(n):
        for x in range(n):
            a = y * (n + 1) + x
            f.append([a, a + 1, a + n + 2, a + n + 1]); cell.append((x, y))
    return pts, f, cell

def fan(n):
    # A centre of valence n, a ring, and an outer ring: n quads at the centre.
    pts = [(0, 0, 0.3)]
    for i in range(2 * n):
        a = math.pi * i / n; r = 1.0 if i % 2 == 0 else 1.1
        pts.append((r * math.cos(a), r * math.sin(a), 0.1 * math.sin(i)))
    f = []; cell = []
    for i in range(n):
        f.append([0, 1 + 2 * i, 2 + 2 * i, 1 + (2 * i + 2) % (2 * n)]); cell.append((i, 0))
    k = len(pts)
    for i in range(2 * n):
        a = math.pi * i / n
        pts.append((2.2 * math.cos(a), 2.2 * math.sin(a), 0.2 * math.cos(i)))
    for i in range(2 * n):
        f.append([1 + i, k + i, k + (i + 1) % (2 * n), 1 + (i + 1) % (2 * n)]); cell.append((i, 1))
    return pts, f, cell

def cubeSphere():
    # A cube with each side split in four: valence 3 at the cube's corners.
    n = 2; pts = []; idx = {}; f = []; cell = []
    def p(v):
        if v not in idx: idx[v] = len(pts); pts.append(tuple(x / n * 2 - 1 for x in v))
        return idx[v]
    for axis in range(3):
        for side in (0, n):
            for a in range(n):
                for b in range(n):
                    q = []
                    for da, db in ((0, 0), (1, 0), (1, 1), (0, 1)):
                        v = [0, 0, 0]; v[axis] = side; v[(axis + 1) % 3] = a + da; v[(axis + 2) % 3] = b + db
                        q.append(p(tuple(v)))
                    if side == 0: q.reverse()
                    f.append(q); cell.append((axis * 2 + (side > 0), 0))
    return pts, f, cell

def torusUV(nu, nv):
    # Unwrapped by angle, so every face keeps one winding: Blender splits values whose faces turn opposite ways.
    return [[(i + a, j + b) for a, b in ((0, 0), (1, 0), (1, 1), (0, 1))] for i in range(nu) for j in range(nv)]

def uvs(pts, f, region, slit=None, param=None):
    # One value per corner: a smooth function of the point, moved per region, so a seam is where regions meet.
    st = []
    for fi, face in enumerate(f):
        r = region[fi]
        for v in face:
            x, y, z = pts[v]
            if param:
                a, b = param[fi][face.index(v)]
                st.append((0.1 * a + 0.01 * math.sin(a + 2 * b) + 0.37 * r, 0.12 * b + 0.01 * math.cos(2 * a) + 0.19 * r)); continue
            u = 0.31 * x + 0.17 * z + 0.05 * math.sin(2 * y); w = 0.23 * y - 0.13 * z + 0.04 * math.cos(3 * x)
            k = slit(fi, v) if slit else None
            if k is not None: st.append((u + k, w + k * 0.5))
            else: st.append((u + 0.37 * r, w + 0.19 * r))
    return st

cases = {}
p, f, c = torus(10, 8)
cases['Blocks'] = dict(pts=p, f=f, param=torusUV(10, 8), region=[(i // 3) + 4 * (j // 3) for i, j in c])
cases['Random'] = dict(pts=p, f=f, param=torusUV(10, 8), region=[rng.randrange(3) for _ in c])
p, f, c = grid(7)
cases['Open'] = dict(pts=p, f=f, region=[(x // 3) + 3 * (y // 2) for x, y in c])
cases['L'] = dict(pts=p, f=f, region=[0 if (x < 4 and y < 4 and not (x >= 2 and y >= 2)) else 1 for x, y in c])
p6, f6, c6 = grid(6)
# A slit: the row below a line from the edge to the middle takes values apart by how far from the tip they are.
def slit(fi, v):
    x, y = c6[fi]; vy, vx = divmod(v, 7)
    d = max(0, 3 - vx)
    if vy == 3 and y < 3 and d: return 0.2 * d
    return None
cases['Slit'] = dict(pts=p6, f=f6, region=[0] * len(f6), slit=slit)
for n in (3, 5, 6):
    p, f, c = fan(n)
    cases['Fan%dA' % n] = dict(pts=p, f=f, region=[(1 if i == 0 else 0) if j == 0 else 0 for i, j in c])
    cases['Fan%dB' % n] = dict(pts=p, f=f, region=[(1 if i < 2 else 0) if j == 0 else 0 for i, j in c])
    cases['Fan%dC' % n] = dict(pts=p, f=f, region=[(1 + i % 3) if j == 0 else 0 for i, j in c])
# Two regions around one point, by how many faces each holds; seams run straight out to the mesh's edge.
for a, b in ((1, 1), (1, 2), (2, 2), (1, 3), (2, 3), (2, 4), (3, 3), (2, 5), (3, 4), (1, 5)):
    n = a + b
    p, f, c = fan(n)
    cases['W%d%d' % (a, b)] = dict(pts=p, f=f, region=[1 if (i if j == 0 else i // 2) < a else 0 for i, j in c])
p, f, c = cubeSphere()
cases['Cube'] = dict(pts=p, f=f, region=[a // 2 for a, _ in c])
cases['Sides'] = dict(pts=p, f=f, region=[a for a, _ in c])
p, f, c = torus(8, 6)
cases['Creased'] = dict(pts=p, f=f, param=torusUV(8, 6), region=[(i // 4) for i, j in c], crease=([[(i % 8) * 6 + 2 for i in range(9)], [(3 * 6 + j % 6) for j in range(7)]], [1.5, 10.0]))
cases['Crossed'] = dict(pts=p, f=f, param=torusUV(8, 6), region=[(j // 3) for i, j in c], crease=([[(4 * 6 + j % 6) for j in range(7)]], [10.0]), corner=([4 * 6 + 1], [10.0]))
# Mixed faces: a triangle and quads in an open patch.
p = [(0, 0, 0), (1, 0, 0.1), (2, 0, 0), (0, 1, 0.2), (1, 1, 0), (2, 1, 0.3), (3, 0.5, 0), (0, 2, 0), (1, 2, 0.1), (2, 2, 0)]
f = [[0, 1, 4, 3], [1, 2, 5, 4], [2, 6, 5], [3, 4, 8, 7], [4, 5, 9, 8]]
cases['Mixed'] = dict(pts=p, f=f, region=[0, 1, 1, 0, 2])

stage = Usd.Stage.CreateNew(usda)
root = UsdGeom.Xform.Define(stage, '/Cases'); stage.SetDefaultPrim(root.GetPrim())
truth = {}
for name, k in cases.items():
    pts, f = k['pts'], k['f']
    st = uvs(pts, f, k['region'], k.get('slit'), k.get('param'))
    # Corners that hold the same value at the same point share an index, as the authoring tool's seams say.
    table = {}; values = []; ids = []; at = 0
    for face in f:
        for v in face:
            key = (v, round(st[at][0], 9), round(st[at][1], 9))
            if key not in table: table[key] = len(values); values.append(st[at])
            ids.append(table[key]); at += 1
    m = UsdGeom.Mesh.Define(stage, '/Cases/' + name)
    m.CreatePointsAttr([Gf.Vec3f(*q) for q in pts]); m.CreateFaceVertexCountsAttr([len(q) for q in f]); m.CreateFaceVertexIndicesAttr([i for q in f for i in q])
    pv = UsdGeom.PrimvarsAPI(m.GetPrim()).CreatePrimvar('st', Sdf.ValueTypeNames.TexCoord2fArray, 'faceVarying')
    pv.Set([Gf.Vec2f(*q) for q in values]); pv.SetIndices(Vt.IntArray(ids))
    ci = []; cl = []; cs = []
    if 'crease' in k:
        for line, s in zip(*k['crease']):
            ci += line; cl.append(len(line)); cs.append(s)
        m.CreateCreaseIndicesAttr(ci); m.CreateCreaseLengthsAttr(cl); m.CreateCreaseSharpnessesAttr(cs)
    if 'corner' in k:
        m.CreateCornerIndicesAttr(k['corner'][0]); m.CreateCornerSharpnessesAttr(k['corner'][1])
    rec = {}
    for mode, smooth in MODES.items():
        for lv in levels:
            me = bpy.data.meshes.new('m'); me.from_pydata([tuple(q) for q in pts], [], f); me.update(calc_edges=True)
            uv = me.uv_layers.new(name='st')
            for i, l in enumerate(uv.data): l.uv = st[i]
            if ci:
                attr = me.attributes.new('crease_edge', 'FLOAT', 'EDGE'); look = {tuple(sorted(e.vertices)): e.index for e in me.edges}; at = 0
                for n, s in zip(cl, cs):
                    for i in range(n - 1):
                        e = look.get(tuple(sorted((ci[at + i], ci[at + i + 1]))))
                        if e is not None: attr.data[e].value = min(1.0, s / 10.0) ** 0.5
                    at += n
            if 'corner' in k:
                attr = me.attributes.new('crease_vert', 'FLOAT', 'POINT')
                for v, s in zip(*k['corner']): attr.data[v].value = min(1.0, s / 10.0) ** 0.5
            ob = bpy.data.objects.new('o', me); bpy.context.collection.objects.link(ob)
            mod = ob.modifiers.new('s', 'SUBSURF'); mod.levels = lv; mod.use_limit_surface = False; mod.use_creases = True
            mod.boundary_smooth = 'PRESERVE_CORNERS'; mod.uv_smooth = smooth
            ev = ob.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
            lay = ev.uv_layers[0].data
            rec[mode + ':' + str(lv)] = [[round(q, 6) for q in ev.vertices[l.vertex_index].co] + [round(lay[i].uv[0], 6), round(lay[i].uv[1], 6)] for i, l in enumerate(ev.loops)]
            bpy.data.objects.remove(ob); bpy.data.meshes.remove(me)
    truth[name] = rec
stage.GetRootLayer().Save()
json.dump(truth, open(truthPath, 'w'))
print('FVCASES', len(truth))
