# 리본 작성과 재현

`scripts/ribbon/author_ribbon.py`가 현재 리본의 정식 작성기다. 같은 디렉터리의 `source-knot.json`과 bpy 4.5.13만 필요하다. 실험용 `study_*` 모듈, 외부 절대경로, 다운로드한 `.blend`, 애드온에 의존하지 않는다. 이전 실험 파일은 비교 증거로 보존한다.

## 원본 데이터

`source-knot.json`에는 billhails의 [Three Knots](https://www.blendswap.com/blend/26843)에 포함된 `ShoeLace`의 두 열린 Bézier spline만 들어 있다. 각 spline은 제어점 9개와 좌우 핸들을 가진다. 원래 오브젝트의 배치 좌표는 제외하고 로컬 XYZ 좌표를 보존했다.

곡선 형상의 원작 라이선스는 CC0이다. [TareminShoelaces의 공개 재배포](https://github.com/Taremin/TareminShoelaces)는 원작자와 원작 링크를 명시하며 저장소 소프트웨어의 라이선스는 MIT다. 사용한 커밋은 `14e1ca51c175fe5e2b14d7fa232da9a4fc2d7e11`, 원본 `knots.blend` SHA-256은 `0cbb699c5279ceb6c2229fc2b2fbaf9e27b0b4e3e567dae361ca243f43f37f31`이다. 데이터 파일에 원작·재배포·라이선스 URL과 추출 범위를 함께 기록한다. 내장 Python과 외부 저장소 코드는 포함하지 않는다.

## 실행

아래 `python`은 bpy 4.5.13이 설치된 제작 환경의 Python이다. 작성기는 버전을 확인하며, 새 디렉터리 또는 빈 디렉터리만 출력 위치로 허용한다. 기존 파일이 있는 디렉터리를 지정하면 쓰기 전에 종료 코드 2로 거부한다.

```powershell
python scripts/ribbon/author_ribbon.py --out <new-source-directory>
```

승인된 제작 원본과 비교하면서 작성할 수도 있다. 비교할 파일은 명령에서 명시하며, 작성기에 특정 작업 폴더를 하드코딩하지 않는다.

```powershell
python scripts/ribbon/author_ribbon.py `
  --out <new-source-directory> `
  --compare-reference <approved-baked-blend>
```

이 명령은 이미지 렌더 없이 0–45의 46프레임을 저장한다. 출력은 `ribbon.blend`, `authoring-evidence.json`, 작성기와 제어점 데이터 사본이며, 비교 옵션을 사용하면 `reference-comparison.json`도 생성한다. `.blend`는 Basis와 46개 absolute shape key를 포함하므로 내장 스크립트 없이 재생할 수 있다.

형상은 연결된 리본 mesh 하나, 13,509 vertices, 고정된 재료 색상 구간으로 구성된다. 폭 0.85의 단면을 접거나 회전해 매듭·고리·꼬리를 표현한다. 각 팔의 재료 길이는 고리 축소에 따라 자유 꼬리로 이동하며, 중앙 감김은 자유 끝이 접근할 때까지 유지된다. 해제 이후에는 같은 길이 좌표로 처진 중심선을 다시 샘플링하고 단면을 회전해 깊이 방향 비틀림과 낙하 시차를 표현한다.

이 동작은 재료 경로를 직접 작성한 것이며 접촉 제약을 푼 천 물리 시뮬레이션은 아니다. 목표 중심선 길이와 실제 샘플 중심선 길이, 단면 길이는 별도로 기록한다.

## 카메라와 종이 배치

작성 장면의 등록 기준은 고정된 revision-2 원본과 같다.

| 항목 | 값 |
| --- | --- |
| 프레임 | 0–45, 30fps |
| 캔버스 | 960×640, 100% |
| 리본 | `One locally sliding bow strip` |
| 카메라 | `Fixed diagnostic camera`, 위치 `(0, -25, -0.65)`, 회전 `(π/2, 0, 0)` |
| 작성 카메라 배율 | orthographic scale 15 |
| 종이 | `Actual card back occlusion`, y=1.3, x 범위 ±7.2, z 범위 ±10 |

종이 면은 실제 종이 뒤의 연결부를 가리는 holdout이다. 앞 매듭의 교차를 감추기 위한 별도 마스크는 없다.

최종 렌더에서는 `studio_render.py`가 모든 프레임에 동일한 카메라 배율 9.5, 아이보리 새틴, 조명과 그림자를 적용한다. 이 배율 변경을 이유로 작성 geometry를 다시 확대하지 않는다. `studio_render.py`와 `package_sequence.py`는 독립된 제작 단계다.

```powershell
python scripts/ribbon/studio_render.py `
  --source <new-source-directory>/ribbon.blend `
  --out <new-studio-directory> --camera-scale 9.5
```

프레임 변환, 압축 예산과 최종 재생 검증은 별도 단계에서 수행한다. 작성기 실행 성공이 시각 승인이나 공개 승격을 의미하지 않는다.

## 재현 검증

고정된 revision-2 `.blend`의 SHA-256은 `e7ea7ce16272f8a2b06be518ad72ca75bacc36845aa9fbc2d7ba898b0f6649b8`이다. 작성기는 이 파일을 내장 스크립트 실행 없이 열어 0/12/20/27/31/35/38/45 프레임의 평가된 vertex와 polygon 연결 순서를 비교했다. 여덟 프레임 모두 topology가 같고 최대 vertex 오차는 0이었다. 허용 오차는 0.0001 scene units다.

카메라 행렬·배율, 종이 좌표·행렬·면, 프레임 범위·속도·캔버스도 완전히 일치했다. 생성한 Blender 파일의 주요 8프레임도 다시 열어 비교했다. 저장소 밖으로 복사한 작성기와 데이터 두 파일만으로 재작성하는 검증과 기존 출력 거부 검증을 수행했다. 기존 출력 거부 시 원래 `.blend` 해시가 유지됐다. 이 검증에서는 이미지를 다시 렌더하지 않았다.

재현 판정은 vertex 좌표·topology·장면 등록값으로 한다. 파일 해시는 각 개별 산출물을 식별하는 데 사용하며 `authoring-evidence.json`에 작성기·제어점 데이터·Blender 파일 해시와 bpy 버전을 기록한다. 정상·저속 재생에서 보이는 관통, 순간 소멸, 이중 윤곽, 자유 끝의 경로와 완전 퇴장은 최종 studio 및 독립 시각 검증 범위다.
