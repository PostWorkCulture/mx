import os as _os
import bpy, os, sys
SRC=sys.argv[-3]; OUT=sys.argv[-2]; FMT=sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=SRC)
for o in list(bpy.data.objects):
    if o.name.endswith("_HP"): bpy.data.objects.remove(o,do_unlink=True)
bpy.ops.outliner.orphans_purge(do_recursive=True) if False else None
import bmesh, math
body=bpy.data.objects["Body"]
liner=bpy.data.materials.new("WheelWell"); liner.use_nodes=True
bs=liner.node_tree.nodes["Principled BSDF"]; bs.inputs["Base Color"].default_value=(0.012,0.011,0.010,1); bs.inputs["Roughness"].default_value=0.85
liner.use_backface_culling=False
for name in ["Body","Wheel_FL","Wheel_FR","Wheel_RL","Wheel_RR"]:
    o=bpy.data.objects[name]; me=o.data
    if "WheelWell" not in me.materials: me.materials.append(liner)
    idx=list(me.materials).index(liner)
    bm=bmesh.new(); bm.from_mesh(me)
    if name!="Body":
        # drop small loose islands (stray fragments caught in the wheel cut)
        bm.faces.ensure_lookup_table(); seenf=set(); isl=[]
        for f0 in bm.faces:
            if f0 in seenf: continue
            st=[f0]; comp=[]
            while st:
                f=st.pop()
                if f in seenf: continue
                seenf.add(f); comp.append(f)
                for e in f.edges:
                    for g in e.link_faces:
                        if g not in seenf: st.append(g)
            isl.append(comp)
        isl.sort(key=len,reverse=True)
        drop=[f for c in isl if len(c)<0.03*len(bm.faces) for f in c]
        print(name,"islands",len(isl),"dropped faces",len(drop))
        bmesh.ops.delete(bm,geom=drop,context='FACES')
        # clean inner side: cut everything inboard of the tread and close with a round disc
        side=1 if o.location.x>0 else -1   # outward = +side in local X
        ax=[side*v.co.x for v in bm.verts if (v.co.y**2+v.co.z**2)**0.5>0.50]
        import numpy as _np
        ax=_np.array(ax); hst,edges=_np.histogram(ax,bins=60,range=(-0.32,0.28)); thr=0.3*_np.median(hst[hst>0])
        xin=-0.15
        cut=[f for f in bm.faces if side*f.calc_center_median().x<xin-0.004]
        bmesh.ops.delete(bm,geom=cut,context='FACES')
        lv=[v for v in bm.verts if not v.link_faces]; bmesh.ops.delete(bm,geom=lv,context='VERTS')
        segs=72
        if "WheelHub" not in me.materials:
            hubm=bpy.data.materials.get("WheelHub") or bpy.data.materials.new("WheelHub"); hubm.use_nodes=True
            hb=hubm.node_tree.nodes["Principled BSDF"]; hb.inputs["Base Color"].default_value=(0.05,0.05,0.055,1); hb.inputs["Metallic"].default_value=0.6; hb.inputs["Roughness"].default_value=0.45
            me.materials.append(hubm)
        hidx=list(me.materials).index(bpy.data.materials["WheelHub"])
        prof=[(0.0,0.515),(-0.022,0.503),(-0.042,0.47),(-0.054,0.42),(-0.055,0.37),(-0.047,0.325),(-0.03,0.297),(-0.008,0.286),(0.02,0.282)]
        rings=[]
        for (dx,rr) in prof:
            rings.append([bm.verts.new((side*(xin+dx), rr*math.cos(2*math.pi*i/segs), rr*math.sin(2*math.pi*i/segs))) for i in range(segs)])
        for a,b_ in zip(rings[:-1],rings[1:]):
            for i in range(segs):
                j=(i+1)%segs
                f=bm.faces.new((a[i],a[j],b_[j],b_[i]) if side>0 else (a[i],b_[i],b_[j],a[j])); f.material_index=idx; f.smooth=True
        cvx=bm.verts.new((side*(xin+0.02),0,0)); last=rings[-1]
        for i in range(segs):
            f=bm.faces.new((cvx,last[i],last[(i+1)%segs])); f.material_index=hidx; f.smooth=False
        print(name,"inner disc at",round(xin,3),"cut faces",len(cut))
    bd=[]
    adj={}
    for e in bd:
        for v in e.verts: adj.setdefault(v,[]).append(e)
    seen=set(); newf=[]; nloops=0
    # find largest loop size first
    _seen=set(); maxloop=0
    for e in bd:
        if e in _seen: continue
        st=[e]; n=0
        while st:
            x=st.pop()
            if x in _seen: continue
            _seen.add(x); n+=1
            for v in x.verts: st.extend(y for y in adj[v] if y not in _seen)
        maxloop=max(maxloop,n)
    for e in bd:
        if e in seen: continue
        comp=[]; st=[e]
        while st:
            x=st.pop()
            if x in seen: continue
            seen.add(x); comp.append(x)
            for v in x.verts: st.extend(y for y in adj[v] if y not in seen)
        if len(comp)<3 or len(comp)<0.5*maxloop: continue
        vs={v for x in comp for v in x.verts}
        c=sum((v.co for v in vs),vs.pop().co*0)/ (len(vs)+1) if False else None
        cen=sum((v.co for x in comp for v in x.verts), comp[0].verts[0].co*0)/(2*len(comp))
        cv=bm.verts.new(cen); nloops+=1
        for x in comp:
            lf=x.link_faces[0]
            # orient opposite to the adjacent face's winding along this edge
            v1,v2=x.verts
            for i,l in enumerate(lf.loops):
                if l.edge==x: 
                    if l.vert==v1: v1,v2=v2,v1
                    break
            try: newf.append(bm.faces.new((v1,v2,cv)))
            except ValueError: pass
    for f in newf: f.material_index=idx; f.smooth=False
    print(name,"capped loops",nloops,"tris",len(newf))
    bm.to_mesh(me); bm.free(); me.update()

import math
LR=float(_os.environ.get("LINER_R","0.63"))
bm=bmesh.new(); bm.from_mesh(body.data); idx=list(body.data.materials).index(liner)
for k in ["FL","FR","RL","RR"]:
    w=bpy.data.objects["Wheel_"+k]; c=w.location.copy(); side=1 if c.x>0 else -1
    x_in=c.x-side*0.34; x_out=c.x+side*0.10
    segs=40; a0=math.radians(12); a1=math.radians(168)
    rows=[]
    for x in (x_in,x_out):
        rows.append([bm.verts.new((x, c.y+LR*math.cos(a0+(a1-a0)*i/segs), c.z+LR*math.sin(a0+(a1-a0)*i/segs))) for i in range(segs+1)])
    for i in range(segs):
        f=bm.faces.new((rows[0][i],rows[0][i+1],rows[1][i+1],rows[1][i])); f.material_index=idx; f.smooth=True
    # inboard wall (half disc) closing the arch
    cv=bm.verts.new((x_in,c.y,c.z))
    for i in range(segs):
        f=bm.faces.new((cv,rows[0][i+1],rows[0][i])); f.material_index=idx
bm.to_mesh(body.data); bm.free(); body.data.update()
for k in ["FL","FR","RL","RR"]:
    w=bpy.data.objects["Wheel_"+k]; mw=w.matrix_world.copy(); w.parent=body; w.matrix_world=mw
mat=bpy.data.materials["Truck_Paint"]; nt=mat.node_tree; bsdf=nt.nodes["Principled BSDF"]
rmn=[n for n in nt.nodes if n.type=='TEX_IMAGE' and n.image and n.image.name.endswith('rm.jpg')][0]
rmn.image=bpy.data.images.load("/home/claude/mx/v2/Truck_rm_paint.png"); rmn.image.colorspace_settings.name='Non-Color'
cc=nt.nodes.new("ShaderNodeTexImage"); cc.image=bpy.data.images.load("/home/claude/mx/v2/Truck_clearcoat.png"); cc.image.colorspace_settings.name='Non-Color'
nt.links.new(cc.outputs['Color'],bsdf.inputs['Coat Weight']); bsdf.inputs['Coat Roughness'].default_value=0.04
import os as _os
if _os.environ.get("WHITE"):
    bcn=[n for n in nt.nodes if n.type=='TEX_IMAGE' and n.image and 'basecolor' in n.image.name][0]
    bcn.image=bpy.data.images.load("/home/claude/mx/v2/Truck_basecolor_whiterims.png"); bcn.image.name="Truck_basecolor"
    rmn.image=bpy.data.images.load("/home/claude/mx/v2/Truck_rm_whiterims.png"); rmn.image.colorspace_settings.name='Non-Color'; rmn.image.name="Truck_rm"
    cc.image=bpy.data.images.load("/home/claude/mx/v2/Truck_clearcoat_whiterims.png"); cc.image.colorspace_settings.name='Non-Color'; cc.image.name="Truck_clearcoat"
img=bpy.data.images["Truck_normal_baked"]; img.filepath=SRC.replace("baked_","nbake_").replace(".blend",".png"); img.source='FILE'; img.reload()
bpy.ops.export_scene.gltf(filepath=OUT,export_format='GLB',export_image_format=FMT,export_image_quality=92,export_jpeg_quality=92,export_yup=True,export_apply=True)
print("size",round(os.path.getsize(OUT)/1e6,2),"MB")
for im in bpy.data.images:
    if im.source=='FILE' and not im.packed_file: im.pack()
bpy.ops.wm.save_as_mainfile(filepath=OUT.replace(".glb",".blend"),compress=True)
