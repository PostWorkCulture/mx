import bpy, numpy as np, json, math, time, sys
from mathutils import Vector, Matrix
T=time.time()
def log(*a): print(f"[{time.time()-T:6.1f}s]",*a,flush=True)
BODY_T=int(sys.argv[-2]); WHEEL_T=int(sys.argv[-1])
bpy.ops.wm.open_mainfile(filepath="/home/claude/mx/v2/imported_merged.blend")
body=bpy.data.objects["Body"]; body.data.name="Body"
W=json.load(open("/home/claude/mx/work/cand4.json"))
names=["FL","FR","RL","RR"]
def assign_faces(me):
    n=len(me.polygons); cen=np.empty(n*3); me.polygons.foreach_get("center",cen); cen=cen.reshape(-1,3)
    out=np.full(n,-1)
    for i,k in enumerate(names):
        c=np.array(W[k]["c"]); a=np.array(W[k]["a"]); r=W[k]["r"]
        d=cen-c; t=d@a; rad=np.linalg.norm(d-np.outer(t,a),axis=1)
        m=(rad<r+0.012)&(t>-0.062)&(t<0.06)&~((rad>r+0.005)&((t<-0.042)|(t>0.05)))&~((t<-0.05)&(rad<0.05))
        out[m]=i
    return out
bpy.context.view_layer.objects.active=body; body.select_set(True)
wheels={}
for i,k in enumerate(names):
    me=body.data; sel=assign_faces(me)==i
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_mode(type='FACE'); bpy.ops.mesh.select_all(action='DESELECT'); bpy.ops.object.mode_set(mode='OBJECT')
    me.polygons.foreach_set("select",sel); me.update()
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.separate(type='SELECTED'); bpy.ops.object.mode_set(mode='OBJECT')
    o=[x for x in bpy.context.selected_objects if x!=body][0]; o.name=o.data.name="Wheel_"+k; o.select_set(False); wheels[k]=o
    log("sep",k,len(o.data.polygons))
S=5.0
body.data.transform(Matrix.Scale(S,4))
for k,o in wheels.items():
    c=Vector(W[k]["c"]); a=Vector(W[k]["a"]).normalized()
    tgt=Vector((1,0,0)) if a.x>0 else Vector((-1,0,0))
    o.data.transform(Matrix.Translation(-c)); o.data.transform(a.rotation_difference(tgt).to_matrix().to_4x4()); o.data.transform(Matrix.Scale(S,4))
    o.location=c*S
fy=(wheels["FL"].location.y+wheels["FR"].location.y)/2; fx=(abs(wheels["FL"].location.x)+abs(wheels["FR"].location.x))/2
ry=(wheels["RL"].location.y+wheels["RR"].location.y)/2; rx=(abs(wheels["RL"].location.x)+abs(wheels["RR"].location.x))/2
wz=0.525
for k,(x,y) in {"FL":(-fx,fy),"FR":(fx,fy),"RL":(-rx,ry),"RR":(rx,ry)}.items(): wheels[k].location=(x,y,wz)
log("wheel pos",fx,fy,rx,ry)
# high-poly copies
hp={}
for o in [body]+list(wheels.values()):
    c=o.copy(); c.data=o.data.copy(); c.name=o.name+"_HP"; bpy.context.scene.collection.objects.link(c); hp[o.name]=c
# LP material
src=body.active_material
lp=src.copy(); lp.name="Truck_Paint"
for o in [body]+list(wheels.values()): o.data.materials.clear(); o.data.materials.append(lp)
def dec(o,target):
    n=len(o.data.polygons); m=o.modifiers.new("Dec","DECIMATE"); m.ratio=target/n; m.use_collapse_triangulate=True
    for x in bpy.context.selected_objects: x.select_set(False)
    bpy.context.view_layer.objects.active=o; o.select_set(True); bpy.ops.object.modifier_apply(modifier="Dec")
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(75))
    log("dec",o.name,n,"->",len(o.data.polygons))
dec(body,BODY_T)
for o in wheels.values(): dec(o,WHEEL_T)
for o in hp.values(): o.data.shade_smooth() if hasattr(o.data,'shade_smooth') else None
bpy.ops.wm.save_as_mainfile(filepath=f"/home/claude/mx/v2/prebake_{BODY_T}.blend")
log("saved")
