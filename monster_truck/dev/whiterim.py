import numpy as np, sys
from PIL import Image, ImageFilter
RC=float(sys.argv[1])
R=np.load("radmap.npy"); ok=np.isfinite(R)
# fill tiny gaps in radius map
Rf=np.where(ok,R,9.0).astype(np.float32)
img=Image.fromarray(Rf,mode='F').filter(ImageFilter.MinFilter(3)); Rd=np.asarray(img)
w=np.clip((RC-Rd)/0.004,0,1)
w=np.asarray(Image.fromarray((w*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))).astype(float)/255
bc=np.asarray(Image.open("Red_Monster_Truck_basecolor.jpg").convert("RGB")).astype(float)/255
L=bc@[0.2126,0.7152,0.0722]
Lb=np.asarray(Image.fromarray((L*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(float)/255
detail=np.clip(L/(Lb+0.02),0.3,1.4); v=np.clip(0.93*(0.6+0.4*detail),0.45,0.97)
white=np.stack([v,v*0.995,v*0.98],-1); soft=w[...,None]; out=bc*(1-soft)+white*soft
Image.fromarray((out*255).clip(0,255).astype(np.uint8)).save("Truck_basecolor_whiterims.png")
s2=np.asarray(Image.fromarray((w*255).astype(np.uint8)).resize((2048,2048),Image.BILINEAR)).astype(float)/255
rm=np.asarray(Image.open("Truck_rm_paint.png").convert("RGB")).astype(float)
rm[...,1]=rm[...,1]*(1-s2)+255*0.38*s2; rm[...,2]=rm[...,2]*(1-s2)
Image.fromarray(rm.clip(0,255).astype(np.uint8)).save("Truck_rm_whiterims.png")
cc=np.asarray(Image.open("Truck_clearcoat.png").convert("L")).astype(float); cc=np.maximum(cc,255*0.3*s2)
Image.fromarray(cc.astype(np.uint8)).convert("RGB").save("Truck_clearcoat_whiterims.png")
print("cover",(w>0.5).mean())
