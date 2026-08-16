# Design QA

## Current pass — Pastel gallery and readability redesign

This pass supersedes the earlier Pastel layout notes below. The older sections remain as implementation history only.

### Comparison targets

- Source visual truth: `C:/Users/enmso/.codex/visualizations/2026/08/12/019ff501-f8d7-7280-b3f3-9fed0fbb6140/09-pastel-letter-album.png`, with the user-approved deviations to remove the redundant timeline, enlarge real photographs, make the story full-width, and remove coupon-like utility separators.
- Implementation screenshot: `artifacts/qa/pastel-redesign-390-stitched.png`.
- Combined comparison input: `artifacts/qa/pastel-redesign-source-comparison.png`.
- Focused interaction evidence: `artifacts/qa/pastel-redesign-390-gallery.png`, `artifacts/qa/pastel-redesign-390-lightbox.png`, and `artifacts/qa/pastel-redesign-390-venue.png`.
- Source pixels: 390 × 1040. Implementation pixels: 390 × 2050. Both use a 390px CSS width at device scale factor 1; the implementation is intentionally taller because readable type, full-height photographs, a real map, and larger touch controls replace the source mock's microtype and compact placeholders.
- CSS viewport for browser captures: 390 × 844 at device scale factor 1.
- State: `?variant=pastel`, default invitation plus the first-photo lightbox state.

### Full-view and focused comparison evidence

- The warm-white paper, powder-blue/blush watercolor hero, navy Korean serif hierarchy, centered invitation rhythm, album character, map section, and soft-blue utilities remain faithful to the selected Pastel target.
- The approved product change intentionally replaces the source's tiny 94px photo strips with four 3:4 real-photo buttons and removes the duplicate timeline. `우리의 이야기` now spans the full content width.
- All four supplied studio photographs are sharp, use their approved focal positions, and remain recognizable without AI alteration. No placeholder art, generated people, or CSS image substitute is present.
- The real Kakao map image and visible attribution replace the target's fictional line map.
- Focused review was required because interaction controls and image crops were too small to judge in the full-view comparison. The gallery, lightbox, and venue/action captures show these areas at the actual 390px viewport.

### Comparison history for this pass

1. Earlier audit findings: fixed 94px gallery rows cropped most of each portrait; photos were non-interactive; `우리의 하루` rendered two unconfirmed `시간 미정` entries beside a very narrow story column; boxed route and footer separators read like a coupon. Result: blocked with P1 gallery usability and P2 wrapping/action-surface findings.
   Before evidence: `artifacts/qa/pastel-review-02-mobile-top.png`, `artifacts/qa/pastel-review-03-mobile-gallery-story.png`, and `artifacts/qa/pastel-review-04-mobile-venue.png`.
2. Implementation fix: removed the timeline data and column, joined the existing story into one full-width paragraph, changed the gallery to four 3:4 buttons, and added a portal lightbox with close/previous/next controls, body scroll lock, Escape and arrow keys, focus containment/restoration, swipe navigation, reduced-motion compatibility, and safe-area offsets.
3. First post-fix browser pass: the layout and lightbox passed, but `네이버 지도` wrapped while adjacent route labels stayed on one line. Fix: the visible label is now `네이버` with the full accessible label `네이버 지도에서 길찾기`.
4. Final post-fix evidence: no actionable P0, P1, or P2 finding remains. At 360/390/430px, route and footer action labels remain single-line; the story uses 15px text with 30px line-height and wraps naturally to 3/2/2 lines.

### Responsive, behavior, and accessibility evidence

- Browser widths checked for both Quiet and Pastel: 360, 390, 430, 768, and 1440px.
- At all ten variant/width combinations, document width equaled viewport width, failed-image count was zero, and the Browser console produced no error events.
- Pastel rendered four gallery buttons at every width. Opening a photo set `aria-modal="true"`, moved focus to the close button, locked body scrolling, and restored focus to the originating photo after closing.
- Runtime controls passed: right arrow advanced the caption, Escape closed the dialog, the last focusable control cycled back to the close control, and a leftward mobile drag advanced from photo 1 to photo 2.
- Keyboard and touch checks support this component-level result; this report does not claim full-site accessibility conformance.

### Required fidelity surfaces

- Fonts and typography: Noto Serif KR retains the selected editorial tone. The story is 15px/30px rather than mockup microtype; action labels remain readable and untruncated across the required widths.
- Spacing and layout rhythm: save cards stack below 600px, the gallery uses a balanced 2 × 2 portrait grid, the story is centered at full width, and venue/actions use independent soft surfaces without divider rows.
- Colors and visual tokens: the selected ivory, navy, powder-blue, blush, and low-contrast gray palette is preserved.
- Image quality and asset fidelity: all four approved studio assets render through responsive `srcset`; crops were visually checked at 390px and in the contain-mode lightbox.
- Copy and content: the redundant timeline and its unconfirmed entries are absent. Confirmed names, date, time, venue, address, and map destinations remain unchanged.
- Icons and controls: existing Phosphor icons remain optically centered; lightbox controls are 48 × 48px and route/footer controls meet the existing mobile touch-target contract.

### Follow-up polish

- P3: the fixed design-review switcher and unconfirmed-content badge remain preview-only review chrome. They are not part of the selected invitation art direction and must be handled separately before public release.

## Comparison targets

### Quiet Editorial

- Source visual truth: `docs/design/references/quiet-editorial-letter.png`
- Implementation screenshot: `artifacts/qa/quiet-photos-stickers-390.png`
- Source pixels: 390 × 1187
- Implementation pixels: 390 × 1521
- CSS viewport: 390 × 844, device scale factor 1, full-page capture
- State: `?variant=quiet&capture=1`, real studio photos with user-confirmed names/date/venue and partial design-only content

### Pastel Letter

- Source visual truth: `docs/design/references/pastel-letter-album.png`
- Implementation screenshot: `artifacts/qa/pastel-photos-stickers-390.png`
- Source pixels: 390 × 1040
- Implementation pixels: 390 × 1353
- CSS viewport: 390 × 844, device scale factor 1, full-page capture
- State: `?variant=pastel&capture=1`, real studio photos with user-confirmed names/date/venue and partial design-only content

## Full-view comparison evidence

Both source references and both implementation screenshots were opened in one comparison input before judgment.

- Quiet preserves the warm ivory paper, high-contrast display serif, arched hero, centered names/date/message, dot calendar, staggered gallery, low-contrast map, route row, and compact utility footer.
- Pastel preserves the powder-blue/blush watercolor opening, centered Korean serif title, two save cards, 2×2 album rhythm, two-column timeline/story, side-by-side map/transit guidance, route row, pale-blue utility footer, and closing message.
- The approved real photographs replace only the former abstract photo surfaces. Original people, facial features, clothing, and studio lighting were not AI-edited; browser crops use `object-position` only.
- Three 세상이 cameos create intentional extra vertical rhythm. Their left/right/left sequence is a user-approved extension, so the added full-page height is not design drift.
- Peeking stickers clip only their lower bodies inside reserved cameo rows; animated top and side edges retain internal clearance and do not cover gallery subjects, labels, controls, or map actions. The compact sleeping sticker stays clear of the footer actions.

Focused region crops were not required because the 390px full-page captures keep every changed photo crop, sticker edge, icon, and control clearly readable at original resolution.

## Comparison history

### Existing layout baseline

- The previous accepted build established the two variant structures, 44px controls, icon alignment, content safety badge, and responsive behavior.
- Prior icon alignment evidence remains in `artifacts/qa/icon-alignment-after-actions-quiet-390.png` and `artifacts/qa/icon-alignment-after-pastel-390.png`.

### Photo and sticker iteration 1

- Eight selected studio photographs rendered correctly, but the initial 116px peeking stickers extended above their reserved rows.
- In Pastel, the first sticker overlapped a save-card edge and the second entered the gallery area; this was classified P2.
- Fix: reduced the peeking sticker width to 96px, clipped the lower body inside a dedicated 108px cameo row, and kept the sleeping sticker in a separate 76px row.

### Final iteration

- Quiet: 390 × 1521, no horizontal overflow, four real photos and three sticker assets loaded.
- Pastel: 390 × 1353, no horizontal overflow, four real photos and three sticker assets loaded.
- Post-fix comparison shows no photo subject, copy, icon, button, or map control obscured.
- No actionable P0, P1, or P2 visual mismatch remains.

### Sesang motion and matte correction

- RCA confirmed that a 96px-wide image was animated inside a 96 × 108px `overflow: hidden` mask. The `translateY(-4px) rotate(-1.2deg)` apex pushed real top and side pixels outside that mask, while an added 8px/11px drop shadow made the bright sticker outline read as a floating matte.
- Fix: the mask is now 108 × 108px with 6px internal padding. The rendered cat remains 96px wide and keeps the same final edge-peek position through the compensating `-16px` wrapper offset. The CSS drop shadow is removed; sticker alpha and source artwork are unchanged.
- At the 390px animation apex, both variants retain at least 1.01px top clearance and 4.25px side clearance for both peeking stickers. Reduced-motion remains static.
- Visual evidence: `artifacts/qa/sesang-motion-fix-quiet-390.png` and `artifacts/qa/sesang-motion-fix-pastel-390.png`.

## Responsive and interaction verification

- Browser widths checked for both variants: 360, 390, 430, 768, 1440px.
- `scrollWidth` equaled viewport width at all ten variant/width combinations.
- Invitation width is fluid through 430px, then remains centered at 430px for 768/1440px.
- Each state loaded four real photo elements and three 세상이 sticker elements; failed-image count was zero.
- Every rendered button measured at least 44px high.
- Normal-motion scroll canary: visible cameos advanced `1 → 2 → 3` at scroll positions `0 → 650 → 851`.
- Reduced-motion canary: all three cameos were static, with computed `transform: none`, `transition-duration: 0s`, and `animation-duration: 0s`.
- Variant switcher updated the rendered variant, URL, and document title.
- Map action displayed the expected non-transmitting status feedback.
- Keyboard focus showed a 2px solid outline on the variant control.
- Broken-photo canary produced four styled fallback slots, zero broken image icons, and no horizontal overflow.
- Fresh Browser console check across Quiet → Pastel: zero errors.

## Required fidelity surfaces

- Fonts and typography: local Cormorant Garamond, Noto Serif KR, and Noto Sans KR variable fonts preserve the established hierarchy and wrapping.
- Spacing and layout rhythm: the source section order and density remain intact; the only material height increase comes from three explicit cat cameo rows.
- Colors and visual tokens: warm ivory/taupe/copper and powder-blue/blush/navy palettes remain unchanged around the newly supplied imagery.
- Image quality and asset fidelity: studio photos ship as 480/960px WebP `srcset` derivatives; lossless-refined stickers retain alpha, have no visible rectangle, and total about 617KB. All new public raster assets total about 1.69MB.
- Copy and content: 김종인·유지혜, 2026년 12월 27일 일요일 오후 3시, 더 바실리움, and the three map links are user-confirmed. Address, floor/hall, timezone, end time, transit, parking, contact, family relation, account, and RSVP remain explicitly unconfirmed.

## Follow-up polish

- P3: retune a focal point only if the couple prefers a different face position after reviewing the live page.
- P3: recheck final line breaks after names, date, venue, and greeting are supplied.

## Typography alignment correction

- Current-run screenshots reproduced a 10.5px title centerline mismatch between the two Pastel save cards at 360, 390, and 430px. Both cards now use the same horizontal icon/text alignment, with title and icon centerline deltas reduced to 0px at 360, 390, 430, 768, and 1440px.
- Quiet's mixed date line now uses one Korean-capable serif family with an explicit line-height. The decorative ampersand is optically raised so its bottom baseline matches both names.
- At all ten variant/viewport combinations, route and footer icon/label centerline deltas remain 0px, every image loads, and `scrollWidth` equals the viewport width.
- Accepted before/after evidence: `artifacts/qa/text-alignment-before-quiet-live-390.png`, `artifacts/qa/text-alignment-after-quiet-live-390.png`, `artifacts/qa/text-alignment-before-pastel-live-390.png`, and `artifacts/qa/text-alignment-after-pastel-live-390.png`.

## 세상이 iris fidelity correction

- Magnified comparison: `artifacts/qa/sesang-eye-refinement-before-after.png` (left column before, right column after; first row left cameo, second row right cameo).
- Actual reference review showed dominant yellow-green irises with only a faint blue/cyan reflection, so the correction blends only hue-qualified iris pixels toward cool cyan by about 3 RGB levels on average.
- Changed pixels: left 606, right 60, sleep 14. Alpha differences: 0. Unexpected visible-pixel differences outside the bounded eye regions: 0.
- Fur, pupils, catchlights, sticker outlines, transparent background, dimensions, animation geometry, and source paths remain unchanged.

final result: passed
