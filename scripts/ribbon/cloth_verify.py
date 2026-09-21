"""Independent numeric read-back of immutable simulation coordinates."""
import argparse
import hashlib
import json
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--study',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--through',type=int)
    args=parser.parse_args()
    source=args.study/'simulated-vertices.npz'
    data=np.load(source)
    info=json.loads((args.study/'initial-evidence.json').read_text())
    frames,faces,flat=data['vertices'],data['faces'],data['flatRest']
    coordinates=data['materialCoordinates'] if 'materialCoordinates' in data else flat[:,:2]
    stations=np.unique(np.round(coordinates[:,0],10))
    station_groups=[np.where(np.isclose(coordinates[:,0],station,atol=1e-9))[0] for station in stations]
    face_sets=[set(f) for f in faces]
    depth=info['settings']['depth']
    ymin,ymax=(1.3-.225)*depth,(1.3+.225)*depth
    paper_vertices=[(x,y,z) for x in [-7,7] for y in [ymin,ymax] for z in [-4.5,4.5]]
    paper_faces=[(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)]
    paper_tree=BVHTree.FromPolygons([Vector(v) for v in paper_vertices],paper_faces)
    limit=args.through or len(frames)
    if not 1<=limit<=len(frames):parser.error('through must select an available simulation frame')
    selected=range(limit)
    rows=[]
    for index in selected:
        v=frames[index]
        tree=BVHTree.FromPolygons([Vector(x) for x in v],faces.tolist())
        pairs=[(a,b) for a,b in tree.overlap(tree) if a<b and not face_sets[a].intersection(face_sets[b])]
        center=np.asarray([v[indices].mean(axis=0) for indices in station_groups])
        center_length=float(np.linalg.norm(np.diff(center,axis=0),axis=1).sum())
        widths=[]
        for indices in station_groups:
            points=v[indices]
            widths.append(float(np.linalg.norm(points[:,None,:]-points[None,:,:],axis=2).max()))
        widths=np.asarray(widths)
        inside=(np.abs(v[:,0])<7)&(v[:,1]>ymin)&(v[:,1]<ymax)&(np.abs(v[:,2])<4.5)
        rows.append({'simulationFrame':index+1,'nonAdjacentFaceIntersections':len(pairs),
                     'paperFaceIntersections':len(tree.overlap(paper_tree)),
                     'verticesInsidePaper':int(inside.sum()),
                     'centerlineLength':center_length,'crossSectionWidthMin':float(widths.min()),
                     'crossSectionWidthMax':float(widths.max()),
                     'maxZ':float(v[:,2].max()),'minZ':float(v[:,2].min()),
                     'intersectionMaterialStations':sorted(set((float(coordinates[faces[a],0].mean()),
                                                                float(coordinates[faces[b],0].mean()))
                                                               for a,b in pairs))[:50]})
    report={'schemaVersion':1,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
            'omittedAdjacentFaces':'only faces sharing actual vertices; no row-neighborhood exemption',
            'sampledFrames':rows,'visualAdmission':False,'releaseCompleteFrame':None,
            'initialSurfacePass':not any(rows[0][key] for key in ['nonAdjacentFaceIntersections','paperFaceIntersections','verticesInsidePaper'])}
    args.out.write_text(json.dumps(report,indent=2))
    print(json.dumps({'initialSurfacePass':report['initialSurfacePass'],
                      'maxSelfIntersections':max(r['nonAdjacentFaceIntersections'] for r in rows),
                      'maxPaperIntersections':max(r['paperFaceIntersections'] for r in rows),
                      'out':str(args.out)}),flush=True)


if __name__=='__main__':main()
