# wedding-card

Pastel Letter를 최종 디자인으로 사용하는 모바일 청첩장 code-first 프로젝트입니다. Figma는 필수 단계나 source of truth가 아닙니다.

## Local design review

```powershell
npm install
npm run dev
```

- `/`: Pastel Letter 최종 디자인
- `/?variant=pastel`: Pastel Letter와 동일한 호환 경로
- `/?variant=quiet`: 내부 회귀 확인용 Quiet Editorial 경로

공개 화면에는 디자인 선택 UI를 노출하지 않습니다.

신랑·신부 이름, 예식 일시, 예식장명과 8층 안내, 주소, 교통·주차 안내, 지도 링크, 초대·스토리 문구와 대표 URL `https://wdcard.enmsoftware.com/`은 사용자 확인값을 사용합니다. 다음 미확정 콘텐츠는 `weddingContent.unconfirmedContent`에 구조화되어 있으며, 화면에는 `DESIGN REVIEW`가 표시되고 `npm run build`는 항목별 목록을 출력한 뒤 의도적으로 실패합니다. 디자인 검토용 정적 결과만 만들 때는 `npm run build:design`을 사용합니다.

- RSVP 운영 계약: 수집 항목, 마감일, 수신자, 보존 정책
- 공개 노출 설정: OG 메타데이터, 검색 노출

방명록의 D1 저장소와 관리자 인증 바인딩은 배포 전 런타임 준비 사항이며, 위 청첩장 콘텐츠 미확정 목록과는 별도로 관리합니다.

## Verification

```powershell
npm run lint
npm run test:ui
npm run build:design
npm run test:sites
```

시각 검증 기록은 [design-qa.md](design-qa.md), 디자인 계약은 [docs/design/README.md](docs/design/README.md)에 있습니다.
Cloudflare 배포 구조 검토는 [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md)에 있습니다.
