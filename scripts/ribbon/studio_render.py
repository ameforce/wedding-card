"""Light a baked ribbon scene without modifying its geometry or motion.

Run with the dedicated Blender bpy Python environment. Input scenes must be
task-produced, baked geometry; embedded scripts and drivers are not required.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path

import bpy
from mathutils import Vector

RIBBON = 'One locally sliding bow strip'
PAPER = 'Actual card back occlusion'


def area_light(name, location, power, size, target=(0, 0, 0)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy, data.shape, data.size = power, 'DISK', size
    light = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(light)
    light.location = location
    light.rotation_euler = (Vector(target) - light.location).to_track_quat('-Z', 'Y').to_euler()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--frames', default=','.join(map(str, range(46))))
    parser.add_argument('--samples', type=int, default=24)
    parser.add_argument('--camera-scale', type=float, default=9.5)
    args = parser.parse_args()
    source, output = Path(args.source).resolve(), Path(args.out).resolve()
    if output.exists() and any(output.iterdir()):
        parser.error('Output must be a new or empty directory.')
    frames = [int(frame) for frame in args.frames.split(',')]
    if not 1 < args.camera_scale < 30:
        parser.error('Camera scale must be finite and between 1 and 30.')
    if len(frames) != len(set(frames)) or any(frame < 0 or frame > 45 for frame in frames):
        parser.error('Frame indices must be unique and in 0..45.')
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    scene = bpy.context.scene
    ribbon, paper = bpy.data.objects.get(RIBBON), bpy.data.objects.get(PAPER)
    if not ribbon or ribbon.type != 'MESH' or not paper or not scene.camera:
        raise ValueError('Expected baked ribbon mesh, card occlusion and fixed camera.')
    if not ribbon.data.shape_keys or len(ribbon.data.shape_keys.key_blocks) < 2:
        raise ValueError('Ribbon must contain baked motion shape keys.')
    output.mkdir(parents=True, exist_ok=True)
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 5
    scene.render.resolution_x, scene.render.resolution_y = 960, 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'
    scene.render.film_transparent = True
    scene.render.fps = 30
    scene.camera.data.ortho_scale = args.camera_scale
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    scene.view_settings.exposure = 0
    world = bpy.data.worlds.new('Ribbon neutral studio')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (.8, .82, .85, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = .28
    scene.world = world
    for light in list(scene.objects):
        if light.type == 'LIGHT':
            bpy.data.objects.remove(light, do_unlink=True)
    area_light('Ribbon large softbox', (-4, -7, 7), 1700, 6)
    area_light('Ribbon fill softbox', (5, -4, 2), 550, 5)
    area_light('Ribbon low reflection', (-1, -3, -4), 170, 4)
    satin = bpy.data.materials.new('Ivory satin, fixed material')
    satin.use_nodes = True
    shader = satin.node_tree.nodes['Principled BSDF']
    shader.inputs['Base Color'].default_value = (.82, .79, .71, 1)
    shader.inputs['Roughness'].default_value = .25
    shader.inputs['Anisotropic'].default_value = .55
    shader.inputs['Sheen Weight'].default_value = .28
    shader.inputs['Sheen Roughness'].default_value = .35
    shader.inputs['Coat Weight'].default_value = .1
    shader.inputs['Coat Roughness'].default_value = .32
    shader.inputs['Alpha'].default_value = 1
    ribbon.data.materials.clear()
    ribbon.data.materials.append(satin)
    for face in ribbon.data.polygons:
        face.material_index = 0
        face.use_smooth = True
    # Preserve the source's paper holdout. A sampled shadow catcher produces
    # noisy alpha across empty paper even after the ribbon exits. Instead bake
    # one restrained soft shadow from this same render's alpha, with no extra
    # ribbon geometry or browser filter. This is an authored contact shadow.
    paper.is_shadow_catcher = False
    scene.use_nodes = True
    nodes, links = scene.node_tree.nodes, scene.node_tree.links
    nodes.clear()
    layers = nodes.new('CompositorNodeRLayers')
    opacity = nodes.new('CompositorNodeMath')
    opacity.operation = 'MULTIPLY'
    opacity.inputs[1].default_value = .2
    links.new(layers.outputs['Alpha'], opacity.inputs[0])
    shade = nodes.new('CompositorNodeSetAlpha')
    shade.inputs['Image'].default_value = (.13, .10, .075, 1)
    links.new(opacity.outputs[0], shade.inputs['Alpha'])
    blur = nodes.new('CompositorNodeBlur')
    blur.filter_type = 'GAUSS'
    blur.size_x, blur.size_y = 9, 9
    links.new(shade.outputs['Image'], blur.inputs['Image'])
    offset = nodes.new('CompositorNodeTransform')
    offset.inputs['X'].default_value = 4
    offset.inputs['Y'].default_value = -7
    links.new(blur.outputs['Image'], offset.inputs['Image'])
    # Keep the original render's canvas domain: a translated shadow used as
    # the base would also translate/crop the whole composite at the frame edge.
    shadow_over = nodes.new('CompositorNodeAlphaOver')
    shadow_over.inputs[0].default_value = 1
    links.new(layers.outputs['Image'], shadow_over.inputs[1])
    links.new(offset.outputs['Image'], shadow_over.inputs[2])
    over = nodes.new('CompositorNodeAlphaOver')
    over.inputs[0].default_value = 1
    links.new(shadow_over.outputs['Image'], over.inputs[1])
    links.new(layers.outputs['Image'], over.inputs[2])
    composite = nodes.new('CompositorNodeComposite')
    links.new(over.outputs['Image'], composite.inputs['Image'])
    scene.frame_set(0)
    camera_matrix = [value for row in scene.camera.matrix_world for value in row]
    camera_scale = scene.camera.data.ortho_scale
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'ribbon-studio.blend'))
    evidence = []
    for frame in frames:
        started = time.monotonic()
        scene.frame_set(frame)
        if ([value for row in scene.camera.matrix_world for value in row] != camera_matrix
                or scene.camera.data.ortho_scale != camera_scale):
            raise ValueError('The camera or registration changed during the sequence.')
        target = output / f'frame-{frame:03d}.png'
        scene.render.filepath = str(target)
        bpy.ops.render.render(write_still=True)
        row = {'frame': frame, 'seconds': round(time.monotonic() - started, 3),
               'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
        evidence.append(row)
        print(json.dumps(row), flush=True)
    report = {'sourceSha256': source_hash, 'bpyVersion': bpy.app.version_string,
              'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'camera': {'matrix': camera_matrix, 'orthoScale': camera_scale},
              'width': 960, 'height': 640, 'fps': 30, 'samples': args.samples,
              'embeddedScriptsEnabled': False, 'frames': evidence}
    (output / 'render-evidence.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('STUDIO_RENDER_COMPLETE', flush=True)


if __name__ == '__main__':
    main()
