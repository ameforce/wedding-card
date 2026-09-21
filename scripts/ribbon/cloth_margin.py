"""Static thickness-aware fold relaxation; never creates animated target poses."""
import argparse
import json
from pathlib import Path
import bpy
import numpy as np
from cloth_study import intersections


def closest_triangle(p,tri):
    a,b,c=tri;ab=b-a;ac=c-a
    # Closest point is either inside the projected triangle or on its boundary.
    normal=np.cross(ab,ac);nn=np.dot(normal,normal)
    choices=[]
    if nn>1e-20:
        q=p-normal*np.dot(p-a,normal)/nn
        d00,d01,d11=np.dot(ab,ab),np.dot(ab,ac),np.dot(ac,ac)
        d20,d21=np.dot(q-a,ab),np.dot(q-a,ac)
        den=d00*d11-d01*d01
        if abs(den)>1e-20:
            v=(d11*d20-d01*d21)/den;w=(d00*d21-d01*d20)/den
            if v>=0 and w>=0 and v+w<=1:choices.append(q)
    for i in range(3):
        x,y=tri[i],tri[(i+1)%3];d=y-x
        choices.append(x+d*np.clip(np.dot(p-x,d)/max(np.dot(d,d),1e-20),0,1))
    return min(choices,key=lambda q:np.dot(p-q,p-q))


def closest_segments(p,q,r,s):
    u,v,w=q-p,s-r,p-r
    a,b,c,d,e=np.dot(u,u),np.dot(u,v),np.dot(v,v),np.dot(u,w),np.dot(v,w)
    den=a*c-b*b;t=np.clip((b*e-c*d)/den,0,1) if den>1e-20 else 0.
    k=np.clip((b*t+e)/c,0,1) if c>1e-20 else 0.
    t=np.clip((b*k-d)/a,0,1) if a>1e-20 else 0.
    k=np.clip((b*t+e)/c,0,1) if c>1e-20 else 0.
    return p+t*u,r+k*v


def closest_faces(a,b):
    choices=[]
    for ids in [(0,1,2),(0,2,3)]:
        choices.extend((p,closest_triangle(p,b[list(ids)])) for p in a)
        choices.extend((closest_triangle(p,a[list(ids)]),p) for p in b)
    choices.extend(closest_segments(a[i],a[(i+1)%4],b[j],b[(j+1)%4]) for i in range(4) for j in range(4))
    return min(choices,key=lambda pair:np.dot(pair[0]-pair[1],pair[0]-pair[1]))


def near_pairs(v,f,margin):
    lo=v[f].min(axis=1);hi=v[f].max(axis=1);sets=[set(x) for x in f]
    for a in range(len(f)):
        candidates=np.where(np.all(lo[a]-margin<=hi,axis=1)&np.all(hi[a]+margin>=lo,axis=1))[0]
        for b in candidates:
            if a<b and not sets[a].intersection(sets[b]):yield a,int(b)


def main():
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--margin',type=float,default=.012);p.add_argument('--iterations',type=int,default=20);args=p.parse_args()
    if args.out.exists() and any(args.out.iterdir()):p.error('Output must be new or empty')
    args.out.mkdir(parents=True,exist_ok=True)
    d=np.load(args.source);original=d['vertices'];v=original.copy();f=d['faces'];across=int(d['across']);history=[]
    if intersections(v,f.tolist(),across):p.error('Initial surface must have zero exact intersections.')
    for iteration in range(args.iterations+1):
        shifts=np.zeros_like(v);counts=np.zeros(len(v));distances=[]
        for a,b in near_pairs(v,f,args.margin):
            x,y=closest_faces(v[f[a]],v[f[b]]);delta=x-y;distance=np.linalg.norm(delta)
            if distance>=args.margin:continue
            distances.append(distance)
            if distance<1e-10:
                x0,y0=closest_faces(original[f[a]],original[f[b]]);delta=x0-y0
                if np.linalg.norm(delta)<1e-10:delta=original[f[a]].mean(axis=0)-original[f[b]].mean(axis=0)
            delta=delta/max(np.linalg.norm(delta),1e-15)*(args.margin-distance)*.6
            shifts[f[a]]+=delta;shifts[f[b]]-=delta;counts[f[a]]+=1;counts[f[b]]+=1
        row={'iteration':iteration,'nearPairs':len(distances),'minimum':float(min(distances)) if distances else None,
             'selfIntersections':len(intersections(v,f.tolist(),across)),
             'maximumDisplacement':float(np.linalg.norm(v-original,axis=1).max())}
        history.append(row);print(json.dumps(row),flush=True)
        if not distances or iteration==args.iterations:break
        proposed=shifts/np.maximum(counts,1)[:,None]
        # A finite thickness correction must not cross another face on its way
        # out. Backtrack the whole static step and retain the original topology.
        fraction=1.
        while fraction>1e-6:
            candidate=v+fraction*proposed
            if not intersections(candidate,f.tolist(),across):
                v=candidate
                break
            fraction*=.5
        row['acceptedStepFraction']=fraction if fraction>1e-6 else 0.
        if fraction<=1e-6:break
    np.savez_compressed(args.out/'candidate.npz',vertices=v,faces=f,flatRest=d['flatRest'],across=across)
    (args.out/'margin-evidence.json').write_text(json.dumps({'source':str(args.source),'margin':args.margin,'history':history,'visualAdmission':False},indent=2))


if __name__=='__main__':main()
