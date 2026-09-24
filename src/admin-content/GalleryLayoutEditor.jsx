import { useId, useRef, useState } from "react";
import { pastelGalleryLayout } from "../gallery-layout.js";
import "./gallery-layout.css";

export function GalleryLayoutEditor({ photos, busy, onMove, renderControls }) {
  const helpId = useId();
  const [selected, setSelected] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [target, setTarget] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const dragSource = useRef(null);
  const tiles = useRef(new Map());
  const selectedIndex = Math.max(0, photos.findIndex((photo) => photo.src === selected));
  const resetDrag = () => { dragSource.current = null; setDragging(null); setTarget(null); };
  const move = (source, destination) => {
    if (busy || source === destination) return;
    const index = photos.findIndex((photo) => photo.src === destination);
    if (index < 0 || !photos.some((photo) => photo.src === source)) return;
    onMove(source, destination);
    setSelected(source);
    setAnnouncement(`사진을 ${index + 1}번 위치로 이동했습니다. 공개하려면 게시해 주세요.`);
    requestAnimationFrame(() => tiles.current.get(source)?.focus({ preventScroll: true }));
  };
  return (
    <section className="content-admin-gallery-layout" aria-label="갤러리 사진 배치">
      <strong>갤러리 배치 · {photos.length}장</strong>
      <p id={helpId}>공개 페이지와 같은 배치입니다. 사진을 원하는 위치로 드래그하세요. 사진을 선택하면 교체·이동·제거할 수 있습니다. 키보드는 Alt + 방향키로 이동합니다.</p>
      <div className="content-admin-gallery-grid">
        {photos.map((photo, index) => (
          <button key={photo.src} type="button" disabled={busy} draggable={!busy}
            ref={(node) => { if (node) tiles.current.set(photo.src, node); else tiles.current.delete(photo.src); }}
            className={`content-admin-gallery-tile ${pastelGalleryLayout(index, photos.length).className}${index === selectedIndex ? " is-selected" : ""}${dragging === photo.src ? " is-dragging" : ""}${target === photo.src ? " is-drop-target" : ""}`}
            aria-label={`갤러리 ${index + 1} 선택`} aria-pressed={index === selectedIndex} aria-describedby={helpId}
            onClick={() => setSelected(photo.src)}
            onDragStart={(event) => {
              if (busy) { event.preventDefault(); return; }
              dragSource.current = photo.src;
              setDragging(photo.src);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-wedding-gallery", photo.src);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (busy || !dragSource.current) { event.dataTransfer.dropEffect = "none"; return; }
              event.dataTransfer.dropEffect = "move";
              setTarget(photo.src);
            }}
            onDragLeave={() => setTarget((current) => current === photo.src ? null : current)}
            onDrop={(event) => {
              event.preventDefault();
              if (busy || !dragSource.current) { resetDrag(); return; }
              move(dragSource.current, photo.src);
              resetDrag();
            }}
            onDragEnd={resetDrag}
            onKeyDown={(event) => {
              if (event.key === "Escape") resetDrag();
              if (!event.altKey || busy) return;
              const direction = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1
                : ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : 0;
              if (!direction) return;
              event.preventDefault();
              const destination = photos[index + direction];
              if (destination) move(photo.src, destination.src);
            }}>
            <img src={photo.src} alt="" loading="lazy" draggable="false" style={{ objectPosition: photo.position }} />
            <span className="content-admin-gallery-index" aria-hidden="true">{index + 1}</span>
            {target === photo.src && dragging !== photo.src && <span className="content-admin-gallery-drop" aria-hidden="true">여기로 이동</span>}
          </button>
        ))}
      </div>
      <p className="content-admin-gallery-announcement" role="status" aria-live="polite">{announcement}</p>
      {photos[selectedIndex] && renderControls(selectedIndex, () => setSelected(photos[selectedIndex].src))}
    </section>
  );
}
