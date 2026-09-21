"""Construct one rectangular strip using explicit piecewise-rigid crease panels.

Initial geometry only: no target fitting, playback interpolation or Cloth run.
The input design supplies material crease u=s_i+q_i*v and signed fold angles.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np


def rotation(axis,angle):
    axis=np.asarray(axis,dtype=float);axis/=np.linalg.norm(axis)
    x,y,z=axis
    skew=np.array([[0.,-z,y],[z,0.,-x],[-y,x,0.]])
    return np.eye(3)*np.cos(angle)+(1-np.cos(angle))*np.outer(axis,axis)+np.sin(angle)*skew


def construct(design,width=.85,pitch=.18,across=8):
    points=np.asarray(design['waypoints']);s=np.asarray(design['s']);q=np.asarray(design['q'])
    angles=np.radians(design['foldAnglesDegrees'])
    if len(points)!=len(s) or len(q)!=len(s) or len(angles)!=len(s):raise ValueError('Inconsistent crease arrays')
    if q[0]!=0 or q[-1]!=0 or s[0]!=0:raise ValueError('Rectangular strip requires perpendicular free tips')
    if min(np.diff(s)-width/2*abs(np.diff(q)))<=0:raise ValueError('Flat crease lines intersect inside material')
    tangent=points[1]-points[0];tangent/=np.linalg.norm(tangent)
    normal=np.array([np.cos(design['rootAngle']),np.sin(design['rootAngle']),0.])
    if abs(np.dot(normal,tangent))>1e-9:raise ValueError('Root normal must be perpendicular to root tangent')
    director=np.cross(normal,tangent)
    matrix=np.column_stack([tangent,director,normal]);translation=points[0].copy()
    vertices=[];rest=[];faces=[];panel_owners=[];lookup={};crease_vertices=[];panels=[];axis_errors=[]
    def add(flat,transform,offset):
        key=tuple(np.round(flat,10))
        world=transform@flat+offset
        if key in lookup:
            index=lookup[key]
            if np.linalg.norm(vertices[index]-world)>1e-8:raise ValueError('Crease is not shared by both rigid panels')
            return index
        index=len(vertices);lookup[key]=index;vertices.append(world);rest.append(flat);return index
    for panel in range(len(s)-1):
        if panel:
            pivot=matrix@np.array([s[panel],0.,0.])+translation
            axis=matrix@np.array([q[panel],1.,0.]);axis/=np.linalg.norm(axis)
            expected_axis=np.asarray(design['foldAxes'][panel])
            axis_errors.append(float(np.linalg.norm(axis-expected_axis)))
            turn=rotation(axis,angles[panel])
            matrix=turn@matrix;translation=turn@(translation-pivot)+pivot
        origin=matrix@np.array([s[panel],0.,0.])+translation
        endpoint=matrix@np.array([s[panel+1],0.,0.])+translation
        if max(np.linalg.norm(origin-points[panel]),np.linalg.norm(endpoint-points[panel+1]))>1e-7:
            raise ValueError('Explicit crease transforms do not reproduce the designed centerline')
        longest=max((s[panel+1]-s[panel])+(q[panel+1]-q[panel])*side*width/2 for side in [-1,1])
        along=max(1,int(np.ceil(longest/pitch)))
        rows=[]
        for i in range(along+1):
            t=i/along;station=(1-t)*s[panel]+t*s[panel+1];slope=(1-t)*q[panel]+t*q[panel+1]
            row=[add(np.array([station+slope*v,v,0.]),matrix,translation) for v in np.linspace(-width/2,width/2,across+1)]
            rows.append(row)
        crease_vertices.append(rows[0])
        for i in range(along):
            for j in range(across):
                a,b,c,d=rows[i][j],rows[i][j+1],rows[i+1][j],rows[i+1][j+1]
                faces.extend([[a,b,c],[c,b,d]]);panel_owners.extend([panel,panel])
        panels.append({'index':panel,'alongSubdivisions':along,'rotation':matrix.tolist(),'translation':translation.tolist()})
    crease_vertices.append(rows[-1])
    return np.asarray(vertices),np.asarray(rest),np.asarray(faces),np.asarray(panel_owners),np.asarray(crease_vertices),panels,axis_errors


def inspect(vertices,rest,faces,owners,qa,margin=.004):
    from cloth_study import intersections
    from cloth_clearance import triangle_distance
    edges=np.sort(np.concatenate([faces[:,[0,1]],faces[:,[1,2]],faces[:,[2,0]]]),axis=1)
    edges,counts=np.unique(edges,axis=0,return_counts=True)
    ratios=np.linalg.norm(vertices[edges[:,0]]-vertices[edges[:,1]],axis=1)/np.linalg.norm(rest[edges[:,0]]-rest[edges[:,1]],axis=1)
    neighbors=[[] for _ in vertices]
    for a,b in edges:neighbors[a].append(b);neighbors[b].append(a)
    seen={0};pending=[0]
    while pending:
        a=pending.pop()
        for b in neighbors[a]:
            if b not in seen:seen.add(b);pending.append(b)
    pairs=intersections(vertices,faces.tolist(),None);positive=[];other=[]
    for a,b in pairs:
        verdict=qa.triangle_intersection(vertices[faces[a]],vertices[faces[b]],epsilon=1e-8)
        record={'faces':[a,b],'panels':[int(owners[a]),int(owners[b])],**verdict}
        (positive if verdict['intersects'] else other).append(record)
    triangles=vertices[faces];lo=triangles.min(axis=1);hi=triangles.max(axis=1);sets=[set(f) for f in faces]
    close=[];distance_candidates=0
    for a in range(len(faces)):
        candidates=np.where(np.all(lo[a]-margin<=hi,axis=1)&np.all(hi[a]+margin>=lo,axis=1))[0]
        for b in candidates:
            if b<=a or sets[a].intersection(sets[b]):continue
            distance_candidates+=1
            distance=triangle_distance(triangles[a],triangles[b])
            if distance<margin:close.append({'faces':[a,int(b)],'panels':[int(owners[a]),int(owners[b])],'distance':float(distance),
                                            'materialCenters':rest[faces[[a,b]],:2].mean(axis=1).tolist()})
    return {'finite':bool(np.isfinite(vertices).all()),'connectedVertices':len(seen),'vertices':len(vertices),'faces':len(faces),
            'oneConnectedComponent':len(seen)==len(vertices),'eulerCharacteristic':int(len(vertices)-len(edges)+len(faces)),
            'edgeFaceCountRange':[int(counts.min()),int(counts.max())],
            'triangleEdgeRatioRange':[float(ratios.min()),float(ratios.max())],
            'bvhPairs':len(pairs),'strictIntersections':len(positive),'intersectionDetails':positive,'nonPositiveBVHPairs':other,
            'clearanceMargin':margin,'clearanceBroadPhasePairs':distance_candidates,'pairsBelowMargin':len(close),
            'closestPairs':sorted(close,key=lambda x:x['distance'])[:100],
            'clearanceScope':'All non-shared-vertex explicit triangles; same-panel/local crease pairs retained. Below-margin is a risk measurement, not user acceptance.'}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--design',type=Path,required=True)
    p.add_argument('--qa',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--pitch',type=float,default=.18)
    p.add_argument('--across',type=int,default=8)
    args=p.parse_args()
    if args.pitch<=0 or args.across<2 or args.across%2:p.error('Positive pitch and positive even width subdivisions required')
    if args.out.exists() and any(args.out.iterdir()):p.error('Use a new empty directory')
    args.out.mkdir(parents=True,exist_ok=True)
    source=args.design.read_bytes();design=json.loads(source)
    (args.out/'input-design.json').write_bytes(source)
    (args.out/'construction-source.py').write_bytes(Path(__file__).read_bytes())
    qa_source=args.qa.read_bytes();(args.out/'independent-triangle-qa.py').write_bytes(qa_source)
    spec=importlib.util.spec_from_file_location('independent_triangle_qa',args.qa);qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
    v,flat,faces,owners,creases,panels,axis_errors=construct(design,pitch=args.pitch,across=args.across)
    raw=inspect(v,flat,faces,owners,qa)
    assert raw['oneConnectedComponent'] and raw['eulerCharacteristic']==1 and raw['edgeFaceCountRange']==[1,2]
    assert max(abs(np.array(raw['triangleEdgeRatioRange'])-1))<1e-8
    pins=np.array([creases[0,args.across//2],creases[-1,args.across//2]])
    np.savez_compressed(args.out/'candidate.npz',vertices=v,flatRest=flat,faces=faces,materialCoordinates=flat[:,:2],
                        panelOwner=owners,creaseVertices=creases,freeTipCenterIndices=pins,restWidth=.85,
                        materialCenterline=np.asarray(design['waypoints']),materialCenterlineS=np.asarray(design['s']))
    import bpy
    from mathutils import Vector
    from cloth_study import render_setup
    from PIL import Image,ImageDraw
    bpy.ops.wm.read_factory_settings(use_empty=True);scene=bpy.context.scene
    mesh=bpy.data.meshes.new('One connected explicitly creased rectangle');mesh.from_pydata(v.tolist(),[],faces.tolist());mesh.update()
    ribbon=bpy.data.objects.new('Single bight with its own loose collar',mesh);scene.collection.objects.link(ribbon)
    ribbon.shape_key_add(name='Basis');rest_key=ribbon.shape_key_add(name='Fixed flat material rest');rest_key.data.foreach_set('co',flat.ravel());rest_key.value=0
    render_setup(scene,ribbon,2)
    for polygon in mesh.polygons:
        s=float(flat[list(polygon.vertices),0].mean());stripe=int(s/.85)
        polygon.material_index=0 if s/.85-stripe>.18 else 1+stripe%3
    scene.frame_set(1);bpy.context.view_layer.update()
    evaluated=ribbon.evaluated_get(bpy.context.evaluated_depsgraph_get());evaluated_mesh=evaluated.to_mesh()
    actual=np.array([v.co[:] for v in evaluated_mesh.vertices]);actual_faces=np.array([p.vertices[:] for p in evaluated_mesh.polygons]);evaluated.to_mesh_clear()
    assert np.array_equal(actual_faces,faces),'F1 changed explicit triangulation'
    f1=inspect(actual,flat,faces,owners,qa)
    displacement=np.linalg.norm(actual-v,axis=1)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.out/'developable-initial.blend'))
    entries=[]
    for view in ['front','side']:
        if view=='side':
            scene.camera.location=(25,-8,3);scene.camera.rotation_euler=(Vector((0,1,0))-scene.camera.location).to_track_quat('-Z','Y').to_euler()
        scene.render.filepath=str(args.out/f'{view}-001.png');bpy.ops.render.render(write_still=True);entries.append(args.out/f'{view}-001.png')
    sheet=Image.new('RGB',(960,400),(239,237,231));draw=ImageDraw.Draw(sheet)
    for i,path in enumerate(entries):
        im=Image.open(path).convert('RGBA');tile=Image.new('RGBA',im.size,(239,237,231,255));tile.alpha_composite(im)
        sheet.paste(tile.convert('RGB').resize((480,320)),(480*i,0));draw.text((480*i+10,326),path.stem,fill=(20,20,20))
    draw.text((10,360),f"ONE CONNECTED STRIP / width .85 / F1 strict {f1['strictIntersections']} / static fixture only",fill=(20,20,20))
    sheet.save(args.out/'front-side-contact-sheet.jpg',quality=94)
    report={'schemaVersion':1,'inputSha256':hashlib.sha256(source).hexdigest(),'qaSha256':hashlib.sha256(qa_source).hexdigest(),
            'construction':'Explicit flat creases and rigid panels; no fit or sweep','restWidth':.85,'restLength':design['materialLength'],
            'minimumFlatCreaseSeparation':design['minCreaseSeparation'],'maxIndependentFoldAxisDifference':max(axis_errors),
            'raw':raw,'evaluatedF1':f1,'f1DisplacementMax':float(displacement.max()),'f1DisplacementRms':float(np.sqrt(np.mean(displacement**2))),
            'explicitFacesPreservedAtF1':True,'freeTipCenterIndices':pins.tolist(),'panels':panels,
            'bounds':[v.min(axis=0).tolist(),v.max(axis=0).tolist()],
            'cameraCanvas':[960,640],'registration':[480,320],'physicsRun':False,'topologicalSlipProved':False,
            'visualAdmission':False,'releaseCompleteFrame':None,
            'limits':'Static geometry fixture only. Sharp folds, clearance, framing and actual bight passage require separate evaluation. No independent collar object.'}
    (args.out/'geometry-evidence.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({'strictRaw':raw['strictIntersections'],'strictF1':f1['strictIntersections'],'edgeRatio':raw['triangleEdgeRatioRange'],
                      'clearancePairs':f1['pairsBelowMargin'],'vertices':len(v),'faces':len(faces),'f1Max':float(displacement.max())}),flush=True)


if __name__=='__main__':main()
