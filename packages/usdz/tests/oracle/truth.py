# Runs inside Blender's Python, which carries OpenUSD: blender --background --factory-startup --python truth.py -- list out.json
# Writes what OpenUSD reads from each root layer: composed prims, properties, drawn meshes with world bounds.
import sys, json, os, time
from pxr import Usd, UsdGeom, UsdShade, Sdf, Gf, Tf
argv = sys.argv[sys.argv.index('--') + 1:]
listfile, outfile = argv[0], argv[1]
mode = argv[2] if len(argv) > 2 else 'mesh'
out = {}
def jsonable(v):
    if v is None or isinstance(v, (bool, int, str)): return v
    if isinstance(v, float): return v if v == v and abs(v) != float('inf') else None
    if isinstance(v, Sdf.AssetPath): return v.path
    if isinstance(v, (list, tuple)): return [jsonable(x) for x in v]
    if isinstance(v, Sdf.Path): return str(v)
    try:
        return [jsonable(x) for x in list(v)]
    except Exception:
        return str(v)
for line in open(listfile, encoding='utf8'):
    f = line.strip()
    if not f: continue
    rec = {}
    t0 = time.time()
    try:
        stage = Usd.Stage.Open(f, Usd.Stage.LoadAll)
        rec['upAxis'] = UsdGeom.GetStageUpAxis(stage)
        rec['metersPerUnit'] = UsdGeom.GetStageMetersPerUnit(stage)
        T = Usd.TimeCode.EarliestTime()
        cache = UsdGeom.XformCache(T)
        prims = {}
        meshes = {}
        counts = {}
        for p in Usd.PrimRange.Stage(stage, Usd.TraverseInstanceProxies()):
            ty = str(p.GetTypeName())
            counts[ty] = counts.get(ty, 0) + 1
            path = str(p.GetPath())
            if mode == 'prims':
                props = {}
                for a in p.GetAuthoredAttributes():
                    ts = a.GetTimeSamples()
                    e = {}
                    if ts: e['times'] = list(ts)
                    if a.HasAuthoredConnections() if hasattr(a, 'HasAuthoredConnections') else False: e['conn'] = [str(x) for x in a.GetConnections()]
                    v = a.Get() if a.HasAuthoredValue() else None
                    if a.GetTypeName().type.typeName in ('SdfAssetPath',) and v is not None: v = None
                    if v is not None and a.GetTypeName().isArray and len(v) > 4: e['len'] = len(v)
                    else: e['v'] = jsonable(v)
                    props[a.GetName()] = e
                for r in p.GetAuthoredRelationships():
                    props[r.GetName()] = {'t': [str(x) for x in r.GetTargets()]}
                prims[path] = {'type': ty, 'props': props}
            if mode != 'prims' and p.IsA(UsdGeom.Mesh):
                im = UsdGeom.Imageable(p)
                if im.ComputeVisibility(T) == 'invisible': continue
                purpose = im.ComputePurpose()
                if purpose in ('guide', 'proxy'): continue
                m = UsdGeom.Mesh(p)
                pts = m.GetPointsAttr().Get(T)
                if pts is None or len(pts) == 0: continue
                fc = m.GetFaceVertexCountsAttr().Get(T) or []
                M = cache.GetLocalToWorldTransform(p)
                lo = [1e300] * 3; hi = [-1e300] * 3
                used = set(m.GetFaceVertexIndicesAttr().Get(T) or [])
                for qi in used:
                    if qi >= len(pts): continue
                    w = M.Transform(Gf.Vec3d(pts[qi]))
                    for i in range(3):
                        if w[i] < lo[i]: lo[i] = w[i]
                        if w[i] > hi[i]: hi[i] = w[i]
                b, rel = UsdShade.MaterialBindingAPI(p).ComputeBoundMaterial()
                meshes[path] = {'points': len(pts), 'faces': len(fc), 'tris': sum(c - 2 for c in fc if c >= 3), 'lo': lo, 'hi': hi,
                                'scheme': m.GetSubdivisionSchemeAttr().Get(), 'material': str(b.GetPath()) if b else None}
        rec['counts'] = counts
        rec['meshes'] = meshes
        if mode == 'prims': rec['prims'] = prims
    except Exception as e:
        rec['error'] = str(e)[:300]
    rec['seconds'] = round(time.time() - t0, 2)
    out[f] = rec
json.dump(out, open(outfile, 'w', encoding='utf8'))
print('TRUTH', len(out))
