"""Independently replay all fine render-path files and their cross-file boundaries."""
from pathlib import Path
import sys,json,time,hashlib
import numpy as np,ipctk
sys.stdout.reconfigure(encoding='utf-8');import argparse
p=argparse.ArgumentParser();p.add_argument('--source',required=True);args=p.parse_args();OUT=Path(args.source).resolve();complete=json.loads((OUT/'complete.json').read_text());start=time.monotonic()
if hashlib.sha256((OUT.parent/'continuous-path.npz').read_bytes()).hexdigest()!=complete['sourceSha256']:raise ValueError('Physical source hash differs')
paper=np.array([[i,j,k] for i in (-5.95,5.95) for j in (2.2,2.76) for k in (-22.,22.)]);pf=np.array([(0,1,3),(0,3,2),(4,6,7),(4,7,5),(0,4,5),(0,5,1),(2,3,7),(2,7,6),(0,2,6),(0,6,4),(1,5,7),(1,7,3)],dtype=np.int32)
def full(x):return np.vstack([x,paper])
previous=None;previous_time=None;mesh=None;count=0;violations=[];min_area=float('inf');source_faces=None
for part in complete['parts']:
    path=OUT/'path-parts'/part['file']
    if hashlib.sha256(path.read_bytes()).hexdigest()!=part['sha256']:raise ValueError('Path part hash differs')
    data=np.load(path);faces=data['faces'];v=data['vertices'];times=data['times']
    if len(v)!=part['count']:raise ValueError('Part count differs')
    if mesh is None:
        n=v.shape[1];af=np.vstack([faces,pf+n]);ae=np.unique(np.sort(np.vstack([af[:,[0,1]],af[:,[1,2]],af[:,[2,0]]]),axis=1),axis=0).astype(np.int32);mesh=ipctk.CollisionMesh(full(v[0]),ae,af);source_faces=faces.copy()
    elif not np.array_equal(source_faces,faces):raise ValueError('Render topology changed')
    for x,t in zip(v,times):
        if previous_time is not None and t<=previous_time:raise ValueError('Render time is not monotonic')
        hit=bool(ipctk.has_intersections(mesh,full(x)));ccd=1. if previous is None else float(ipctk.compute_collision_free_stepsize(mesh,full(previous),full(x)))
        inside=int(((abs(x[:,0])<5.95)&(x[:,1]>2.2)&(x[:,1]<2.76)&(abs(x[:,2])<22)).sum())
        area=float((np.linalg.norm(np.cross(x[faces[:,1]]-x[faces[:,0]],x[faces[:,2]]-x[faces[:,0]]),axis=1)*.5).min());min_area=min(area,min_area)
        if hit or ccd!=1. or inside or area<=1e-10:violations.append({'sample':count,'time':float(t),'intersections':hit,'ccd':ccd,'insidePaper':inside,'minimumArea':area})
        previous=x.copy();previous_time=float(t);count+=1
    print(json.dumps({'checkedSamples':count,'violations':len(violations),'seconds':time.monotonic()-start}),flush=True)
result={'checkedSamples':count,'checkedContinuousSegments':count-1,'violations':violations,'minimumTriangleArea':min_area,'completeRecordSha256':hashlib.sha256((OUT/'complete.json').read_bytes()).hexdigest(),'seconds':time.monotonic()-start,'admitted':False};(OUT/'independent-verification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
if violations:raise SystemExit(1)
