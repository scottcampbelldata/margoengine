"""Black-box schema oracle; uses installed OpenUSD, never its source."""
import sys, json
from pxr import Usd, UsdGeom
s = Usd.Stage.Open(sys.argv[1])
p = UsdGeom.PointInstancer(s.GetPrimAtPath('/Scatter'))
out = {}
for t in [0, 6, 12, 24, 36]:
    transforms = p.ComputeInstanceTransformsAtTime(t, t)
    out[str(t)] = [[float(m[r][c]) for r in range(4) for c in range(4)] for m in transforms]
json.dump(out, open(sys.argv[2], 'w'), indent=2)
