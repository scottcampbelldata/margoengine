"""Hero prop: a big glazed folk-style tanuki statue on Building_4's roof, straw hat, sake flask and a swinging paper lantern."""
import math

import bake
import facade
import kit


def build(root):
    spec = next(s for s in facade.BUILDINGS if s['name'] == 'Building_4')
    top = facade.GROUND + facade.FLOOR0 + facade.FLOOR * (spec['floors'] - 1)
    cx = (spec['x'][0] + spec['x'][1]) / 2 - 1.2
    cy = spec['y'][0] + 1.4
    atlas = bake.Atlas('Tanuki_Atlas', 1024, roughness=0.35)
    fur, belly, dark = 'paint:#8a5a38', 'paint:#f1dfc0', 'paint:#2e211a'
    statue = kit.empty('Tanuki_Statue', (cx, cy, top), root)
    statue.rotation_euler = (0, 0, math.radians(-15))
    atlas.add(kit.cylinder('Tanuki_Pedestal', 0.42, 0.14, (0, 0, 0.07), None, statue, segments=24), 'concrete')
    atlas.add(kit.cylinder('Tanuki_Pedestal_Top', 0.38, 0.04, (0, 0, 0.16), None, statue, segments=24), 'paint:#6b5a48')
    atlas.add(kit.sphere('Tanuki_Body', 0.34, (0, 0.04, 0.52), None, statue, scale=(1.0, 0.92, 1.12), segments=24, rings=14), fur)
    atlas.add(kit.sphere('Tanuki_Belly', 0.28, (0, -0.12, 0.47), None, statue, scale=(0.95, 0.75, 1.0), segments=24, rings=14), belly)
    atlas.add(kit.sphere('Tanuki_Head', 0.24, (0, -0.02, 1.0), None, statue, scale=(1.05, 1.0, 0.95), segments=24, rings=14), fur)
    atlas.add(kit.sphere('Tanuki_Muzzle', 0.11, (0, -0.2, 0.95), None, statue, scale=(1.1, 0.8, 0.8), segments=16, rings=10), belly)
    atlas.add(kit.sphere('Tanuki_Nose', 0.04, (0, -0.29, 0.98), None, statue, segments=12, rings=8), dark)
    for side in (-1, 1):
        atlas.add(kit.sphere('Tanuki_Mask_%d' % side, 0.075, (side * 0.09, -0.19, 1.05), None, statue, scale=(1.2, 0.5, 0.85), segments=14, rings=8), dark)
        atlas.add(kit.sphere('Tanuki_Eye_%d' % side, 0.03, (side * 0.09, -0.225, 1.06), None, statue, segments=10, rings=6), 'paint:#ffffff')
        atlas.add(kit.sphere('Tanuki_Pupil_%d' % side, 0.016, (side * 0.09, -0.247, 1.06), None, statue, segments=8, rings=5), 'paint:#111111')
        atlas.add(kit.sphere('Tanuki_Ear_%d' % side, 0.06, (side * 0.17, 0.0, 1.2), None, statue, scale=(1, 0.6, 1), segments=12, rings=8), dark)
        atlas.add(kit.sphere('Tanuki_Foot_%d' % side, 0.1, (side * 0.16, -0.12, 0.2), None, statue, scale=(1.1, 1.4, 0.6), segments=14, rings=8), fur)
        atlas.add(kit.sphere('Tanuki_Cheek_%d' % side, 0.035, (side * 0.15, -0.2, 0.93), None, statue, scale=(1.2, 0.5, 0.8), segments=10, rings=6), 'paint:#f2a39a')
    atlas.add(kit.cylinder('Tanuki_Hat', 0.38, 0.14, (0, 0.0, 1.24), None, statue, segments=28, radius_top=0.04), 'paint:#d9b46a')
    atlas.add(kit.cylinder('Tanuki_Hat_Band', 0.2, 0.03, (0, 0.0, 1.2), None, statue, segments=28), 'paint:#7a3b1e')
    atlas.add(kit.sphere('Tanuki_Tail', 0.13, (0, 0.33, 0.35), None, statue, scale=(0.9, 1.3, 0.9), segments=14, rings=8), fur)
    # Left hand: sake flask (tokkuri) with a cord.
    atlas.add(kit.sphere('Tanuki_Hand_L', 0.07, (-0.33, -0.1, 0.55), None, statue, segments=12, rings=8), fur)
    atlas.add(kit.cylinder('Tanuki_Flask', 0.09, 0.2, (-0.38, -0.12, 0.4), None, statue, segments=16, radius_top=0.04), 'paint:#efe6d2')
    atlas.add(kit.cylinder('Tanuki_Flask_Neck', 0.035, 0.08, (-0.38, -0.12, 0.54), None, statue, segments=12), 'paint:#efe6d2')
    kit.text_mesh('Tanuki_Flask_Mark', '酒', 0.07, (-0.38, -0.205, 0.4), kit.material('flask_mark', '#2e211a', 0.6), statue, rot=(math.radians(90), 0, 0))
    # Right hand: the paper lantern on a short pole, swinging.
    arm = kit.empty('Tanuki_Lantern_Arm', (0.33, -0.1, 0.62), statue)
    atlas.add(kit.sphere('Tanuki_Hand_R', 0.07, (0, 0, 0), None, arm, segments=12, rings=8), fur)
    atlas.add(kit.tube('Tanuki_Lantern_Pole', [(0, 0, 0), (0.12, -0.05, 0.1)], 0.012, None, arm, sides=6), 'wood_dark')
    atlas.add(kit.tube('Tanuki_Lantern_Cord', [(0.12, -0.05, 0.1), (0.12, -0.05, -0.05)], 0.006, None, arm, sides=4), 'rubber')
    kit.cylinder('Tanuki_Lantern', 0.1, 0.24, (0.12, -0.05, -0.18), kit.material('tanuki_lantern', '#e0442f', 0.5, emission='#ff6a3d', strength=2.6), arm, segments=16)
    atlas.add(kit.boxes('Tanuki_Lantern_Caps', [((0.13, 0.13, 0.025), (0.12, -0.05, z)) for z in (-0.05, -0.31)], None, arm), 'paint:#1d1714')
    kit.swing(arm, 1, 18, 3)
    return statue
