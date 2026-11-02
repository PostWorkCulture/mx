import numpy as np
N=4096
R=np.full((N,N),np.nan,dtype=np.float32); X=np.full((N,N),np.nan,dtype=np.float32)
# barycentric sample grid
g=8; bs=[(i/g,j/g) for i in range(g+1) for j in range(g+1-i)]; B=np.array([(a,b,1-a-b) for a,b in bs])  # (S,3)
for k in ["FL","FR","RL","RR"]:
    d=np.load(f"wheel_{k}.npz"); uv=d["uv"]; co=d["co"]  # (T,3,2),(T,3,3)
    vr=np.hypot(co[...,1],co[...,2]); vx=np.abs(co[...,0])*np.sign(-co[...,0] if k[1]=='L' else co[...,0])  # outward positive
    P=np.einsum('sk,tkd->tsd',B,uv); r=np.einsum('sk,tk->ts',B,vr); xo=np.einsum('sk,tk->ts',B,vx)
    px=(P[...,0]*N).astype(int).clip(0,N-1); py=((1-P[...,1])*N).astype(int).clip(0,N-1)
    R[py.ravel(),px.ravel()]=r.ravel(); X[py.ravel(),px.ravel()]=xo.ravel()
np.save("radmap.npy",R); np.save("xmap.npy",X)
print("covered",np.isfinite(R).mean())
