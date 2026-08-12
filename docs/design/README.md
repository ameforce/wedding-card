# Code-first design contract

## Source of truth

실제 Browser 렌더링과 저장소의 토큰·컴포넌트·콘텐츠 데이터가 source of truth다. Figma 또는 Penpot은 추후 비개발 이해관계자의 캔버스 코멘트나 외부 디자이너 핸드오프가 필요할 때만 선택적으로 사용한다.

## Selected visual targets

- Quiet Editorial: `references/quiet-editorial-letter.png`
- Pastel Letter: `references/pastel-letter-album.png`

두 이미지의 글자와 정보는 시각 제안이며 공개 사실이 아니다. 실제 인물 사진이나 닮은 사람을 생성하지 않는다.

## Shared implementation

- 한 개의 콘텐츠 객체: `src/content.js`
- 한 개의 기능·섹션 컴포넌트 트리: `src/App.jsx`
- 시안별 토큰과 배치: `[data-variant="quiet"]`, `[data-variant="pastel"]`
- URL 선택: `?variant=quiet`, `?variant=pastel`; 알 수 없는 값은 `quiet`
- 공통 기능: 디자인 전환, 길찾기·연락·일정·공유의 미확정 피드백, 이미지 오류 fallback
- 44px 이상 터치 영역, 키보드 포커스, `prefers-reduced-motion`

## Content gate

현재 확인되지 않은 값:

- 신랑·신부 이름과 표기
- 부모님 이름·호칭 표시 여부
- 날짜·시간·타임존
- 예식장·층·홀·주소
- 주차·대중교통과 공식 길찾기 링크
- 인사말 최종 원문
- 실제 사진과 각 사진의 crop·focal point
- 연락처, 계좌 안내, RSVP, 배경음악
- 공유 URL·도메인·OG 이미지·검색엔진 노출

이 값들은 `DESIGN ONLY` 상태로만 렌더링되며 `scripts/check-content.mjs`가 기본 production build를 차단한다.

## Asset policy

- `quiet-light-study.webp`: 실제 사진이 공급되기 전의 비인물 추상 자산
- `pastel-watercolor-wash.webp`: Pastel Letter의 비인물 수채 워시
- `abstract-map.webp`: 실제 지리정보가 없는 디자인용 추상 지도
- 원본 PNG는 로컬 `artifacts/source-assets/`에 보존하며 배포물에는 포함하지 않는다.
