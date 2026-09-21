"""Package an approved fixed-camera PNG sequence and its separate local review viewer.

The source .blend and PNGs remain outside public/. Geometry/visual admission is
separate: a successful package proves encoding and dimensions, not natural motion.
"""
import argparse
import hashlib
import html
import io
import json
from pathlib import Path
import sys

import PIL
from PIL import Image, ImageDraw, features

APPROVED_PYTHON = (3, 14, 7)
APPROVED_PILLOW = '11.3.0'
APPROVED_LIBWEBP = '1.5.0'


def validate_packaging_environment():
    actual_python = sys.version_info[:3]
    actual_webp = features.version('webp')
    if actual_python != APPROVED_PYTHON:
        raise RuntimeError(
            f'Packaging requires Python {".".join(map(str, APPROVED_PYTHON))}; '
            f'found {".".join(map(str, actual_python))}.')
    if PIL.__version__ != APPROVED_PILLOW or actual_webp != APPROVED_LIBWEBP:
        raise RuntimeError(
            f'Packaging requires Pillow {APPROVED_PILLOW} with libwebp '
            f'{APPROVED_LIBWEBP}; found Pillow {PIL.__version__} with '
            f'libwebp {actual_webp or "unavailable"}.')


def load_render_inputs(source, count, root_bytes, manifest_path=None):
    """Freeze checked PNG bytes so conversion never reopens mutable inputs."""
    binding = None
    if manifest_path:
        manifest_bytes = Path(manifest_path).read_bytes()
        record = json.loads(manifest_bytes)
        if record.get('frameCount') != count or len(record.get('frames', [])) != count:
            raise ValueError('Render manifest frame count differs.')
        if record.get('rootTrackSha256') != hashlib.sha256(root_bytes).hexdigest():
            raise ValueError('Rendered root track hash differs.')
        lineage = record.get('certifiedSurface')
        if not isinstance(lineage, dict) or not lineage.get('parts') or not lineage.get('surfaceVerificationSha256'):
            raise ValueError('Render manifest is missing certified surface lineage.')
        binding = {'sha256': hashlib.sha256(manifest_bytes).hexdigest(),
                   'sceneSha256': record['sceneSha256'], 'certifiedSurface': lineage,
                   'rendererSha256': record['rendererSha256'],
                   'width': record['width'], 'height': record['height'], 'fps': record['fps'],
                   'registration': record['registration'], 'releaseCompleteFrame': record['releaseCompleteFrame']}
    frames = []
    for index in range(count):
        blob = (Path(source) / f'frame-{index:03d}.png').read_bytes()
        if manifest_path:
            frame = record['frames'][index]
            if frame.get('frame') != index or frame.get('sha256') != hashlib.sha256(blob).hexdigest():
                raise ValueError(f'Frame {index}: rendered PNG hash or order differs.')
        frames.append(blob)
    return frames, binding


def main():
    validate_packaging_environment()
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--count', type=int, default=46)
    parser.add_argument('--release-complete-frame', type=int, required=True)
    parser.add_argument('--root-track', required=True, help='Author-extracted JSON object with rootYPx pixels.')
    parser.add_argument('--panel-curve', required=True, help='Measured-reference JSON array of {offset,progress}.')
    parser.add_argument('--registration-x', type=float, required=True)
    parser.add_argument('--registration-y', type=float, required=True)
    parser.add_argument('--uniform-scale', type=float, choices=[0.5, 1.0], default=1.0,
                        help='Uniformly retain the authored canvas or downscale every frame by exactly one half.')
    parser.add_argument('--label', default='리본 연속 동작 검토')
    parser.add_argument('--frame-pack', action='store_true', help='Fetch the same bounded WebP bytes as one hash-bound file.')
    parser.add_argument('--render-manifest', help='Bind independently certified rendering to every encoded PNG.')
    args = parser.parse_args()
    source, output = Path(args.input).resolve(), Path(args.out).resolve()
    if not 2 <= args.count <= 300 or not 0 <= args.release_complete_frame < args.count - 1:
        parser.error('Invalid frame count or release-complete frame.')
    if output.exists() and any(output.iterdir()):
        parser.error('Output must be new or empty; never overwrite a reviewed sequence.')
    output.mkdir(parents=True, exist_ok=True)
    root_track_path = Path(args.root_track).resolve()
    root_bytes = root_track_path.read_bytes()
    source_frames, render_binding = load_render_inputs(source, args.count, root_bytes, args.render_manifest)
    source_width, source_height = Image.open(io.BytesIO(source_frames[0])).size
    width, height = int(source_width * args.uniform_scale), int(source_height * args.uniform_scale)
    if render_binding and (render_binding['width'] != source_width or render_binding['height'] != source_height
            or render_binding['fps'] != 30 or render_binding['releaseCompleteFrame'] != args.release_complete_frame
            or render_binding['registration'] != {'x': args.registration_x / args.uniform_scale, 'y': args.registration_y / args.uniform_scale}):
        raise ValueError('Packaging settings differ from the certified render.')
    if not 480 <= width <= 960 or not ((width % 3 == 0 and height * 3 == width * 2) or (width, height) == (480, 1920)):
        raise ValueError('v2 requires a bounded 3:2 canvas or the fixed 480x1920 release canvas.')
    panel_curve_path = Path(args.panel_curve).resolve()
    root_track = json.loads(root_bytes)
    root_y = root_track.get('rootYPx') if isinstance(root_track, dict) else None
    if not isinstance(root_y, list) or len(root_y) != args.count:
        raise ValueError('Author root track must contain rootYPx for every frame.')
    if any(not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0 for value in root_y):
        raise ValueError('Author root track contains an invalid vertical value.')
    if any(value != 0 for value in root_y[:args.release_complete_frame + 1]):
        raise ValueError('Root motion begins before complete knot and paper release.')
    if any(next_value < value or next_value - value > height for value, next_value in zip(root_y, root_y[1:])):
        raise ValueError('Author root track is not continuous and downward-only.')
    panel_curve_bytes = panel_curve_path.read_bytes()
    panel_curve_evidence = json.loads(panel_curve_bytes)
    if isinstance(panel_curve_evidence, dict):
        if panel_curve_evidence.get('kind') != 'reference-paper-measurement' or panel_curve_evidence.get('panelDurationMs') != 1400:
            raise ValueError('Panel curve evidence must be the measured 1400 ms paper reference.')
        source_sha = panel_curve_evidence.get('sourceSha256')
        if not isinstance(source_sha, str) or len(source_sha) != 64:
            raise ValueError('Panel curve evidence is missing its source hash.')
        panel_curve = panel_curve_evidence.get('panelCurve')
    else:
        # A raw curve is accepted for isolated packaging fixtures. Production
        # packaging uses the evidence object above and retains its source hash.
        panel_curve = panel_curve_evidence
    if not isinstance(panel_curve, list) or len(panel_curve) < 2:
        raise ValueError('Measured panel curve must include at least two points.')
    previous_offset = previous_progress = previous_left = previous_right = -1
    for point in panel_curve:
        if not isinstance(point, dict) or set(point) != {'offset', 'progress', 'leftProgress', 'rightProgress'}:
            raise ValueError('Measured panel curve points must be exactly {offset,progress,leftProgress,rightProgress}.')
        offset, progress, left, right = point['offset'], point['progress'], point['leftProgress'], point['rightProgress']
        if (not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in (offset, progress, left, right))
                or not all(0 <= value <= 1 for value in (offset, progress, left, right))
                or offset <= previous_offset or progress < previous_progress or left < previous_left or right < previous_right):
            raise ValueError('Measured panel curve is not normalized and monotonic.')
        previous_offset, previous_progress, previous_left, previous_right = offset, progress, left, right
    if (panel_curve[0] != {'offset': 0, 'progress': 0, 'leftProgress': 0, 'rightProgress': 0}
            or panel_curve[-1] != {'offset': 1, 'progress': 1, 'leftProgress': 1, 'rightProgress': 1}):
        raise ValueError('Measured panel curve must start at 0/0 and end at 1/1.')
    if not 0 <= args.registration_x <= width or not 0 <= args.registration_y <= height:
        raise ValueError('Registration must remain inside the fixed canvas.')
    if width * height * 4 * 7 > 32 * 1024 * 1024:
        raise ValueError('Decoded surfaces exceed the 32 MiB budget.')
    evidence = []
    for index in range(args.count):
        with Image.open(io.BytesIO(source_frames[index])) as png:
            image = png.convert('RGBA')
        if image.size != (source_width, source_height):
            raise ValueError(f'Frame {index}: fixed source canvas changed.')
        if args.uniform_scale != 1:
            image = image.resize((width, height), Image.Resampling.LANCZOS)
        original = image.tobytes()
        # Blender retains RGB values behind completely transparent pixels.
        # Clear only those invisible bytes; preserve every alpha value and
        # every RGB value that can contribute to compositing.
        pixels = bytearray(original)
        cleared = 0
        for offset in range(0, len(pixels), 4):
            if pixels[offset + 3] == 0:
                if any(pixels[offset:offset + 3]):
                    cleared += 1
                pixels[offset:offset + 3] = b'\x00\x00\x00'
        image = Image.frombytes('RGBA', image.size, bytes(pixels))
        target = output / f'frame-{index:03d}.webp'
        image.save(target, lossless=True, quality=100, method=6, exact=True)
        with Image.open(target) as webp:
            decoded = webp.convert('RGBA')
        if image.tobytes() != decoded.tobytes():
            raise ValueError(f'Frame {index}: lossless RGBA round-trip failed.')
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        # Cached manifests can fail open after a deploy, but must never combine
        # an old pose with a new pose served under the same frame filename.
        target = target.rename(output / f'frame-{index:03d}-{digest[:12]}.webp')
        alpha = decoded.getchannel('A')
        evidence.append({
            'file': target.name, 'sha256': digest,
            'sourcePngSha256': hashlib.sha256(source_frames[index]).hexdigest(),
            'bytes': target.stat().st_size, 'alphaBounds': alpha.getbbox(),
            'alphaExtrema': alpha.getextrema(),
            'alphaAndVisibleRgbIdenticalToPng': True,
            'rgbaIdenticalToCanonicalPixels': True,
            'invisibleRgbPixelsCleared': cleared,
            'uniformScale': args.uniform_scale,
        })
    total = sum(frame['bytes'] for frame in evidence)
    if not evidence[0]['alphaBounds'] or evidence[-1]['alphaBounds'] is not None:
        raise ValueError('First frame must be visible and terminal frame fully transparent.')
    final_visible = evidence[-2]['alphaBounds']
    if not final_visible:
        raise ValueError('The visible release must leave before, not at, the transparent terminal frame.')
    def root_translation(index, viewport_width, viewport_height):
        if index <= args.release_complete_frame:
            return 0
        scale = min(viewport_width, 430) / width
        last_visible = args.count - 2
        progress = min(1, (index - args.release_complete_frame) / max(1, last_visible - args.release_complete_frame))
        authored = root_y[index] * scale
        required = viewport_height / 2 + args.registration_y * scale + 16
        return authored + max(0, required * progress - authored)
    for viewport_width, viewport_height in ((360, 800), (390, 844), (430, 932), (768, 1024), (1440, 900)):
        scale = min(viewport_width, 430) / width
        canvas_top = viewport_height / 2 - args.registration_y * scale
        visible_top = canvas_top + final_visible[1] * scale + root_translation(args.count - 2, viewport_width, viewport_height)
        if visible_top < viewport_height + 16:
            raise ValueError(f'Released ribbon has not exited {viewport_width}x{viewport_height} before terminal transparency.')
    if total > 4 * 1024 * 1024:
        raise ValueError(f'Compressed sequence exceeds 4 MiB: {total} bytes.')
    manifest = {
        'schemaVersion': 2, 'fps': 30, 'width': width, 'height': height,
        'frames': [frame['file'] for frame in evidence], 'holdMs': 800,
        'panelDelayMs': 600, 'panelDurationMs': 1400,
        'releaseCompleteFrame': args.release_complete_frame,
        'registration': {'x': args.registration_x, 'y': args.registration_y},
        'rootYPx': root_y,
        'poster': {'frameIndex': 0, 'sha256': evidence[0]['sha256']},
        'panelCurve': panel_curve,
    }
    if args.frame_pack:
        packed = b''.join((output / frame['file']).read_bytes() for frame in evidence)
        packed_sha = hashlib.sha256(packed).hexdigest()
        packed_name = f'sequence-{packed_sha[:12]}.bin'
        (output / packed_name).write_bytes(packed)
        manifest['framePack'] = {'file': packed_name, 'sha256': packed_sha,
                                 'lengths': [frame['bytes'] for frame in evidence]}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    # Review artifacts sit beside, never inside, the publishable sequence directory.
    report = {'encodingPassed': True, 'visualAdmission': 'not-evaluated',
              'sourceCanvas': [source_width, source_height], 'uniformScale': args.uniform_scale,
              'width': width, 'height': height, 'bytes': total, 'frames': evidence,
              'rootTrack': {'path': str(root_track_path), 'sha256': hashlib.sha256(root_bytes).hexdigest()},
              'renderManifest': render_binding,
              'publicManifestSha256': hashlib.sha256((output / 'manifest.json').read_bytes()).hexdigest(),
              'panelCurve': {'path': str(panel_curve_path), 'sha256': hashlib.sha256(panel_curve_bytes).hexdigest()},
              'exitBeforeTransparentTerminal': True}
    (output.parent / f'{output.name}-encoding.json').write_text(
        json.dumps(report, indent=2), encoding='utf-8')
    selected = sorted(set(round(i * (args.count - 1) / 11) for i in range(12)))
    tile_height = round(320 * height / width)
    sheet = Image.new('RGB', (1280, (tile_height + 35) * 3), '#f4efea')
    draw = ImageDraw.Draw(sheet)
    for slot, index in enumerate(selected):
        with Image.open(output / manifest['frames'][index]) as image:
            thumb = image.convert('RGBA')
            thumb.thumbnail((320, tile_height))
        x, y = slot % 4 * 320, slot // 4 * (tile_height + 35)
        sheet.paste(thumb, (x, y), thumb)
        draw.text((x + 8, y + tile_height + 8), f'{index:02d} / {index / 30:.2f}s', fill='#494038')
    sheet.save(output.parent / f'{output.name}-contact-sheet.jpg', quality=95)
    viewer = VIEWER.replace('__TITLE__', html.escape(args.label)).replace(
        '__MANIFEST__', json.dumps(f'./{output.name}/manifest.json', ensure_ascii=True))
    (output.parent / f'{output.name}-review.html').write_text(viewer, encoding='utf-8')
    print(json.dumps({'encodingPassed': True, 'visualAdmission': 'not-evaluated',
                      'frameCount': args.count, 'bytes': total, 'output': str(output)}))


VIEWER = '''<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>__TITLE__</title>
<style>*{box-sizing:border-box}body{margin:0;background:#eee7df;color:#3e3730;font:16px system-ui}
header,footer{padding:16px;max-width:1100px;margin:auto}h1{font-size:22px;margin:0 0 12px}
button,select,input{font:inherit;margin:4px;min-height:44px}button{padding:8px 16px}
#stage{margin:auto;background:#f4efea;width:100%;max-width:1440px;overflow:hidden}
img{display:block;width:100%;height:auto}#seek{width:min(500px,90vw)}footer{line-height:1.6}</style>
<header><h1>__TITLE__</h1><button id="play" disabled>재생</button><button id="reset" disabled>처음부터</button>
<label>속도 <select id="speed"><option value="1">정상 · 30fps</option><option value=".25">느리게 · 0.25배</option></select></label>
<label>미리보기 폭 <select id="width"><option value="100%">화면에 맞춤</option><option>360px</option><option selected>390px</option><option>430px</option><option>768px</option><option>1440px</option></select></label>
<p><input id="seek" type="range" min="0" value="0" step="1" aria-label="프레임" disabled><output id="time">준비 중</output></p></header>
<main id="stage" style="width:390px"><img id="ribbon" alt="리본 매듭 풀림 동작 샘플"></main>
<footer>같은 카메라와 캔버스의 투명 이미지 연속 재생입니다. 이 페이지는 검토용이며, 파일 변환 성공이 자연스러운 풀림 동작의 검증을 의미하지는 않습니다.</footer>
<script type="module">
const img=document.querySelector('#ribbon'),seek=document.querySelector('#seek'),time=document.querySelector('#time');
const play=document.querySelector('#play'),reset=document.querySelector('#reset'),speed=document.querySelector('#speed');
let playing=false,anchor=0,base=0,frame=0,images=[],manifest;
function show(n){frame=Math.min(images.length-1,Math.max(0,n));img.src=images[frame].src;seek.value=frame;time.textContent=`${frame} / ${images.length-1} · ${(frame/30).toFixed(2)}초`}
function animate(t){if(playing){show(Math.floor(base+(t-anchor)/1000*30*Number(speed.value)));if(frame===images.length-1){playing=false;play.textContent='재생'}}requestAnimationFrame(animate)}
play.onclick=()=>{playing=!playing;if(playing){if(frame===images.length-1)show(0);base=frame;anchor=performance.now()}play.textContent=playing?'일시 정지':'재생'};
reset.onclick=()=>{show(0);base=0;anchor=performance.now()};
seek.oninput=()=>{playing=false;play.textContent='재생';show(Number(seek.value))};
speed.onchange=()=>{base=frame;anchor=performance.now()};
document.querySelector('#width').onchange=e=>document.querySelector('#stage').style.width=e.target.value;
try{const url=new URL(__MANIFEST__,location.href);const response=await fetch(url);if(!response.ok)throw Error(response.status);
manifest=await response.json();images=manifest.frames.map(name=>{const image=new Image();image.src=new URL(name,url);return image});
await Promise.all(images.map(image=>image.decode()));seek.max=images.length-1;play.disabled=reset.disabled=seek.disabled=false;show(0);requestAnimationFrame(animate)}
catch(error){time.textContent='프레임 로드 실패: '+error.message}
</script></html>'''


if __name__ == '__main__':
    main()
