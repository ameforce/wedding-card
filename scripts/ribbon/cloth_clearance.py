"""Measure initial non-neighbor surface clearance against Cloth contact distance."""
import argparse
import json
from pathlib import Path
import bpy
import numpy as np
from cloth_study import intersections


def point_triangle(p, a, b, c):
    ab, ac, ap = b-a, c-a, p-a
    d1, d2 = np.dot(ab, ap), np.dot(ac, ap)
    if d1 <= 0 and d2 <= 0:return np.linalg.norm(ap)
    bp=p-b;d3,d4=np.dot(ab,bp),np.dot(ac,bp)
    if d3 >= 0 and d4 <= d3:return np.linalg.norm(bp)
    vc=d1*d4-d3*d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:return np.linalg.norm(p-(a+ab*d1/(d1-d3)))
    cp=p-c;d5,d6=np.dot(ab,cp),np.dot(ac,cp)
    if d6 >= 0 and d5 <= d6:return np.linalg.norm(cp)
    vb=d5*d2-d1*d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:return np.linalg.norm(p-(a+ac*d2/(d2-d6)))
    va=d3*d6-d5*d4
    if va <= 0 and d4-d3 >= 0 and d5-d6 >= 0:return np.linalg.norm(p-(b+(c-b)*(d4-d3)/((d4-d3)+(d5-d6))))
    total=va+vb+vc
    if abs(total)<1e-20:return min(np.linalg.norm(ap),np.linalg.norm(bp),np.linalg.norm(cp))
    return np.linalg.norm(p-(a+ab*vb/total+ac*vc/total))


def segment_distance(p, q, r, s):
    u,v,w=q-p,s-r,p-r
    a,b,c,d,e=np.dot(u,u),np.dot(u,v),np.dot(v,v),np.dot(u,w),np.dot(v,w)
    denom=a*c-b*b
    t=np.clip((b*e-c*d)/denom,0,1) if denom>1e-20 else 0.
    k=np.clip((b*t+e)/c,0,1) if c>1e-20 else 0.
    t=np.clip((b*k-d)/a,0,1) if a>1e-20 else 0.
    k=np.clip((b*t+e)/c,0,1) if c>1e-20 else 0.
    return np.linalg.norm(w+t*u-k*v)


def triangle_distance(a,b):
    distances=[point_triangle(p,*b) for p in a]+[point_triangle(p,*a) for p in b]
    distances += [segment_distance(a[i],a[(i+1)%3],b[j],b[(j+1)%3]) for i in range(3) for j in range(3)]
    return min(distances)


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--margin',type=float,default=.004);args=p.parse_args()
    data=np.load(args.input);v=data['vertices'];f=data['faces'];across=int(data['across'])
    if intersections(v,f.tolist(),across):
        p.error('Distance-only analysis requires a surface that first passes exact intersection checks.')
    sets=[set(face) for face in f]
    # BVHTree.overlap performs triangle overlap rather than a reliable distance
    # query. Expand face AABBs explicitly before exact triangle distance tests.
    lo=v[f].min(axis=1);hi=v[f].max(axis=1)
    pairs=[]
    for a in range(len(f)):
        candidates=np.where(np.all(lo[a]-args.margin<=hi,axis=1)&np.all(hi[a]+args.margin>=lo,axis=1))[0]
        pairs.extend((a,int(b)) for b in candidates if a<b and not sets[a].intersection(sets[b]))
    close=[]
    for a,b in pairs:
        qa,qb=v[f[a]],v[f[b]]
        distance=min(triangle_distance(qa[list(i)],qb[list(j)]) for i in [(0,1,2),(0,2,3)] for j in [(0,1,2),(0,2,3)])
        if distance<args.margin:
            close.append({'faces':[a,b],'materialRows':[int(min(f[a])//across),int(min(f[b])//across)],'distance':float(distance),
                          'centers':[qa.mean(axis=0).tolist(),qb.mean(axis=0).tolist()]})
    close.sort(key=lambda x:x['distance'])
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps({'input':str(args.input),'margin':args.margin,'broadPhasePairs':len(pairs),
        'pairsBelowMargin':len(close),'closestPairs':close[:100],'scope':'Non-shared-vertex quads; face tessellation into two triangles. No visual admission.'},indent=2))
    print(json.dumps({'pairsBelowMargin':len(close),'minimum':close[0] if close else None}))


if __name__=='__main__':main()
