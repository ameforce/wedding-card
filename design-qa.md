# Design QA

## Accepted pass — surface, gallery, and native-action refinements

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
