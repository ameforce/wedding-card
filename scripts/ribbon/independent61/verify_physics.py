"""Independent replay of every accepted physical timestep, not only render frames."""
from pathlib import Path
import sys,json,time,hashlib
import numpy as np,ipctk
sys.stdout.reconfigure(encoding='utf-8');import argparse
p=argparse.ArgumentParser();p.add_argument('--source',required=True);args=p.parse_args();OUT=Path(args.source).resolve();d=np.load(OUT/'continuous-path.npz');v=d['vertices'];times=d['times'];f=d['faces'];a=int(d['across']);n=v.shape[1];rest=d['solverRestPositions'];flat=d['flatRest']
e=np.unique(np.sort(np.vstack([f[:,[0,1]],f[:,[1,2]],f[:,[2,0]]]),axis=1),axis=0).astype(np.int32)
paper=np.array([[i,j,k] for i in (-5.95,5.95) for j in (2.2,2.76) for k in (-22.,22.)]);pf=np.array([(0,1,3),(0,3,2),(4,6,7),(4,7,5),(0,4,5),(0,5,1),(2,3,7),(2,7,6),(0,2,6),(0,6,4),(1,5,7),(1,7,3)],dtype=np.int32);af=np.vstack([f,pf+n]);ae=np.unique(np.sort(np.vstack([af[:,[0,1]],af[:,[1,2]],af[:,[2,0]]]),axis=1),axis=0).astype(np.int32)
def full(x):return np.vstack([x,paper])
mesh=ipctk.CollisionMesh(full(v[0]),ae,af);rest_lengths=np.linalg.norm(rest[e[:,0]]-rest[e[:,1]],axis=1);flat_lengths=np.linalg.norm(flat[e[:,0]]-flat[e[:,1]],axis=1)
parent=list(range(n))
def find(i):
    while parent[i]!=i:parent[i]=parent[parent[i]];i=parent[i]
    return i
for i,j in e:parent[find(i)]=find(j)
components=len({find(i) for i in range(n)});history=[];release=None;started=time.monotonic()
for index,x in enumerate(v):
    intersects=bool(ipctk.has_intersections(mesh,full(x)));ccd=1. if index==0 else float(ipctk.compute_collision_free_stepsize(mesh,full(v[index-1]),full(x)))
    inside=(abs(x[:,0])<5.95)&(x[:,1]>2.2)&(x[:,1]<2.76)&(abs(x[:,2])<22)
    lengths=np.linalg.norm(x[e[:,0]]-x[e[:,1]],axis=1);ratio=lengths/rest_lengths
    area=np.linalg.norm(np.cross(x[f[:,1]]-x[f[:,0]],x[f[:,2]]-x[f[:,0]]),axis=1)*.5
    if release is None and x[:,2].max()<-22.015:release=float(times[index])
    row={'step':index,'seconds':float(times[index]),'intersections':intersects,'linearCcdFraction':ccd,'insidePaperVertices':int(inside.sum()),'edgeRatioMin':float(ratio.min()),'edgeRatioMax':float(ratio.max()),'edgeRatioP99':float(np.quantile(ratio,.99)),'minTriangleArea':float(area.min())};history.append(row)
    if index%120==0:print(json.dumps(row),flush=True)
def shape_metrics(x):
    centers=x.reshape(-1,a,3).mean(axis=1);sections=d['sections'];result={}
    for label,lo,hi in [('rightBight',3,9),('centerWrap',10,13),('crossing',25,29),('leftBight',29,35)]:
        c=centers[(sections>=lo)&(sections<=hi)];delta=c[-1]-c[0];chord=np.linalg.norm(delta);direction=delta/max(chord,1e-12);deviation=np.linalg.norm((c-c[0])-np.outer((c-c[0])@direction,direction),axis=1);result[label]={'chord':float(chord),'maxChordDeviation':float(deviation.max())}
    return result
violations=[r for r in history if r['intersections'] or r['linearCcdFraction']!=1. or r['insidePaperVertices'] or r['minTriangleArea']<=1e-10]
initial_flat=np.linalg.norm(v[0][e[:,0]]-v[0][e[:,1]],axis=1)/flat_lengths
result={'stepCount':len(v)-1,'connectedComponents':components,'eulerCharacteristic':int(n-len(e)+len(f)),'violations':violations,'fullPaperReleaseSeconds':release,'restModel':'Fixed original authored three-dimensional rest surface; not a flat-pattern fabrication claim.','initialFlatPatternDiagnostic':{'edgeRatioMin':float(initial_flat.min()),'edgeRatioMax':float(initial_flat.max()),'edgeRatioP99':float(np.quantile(initial_flat,.99))},'edgeRatioMin':min(r['edgeRatioMin'] for r in history),'edgeRatioMax':max(r['edgeRatioMax'] for r in history),'edgeRatioP99Max':max(r['edgeRatioP99'] for r in history),'initialShape':shape_metrics(v[0]),'finalShape':shape_metrics(v[-1]),'sourceSha256':hashlib.sha256((OUT/'continuous-path.npz').read_bytes()).hexdigest(),'verificationSeconds':time.monotonic()-started,'admitted':False,'steps':history}
(OUT/'physical-verification.json').write_text(json.dumps(result,indent=2));print(json.dumps({k:x for k,x in result.items() if k!='steps'}),flush=True)
if violations or components!=1 or release is None:raise SystemExit(1)
