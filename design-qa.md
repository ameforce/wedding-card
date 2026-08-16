# Design QA

## Accepted pass — Letter B-informed photo hero and venue guidance

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
