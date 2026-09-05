# 리본 제작

정식 제작 경로는 `author_ribbon.py` → `studio_render.py` → `package_sequence.py`다.
Blender와 Pillow는 별도의 제작 환경에서 사용하며 웹 앱에는 포함하지 않는다.

재현 명령, 원작 출처와 제작 한계는
[리본 작성과 재현](../../docs/design/ribbon/authoring.md)에 기록한다.
이전 미통과 연구 소스와 렌더는 외부 검증 산출물에 보존하며 제품 빌드에 넣지 않는다.

```powershell
python scripts/ribbon/author_ribbon.py --out <new-source-directory>
python scripts/ribbon/studio_render.py --source <new-source-directory>/ribbon.blend --out <new-render-directory> --samples 16
python scripts/ribbon/package_sequence.py --input <new-render-directory> --out <new-sequence-directory> --release-frame 35
```

모든 출력 디렉터리는 새 디렉터리 또는 빈 디렉터리여야 한다.
패키지는 모든 알파와 가시 RGB를 보존하는 무손실 WebP다.
완전 투명 픽셀의 보이지 않는 RGB만 0으로 정리한다.
검토 화면과 증거 JSON은 공개 프레임 디렉터리의 바깥에 생성된다.
변환 성공과 시각 검증 통과는 별개이며, 승인된 프레임만 공개 자산으로 복사한다.
