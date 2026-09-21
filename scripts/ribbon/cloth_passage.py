"""Read back projected passage and bight-area changes from simulated cloth."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np


def crossings(points, stations, parameters):
    result=[]
    for first in range(len(points)-1):
        p=points[first];u=points[first+1]-p
        for second in range(first+2,len(points)-1):
            if second==first+1:continue
            q=points[second];v=points[second+1]-q
            matrix=np.array([[u[0],-v[0]],[u[2],-v[2]]])
            determinant=np.linalg.det(matrix)
            if abs(determinant)<1e-10:continue
            t,r=np.linalg.solve(matrix,(q-p)[[0,2]])
            if 1e-7<t<1-1e-7 and 1e-7<r<1-1e-7:
                a=p+t*u;b=q+r*v
                result.append({'firstS':float(stations[first]+t*(stations[first+1]-stations[first])),
                               'secondS':float(stations[second]+r*(stations[second+1]-stations[second])),
                               'firstGuidePort':float(parameters[first]+t*(parameters[first+1]-parameters[first])),
                               'secondGuidePort':float(parameters[second]+r*(parameters[second+1]-parameters[second])),
                               'deltaY':float(a[1]-b[1]),'firstOver':bool(a[1]<b[1])})
    return result


def projected_area(points):
    if len(points)<3:return 0.
    planar=points[:,[0,2]]
    shifted=np.roll(planar,-1,axis=0)
    return abs(float(np.sum(planar[:,0]*shifted[:,1]-planar[:,1]*shifted[:,0])))/2


def segment_metrics(points,parameters,low,high):
    selected=points[(parameters>=low)&(parameters<=high)]
    if len(selected)<2:return {'points':len(selected),'projectedClosedArea':0.,'chord':0.,'maximumChordDistance':0.}
    start,end=selected[[0,-1]];chord=end-start;length=np.linalg.norm(chord)
    if length<1e-9:distances=np.linalg.norm(selected-start,axis=1)
    else:
        direction=chord/length
        distances=np.linalg.norm((selected-start)-np.outer((selected-start)@direction,direction),axis=1)
    return {'points':len(selected),'projectedClosedArea':projected_area(selected),
            'chord':float(length),'maximumChordDistance':float(distances.max())}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--simulation',type=Path,required=True)
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--frames',default='1,30,60,90,120,135,150,165,180')
    parser.add_argument('--through',type=int)
    args=parser.parse_args()
    simulation=np.load(args.simulation);candidate=np.load(args.candidate)
    frames=simulation['vertices'];coordinates=simulation['materialCoordinates']
    stations=np.unique(np.round(coordinates[:,0],10))
    groups=[np.where(np.isclose(coordinates[:,0],station,atol=1e-9))[0] for station in stations]
    guide_stations=candidate['coarseFlatRest'][::2,0]
    guide_parameters=candidate['materialGuideParameters']
    parameters=np.interp(stations,guide_stations,guide_parameters)
    if args.through:
        if not 1<=args.through<=len(frames):parser.error('through must select an available simulation frame')
        selected=range(1,args.through+1)
    else:
        selected=sorted(set(int(value) for value in args.frames.split(',') if 1<=int(value)<=len(frames)))
    rows=[]
    for frame in selected:
        points=np.asarray([frames[frame-1,indices].mean(axis=0) for indices in groups])
        ledger=crossings(points,stations,parameters)
        pulled_bight_crossings=sum(any(1.5<=entry[key]<=7.5 for key in ['firstGuidePort','secondGuidePort'])
                                   for entry in ledger)
        rows.append({'simulationFrame':frame,'crossingCount':len(ledger),
                     'pulledBightCrossings':pulled_bight_crossings,'crossings':ledger,
                     'rightBight':segment_metrics(points,parameters,1.5,7.5),
                     'collar':segment_metrics(points,parameters,7.5,11.0),
                     'leftBight':segment_metrics(points,parameters,15.5,22.5)})
    initial_height=rows[0]['rightBight']['maximumChordDistance']
    qualifying=[row['pulledBightCrossings']==0 and
                row['rightBight']['maximumChordDistance']<=initial_height*.1 for row in rows]
    release_candidate=None
    for index in range(len(rows)-5):
        if all(qualifying[index:index+6]):
            release_candidate=rows[index]['simulationFrame'];break
    report={'schemaVersion':1,'simulationSha256':hashlib.sha256(args.simulation.read_bytes()).hexdigest(),
            'candidateSha256':hashlib.sha256(args.candidate.read_bytes()).hexdigest(),
            'projection':'fixed diagnostic camera x/z plane; deltaY records passage order',
            'note':'The release candidate requires six consecutive frames with no crossing involving the pulled bight and less than ten percent of its initial chord deviation. It is not an automatic visual-admission decision.',
            'frames':rows,'visualAdmission':False,'releaseCandidateFrame':release_candidate,
            'releaseCompleteFrame':None}
    args.out.write_text(json.dumps(report,indent=2))
    print(json.dumps({'releaseCandidateFrame':release_candidate,
                      'tail':[{'frame':row['simulationFrame'],'crossings':row['crossingCount'],
                               'pulledBightCrossings':row['pulledBightCrossings'],
                               'rightArea':row['rightBight']['projectedClosedArea'],
                               'rightHeight':row['rightBight']['maximumChordDistance'],
                               'leftArea':row['leftBight']['projectedClosedArea']}
                              for row in rows[-10:]]}),flush=True)


if __name__=='__main__':main()
