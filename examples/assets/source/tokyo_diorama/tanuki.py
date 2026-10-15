"""Original hero prop: a round tanuki in a straw hat holding a swinging paper lantern, on a rooftop sign board."""
import buildings
import kit


def build(root):
    shop = next(s for s in buildings.SHOPS if s['name'] == 'Shop_B')
    fur, belly = kit.material('tanuki_fur', '#9a6b45', 0.85), kit.material('tanuki_belly', '#f1dfc0', 0.85)
    mask, white = kit.material('tanuki_mask', '#3b2a22', 0.8), kit.material('tanuki_eye', '#ffffff', 0.4)
    hat, board = kit.material('tanuki_hat', '#d8b46a', 0.9), kit.material('sign_board', '#fff4dc', 0.7)
    outline, steel = kit.material('sign_outline', '#3a2a22', 0.7), kit.material('sign_steel', '#55595e', 0.5, metallic=0.7)
    paper = kit.material('lantern_paper', '#d8382f', 0.6, emission='#ff6a3d', strength=3.0)

    sign = kit.empty('Tanuki_Sign', (shop['x'], shop['y'] - 0.2, buildings.top('Shop_B')), root)
    kit.boxes('Tanuki_Sign_Legs', [((0.06, 0.06, 0.5), (x, 0.1, 0.25)) for x in (-0.6, 0.6)], steel, sign)
    kit.box('Tanuki_Sign_Outline', (1.8, 0.1, 1.5), (0, 0.12, 1.2), outline, sign, bevel=0.12)
    kit.box('Tanuki_Sign_Board', (1.66, 0.1, 1.36), (0, 0.06, 1.2), board, sign, bevel=0.1)
    kit.boxes('Tanuki_Sign_Glyphs', [(size, (x, 0.0, z + 1.72)) for size, (x, _, z) in kit.glyph_specs(1.2, 0.22, seed=11)],
              kit.material('sign_glyph_lit', '#ff8a3d', 0.4, emission='#ff7a2a', strength=2.5), sign)

    body = kit.empty('Tanuki_Body', (0, -0.08, 0.6), sign)
    kit.sphere('Tanuki_Torso', 0.32, (0, 0, 0.3), fur, body, scale=(1.15, 0.85, 1.2))
    kit.sphere('Tanuki_Belly', 0.24, (0, -0.16, 0.26), belly, body, scale=(1.0, 0.45, 1.1))
    kit.sphere('Tanuki_Head', 0.26, (0, -0.04, 0.82), fur, body)
    kit.boxes('Tanuki_Eye_Mask', [((0.16, 0.06, 0.1), (x, -0.25, 0.84)) for x in (-0.09, 0.09)], mask, body)
    kit.boxes('Tanuki_Eyes', [((0.05, 0.04, 0.05), (x, -0.29, 0.86)) for x in (-0.09, 0.09)], white, body)
    kit.sphere('Tanuki_Nose', 0.04, (0, -0.29, 0.77), mask, body)
    kit.boxes('Tanuki_Ears', [((0.1, 0.06, 0.12), (x, -0.02, 1.06), (0, 0, 0)) for x in (-0.16, 0.16)], mask, body)
    kit.cylinder('Tanuki_Hat', 0.34, 0.16, (0, -0.04, 1.08), hat, body, segments=20, radius_top=0.02)
    kit.sphere('Tanuki_Tail', 0.12, (0.34, 0.1, 0.12), fur, body, scale=(1.0, 1.0, 2.0))
    kit.boxes('Tanuki_Feet', [((0.16, 0.18, 0.08), (x, -0.08, -0.06)) for x in (-0.14, 0.14)], mask, body)

    arm = kit.empty('Tanuki_Lantern_Arm', (-0.34, -0.1, 0.45), body)
    kit.tube('Tanuki_Arm', [(0, 0, 0), (-0.18, -0.05, -0.12)], 0.06, fur, arm)
    kit.tube('Tanuki_Lantern_Cord', [(-0.18, -0.05, -0.12), (-0.18, -0.05, -0.28)], 0.008, outline, arm)
    kit.cylinder('Tanuki_Lantern', 0.11, 0.26, (-0.18, -0.05, -0.42), paper, arm, segments=14)
    kit.boxes('Tanuki_Lantern_Caps', [((0.14, 0.14, 0.03), (-0.18, -0.05, z)) for z in (-0.29, -0.55)], outline, arm)
    kit.swing(arm, 1, 22, 3)
