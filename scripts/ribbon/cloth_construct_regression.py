"""Targeted numerical regressions for the static triangle hinge fabricator."""
import json
import numpy as np
from cloth_construct_hinges import Hinges,subdivide


def main():
    samples=np.linspace(0,3.4,9)
    centers=np.c_[samples,np.zeros_like(samples),np.zeros_like(samples)]
    widths=np.tile([0.,1.,0.],(len(samples),1))
    model=Hinges(centers,widths,samples)
    angles=np.random.default_rng(170).uniform(-1.1,1.1,len(model.constants))
    vertices=model.forward(angles)[0]
    fine,rest,faces,_=subdivide(vertices,model.rest,4)
    edges=np.sort(np.concatenate([faces[:,[0,1]],faces[:,[1,2]],faces[:,[2,0]]]),axis=1)
    unique,counts=np.unique(edges,axis=0,return_counts=True)
    assert counts.max()==2 and counts.min()==1
    assert len(fine)-len(unique)+len(faces)==1,'Rectangular disk topology required'
    ratios=np.linalg.norm(fine[unique[:,0]]-fine[unique[:,1]],axis=1)/np.linalg.norm(rest[unique[:,0]]-rest[unique[:,1]],axis=1)
    assert max(abs(ratios-1))<1e-10
    checks=[]
    for mode in ['target','point-contact','whole-face-contact']:
        model.contacts=[];model.bend_penalty=.03
        if mode!='target':
            for i,j in ([(0,1)] if mode=='point-contact' else [(i,j) for i in range(3) for j in range(3)]):
                delta=vertices[i]-vertices[12+j]
                normal=-delta/np.linalg.norm(delta)
                model.contacts.append((np.array([0,1,2]),np.array([12,13,14]),np.eye(3)[i],np.eye(3)[j],normal))
        _,gradient,_=model.objective(angles)
        errors=[]
        for index in range(len(angles)):
            a=angles.copy();b=angles.copy();a[index]+=1e-6;b[index]-=1e-6
            numeric=(model.objective(a)[0]-model.objective(b)[0])/2e-6
            errors.append(abs(numeric-gradient[index])/max(1,abs(numeric)))
        assert max(errors)<1e-5,(mode,max(errors))
        checks.append({'mode':mode,'maxRelativeGradientError':max(errors)})
    print(json.dumps({'passed':True,'meshDiskEuler':1,'edgeMetricMaxError':max(abs(ratios-1)),'gradientChecks':checks}),flush=True)


if __name__=='__main__':main()
