# wedding-card

모바일 청첩장의 두 디자인 방향을 하나의 콘텐츠·기능 구조에서 검토하는 code-first 프로젝트입니다. Figma는 필수 단계나 source of truth가 아닙니다.

## Local design review

```powershell
npm install
npm run dev
```

- `/?variant=quiet`: Quiet Editorial
- `/?variant=pastel`: Pastel Letter

실제 인적·예식 정보가 아직 없기 때문에 화면에는 `DESIGN ONLY`가 표시됩니다. `npm run build`는 이 placeholder가 남아 있으면 의도적으로 실패합니다. 디자인 검토용 정적 결과만 만들 때는 `npm run build:design`을 사용합니다.

## Verification

```powershell
npm run lint
npm run build:design
npm run test:sites
```

시각 검증 기록은 [design-qa.md](design-qa.md), 디자인 계약은 [docs/design/README.md](docs/design/README.md)에 있습니다.
