# 리본 작성과 재현

현재 공개 리본은 프로젝트에서 직접 작성한 하나의 연결된 메시다. 외부 3D 자산,
다운로드한 `.blend`, 애드온이나 런타임 3D에 의존하지 않는다.
`scripts/ribbon/approved_motion.py`가 형상과 동작의 원본이며,
`render_approved_sequence.py`가 같은 장면을 투명 PNG 시퀀스로 렌더한다.

## 제작 계약

| 항목 | 값 |
| --- | --- |
| Blender | 4.5.13 LTS |
| 프레임 | 0–74, 75장 |
| 속도 | 30fps |
| 캔버스 | 960×640 |
| 리본 | 하나의 연결된 메시, 하나의 아이보리 새틴 재질 |
| 토폴로지 | 360행, 단면 7열, 2,520 vertices |
| 카메라 | 고정 orthographic, scale 15 |
| 등록점 | `(0, 0, 0)` |
| 공개 형식 | 투명 무손실 WebP |

증명본에서는 리본의 접촉과 명암을 확인하기 위한 아이보리 종이를 사용한다.
공개 렌더에서는 그 종이를 제거하고 `film_transparent`를 켠다. 모든 프레임은
동일한 카메라, 재질, 캔버스, 배율과 등록점을 사용하며 프레임별 자르기나
정규화를 하지 않는다.

## 동작 순서

오른쪽 자유 꼬리가 먼저 당겨지고 오른쪽 고리와 왼쪽 고리가 차례로 줄어든다.
매듭은 깊이 방향으로 열리며 같은 리본 띠가 느슨한 한 줄로 풀린 뒤 화면 오른쪽
밖으로 완전히 나간다. 별도 밴드, 교차 페이드한 자세나 정지 리본을 겹치지 않는다.

주요 진행 구간은 다음과 같다.

- 오른쪽 고리 축소: 전체 진행률 0.06–0.38
- 왼쪽 고리 축소: 전체 진행률 0.22–0.55
- 매듭 해제: 전체 진행률 0.42–0.62
- 느슨한 띠 퇴장: 전체 진행률 0.69–0.98
- 마지막 프레임: 완전 투명

공개 매니페스트는 첫 자세를 600ms 유지하고 프레임 31부터 매듭 해제 구간으로
표시한다. 마지막 투명 프레임을 실제로 그린 뒤 300ms를 기다리고 종이 패널을
1,200ms 동안 연다.

## 실행

아래 두 명령은 Blender 실행 파일로 호출한다. 각 출력 위치는 새 디렉터리이거나
비어 있어야 하며 기존 증거를 덮어쓰지 않는다.

```powershell
blender --background --factory-startup `
  --python scripts/ribbon/approved_motion.py -- `
  --out <new-proof-directory>

blender --background --factory-startup `
  --python scripts/ribbon/render_approved_sequence.py -- `
  --out <new-render-directory>
```

동작 증명본을 정상 속도와 0.25배 속도로 확인한 뒤 투명 프레임을 패키징한다.

```powershell
python scripts/ribbon/package_sequence.py `
  --input <new-render-directory> `
  --out <new-sequence-directory> `
  --count 75 --release-frame 31
```

패키저는 완전 투명 픽셀의 보이지 않는 RGB만 0으로 정리한다. 나머지 알파와
가시 RGB는 PNG와 동일한 무손실 WebP로 보존한다. 각 파일 이름에는 내용
SHA-256의 앞 12자리를 넣고, 전체 공개 시퀀스는 4MiB 이하로 제한한다.
`.blend`, PNG, 증명 영상, 검토 화면과 증거 JSON은 `public` 밖에 둔다.

## 검증

`final-sequence-evidence.json`은 Blender 버전, 작성기 해시, 장면 계약,
75개 PNG의 해시와 크기, 고리 축소와 매듭 해제 완료, 마지막 띠의 카메라 이탈을
기록한다. `ribbon-sequence-encoding.json`은 WebP 왕복 동일성, 알파 경계,
프레임별 해시와 압축 크기를 기록한다. 이 기계 검사는 자연스러운 동작의 시각
승인을 대신하지 않는다.

통합 뒤에는 다음을 확인한다.

```powershell
npm run check:ribbon
node --test tests/pastel-intro.test.mjs tests/pastel-intro-browser.test.mjs
npm run build
npm run test:ui
npm run test:sites
```

브라우저 검증은 360, 390, 430, 768, 1440px에서 모든 75프레임을 순서대로
그리는지, 마지막 프레임이 투명한지, 종이 패널이 그 뒤에 열리는지 확인한다.
400ms 지연, 프레임 실패와 시간 초과에서는 표지를 제거하고 초대장 접근과
스크롤을 복구해야 한다. `capture=1`과 Quiet에는 표지를 장착하지 않는다.

`author_ribbon.py`, `studio_render.py`, `source-knot.json`은 이전 46프레임
경로의 보존 자료다. 현재 공개 리본을 재생성할 때는 사용하지 않는다.
