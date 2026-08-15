# Design QA

## Comparison targets

### Quiet Editorial

- Source visual truth: `docs/design/references/quiet-editorial-letter.png`
- Implementation screenshot: `artifacts/qa/quiet-photos-stickers-390.png`
- Source pixels: 390 × 1187
- Implementation pixels: 390 × 1521
- CSS viewport: 390 × 844, device scale factor 1, full-page capture
- State: `?variant=quiet&capture=1`, real studio photos with design-only event content

### Pastel Letter

- Source visual truth: `docs/design/references/pastel-letter-album.png`
- Implementation screenshot: `artifacts/qa/pastel-photos-stickers-390.png`
- Source pixels: 390 × 1040
- Implementation pixels: 390 × 1353
- CSS viewport: 390 × 844, device scale factor 1, full-page capture
- State: `?variant=pastel&capture=1`, real studio photos with design-only event content

## Full-view comparison evidence

Both source references and both implementation screenshots were opened in one comparison input before judgment.

- Quiet preserves the warm ivory paper, high-contrast display serif, arched hero, centered names/date/message, dot calendar, staggered gallery, low-contrast map, route row, and compact utility footer.
- Pastel preserves the powder-blue/blush watercolor opening, centered Korean serif title, two save cards, 2×2 album rhythm, two-column timeline/story, side-by-side map/transit guidance, route row, pale-blue utility footer, and closing message.
- The approved real photographs replace only the former abstract photo surfaces. Original people, facial features, clothing, and studio lighting were not AI-edited; browser crops use `object-position` only.
- Three 세상이 cameos create intentional extra vertical rhythm. Their left/right/left sequence is a user-approved extension, so the added full-page height is not design drift.
- Peeking stickers are clipped inside reserved cameo rows and do not cover gallery subjects, labels, controls, or map actions. The compact sleeping sticker stays clear of the footer actions.

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
- Image quality and asset fidelity: studio photos ship as 480/960px WebP `srcset` derivatives; stickers retain alpha, have no visible rectangle, and total about 221KB. All new public raster assets total about 1.30MB.
- Copy and content: event facts remain visibly design-only. No name, date, venue, contact, family relation, account, or RSVP fact was inferred.

## Follow-up polish

- P3: retune a focal point only if the couple prefers a different face position after reviewing the live page.
- P3: recheck final line breaks after names, date, venue, and greeting are supplied.

final result: passed
