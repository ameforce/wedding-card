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

신랑·신부 이름, 예식 일시, 예식장명, 주소, 교통·주차 안내와 지도 링크는 사용자 확인값을 사용합니다. 층·홀과 종료 시각 등 남은 미확정 콘텐츠 때문에 화면에는 `DESIGN REVIEW`가 표시되며, `npm run build`는 placeholder를 감지해 의도적으로 실패합니다. 디자인 검토용 정적 결과만 만들 때는 `npm run build:design`을 사용합니다.

## Verification

```powershell
npm run lint
npm run test:ui
npm run build:design
npm run test:sites
```

시각 검증 기록은 [design-qa.md](design-qa.md), 디자인 계약은 [docs/design/README.md](docs/design/README.md)에 있습니다.
