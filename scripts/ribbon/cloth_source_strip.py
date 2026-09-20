"""Bounded raw-source ribbon feasibility study; core centerlines are immutable."""
import argparse
import json
from pathlib import Path
import numpy as np
import bpy
from cloth_source_baseline import sample
from cloth_candidate import rotate_axis
from cloth_study import intersections
from cloth_strain import edge_groups


def frames(c,mode):
    tangent=np.gradient(c,axis=0);tangent/=np.linalg.norm(tangent,axis=1)[:,None]
    width=np.zeros_like(c);width[0]=np.cross(tangent[0],[0,-1,0]);width[0]/=np.linalg.norm(width[0])
    for i in range(1,len(c)):
        turn=np.cross(tangent[i-1],tangent[i]);sine=np.linalg.norm(turn)
        w=width[i-1].copy()
        if sine>1e-10:w=rotate_axis(w,turn/sine,np.arctan2(sine,np.dot(tangent[i-1],tangent[i])))
        w-=tangent[i]*np.dot(w,tangent[i]);width[i]=w/np.linalg.norm(w)
    if mode=='binormal':
        derivative=np.gradient(tangent,axis=0);binormal=np.cross(tangent,derivative)
        size=np.linalg.norm(binormal,axis=1)
        for i in range(len(c)):
            if size[i]>1e-4:
                w=binormal[i]/size[i]
                if np.dot(w,width[max(0,i-1)])<0:w=-w
                width[i]=w
    return width


def main():
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--scales',default='1,2,4,8');p.add_argument('--frame-modes',default='bishop,binormal')
    p.add_argument('--seed-width',type=float,default=.85);p.add_argument('--rest-width',type=float,default=.85)
    args=p.parse_args()
    if args.out.exists() and any(args.out.iterdir()):p.error('Output must be new or empty')
    args.out.mkdir(parents=True,exist_ok=True);source=json.loads(args.source.read_text(encoding='utf-8'));records=[]
    for scale in [float(x) for x in args.scales.split(',')]:
        a,_=sample(source['splines'][0]['bezierPoints'],32,scale);b,_=sample(source['splines'][1]['bezierPoints'],32,scale)
        # Rigidly place the unchanged source knot in front of the actual paper.
        a[:,1]-=.35*scale;b[:,1]-=.35*scale
        extent=max(7.7,4.*scale);back=max(2.65,.7*scale)
        waypoints=[a[-1],np.array([extent,a[-1,1],a[-1,2]]),np.array([extent,back,a[-1,2]]),
                   np.array([-extent,back,b[0,2]]),np.array([-extent,b[0,1],b[0,2]]),b[0]]
        bridge=[]
        for start,end in zip(waypoints,waypoints[1:]):
            for t in np.linspace(0,1,40,endpoint=False):bridge.append(start*(1-t)+end*t)
        c=np.concatenate([a,np.array(bridge[1:]),b]);across=9
        s=np.r_[0.,np.linalg.norm(np.diff(c,axis=0),axis=1).cumsum()]
        u=np.linspace(-args.seed_width/2,args.seed_width/2,across)
        rest_u=np.linspace(-args.rest_width/2,args.rest_width/2,across)
        flat=np.array([(x,y,0.) for x in s for y in rest_u]);faces=np.array([(i*across+j,i*across+j+1,(i+1)*across+j+1,(i+1)*across+j) for i in range(len(c)-1) for j in range(across-1)])
        groups=edge_groups(len(c),across)
        for mode in args.frame_modes.split(','):
            w=frames(c,mode);v=(c[:,None,:]+w[:,None,:]*u[None,:,None]).reshape(-1,3)
            metrics={}
            for name,edges in groups.items():
                ratios=np.linalg.norm(v[edges[:,1]]-v[edges[:,0]],axis=1)/np.linalg.norm(flat[edges[:,1]]-flat[edges[:,0]],axis=1)
                metrics[name]={'min':float(ratios.min()),'max':float(ratios.max()),'p95AbsoluteError':float(np.quantile(np.abs(ratios-1),.95))}
            pairs=intersections(v,faces.tolist(),across)
            row={'scale':scale,'frameMode':mode,'vertices':len(v),'selfIntersections':len(pairs),'metric':metrics,
                 'xBounds':v[:,0].min().item(), 'xMaximum':v[:,0].max().item(),'zBounds':[v[:,2].min().item(),v[:,2].max().item()],
                 'sourceCoreModified':False,'cameraNormalization':False,'visualAdmission':False}
            row['rigidTranslation']=[0.,-.35*scale,0.]
            row['seedWidth']=args.seed_width;row['fixedRestWidth']=args.rest_width
            source_row=(np.arange(len(c))<len(a))|(np.arange(len(c))>=len(a)+len(bridge)-1)
            core_rows=np.flatnonzero(source_row&(np.linalg.norm(c[:,[0,2]],axis=1)<1.25*scale))
            name=f'scale-{int(scale)}-{mode}';np.savez_compressed(args.out/f'{name}.npz',vertices=v,faces=faces,flatRest=flat,across=across,coreRows=core_rows)
            records.append(row);print(json.dumps(row),flush=True)
    (args.out/'source-strip-feasibility.json').write_text(json.dumps(records,indent=2))


if __name__=='__main__':main()
