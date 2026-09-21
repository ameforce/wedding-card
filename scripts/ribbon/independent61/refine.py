"""Refine and certify a completed continuous cloth trajectory for rendering."""
import sys,time,json,hashlib,io
from pathlib import Path
import numpy as np
from surface_refinement import SurfaceRefinement
sys.stdout.reconfigure(encoding='utf-8')
import argparse
B=Path(__file__).resolve().parent
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',required=True);p.add_argument('--out',required=True);args=p.parse_args()
source=Path(args.source).resolve();out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=False);parts=out/'path-parts';parts.mkdir()
(out/'source.py').write_bytes(Path(__file__).read_bytes());(out/'surface_refinement.py').write_bytes((B/'surface_refinement.py').read_bytes())
index=0;refiner=None;previous=None;previous_coarse=None;previous_time=None;public=[];public_times=[];chunk=[];chunk_times=[];part_records=[];history=[];started=time.monotonic();added=0
def flush():
    if not chunk:return
    path=parts/f'part-{len(part_records):04d}.npz';np.savez_compressed(path,vertices=np.array(chunk),times=np.array(chunk_times),faces=refiner.faces)
    part_records.append({'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'count':len(chunk),'start':chunk_times[0],'end':chunk_times[-1]});chunk.clear();chunk_times.clear()
def retain(v,t):
    chunk.append(v.copy());chunk_times.append(t)
    if len(chunk)>=64:flush()
    if abs(t*30-round(t*30))<1e-7:
        public.append(v.copy());public_times.append(t)
def bridge(c0,v0,t0,c1,v1,t1,depth=0):
    global added
    if refiner.ccd(v0,v1)==1.:
        retain(v1,t1);return
    if depth>=12:raise ValueError(f'Render continuity cannot be certified between {t0} and {t1}')
    middle=(c0+c1)*.5;tm=(t0+t1)*.5;vm,_=refiner.refine(middle);added+=1
    bridge(c0,v0,t0,middle,vm,tm,depth+1);bridge(middle,vm,tm,c1,v1,t1,depth+1)
data=np.load(source/'continuous-path.npz');vertices=data['vertices'];times=data['times'];faces=data['faces']
if refiner is None:refiner=SurfaceRefinement(faces,vertices.shape[1])
while index<len(times):
    coarse=vertices[index];t=float(times[index]);current,stats=refiner.refine(coarse)
    if previous is None:retain(current,t)
    else:bridge(previous_coarse,previous,previous_time,coarse,current,t)
    previous=current;previous_coarse=coarse.copy();previous_time=t;index+=1
    if index%20==0:
        row={'sourceSteps':index,'time':t,'renderSamples':len(public),'insertedContinuityPoints':added,'seconds':time.monotonic()-started,**stats};history.append(row);print(json.dumps(row),flush=True)
        np.savez_compressed(out/'render-cache.npz',vertices=np.array(public),times=np.array(public_times),faces=refiner.faces)
        (out/'progress.json').write_text(json.dumps({'history':history,'parts':part_records,'admitted':False},indent=2))
flush();np.savez_compressed(out/'render-cache.npz',vertices=np.array(public),times=np.array(public_times),faces=refiner.faces)
result={'sourceSteps':index,'renderSamples':len(public),'insertedContinuityPoints':added,'intersections':0,'continuousStepFractions':1,'sourceSha256':hashlib.sha256((source/'continuous-path.npz').read_bytes()).hexdigest(),'parts':part_records,'seconds':time.monotonic()-started,'admitted':False}
(out/'complete.json').write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k!='parts'}),flush=True)
