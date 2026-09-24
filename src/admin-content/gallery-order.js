/** Insert at the target position, retaining all intervening photos in order. */
export function reorderGallery(photos, source, target) {
  const from = photos.findIndex((photo) => photo.src === source);
  const to = photos.findIndex((photo) => photo.src === target);
  if (from < 0 || to < 0 || from === to) return photos;
  const next = [...photos];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
