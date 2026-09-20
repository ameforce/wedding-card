"""Separate only post-release common world-Z descent from an exact Cloth cache.

The caller supplies the release frame. Paper clearance is checked, but this tool
cannot certify knot release, visual acceptance, or readiness for publication.
"""
import argparse
import hashlib
import json
from pathlib import Path

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def array_sha(array):
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def evaluated_mesh(obj):
    evaluated=obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh=evaluated.to_mesh()
    try:
        return (np.array([v.co[:] for v in mesh.vertices],dtype=np.float32),
                np.array([p.vertices[:] for p in mesh.polygons],dtype=np.int64))
    finally:
        evaluated.to_mesh_clear()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache',type=Path,required=True)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--release-complete-source-frame',type=int,required=True)
    args=parser.parse_args()
    if args.out.exists() and (not args.out.is_dir() or any(args.out.iterdir())):
        raise ValueError('Output must be new or empty')
    with np.load(args.cache,allow_pickle=False) as data:
        vertices,faces,flat=(data[k].copy() for k in ['vertices','faces','flatRest'])
    if vertices.ndim!=3 or vertices.shape[2]!=3 or len(vertices)==0 or flat.shape!=vertices.shape[1:]:
        raise ValueError('Expected nonempty vertices[F,N,3] and flatRest[N,3]')
    if faces.ndim!=2 or faces.shape[1]!=3 or len(faces)==0 or not np.issubdtype(faces.dtype,np.integer):
        raise ValueError('Explicit integer triangles required')
    if faces.min()<0 or faces.max()>=len(flat):raise ValueError('Face outside mesh')
    if not np.isfinite(vertices).all() or not np.isfinite(flat).all():raise ValueError('Nonfinite input')
    release=args.release_complete_source_frame-1
    if not 0<=release<len(vertices):raise ValueError('Release frame outside cache')
    if np.ptp(flat[:,2])!=0:raise ValueError('flatRest must lie in a material XY plane')
    triangles=flat.astype(np.float64)[faces]
    area=np.linalg.norm(np.cross(triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0]),axis=1)/2
    if np.any(area<=0):raise ValueError('Degenerate rest triangle')
    weights=np.zeros(len(flat),dtype=np.float64)
    for corner in range(3):np.add.at(weights,faces[:,corner],area/3)
    weights/=weights.sum()

    bpy.context.preferences.filepaths.use_scripts_auto_execute=False
    bpy.ops.wm.open_mainfile(filepath=str(args.source.resolve()),load_ui=False,use_scripts=False)
    scene=bpy.context.scene;saved_frame=scene.frame_current
    ribbon=bpy.data.objects.get('One physical ribbon')
    if ribbon is None or ribbon.type!='MESH':raise ValueError('Source ribbon is missing')
    cloth=next((m for m in ribbon.modifiers if m.type=='CLOTH'),None)
    rest=cloth.settings.rest_shape_key if cloth else None
    if rest is None and ribbon.data.shape_keys:rest=ribbon.data.shape_keys.key_blocks.get('Unchanged flat material')
    if rest is None or not np.array_equal(np.array([v.co[:] for v in rest.data],dtype=np.float32),flat.astype(np.float32)):
        raise ValueError('Source and cache flatRest differ')
    if not np.array_equal(np.array([p.vertices[:] for p in ribbon.data.polygons]),faces):
        raise ValueError('Source and cache explicit triangles differ')
    scene.frame_set(1);bpy.context.view_layer.update()
    actual,actual_faces=evaluated_mesh(ribbon)
    if not np.array_equal(actual_faces,faces) or not np.array_equal(actual,vertices[0].astype(np.float32)):
        raise ValueError('Cache F1 does not match evaluated source F1 at float32 precision')
    transform=np.array(ribbon.matrix_world,dtype=np.float64)
    if not np.isfinite(transform).all() or abs(np.linalg.det(transform[:3,:3]))<1e-12:
        raise ValueError('Source object transform is not invertible')
    world=vertices.astype(np.float64)@transform[:3,:3].T+transform[:3,3]
    camera=scene.camera
    if camera is None or camera.data.type!='ORTHO':raise ValueError('Orthographic front camera required')
    rotation=np.array(camera.matrix_world.to_3x3().normalized(),dtype=np.float64)
    expected=np.array([[1,0,0],[0,0,-1],[0,1,0]],dtype=np.float64)
    if not np.allclose(rotation,expected,rtol=0,atol=1e-6):
        raise ValueError('Camera must face world +Y with screen up world +Z and right world +X')
    scene.render.resolution_x=960;scene.render.resolution_y=640;scene.render.resolution_percentage=100
    origin=world_to_camera_view(scene,camera,Vector((0,0,0)))
    up=world_to_camera_view(scene,camera,Vector((0,0,1)))
    pixels_per_unit=float((up.y-origin.y)*640)
    if not np.isfinite(pixels_per_unit) or pixels_per_unit<=0:raise ValueError('Invalid camera pixel conversion')
    papers=[o for o in scene.objects if o.type=='MESH' and o!=ribbon and any(m.name=='Paper contact' and m.type=='COLLISION' for m in o.modifiers)]
    if len(papers)!=1:raise ValueError('Exactly one source Paper contact collider required')
    paper=papers[0];paper_vertices,_=evaluated_mesh(paper)
    paper_matrix=np.array(paper.matrix_world,dtype=np.float64)
    paper_world=paper_vertices.astype(np.float64)@paper_matrix[:3,:3].T+paper_matrix[:3,3]
    low,high=paper_world.min(axis=0),paper_world.max(axis=0)
    # The front-plane test is valid only for the source axis-aligned box.
    if np.any(high<=low) or len(np.unique(paper_world,axis=0))!=8 or not np.all(np.isclose(paper_world,low,atol=1e-6,rtol=0)|np.isclose(paper_world,high,atol=1e-6,rtol=0)):
        raise ValueError('Only an axis-aligned paper box is supported')
    outer=float(paper.collision.thickness_outer)
    clear_front=float(low[1]-outer)
    max_y=world[release:,:,1].max(axis=1)
    if np.any(max_y>=clear_front):
        first=release+int(np.flatnonzero(max_y>=clear_front)[0])+1
        raise ValueError(f'Paper behind/contact remains at source frame {first}')
    centroid=np.einsum('fnc,n->fc',world,weights)
    descent=centroid[release:,2]-centroid[release,2]
    if np.any(np.diff(centroid[release:,2])>0):
        raise ValueError('Post-release material centroid is not downward-only; no clamping is permitted')
    root_z=np.zeros(len(vertices),dtype=np.float64);root_z[release:]=descent
    translation=np.zeros((len(vertices),3),dtype=np.float64);translation[:,2]=root_z
    local_translation=translation@np.linalg.inv(transform[:3,:3]).T
    relative=vertices.astype(np.float64)-local_translation[:,None,:]
    restored=relative+local_translation[:,None,:]
    error=np.abs(restored-vertices.astype(np.float64))
    tolerance=8*np.finfo(np.float64).eps*np.maximum(1,np.abs(vertices.astype(np.float64))+np.abs(local_translation[:,None,:]))
    if not np.all(error<=tolerance):raise ValueError('Root reconstruction exceeds float64 roundoff bound')
    if not np.array_equal(relative[:release+1],vertices[:release+1]):raise ValueError('Early root extraction changed coordinates')
    root_px=-root_z*pixels_per_unit
    args.out.mkdir(parents=True,exist_ok=True)
    np.savez_compressed(args.out/'relative-cache.npz',vertices=relative,faces=faces,flatRest=flat)
    source_files=[{'path':str(p.resolve()),'sha256':sha(p)} for p in [args.cache,args.source,Path(__file__)]]
    track={'schemaVersion':1,'sourceFrameBase':1,'releaseCompleteSourceFrame':release+1,
           'releaseCompleteFrame':release+1,'releaseFrameBase':1,'releaseClaim':'Caller-supplied; paper clearance only, not knot-release certification',
           'rootYPx':root_px.tolist(),'worldTranslationZ':root_z.tolist(),
           'localTranslation':local_translation.tolist(),'coordinateContract':'raw local vertices = relative local vertices + localTranslation[sourceFrame-1]',
           'camera':{'matrixWorld':np.array(camera.matrix_world).tolist(),'orthoScale':camera.data.ortho_scale,'shiftX':camera.data.shift_x,'shiftY':camera.data.shift_y,
                     'canvas':[960,640],'pixelAspect':[scene.render.pixel_aspect_x,scene.render.pixel_aspect_y],'pixelsPerWorldZUnit':pixels_per_unit,'registrationPx':[480,320]},
           'objectMatrixWorld':transform.tolist(),'inputs':source_files,
           'centroidMethod':'Fixed flatRest triangle area / 3 accumulated to each material vertex',
           'physicsAdmission':False,'visualAdmission':False,'publicMappingApplied':False}
    (args.out/'root-track.json').write_text(json.dumps(track,indent=2))
    report={'sourceSavedFrame':saved_frame,'sourceEvaluatedFrame':1,'firstFrameMaxDifference':float(np.abs(actual-vertices[0]).max()),
            'allFrames':len(vertices),'releaseFrame':release+1,'preservedThroughRelease':True,'maxReconstructionError':float(error.max()),
            'reconstructionBound':'8 * float64 epsilon * max(1, abs(raw)+abs(localTranslation)); no pose tolerance',
            'facesSha256':array_sha(faces),'flatRestSha256':array_sha(flat),'weightsSha256':array_sha(weights),
            'paper':{'name':paper.name,'bounds':[low.tolist(),high.tolist()],'collisionThicknessOuter':outer,'requiredMaxWorldYExclusive':clear_front,
                     'postReleaseMinimumFrontClearance':float(clear_front-max_y.max())},
            'monotonicDownward':True,'rootBeforeReleaseZero':bool(np.all(root_z[:release+1]==0)),
            'limitations':['Caller release frame is not independently proven knot release.','Only fixed F1 front orthographic camera and axis-aligned source paper box are supported.','No public frame mapping, viewport exit, terminal frame, or visual approval is generated.'],
            'inputs':source_files,'outputs':[{'path':name,'sha256':sha(args.out/name)} for name in ['relative-cache.npz','root-track.json']]}
    with np.load(args.out/'relative-cache.npz') as saved:
        if not np.array_equal(saved['faces'],faces) or not np.array_equal(saved['flatRest'],flat):raise ValueError('Output topology/rest changed')
    (args.out/'validation.json').write_text(json.dumps(report,indent=2))
    (args.out/'extractor-source.py').write_bytes(Path(__file__).read_bytes())
    print(json.dumps(report),flush=True)


if __name__=='__main__':main()
