# Design QA

## Current accepted pass — fine paper surface and reference-matched brush lettering

### Source truth and normalized evidence

- Active lettering source truth is `C:\Users\enmso\.codex\codex-remote-attachments\019ff501-f8d7-7280-b3f3-9fed0fbb6140\84FA598D-9FE2-4208-99B0-77A056F6295A\1-사진-1.jpg` (1080 × 286). It supersedes the earlier two-image font decision for this pass. The authoritative paper sources are the supplied 1080 × 2340 mobile screenshots `C:\Users\enmso\AppData\Local\Temp\codex-clipboard-d0f90eb5-338b-41c5-9c61-0526aee5acd7.png` and `C:\Users\enmso\AppData\Local\Temp\codex-clipboard-f79f8fe5-9849-4367-a7e0-8479293a688a.png`.
- Browser-rendered implementation evidence is `artifacts/qa/pastel-paper-script-390-top.png`, `artifacts/qa/pastel-paper-script-390-middle.png`, and `artifacts/qa/pastel-paper-script-390-bottom.png`, each 390 × 844 pixels at CSS viewport 390 × 844 and `devicePixelRatio: 1`, with the lightbox closed and capture mode enabled.
- Focused combined comparison is `artifacts/qa/pastel-paper-script-reference-comparison.png` (980 × 640). It places the complete 1080 × 286 lettering source and the native-density 390px implementation top in one comparison input. The source is a typography crop rather than a full invitation viewport, so only lettering form, stroke weight, terminal shape, and diagonal are judged from it.
- `artifacts/qa/pastel-paper-fibers-reference-comparison.png` (1210 × 1270) is the same-input paper comparison: both mobile sources normalized to 390px width, the native-density IAB top/middle/bottom implementation captures, and the repeat-safe implementation microtexture asset. It supplies both full-view section evidence and a focused asset-level fiber comparison. A stitched browser full-page capture was excluded because the in-app Browser duplicated fixed regions while stitching.

### Findings and comparison history

1. Initial P1 — the Sacramento label had inflated loops, weak connected-brush rhythm, and only a `-4deg` rotation, so it read almost horizontal against the new source. Fix: compared Hurricane, WindSong, Meow Script, Mrs Saint Delafield, and Birthstone on the same photo and selected self-hosted OFL-1.1 Mrs Saint Delafield; increased the static counter-clockwise rotation to `-10deg`, sized it at 66–78px, and kept the required two-line `Our Wedding` / `Day` composition.
2. Initial P1 — the former 864 × 1821 full-page raster carried visible embedded texture while being enlarged, creating a macro-image impression. The first revision increased its resolution but retained long vertical streaks and broad fibrous bands, which still differed materially from the mobile sources' dense, low-contrast, short mottled cold-press fibers.
3. Texture fix — blurred the 1536 × 4096 watercolor surface until it carries low-frequency powder-blue/blush color only. Derived a clean 350 × 350 crop from the first mobile source, mirrored it on both axes into a 700 × 700 repeat-safe `pastel-paper-fibers.webp`, and rendered that real raster microtexture at its reference-equivalent 234px CSS scale and 34% multiply opacity.
4. Post-fix evidence — at 390px the live label bounds remain `2.5..270.1px` inside the invitation while the photo begins at `27.3px`; it extends intentionally past the photo edge without clipping, stays clear of the groom's head, and computes to the exact `-10deg` transform matrix. The authoritative top, middle, and bottom IAB captures now show short dense mottled fibers without the former vertical streaks, pixel blocks, repeat seams, or a detached panel.

### Required fidelity surfaces

- Fonts and typography: Mrs Saint Delafield is thinner, more continuously connected, and has longer ascenders/descenders than the superseded Sacramento treatment. The white label keeps a light 1px/6px shadow for contrast without thickening its strokes.
- Spacing and layout rhythm: the approved 86% arched photo, `50% 58%` crop, intro/photo/identity order, and clear space above the groom remain unchanged. At 360, 390, 430, 768, and 1440px the label remains inside the invitation with no horizontal overflow.
- Colors and visual tokens: the continuous warm-ivory paper with distributed powder-blue/blush wash remains behind all sections. No CSS radial gradient, repeat band, separate panel, or dark gallery surface was added.
- Image quality and asset fidelity: `pastel-watercolor-surface.webp` is a 1536 × 4096, 22,266-byte low-frequency color field; `pastel-paper-fibers.webp` is the 700 × 700, 15,374-byte reference-derived repeat-safe microtexture. The real couple photos are byte-for-byte untouched.
- Copy and content: the exact `Our Wedding Day` label and all confirmed invitation copy remain unchanged; only typeface, placement, angle, and paper rendering changed.

### Responsive, interaction, and verification evidence

- Layout checks at 360, 390, 430, 768, and 1440px remain unchanged: zero document/invitation overflow, an exact 86% photo-width ratio, and the intended font loaded. Final paper evidence is the authoritative IAB 390 × 844, DPR1 capture set at scroll positions 0, 1400, and 3200; the watercolor is nonrepeating and the 234px raster microtexture repeats without a visible edge.
- The hero opened the shared lightbox with focus on `갤러리 닫기`, locked body scroll, and Escape restored focus to `1번째 사진 크게 보기` with the 2px solid/3px-offset focus outline.
- Emulated `prefers-reduced-motion: reduce` reported `labelAnimation: none`, the static `-10deg` matrix, reveal opacity `1`, reveal transform `none`, and transition duration `0s`. Browser warning/error logs were empty.
- `npm run test:ui`: 35/35 passed; `npm run test:sites`: 12/12 passed; `npm run lint`: passed; `npm run build:design`: passed. The build contains `dist/client/index.html`, `dist/server/index.js`, `dist/.openai/hosting.json`, the 22,266-byte low-frequency color surface, the 15,374-byte raster microtexture, and the Mrs Saint Delafield font bundle.

final result: passed

## Superseded pass — Pastel Letter feedback refinement

### Implemented outcome

- Earlier handwritten-script experiments are superseded by the current Sacramento decision and must not be used as implementation or visual-reference evidence. The approved 86% arched frame and `50% 58%` photo focal position remain unchanged.
- The supplied watercolor wash is distributed through the full Pastel invitation at three natural positions, with low-opacity blue/blush support washes and a local procedural paper-grain asset behind content. It is no longer visually concentrated only at the hero's upper edge.
- Pastel inter-section reveal gaps increase from 14px to 28px and its internal section padding is more generous, without adding spacer sections or changing Quiet spacing.
- Pastel contact and account disclosures are independently collapsed by default. Groom/bride emoji markers appear on all four summary titles; each account has an accessible copy control. Account values are modeled once in source and intentionally omitted from tests, logs, and this QA record.
- Background music is not rendered yet: no actual audio file, public playback license, or approved source path was supplied, so no arbitrary track or broken player was added. The remaining input contract is a licensed audio asset/source, applicable public-use credit or rights terms, and intended loop/trim behavior; playback will start off when that source is approved.

### Live browser evidence

- At 360, 390, 430, 768, and 1440px, the earlier Pastel version had no horizontal overflow or loaded-image failures. The current-font evidence is the top-level Sacramento pass.
- The two Pastel account disclosures were initially closed, the two copy controls remained at least 44px tall, and a copy click produced the expected success feedback without exposing the value in QA evidence.
- The shared Pastel lightbox opened from the hero with focus on `갤러리 닫기`; Escape closed it and restored focus to the hero trigger. Under emulated reduced motion, the label animation was disabled while its static diagonal stayed intact, and reveal sections rendered opaque with no transform.
- Quiet regression at the same five widths found no overflow or loaded-image failures, exactly four photo triggers, no account disclosure, and one calendar plus one share action. Its lightbox kept the same keyboard focus restoration behavior.

### Automated verification

- `npm run lint`: passed.
- `npm run test:ui`: 33/33 passed.
- `npm run build:design`: passed and prepared the Sites output.
- `npm run test:sites`: 4/4 passed.
- Plain `npm run build` remains intentionally blocked by the existing design-placeholder guard, not by this change.

### Final result

`passed` for the implementable Pastel feedback. Background music remains explicitly blocked on the licensed source contract above.

## Accepted pass — hero label, restrained motion, and spacing

- Pastel hero uses the exact `Our Wedding Day` label at the approved photo's upper-left without changing its crop or adding a card treatment.
- Shared content sections receive an intersection-based opacity/14px vertical reveal. Capture mode and reduced-motion users receive the final static state immediately.
- Natural inter-section spacing increases by 10px in Quiet and 14px in Pastel without inserting empty spacer sections.
- Browser verification at 360, 390, 430, 768, and 1440px found zero horizontal overflow and zero failed images in both variants. The label remained entirely inside the approved photo at every width.
- Normal-motion canary showed the label settling from 8px/transparent to its final position and sections revealing after scroll. Reduced-motion canary rendered the label and all sections immediately with no transform.
- Account guidance and RSVP remain intentionally absent until exact public values, fields, destination, consent, and retention rules are confirmed.

### Final result

`passed` for the confirmed hero-label, motion, and spacing subset. Account and RSVP remain blocked on user-supplied facts.

## Accepted pass — compact Pastel calendar heading

- Pastel now groups `2026년 12월` directly with `27일 일요일 · 오후 3시 예식` in a centered two-line heading with a 2px internal gap.
- The shared calendar still derives every value from confirmed content; no date, weekday, time, or duration was inferred.
- Quiet keeps its existing horizontal calendar-heading layout while receiving the confirmed weekday in the ceremony label.

### Final result

`passed`

## Accepted pass — revised Pastel hero source and confirmed family birth order

### Source, content, and visual contract

- The Pastel top hero is sourced only from the supplied `KSJ_1400.jpg`, converted into the local responsive `public/assets/photos/pastel-hero-480.webp` and `public/assets/photos/pastel-hero-960.webp` derivatives. The browser never reads the original drive path.
- The photograph remains a 2:3 master inside the existing 86% 4:5 arched inset frame. `object-position: 50% 58%` keeps both faces, the raised bouquet, and the falling petals composed inside the mobile portrait crop without changing the frame, watercolor surface, or typography.
- The new hero has the accurate descriptive alt text `꽃잎이 흩날리는 야외에서 함께 선 신랑과 신부의 스튜디오 사진`. It is distinct from all four Pastel gallery selections; Quiet's photo mapping remains unchanged.
- The confirmed family attribution now renders as `김웅기 · 홍정화의 장남 김종인` and `유효상 · 정소은의 장녀 유지혜`.

### Responsive and interaction evidence

- Live Browser capture: `artifacts/qa/pastel-hero-ksj-1400-390.jpg` at 390px width, top-of-page with the shared lightbox closed.
- The Hero remains the first trigger in the shared accessible Pastel lightbox; opening it, advancing to a gallery image, and closing it restores focus to the new hero trigger.
- Static coverage verifies the WebP dimensions, no-alpha transport, focal position, and non-duplication against the Pastel gallery.

### Final result

`passed`

## Superseded pass — pre-birth-order-confirmation family, contact actions, and Pastel schedule

### Source and rendered evidence

- Product structure follows the previously accepted Letter B audit: family attribution sits after the invitation copy, the confirmed event date receives a readable calendar treatment, and contact details use compact side-specific disclosures near the venue utilities. No Letter B private value was copied.
- Live implementation captures: `artifacts/qa/family-contact-quiet-live-1280.png` and `artifacts/qa/family-contact-pastel-live-1280.png`. Each is a 1280 × 720 browser window containing the real 430px capped invitation at the contact anchor; the screenshots were reopened and visually accepted after capture.
- The expanded contact state was inspected live but intentionally not persisted as a QA artifact, avoiding an unnecessary second copy of the confirmed phone numbers outside the source content.

### Findings and fixes

- Initial P1: the footer `연락하기` control only displayed an unavailable toast. Fix: it now links to one shared `#contact` section rendered by both variants.
- Initial P1: the shared link component opened every destination in a new tab. Fix: only `http:` and `https:` destinations receive `_blank`; `#contact`, `tel:`, and `sms:` stay in the current mobile context.
- Initial P2: the fixed design switcher could cover the contact heading after anchor navigation. Fix: the contact section now uses a 104px scroll margin. Live read-back measured the contact heading below the switcher in both variants.
- Initial P2: family contact text was too small for the established older-guest readability requirement. Fix: disclosure labels are 15px, names 16px, and relations/numbers 13px while each phone and message target remains 44 × 44px.

### Content, interaction, and accessibility

- At this historical acceptance, family attribution used `아들` and `딸`; it is superseded by the current confirmed `장남` and `장녀` display above.
- Two native `details` disclosures group groom-side and bride-side contacts. Each confirmed person has a labeled phone action and message action with normalized `tel:` and `sms:` destinations; neither opens a browser tab.
- Pastel now includes a visible `예식 일정` section with the confirmed December 2026 calendar and Sunday 27 highlighted. The footer still has exactly one calendar action, so no duplicate save control was introduced.
- Live Browser checks found zero failed images and zero horizontal overflow at the capped 430px layout. The narrow-width CSS contract uses a shrinking `minmax(0, 1fr)` person column beside two fixed 44px actions; static tests cover the 360px-sensitive geometry and the five project breakpoints remain governed by the shared invitation cap.
- Native summary focus retained a visible browser outline, contact actions have descriptive accessible names, and reduced-motion continues to shorten all transitions and disable the cat motion.

### Privacy boundary

- Confirmed phone numbers are intentionally part of the static invitation content and will be public if the site is published. Collapsed disclosures organize the screen but are not access control.
- Tests validate contact count, shape, schemes, labels, and touch sizes without repeating literal phone numbers. Account guidance remains absent because no confirmed account data or public-scope approval exists.

### Final result

`passed`

## Accepted pass — unified Pastel Hero and Letter B content audit

### Source and rendered evidence

- Source visual truth is a deliberate three-part composite: the live public Letter B sample at `https://salondeletter.com/w/sample1_2` establishes the real-photo-first hierarchy; `artifacts/qa/pastel-inset-frame-390.png` preserves the previously approved 86% arched inset treatment; the approved project contract fixes the final order as introduction → photo → identity on one watercolor surface with no slash or rule.
- Live Letter B captures were made on 2026-08-17 without opening the contact or account accordions: `artifacts/qa/letter-b-sample-top-2026-08-17-390.png`, `artifacts/qa/letter-b-sample-family-2026-08-17-390.png`, `artifacts/qa/letter-b-sample-schedule-2026-08-17-390.png`, `artifacts/qa/letter-b-sample-calendar-2026-08-17-390.png`, `artifacts/qa/letter-b-sample-countdown-2026-08-17-390.png`, and `artifacts/qa/letter-b-sample-private-sections-2026-08-17-390.png`.
- Implementation screenshot: `artifacts/qa/pastel-hero-unified-390.png` — 390 × 900 pixels, CSS viewport 390 × 900, `devicePixelRatio: 1`, `?variant=pastel&capture=1`, top-of-page state, lightbox closed.
- Full-view combined input: `artifacts/qa/pastel-hero-unified-comparison-390.png` — 1170 × 844 pixels. Left is the current Letter B structural source, middle is the previous accepted inset implementation, and right is the revised implementation, each normalized to a 390 × 844 panel.
- Focused comparison uses the same combined input because the complete Hero anatomy and the former slash/rule remain readable at native mobile density; a separate crop would not expose additional fidelity information.

### Findings and comparison history

- Initial P2: the previous implementation put the photo before the introduction and isolated the copy on a lower watercolor panel with a rotated slash and horizontal rule. Fix: moved the introduction above the single inset photo, applied the watercolor asset to the whole Hero, made the identity block transparent, and removed both divider elements and styles.
- Post-fix evidence: the 390px comparison shows introduction → photo → names/date/place with uninterrupted paper/watercolor around the image. Computed checks at 360, 390, 430, 768, and 1440px report the same order, an exact `0.86` photo-to-invitation width ratio, no horizontal overflow, no failed images, zero divider nodes, a watercolor Hero background, and a transparent identity block without border or shadow.
- Fonts and typography: `Noto Serif KR Variable` remains consistent through the introduction, names, date, and venue; mixed Korean/numeric lines remain centered and readable at 360px.
- Spacing and layout rhythm: the intro-to-photo gap and photo-to-identity gap are balanced without restoring a separate panel. The 430px invitation cap remains intact at desktop widths.
- Colors and visual tokens: the existing `#fcfbf4` paper and supplied watercolor raster now form one Hero surface; no new dark surface, border, rule, or shadow was introduced.
- Image quality and asset fidelity: the approved real photograph is unchanged and remains cover-cropped inside the 86% softly arched frame. No person, likeness, or photo pixels were AI-edited.
- Copy and content: only existing confirmed project copy and facts render. Letter B people, family relations, phone numbers, accounts, and private wording were not copied.
- Browser interaction: at 390px the Hero opened the shared lightbox, focused `갤러리 닫기`, locked body scroll, advanced from photo 1 to photo 2 with ArrowRight, closed with Escape, and restored focus to the Hero. Browser console warnings/errors were empty.
- Reduced motion: emulated `prefers-reduced-motion: reduce` reduced Pastel image transition duration effectively to zero; Quiet's cat motion computed to `animation-name: none`.
- Quiet regression: at all five required widths there was no overflow or failed image, visible controls remained at least 44px high, and exactly one calendar plus one share action rendered.

### Letter B section classification and next content contract

- Implementable from confirmed facts now: the existing names, start date/time, venue, address, map, transit/parking guidance, December calendar in Quiet, and start-only iCalendar action. Pastel already exposes the same event facts in its Hero and the shared footer calendar action.
- Optional presentation using confirmed facts: a dedicated Pastel `예식 안내` block or derived countdown. This is a product-choice question, not a missing-data blocker; it must not duplicate the existing footer calendar action, and a separate event timeline remains intentionally excluded.
- Still requires exact user facts and a public-scope decision: account sections, including side, bank, holder, number, disclosure text, and whether the data is always visible or collapsed. The currently rendered family relations and couple/parent contact controls are already confirmed public content; no additional relation or contact value may be inferred from Letter B.
- Other optional Letter B modules requiring separate product/content decisions: wedding interview, relationship timeline, guest-snap upload, notice carousel, RSVP, guestbook, and music. They are useful patterns, not current project requirements.
- Highest-value next question: Which family/contact/account items, for which people, should be public, and what are the exact approved values?

### Final result

`passed`

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
