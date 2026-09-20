"""Restore a tied initial surface toward flat-material edge lengths.

This is a static initial-shape constraint solve, never animation authoring.
No result is admitted solely by convergence; strict contact and silhouette
read-back remain separate requirements.
"""
import argparse
import hashlib
import json
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from cloth_strain import edge_groups


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--source',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--iterations',type=int,default=2400)
    p.add_argument('--anchor',type=float,default=.0005)
    p.add_argument('--depth',type=float,default=1.5)
    p.add_argument('--contact-safe',action='store_true')
    p.add_argument('--local-contact-rollback',action='store_true')
    args=p.parse_args()
    if args.out.exists() and any(args.out.iterdir()):p.error('Output must be new or empty')
    args.out.mkdir(parents=True,exist_ok=True)
    d=np.load(args.source)
    original=d['vertices'].copy()
    flat,faces,across=d['flatRest'],d['faces'],int(d['across'])
    v=original.copy()
    groups=edge_groups(len(v)//across,across)
    edges=np.concatenate(list(groups.values()))
    a,b=edges[:,0],edges[:,1]
    target=np.linalg.norm(flat[b]-flat[a],axis=1)
    counts=np.bincount(np.r_[a,b],minlength=len(v)).astype(float)
    face_sets=[set(f) for f in faces]
    ymin,ymax=(1.3-.225)*args.depth,(1.3+.225)*args.depth
    snapshots=[]
    for iteration in range(args.iterations+1):
        previous=v.copy()
        delta=v[b]-v[a]
        length=np.linalg.norm(delta,axis=1)
        ratio=length/target
        if iteration%100==0:
            tree=BVHTree.FromPolygons([Vector(x) for x in v],faces.tolist())
            pairs=[(i,j) for i,j in tree.overlap(tree) if i<j and not face_sets[i].intersection(face_sets[j])]
            row={'iteration':iteration,'ratioMin':float(ratio.min()),'ratioMax':float(ratio.max()),
                 'p95AbsoluteError':float(np.quantile(np.abs(ratio-1),.95)),
                 'nonAdjacentFaceIntersections':len(pairs),
                 'maximumDisplacement':float(np.linalg.norm(v-original,axis=1).max())}
            snapshots.append(row)
            print(json.dumps(row),flush=True)
        if iteration==args.iterations:break
        correction=delta*((length-target)/np.maximum(length,1e-10))[:,None]
        accum=np.zeros_like(v)
        np.add.at(accum,a,correction)
        np.add.at(accum,b,-correction)
        v += .9*accum/counts[:,None]
        # Silhouette is soft: the constraint solution may move in depth freely.
        v[:,[0,2]] += args.anchor*(original[:,[0,2]]-v[:,[0,2]])
        v[:,1] += args.anchor*.2*(original[:,1]-v[:,1])
        # Original front/back assignment prevents the static solve entering paper.
        inside=(np.abs(v[:,0])<7.015)&(np.abs(v[:,2])<4.515)&(v[:,1]>ymin-.015)&(v[:,1]<ymax+.015)
        front=original[:,1]<(ymin+ymax)/2
        v[inside&front,1]=ymin-.018
        v[inside&~front,1]=ymax+.018
        if args.contact_safe:
            for attempt in range(4):
                tree=BVHTree.FromPolygons([Vector(x) for x in v],faces.tolist())
                pairs=[(i,j) for i,j in tree.overlap(tree) if i<j and not face_sets[i].intersection(face_sets[j])]
                if not pairs:break
                affected=np.unique(np.concatenate([faces[i] for pair in pairs for i in pair]))
                if args.local_contact_rollback:
                    restore=np.unique(np.clip(np.r_[affected,affected-across,affected+across,affected-1,affected+1],0,len(v)-1))
                else:
                    affected_rows=np.unique(affected//across)
                    affected_rows=np.unique(np.clip(np.r_[affected_rows-1,affected_rows,affected_rows+1],0,len(v)//across-1))
                    restore=(affected_rows[:,None]*across+np.arange(across)[None,:]).ravel()
                v[restore]=previous[restore]
            else:
                v=previous
        elif iteration%10==0:
            tree=BVHTree.FromPolygons([Vector(x) for x in v],faces.tolist())
            pairs=[(i,j) for i,j in tree.overlap(tree) if i<j and not face_sets[i].intersection(face_sets[j])]
            if pairs:
                shifts=np.zeros_like(v)
                n=np.zeros(len(v))
                for i,j in pairs:
                    ia,ib=faces[i],faces[j]
                    # Preserve the initial over/under ordering for this contact.
                    direction=1. if original[ia,1].mean()>original[ib,1].mean() else -1.
                    shifts[ia,1]+=.01*direction
                    shifts[ib,1]-=.01*direction
                    n[ia]+=1;n[ib]+=1
                v+=shifts/np.maximum(1,n)[:,None]
    np.savez_compressed(args.out/'candidate.npz',vertices=v,faces=faces,flatRest=flat,across=across)
    report={'schemaVersion':1,'sourceSha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),
            'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'operation':'static initial edge-length relaxation with soft silhouette anchors',
            'animatedPosesCreated':0,'visualAdmission':False,'settings':{'iterations':args.iterations,'anchor':args.anchor,'contactSafe':args.contact_safe,'localContactRollback':args.local_contact_rollback},
            'iterations':snapshots}
    (args.out/'relaxation-evidence.json').write_text(json.dumps(report,indent=2))


if __name__=='__main__':main()
