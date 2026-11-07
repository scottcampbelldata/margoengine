"""Curves as splines, point clouds as points and volumes as OpenVDB grids, read from each object's evaluated geometry
(packages/blender/FORMAT.md, "Curves, points and volumes"). Legacy curve objects, hair curves objects and curves made
by geometry nodes all evaluate to the same Curves data, so one reader covers them."""
import os
import tempfile

import numpy as np

# Blender's enum values for the curve_type, knots_mode and handle type attributes.
CURVE_TYPES = {0: "catmullRom", 1: "poly", 2: "bezier", 3: "nurbs"}
KNOT_MODES = {0: "normal", 1: "endpoint", 2: "bezier", 3: "endpointBezier"}
KINDS = ("CURVE", "CURVES", "POINTCLOUD", "VOLUME")


class GeometryData:
    """Collects the Float32 data section and the embedded OpenVDB files while objects are read."""

    def __init__(self, unit_scale):
        self.parts, self.size, self.vdbs, self.unit_scale = [], 0, [], unit_scale
        self.curves, self.points, self.volumes = [], [], []

    def view(self, values, components):
        values = np.ascontiguousarray(values, dtype="<f4")
        if not np.isfinite(values).all():
            raise ValueError("non-finite curve or point data")
        offset = self.size
        self.parts.append(values.tobytes())
        self.size += values.nbytes
        return {"byteOffset": offset, "components": components}

    def yup(self, values):
        """Blender Z-up local coordinates to Margo's Y-up metres, as meshes are."""
        values = values.reshape(-1, 3)[:, (0, 2, 1)].copy()
        values[:, 2] *= -1
        return values * self.unit_scale

    def data(self):
        return b"".join(self.parts)


def attribute(owner, name, domain, components, count):
    """The named attribute's values as float32, or None when the geometry does not hold it."""
    found = owner.attributes.get(name)
    if found is None or found.domain != domain:
        return None
    key = {"FLOAT_VECTOR": "vector", "FLOAT_COLOR": "color", "BYTE_COLOR": "color"}.get(found.data_type, "value")
    if found.data_type in ("INT8", "INT", "BOOLEAN"):
        # Curve-domain settings: a plain list takes any element type.
        values = [0] * count
        found.data.foreach_get(key, values)
        return np.array(values, dtype=np.int32)
    values = np.empty(count * components, dtype=np.float32)
    found.data.foreach_get(key, values)
    return values


def read_curves(name, curves, data):
    count, points = len(curves.curves), len(curves.points)
    if not count or not points:
        return None
    offsets = np.empty(count + 1, dtype=np.int32)
    curves.curve_offset_data.foreach_get("value", offsets)
    types = attribute(curves, "curve_type", "CURVE", 1, count)
    cyclic = attribute(curves, "cyclic", "CURVE", 1, count)
    resolution = attribute(curves, "resolution", "CURVE", 1, count)
    order = attribute(curves, "nurbs_order", "CURVE", 1, count)
    knots = attribute(curves, "knots_mode", "CURVE", 1, count)
    splines = []
    for i in range(count):
        kind = CURVE_TYPES.get(int(types[i]) if types is not None else 0)
        knot = KNOT_MODES.get(int(knots[i]) if knots is not None else 0)
        if kind is None or knot is None:
            raise ValueError(f"Object '{name}': curve {i} uses a curve type or custom knots this exporter cannot write; "
                             "set its knot mode to Uniform, Endpoint or Bezier")
        spline = {"type": kind, "points": int(offsets[i + 1] - offsets[i]), "cyclic": bool(cyclic[i]) if cyclic is not None else False,
                  "resolution": int(resolution[i]) if resolution is not None else 12}
        if kind == "nurbs":
            spline.update(order=int(order[i]) if order is not None else 4, knots=knot)
        splines.append(spline)
    record = {"splines": splines, "attributes": {}}
    position = attribute(curves, "position", "POINT", 3, points)
    record["attributes"]["position"] = data.view(data.yup(position), 3)
    for key, source, components in (("handleLeft", "handle_left", 3), ("handleRight", "handle_right", 3)):
        values = attribute(curves, source, "POINT", components, points)
        if values is not None:
            record["attributes"][key] = data.view(data.yup(values), 3)
    for key, source in (("handleTypeLeft", "handle_type_left"), ("handleTypeRight", "handle_type_right"),
                        ("radius", "radius"), ("tilt", "tilt"), ("weight", "nurbs_weight")):
        values = attribute(curves, source, "POINT", 1, points)
        if values is not None:
            record["attributes"][key] = data.view(values * (data.unit_scale if key == "radius" else 1), 1)
    record["count"] = points
    return record


def read_points(name, cloud, data):
    count = len(cloud.points)
    if not count:
        return None
    record = {"count": count, "attributes": {"position": data.view(data.yup(attribute(cloud, "position", "POINT", 3, count)), 3)}}
    radius = attribute(cloud, "radius", "POINT", 1, count)
    if radius is not None:
        record["attributes"]["radius"] = data.view(radius * data.unit_scale, 1)
    colour = next((a for a in cloud.color_attributes if a.domain == "POINT"), None)
    if colour is not None:
        values = np.empty(count * 4, dtype=np.float32)
        colour.data.foreach_get("color", values)
        record["attributes"]["color"] = data.view(values, 4)
    return record


def read_volume(name, volume, data):
    grids = volume.grids
    if not grids.load() or not len(grids):
        return None
    handle, path = tempfile.mkstemp(suffix=".vdb")
    os.close(handle)
    try:
        if not grids.save(path):
            raise ValueError(f"Object '{name}': Blender could not write its volume grids ({grids.error_message})")
        with open(path, "rb") as file:
            data.vdbs.append(file.read())
    finally:
        os.unlink(path)
    return {"grids": [grid.name for grid in grids], "section": len(data.vdbs) - 1}


def read_object(obj, data):
    """Appends the object's evaluated curves, point cloud or volume to `data`; returns the node fields it adds."""
    geometry = obj.evaluated_geometry()
    fields = {}
    if obj.type in ("CURVE", "CURVES") and geometry.curves is not None:
        record = read_curves(obj.name, geometry.curves, data)
        if record:
            fields["curves"] = len(data.curves)
            data.curves.append(record)
    if obj.type == "POINTCLOUD" and geometry.pointcloud is not None:
        record = read_points(obj.name, geometry.pointcloud, data)
        if record:
            fields["points"] = len(data.points)
            data.points.append(record)
    if obj.type == "VOLUME" and geometry.volume is not None:
        record = read_volume(obj.name, geometry.volume, data)
        if record:
            fields["volume"] = len(data.volumes)
            data.volumes.append(record)
    return fields
