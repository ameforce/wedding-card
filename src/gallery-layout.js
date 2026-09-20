const FULL = Object.freeze({ className: "is-full", sizes: "(min-width: 768px) 398px, calc(100vw - 24px)" });
const LARGE = Object.freeze({ className: "is-large", sizes: "(min-width: 768px) 195px, calc((100vw - 28px) / 2)" });
const SMALL = Object.freeze({ className: "is-small", sizes: "(min-width: 768px) 126px, calc((100vw - 32px) / 3)" });

export function pastelGalleryLayout(index, count) {
  if (count === 1) return FULL;
  if (count === 2) return LARGE;
  if (index < 3) return SMALL;
  if (count === 4) return FULL;
  if (index < 5) return LARGE;

  const remaining = count - 5;
  const lastRowCount = remaining % 3 || 3;
  const positionInRemainder = index - 5;
  if (positionInRemainder >= remaining - lastRowCount && lastRowCount === 1) return FULL;
  if (positionInRemainder >= remaining - lastRowCount && lastRowCount === 2) return LARGE;
  return SMALL;
}
