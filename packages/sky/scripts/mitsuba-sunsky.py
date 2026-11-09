"""Black-box sunsky eval through Mitsuba 3's public Python API. No renderer source."""
import json
from pathlib import Path
import sys
import mitsuba as mi

mi.set_variant('scalar_rgb')
cases = json.loads(Path(sys.argv[1]).read_text())
rows = []
for case in cases:
    z_up = lambda v: [v[0], v[2], v[1]]
    emitter = mi.load_dict({'type': 'sunsky', 'sun_direction': z_up(case['sun']),
                            'turbidity': float(case['turbidity']), 'albedo': 0.0, 'sun_scale': 0.0})
    values = []
    for direction in case['directions']:
        si = mi.SurfaceInteraction3f()
        si.wi = mi.Vector3f(*[-v for v in z_up(direction)])
        values.append([float(v) for v in emitter.eval(si)])
    rows.append(values)
Path(sys.argv[2]).write_text(json.dumps({'version': mi.__version__, 'variant': mi.variant(), 'radiance': rows}))
