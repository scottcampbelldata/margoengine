# What OpenUSD itself answers for a real stage: every transformable prim's world matrix at the default time, whether it
# resets the transform stack, its visibility and purpose, and the world positions of the points its faces use. The
# answers are recorded in ../real-files/manifest.json, which scripts/test-real-reset.mjs compares the reader against.
# Run with the usd-core package, in isolated mode because the stage is an outside file:
#   python -I packages/usdz/tests/oracle/real-reset-truth.py <stage.usda> <out.json>
import json
import sys

from pxr import Gf, Usd, UsdGeom

stage = Usd.Stage.Open(sys.argv[1])
cache = UsdGeom.XformCache(Usd.TimeCode.Default())
out = {'version': '.'.join(map(str, Usd.GetVersion())), 'prims': {}, 'resets': []}
for prim in Usd.PrimRange(stage.GetPseudoRoot(), Usd.TraverseInstanceProxies()):
    x = UsdGeom.Xformable(prim)
    if not x:
        continue
    path = str(prim.GetPath())
    m = cache.GetLocalToWorldTransform(prim)
    image = UsdGeom.Imageable(prim)
    entry = {
        # USD matrices act on row vectors, so reading them row by row gives glTF's column-major order.
        'world': [m[r][c] for r in range(4) for c in range(4)],
        'visible': image.ComputeVisibility() != 'invisible',
        'purpose': str(image.ComputePurpose()),
    }
    if x.GetResetXformStack():
        out['resets'].append(path)
    if prim.IsA(UsdGeom.Mesh):
        mesh = UsdGeom.Mesh(prim)
        points = mesh.GetPointsAttr().Get()
        used = sorted(set(mesh.GetFaceVertexIndicesAttr().Get()))
        entry['points'] = [list(m.Transform(Gf.Vec3d(points[i]))) for i in used]
    out['prims'][path] = entry
with open(sys.argv[2], 'w') as file:
    json.dump(out, file)
print(out['version'], len(out['prims']), 'prims,', len(out['resets']), 'reset')
