"""Schema defaults and extents through OpenUSD 26.11's public API only."""
from pxr import Usd, UsdGeom
import json, sys
s = Usd.Stage.CreateInMemory()
types = [UsdGeom.Cube, UsdGeom.Sphere, UsdGeom.Cylinder, UsdGeom.Capsule, UsdGeom.Cone]
out = {}
for schema in types:
    for axis in ['X', 'Y', 'Z'] if schema not in [UsdGeom.Cube, UsdGeom.Sphere] else ['Z']:
        for custom in [False, True]:
            name = schema.__name__ + axis + str(int(custom))
            g = schema.Define(s, '/' + name)
            if schema not in [UsdGeom.Cube, UsdGeom.Sphere]:
                g.GetAxisAttr().Set(axis)
            if custom:
                if schema == UsdGeom.Cube: g.GetSizeAttr().Set(3.0)
                else: g.GetRadiusAttr().Set(1.25)
                if schema not in [UsdGeom.Cube, UsdGeom.Sphere]: g.GetHeightAttr().Set(3.5)
            extent = UsdGeom.Boundable.ComputeExtentFromPlugins(g, Usd.TimeCode.Default())
            out['/' + name] = [list(v) for v in extent]
s.GetRootLayer().Export(sys.argv[1])
json.dump(out, open(sys.argv[2], 'w'), indent=2)
