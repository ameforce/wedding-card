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
- 공통 기능: 디자인 전환, 공식 길찾기, 주소 복사, `Asia/Seoul` 시작 시각 iCalendar 열기, Web Share와 링크 복사 fallback, 이미지 오류 fallback
- 연락하기는 확인된 연락처가 없어 안내 상태로 유지
- 실제 스튜디오 사진은 변형 없이 WebP 파생본과 variant별 focal point만 사용
- 세상이 스티커는 실제 사진의 턱시도 무늬를 기준으로 만든 투명 자산이며, 필요한 한 개만 갤러리의 자연스러운 여백 가장자리에 절대 배치한다. `prefers-reduced-motion`에서는 정지 상태를 유지한다.
- 44px 이상 터치 영역, 키보드 포커스, `prefers-reduced-motion`

## Content gate

현재 확인된 값:

- 신랑 김종인, 신부 유지혜
- 2026년 12월 27일 일요일 오후 3시 (`Asia/Seoul` 내부 시간대)
- 더 바실리움, 경기 성남시 분당구 양현로 322
- 네이버 지도·카카오맵·T map 길찾기 링크
- 수인분당선 야탑역 4번 출구 도보 400m, 같은 출구에서 10~15분 간격 셔틀 운행
- B2·B4 주차장, 2시간 무료, 8층 웨딩홀 로비 주차등록 기기

현재 확인되지 않은 값:

- 부모님 이름·호칭 표시 여부
- 예식장 층·홀
- 인사말 최종 원문
- 공개 최종 승인된 사진 범위와 OG 이미지
- 연락처, 계좌 안내, RSVP, 배경음악
- 공유 URL·도메인·OG 이미지·검색엔진 노출

이 값들은 `DESIGN ONLY` 상태로만 렌더링되며 `scripts/check-content.mjs`가 기본 production build를 차단한다.

## Asset policy

- `quiet-light-study.webp`: 실제 사진이 공급되기 전의 비인물 추상 자산
- `pastel-watercolor-wash.webp`: Pastel Letter의 비인물 수채 워시
- 실제 예식장 지도: `public/assets/map/venue-map.webp`와 `카카오맵` 출처 메타데이터를 함께 보존한다. 지도 자체에 포함된 제공자 표시는 유지하되 별도 `카카오맵 제공` 캡션은 렌더링하지 않는다. 이 자산을 읽지 못하면 지도를 렌더링하지 않고 길찾기 링크만 제공한다.
- `photos/*.webp`: 사용자가 지정한 수정본에서 만든 480/960px 반응형 파생본. 실제 인물은 AI 편집하지 않는다.
- `stickers/sesang-*.webp`: 사용자가 제공한 실제 세상이 사진을 identity reference로 사용한 투명 스티커 자산. 원본 고양이 사진은 저장소에 복사하지 않는다. 홍채는 황록색을 주색으로 유지하면서 청록 반사만 3 RGB level 안팎으로 제한 보정했으며, 털·동공·테두리·alpha는 바꾸지 않았다.
- 원본 PNG는 로컬 `artifacts/source-assets/`에 보존하며 배포물에는 포함하지 않는다.

## Photo selection

- Quiet Editorial: `KSJ_1291`, `KSJ_1475`, `KSJ_1400`, `KSJ_1629`
- Pastel Letter: hero `KSJ_1562`; gallery `KSJ_1068`, `KSJ_1843`, `KSJ_0378`, `KSJ_1102`
- 브라우저는 480/960px `srcset`에서 슬롯과 DPR에 맞는 자산을 선택한다.

## Letter B reference audit

공개 레퍼런스는 구조와 사용성만 확인했으며, 인물·사진·이름·문구·그래픽은 복제하거나 저장소 산출물에 포함하지 않는다.

채택한 요소:

- 첫 화면에서 실제 커플 사진을 먼저 보여주는 photo-first hierarchy
- 이름·날짜·장소를 중앙 정렬과 충분한 여백으로 읽히게 하는 흐름
- 사진을 눌러 확대할 수 있음을 명시한 큰 갤러리
- 실제 지도 뒤에 독립적인 네이버·카카오맵·T map 길찾기 버튼을 두는 구조
- 지하철·셔틀·주차·등록 위치를 아이콘과 짧은 문단으로 나눈 안내
- 하단에 연락·캘린더·공유 기능을 한 번씩만 모은 utility row

현재 제외한 요소:

- 카운트다운, 자동재생 음악, RSVP
- 미확정 RSVP 운영 계약과 공개 노출 설정(OG 메타데이터·검색 노출)

제외 요소는 실제 사용 여부와 개인정보 공개 범위가 확인된 뒤에만 추가한다.
