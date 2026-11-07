# Every prim whose transform or visibility moves, through OpenUSD's public API: blender --python truth.py -- list out.json
import sys, json, time
from pxr import Usd, UsdGeom, Gf
argv = sys.argv[sys.argv.index('--') + 1:]
out = {}
for line in open(argv[0], encoding='utf8'):
    f = line.strip()
    if not f: continue
    print('FILE', f, flush=True)
    try:
        s = Usd.Stage.Open(f, Usd.Stage.LoadAll)
        prims = {}
        moving = []
        codes = set()
        for p in Usd.PrimRange.Stage(s, Usd.TraverseInstanceProxies()):
            if not p.IsA(UsdGeom.Imageable): continue
            x = UsdGeom.Xformable(p)
            vis = UsdGeom.Imageable(p).GetVisibilityAttr()
            vt = vis.GetTimeSamples() if vis else []
            if (x and x.TransformMightBeTimeVarying()) or len(vt) > 1:
                moving.append(p)
                if x:
                    for op in x.GetOrderedXformOps():
                        codes.update(op.GetTimeSamples())
                codes.update(vt)
        if not moving:
            continue
        codes = sorted(codes)
        lo, hi = codes[0], codes[-1]
        times = sorted(set([lo, hi, lo + (hi - lo) * 0.31, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.77, codes[len(codes) // 2], round(lo + (hi - lo) * 0.4)]))
        if hi - lo <= 20:
            times = sorted(set(times + [lo + i * 0.5 for i in range(int((hi - lo) * 2) + 1)]))
        caches = [UsdGeom.XformCache(Usd.TimeCode(t)) for t in times]
        for p in moving[:400]:
            img = UsdGeom.Imageable(p)
            prims[str(p.GetPath())] = {
                'world': [[v for r in c.GetLocalToWorldTransform(p) for v in r] for c in caches],
                'visible': [str(img.ComputeVisibility(Usd.TimeCode(t))) != 'invisible' for t in times],
            }
        out[f] = {'tcps': s.GetTimeCodesPerSecond(), 'start': s.GetStartTimeCode() if s.HasAuthoredTimeCodeRange() else None, 'first': lo, 'times': times, 'count': len(moving), 'prims': prims}
    except Exception as e:
        out[f] = {'error': str(e)[:300]}
    json.dump(out, open(argv[1], 'w'))
print('ANIMTRUTH', len(out))
