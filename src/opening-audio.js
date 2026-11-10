// Keep the muted gesture-unlock pre-roll inaudible until its rewind has
// completed and the media element can resume from the beginning.
export function prepareOpeningAudio(audio, onReady, onError) {
  let active = true;
  let awaitingSeek = false;
  const cleanup = () => {
    active = false;
    audio.removeEventListener("seeked", seeked);
    audio.removeEventListener("canplay", check);
    audio.removeEventListener("playing", check);
    audio.removeEventListener("error", failed);
  };
  const check = () => {
    if (!active || awaitingSeek || audio.seeking || audio.readyState < 3) return;
    cleanup();
    onReady();
  };
  const seeked = () => { awaitingSeek = false; check(); };
  const failed = () => { if (active) { cleanup(); onError(); } };
  audio.addEventListener("seeked", seeked);
  audio.addEventListener("canplay", check);
  audio.addEventListener("playing", check);
  audio.addEventListener("error", failed);
  try {
    if (audio.currentTime > 0) {
      awaitingSeek = true;
      audio.currentTime = 0;
    }
    check();
  } catch {
    failed();
  }
  return cleanup;
}
