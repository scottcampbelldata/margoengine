"""Black-box probe of Blender's ELASTIC key interpolation (KB5339c): two keys, sampled at sub-frames by fcurve.evaluate.
Margo-authored CC0 cases. The fitted model and its derivation are in docs/clean-room.md (KB5339c)."""
from pathlib import Path
import json
import sys
import bpy
from bpy_extras import anim_utils

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
ob = bpy.data.objects.new("p", None)
scene.collection.objects.link(ob)
cases = []


def run(easing, amp, per, f0, v0, f1, v1, n=64):
    ob.animation_data_clear()
    ob.location[0] = v0
    ob.keyframe_insert("location", index=0, frame=f0)
    ob.location[0] = v1
    ob.keyframe_insert("location", index=0, frame=f1)
    bag = anim_utils.action_get_channelbag_for_slot(ob.animation_data.action, ob.animation_data.action_slot)
    fc = bag.fcurves[0]
    k = fc.keyframe_points[0]
    k.interpolation, k.easing, k.amplitude, k.period = "ELASTIC", easing, amp, per
    samples = [[f0 + (f1 - f0) * i / n, fc.evaluate(f0 + (f1 - f0) * i / n)] for i in range(n + 1)]
    # amp and per as Blender stored them: it clamps a negative amplitude to 0 and keeps a negative period.
    cases.append({"easing": easing, "amp": k.amplitude, "per": k.period, "k": [f0, v0, f1, v1], "s": samples})


# 84 cases: 4 easings x 7 amplitude/period pairs x 3 key pairs.
for easing in ["EASE_IN", "EASE_OUT", "EASE_IN_OUT", "AUTO"]:
    for amp, per in [(0.0, 0.0), (0.8, 4.1), (0.5, 10.0), (2.0, 3.0), (1.0, 0.0), (0.0, 7.0), (3.0, 20.0)]:
        for f0, v0, f1, v1 in [(1, 0.0, 41, 1.0), (10, 2.0, 30, -1.5), (0, 0.0, 100, 0.3)]:
            run(easing, amp, per, f0, v0, f1, v1)
# Edges: equal keys, a negative amplitude and period, a short period, a half-frame span, amplitude just under the change
# and far above it.
for easing in ["EASE_IN", "EASE_OUT", "EASE_IN_OUT"]:
    for amp in [0.0, 1.0, 0.3]:
        run(easing, amp, 0.0, 0, 0.5, 40, 0.5)
        run(easing, amp, 5.0, 0, 0.5, 40, 0.5)
    run(easing, -1.0, -3.0, 0, 0.0, 40, 1.0)
    run(easing, 0.2, 0.5, 0, 0.0, 40, 1.0, 400)
    run(easing, 0.2, 2.0, 0, 0.0, 0.5, 1.0)
    run(easing, 0.999, 3.0, 0, 0.0, 40, 1.0)
    run(easing, 1e6, 3.0, 0, 0.0, 40, 1.0)
    # A negative period with the amplitude below and above the change.
    for amp in [0.25, 1.0, 2.0]:
        for change in [0.5, -0.5]:
            run(easing, amp, -2.5, 0, 0.0, 40, change)
(output / "elastic-probe.json").write_text(json.dumps(cases), encoding="utf-8")
print("cases", len(cases))
