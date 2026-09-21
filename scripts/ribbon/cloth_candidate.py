"""Redesign static knot passages and folds before any cloth evaluation."""
import argparse
import hashlib
import importlib.util
import json
import shutil
from pathlib import Path

import bpy
import numpy as np
from cloth_study import intersections


def rotate_axis(vector, axis, angle):
    return vector*np.cos(angle)+np.cross(axis,vector)*np.sin(angle)+axis*np.dot(axis,vector)*(1-np.cos(angle))


def transport_transition(centers, tangent, axis, rows, first, last):
    """Distribute width-frame twist by material distance, avoiding projection poles."""
    start=next(i for i,r in enumerate(rows) if r>=first)
    end=next(i for i,r in enumerate(rows) if r>=last)
    width=axis[start].copy()
    transported=[width.copy()]
    for i in range(start+1,end+1):
        turn=np.cross(tangent[i-1],tangent[i])
        sine=np.linalg.norm(turn)
        if sine>1e-10:
            width=rotate_axis(width,turn/sine,np.arctan2(sine,np.dot(tangent[i-1],tangent[i])))
        width-=tangent[i]*np.dot(width,tangent[i])
        width/=np.linalg.norm(width)
        transported.append(width.copy())
    target=axis[end]
    twist=np.arctan2(np.dot(tangent[end],np.cross(transported[-1],target)),np.dot(transported[-1],target))
    s=np.r_[0.,np.linalg.norm(np.diff(centers[start:end+1],axis=0),axis=1).cumsum()]
    for k,i in enumerate(range(start,end+1)):
        u=s[k]/s[-1]
        axis[i]=rotate_axis(transported[k],tangent[i],twist*u*u*(3-2*u))


def build(source, depth=3., core=1.6, band=.7, angle=1.50, stride=4, across=9, gather_radius=1.6, collar=None, frame_mode='cylinder', fold_profile='accordion'):
    spec = importlib.util.spec_from_file_location('initial_evidence', source)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    full, _, centers, _ = m.geometry(0)
    rows = list(range(0, len(centers), stride))
    if rows[-1] != len(centers)-1:
        rows.append(len(centers)-1)
    centers = np.array([centers[i][:] for i in rows])
    original = np.array([full[i*m.ACROSS+j][:] for i in rows for j in [0,4,8]]).reshape(-1,3,3)
    axis = original[:,2]-original[:,0]
    axis /= np.linalg.norm(axis,axis=1)[:,None]
    tangent = np.gradient(centers,axis=0)
    tangent /= np.linalg.norm(tangent,axis=1)[:,None]
    normal = np.cross(tangent,axis)
    normal /= np.linalg.norm(normal,axis=1)[:,None]
    radius = np.linalg.norm(centers[:,[0,2]],axis=1)
    # Spread the core's centerline passages; loops and tails keep their outline.
    weight = np.exp(-(radius/1.0)**4)
    centers[:,0] *= 1+(core-1)*weight
    centers[:,2] *= 1+(core-1)*weight
    centers[:,1] *= depth
    # The horizontal band sits behind the loop, with a gradual knot entry.
    for k,row in enumerate(rows):
        if 425 <= row <= 1070:
            w = min(1., (row-425)/45., (1070-row)/60.)
            centers[k,1] += band*max(0,w)
    # A compact accordion stores full material width in the central knot.
    gather = np.exp(-(radius/gather_radius)**8)
    if collar is not None:
        # Source A's real outer wrap (control 5, material rows ~375..430).
        # This remains part of the same strip. Interior passages alone pleat.
        r=np.array(rows,dtype=float)
        left=np.clip((r-355)/25,0,1)
        right=np.clip((448-r)/25,0,1)
        left=left*left*(3-2*left)
        right=right*right*(3-2*right)
        broad=left*right
        gather *= 1-broad
        centers[:,0] += .35*broad
        entry=np.clip((r-345)/30,0,1)
        exit=np.clip((475-r)/30,0,1)
        entry=entry*entry*(3-2*entry)
        exit=exit*exit*(3-2*exit)
        centers[:,1] -= float(collar)*entry*exit
        # Route the collar's outgoing passage above the incoming tail.
        centers[:,2] += .3*np.exp(-((r-452)/20)**4)
        # Develop the visible collar around the bundle's horizontal axis.
        # Its front face is a vertical wrap with horizontal material width.
        # Only the tied initial surface changes; no animated target poses exist.
        u=np.clip((r-355)/(448-355),0,1)
        theta=np.pi+np.pi*u
        arc=np.column_stack((np.zeros_like(r),-.65+.85*np.sin(theta),.48*np.cos(theta)))
        centers=centers*(1-broad[:,None])+arc*broad[:,None]
        direction=np.array([1.,0.,0.])
        axis=axis*(1-broad[:,None])+direction*broad[:,None]
        axis/=np.linalg.norm(axis,axis=1)[:,None]
        tangent=np.gradient(centers,axis=0)
        tangent/=np.linalg.norm(tangent,axis=1)[:,None]
        axis-=tangent*np.sum(axis*tangent,axis=1)[:,None]
        axis/=np.linalg.norm(axis,axis=1)[:,None]
        if frame_mode in ['transport','binormal']:
            transport_transition(centers,tangent,axis,rows,410,500)
        if frame_mode=='binormal':
            curvature=np.gradient(tangent,axis=0)
            curve_length=np.linalg.norm(np.gradient(centers,axis=0),axis=1)
            binormal=np.cross(tangent,curvature)
            size=np.linalg.norm(binormal,axis=1)
            for i,r in enumerate(rows):
                if 420<=r<=488 and size[i]>1e-8:
                    desired=binormal[i]/size[i]
                    if np.dot(desired,axis[i])<0:desired=-desired
                    turn_rate=size[i]/max(curve_length[i],1e-8)
                    blend=np.clip((turn_rate-.5)/1.5,0,1)*min(1,(r-420)/12,(488-r)/12)
                    axis[i]=axis[i]*(1-blend)+desired*blend
                    axis[i]/=np.linalg.norm(axis[i])
        normal=np.cross(tangent,axis)
        normal/=np.linalg.norm(normal,axis=1)[:,None]
    vertices = []
    for i,c in enumerate(centers):
        folded = angle*gather[i]
        points = []
        for j in range(across):
            width = (j/(across-1)-.5)*m.WIDTH*np.cos(folded)
            pleat = ((j%2)-.5)*m.WIDTH/(across-1)*np.sin(folded)
            if fold_profile=='single-v':
                pleat=(abs(j-(across-1)/2)-(across-1)/4)*m.WIDTH/(across-1)*np.sin(folded)
            points.append(c+axis[i]*width+normal[i]*pleat)
        vertices.extend(points)
    vertices = np.array(vertices)
    faces = [(i*across+j, i*across+j+1, (i+1)*across+j+1, (i+1)*across+j)
             for i in range(len(rows)-1) for j in range(across-1)]
    s = np.r_[0., np.linalg.norm(np.diff(centers,axis=0),axis=1).cumsum()]
    flat = np.array([(x,(j/(across-1)-.5)*m.WIDTH,0) for x in s for j in range(across)])
    return vertices,faces,flat,across


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--source',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--broad-collar',action='store_true')
    p.add_argument('--frame-mode',choices=['cylinder','transport','binormal'],default='cylinder')
    p.add_argument('--fold-profile',choices=['accordion','single-v'],default='accordion')
    p.add_argument('--depths',help='Comma-separated static passage depths for a bounded geometry search')
    args=p.parse_args()
    if args.out.exists() and any(args.out.iterdir()):
        p.error('Output must be new or empty')
    args.out.mkdir(parents=True,exist_ok=True)
    rows=[]
    best=None
    for depth in ([float(x) for x in args.depths.split(',')] if args.depths else ([1.5,2.,2.5,3.] if args.fold_profile=='single-v' else ([1.5,2.,2.5] if args.broad_collar else [1.,2.,3.]))):
        for core in ([1.,1.4,1.8] if args.fold_profile=='single-v' else [1.,1.4]):
            for band in ([1.4] if args.broad_collar else [.7,1.4]):
              for collar in ([.6,.9,1.2] if args.broad_collar else [None]):
                v,f,flat,across=build(args.source,depth=depth,core=core,band=band,collar=collar,frame_mode=args.frame_mode,fold_profile=args.fold_profile)
                pairs=intersections(v,f,across)
                row={'depth':depth,'core':core,'band':band,'collarForward':collar,'frameMode':args.frame_mode,'foldProfile':args.fold_profile,'intersections':len(pairs)}
                rows.append(row)
                print(json.dumps(row),flush=True)
                if best is None or len(pairs)<best[0]:
                    best=(len(pairs),v,f,flat,across,row)
    count,v,f,flat,across,row=best
    row['intersectionRows'] = sorted(set((min(f[a])//across,min(f[b])//across) for a,b in intersections(v,f,across)))
    row['intersectionCenters'] = [[v[a*across+across//2].tolist(),v[b*across+across//2].tolist()] for a,b in row['intersectionRows']]
    np.savez_compressed(args.out/'candidate.npz',vertices=v,faces=f,flatRest=flat,across=across)
    (args.out/'candidate-evidence.json').write_text(json.dumps({'candidates':rows,'selected':row,
        'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'initialSourceSha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),
        'candidateSha256':hashlib.sha256((args.out/'candidate.npz').read_bytes()).hexdigest(),
        'visualAdmission':False},indent=2))
    shutil.copy2(Path(__file__),args.out/'cloth_candidate.py')


if __name__=='__main__':main()
