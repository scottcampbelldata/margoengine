# What OpenUSD's public UsdSkel API says a skinned stage looks like: blender --python skel-truth.py -- out.json file...
# Per mesh: rest points, then world points at several times, blend shapes then skin, through UsdSkel.Cache.
import sys, json
from pxr import Usd, UsdGeom, UsdSkel, Vt, Gf
argv = sys.argv[sys.argv.index('--') + 1:]
out = {}
for f in argv[1:]:
    try:
        s = Usd.Stage.Open(f, Usd.Stage.LoadAll)
        start, end = s.GetStartTimeCode(), s.GetEndTimeCode()
        times = sorted(set([start, start + (end - start) * 0.31, start + (end - start) * 0.5, start + (end - start) * 0.77, end]))
        meters = UsdGeom.GetStageMetersPerUnit(s)
        cache = UsdSkel.Cache()
        res = {'tcps': s.GetTimeCodesPerSecond(), 'start': start, 'end': end, 'times': times, 'meters': meters, 'up': str(UsdGeom.GetStageUpAxis(s)), 'meshes': {}}
        roots = [p for p in s.Traverse() if p.IsA(UsdSkel.Root)]
        for prim in roots:
            root = UsdSkel.Root(prim)
            cache.Populate(root, Usd.PrimDefaultPredicate)
            for binding in cache.ComputeSkelBindings(root, Usd.PrimDefaultPredicate):
                skel = binding.GetSkeleton()
                sq = cache.GetSkelQuery(skel)
                xc = UsdGeom.XformCache()
                for query in binding.GetSkinningTargets():
                    mesh = UsdGeom.Mesh(query.GetPrim())
                    if not mesh:
                        continue
                    rest = mesh.GetPointsAttr().Get(Usd.TimeCode.Default()) or mesh.GetPointsAttr().Get(start)
                    frames = []
                    for t in times:
                        tc = Usd.TimeCode(t)
                        pts = Vt.Vec3fArray(mesh.GetPointsAttr().Get(tc))
                        if query.HasBlendShapes():
                            weights = sq.GetAnimQuery().ComputeBlendShapeWeights(tc) if sq.GetAnimQuery() else None
                            if weights is not None:
                                mapped = query.GetBlendShapeMapper().Remap(weights) if query.GetBlendShapeMapper() else weights
                                bq = UsdSkel.BlendShapeQuery(UsdSkel.BindingAPI(query.GetPrim()))
                                sub = bq.ComputeSubShapeWeights(mapped)
                                bq.ComputeDeformedPoints(sub[0], sub[1], sub[2], bq.ComputeBlendShapePointIndices(), bq.ComputeSubShapePointOffsets(), pts)
                        xforms = sq.ComputeSkinningTransforms(tc)
                        query.ComputeSkinnedPoints(xforms, pts, tc)
                        xc.SetTime(tc)
                        world = xc.GetLocalToWorldTransform(skel.GetPrim())
                        frames.append([list(world.Transform(Gf.Vec3d(p))) for p in pts])
                    res['meshes'][str(query.GetPrim().GetPath())] = {'rest': [list(p) for p in rest], 'frames': frames}
        out[f] = res
    except Exception as e:
        out[f] = {'error': str(e)}
json.dump(out, open(argv[0], 'w'))
print('SKELTRUTH', len(out))
