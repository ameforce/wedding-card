"""Independent narrow-phase checks for static hinge construction snapshots."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
from cloth_study import intersections


def barycentric(point,tri):
    uv=np.linalg.lstsq((tri[1:]-tri[0]).T,point-tri[0],rcond=None)[0]
    return np.r_[1-uv.sum(),uv]


def area(poly):
    if len(poly)<3:return 0.
    p=np.asarray(poly);q=np.roll(p,-1,axis=0)
    return abs(float(np.sum(p[:,0]*q[:,1]-p[:,1]*q[:,0])))/2


def cross2(a,b):return float(a[0]*b[1]-a[1]*b[0])


def coplanar_area(a,b,normal):
    axes=[i for i in range(3) if i!=np.argmax(abs(normal))]
    polygon=[p[axes] for p in a];clip=b[:,axes]
    orientation=np.sign(cross2(clip[1]-clip[0],clip[2]-clip[0]))
    for i in range(3):
        p=clip[i];q=clip[(i+1)%3];output=[]
        if not polygon:break
        for index,end in enumerate(polygon):
            start=polygon[index-1]
            start_distance=orientation*cross2(q-p,start-p)
            end_distance=orientation*cross2(q-p,end-p)
            start_in=start_distance>=0;end_in=end_distance>=0
            if start_in!=end_in:
                t=start_distance/(start_distance-end_distance)
                output.append(start+t*(end-start))
            if end_in:output.append(end)
        polygon=output
    return area(polygon)


def classify(a,b):
    na=np.cross(a[1]-a[0],a[2]-a[0]);na/=np.linalg.norm(na)
    nb=np.cross(b[1]-b[0],b[2]-b[0]);nb/=np.linalg.norm(nb)
    parallel=np.linalg.norm(np.cross(na,nb))
    if parallel<1e-7:
        if max(abs((a-b[0])@nb))>1e-7:return 'parallel_separated',0.
        overlap=coplanar_area(a,b,na)
        return ('coplanar_area' if overlap>1e-10 else 'coplanar_boundary'),overlap
    hits=[]
    for first,second,n in [(a,b,nb),(b,a,na)]:
        for i in range(3):
            p=first[i];d=first[(i+1)%3]-p;den=np.dot(n,d)
            if abs(den)<1e-12:continue
            t=np.dot(n,second[0]-p)/den
            if t<-1e-8 or t>1+1e-8:continue
            point=p+t*d
            if min(barycentric(point,second))>=-1e-8:hits.append(point)
    if len(hits)<2:return 'no_strict_segment',0.
    points=np.asarray(hits)
    extent=float(np.max(np.linalg.norm(points[:,None,:]-points[None,:,:],axis=2)))
    midpoint=points.mean(axis=0)
    interior=min(min(barycentric(midpoint,a)),min(barycentric(midpoint,b)))
    if extent>1e-7 and interior>1e-8:return 'transverse_interior',extent
    return 'boundary_or_tolerance',extent


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate',type=Path,required=True)
    p.add_argument('--independent-qa',type=Path)
    args=p.parse_args();data=np.load(args.candidate)
    # Validate classification itself against transverse, area and boundary cases.
    tri=np.array([[0.,0.,0.],[1.,0.,0.],[0.,1.,0.]])
    assert classify(tri,np.array([[.2,.2,-1],[.2,.2,1],[.8,.2,0]]))[0]=='transverse_interior'
    assert classify(tri,tri+.1*np.array([1.,1.,0.]))[0]=='coplanar_area'
    assert classify(tri,np.array([[1.,0.,0.],[1.,1.,0.],[0.,1.,0.]]))[0]=='coplanar_boundary'
    reports={}
    independent=None
    if args.independent_qa:
        spec=importlib.util.spec_from_file_location('independent_triangle_qa',args.independent_qa)
        independent=importlib.util.module_from_spec(spec);spec.loader.exec_module(independent)
    for label,vertices in [('doublePrecision',data['vertices']),('blenderFloat32',data['vertices'].astype(np.float32).astype(float))]:
        faces=data['faces'];pairs=intersections(vertices,faces.tolist(),None)
        counts={};evidence=[];qa_counts={};disagreements=[]
        for a,b in pairs:
            category,measure=classify(vertices[faces[a]],vertices[faces[b]])
            counts[category]=counts.get(category,0)+1
            if independent:
                qa=independent.triangle_intersection(vertices[faces[a]],vertices[faces[b]],epsilon=1e-8)
                key=('positive_' if qa['intersects'] else 'contact_' if qa['contactOnly'] else 'separate_')+qa['kind']
                qa_counts[key]=qa_counts.get(key,0)+1
                if bool(qa['intersects'])!=(category in ('transverse_interior','coplanar_area')):
                    disagreements.append({'faces':[a,b],'own':category,'independent':qa})
            if category in ('transverse_interior','coplanar_area'):
                evidence.append({'faces':[a,b],'category':category,'measure':measure,
                                 'coarseOwnerDelta':abs(int(data['triangleOwner'][a])-int(data['triangleOwner'][b]))})
        reports[label]={'bvhPairs':len(pairs),'classification':counts,'confirmedPositiveIntersections':len(evidence),'pairs':evidence,
                        'independentQA':qa_counts,'disagreements':disagreements}
    from cloth_construct_hinges import crossing_ledger
    coarse=data['coarseVertices'];coarse_rest=data['coarseFlatRest'];fiber=[];fiber_s=[]
    for row in range(len(coarse)//2):
        fiber.append(coarse[2*row:2*row+2].mean(axis=0));fiber_s.append(coarse_rest[2*row,0])
        if row<len(coarse)//2-1:
            fiber.append(coarse[2*row+1:2*row+3].mean(axis=0));fiber_s.append(coarse_rest[2*row+1:2*row+3,0].mean())
    ledger=crossing_ledger(np.asarray(fiber),np.asarray(fiber_s))
    for entry in ledger:
        for prefix in ['first','second']:
            entry[prefix+'GuidePort']=float(np.interp(entry[prefix+'S'],coarse_rest[::2,0],data['materialGuideParameters']))
    (args.candidate.parent/'exact-material-fiber.json').write_text(json.dumps({'fiber':np.asarray(fiber).tolist(),'materialS':fiber_s,'crossings':ledger,
        'note':'Actual t=0 polyline includes every coarse diagonal midpoint. Original construction-evidence row-center chord ledger is approximate and superseded.'},indent=2))
    report={'schemaVersion':1,'candidate':str(args.candidate.resolve()),'regressionsPassed':3,
            'tolerances':{'parallelNormalCross':1e-7,'planeDistance':1e-7,'projectedArea':1e-10,'segmentLength':1e-7,'barycentricInterior':1e-8},
            'note':'BVH candidates are independently classified. Coplanar boundary/tolerance remains contact uncertainty, not positive-area penetration.',
            'results':reports}
    report['independentQASha256']=hashlib.sha256(args.independent_qa.read_bytes()).hexdigest() if args.independent_qa else None
    target=args.candidate.parent/'strict-static-contact.json';target.write_text(json.dumps(report,indent=2))
    print(json.dumps({k:{x:y for x,y in v.items() if x!='pairs'} for k,v in reports.items()}),flush=True)


if __name__=='__main__':main()
