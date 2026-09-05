# 리본 원본과 사용 범위

현재 제작 경로는 추가 비용 없이 Blender에서 동작을 직접 만드는 방식이다. 외부 원본이 제공하는 묶인 형태와 직접 제작하는 풀림 애니메이션을 구분한다.

## 매듭 곡선

- 원작: billhails, [Three Knots](https://blendswap.com/blend/26843), CC0. Square Knot, Granny Knot, Shoelace Knot의 Bezier 곡선이다.
- 공개 재배포: [Taremin/TareminShoelaces](https://github.com/Taremin/TareminShoelaces), 커밋 `14e1ca51c175fe5e2b14d7fa232da9a4fc2d7e11`의 `knots.blend`. README가 위 원작과 원작자를 명시한다.
- 원본 SHA-256: `0cbb699c5279ceb6c2229fc2b2fbaf9e27b0b4e3e567dae361ca243f43f37f31`.
- 저장소 소프트웨어 라이선스는 MIT이며, 곡선 원작의 표기는 CC0이다. 외부 애드온을 설치하거나 실행하지 않고 저장된 곡선 데이터를 읽는다.

이 원본은 완성된 풀림 애니메이션을 제공하지 않는다. 고리와 자유 끝의 재료 이동, 띠 표면, 폭 방향, 리본 퇴장과 렌더 설정은 이 작업에서 별도로 제작하고 검증한다.

## 연구용 예제

[Lalani의 BlenderArtists 예제](https://blenderartists.org/t/would-anyone-know-how-to-animate-ribbon-unbinding-a-gift-box/555859)는 Curve modifier, 저장된 곡선 키, 메시 이동을 조합해 띠가 매듭 경로를 따라 흐르게 하는 방법을 확인하는 데 사용했다. 사용 허가를 확인하지 못한 형상과 내장 스크립트는 제품에 포함하지 않는다. 파일을 열 때 내장 스크립트 자동 실행을 끈다.

사용자가 제공한 영상은 형태와 동작 순서를 비교하는 레퍼런스다. 공개 프레임으로 복사하지 않는다.
