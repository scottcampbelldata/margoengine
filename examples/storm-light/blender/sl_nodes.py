# A small helper for building shader node trees from Python.
# Values passed to helpers can be plain numbers/tuples or node sockets.

import bpy


def _is_socket(v):
    return isinstance(v, bpy.types.NodeSocket)


class NB:
    def __init__(self, mat):
        if mat.node_tree is None:
            mat.use_nodes = True
        self.mat = mat
        self.nt = mat.node_tree
        self.nodes = self.nt.nodes
        self.links = self.nt.links
        self.nodes.clear()
        self._geo = None
        self._cache = {}

    # -- basics
    def n(self, typ, **props):
        node = self.nodes.new(typ)
        for k, v in props.items():
            setattr(node, k, v)
        return node

    def set(self, sock, val):
        if val is None:
            return
        if _is_socket(val):
            self.links.new(val, sock)
        else:
            if isinstance(val, (int, float)) and hasattr(sock, "default_value"):
                dv = sock.default_value
                try:
                    len(dv)
                    n = len(dv)
                    sock.default_value = tuple([float(val)] * n) if n != 4 else (val, val, val, 1.0)
                    return
                except TypeError:
                    pass
            if isinstance(val, tuple) and len(val) == 3:
                try:
                    if len(sock.default_value) == 4:
                        val = (val[0], val[1], val[2], 1.0)
                except TypeError:
                    pass
            sock.default_value = val

    def geo(self):
        if self._geo is None:
            self._geo = self.n("ShaderNodeNewGeometry")
        return self._geo

    def pos(self):
        return self.geo().outputs["Position"]

    def normal(self):
        return self.geo().outputs["Normal"]

    def pointiness(self):
        return self.geo().outputs["Pointiness"]

    def sep(self, v):
        key = ("sep", v.node.name, v.identifier) if _is_socket(v) else None
        if key and key in self._cache:
            return self._cache[key]
        s = self.n("ShaderNodeSeparateXYZ")
        self.set(s.inputs[0], v)
        r = (s.outputs["X"], s.outputs["Y"], s.outputs["Z"])
        if key:
            self._cache[key] = r
        return r

    def comb(self, x, y, z):
        c = self.n("ShaderNodeCombineXYZ")
        self.set(c.inputs[0], x)
        self.set(c.inputs[1], y)
        self.set(c.inputs[2], z)
        return c.outputs[0]

    def attr(self, name):
        a = self.n("ShaderNodeAttribute", attribute_name=name, attribute_type="GEOMETRY")
        return a.outputs["Fac"]

    # -- math
    def m(self, op, a, b=None, c=None, clamp=False):
        node = self.n("ShaderNodeMath", operation=op, use_clamp=clamp)
        self.set(node.inputs[0], a)
        if b is not None:
            self.set(node.inputs[1], b)
        if c is not None:
            self.set(node.inputs[2], c)
        return node.outputs[0]

    def add(self, a, b):
        return self.m("ADD", a, b)

    def sub(self, a, b):
        return self.m("SUBTRACT", a, b)

    def mul(self, a, b):
        return self.m("MULTIPLY", a, b)

    def madd(self, a, b, c):
        return self.m("MULTIPLY_ADD", a, b, c)

    def v(self, op, a, b=None, scale=None):
        node = self.n("ShaderNodeVectorMath", operation=op)
        self.set(node.inputs[0], a)
        if b is not None:
            self.set(node.inputs[1], b)
        if scale is not None:
            self.set(node.inputs[3], scale)
        out = node.outputs["Value"] if op in ("DOT_PRODUCT", "LENGTH", "DISTANCE") else node.outputs["Vector"]
        return out

    def vscale(self, a, s):
        return self.v("SCALE", a, scale=s)

    def vmul(self, a, b):
        return self.v("MULTIPLY", a, b)

    def vadd(self, a, b):
        return self.v("ADD", a, b)

    def mapping(self, vec, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        node = self.n("ShaderNodeMapping", vector_type="POINT")
        self.set(node.inputs["Vector"], vec)
        node.inputs["Location"].default_value = loc
        node.inputs["Rotation"].default_value = rot
        node.inputs["Scale"].default_value = scale
        return node.outputs[0]

    def mr(self, val, a, b, c=0.0, d=1.0, smooth=True, clamp=True):
        node = self.n("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP" if smooth else "LINEAR", clamp=clamp)
        self.set(node.inputs["Value"], val)
        self.set(node.inputs["From Min"], a)
        self.set(node.inputs["From Max"], b)
        self.set(node.inputs["To Min"], c)
        self.set(node.inputs["To Max"], d)
        return node.outputs["Result"]

    def lerp(self, f, a, b):
        node = self.n("ShaderNodeMix", data_type="FLOAT", clamp_factor=True)
        self.set(_sock(node.inputs, "Factor_Float"), f)
        self.set(_sock(node.inputs, "A_Float"), a)
        self.set(_sock(node.inputs, "B_Float"), b)
        return _sock(node.outputs, "Result_Float")

    def mixc(self, f, a, b, blend="MIX"):
        node = self.n("ShaderNodeMix", data_type="RGBA", blend_type=blend, clamp_factor=True)
        self.set(_sock(node.inputs, "Factor_Float"), f)
        self.set(_sock(node.inputs, "A_Color"), a)
        self.set(_sock(node.inputs, "B_Color"), b)
        return _sock(node.outputs, "Result_Color")

    def cmul(self, col, s):
        """Colour times a scalar or colour."""
        if _is_socket(s) and s.type in ("RGBA", "VECTOR"):
            return self.mixc(1.0, col, s, "MULTIPLY")
        node = self.n("ShaderNodeVectorMath", operation="SCALE")
        self.set(node.inputs[0], col)
        self.set(node.inputs[3], s)
        return node.outputs["Vector"]

    def ramp(self, fac, stops, interp="LINEAR"):
        node = self.n("ShaderNodeValToRGB")
        cr = node.color_ramp
        cr.interpolation = interp
        els = cr.elements
        while len(els) > 1:
            els.remove(els[-1])
        for i, (p, c) in enumerate(stops):
            e = els[0] if i == 0 else els.new(p)
            e.position = p
            e.color = (c[0], c[1], c[2], 1.0)
        self.set(node.inputs["Fac"], fac)
        return node.outputs["Color"]

    # -- textures
    def noise(self, vec, scale, detail=4.0, rough=0.5, dist=0.0, ntype="FBM", lac=2.0, col=False):
        node = self.n("ShaderNodeTexNoise", noise_dimensions="3D", noise_type=ntype)
        self.set(node.inputs["Vector"], vec)
        self.set(node.inputs["Scale"], scale)
        self.set(node.inputs["Detail"], detail)
        self.set(node.inputs["Roughness"], rough)
        self.set(node.inputs["Lacunarity"], lac)
        self.set(node.inputs["Distortion"], dist)
        return node.outputs["Color"] if col else node.outputs["Fac"]

    def voronoi(self, vec, scale, feature="F1", out="Distance", rand=1.0, dist="EUCLIDEAN", detail=0.0):
        node = self.n("ShaderNodeTexVoronoi", voronoi_dimensions="3D", feature=feature, distance=dist)
        self.set(node.inputs["Vector"], vec)
        self.set(node.inputs["Scale"], scale)
        self.set(node.inputs["Randomness"], rand)
        if "Detail" in node.inputs:
            self.set(node.inputs["Detail"], detail)
        return node.outputs[out]

    def wave(self, vec, scale, dist=0.0, detail=2.0, direction="Z", profile="SIN", dscale=1.0, phase=0.0):
        node = self.n("ShaderNodeTexWave", wave_type="BANDS", bands_direction=direction, wave_profile=profile)
        self.set(node.inputs["Vector"], vec)
        self.set(node.inputs["Scale"], scale)
        self.set(node.inputs["Distortion"], dist)
        self.set(node.inputs["Detail"], detail)
        self.set(node.inputs["Detail Scale"], dscale)
        self.set(node.inputs["Phase Offset"], phase)
        return node.outputs["Fac"]

    def brick(self, vec, scale=1.0, width=0.5, height=0.25, mortar=0.02, smooth=0.1, offset=0.5, bias=0.0,
              c1=(0.8, 0.8, 0.8), c2=(0.2, 0.2, 0.2), squash=1.0, sqf=2):
        node = self.n("ShaderNodeTexBrick", offset=offset, offset_frequency=2, squash=squash, squash_frequency=sqf)
        self.set(node.inputs["Vector"], vec)
        self.set(node.inputs["Scale"], scale)
        self.set(node.inputs["Brick Width"], width)
        self.set(node.inputs["Row Height"], height)
        self.set(node.inputs["Mortar Size"], mortar)
        self.set(node.inputs["Mortar Smooth"], smooth)
        self.set(node.inputs["Bias"], bias)
        self.set(node.inputs["Color1"], c1)
        self.set(node.inputs["Color2"], c2)
        self.set(node.inputs["Mortar"], (0, 0, 0))
        return node.outputs["Fac"], node.outputs["Color"]

    def bump(self, height, strength=1.0, distance=1.0):
        node = self.n("ShaderNodeBump")
        self.set(node.inputs["Strength"], strength)
        self.set(node.inputs["Distance"], distance)
        self.set(node.inputs["Height"], height)
        return node.outputs["Normal"]

    def zone_masks(self, count):
        z = self.attr("zone")
        masks = []
        for k in range(count):
            masks.append(self.m("COMPARE", z, float(k), 0.5))
        return masks

    def by_zone(self, masks, values, kind="float"):
        """Select a value per zone. values: list aligned with masks (None = zone 0 value)."""
        res = values[0]
        for k in range(1, len(values)):
            if values[k] is None:
                continue
            if kind == "color":
                res = self.mixc(masks[k], res, values[k])
            else:
                res = self.lerp(masks[k], res, values[k])
        return res


def _sock(coll, ident):
    for s in coll:
        if s.identifier == ident:
            return s
    raise KeyError(ident)
