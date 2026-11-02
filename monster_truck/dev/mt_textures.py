import numpy as np
from PIL import Image, ImageFilter
F=lambda a,k,mode="max": np.asarray(Image.fromarray((a*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(k) if mode=="max" else ImageFilter.MinFilter(k)))>127
blur=lambda a,r: np.asarray(Image.fromarray((np.clip(a,0,1)*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))).astype(np.float32)/255
src="/home/claude/mx/v2/Red_Monster_Truck_basecolor.jpg"
bc=np.asarray(Image.open(src).convert("RGB")).astype(np.float32)/255
hsv=np.asarray(Image.open(src).convert("HSV")).astype(np.float32)/255; h,s,v=hsv[...,0],hsv[...,1],hsv[...,2]
mx=bc.max(-1)
# regions
okd=np.load("onbody2k.npy"); okd=np.repeat(np.repeat(okd,2,0),2,1)
R=np.load("/home/claude/mx/v2/radmap.npy"); wheel_cov=np.isfinite(R); wheelreg=F(wheel_cov.astype(np.float32),7)
Rf=np.where(wheel_cov,R,9.0).astype(np.float32); Rd=np.asarray(Image.fromarray(Rf,mode='F').filter(ImageFilter.MinFilter(3)))
rim=np.clip((0.275-Rd)/0.004,0,1)
rim_hard=rim>0.5
rim_ext=rim_hard|(F(rim_hard.astype(np.float32),9)&~wheel_cov&~okd)     # bleed into island margins
rimw=np.maximum(blur(rim_ext.astype(np.float32),0.7),0)*1.0
red=(((h<0.05)|(h>0.92))&(s>0.25)&(v>0.03))
red_open=F(F(red.astype(np.float32),7,"min"),7)          # drop small red specks on black trim
closed=F(F(red_open.astype(np.float32),11),11,"min")
paint=((closed&okd)|(F(red_open.astype(np.float32),9)&red&~okd&~wheelreg))&~rim_ext
# stripes
P=np.load("/home/claude/mx/v2/posmap2k.npy"); P=np.repeat(np.repeat(P,2,0),2,1).astype(np.float32); ok=np.isfinite(P[...,0])
x,y,z=[np.where(ok,P[...,i],-99) for i in range(3)]
sat=(mx-bc.min(-1))/(mx+1e-3)
st=(sat<0.25)&(mx>0.40)&ok&(np.abs(x)<0.42)&(z>1.2)&((y<-1.0)|((y>-0.3)&(y<1.6)))
st=F(F(st.astype(np.float32),5),5,"min"); del P,x,y,z
st_ext=st|(F(st.astype(np.float32),13)&~okd&~wheelreg&(sat<0.3)&(mx>0.35))
paint=paint&~st_ext
pw=blur(paint.astype(np.float32),0.8); sw=blur(st_ext.astype(np.float32),0.8)
ao=np.asarray(Image.open("body_ao.png").convert("L").resize((4096,4096),Image.BILINEAR)).astype(np.float32)/255
shade=np.clip(ao,0,1)**0.75
L=bc@[0.2126,0.7152,0.0722]; Lb=blur(L,6); rimdetail=np.clip(L/(Lb+0.02),0.3,1.4)
rm0=np.asarray(Image.open("/home/claude/mx/v2/Red_Monster_Truck_rm.jpg").convert("RGB")).astype(np.float32)/255
schemes={
 "lime_black":  dict(accent=(148,220,26),paint=(148,220,26),p_rm=(0.22,0.15), stripe=(14,14,15),s_rm=(0.25,0.10), rim=(26,26,27),r_rm=(0.45,0.30),r_cc=0.2),
 "stealth_gold":dict(paint=(17,17,19),p_rm=(0.26,0.40), stripe=(205,155,45),s_rm=(0.30,0.85), rim=(214,165,52),r_rm=(0.28,1.00),r_cc=0.0),
}
for name,S in schemes.items():
    out=bc.copy()
    pc=np.array(S["paint"])/255; out=out*(1-pw[...,None])+(pc[None,None,:]*shade[...,None])*pw[...,None]
    sc=np.array(S["stripe"])/255; out=out*(1-sw[...,None])+(sc[None,None,:]*shade[...,None])*sw[...,None]
    rc=np.array(S["rim"])/255; rv=np.clip(0.62+0.38*rimdetail,0.45,1.15); out=out*(1-rimw[...,None])+(rc[None,None,:]*rv[...,None])*rimw[...,None]
    acw=np.zeros_like(pw)
    if "accent" in S:   # small lime details on the black wheels: beadlock bolts, pinstripe, centre cap
        band=(Rd>0.226)&(Rd<0.276)
        bolts=F(F((band&(L>0.13)).astype(np.float32),3,"min"),5)&(Rd>0.229)&(Rd<0.262)
        stripe_r=np.clip(1-np.abs(Rd-0.2695)/0.0045,0,1)
        cap=np.clip((0.031-Rd)/0.003,0,1)
        acw=np.clip(np.maximum.reduce([blur(bolts.astype(np.float32),0.6),stripe_r,cap]),0,1)*(Rd<0.28)
        ac=np.array(S["accent"])/255; av=np.clip(0.55+0.45*rimdetail,0.45,1.1)
        out=out*(1-acw[...,None])+(ac[None,None,:]*av[...,None])*acw[...,None]
    Image.fromarray((out*255).clip(0,255).astype(np.uint8)).save(f"bc_{name}.jpg",quality=94)
    rm=rm0.copy()
    for w,(ro,me) in [(pw,S["p_rm"]),(sw,S["s_rm"]),(rimw,S["r_rm"]),(acw,(0.25,0.1))]:
        rm[...,1]=rm[...,1]*(1-w)+ro*w; rm[...,2]=rm[...,2]*(1-w)+me*w
    Image.fromarray((rm*255).clip(0,255).astype(np.uint8)).resize((2048,2048),Image.LANCZOS).save(f"rm_{name}.png")
    cc=np.clip(pw+sw+rimw*S["r_cc"]+acw,0,1)
    Image.fromarray((cc*255).astype(np.uint8)).convert("RGB").resize((2048,2048),Image.LANCZOS).save(f"cc_{name}.png")
    Image.fromarray((out*255).clip(0,255).astype(np.uint8)).resize((1024,1024)).save(f"prev_{name}.jpg")
print("paint",paint.mean(),"stripe",st_ext.mean(),"rim",rim_ext.mean())
