export function findPhotoIndexBySource(photos, source) {
  return source == null ? -1 : photos.findIndex((photo) => photo.src === source);
}

export function movePhotoSource(photos, source, offset) {
  if (photos.length === 0) return null;
  const currentIndex = findPhotoIndexBySource(photos, source);
  if (currentIndex < 0) return null;
  return photos[(currentIndex + offset + photos.length) % photos.length].src;
}

export function fallbackPhotoSource(photos, previousIndex) {
  if (photos.length === 0) return null;
  return photos[Math.min(Math.max(previousIndex, 0), photos.length - 1)].src;
}
