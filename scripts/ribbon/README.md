# 리본 제작

현재 공개 리본의 정식 제작 경로는 `approved_motion.py`로 동작 증명본을 확인한 뒤
`render_approved_sequence.py`로 투명 PNG 75장을 만들고, `package_sequence.py`로
무손실 WebP와 매니페스트를 생성하는 순서다. 두 Blender 스크립트는 4.5.13 LTS에
고정되어 있으며 같은 리본 메시, 재질, 카메라, 960×640 캔버스와 30fps 등록점을
사용한다.

```powershell
blender --background --factory-startup `
  --python scripts/ribbon/approved_motion.py -- `
  --out <new-proof-directory>

blender --background --factory-startup `
  --python scripts/ribbon/render_approved_sequence.py -- `
  --out <new-render-directory>

python scripts/ribbon/package_sequence.py `
  --input <new-render-directory> `
  --out <new-sequence-directory> `
  --count 75 --release-frame 31
```

모든 출력 디렉터리는 새 디렉터리이거나 비어 있어야 한다. 패키지는 모든 알파와
가시 RGB를 보존하며, 완전 투명 픽셀의 보이지 않는 RGB만 0으로 정리한다.
`.blend`, PNG, 증명 영상, 검토 화면과 증거 JSON은 `public` 밖에 둔다. 공개
디렉터리에는 해시가 이름에 결합된 WebP와 `manifest.json`만 둔다.

`author_ribbon.py`, `studio_render.py`, `source-knot.json`은 이전 46프레임 제작
경로를 재현하기 위한 보존 자료다. 현재 공개 시퀀스의 원본으로 사용하지 않는다.
자세한 계약과 검증 근거는 [리본 작성과 재현](../../docs/design/ribbon/authoring.md)에
기록한다.
