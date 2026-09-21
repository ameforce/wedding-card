"""Render exact saved Cloth vertices using one immutable source camera.

Source frames are one-based, output frame ids zero-based. No interpolation,
geometry modifier, root extraction, crop, recentering or scale normalization.
Paper shadows are re-rendered from each selected physical snapshot.
"""
import argparse
import hashlib
import json
from pathlib import Path

import bpy
import numpy as np
from PIL import Image
from mathutils import Vector


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def array_sha(array):
    array=np.ascontiguousarray(array)
    return hashlib.sha256(array.tobytes()).hexdigest()


def frame_mapping(frames,mapping,count):
    if frames is not None:
        selected=[int(value.strip()) for value in frames.split(',')]
        rows=[{'outputFrame':i,'sourceFrame':frame} for i,frame in enumerate(selected)]
    else:
        spec=json.loads(mapping.read_bytes())
        if spec.get('schemaVersion')!=1 or spec.get('sourceFrameBase')!=1 or spec.get('outputFrameBase')!=0:
            raise ValueError('Mapping schemaVersion=1, sourceFrameBase=1, outputFrameBase=0 required')
        rows=spec['frames']
    if not rows:raise ValueError('At least one exact source frame is required')
    used=set()
    for row in rows:
        if set(row)!={'sourceFrame','outputFrame'}:raise ValueError('Mapping entries contain only sourceFrame/outputFrame')
        source,output=row['sourceFrame'],row['outputFrame']
        if type(source)!=int or not 1<=source<=count:raise ValueError('Source frame outside recorded cache')
        if type(output)!=int or output<0 or output in used:raise ValueError('Unique nonnegative output frame ids required')
        used.add(output)
    if [r['outputFrame'] for r in rows]!=sorted(used):raise ValueError('Output ids must be increasing')
    return rows


def camera_readback(scene):
    camera=scene.camera
    if camera is None:raise ValueError('Source must contain its authored camera')
    return {'name':camera.name,'matrixWorld':np.array(camera.matrix_world).tolist(),'type':camera.data.type,
            'orthoScale':camera.data.ortho_scale,'lens':camera.data.lens,'shiftX':camera.data.shift_x,'shiftY':camera.data.shift_y,
            'clipStart':camera.data.clip_start,'clipEnd':camera.data.clip_end,
            'canvas':[scene.render.resolution_x,scene.render.resolution_y],
            'pixelAspect':[scene.render.pixel_aspect_x,scene.render.pixel_aspect_y],'registrationPx':[480,320]}


def light_readback(scene):
    return [{'name':o.name,'type':o.data.type,'matrixWorld':np.array(o.matrix_world).tolist(),
             'energy':o.data.energy,'color':list(o.data.color),'size':getattr(o.data,'size',None)}
            for o in scene.objects if o.type=='LIGHT']


def material(name,color,roughness=.8,anisotropy=0.):
    mat=bpy.data.materials.new(name);mat.use_nodes=True
    shader=mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value=(*color,1)
    shader.inputs['Roughness'].default_value=roughness
    anisotropic=shader.inputs.get('Anisotropic IOR Level') or shader.inputs.get('Anisotropic')
    if anisotropic is not None:anisotropic.default_value=anisotropy
    if anisotropy:
        tangent=mat.node_tree.nodes.new('ShaderNodeTangent');tangent.direction_type='UV_MAP';tangent.uv_map='Fixed material coordinates'
        mat.node_tree.links.new(tangent.outputs['Tangent'],shader.inputs['Tangent'])
    return mat


def fixed_material(ribbon,flat,kind):
    mesh=ribbon.data;mesh.materials.clear()
    while mesh.uv_layers:mesh.uv_layers.remove(mesh.uv_layers[0])
    uv=mesh.uv_layers.new(name='Fixed material coordinates')
    width=float(np.ptp(flat[:,1]));start=float(flat[:,0].min());bottom=float(flat[:,1].min())
    if width<=0:raise ValueError('Positive flat material width required')
    coordinates=np.c_[(flat[:,0]-start)/width,(flat[:,1]-bottom)/width]
    for polygon in mesh.polygons:
        for loop_index,vertex_index in zip(polygon.loop_indices,polygon.vertices):
            uv.data[loop_index].uv=coordinates[vertex_index]
        polygon.use_smooth=(kind=='satin')
    if kind=='satin':
        mesh.materials.append(material('Original ivory satin',(0.82,.78,.67),roughness=.28,anisotropy=.65))
        for polygon in mesh.polygons:polygon.material_index=0
    else:
        for i,color in enumerate([(0.72,.72,.69),(.08,.25,.62),(.85,.2,.1),(.06,.5,.28)]):
            mesh.materials.append(material(f'Fixed diagnostic stripe {i}',color))
        for polygon in mesh.polygons:
            s=float(flat[list(polygon.vertices),0].mean())
            polygon.material_index=0 if s%1.2>.22 else 1+int(s/1.2)%3
    values=np.array([entry.uv[:] for entry in uv.data],dtype=np.float32)
    return {'kind':kind,'uvLayer':uv.name,'uvSha256':array_sha(values),'restWidth':width,
            'uvFormula':'u=(rest_s-min_s)/rest_width; v=(rest_t-min_t)/rest_width; fixed for the entire cache',
            'smoothPolygonNormals':kind=='satin','geometryModifiers':[],
            'satinParameters':{'baseColorLinear':[.82,.78,.67],'roughness':.28,'anisotropy':.65} if kind=='satin' else None}


def paper_readback(paper):
    corners=np.array([paper.matrix_world@Vector(v) for v in paper.bound_box])
    return {'name':paper.name,'matrixWorld':np.array(paper.matrix_world).tolist(),'dimensions':list(paper.dimensions),
            'bounds':[corners.min(axis=0).tolist(),corners.max(axis=0).tolist()],
            'sourceHideRender':paper.hide_render,'sourceShadowCatcher':paper.is_shadow_catcher,
            'meshVerticesSha256':array_sha(np.array([v.co[:] for v in paper.data.vertices],dtype=np.float32)),
            'sourceModifiers':[{'name':m.name,'type':m.type} for m in paper.modifiers]}


def alpha_readback(path):
    rgba=np.array(Image.open(path).convert('RGBA'));alpha=rgba[:,:,3]
    bbox=Image.fromarray(alpha).getbbox()
    return {'dimensions':[rgba.shape[1],rgba.shape[0]],'alphaRange':[int(alpha.min()),int(alpha.max())],
            'nonzeroAlphaPixels':int(np.count_nonzero(alpha)),'nontransparentBounds':list(bbox) if bbox else None,
            'alphaTouchesCanvas':{'top':bool(alpha[0].any()),'bottom':bool(alpha[-1].any()),
                                  'left':bool(alpha[:,0].any()),'right':bool(alpha[:,-1].any())}}


def render_pass(scene,path):
    scene.render.filepath=str(path);bpy.ops.render.render(write_still=True)
    return {'path':path.name,'sha256':sha(path),**alpha_readback(path)}


def shadow_pass_compositor(scene):
    """Write the unmodified Cycles Shadow Catcher pass.

    A shadow-catcher pass is multiplicative footage, not a black-alpha matte.
    Converting its display-referred luminance with ``1 - luminance`` leaves a
    visible rectangle whenever the unoccluded receiver is not encoded as pure
    white.  Keep the pass intact here and compare it with a no-caster baseline
    after rendering instead.
    """
    scene.use_nodes=True;tree=scene.node_tree;tree.nodes.clear()
    layers=tree.nodes.new('CompositorNodeRLayers')
    if layers.outputs.get('Shadow Catcher') is None:raise ValueError('Cycles Shadow Catcher pass is unavailable')
    output=tree.nodes.new('CompositorNodeComposite')
    tree.links.new(layers.outputs['Shadow Catcher'],output.inputs['Image'])


def shadow_matte(baseline_path, shadow_path, receiver_path, output_path):
    """Convert a catcher ratio relative to its no-caster baseline into alpha."""
    baseline=np.asarray(Image.open(baseline_path).convert('RGBA'),dtype=np.float32)/255.
    shadow=np.asarray(Image.open(shadow_path).convert('RGBA'),dtype=np.float32)/255.
    receiver=np.asarray(Image.open(receiver_path).convert('RGBA'),dtype=np.float32)/255.
    weights=np.array([.2126,.7152,.0722],dtype=np.float32)
    baseline_luma=baseline[:,:,:3]@weights
    shadow_luma=shadow[:,:,:3]@weights
    ratio=np.divide(shadow_luma,baseline_luma,out=np.ones_like(shadow_luma),where=baseline_luma>1/255)
    loss=np.clip(1-ratio,0,1)*receiver[:,:,3]
    rgba=np.zeros((*loss.shape,4),dtype=np.uint8)
    rgba[:,:,3]=np.rint(loss*255).astype(np.uint8)
    Image.fromarray(rgba,'RGBA').save(output_path)
    return {'maximumAlpha':int(rgba[:,:,3].max()),'nonzeroAlphaPixels':int(np.count_nonzero(rgba[:,:,3]))}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache',type=Path,required=True)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--frames',help='Comma-separated one-based exact cache frames, e.g. 1,180,360')
    group.add_argument('--mapping',type=Path,help='Explicit schemaVersion 1 source/output frame mapping')
    parser.add_argument('--material',choices=['neutral','satin'],default='neutral')
    parser.add_argument('--samples',type=int,default=32)
    parser.add_argument('--paper-object',help='Exact source object name; default finds the Paper contact collider')
    parser.add_argument('--paper-mode',choices=['shadow','holdout','source-hidden'],default='shadow',
                        help='source-hidden is a diagnostic control only')
    parser.add_argument('--append-transparent-terminal',action='store_true',
                        help='Append one fixed-canvas fully transparent PNG after every mapped visible frame')
    args=parser.parse_args()
    if args.samples<1:parser.error('Positive Cycles samples required')
    if args.out.exists() and any(args.out.iterdir()):parser.error('Output must be new or empty')
    data=np.load(args.cache,allow_pickle=False)
    frames,faces,flat=data['vertices'],data['faces'],data['flatRest']
    if frames.ndim!=3 or frames.shape[2]!=3 or flat.shape!=frames.shape[1:]:parser.error('Expected vertices[F,N,3] and flatRest[N,3]')
    if faces.ndim!=2 or faces.shape[1]!=3 or not np.issubdtype(faces.dtype,np.integer):parser.error('Explicit integer triangles required')
    if faces.min()<0 or faces.max()>=len(flat):parser.error('Face index outside mesh')
    if not np.isfinite(frames).all() or not np.isfinite(flat).all():parser.error('Cache and rest must be finite')
    try:mapping=frame_mapping(args.frames,args.mapping,len(frames))
    except (ValueError,KeyError,TypeError) as error:parser.error(str(error))
    args.out.mkdir(parents=True,exist_ok=True)
    (args.out/'renderer-source.py').write_bytes(Path(__file__).read_bytes())
    if args.mapping:(args.out/'input-mapping.json').write_bytes(args.mapping.read_bytes())
    bpy.context.preferences.filepaths.use_scripts_auto_execute=False
    bpy.ops.wm.open_mainfile(filepath=str(args.source.resolve()),load_ui=False,use_scripts=False)
    scene=bpy.context.scene
    ribbon=bpy.data.objects.get('One physical ribbon') or bpy.data.objects.get('One locally sliding bow strip')
    if ribbon is None or ribbon.type!='MESH':raise ValueError('A recognized single physical ribbon mesh is required')
    original_faces=np.array([p.vertices[:] for p in ribbon.data.polygons])
    if not np.array_equal(original_faces,faces):raise ValueError('Source and cache explicit triangles differ')
    if len(ribbon.data.vertices)!=len(flat):raise ValueError('Source and cache vertex counts differ')
    cloth=next((m for m in ribbon.modifiers if m.type=='CLOTH'),None)
    rest_key=cloth.settings.rest_shape_key if cloth else None
    if rest_key is None and ribbon.data.shape_keys:
        rest_key=ribbon.data.shape_keys.key_blocks.get('Unchanged flat material')
    if rest_key is None:raise ValueError('Source fixed flat-rest Shape Key is required for identity matching')
    source_flat=np.array([v.co[:] for v in rest_key.data],dtype=np.float32)
    if not np.array_equal(source_flat,flat.astype(np.float32)):raise ValueError('Source and cache fixed flat rest differ')
    saved_frame=scene.frame_current
    # Evaluate the intact source at F1 before freezing animation or removing
    # deformation. A blend saved at F10 is not the authored F1 state.
    scene.frame_set(1);bpy.context.view_layer.update()
    evaluated=ribbon.evaluated_get(bpy.context.evaluated_depsgraph_get())
    initial_mesh=evaluated.to_mesh()
    try:
        source_vertices=np.array([v.co[:] for v in initial_mesh.vertices],dtype=np.float32)
        source_faces=np.array([p.vertices[:] for p in initial_mesh.polygons])
    finally:
        evaluated.to_mesh_clear()
    if not np.array_equal(source_faces,faces):raise ValueError('Evaluated source F1 and cache explicit triangles differ')
    # Blender mesh coordinates are float32. Permit only differences that round
    # to that identical representable value, never a configurable pose offset.
    if not np.array_equal(source_vertices,frames[0].astype(np.float32)):
        raise ValueError('Cache F1 does not match evaluated source F1 at float32 precision')
    source_state={'objectMatrixWorld':np.array(ribbon.matrix_world).tolist(),'sourceFrame':saved_frame,'evaluatedFrame':1,
                  'modifiers':[{'name':m.name,'type':m.type} for m in ribbon.modifiers],
                  'fixedRestKey':rest_key.name,'firstCacheVsSourceMax':float(np.linalg.norm(frames[0]-source_vertices,axis=1).max()),
                  'firstFrameIdentity':'Exact equality after float32 cast; source evaluated with intact modifiers and animation at F1',
                  'evaluatedF1VerticesSha256':array_sha(source_vertices)}
    if args.paper_object:
        papers=[bpy.data.objects[args.paper_object]]
    else:
        papers=[o for o in scene.objects if o.type=='MESH' and o!=ribbon
                and any(m.name in ('Paper contact','Real paper collision') or m.type=='COLLISION' for m in o.modifiers)]
    paper_records=[paper_readback(paper) for paper in papers]
    # Freeze only after the intact F1 consumer and cache identity were proved.
    ribbon.modifiers.clear();ribbon.shape_key_clear();ribbon.animation_data_clear()
    for obj in [scene.camera,*[o for o in scene.objects if o.type=='LIGHT'],*papers]:
        if obj is not None:obj.animation_data_clear()
        if obj is not None and obj.data:obj.data.animation_data_clear()
    bpy.context.view_layer.update()
    scene.render.engine='CYCLES';scene.cycles.samples=args.samples;scene.cycles.seed=0
    scene.cycles.use_animated_seed=False;scene.cycles.use_denoising=True
    scene.render.resolution_x=960;scene.render.resolution_y=640;scene.render.resolution_percentage=100
    scene.render.use_border=False;scene.render.use_crop_to_border=False;scene.render.film_transparent=True
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA';scene.render.image_settings.color_depth='8'
    # A saved compositor must not add old imagery or a fixed shadow.
    scene.use_nodes=False
    material_record=fixed_material(ribbon,flat,args.material)
    camera=camera_readback(scene);lights=light_readback(scene)
    world={'name':scene.world.name if scene.world else None,'useNodes':scene.world.use_nodes if scene.world else False,
           'nodeValues':[{ 'name':n.name,'type':n.type,'strength':n.inputs['Strength'].default_value if n.type=='BACKGROUND' else None,
                          'color':list(n.inputs['Color'].default_value) if n.type=='BACKGROUND' else None}
                         for n in scene.world.node_tree.nodes] if scene.world and scene.world.use_nodes else []}
    holdout=bpy.data.materials.new('Exact paper ray holdout');holdout.use_nodes=True;nodes=holdout.node_tree.nodes;nodes.clear()
    shader=nodes.new('ShaderNodeHoldout');output=nodes.new('ShaderNodeOutputMaterial');holdout.node_tree.links.new(shader.outputs[0],output.inputs['Surface'])
    catcher=material('Actual paper shadow receiver',(1.,1.,1.),roughness=1.)
    receiver_record=None;shadow_baseline_record=None;shadow_baseline_path=None
    if papers and args.paper_mode=='shadow':
        emission=bpy.data.materials.new('Paper receiver domain only');emission.use_nodes=True;nodes=emission.node_tree.nodes;nodes.clear()
        shader=nodes.new('ShaderNodeEmission');shader.inputs['Color'].default_value=(1.,1.,1.,1.)
        output=nodes.new('ShaderNodeOutputMaterial');emission.node_tree.links.new(shader.outputs[0],output.inputs['Surface'])
        ribbon.visible_camera=False
        for paper in papers:
            paper.hide_render=False;paper.is_shadow_catcher=False;paper.data.materials.clear();paper.data.materials.append(emission)
        receiver_path=args.out/'paper-receiver-mask.png';receiver_record=render_pass(scene,receiver_path)
        ribbon.visible_camera=True
        scene.view_layers[0].cycles.use_pass_shadow_catcher=True
        shadow_pass_compositor(scene)
        shadow_baseline_path=args.out/'paper-shadow-baseline.png'
        ribbon.visible_camera=False;ribbon.visible_shadow=False
        for paper in papers:
            paper.hide_render=False;paper.is_shadow_catcher=True
            paper.data.materials.clear();paper.data.materials.append(catcher)
        shadow_baseline_record=render_pass(scene,shadow_baseline_path)
        ribbon.visible_shadow=True;ribbon.visible_camera=True;scene.use_nodes=False
    metadata=[]
    for name in ['simulation-evidence.json','input-audit.json']:
        path=args.source.parent/name
        if path.exists():metadata.append({'path':str(path.resolve()),'sha256':sha(path)})
    evidence={'schemaVersion':1,'rendererSha256':sha(Path(__file__)),'bpyVersion':bpy.app.version_string,
              'cache':{'path':str(args.cache.resolve()),'sha256':sha(args.cache),'frames':len(frames),'vertices':len(flat),'faces':len(faces),
                       'facesSha256':array_sha(faces),'flatRestSha256':array_sha(flat)},
              'source':{'path':str(args.source.resolve()),'sha256':sha(args.source),'readback':source_state,'metadata':metadata},
              'camera':camera,'lights':lights,'world':world,'paper':paper_records,'paperMode':args.paper_mode,
              'paperReceiverMask':receiver_record,'paperShadowBaseline':shadow_baseline_record,
              'colorManagement':{'viewTransform':scene.view_settings.view_transform,'look':scene.view_settings.look,
                                 'exposure':scene.view_settings.exposure,'gamma':scene.view_settings.gamma},
              'material':material_record,'samples':args.samples,'mapping':mapping,'frames':[],
              'sourceFrameBase':1,'outputFrameBase':0,'geometryInterpolation':False,'rootExtraction':False,
              'cameraOrScaleNormalization':False,'physicsAdmission':False,'visualAdmission':False,'releaseCompleteFrame':None,
              'shadowMethod':'Per-frame explicit Cycles Shadow Catcher pass divided by a no-caster baseline. Alpha=clamp(1-current/baseline)*actual paper receiver alpha; black matte under exact holdout ribbon. No reused or blurred shadow.',
              'shadowReference':'https://docs.blender.org/manual/en/4.5/render/layers/passes.html'}
    for row in mapping:
        xyz=frames[row['sourceFrame']-1]
        ribbon.data.vertices.foreach_set('co',xyz.ravel());ribbon.data.update();bpy.context.view_layer.update()
        ev=ribbon.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=ev.to_mesh()
        actual=np.array([v.co[:] for v in mesh.vertices],dtype=np.float32);actual_faces=np.array([p.vertices[:] for p in mesh.polygons]);ev.to_mesh_clear()
        if not np.array_equal(actual,xyz.astype(np.float32)) or not np.array_equal(actual_faces,faces):
            raise ValueError('Render consumer changed exact saved vertices or explicit triangles')
        if ribbon.modifiers or ribbon.data.shape_keys:raise ValueError('Geometry-changing render state appeared')
        uv_hash=array_sha(np.array([entry.uv[:] for entry in ribbon.data.uv_layers['Fixed material coordinates'].data],dtype=np.float32))
        if uv_hash!=material_record['uvSha256']:raise ValueError('Material UV changed across snapshots')
        if camera_readback(scene)!=camera or light_readback(scene)!=lights:raise ValueError('Camera or lights changed during rendering')
        stem=f"frame-{row['outputFrame']:03d}";passes=[]
        for paper in papers:
            paper.hide_render=args.paper_mode=='source-hidden';paper.is_shadow_catcher=False
            paper.data.materials.clear();paper.data.materials.append(holdout)
        ribbon.visible_camera=True
        scene.use_nodes=False;scene.view_layers[0].cycles.use_pass_shadow_catcher=False
        ribbon_path=args.out/(stem+'-ribbon.png') if papers and args.paper_mode=='shadow' else args.out/(stem+'.png')
        passes.append(render_pass(scene,ribbon_path))
        final_path=args.out/(stem+'.png')
        if papers and args.paper_mode=='shadow':
            for paper in papers:
                paper.hide_render=False;paper.is_shadow_catcher=True
                paper.data.materials.clear();paper.data.materials.append(catcher)
            ribbon.visible_camera=False
            scene.view_layers[0].cycles.use_pass_shadow_catcher=True;scene.use_nodes=True
            raw_shadow_path=args.out/(stem+'-shadow-raw.png');passes.append(render_pass(scene,raw_shadow_path))
            shadow_path=args.out/(stem+'-shadow.png')
            matte=shadow_matte(shadow_baseline_path,raw_shadow_path,receiver_path,shadow_path)
            passes.append({'path':shadow_path.name,'sha256':sha(shadow_path),**alpha_readback(shadow_path),**matte})
            shadow=Image.open(shadow_path).convert('RGBA');front=Image.open(ribbon_path).convert('RGBA')
            Image.alpha_composite(shadow,front).save(final_path)
            ribbon.visible_camera=True
        result={**row,'path':final_path.name,'sha256':sha(final_path),'cacheVertexSha256':array_sha(xyz),
                'evaluatedFloat32VertexSha256':array_sha(actual),'vertexMaxCastDifference':float(np.linalg.norm(actual-xyz,axis=1).max()),
                'uvSha256':uv_hash,
                'geometryBounds':[xyz.min(axis=0).tolist(),xyz.max(axis=0).tolist()],
                'passes':passes,**alpha_readback(final_path)}
        evidence['frames'].append(result)
        (args.out/'render-evidence.json').write_text(json.dumps(evidence,indent=2))
        print(json.dumps({'outputFrame':row['outputFrame'],'sourceFrame':row['sourceFrame'],'path':str(final_path),'sha256':result['sha256']}),flush=True)
    if args.append_transparent_terminal:
        terminal_index=mapping[-1]['outputFrame']+1
        terminal_path=args.out/f'frame-{terminal_index:03d}.png'
        Image.new('RGBA',(scene.render.resolution_x,scene.render.resolution_y),(0,0,0,0)).save(terminal_path)
        terminal={'outputFrame':terminal_index,'sourceFrame':None,'terminal':True,'path':terminal_path.name,
                  'sha256':sha(terminal_path),**alpha_readback(terminal_path)}
        evidence['frames'].append(terminal)
        evidence['transparentTerminalFrame']=terminal_index
        (args.out/'render-evidence.json').write_text(json.dumps(evidence,indent=2))
        print(json.dumps({'outputFrame':terminal_index,'sourceFrame':None,'path':str(terminal_path),
                          'sha256':terminal['sha256'],'terminal':True}),flush=True)
    print('EXACT_CACHE_RENDER_COMPLETE',flush=True)


if __name__=='__main__':main()
