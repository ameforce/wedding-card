# wedding-card

모바일 청첩장의 두 디자인 방향을 하나의 콘텐츠·기능 구조에서 검토하는 code-first 프로젝트입니다. Figma는 필수 단계나 source of truth가 아닙니다.

## Local design review

```powershell
npm install
npm run dev
```

- `/?variant=quiet`: Quiet Editorial
- `/?variant=pastel`: Pastel Letter

신랑·신부 이름, 예식 일시, 예식장명과 지도 링크는 사용자 확인값을 사용합니다. 주소·층/홀·타임존·종료 시각·교통 안내 등은 아직 미확정이므로 화면에는 `DESIGN REVIEW`가 표시되며, `npm run build`는 남은 placeholder 때문에 의도적으로 실패합니다. 디자인 검토용 정적 결과만 만들 때는 `npm run build:design`을 사용합니다.

## Verification

```powershell
npm run lint
npm run test:ui
npm run build:design
npm run test:sites
```

시각 검증 기록은 [design-qa.md](design-qa.md), 디자인 계약은 [docs/design/README.md](docs/design/README.md)에 있습니다.
