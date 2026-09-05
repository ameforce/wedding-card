"""Package an approved fixed-camera PNG sequence and its separate local review viewer.

The source .blend and PNGs remain outside public/. Geometry/visual admission is
separate: a successful package proves encoding and dimensions, not natural motion.
"""
import argparse
import hashlib
import html
import json
from pathlib import Path

from PIL import Image, ImageDraw


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--count', type=int, default=46)
    parser.add_argument('--release-frame', type=int, required=True)
    parser.add_argument('--label', default='리본 연속 동작 검토')
    args = parser.parse_args()
    source, output = Path(args.input).resolve(), Path(args.out).resolve()
    if not 2 <= args.count <= 300 or not 0 <= args.release_frame < args.count:
        parser.error('Invalid frame count or release frame.')
    if output.exists() and any(output.iterdir()):
        parser.error('Output must be new or empty; never overwrite a reviewed sequence.')
    output.mkdir(parents=True, exist_ok=True)
    width, height = Image.open(source / 'frame-000.png').size
    if width * height * 4 * 7 > 32 * 1024 * 1024:
        raise ValueError('Decoded surfaces exceed the 32 MiB budget.')
    evidence = []
    for index in range(args.count):
        with Image.open(source / f'frame-{index:03d}.png') as png:
            image = png.convert('RGBA')
        if image.size != (width, height):
            raise ValueError(f'Frame {index}: fixed canvas changed.')
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
        image.save(target, lossless=True, quality=100, method=4, exact=True)
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
            'bytes': target.stat().st_size, 'alphaBounds': alpha.getbbox(),
            'alphaExtrema': alpha.getextrema(),
            'alphaAndVisibleRgbIdenticalToPng': True,
            'rgbaIdenticalToCanonicalPixels': True,
            'invisibleRgbPixelsCleared': cleared,
        })
    total = sum(frame['bytes'] for frame in evidence)
    if not evidence[0]['alphaBounds'] or evidence[-1]['alphaBounds'] is not None:
        raise ValueError('First frame must be visible and terminal frame fully transparent.')
    if total > 4 * 1024 * 1024:
        raise ValueError(f'Compressed sequence exceeds 4 MiB: {total} bytes.')
    manifest = {
        'schemaVersion': 1, 'fps': 30, 'width': width, 'height': height,
        'frames': [frame['file'] for frame in evidence], 'holdMs': 600,
        'releaseFrame': args.release_frame, 'panelDelayMs': 300, 'panelDurationMs': 1200,
    }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    # Review artifacts sit beside, never inside, the publishable sequence directory.
    report = {'encodingPassed': True, 'visualAdmission': 'not-evaluated',
              'width': width, 'height': height, 'bytes': total, 'frames': evidence}
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
