"""Value types through OpenUSD public APIs: a text layer of one attribute per type, exported as Crate.

Writes fixtures/crate-types/types.usda, types.usdc and types.json (the values Sdf reads back). usd-core 26.11.
"""
import json, pathlib
from pxr import Sdf, Usd, Gf, Vt
out = pathlib.Path(__file__).parent.parent / 'fixtures' / 'crate-types'
txt = '''#usda 1.0
def "A" {
    int64 i64 = -5
    int64 i64b = -5000000000
    uint64 u64b = 4000000000
    int64 i64c = 2000000000
    half2 v2hb = (0.5, -1.25)
    half3 v3h = (1, 2, 3)
    float2 v2f = (0.5, 2)
    int2 v2i = (100, -100)
    uint64 u64 = 7
    uint u = 4000000000
    uchar uc = 200
    int i = -3
    half h = 0.5
    float f = 0.25
    double d = 0.1
    double d2 = 3
    timecode tc = 0.5
    timecode tc2 = 0.1
    matrix4d m = ( (2, 0, 0, 0), (0, 3, 0, 0), (0, 0, 4, 0), (0, 0, 0, 1) )
    matrix2d m2 = ( (1, 2), (3, 4) )
    quatf q = (0.5, 0.1, 0.2, 0.3)
    quatd qd = (1, 0, 0, 0)
    int3 v3i = (1, -2, 3)
    float3 v3f = (1, 2, 3)
    double3 v3d = (0.5, 1.5, 2.5)
    half2 v2h = (1, 2)
    int[] ia = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, -100000, 5]
    float[] fa = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5]
    double[] da = [0.1, 0.2, 0.3]
    half[] ha = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2]
    int64[] i64a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, -9000000000]
    quatf[] qa = [(1, 0, 0, 0), (0.5, 0.5, 0.5, 0.5)]
    string[] sa = ["x", "y"]
    token[] ta = ["p", "q"]
    asset[] aa = [@a.png@, @b.png@]
    bool b = 1
    bool[] ba = [1, 0, 1]
    string s = "hi"
    token t = "tok"
    asset a = @tex.png@
    double2[] d2a = [(1, 2), (3, 4)]
    matrix3d m3 = ( (1, 0, 0), (0, 1, 0), (0, 0, 1) )
}
'''
open(out / 'types.usda', 'w', newline='\n').write(txt)
l = Sdf.Layer.FindOrOpen(str(out / 'types.usda'))
o = Sdf.Layer.CreateAnonymous('.usdc'); o.TransferContent(l); o.Export(str(out / 'types.usdc'))
def conv(v):
    if isinstance(v, (Gf.Quatf, Gf.Quatd, Gf.Quath)): return [v.GetReal(), *v.GetImaginary()]
    if isinstance(v, (Gf.Matrix4d, Gf.Matrix3d, Gf.Matrix2d)): return [x for row in v for x in row]
    if isinstance(v, Sdf.AssetPath): return v.path
    if isinstance(v, Sdf.TimeCode): return float(v)
    if hasattr(v, '__len__') and not isinstance(v, str):
        out = []
        for e in v:
            c = conv(e); out.extend(c) if isinstance(c, list) else out.append(c)
        return out
    if isinstance(v, bool): return v
    return v
res = {}
for prop in l.GetPrimAtPath('/A').properties:
    res[prop.name] = conv(prop.default)
json.dump(res, open(out / 'types.json','w'))
