# What OpenUSD's public API says of lights and cameras, inside Blender's Python:
# blender --background --factory-startup --python lux-truth.py -- cases.usda openusd.json blackbody.json
import sys, json
from pxr import Usd, UsdGeom, UsdLux, Gf
argv = sys.argv[sys.argv.index('--') + 1:]
s = Usd.Stage.Open(argv[0])
t = Usd.TimeCode.EarliestTime()
cache = UsdGeom.XformCache(t)
def m(x): return [x[r][c] for r in range(4) for c in range(4)]
out = {}
for p in Usd.PrimRange.Stage(s):
    if p.GetTypeName() == 'Camera':
        c = UsdGeom.Camera(p).GetCamera(t)
        r = c.frustum.GetNearFar()
        out[str(p.GetPath())] = {'world': m(cache.GetLocalToWorldTransform(p)), 'vfov': c.GetFieldOfView(Gf.Camera.FOVVertical), 'aspect': c.aspectRatio, 'near': r.GetMin(), 'far': r.GetMax()}
    elif p.HasAPI(UsdLux.LightAPI) or p.IsA(UsdLux.BoundableLightBase) or p.IsA(UsdLux.NonboundableLightBase):
        out[str(p.GetPath())] = {'world': m(cache.GetLocalToWorldTransform(p))}
json.dump(out, open(argv[1], 'w'), indent=0)
json.dump({str(k): list(UsdLux.BlackbodyTemperatureAsRgb(k)) for k in (1000, 1667, 2000, 2222, 3000, 4000, 5000, 6500, 8000, 10000)}, open(argv[2], 'w'), indent=0)
print('LUX TRUTH', len(out))
