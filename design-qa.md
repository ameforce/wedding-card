# Design QA

## Accepted pass — Pastel inset photo frame composite target

### Comparison target and normalization

- Source visual truth is an intentional composite, not either historical screen alone: `C:\Users\enmso\AppData\Local\Temp\wedding-card-photo-layout-audit\01-quiet-hero.png` supplies the inset-frame principle; `C:\Users\enmso\AppData\Local\Temp\wedding-card-photo-layout-audit\02-pastel-hero.png` supplies the Pastel palette and real-photo content. The approved override is an 84–88% (implemented at 86%) softly arched frame with paper breathing room and no visible border or shadow.
- Both source captures are 1280 × 720 pixels at 72 dpi. Their centered 430 × 720 invitation regions were normalized to 390px wide for the focused comparison; the 390px implementation remains at native pixels.
- Implementation capture: `artifacts/qa/pastel-inset-frame-390.png` — 390 × 844 pixels, CSS viewport 390 × 844, `devicePixelRatio: 1`, `?variant=pastel`, default top-of-page state with the lightbox closed.
- Full-view combined input: `artifacts/qa/pastel-inset-frame-comparison-390.png` — Quiet source and Pastel source above the native implementation capture.
- Focused combined input: `artifacts/qa/pastel-inset-frame-focused-comparison-390.png` — left Quiet inset principle, center Pastel content/palette, right current Pastel implementation. The focused hero occupies a native 390px-wide implementation panel, so a separate crop is not needed.

### Findings

- No actionable P0, P1, or P2 differences were found in the approved composite target.
- Intentional deviation: the historical Pastel source is full bleed, while the current implementation is not. This is the approved 86% inset-frame override, not fidelity drift.

### Required fidelity surfaces

- Fonts and typography: the existing `Noto Serif KR Variable` hierarchy, Korean/Latin optical alignment, and readable 390px name/date treatment remain unchanged from the accepted Pastel content surface.
- Spacing and layout rhythm: the live hero measures 335.39px / 390px = 86.0%, with 27.3px side breathing room, 22px top padding at 390px, 20px lower separation, and `50% 50% 18px 18px / 20% 20% 18px 18px` framing.
- Colors and tokens: the Pastel `#fcfbf4` paper, watercolor identity surface, and blue-ink treatment are retained; no new heavy surface, rule, or dark gallery treatment was introduced.
- Image quality and asset fidelity: the supplied real Pastel studio photo is unchanged; its crop remains cover-based, sharp, and free of artificial matte, border, or shadow.
- Copy and content: confirmed couple, date, venue, and existing Pastel invitation copy remain intact; no unconfirmed public information was introduced.

### Responsive, interaction, and console evidence

- Live frame checks passed at 360px (309.59px / 86.0%), 390px (335.39px / 86.0%), and 430px (369.80px / 86.0%); all had no horizontal overflow, `border: 0`, and `box-shadow: none`. Quiet was compared at 390px and retained its existing 37.7% arched hero without regression.
- The shared accessible lightbox opened from the Pastel hero, focused `갤러리 닫기`, advanced to photo 2 with ArrowRight, closed with Escape, and restored focus to `1번째 사진 크게 보기`.
- Browser console error/warning check: none.

### Comparison history

1. 2026-08-17 — first composite comparison using the two approved source captures and the current 390px implementation: no P0/P1/P2 finding; no corrective iteration required.

### Implementation checklist

- [x] Keep the Pastel hero at the approved 86% inset width with an arched, unshadowed frame.
- [x] Preserve the shared gallery/lightbox behavior and Quiet variant.
- [x] Record the durable Pastel frame rule in `AGENTS.md`.

final result: passed

## Superseded pass — Letter B-informed photo hero and venue guidance

The prior full-width Pastel hero acceptance below is superseded only for the top-photo treatment by the composite inset-frame pass above. Its remaining venue, gallery, accessibility, and utility evidence is historical context.

### Visual result

- Pastel now opens with the approved real `KSJ_1562` photo in a full-width 4:5 hero. The hero participates in the same five-photo accessible lightbox as the four gallery images.
- The identity block uses the supplied watercolor raster over the sampled `#fcfbf4` paper tone. `더 바실리움` flows directly into `INVITATION` without a rule, background switch, or hard color seam.
- Current screenshots: `artifacts/qa/letterb-refinement-pastel-top-390.png`, `artifacts/qa/letterb-refinement-pastel-seam-390.png`, `artifacts/qa/letterb-refinement-pastel-venue-390.png`, and `artifacts/qa/letterb-refinement-pastel-hero-lightbox-390.png`.
- The public Letter B reference and the current 390px captures were inspected side by side in the same comparison inputs. The implementation adopts its photo-first hierarchy, gallery clarity, real-map placement, and readable transport grouping without copying its people, text, photos, graphics, or optional private sections.
- The separate `카카오맵 제공` caption is absent. The supplied map image's embedded Kakao provider mark and the source metadata in `src/content.js` remain intact.
- The single calendar action is now in the footer beside the single share action. The upper calendar card is absent.

### Confirmed venue guidance

- Subway: `수인분당선 야탑역 4번 출구에서 도보 400m`.
- Shuttle: `야탑역 4번 출구에서 10~15분 간격으로 운행`.
- Parking: `B2·B4 주차장 이용 · 2시간 무료`.
- Registration: `웨딩홀·연회장 앞`, `8층 웨딩홀 로비 주차등록 기기에서 등록`.

### Responsive and interaction evidence

- Browser widths checked for both variants: 360, 390, 430, 768, and 1440px.
- At all ten variant/width combinations, `scrollWidth === clientWidth`, failed-image count was zero, minimum control height was 44px, and exactly one calendar plus one share action rendered. Quiet exposed four photo triggers; Pastel exposed five.
- The Pastel hero opened the lightbox, focused `갤러리 닫기`, locked body scroll, and restored focus to the hero after Escape. The lightbox reported `5장 중 1번째 사진` and retained the Pastel paper tone.
- Browser logs contained no warning or error; Vite debug and React development info were the only entries.

### iPhone action verdict

- The current LAN preview is `http:` and exposes neither `navigator.share` nor `navigator.canShare`, so iPhone system sharing cannot be proven on this connection. The invitation continues to use native share first on a supported secure context and an explicit copy fallback otherwise.
- Calendar capability still prefers sharing the generated `text/calendar` file when the platform accepts it. The fallback no longer sets the HTML `download` attribute; it opens the calendar resource inline so the browser or OS can hand it to its calendar handler when supported.
- A browser cannot force a particular default calendar application. Actual iPhone native-share validation therefore remains gated on an HTTPS preview or production URL.

### Verification

- `npm run test:ui`: 25/25 passed.
- `npm run lint`: passed.
- `npm run build:design`: passed.
- `npm run test:sites`: 4/4 passed.
- Default production `npm run build` remains intentionally blocked by `isDesignPlaceholder: true` because contact, family, RSVP, account, final greeting, domain/OG, and other publication decisions remain unconfirmed.

final result: passed

## Superseded pass — surface, gallery, and native-action refinements

This section records the prior `45b1ebacc0f3893d4cc88bfd7ae18dc3caa2b384` state. Its top calendar card, visible map caption, and older Pastel paper value were replaced by the current accepted pass above.

### Visual result

- Quiet source comparison: `artifacts/qa/refinements-quiet-source-comparison.png` against `08-quiet-editorial-letter.png`, with the accepted real-photo and interaction deviations.
- Pastel combined comparison: `artifacts/qa/refinements-pastel-source-comparison.png` against `09-pastel-letter-album.png`. The right column intentionally contains three separate, non-overlapping 390 × 844 section captures for top/gallery, venue/footer, and lightbox; it is not presented as a stitched full-page screenshot.
- Focused accepted captures: `artifacts/qa/refinements-pastel-390-top.png`, `artifacts/qa/refinements-pastel-390-map.png`, `artifacts/qa/refinements-pastel-390-footer.png`, `artifacts/qa/refinements-pastel-390-lightbox.png`, and `artifacts/qa/refinements-quiet-390-lightbox.png`.
- Pastel uses one continuous `#f9f5f4` paper surface. The supplied watercolor wash blends into that surface, and the former rule above `INVITATION` is absent.
- `카카오맵 제공` is integrated as the real map card's tinted footer. The descriptive alt text, source identity, venue, address, and route destinations are preserved.
- Both lightboxes use the active invitation's light paper tone instead of a dark overlay. Approved people remain unedited and display in contain mode.
- Pastel has one `캘린더에 추가하기` action near the invitation and one `공유하기` action near the footer. The event-copy control and duplicate footer calendar control are absent. The helper `기기 환경에 따라 파일로 저장돼요` remains one 18px line at 390px.

### Responsive and interaction evidence

- Browser widths checked for both variants: 360, 390, 430, 768, and 1440px.
- At all ten variant/width combinations, document width equaled viewport width, failed-image count was zero, all four photos exposed an enlargement trigger, minimum button height was 44px, and exactly one calendar action plus one share action rendered.
- Quiet hero/gallery and Pastel gallery opened the shared `aria-modal` lightbox, focused the close control, locked body scrolling, advanced with ArrowRight, closed with Escape, and restored focus to the opener.
- Pastel mobile drag advanced photo 1 to photo 2. Both lightbox backdrops computed to their light invitation tone.
- Reduced-motion emulation matched `prefers-reduced-motion: reduce`; sticker animation and transition durations computed to `0s`, with `transform: none`.
- The final Browser console contained no error or warning. This is component-level evidence, not a claim of full-site accessibility conformance.

### Calendar and share platform verdict

- The Web Share API invokes the operating system's sharing mechanism, but it has limited availability, requires a secure context and transient user activation, and recommends payload validation with `navigator.canShare()`: https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_API and https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share.
- The calendar action capability-checks a `text/calendar` file and uses the system share chooser only when the current browser/OS accepts that payload. User cancellation returns `cancelled` without an unwanted download. Unsupported, insecure, policy-blocked, or failed file sharing falls back to the start-only `.ics` file.
- The web cannot guarantee that a specific default calendar app appears or accepts the file. The HTML `download` hint also cannot prove whether the browser will download, display, or open the resource externally: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a and https://developer.mozilla.org/en-US/docs/Web/API/HTMLAnchorElement/download.
- Invitation sharing uses the capability-checked system share sheet first and copies the confirmed summary plus current URL only when native share is unavailable or fails. Abort cancellation never silently copies.
- The LAN HTTP canary exposed neither `navigator.share` nor `navigator.canShare`; it showed the explicit calendar-file fallback toast and copy fallback toast. This is not presented as production-HTTPS native-share evidence. Native, cancellation, unsupported, thrown-capability, and failure paths are covered by dependency-injected tests.

### Verification

- `npm run test:ui`: 23/23 passed.
- `npm run lint`: passed.
- Fresh production `npm run build` with `ALLOW_DESIGN_PLACEHOLDERS` unset: intentionally blocked by the existing placeholder safety gate because transit, parking, contact, and other design-only content remain unconfirmed.
- `npm run build:design`: passed and produced `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
- `npm run test:sites`: 4/4 passed.

final result: passed
