"""Build the big-wheel monster truck from the baked hero/LOD truck.
usage: python mt_build.py <baked.blend> <normal_png> <scheme> <lod:0|1> <out.glb>
Blender coords: Z up, front = -Y.  glTF export: front = +Z, up = +Y.
"""
import bpy, bmesh, math, sys, os, time
import numpy as np
from mathutils import Vector, Matrix
T0 = time.time()
def log(*a): print(f"[{time.time()-T0:6.1f}s]", *a, flush=True)

SRC, NRM, SCHEME, LOD, OUT = sys.argv[-5], sys.argv[-4], sys.argv[-3], int(sys.argv[-2]), sys.argv[-1]
TEX = "/home/claude/mx/mt"
SEG = 12 if LOD else 20

# ---------------- dimensions ----------------
WS, WX = 1.75, 1.85              # wheel radial / axial scale
R = 0.525 * WS                   # tyre radius 0.919
TRACK = 1.56
YF, YR = -1.62, 1.55             # axle y (front is -Y)
LIFT = 0.98
FRAME_Z = 1.24

bpy.ops.wm.open_mainfile(filepath=SRC)
for o in list(bpy.data.objects):
    if o.name.endswith("_HP"): bpy.data.objects.remove(o, do_unlink=True)
body = bpy.data.objects["Body"]
wheels = {k: bpy.data.objects["Wheel_" + k] for k in ["FL", "FR", "RL", "RR"]}

# ---------------- materials ----------------
def pmat(name, col, metal, rough, coat=0.0, emis=None):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    b.inputs["Coat Weight"].default_value = coat
    b.inputs["Coat Roughness"].default_value = 0.05
    return m
def lin(c):  # sRGB 0-255 -> linear
    c = np.array(c) / 255.0
    return tuple(np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4))

SCH = {
    "lime_black":   dict(spring=(lin((148, 220, 26)), 0.1, 0.25, 1.0), shock=(lin((20, 20, 22)), 0.7, 0.3)),
    "stealth_gold": dict(spring=(lin((214, 165, 52)), 1.0, 0.25, 0.0), shock=(lin((18, 18, 20)), 0.7, 0.3)),
}[SCHEME]
M_FRAME = pmat("MT_Frame", lin((16, 16, 17)), 0.35, 0.45)
M_DARK = pmat("MT_Axle", lin((34, 34, 36)), 0.6, 0.45)
M_CHROME = pmat("MT_Chrome", lin((225, 225, 228)), 1.0, 0.1)
M_SPRING = pmat("MT_Spring", SCH["spring"][0], SCH["spring"][1], SCH["spring"][2], SCH["spring"][3])
M_SHOCK = pmat("MT_Shock", *SCH["shock"])
M_WELL = bpy.data.materials.get("WheelWell") or pmat("WheelWell", (0.012, 0.011, 0.010), 0.0, 0.85)
M_HUB = pmat("WheelHub", (0.05, 0.05, 0.055), 0.6, 0.45)

# body paint material -> scheme textures
mat = bpy.data.materials["Truck_Paint"]; nt = mat.node_tree; bsdf = nt.nodes["Principled BSDF"]
def img(path, noncolor):
    im = bpy.data.images.load(path, check_existing=False)
    if noncolor: im.colorspace_settings.name = 'Non-Color'
    return im
bcn = [n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image and 'basecolor' in n.image.name.lower()][0]
bcn.image = img(f"{TEX}/bc_{SCHEME}.jpg", False); bcn.image.name = f"MT_{SCHEME}_basecolor"
rmn = [n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image and n.image.name.endswith('rm.jpg')][0]
rmn.image = img(f"{TEX}/rm_{SCHEME}.png", True); rmn.image.name = f"MT_{SCHEME}_rm"
cc = nt.nodes.new("ShaderNodeTexImage"); cc.image = img(f"{TEX}/cc_{SCHEME}.png", True); cc.image.name = f"MT_{SCHEME}_coat"
nt.links.new(cc.outputs['Color'], bsdf.inputs['Coat Weight']); bsdf.inputs['Coat Roughness'].default_value = 0.04
nimg = bpy.data.images["Truck_normal_baked"]; nimg.filepath = NRM; nimg.source = 'FILE'; nimg.reload(); nimg.name = "MT_normal"

def ensure_mat(me, m):
    if m.name not in me.materials: me.materials.append(m)
    return list(me.materials).index(m)

# ---------------- wheels: clean inner side, then scale up ----------------
for k, o in wheels.items():
    me = o.data; side = 1 if o.location.x > 0 else -1
    iw = ensure_mat(me, M_WELL); ih = ensure_mat(me, M_HUB)
    bm = bmesh.new(); bm.from_mesh(me)
    seen = set(); isl = []
    for f0 in bm.faces:
        if f0 in seen: continue
        st = [f0]; comp = []
        while st:
            f = st.pop()
            if f in seen: continue
            seen.add(f); comp.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g not in seen: st.append(g)
        isl.append(comp)
    drop = [f for c in isl if len(c) < 0.03 * len(bm.faces) for f in c]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    xin = -0.15
    cut = [f for f in bm.faces if side * f.calc_center_median().x < xin - 0.004]
    bmesh.ops.delete(bm, geom=cut, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    segs = 48 if LOD else 72
    prof = [(0.0, 0.515), (-0.022, 0.503), (-0.042, 0.47), (-0.054, 0.42), (-0.055, 0.37), (-0.047, 0.325), (-0.03, 0.297), (-0.008, 0.286), (0.02, 0.282)]
    rings = [[bm.verts.new((side * (xin + dx), rr * math.cos(2 * math.pi * i / segs), rr * math.sin(2 * math.pi * i / segs))) for i in range(segs)] for dx, rr in prof]
    for a, b in zip(rings[:-1], rings[1:]):
        for i in range(segs):
            j = (i + 1) % segs
            f = bm.faces.new((a[i], a[j], b[j], b[i]) if side > 0 else (a[i], b[i], b[j], a[j])); f.material_index = iw; f.smooth = True
    c = bm.verts.new((side * (xin + 0.02), 0, 0))
    for i in range(segs):
        f = bm.faces.new((c, rings[-1][i], rings[-1][(i + 1) % segs]) if side > 0 else (c, rings[-1][(i + 1) % segs], rings[-1][i])); f.material_index = ih
    bm.to_mesh(me); bm.free()
    me.transform(Matrix.Diagonal((WX, WS, WS, 1)))
    me.update()

# ---------------- body: arch liners at the old wheel spots, then lift ----------------
bm = bmesh.new(); bm.from_mesh(body.data); iw = ensure_mat(body.data, M_WELL)
for k, w in wheels.items():
    c = w.location.copy(); side = 1 if c.x > 0 else -1
    x_in, x_out = c.x - side * 0.34, c.x + side * 0.10
    segs, a0, a1, LR = 40, math.radians(12), math.radians(168), 0.63
    rows = [[bm.verts.new((x, c.y + LR * math.cos(a0 + (a1 - a0) * i / segs), c.z + LR * math.sin(a0 + (a1 - a0) * i / segs))) for i in range(segs + 1)] for x in (x_in, x_out)]
    for i in range(segs):
        f = bm.faces.new((rows[0][i], rows[0][i + 1], rows[1][i + 1], rows[1][i])); f.material_index = iw; f.smooth = True
    # floor of the old arch (closes the pocket from below so you can't see up into the shell)
    cv = bm.verts.new((x_in, c.y, c.z))
    for i in range(segs):
        f = bm.faces.new((cv, rows[0][i + 1], rows[0][i])); f.material_index = iw
bm.to_mesh(body.data); bm.free()
body.data.transform(Matrix.Translation((0, 0, LIFT)))
body.data.update()

# ---------------- mesh helpers ----------------
def new_obj(name, mats, parent=None, loc=(0, 0, 0)):
    me = bpy.data.meshes.new(name); o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    for m in mats: me.materials.append(m)
    o.location = loc
    if parent: o.parent = parent
    return o
def basis(d):
    d = d.normalized(); up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
    u = d.cross(up).normalized(); v = d.cross(u).normalized(); return d, u, v
def cyl(bm, a, b, r, mi, seg=SEG, cap=True, r2=None):
    a, b = Vector(a), Vector(b); d, u, v = basis(b - a); r2 = r if r2 is None else r2
    ra = [bm.verts.new(a + (u * math.cos(t) + v * math.sin(t)) * r) for t in [2 * math.pi * i / seg for i in range(seg)]]
    rb = [bm.verts.new(b + (u * math.cos(t) + v * math.sin(t)) * r2) for t in [2 * math.pi * i / seg for i in range(seg)]]
    for i in range(seg):
        j = (i + 1) % seg; f = bm.faces.new((ra[i], ra[j], rb[j], rb[i])); f.material_index = mi; f.smooth = True
    if cap:
        f = bm.faces.new(list(reversed(ra))); f.material_index = mi
        f = bm.faces.new(rb); f.material_index = mi
def box(bm, center, size, mi, rot=None):
    m = Matrix.Translation(center) @ (rot.to_4x4() if rot else Matrix()) @ Matrix.Diagonal((*size, 1))
    r = bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    for f in {f for v in r["verts"] for f in v.link_faces}: f.material_index = mi
def sphere(bm, c, r, mi, scale=(1, 1, 1), seg=None):
    seg = seg or SEG
    m = Matrix.Translation(c) @ Matrix.Diagonal((*scale, 1))
    res = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=max(6, seg // 2), radius=r, matrix=m)
    for f in {f for v in res["verts"] for f in v.link_faces}: f.material_index = mi; f.smooth = True
def helix(bm, L, rad, wire, turns, mi):
    n = turns * (12 if LOD else 18); ws = 6 if LOD else 8
    rings = []
    for i in range(n + 1):
        t = i / n; th = t * turns * 2 * math.pi
        p = Vector((rad * math.cos(th), -t * L, rad * math.sin(th)))
        tan = Vector((-rad * math.sin(th) * turns * 2 * math.pi, -L, rad * math.cos(th) * turns * 2 * math.pi)).normalized()
        nrm = Vector((math.cos(th), 0, math.sin(th))); bi = tan.cross(nrm).normalized(); nrm = bi.cross(tan).normalized()
        rings.append([bm.verts.new(p + (nrm * math.cos(2 * math.pi * j / ws) + bi * math.sin(2 * math.pi * j / ws)) * wire) for j in range(ws)])
    for a, b in zip(rings[:-1], rings[1:]):
        for j in range(ws):
            k = (j + 1) % ws; f = bm.faces.new((a[j], a[k], b[k], b[j])); f.material_index = mi; f.smooth = True
def finish(o, bm):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(o.data); bm.free(); o.data.update()
def aim_matrix(origin, target):
    """object matrix whose local -Y points from origin to target (=> glTF local +Z)."""
    d = (Vector(target) - Vector(origin)).normalized()
    q = Vector((0, -1, 0)).rotation_difference(d)
    return Matrix.Translation(origin) @ q.to_matrix().to_4x4()
def set_parent(child, parent):
    mw = child.matrix_world.copy(); child.parent = parent; child.matrix_world = mw
def empty(name, loc, parent):
    e = bpy.data.objects.new(name, None); e.empty_display_size = 0.05; e.empty_display_type = 'SPHERE'
    bpy.context.scene.collection.objects.link(e); e.location = loc; bpy.context.view_layer.update(); set_parent(e, parent); return e

root = bpy.data.objects.new("MonsterTruck", None); bpy.context.scene.collection.objects.link(root)
body.location = (0, 0, 0); body.parent = None; body.matrix_world = Matrix(); body.parent = root
for w in wheels.values(): w.parent = None

# ---------------- static chassis (sprung) ----------------
ch = new_obj("Chassis", [M_FRAME, M_DARK, M_CHROME, M_WELL], root); bm = bmesh.new()
for x in (-0.55, 0.55):
    box(bm, (x, -0.02, FRAME_Z), (0.09, 4.30, 0.14), 0)
for y in (-2.05, -1.1, 0.0, 1.1, 2.0):
    cyl(bm, (-0.55, y, FRAME_Z), (0.55, y, FRAME_Z), 0.05, 0)
box(bm, (0, 0.0, 1.318), (1.84, 3.95, 0.02), 3)                    # floor pan under the shell
box(bm, (0, 0.05, 1.115), (1.15, 3.3, 0.035), 1)                   # skid plate
box(bm, (0.12, -0.45, 1.19), (0.32, 0.36, 0.24), 1)                # transfer case
sphere(bm, (-0.25, -0.75, 1.2), 0.17, 1, (1.0, 1.4, 0.9))          # transmission bell
# front/rear frame horns + cage hoops inside the old wheel arches (visual depth)
for y0, y1 in ((-2.17, -2.45), (2.13, 2.42)):
    for x in (-0.55, 0.55): cyl(bm, (x, y0, FRAME_Z), (x * 0.85, y1, FRAME_Z + 0.1), 0.045, 0)
mounts = {}
for (akey, yA, c) in (("F", YF, 1), ("R", YR, -1)):
    for s, sk in ((-1, "L"), (1, "R")):
        for kk, kq in ((-1, 1), (1, 2)):
            T = Vector((s * 0.78, yA + kk * 0.26 + c * 0.12, 2.03)); B = Vector((s * 1.01, yA + kk * 0.20, R + 0.05))
            mounts[f"{akey}{sk}_{kq}"] = (T, B)
            box(bm, T + Vector((0, 0, 0.08)), (0.14, 0.12, 0.16), 0)   # shock tower tab
        Fl = Vector((s * 0.55, yA + c * 1.10, FRAME_Z - 0.07)); Fu = Vector((s * 0.35, yA + c * 0.95, FRAME_Z + 0.04))
        mounts[f"L{akey}{sk}_lo"] = (Fl, Vector((s * 0.60, yA, R - 0.12)))
        mounts[f"L{akey}{sk}_up"] = (Fu, Vector((s * 0.30, yA, R + 0.14)))
        box(bm, Fl + Vector((0, 0, -0.04)), (0.1, 0.12, 0.1), 0); box(bm, Fu, (0.1, 0.12, 0.08), 0)
    # upper shock crossbar inside body (ties the towers together)
    cyl(bm, (-0.78, yA + c * 0.12, 2.11), (0.78, yA + c * 0.12, 2.11), 0.045, 0)
    for s in (-1, 1): cyl(bm, (s * 0.78, yA + c * 0.12, 2.11), (s * 0.55, yA + c * 0.12, FRAME_Z), 0.045, 0)
finish(ch, bm)

# ---------------- axles ----------------
axles = {}
for (akey, yA, c) in (("F", YF, 1), ("R", YR, -1)):
    ax = new_obj("Axle_" + akey, [M_DARK, M_CHROME, M_FRAME], root, (0, yA, R)); bm = bmesh.new()
    cyl(bm, (-1.16, 0, 0), (1.16, 0, 0), 0.09, 0)
    sphere(bm, (0.18, 0, 0), 0.25, 0, (1.0, 1.0, 0.92))
    cyl(bm, (0.18, 0, 0), (0.18, -c * 0.24, 0), 0.19, 0)                 # diff cover side
    cyl(bm, (0.18, 0, 0), (0.18, c * 0.34, 0), 0.10, 0, r2=0.08)         # pinion snout
    for s in (-1, 1):
        cyl(bm, (s * 1.10, 0, 0), (s * 1.33, 0, 0), 0.17, 0)             # hub / knuckle
        sphere(bm, (s * 1.33, 0, 0), 0.12, 2, (0.3, 1, 1))
        if akey == "F": cyl(bm, (s * 1.08, 0, -0.22), (s * 1.08, 0, 0.22), 0.075, 0)  # kingpin boss
        for kk in (-1, 1):  # lower shock mount tabs
            Bl = mounts[f"{akey}{'L' if s < 0 else 'R'}_{1 if kk < 0 else 2}"][1] - Vector((0, yA, R))
            box(bm, Bl + Vector((0, 0, -0.05)), (0.08, 0.06, 0.14), 2)
        box(bm, (s * 0.60, 0, -0.14), (0.1, 0.12, 0.14), 2)                # lower link bracket
        box(bm, (s * 0.30, 0, 0.15), (0.1, 0.12, 0.12), 2)                 # upper link bracket
    if akey == "F":
        cyl(bm, (-1.05, -0.26, -0.06), (1.05, -0.26, -0.06), 0.035, 1)   # tie rod
        for s in (-1, 1): box(bm, (s * 1.07, -0.13, -0.06), (0.06, 0.28, 0.06), 0)  # steering arms
    finish(ax, bm); axles[akey] = ax
bpy.context.view_layer.update()
for k, w in wheels.items():
    side = -1 if k[1] == "L" else 1
    w.location = (side * TRACK, YF if k[0] == "F" else YR, R)
    bpy.context.view_layer.update(); set_parent(w, axles[k[0]])

# ---------------- shocks, springs, links, driveshafts ----------------
def shock(name, T, B, axle):
    L = (T - B).length
    sb = new_obj(name + "_Body", [M_SHOCK, M_CHROME, M_FRAME]); sb.matrix_world = aim_matrix(T, B); bm = bmesh.new()
    cyl(bm, (-0.045, 0, 0), (0.045, 0, 0), 0.05, 2)                  # top eye
    cyl(bm, (0, -0.03, 0), (0, -0.66, 0), 0.075, 0)                  # body
    cyl(bm, (0, -0.07, 0), (0, -0.10, 0), 0.14, 1)                   # top perch
    cyl(bm, (0.11, -0.10, 0), (0.11, -0.44, 0), 0.042, 0)            # piggyback reservoir
    cyl(bm, (0.0, -0.12, 0), (0.11, -0.12, 0), 0.025, 1)
    finish(sb, bm); set_parent(sb, root)
    ss = new_obj(name + "_Shaft", [M_CHROME, M_FRAME]); ss.matrix_world = aim_matrix(B, T); bm = bmesh.new()
    cyl(bm, (-0.045, 0, 0), (0.045, 0, 0), 0.05, 1)
    cyl(bm, (0, -0.03, 0), (0, -0.70, 0), 0.032, 0)
    cyl(bm, (0, -0.09, 0), (0, -0.12, 0), 0.14, 0)                   # bottom perch
    finish(ss, bm); set_parent(ss, axle)
    Ls = L - 0.085 - 0.105
    sp = new_obj(name + "_Spring", [M_SPRING]); sp.matrix_world = aim_matrix(T + (B - T).normalized() * 0.085, B); bm = bmesh.new()
    helix(bm, Ls, 0.118, 0.021, 9, 0); finish(sp, bm); set_parent(sp, sb)
    empty(name + "_Body_target", B, axle); empty(name + "_Shaft_target", T, root)
    return L, Ls
def link(name, Fm, Am, axle, r=0.042, mats=None):
    L = (Am - Fm).length
    lk = new_obj(name, [M_FRAME, M_CHROME]); lk.matrix_world = aim_matrix(Fm, Am); bm = bmesh.new()
    cyl(bm, (0, -0.05, 0), (0, -(L - 0.05), 0), r, 0)
    sphere(bm, (0, 0, 0), r * 1.45, 1, seg=12); sphere(bm, (0, -L, 0), r * 1.45, 1, seg=12)
    finish(lk, bm); set_parent(lk, root); empty(name + "_target", Am, axle); return L
rest = {}
for key, (T, B) in mounts.items():
    if key.startswith("L"): continue
    akey, side, n = key[0], key[1], key[3]
    rest["Shock_" + key] = shock("Shock_" + key, T, B, axles[akey])
for key, (Fm, Am) in mounts.items():
    if not key.startswith("L"): continue
    akey = key[1]; rest["Link_" + key[1:]] = link("Link_" + key[1:], Fm, Am, axles[akey])
for akey, yA, c, y0 in (("F", YF, 1, -0.63), ("R", YR, -1, -0.27)):
    Fm = Vector((0.12, y0, 1.19)); Am = Vector((0.18, yA + c * 0.34, R))
    L = (Am - Fm).length
    ds = new_obj("Driveshaft_" + akey, [M_DARK, M_CHROME]); ds.matrix_world = aim_matrix(Fm, Am); bm = bmesh.new()
    cyl(bm, (0, -0.06, 0), (0, -(L - 0.06), 0), 0.05, 0)
    for yy in (0.0, -L): box(bm, (0, yy, 0), (0.11, 0.1, 0.11), 1)
    finish(ds, bm); set_parent(ds, root); empty("Driveshaft_" + akey + "_target", Am, axles[akey]); rest["Driveshaft_" + akey] = L


# custom props with rest lengths for the rig (exported as glTF extras)
for k, v in rest.items():
    o = bpy.data.objects.get(k + "_Body") or bpy.data.objects.get(k)
    if isinstance(v, tuple):
        bpy.data.objects[k + "_Body"]["restLength"] = v[0]; bpy.data.objects[k + "_Spring"]["restLength"] = v[1]
    else:
        bpy.data.objects[k]["restLength"] = v
root["wheelRadius"] = R; root["trackHalf"] = TRACK; root["axleFrontZ"] = -YF; root["axleRearZ"] = -YR

# stats
tris = 0
for o in root.children_recursive:
    if o.type == 'MESH':
        o.data.calc_loop_triangles(); tris += len(o.data.loop_triangles)
log("objects", len([o for o in root.children_recursive]), "tris", tris)

# ---------------- export ----------------
for o in bpy.data.objects: o.select_set(False)
root.select_set(True)
for o in root.children_recursive: o.select_set(True)
for im in bpy.data.images:
    if im.source == 'FILE' and not im.packed_file:
        try: im.pack()
        except Exception as e: print("pack fail", im.name, e)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_extras=True,
                          export_image_format='WEBP', export_image_quality=92, export_yup=True, export_apply=True)
log("glb", round(os.path.getsize(OUT) / 1e6, 2), "MB")
bpy.ops.wm.save_as_mainfile(filepath=OUT.replace(".glb", ".blend"), compress=True)
log("done")
