"""Original, fully modeled workshop dressing for the Light Keeper.

Called by build_robot.py through Blender MCP. All authored positions are glTF
Y-up metres; the front of the workbench and tool stand is -Z. No downloads,
external scene objects, generated text or standalone Blender process are used.
"""
import math
import random
import bpy
from mathutils import Vector, Matrix


def build(ctx):
    g = ctx["g"]
    palette = {name: ctx[name] for name in (
        "cream", "teal", "dark", "copper", "walnut", "sand", "clay",
        "green", "soil", "paper")}
    mat = ctx["material"]
    palette.update({
        "wood_edge": mat("Workshop / worn walnut endgrain", (.29, .153, .077), .78),
        "wood_dark": mat("Workshop / dark walnut joinery", (.115, .057, .026), .84),
        "iron": mat("Workshop / forged charcoal iron", (.052, .059, .052), .56, .66),
        "steel": mat("Workshop / aged handtool steel", (.32, .34, .30), .32, .84),
        "brass": mat("Workshop / old precision brass", (.49, .33, .115), .34, .83),
        "leather": mat("Workshop / olive leather toolkit", (.105, .14, .09), .83),
        "book_red": mat("Workshop / oxblood book cloth", (.22, .065, .037), .93),
        "book_moss": mat("Workshop / moss book cloth", (.13, .16, .10), .94),
        "jute": mat("Workshop / braided flax rug", (.33, .27, .17), .99),
        "jute_light": mat("Workshop / flax highlight fibres", (.36, .295, .19), .99),
        "linen": mat("Workshop / natural linen wiping cloth", (.70, .665, .57), .96),
        "leaf_light": mat("Workshop / young olive leaf", (.13, .21, .055), .9),
        "leaf_dark": mat("Workshop / leaf shadow green", (.027, .085, .018), .94),
        "bark": mat("Workshop / olive twig bark", (.19, .13, .065), .96),
        "lamp_glow": mat("Workshop / warm task lamp diffuser", (.93, .69, .32), .6, 0, .45),
    })
    groups = {}
    group_name = "Workshop"
    rigid_parents = {}
    lamp_joints = []

    def keep(obj):
        groups.setdefault(group_name, []).append(obj)
        return obj

    def B(name, p, size, key="walnut", bevel=.007):
        return keep(ctx["box"](name, p, size, palette[key], bevel))

    def C(name, p, radius, height, key="brass", vertices=32, top=None):
        return keep(ctx["cylinder"](name, p, radius, height, palette[key], vertices, top))

    def R(name, a, b, radius, key="iron"):
        return keep(ctx["rod"](name, a, b, radius, palette[key]))

    def S(name, p, radius, key="brass", segments=16):
        return keep(ctx["sphere"](name, p, radius, palette[key], segments))

    def mesh(name, vertices, faces, key, smooth=False):
        data = bpy.data.meshes.new(name)
        data.from_pydata([g(p) for p in vertices], [], faces)
        data.update()
        obj = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(obj)
        data.materials.append(palette[key])
        if smooth:
            for polygon in data.polygons:
                polygon.use_smooth = True
        return keep(obj)

    def tube(name, points, radius, key, sides=6, closed=False):
        points = [Vector(p) for p in points]
        verts, faces = [], []
        for i, p in enumerate(points):
            tangent = points[(i + 1) % len(points)] - points[i - 1] if closed else (
                points[min(i + 1, len(points) - 1)] - points[max(0, i - 1)])
            tangent.normalize()
            u = tangent.cross(Vector((0, 1, 0)))
            if u.length < .01:
                u = tangent.cross(Vector((1, 0, 0)))
            u.normalize()
            v = tangent.cross(u).normalized()
            verts.extend(p + radius * (u * math.cos(k * math.tau / sides) +
                                      v * math.sin(k * math.tau / sides)) for k in range(sides))
        for i in range(len(points) if closed else len(points) - 1):
            j = (i + 1) % len(points)
            faces.extend((i * sides + k, i * sides + (k + 1) % sides,
                          j * sides + (k + 1) % sides, j * sides + k) for k in range(sides))
        if not closed:
            faces.extend((tuple(reversed(range(sides))),
                          tuple((len(points) - 1) * sides + k for k in range(sides))))
        return mesh(name, verts, faces, key, True)

    def ring(name, p, radius, thickness, key, normal=(0, 1, 0), segments=48):
        normal = Vector(normal).normalized()
        u = normal.cross(Vector((0, 1, 0)))
        if u.length < .01:
            u = normal.cross(Vector((0, 0, 1)))
        u.normalize()
        v = normal.cross(u).normalized()
        points = [Vector(p) + radius * (math.cos(k * math.tau / segments) * u +
                                        math.sin(k * math.tau / segments) * v) for k in range(segments)]
        return tube(name, points, thickness, key, 8, True)

    def lathe(name, center, profile, key, segments=40):
        # The closed radial profile gives pots and lamp shades actual inner walls.
        x, y, z = center
        verts = [(x + r * math.cos(k * math.tau / segments), y + h,
                  z + r * math.sin(k * math.tau / segments))
                 for r, h in profile for k in range(segments)]
        faces = [(j * segments + k, j * segments + (k + 1) % segments,
                  ((j + 1) % len(profile)) * segments + (k + 1) % segments,
                  ((j + 1) % len(profile)) * segments + k)
                 for j in range(len(profile)) for k in range(segments)]
        return mesh(name, verts, faces, key, True)

    def leaf(name, a, b, width, key):
        # A closed, gently cupped lamina remains visible from both orbit sides.
        a, b = Vector(a), Vector(b)
        axis = b - a
        broad = "pothos" in name.lower()
        # Front-tilted leaf planes make the crown read from the production
        # camera; the previous horizontal leaves were seen edge-on there.
        hint = Vector((.18, .58, -1)) if broad else Vector((.13, .36, -1))
        side = axis.cross(hint)
        if side.length < .001:
            side = axis.cross(Vector((0, 0, 1)))
        side.normalize()
        normal = side.cross(axis).normalized()
        mid = a + axis * .46
        profile = [(.08, .68), (.22, .96), (.40, 1), (.60, .83), (.79, .54), (.92, .23)] if broad else [
            (.14, .45), (.30, .83), (.48, 1), (.67, .82), (.84, .46), (.94, .16)]
        def edge(t, w, sign):
            return a + axis * t + side * width * w * sign + normal * width * .10 * math.sin(t * math.pi)
        boundary = [a] + [edge(t, w, 1) for t, w in profile] + [b] + [
            edge(t, w, -1) for t, w in reversed(profile)]
        n = len(boundary)
        verts = boundary + [mid + normal * width * .26, mid - normal * .001]
        faces = []
        for k in range(n):
            j = (k + 1) % n
            faces.extend(((k, j, n), (j, k, n + 1)))
        return mesh(name, verts, faces, key)

    def screw(p, axis=(0, 0, -1), radius=.006, key="iron"):
        p, axis = Vector(p), Vector(axis).normalized()
        R("Slotted flush screw", p - axis * .002, p + axis * .001, radius, key)
        # The dark modeled slot remains legible on the larger bracket screws.
        if radius > .005:
            side = axis.cross(Vector((0, 1, 0)))
            if side.length < .1:
                side = Vector((1, 0, 0))
            side.normalize()
            R("Screwdriver slot", p + axis * .002 - side * radius * .55,
              p + axis * .002 + side * radius * .55, .0007, "dark")

    def book(name, x, y, z, width, depth, height, key):
        B(name + " page block", (x, y + height * .5, z),
          (width - .012, height - .012, depth - .009), "paper", .003)
        for h in (y + .003, y + height - .003):
            B(name + " cloth cover", (x, h, z), (width, .006, depth), key, .002)
        B(name + " rounded spine", (x - width * .5 + .004, y + height * .5, z),
          (.009, height, depth), key, .003)
        for offset in (-.075, .075):
            B(name + " spine raised band", (x - width * .5 - .001, y + height * .5, z + offset),
              (.003, height + .002, .006), "brass", .001)
        for h in (.27, .52, .76):
            B(name + " page fore-edge seam", (x, y + height * h, z - depth * .5 + .002),
              (width - .018, .0006, .0006), "wood_edge", 0)

    def toolcase(name, center, size):
        x, y, z = center
        w, h, d = size
        B(name + " olive case", center, size, "leather", .013)
        B(name + " dark lid seam", (x, y + h * .25, z), (w + .002, .006, d + .002), "iron", .002)
        B(name + " fitted lid", (x, y + h * .32, z), (w + .005, h * .35, d + .005), "leather", .008)
        for sx in (-1, 1):
            px = x + sx * w * .34
            for sz in (-1, 1):
                pz = z + sz * (d * .5 + .004)
                B(name + " corner iron strap", (px, y, pz), (.028, h * .88, .008), "iron", .003)
                for py in (y - h * .31, y + h * .33):
                    screw((px, py, pz + sz * .006), (0, 0, sz), .004, "brass")
            B(name + " top corner plate", (px, y + h * .5 + .004, z), (.03, .008, d + .012), "iron", .002)
            B(name + " brass clasp", (px, y + h * .20, z - d * .5 - .009), (.023, .046, .010), "brass", .003)
            B(name + " clasp hinge", (px, y + h * .21, z - d * .5 - .016), (.013, .025, .009), "iron", .002)
        handle_y = y + h * .5 + .016
        for px in (x - .07, x + .07):
            B(name + " handle socket", (px, handle_y, z), (.025, .016, .03), "brass", .003)
        tube(name + " folded leather carry handle", [(x - .07, handle_y, z),
             (x - .065, handle_y + .033, z), (x + .065, handle_y + .033, z),
             (x + .07, handle_y, z)], .009, "leather", 8)
        for sx in (-1, 1):
            for sz in (-1, 1):
                B(name + " grounded rubber foot", (x + sx * w * .36, y - h * .5 - .006,
                  z + sz * d * .31), (.035, .012, .027), "dark", .003)

    def make_lamp():
        nonlocal group_name
        points = [(1.24, .85, .245), (1.34, .99, .245), (1.10, 1.09, .20)]
        names = ("LampBase", "LampLowerArm", "LampUpperArm", "LampShade")
        positions = (points[0], points[0], points[1], points[2])
        joints = []
        for i, (name, position) in enumerate(zip(names, positions)):
            joint = bpy.data.objects.new(name, None)
            bpy.context.scene.collection.objects.link(joint)
            joint.empty_display_type = "PLAIN_AXES"
            joint.empty_display_size = .04
            if i == 0:
                joint.location = g(position)
            else:
                joint.parent = joints[-1]
                joint.location = g(Vector(position)-Vector(positions[i-1]))
            joint["rest_pivot_gltf"] = list(position)
            joint["control_axes"] = "glTF Y swivel; glTF Z hinge"
            joints.append(joint)
        lamp_joints.extend(joints)
        bpy.context.view_layer.update()
        for name, joint in zip(("Lamp fixed base geometry", "Lamp lower arm geometry", "Lamp upper arm geometry", "Lamp shade geometry"), joints):
            rigid_parents[name] = joint

        group_name = "Lamp fixed base geometry"
        C("Lamp cast iron weighted base", (1.24, .821, .245), .078, .036, "iron", 48)
        C("Lamp copper base trim", (1.24, .842, .245), .065, .008, "copper", 48)
        for index in range(2):
            group_name = "Lamp lower arm geometry" if index == 0 else "Lamp upper arm geometry"
            a, b = points[index:index+2]
            for dz in (-.012, .012):
                R("Twin copper articulated lamp arm", (a[0], a[1], a[2]+dz), (b[0], b[1], b[2]+dz), .007, "copper")
            p = points[index]
            R("Lamp joint axle", (p[0], p[1], p[2]-.029), (p[0], p[1], p[2]+.029), .019, "iron")
            screw((p[0], p[1], p[2]-.034), radius=.009, key="brass")
        group_name = "Lamp lower arm geometry"
        a, b = Vector(points[0]), Vector(points[1])
        start, end = a.lerp(b, .20), a.lerp(b, .62)
        axis = (end-start).normalized()
        u, v = Vector((0, 0, 1)), axis.cross(Vector((0, 0, 1))).normalized()
        coil = [start.lerp(end, i/55)+.008*(u*math.cos(i*math.tau/5)+v*math.sin(i*math.tau/5)) for i in range(56)]
        tube("Visible anglepoise tension spring", coil, .0018, "steel", 5)
        # Each cable section terminates inside a hinge axle. Rigid pieces remain
        # connected at pivots when either arm rotates; no static cross-joint lead.
        tube("Lower lamp fabric cable", [points[0], (1.28, .91, .270), points[1]], .0022, "dark")
        group_name = "Lamp upper arm geometry"
        tube("Upper lamp fabric cable", [points[1], (1.22, 1.04, .270), points[2]], .0022, "dark")
        group_name = "Lamp shade geometry"
        p = points[2]
        R("Lamp shade joint axle", (p[0], p[1], p[2]-.029), (p[0], p[1], p[2]+.029), .019, "iron")
        screw((p[0], p[1], p[2]-.034), radius=.009, key="brass")
        R("Lamp neck swivel", points[2], (1.075, 1.067, .18), .018, "copper")
        lathe("Copper spun open task lamp shade", (1.065, .925, .18),
              [(.112, 0), (.118, .009), (.045, .129), (.035, .133), (.031, .122), (.105, .008)], "copper", 48)
        C("Warm recessed lamp diffuser", (1.065, .936, .18), .102, .004, "lamp_glow", 48)
        tube("Shade fabric cable service lead", [points[2], (1.09, 1.078, .226)], .0022, "dark")

    def finish_groups():
        result = list(lamp_joints)
        for name, objects in groups.items():
            objects = [obj for obj in objects if obj.type == "MESH"]
            if not objects:
                continue
            bpy.ops.object.select_all(action="DESELECT")
            for obj in objects:
                obj.select_set(True)
            bpy.context.view_layer.objects.active = objects[0]
            if len(objects) > 1:
                bpy.ops.object.join()
            obj = bpy.context.object
            obj.name = name
            if name in rigid_parents:
                world = obj.matrix_world.copy()
                obj.parent = rigid_parents[name]
                obj.matrix_world = world
            if name in ("Workshop / freestanding perforated tool stand", "Workshop / hanging forged handtools"):
                anchor = g((-.92, 0, .57))
                inverse = obj.matrix_world.inverted()
                for vertex in obj.data.vertices:
                    vertex.co = inverse @ (anchor+(obj.matrix_world@vertex.co-anchor)*.82)
                obj.data.update()
            obj["authored_by"] = "Margo Engine original Blender workshop module"
            obj["semantic_front"] = "glTF -Z"
            obj["support_plane"] = "plinth top y=0; bench props supported at y=0.800"
            result.append(obj)
        bpy.ops.object.select_all(action="DESELECT")
        return result

    if ctx.get("only_lamp"):
        make_lamp()
        return finish_groups()

    # An open gallery island: deliberately asymmetric props flank the hero.
    # Every foot is on the y=0 plinth; there is no surrounding room shell.
    group_name = "Workshop / limestone island"
    C("Circular honed limestone island", (0, -.065, .025), 1.48, .13, "sand", 128)
    C("Recessed dark limestone underside", (0, -.121, .025), 1.454, .018, "wood_dark", 128)
    for x, z in ((.60, -1.28), (-1.21, -.77), (1.26, .64)):
        C("Small island perimeter brass anchor", (x, .016, z), .012, .032, "brass", 16)

    group_name = "Workshop / walnut joiners bench"
    # Five separate planks expose real seams and endgrain at both ends.
    for i in range(5):
        z = -.205 + i * .133
        B("Walnut benchtop plank %d" % i, (.92, .761, z), (.94, .078, .129), "walnut", .008)
        for x in (.48, 1.36):
            B("Plank endgrain end cap", (x, .761, z), (.009, .067, .119), "wood_edge", .002)
    for x in (.52, 1.31):
        for z in (-.19, .31):
            B("Through-tenon bench leg", (x, .359, z), (.085, .718, .088), "walnut", .006)
            B("Leg endgrain shoulder", (x, .715, z), (.096, .035, .096), "wood_edge", .003)
            for y in (.12, .64):
                screw((x, y, z - .047), radius=.007)
    for z in (-.195, .325):
        B("Bench full-width apron", (.915, .652, z), (.83, .17, .043), "wood_dark", .006)
        B("Lower shelf support rail", (.915, .18, z), (.83, .06, .045), "walnut", .004)
    for x in (.52, 1.31):
        B("Bench solid side apron", (x, .652, .065), (.048, .17, .52), "walnut", .005)
        B("Lower side stretcher", (x, .18, .065), (.049, .06, .53), "walnut", .004)
    for z in (-.10, .055, .21):
        B("Slatted low storage shelf", (.915, .209, z), (.79, .028, .149), "wood_edge", .003)
    for x in (.712, 1.118):
        B("Recessed walnut drawer face", (x, .655, -.224), (.385, .139, .024), "walnut", .005)
        B("Raised drawer inner panel", (x, .655, -.240), (.326, .091, .009), "wood_edge", .004)
        for px in (x - .061, x + .061):
            R("Drawer iron pull standoff", (px, .655, -.25), (px, .655, -.273), .008, "iron")
            screw((px, .655, -.277), radius=.005)
        R("Forged iron drawer handle", (x - .061, .655, -.276), (x + .061, .655, -.276), .009, "iron")
    for x in (.48, 1.36):
        B("Benchtop front iron corner plate", (x, .758, -.273), (.044, .065, .009), "iron", .002)
        B("Benchtop corner top strap", (x, .803, -.225), (.044, .008, .09), "iron", .002)
        for y in (.741, .778):
            screw((x, y, -.279), radius=.0055)
    # Back bracing and real joints keep reverse orbit as finished as the front.
    R("Workbench rear diagonal iron tie", (.56, .23, .358), (1.27, .58, .358), .006, "iron")
    R("Workbench rear opposing iron tie", (1.27, .23, .364), (.56, .58, .364), .006, "iron")

    group_name = "Workshop / fitted tool cases"
    toolcase("Lower shelf instrument case", (.92, .350, .06), (.53, .23, .33))
    toolcase("Tool stand field case", (-.96, .134, .37), (.37, .244, .25))

    group_name = "Workshop / old books"
    book("Oxblood bench notebook", 1.18, .803, -.08, .20, .24, .030, "book_red")
    book("Moss workshop notebook", 1.17, .833, -.075, .18, .23, .026, "book_moss")
    book("Floor folio lower", .95, .002, -.87, .25, .29, .031, "book_moss")
    book("Floor folio upper", .96, .033, -.865, .23, .27, .028, "book_red")
    # A folded linen wiping cloth drapes over the front edge of the bench.
    group_name = "Workshop / linen cloth"
    cloth_verts, cloth_faces = [], []
    for j in range(13):
        t = j / 12
        for i in range(9):
            x = .89 + i * .014
            if t <= .58:
                z, y = -.10 - t * .29655, .803 + .003 * math.sin(i * 2.3 + t * 5)
            else:
                z = -.272 - .007 * math.sin((t - .58) * math.pi * 2)
                y = .806 - (t - .58) * .40 + .004 * math.sin(i * 2.3)
            cloth_verts.append((x, y, z))
    for j in range(12):
        for i in range(8):
            a = j * 9 + i
            cloth_faces.append((a, a + 1, a + 10, a + 9))
    cloth = mesh("Folded linen drape with woven pleats", cloth_verts, cloth_faces, "linen", True)
    solid = cloth.modifiers.new("Linen edge thickness", "SOLIDIFY")
    solid.thickness = .0014
    bpy.context.view_layer.objects.active = cloth
    bpy.ops.object.modifier_apply(modifier=solid.name)
    for i in range(7):
        x = .899 + i * .016
        R("Linen fringe", (x, .639, -.278), (x + .002, .621, -.279), .0012, "jute_light")

    make_lamp()

    group_name = "Workshop / brass precision gyroscope"
    B("Gyroscope walnut base", (.65, .816, .095), (.27, .027, .21), "wood_dark", .009)
    C("Gyroscope stepped brass pedestal", (.65, .844, .095), .055, .031, "brass", 40)
    C("Gyroscope vertical spindle", (.65, .898, .095), .010, .082, "brass", 24)
    center = (.65, 1.002, .095)
    ring("Gyroscope outer gimbal", center, .106, .005, "brass", (0, 0, 1))
    ring("Gyroscope middle gimbal", center, .083, .0045, "brass", (.84, .15, .52))
    ring("Gyroscope inner flywheel", center, .060, .007, "brass", (.15, .76, .63))
    S("Gyroscope central bearing", center, .021, "steel", 24)
    R("Gyroscope horizontal axle", (.526, 1.002, .095), (.774, 1.002, .095), .004, "steel")
    for x in (.526, .774):
        C("Gyroscope bearing support", (x, .9155, .095), .008, .173, "brass", 24)
        S("Gyroscope adjusting thumbscrew", (x, 1.012, .095), .012, "brass")
    for x in (.57, .73):
        screw((x, .833, .035), (0, 1, 0), .005, "brass")

    group_name = "Workshop / desk pen pot and handtools"
    lathe("Brass open pencil and scriber pot", (1.00, .802, .285),
          [(.035, 0), (.039, .006), (.040, .099), (.036, .104),
           (.032, .098), (.032, .006)], "brass", 32)
    C("Pencil pot dark interior", (1.00, .814, .285), .031, .010, "dark", 24)
    for i, (dx, dz, height) in enumerate(((-.014, .007, .181), (.01, .008, .145),
                                        (.002, -.011, .165), (-.010, -.009, .14))):
        a = (1.00 + dx, .82, .285 + dz)
        b = (1.00 + dx * 2.2, .802 + height, .285 + dz * 1.8)
        R("Pencil or precision scribe", a, b, .004, "wood_edge" if i < 2 else "steel")
        S("Pencil pointed graphite", b, .003, "dark", 12)
    B("Small brass parts tray", (.80, .812, .29), (.12, .018, .09), "brass", .005)
    for dx, dz in ((-.025, -.013), (.015, .006), (.032, -.018)):
        ring("Loose washer in parts tray", (.80 + dx, .824, .29 + dz), .009, .0019, "steel", segments=16)

    group_name = "Workshop / freestanding perforated tool stand"
    board_z = .57
    keep(ctx["pegboard"]("Oak pegboard with through perforations", (-.92, 1.104, board_z), .66, .68, palette["wood_edge"]))
    for x in (-1.25, -.59):
        B("Pegboard solid ash upright", (x, .745, .613), (.038, 1.49, .051), "walnut", .006)
        B("Grounded pegboard outrigger", (x, .021, .55), (.072, .042, .34), "wood_dark", .005)
        B("Stand foot forged bracket", (x, .055, .55), (.081, .018, .14), "iron", .003)
        for z in (.425, .675):
            screw((x, .043, z), (0, 1, 0), .005, "brass")
    for y in (.756, 1.454):
        B("Pegboard horizontal face frame", (-.92, y, .568), (.721, .033, .046), "walnut", .005)
    for x in (-1.274, -.566):
        B("Pegboard vertical face edge", (x, 1.104, .568), (.026, .68, .046), "walnut", .004)
        for y in (.78, 1.43):
            screw((x, y, .541), radius=.006, key="brass")
    B("Tool stand rear lower stretcher", (-.92, .19, .631), (.66, .045, .035), "walnut", .005)
    R("Pegboard rear iron diagonal", (-1.23, .23, .645), (-.61, 1.40, .645), .006, "iron")
    R("Pegboard rear opposing diagonal", (-.61, .23, .656), (-1.23, 1.40, .656), .006, "iron")

    def peg(x, y):
        R("Tool peg board mounting pin", (x, y, .551), (x, y, .516), .004, "iron")
        R("Tool peg upward hook", (x, y, .516), (x, y + .012, .516), .004, "iron")

    def extruded_outline(name, outline, z, thickness, key):
        n = len(outline)
        verts = [(x, y, z + dz) for dz in (-thickness * .5, thickness * .5) for x, y in outline]
        faces = [tuple(reversed(range(n))), tuple(n + k for k in range(n))]
        faces.extend((k, (k + 1) % n, n + (k + 1) % n, n + k) for k in range(n))
        return mesh(name, verts, faces, key)

    def spanner(x, top, length, head_radius):
        z, r = .515, head_radius
        center = top - r
        outline = [(-.90, .85), (-1.05, .30), (-.95, -.40), (-.45, -.90),
                   (.45, -.90), (.95, -.40), (1.05, .30), (.90, .85),
                   (.40, .60), (.40, -.05), (-.40, -.05), (-.40, .60)]
        extruded_outline("Forged spanner open jaw with working gap",
                          [(x + a * r, center + b * r) for a, b in outline], z, .010, "steel")
        B("Spanner tapered flat handle", (x, center - length * .47, z),
          (r * .62, length * .98, .010), "steel", .004)
        # A true annulus makes the opposite ring-end opening visible.
        ring("Spanner closed ring end opening", (x, center - length, z), r * .64,
             r * .20, "steel", (0, 0, 1), 24)
        B("Spanner recessed handle stamp", (x, center - length * .43, z - .006),
          (r * .26, length * .52, .0015), "iron", .001)
        peg(x, center + .005)

    group_name = "Workshop / hanging forged handtools"
    spanner(-1.17, 1.39, .265, .025)
    spanner(-1.055, 1.39, .315, .030)
    spanner(-.93, 1.385, .232, .024)
    B("Steel hanging ruler", (-.80, 1.17, .515), (.034, .388, .006), "steel", .002)
    ring("Ruler hanging eye opening", (-.80, 1.374, .515), .008, .0025, "steel", (0, 0, 1), 16)
    peg(-.80, 1.374)
    for i in range(34):
        y = .994 + i * .0105
        B("Engraved ruler graduation", (-.809 + (.003 if i % 5 else 0), y, .511),
          (.011 if i % 5 else .021, .0008, .0008), "iron", 0)
    R("Screwdriver forged shaft", (-.68, 1.11, .515), (-.68, 1.31, .515), .004, "steel")
    R("Screwdriver ash handle", (-.68, 1.31, .515), (-.68, 1.39, .515), .013, "wood_dark")
    ring("Screwdriver hanging leather loop", (-.68, 1.40, .52), .009, .0025, "leather", (0, 0, 1), 16)
    peg(-.68, 1.40)
    B("Screwdriver flat blade", (-.68, 1.102, .515), (.011, .025, .004), "steel", .001)
    # Pliers: two crossed handles, actual separated jaws and a central pivot.
    px, py = -.92, .902
    for side in (-1, 1):
        tube("Pliers curved forged arm", [(px + side * .036, py - .067, .515),
             (px + side * .025, py - .015, .515), (px - side * .008, py + .025, .515),
             (px - side * .025, py + .067, .515)], .006, "steel")
        R("Pliers charcoal handle sleeve", (px + side * .036, py - .067, .515),
          (px + side * .029, py - .027, .515), .009, "dark")
    screw((px, py + .008, .506), radius=.007, key="brass")
    peg(px, py + .035)
    R("Small hammer hickory handle", (-1.16, .81, .515), (-1.16, .975, .515), .009, "wood_edge")
    B("Small cross peen hammer head", (-1.16, .984, .515), (.089, .028, .030), "steel", .005)
    peg(-1.16, .974)
    # A compact rectangular try square is visibly a tool, rather than dots.
    B("Try square ebony stock", (-.69, .87, .514), (.025, .145, .018), "wood_dark", .003)
    B("Try square long steel blade", (-.741, .936, .512), (.129, .022, .005), "steel", .002)
    peg(-.69, .947)

    def pot(name, x, z, radius, height, key="clay"):
        lathe(name + " hollow ceramic vessel", (x, 0, z),
              [(radius * .73, 0), (radius * .83, .018), (radius, height * .87),
               (radius * 1.045, height * .96), (radius * 1.02, height),
               (radius * .92, height), (radius * .90, height * .89),
               (radius * .72, .025)], key, 48)
        C(name + " closed ceramic base", (x, .009, z), radius * .74, .018, key, 40)
        C(name + " recessed real soil", (x, height - .014, z), radius * .90, .018, "soil", 40)
        rng = random.Random(42)
        for i in range(9):
            angle, r = rng.random() * math.tau, rng.random() * radius * .72
            S(name + " soil pebble", (x + math.cos(angle) * r, height - .002,
              z + math.sin(angle) * r), .006, "sand", 12)

    group_name = "Workshop / planted olive sapling"
    ox, oz, oh = -.50, .67, .218
    pot("Speckled stoneware olive pot", ox, oz, .125, oh, "sand")
    tube("Olive subtly curved woody trunk", [(ox, oh - .01, oz), (ox + .012, .47, oz - .009),
         (ox - .008, .72, oz + .005), (ox + .022, .96, oz + .008)], .008, "bark", 8)
    rng = random.Random(73)
    for branch in range(11):
        angle = branch * 2.39996
        start_y = .37 + branch * .044
        root = Vector((ox + .012, start_y, oz))
        spread = .18 - max(0, branch - 6) * .015
        end = Vector((ox + math.cos(angle) * (spread + branch % 3 * .012),
                      start_y + .20 + rng.random() * .07,
                      oz + math.sin(angle) * spread * .8))
        mid = root.lerp(end, .5) + Vector((0, .03, 0))
        tube("Olive branching woody stem", [root, mid, end], .0035, "bark")
        axis = (end - root).normalized()
        side = Vector((math.cos(angle + math.pi / 2), .10, math.sin(angle + math.pi / 2)))
        for i in range(6):
            node = root.lerp(end, .28 + i * .137)
            for sign in (-1, 1):
                tip = node + side * sign * (.065 + rng.random() * .021) + axis * .030
                leaf("Narrow opposite olive leaf", node, tip, .011 + rng.random() * .004,
                     "green" if (i + branch) % 3 else "leaf_light")
        for sign in (-1, 1):
            start = root.lerp(end, .56 + sign * .08)
            shoot = start + side * sign * .065 + axis * .07
            R("Olive tertiary leafy shoot", start, shoot, .0018, "bark")
            for i in range(3):
                node = start.lerp(shoot, .35 + i * .25)
                tip = node + axis * .052 + side * (1 if i % 2 else -1) * .034
                leaf("Small olive shoot leaf", node, tip, .0105, "leaf_dark" if branch % 2 else "green")

    group_name = "Workshop / trailing pothos in clay pot"
    vx, vz, vh = 1.17, -.55, .245
    pot("Patinated terracotta trailing plant pot", vx, vz, .132, vh)
    rng = random.Random(14)
    for branch in range(12):
        angle = branch * 2.39996
        start = Vector((vx, vh - .012, vz))
        end = start + Vector((math.cos(angle) * (.105 + rng.random() * .055),
                              .12 + rng.random() * .15, math.sin(angle) * .14))
        path = [start, start.lerp(end, .45) + Vector((0, .04, 0)), end]
        tube("Pothos dense crown petiole", path, .0024, "green")
        for i in range(4):
            node = start.lerp(end, .36 + i * .20)
            sign = -1 if i % 2 else 1
            tip = node + Vector((sign * (.055 + rng.random() * .025),
                                .018 + rng.random() * .025, -.032 + rng.random() * .02))
            leaf("Cupped heart shaped pothos crown leaf", node, tip, .031 + rng.random() * .012,
                 ("leaf_light", "green", "leaf_dark")[(i + branch) % 3])
    for branch in range(5):
        # A cubic stem bows over the rim, then wanders as it trails below the
        # island edge. Alternating broad leaves conceal the structural stem.
        start = Vector((vx + .015, vh - .01, vz - .01))
        c1 = start + Vector((.04 + branch * .019, .29, -.05 - branch * .015))
        c2 = Vector((vx + .10 + branch * .024, .16, vz - .13 - branch * .024))
        end = Vector((vx + .07 + branch * .027, -.13 - branch * .027,
                      vz - .23 - branch * .017))
        path = []
        for i in range(25):
            t = i / 24
            p = (1-t)**3 * start + 3*(1-t)**2*t*c1 + 3*(1-t)*t*t*c2 + t**3*end
            p += Vector((.018 * math.sin(t * math.tau * 1.3 + branch),
                         0, .014 * math.sin(t * math.tau * 1.1 + branch))) * t
            path.append(p)
        tube("Pothos curved trailing vine", path, .0025, "green")
        for i in range(12):
            node = path[min(24, 2 + i * 2)]
            sign = -1 if i % 2 else 1
            tip = node + Vector((sign * (.055 + rng.random() * .025),
                                -.005 + rng.random() * .034, -.025 + rng.random() * .030))
            leaf("Cupped heart shaped pothos trailing leaf", node, tip, .029 + rng.random() * .012,
                 ("green", "leaf_dark", "leaf_light")[(i + branch) % 3])

    group_name = "Workshop / braided jute floor mat"
    rug = (.53, .010, -.64)
    rug_verts, rug_faces = [], []
    for y in (.006, .013):
        for k in range(96):
            a = k * math.tau / 96
            radius = .270 * (1 + .018 * math.sin(3 * a + .4) + .011 * math.cos(7 * a))
            rug_verts.append((rug[0] + math.cos(a) * radius * 1.08,
                              y, rug[2] + math.sin(a) * radius * .88))
    rug_faces.extend((tuple(reversed(range(96))), tuple(96 + k for k in range(96))))
    rug_faces.extend((k, (k + 1) % 96, 96 + (k + 1) % 96, 96 + k) for k in range(96))
    mesh("Subtly oval irregular woven jute mat core", rug_verts, rug_faces, "jute")
    for i in range(25):
        radius = .016 + i * .0103
        points = []
        for k in range(96):
            a = k * math.tau / 96
            r = radius * (1 + .018 * math.sin(3 * a + .4) + .011 * math.cos(7 * a))
            r += .0007 * math.sin(11 * a + i * .41)
            points.append((rug[0] + math.cos(a) * r * 1.08,
                           .0155 + .0005 * math.sin(k * .8 + i),
                           rug[2] + math.sin(a) * r * .88))
        tube("Irregular braided jute coil", points, .0022,
             "jute_light" if i % 3 == 0 else "jute", 5, True)
    # Short stitches bridge adjacent coils, giving the braid a woven rhythm.
    for i in range(36):
        a = i * math.tau / 36
        r = .245
        R("Radial flax binding stitch", (rug[0] + math.cos(a) * r * 1.08, .017, rug[2] + math.sin(a) * r * .88),
          (rug[0] + math.cos(a + .025) * (r + .014) * 1.08, .017,
           rug[2] + math.sin(a + .025) * (r + .014) * .88), .0009, "jute_light")

    # Keep articulated lamp sections separate; join every other coherent prop.
    return finish_groups()
