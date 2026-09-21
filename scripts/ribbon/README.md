# 리본 제작

현재는 실제 천의 통과를 검증하는 재제작 단계다. `author_ribbon.py`와
`studio_render.py`, `approved_motion.py`와 `render_approved_sequence.py`는 기존
형태 보간 자산의 재현 경로이며, 실제 매듭 풀림을 검증한 새 제작 경로로
간주하지 않는다.
Blender와 Pillow는 별도의 제작 환경에서 사용하며 웹 앱에는 포함하지 않는다.

`cloth_construct_beam.py`와 `cloth_study.py`로 만든 v13 후보는 한 장의 평평한
리본 띠를 명시된 삼각형 연결로 접고, 끝단 제어와 천 계산을 연속 평가한
스키마 2 검토본이다. `cloth_passage.py`, `cloth_release.py`,
`cloth_verify.py`, `cloth_strain.py`, `cloth_clearance.py`는 각각 재료 통과,
해제 시점, 전 프레임 교차, 변형률과 종이 접촉을 검사한다. 이 후보의 자동
검사는 통과했지만 사용자 시각 승인은 아직 받지 않았으므로 운영 자산으로
교체하지 않는다.

`cloth_construct_developable.py`는 평평한 띠를 접어 만든 고리 통과 실험의
초기 형상을 제작한다. `cloth_construct_developable_bow.py`의 전체 리본은
개발 중이며, 연결·초기 접촉·실제 풀림·시각 검증을 각각 통과해야 한다.
실험용 좁은 띠의 성공만으로 넓은 새틴 리본을 승인하지 않는다.

기존 `BVHTree.overlap` 기반 검사는 공면 면적 겹침을 누락할 수 있다.
초기 형상과 채택할 동작은 보수적인 좌표 경계 상자 후보로 다시 검사한다.
정점을 공유하는 면도 되접힘을 확인하며, 단순 경계 접촉과 실제 겹침을 구분한다.
과거 검사 수 0이나 후보 생성 성공만으로 최종 리본을 승인하지 않는다.

`render_cloth_cache.py`는 실제 계산에서 저장한 NPZ 정점을 그대로 출력한다.
원본 장면의 첫 프레임을 평가한 뒤 카메라와 조명을 고정하고, 캐시의 첫
형상·삼각형·기준 형상이 원본과 다르면 거부한다. 출력 프레임은 원본 계산의
프레임 번호로 지정하며, 내부 정점 보간이나 프레임별 크기 조정은 하지 않는다.
종이 뒤 리본의 차폐와 실제 천이 만드는 그림자는 매 프레임 다시 계산한다.
그림자 수신 패스는 리본을 숨긴 기준 패스로 나누어 실제 감광 비율만 검은
알파로 바꾼다. 고정 회색 사각형이나 수신면 바깥 알파가 생기면 채택하지 않는다.

`extract_cloth_root.py`는 별도로 확인한 완전 해제 프레임 이후의 공통 수직
이동만 분리한다. 종이 앞면의 접촉 여유를 검사하고, 분리된 좌표와 이동량을
합쳐 원본 좌표가 복원되는지 확인한다. 이 도구의 기하 검사나 합성 시험은
매듭 풀림·시각 승인·실제 최종 해제 프레임의 증거를 대신하지 않는다.

초기 외형의 기준은 `reference-ribbon-registration.json`에 기록한
레퍼런스 첫 프레임의 수동 측정값이다. 경계의 측정 오차를 포함하며,
완벽한 실루엣 마스크나 매듭 통과의 증거는 아니다.

재현 명령, 원작 출처와 제작 한계는
[리본 작성과 재현](../../docs/design/ribbon/authoring.md)에 기록한다.
이전 미통과 연구 소스와 렌더는 외부 검증 산출물에 보존하며 제품 빌드에 넣지 않는다.

```powershell
python scripts/ribbon/package_sequence.py --input <validated-render-directory> --out <new-sequence-directory> --count <frame-count> --release-complete-frame <verified-release-frame> --root-track <author-root-track.json> --panel-curve scripts/ribbon/reference-paper-curve.json --registration-x <fixed-x> --registration-y <fixed-y>
```

정식 Windows x64 패키징 환경은 Python 3.14.7, Pillow 11.3.0과 그 휠에
포함된 libwebp 1.5.0이다. 새 가상 환경에서는 먼저
`py -3.14 -m pip install --only-binary=:all: Pillow==11.3.0`을 실행한다.
패키저는 세 버전을 모두 확인하고 다른 환경에서는 공개 파일을 쓰기 전에
중단한다.

모든 출력 디렉터리는 새 디렉터리이거나 비어 있어야 한다. 패키지는 모든 알파와
가시 RGB를 보존하며, 완전 투명 픽셀의 보이지 않는 RGB만 0으로 정리한다.
`.blend`, PNG, 증명 영상, 검토 화면과 증거 JSON은 `public` 밖에 둔다. 공개
디렉터리에는 해시가 이름에 결합된 WebP와 `manifest.json`만 둔다.

`author_ribbon.py`, `studio_render.py`, `source-knot.json`은 이전 46프레임 제작
경로를 재현하기 위한 보존 자료다. 현재 공개 시퀀스의 원본으로 사용하지 않는다.
자세한 계약과 검증 근거는 [리본 작성과 재현](../../docs/design/ribbon/authoring.md)에
기록한다.
