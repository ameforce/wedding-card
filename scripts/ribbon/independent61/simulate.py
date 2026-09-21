"""Offline cloth with an original authored 3D rest surface, fixed rest lengths and endpoint forces.
Flat coordinates are retained as diagnostics, not as a manufacturing-pattern claim.
"""
from pathlib import Path
import sys,json,time,hashlib
import numpy as np,scipy.sparse as sp
import ipctk
from scipy.sparse.linalg import spsolve
sys.stdout.reconfigure(encoding='utf-8')
import argparse
HERE=Path(__file__).resolve().parent
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--out',required=True);args=p.parse_args()
OUT=Path(args.out).resolve();OUT.mkdir(parents=True,exist_ok=False)
(OUT/'source.py').write_bytes(Path(__file__).read_bytes())
d=np.load(HERE/'source-rest.npz');x=d['vertices'].copy();q=d['faces'];flat=d['flatRest'];a=int(d['across']);n=len(x);size=x.size
f=np.array([t for z in q for t in ((z[0],z[1],z[2]),(z[0],z[2],z[3]))],dtype=np.int32)
edges=np.unique(np.sort(np.vstack([f[:,[0,1]],f[:,[1,2]],f[:,[2,0]]]),axis=1),axis=0).astype(np.int32);ea,eb=edges.T
paper=np.array([[i,j,k] for i in (-5.95,5.95) for j in (2.2,2.76) for k in (-22.,22.)])
pf=np.array([(0,1,3),(0,3,2),(4,6,7),(4,7,5),(0,4,5),(0,5,1),(2,3,7),(2,7,6),(0,2,6),(0,6,4),(1,5,7),(1,7,3)],dtype=np.int32)
af=np.vstack([f,pf+n]);ae=np.unique(np.sort(np.vstack([af[:,[0,1]],af[:,[1,2]],af[:,[2,0]]]),axis=1),axis=0).astype(np.int32)
def full(v):return np.vstack([v,paper])
mesh=ipctk.CollisionMesh(full(x),ae,af)
if ipctk.has_intersections(mesh,full(x)):raise ValueError('Initial surface intersects')
barrier=ipctk.BarrierPotential(.015,1e8);rest=np.linalg.norm(x[ea]-x[eb],axis=1);spring_k=5000.
ii=ea[:,None]*3+np.arange(3);jj=eb[:,None]*3+np.arange(3)
rr=np.concatenate([np.repeat(z,3,axis=1).ravel() for z in (ii,ii,jj,jj)]);cc=np.concatenate([np.tile(z,(1,3)).ravel() for z in (ii,jj,ii,jj)])
lr=[];lc=[];lv=[];count=0
for i in range(n//a):
    for j in range(a):
        for ids in ([[(i-1)*a+j,i*a+j,(i+1)*a+j]] if 0<i<n//a-1 else [])+([[i*a+j-1,i*a+j,i*a+j+1]] if 0<j<a-1 else []):
            lr.extend([count]*3);lc.extend(ids);lv.extend([1.,-2.,1.]);count+=1
L=sp.coo_matrix((lv,(lr,lc)),shape=(count,n)).tocsc();bend=sp.kron(L.T@L,sp.eye(3),format='csc')*.2
pins=np.r_[np.arange(a),np.arange(n-a,n)];pd=(pins[:,None]*3+np.arange(3)).ravel();initial=x.copy();velocity=np.zeros_like(x)
def pull(seconds):
    frame=seconds*60+1
    if frame<=10:return np.array([0.,0.,0.])
    if frame<=120:
        t=(frame-10)/110;return np.array([6*t,-2*t,-4*t])
    t=min(1,(frame-120)/240);return np.array([6+2*t,-2-6*t,-4-42*t])
def step(start,vel,t,dt):
    inertia=.003/dt**2;diag=np.full(size,inertia);diag[pd]+=1e5;constant=sp.diags(diag,format='csc')+bend
    pred=start+vel*dt;pred[:,2]-=.1*dt*dt
    offset=pull(t+dt);target=initial[pins].copy();target[:a]+=offset*[-1,1,1];target[a:]+=offset
    def objective(v,derivatives=False):
        collisions=ipctk.NormalCollisions();collisions.build(mesh,full(v),.015)
        delta=v-pred;pin_delta=v[pins]-target;e=v[ea]-v[eb];length=np.linalg.norm(e,axis=1);error=length-rest
        value=.5*inertia*np.sum(delta*delta)+.5e5*np.sum(pin_delta*pin_delta)+.5*spring_k*np.sum(error*error)+.5*np.dot(v.ravel(),bend@v.ravel())+barrier(collisions,mesh,full(v))
        if not derivatives:return value
        grad=inertia*delta;grad[pins]+=1e5*pin_delta;force=spring_k*(error/np.maximum(length,1e-12))[:,None]*e;np.add.at(grad,ea,force);np.add.at(grad,eb,-force)
        gradient=grad.ravel()+bend@v.ravel()+barrier.gradient(collisions,mesh,full(v))[:size]
        hessian=constant+barrier.hessian(collisions,mesh,full(v),ipctk.PSDProjectionMethod.CLAMP)[:size,:size]
        normal=e/np.maximum(length[:,None],1e-12);nn=normal[:,:,None]*normal[:,None,:];factor=np.maximum(0,1-rest/np.maximum(length,1e-12));blocks=spring_k*(nn+factor[:,None,None]*(np.eye(3)[None]-nn))
        hessian+=sp.coo_matrix((np.concatenate([blocks.ravel(),-blocks.ravel(),-blocks.ravel(),blocks.ravel()]),(rr,cc)),shape=(size,size)).tocsc()
        return value,gradient,hessian
    y=start.copy()
    for iteration in range(32):
        value,gradient,hessian=objective(y,True)
        gmax=float(np.max(abs(gradient)))
        if gmax<.05:break
        direction=spsolve(hessian,-gradient).reshape(-1,3);largest=np.linalg.norm(direction,axis=1).max()
        if largest>.15:direction*=.15/largest
        alpha=min(1,ipctk.compute_collision_free_stepsize(mesh,full(y),full(y+direction)));slope=np.dot(gradient,direction.ravel());accepted=False
        for _ in range(25):
            candidate=y+alpha*direction
            if objective(candidate)<=value+1e-4*alpha*slope:accepted=True;break
            alpha*=.5
        if not accepted or alpha<1e-10:break
        y=candidate
    ccd=float(ipctk.compute_collision_free_stepsize(mesh,full(start),full(y)))
    return y,ccd,gmax,iteration+1
positions=[x.copy()];times=[0.];samples=[x.copy()];history=[];t=0.;dt=1/120;started=time.monotonic();rejected=0;sample_count=180
def save():
    np.savez_compressed(OUT/'simulation.npz',vertices=np.array(samples),faces=f,across=a,flatRest=flat,sections=d['sections'],solverRestPositions=initial,fps=30)
    np.savez_compressed(OUT/'continuous-path.npz',vertices=np.array(positions),times=np.array(times),faces=f,across=a,flatRest=flat,sections=d['sections'],solverRestPositions=initial)
    (OUT/'progress.json').write_text(json.dumps({'frames':history,'acceptedSteps':len(times)-1,'rejectedSteps':rejected,'admitted':False},indent=2))
for frame in range(1,sample_count):
    end=frame/30
    while t<end-1e-10:
        h=min(dt,end-t);previous=x.copy();candidate,ccd,gmax,iterations=step(previous,velocity,t,h)
        if ccd<1. or gmax>5:
            rejected+=1;dt=h*.5
            if dt<1/30720:
                save();raise ValueError(f'Adaptive step limit at {t}: ccd={ccd} residual={gmax}')
            continue
        x=candidate;velocity=(x-previous)/h*(.995**(h*60));t+=h
        positions.append(x.copy());times.append(t)
        if len(times)%50==0:print(json.dumps({'acceptedSteps':len(times)-1,'time':t,'stepSeconds':h,'seconds':time.monotonic()-started}),flush=True)
        dt=min(1/120,h*1.5)
    samples.append(x.copy())
    if frame%5==0 or frame==sample_count-1:
        ratios=np.linalg.norm(x[ea]-x[eb],axis=1)/rest
        row={'frame':frame,'time':t,'acceptedSteps':len(times)-1,'rejectedSteps':rejected,'dt':dt,'residual':gmax,'edgeRatioP99':float(np.quantile(ratios,.99)),'edgeRatioMax':float(ratios.max()),'maxZ':float(x[:,2].max()),'intersections':bool(ipctk.has_intersections(mesh,full(x))),'seconds':time.monotonic()-started};history.append(row);print(json.dumps(row),flush=True)
        save()
save();print('ADAPTIVE_PULL_FINISHED',flush=True)
