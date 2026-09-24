// Automatic presentation metadata; preserve valid legacy descriptions and crops.
export const DEFAULT_PHOTO_ALT = "웨딩 사진";
export const DEFAULT_PHOTO_POSITION = "50% 50%";

export function normalizePhotoPresentation(photo) {
  if (!photo || typeof photo !== "object" || Array.isArray(photo)) return photo;
  const alt = typeof photo.alt === "string" ? photo.alt.trim() : "";
  const position = typeof photo.position === "string" ? photo.position.trim() : "";
  const match = position.match(/^(\d{1,3})%\s+(\d{1,3})%$/);
  return {
    ...photo,
    alt: alt && alt.length <= 300 ? alt : DEFAULT_PHOTO_ALT,
    position: match && Number(match[1]) <= 100 && Number(match[2]) <= 100
      ? `${Number(match[1])}% ${Number(match[2])}%` : DEFAULT_PHOTO_POSITION,
  };
}
