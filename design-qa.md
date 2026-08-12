# Design QA

## Comparison targets

### Quiet Editorial

- Source visual truth: `docs/design/references/quiet-editorial-letter.png`
- Implementation screenshot: `artifacts/qa/quiet-390.png`
- Source pixels: 390 × 1187
- Implementation pixels: 390 × 1229
- CSS viewport: 390 × 1187, device scale factor 1
- State: `?variant=quiet&capture=1`, design-only content

### Pastel Letter

- Source visual truth: `docs/design/references/pastel-letter-album.png`
- Implementation screenshot: `artifacts/qa/pastel-390.png`
- Source pixels: 390 × 1040
- Implementation pixels: 390 × 1061
- CSS viewport: 390 × 1040, device scale factor 1
- State: `?variant=pastel&capture=1`, design-only content

## Full-view comparison evidence

Source and implementation were opened together for each variant before judgment.

- Quiet preserves the warm ivory paper, thin high-contrast display serif, arched hero slot, centered names/date/message, dot calendar, three staggered crops, low-contrast map, route row, and compact utility footer.
- Pastel preserves the powder-blue/blush watercolor opening, centered Korean serif title, two save cards, 2×2 album rhythm, two-column timeline/story, map with adjacent transit guidance, route row, pale-blue utility footer, and closing message.
- Generated photo-slot art contains no person, likeness, venue, text, logo, or watermark. This is an intentional safety constraint until real photographs are supplied.
- The implementation is 42px taller for Quiet and 21px taller for Pastel. The difference comes from the explicit `DESIGN ONLY` disclosure and production-safe 44px touch targets. It does not change hierarchy or above-the-fold intent.

Focused regions were not separately cropped because the 390px source and implementation captures kept the hero typography, gallery geometry, location treatment, and controls clearly readable at original resolution.

## Comparison history

### Iteration 1

- Quiet rendered at 390 × 1772. Hero, gallery, and location blocks were materially too tall.
- Pastel rendered at 390 × 1395. The location and transit content stacked vertically instead of matching the compact side-by-side source.
- Fixes: reduced excessive section rhythm, restored source-like image proportions, moved Pastel transit guidance beside the map, tightened footer spacing, and retained 44px controls.

### Final iteration

- Quiet: 390 × 1229, no horizontal overflow, fonts loaded, all five images loaded.
- Pastel: 390 × 1061, no horizontal overflow, fonts loaded, all six images loaded.
- No actionable P0, P1, or P2 visual mismatch remains.

## Responsive and interaction verification

- Browser widths checked for both variants: 360, 390, 430, 768, 1440px.
- `scrollWidth` equaled the viewport width at every breakpoint.
- Invitation width is fluid through 430px, then remains centered at 430px for 768/1440px.
- Every rendered button was at least 44px high.
- Unknown `variant` falls back to `quiet` and normalizes the URL.
- Variant buttons update `aria-pressed` and the URL.
- Contact action presents a visible status message without transmitting data.
- Keyboard focus produced a visible focus ring.
- Broken photo asset test replaced all four photo slots with the local fallback and left no broken image element.
- `prefers-reduced-motion` rule is present.
- Browser console: 0 warnings, 0 errors in tested states.

## Required fidelity surfaces

- Fonts and typography: local Cormorant Garamond, Noto Serif KR, and Noto Sans KR variable fonts load successfully; hierarchy and wrapping match the targets.
- Spacing and layout rhythm: final full-page height is within 3.6% for Quiet and 2.1% for Pastel; section order and proportions are preserved.
- Colors and visual tokens: warm ivory/taupe/copper and powder-blue/blush/navy families match the selected directions without synthetic CSS gradients.
- Image quality and assets: 2×-class WebP dimensions cover the 430px maximum card width; total shipped custom raster assets are under 31KB; original PNGs remain outside public output.
- Copy and content: all personal and event fields are explicitly design-only; no unverified fact is presented as real.

## Follow-up polish

- P3: replace abstract photo slots with approved real photographs and define crop/focal points.
- P3: tune final line breaks after actual names, date, venue, and greeting are supplied.

final result: passed
