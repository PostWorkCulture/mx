import bpy, time, sys
T=time.time()
def log(*a): print(f"[{time.time()-T:6.1f}s]",*a,flush=True)
SRC=sys.argv[-2]; RES=int(sys.argv[-1])
bpy.ops.wm.open_mainfile(filepath=SRC)
sc=bpy.context.scene; sc.render.engine='CYCLES'; sc.cycles.device='CPU'; sc.cycles.samples=4
sc.render.bake.margin=8
img=bpy.data.images.new("Truck_normal_baked",RES,RES,alpha=False,float_buffer=False)
img.generated_color=(0.5,0.5,1,1); img.colorspace_settings.name='Non-Color'
mat=bpy.data.materials["Truck_Paint"]; nt=mat.node_tree
bn=nt.nodes.new("ShaderNodeTexImage"); bn.name="BAKE"; bn.image=img; bn.interpolation='Linear'
for n in nt.nodes: n.select=False
bn.select=True; nt.nodes.active=bn
order=["Body","Wheel_FL","Wheel_FR","Wheel_RL","Wheel_RR"]
for i,name in enumerate(order):
    lp=bpy.data.objects[name]; hp=bpy.data.objects[name+"_HP"]
    for o in bpy.data.objects: o.select_set(False); o.hide_render=False
    hp.select_set(True); lp.select_set(True); bpy.context.view_layer.objects.active=lp
    sc.render.bake.use_clear = (i==0)
    bpy.ops.object.bake(type='NORMAL',use_selected_to_active=True,cage_extrusion=0.02,max_ray_distance=0.08,normal_space='TANGENT',margin=8,use_clear=(i==0),target='IMAGE_TEXTURES')
    log("baked",name)
img.filepath_raw=SRC.replace("prebake_","nbake_").replace(".blend",".png"); img.file_format='PNG'; img.save()
# rewire LP normal map
nm=[n for n in nt.nodes if n.type=='NORMAL_MAP'][0]
nt.links.new(bn.outputs['Color'],nm.inputs['Color'])
old=[n for n in nt.nodes if n.type=='TEX_IMAGE' and n.image and n.image.name.endswith('normal.png')][0]; nt.nodes.remove(old)
bpy.ops.wm.save_as_mainfile(filepath=SRC.replace("prebake","baked"))
log("done")
