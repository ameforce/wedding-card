"""Explicit two-bight crease fabrication with a full-width paper contact gate.

No optimizer, sweep surface or animation. Design stations and one root normal
determine flat creases; rigid-panel construction preserves the flat metric.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
from cloth_construct_developable import construct,inspect,rotation

PAPER_LOW=np.array([-7.,1.6,-4.5])
PAPER_HIGH=np.array([7.,2.3,4.5])


def resolve_design(input_design):
    points=np.asarray(input_design['waypoints'],dtype=float)
    if points.ndim!=2 or points.shape[1]!=3 or not np.isfinite(points).all():raise ValueError('Finite Nx3 explicit stations required')
    root_angle=float(input_design['rootAngle'])
    if not np.isfinite(root_angle):raise ValueError('Finite fixed root angle required')
    tangents=np.diff(points,axis=0);lengths=np.linalg.norm(tangents,axis=1)
    if min(lengths)<1e-8:raise ValueError('Zero-length panel')
    tangents/=lengths[:,None];stations=np.r_[0,lengths.cumsum()]
    normal=np.asarray(input_design.get('rootNormal',[np.cos(root_angle),np.sin(root_angle),0.]),dtype=float)
    normal/=np.linalg.norm(normal)
    # Current reusable fabricator has this explicit root-normal convention.
    if np.linalg.norm(normal-np.array([np.cos(root_angle),np.sin(root_angle),0.]))>1e-8:
        raise ValueError('Root normal must match the declared rootAngle convention')
    if abs(np.dot(normal,tangents[0]))>1e-8:raise ValueError('Root tangent is not perpendicular to root normal')
    director=np.cross(normal,tangents[0]);q=[0.];axes=[director];angles=[0.]
    for index in range(1,len(points)-1):
        before,after=tangents[index-1:index+1]
        delta=after-before
        if np.linalg.norm(delta)<1e-8:
            q.append(0.);axes.append(director.copy());angles.append(0.);continue
        axis=np.cross(normal,delta);axis/=np.linalg.norm(axis)
        if np.dot(axis,director)<0:axis=-axis
        denominator=np.dot(axis,director)
        if abs(denominator)<1e-8:raise ValueError(f'Longitudinal singular crease at station {index}')
        slope=float(np.dot(axis,before)/denominator)
        along=np.dot(axis,before)
        angle=float(np.arctan2(np.dot(axis,np.cross(before,after)),np.dot(before,after)-along*along))
        normal=rotation(axis,angle)@normal;normal/=np.linalg.norm(normal)
        director=np.cross(normal,after);director/=np.linalg.norm(director)
        q.append(slope);axes.append(axis);angles.append(angle)
    q.append(0.);axes.append(director);angles.append(0.)
    separation=lengths-.425*abs(np.diff(q))
    return {**input_design,'waypoints':points.tolist(),'s':stations.tolist(),'q':q,'foldAxes':np.asarray(axes).tolist(),
            'foldAnglesDegrees':np.degrees(angles).tolist(),'materialLength':float(stations[-1]),
            'minCreaseSeparation':float(separation.min()),'creaseSeparations':separation.tolist(),
            'flatDomainValid':bool(min(separation)>0),'fixedRestWidth':.85}


def paper_geometry():
    vertices=np.array([[x,y,z] for x in [PAPER_LOW[0],PAPER_HIGH[0]] for y in [PAPER_LOW[1],PAPER_HIGH[1]] for z in [PAPER_LOW[2],PAPER_HIGH[2]]])
    quads=[[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]]
    faces=np.array([tri for a,b,c,d in quads for tri in [[a,b,c],[a,c,d]]])
    return vertices,faces


def inspect_paper(vertices,faces,owners,qa):
    paper_v,paper_f=paper_geometry();paper_triangles=paper_v[paper_f]
    lo=paper_triangles.min(axis=1);hi=paper_triangles.max(axis=1)
    inside=np.all(vertices>PAPER_LOW+1e-8,axis=1)&np.all(vertices<PAPER_HIGH-1e-8,axis=1)
    positive=[];touch=[];tested=0
    for index,face in enumerate(faces):
        triangle=vertices[face];tlo=triangle.min(axis=0);thi=triangle.max(axis=0)
        candidates=np.where(np.all(tlo-1e-8<=hi,axis=1)&np.all(thi+1e-8>=lo,axis=1))[0]
        for paper_index in candidates:
            tested+=1;verdict=qa.triangle_intersection(triangle,paper_triangles[paper_index],epsilon=1e-8)
            record={'ribbonFace':index,'panel':int(owners[index]),'paperFace':int(paper_index),**verdict}
            if verdict['intersects']:positive.append(record)
            elif verdict['contactOnly']:touch.append(record)
    return {'bounds':[PAPER_LOW.tolist(),PAPER_HIGH.tolist()],'testedTrianglePairs':tested,
            'strictIntersections':len(positive),'verticesStrictlyInside':int(inside.sum()),
            'intersectionDetails':positive,'insideVertexIndices':np.where(inside)[0].tolist(),'boundaryContacts':touch,
            'scope':'Actual full-width explicit ribbon triangles against a closed triangulated paper box, plus strict volume membership.'}


def plan_image(design,out):
    from PIL import Image,ImageDraw
    image=Image.new('RGB',(960,700),(240,237,230));draw=ImageDraw.Draw(image)
    def project(point,side=False):
        return (480+60*point[1 if side else 0],320-60*(point[2]+.65))
    draw.rectangle((60,50,900,590),outline=(120,115,108),width=1)
    points=design['waypoints']
    for i,(a,b) in enumerate(zip(points,points[1:])):
        color=[(30,90,170),(190,65,40),(30,135,80)][i%3]
        draw.line([project(a),project(b)],fill=color,width=3)
        draw.text(project(a),str(i),fill=(20,20,20))
    draw.text((20,640),'EXPLICIT CENTERLINE PLAN ONLY / fixed camera projection / no ribbon surface admission',fill=(20,20,20))
    image.save(out/'station-plan.png')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--design',type=Path,required=True)
    p.add_argument('--qa',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--pitch',type=float,default=.22)
    p.add_argument('--across',type=int,default=8)
    args=p.parse_args()
    if args.pitch<=0 or args.across<2 or args.across%2:p.error('Positive pitch and even width subdivision count required')
    if args.out.exists() and any(args.out.iterdir()):p.error('Use a new empty directory')
    args.out.mkdir(parents=True,exist_ok=True)
    source=args.design.read_bytes();input_design=json.loads(source)
    (args.out/'input-design.json').write_bytes(source)
    (args.out/'construction-source.py').write_bytes(Path(__file__).read_bytes())
    design=resolve_design(input_design)
    (args.out/'resolved-design.json').write_text(json.dumps(design,indent=2));plan_image(design,args.out)
    gate={'schemaVersion':1,'inputSha256':hashlib.sha256(source).hexdigest(),'flatDomainValid':design['flatDomainValid'],
          'minimumCreaseSeparation':design['minCreaseSeparation'],'physicsRun':False,'visualAdmission':False,'releaseCompleteFrame':None}
    if not design['flatDomainValid']:
        gate['failureBoundary']='Flat crease lines cross inside the .85-wide rectangle; no surface or F1 evaluation was produced.'
        (args.out/'preflight-evidence.json').write_text(json.dumps(gate,indent=2));print(json.dumps(gate),flush=True);return
    spec=importlib.util.spec_from_file_location('independent_triangle_qa',args.qa);qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
    gate['qaSha256']=hashlib.sha256(args.qa.read_bytes()).hexdigest()
    v,flat,faces,owners,creases,panels,axis_errors=construct(design,pitch=args.pitch,across=args.across)
    cloth=inspect(v,flat,faces,owners,qa);paper=inspect_paper(v,faces,owners,qa)
    gate.update({'cloth':cloth,'paper':paper,'maxFoldAxisDifference':max(axis_errors),'bounds':[v.min(axis=0).tolist(),v.max(axis=0).tolist()]})
    pins=np.array([creases[0,args.across//2],creases[-1,args.across//2]])
    np.savez_compressed(args.out/'candidate.npz',vertices=v,flatRest=flat,faces=faces,materialCoordinates=flat[:,:2],
                        panelOwner=owners,creaseVertices=creases,freeTipCenterIndices=pins,restWidth=.85,
                        materialCenterline=np.asarray(design['waypoints']),materialCenterlineS=np.asarray(design['s']))
    passed=(cloth['strictIntersections']==0 and paper['strictIntersections']==0 and paper['verticesStrictlyInside']==0
            and cloth['oneConnectedComponent'] and cloth['eulerCharacteristic']==1
            and max(abs(np.array(cloth['triangleEdgeRatioRange'])-1))<1e-8)
    gate['preflightPassed']=passed
    (args.out/'preflight-evidence.json').write_text(json.dumps(gate,indent=2))
    if not passed:
        print(json.dumps({'preflightPassed':False,'self':cloth['strictIntersections'],'paper':paper['strictIntersections'],'inside':paper['verticesStrictlyInside']}),flush=True);return
    import bpy
    from mathutils import Vector
    from cloth_study import render_setup
    from PIL import Image,ImageDraw
    bpy.ops.wm.read_factory_settings(use_empty=True);scene=bpy.context.scene
    mesh=bpy.data.meshes.new('Explicit two-bight continuous strip');mesh.from_pydata(v.tolist(),[],faces.tolist());mesh.update()
    ribbon=bpy.data.objects.new('Two bights and paper bridge in one strip',mesh);scene.collection.objects.link(ribbon)
    ribbon.shape_key_add(name='Basis');rest_key=ribbon.shape_key_add(name='Fixed flat rest');rest_key.data.foreach_set('co',flat.ravel());rest_key.value=0
    render_setup(scene,ribbon,2)
    for polygon in mesh.polygons:
        s=float(flat[list(polygon.vertices),0].mean());stripe=int(s/.85)
        polygon.material_index=0 if s/.85-stripe>.18 else 1+stripe%3
    scene.frame_set(1);bpy.context.view_layer.update()
    evaluated=ribbon.evaluated_get(bpy.context.evaluated_depsgraph_get());ev=evaluated.to_mesh()
    actual=np.array([p.co[:] for p in ev.vertices]);evaluated_faces=np.array([p.vertices[:] for p in ev.polygons]);evaluated.to_mesh_clear()
    assert np.array_equal(evaluated_faces,faces)
    gate['F1Cloth']=inspect(actual,flat,faces,owners,qa);gate['F1Paper']=inspect_paper(actual,faces,owners,qa)
    gate['F1MaxDisplacement']=float(np.linalg.norm(actual-v,axis=1).max())
    paper_vertices,paper_faces=paper_geometry()
    paper_mesh=bpy.data.meshes.new('Exactly checked paper box');paper_mesh.from_pydata(paper_vertices.tolist(),[],paper_faces.tolist())
    paper_object=bpy.data.objects.new('Checked paper occlusion',paper_mesh);scene.collection.objects.link(paper_object)
    holdout=bpy.data.materials.new('Paper holdout');holdout.use_nodes=True;nodes=holdout.node_tree.nodes;nodes.clear()
    shader=nodes.new('ShaderNodeHoldout');output=nodes.new('ShaderNodeOutputMaterial');holdout.node_tree.links.new(shader.outputs[0],output.inputs[0])
    paper_mesh.materials.append(holdout)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.out/'fullbow-initial.blend'))
    images=[]
    for view in ['front','side']:
        if view=='side':
            scene.camera.location=(25,-8,3);scene.camera.rotation_euler=(Vector((0,1,0))-scene.camera.location).to_track_quat('-Z','Y').to_euler()
            paper_object.hide_render=True
        path=args.out/f'{view}-001.png';scene.render.filepath=str(path);bpy.ops.render.render(write_still=True);images.append(path)
    sheet=Image.new('RGB',(960,380),(240,237,230));draw=ImageDraw.Draw(sheet)
    for i,path in enumerate(images):
        im=Image.open(path).convert('RGBA');bg=Image.new('RGBA',im.size,(240,237,230,255));bg.alpha_composite(im)
        sheet.paste(bg.convert('RGB').resize((480,320)),(i*480,0));draw.text((i*480+10,330),path.stem,fill=(20,20,20))
    sheet.save(args.out/'front-side-contact-sheet.jpg',quality=94)
    gate['frontUsesCheckedPaperOcclusion']=True;gate['sidePaperHiddenForInspection']=True
    (args.out/'F1-evidence.json').write_text(json.dumps(gate,indent=2))
    print(json.dumps({'preflightPassed':True,'F1Self':gate['F1Cloth']['strictIntersections'],'F1Paper':gate['F1Paper']['strictIntersections']}),flush=True)


if __name__=='__main__':main()
