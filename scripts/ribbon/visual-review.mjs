import { loadRibbonManifest, createRibbonFrameLoader, createSequentialRibbonScheduler, calculateRootTranslation, assertRibbonFrameDimensions } from "/__review/player.mjs";

const byId = (id) => document.getElementById(id);
const canvas = byId("ribbon"), context = canvas.getContext("2d"), reference = byId("reference"), invitation = byId("invitation");
const mode = byId("mode"), seek = byId("seek"), speed = byId("speed"), status = byId("status");
let manifest, loader, config, scheduler, index = 0, playing = false, drawing = false, virtualTime = 0, lastTime = null, generation = 0;
let frameQueue = Promise.resolve();

function setStatus(text) { status.textContent = text; }
function updatePosition() { seek.value = index; byId("position").textContent = `${index + 1}/${manifest.frames.length}`; }
function applyPosition() {
  const stage = byId("candidate-screen").getBoundingClientRect();
  const shift = calculateRootTranslation(manifest, index, { width: stage.width, height: stage.height });
  const canvasTop = stage.height / 2 - manifest.registration.y * stage.width / manifest.width;
  canvas.style.top = `${canvasTop}px`;
  canvas.style.transform = `translateY(${shift.y}px) scale(${Number(byId("zoom").value)})`;
}
function showFrame(next, epoch = generation) {
  const pending = frameQueue.then(async () => {
    if (epoch !== generation) return false;
    const frame = await loader.getFrame(next);
    if (epoch !== generation) return false;
    assertRibbonFrameDimensions(frame, manifest);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(frame, 0, 0);
    index = next; updatePosition(); applyPosition();
    return true;
  });
  frameQueue = pending.catch(() => {});
  return pending;
}
function stop() { playing = false; scheduler?.stop(); byId("pause").disabled = true; byId("pause").textContent = "일시 정지"; }
async function restart() {
  const epoch = ++generation;
  stop(); reference.pause(); reference.currentTime = config.referenceStart;
  if (mode.value === "full") {
    reference.playbackRate = 1;
    invitation.src = `/?reviewReplay=${epoch}`;
    reference.play().catch(() => setStatus("원본 영상의 재생 버튼을 눌러 주세요."));
    setStatus("청첩장을 새로 불러오고 있습니다.");
    return;
  }
  byId("restart").disabled = true;
  try {
    if (!await showFrame(0, epoch)) return;
    scheduler = createSequentialRibbonScheduler(manifest);
    virtualTime = 0; lastTime = null; playing = true; byId("pause").disabled = false;
    reference.playbackRate = Number(speed.value);
    reference.play().catch(() => setStatus("리본 재생 중 · 원본 영상은 재생 버튼을 눌러 주세요."));
    setStatus("리본 재생 중");
  } catch { setStatus("리본을 불러오지 못했습니다. 처음부터 다시 재생해 주세요."); }
  finally { if (epoch === generation) byId("restart").disabled = false; }
}
async function animate(now) {
  requestAnimationFrame(animate);
  if (!manifest || !playing || document.hidden) { lastTime = null; return; }
  if (lastTime !== null) virtualTime += (now - lastTime) * Number(speed.value);
  lastTime = now;
  // Decoding delays the next draw, not the active clock. The shared scheduler
  // then extends late playback without losing time or skipping a frame.
  if (drawing) return;
  const next = scheduler.dueFrame(virtualTime);
  if (next === null) return;
  const epoch = generation;
  drawing = true;
  try {
    if (!await showFrame(next, epoch)) return;
    if (scheduler.markDrawn(next, virtualTime)) { stop(); setStatus("리본 재생을 마쳤습니다."); }
  } catch { stop(); setStatus("리본을 불러오지 못했습니다. 처음부터 다시 재생해 주세요."); }
  finally { drawing = false; }
}
byId("restart").onclick = restart;
byId("pause").onclick = () => {
  playing = !playing; lastTime = null;
  byId("pause").textContent = playing ? "일시 정지" : "계속 재생";
  if (playing) reference.play().catch(() => {}); else reference.pause();
};
seek.oninput = async () => {
  const epoch = ++generation;
  stop(); reference.pause();
  try { if (await showFrame(Number(seek.value), epoch)) setStatus("선택한 리본 장면입니다."); }
  catch { if (epoch === generation) setStatus("장면을 불러오지 못했습니다."); }
};
speed.onchange = () => { reference.playbackRate = Number(speed.value); };
byId("zoom").onchange = () => { if (manifest) applyPosition(); };
function renderMode() {
  const full = mode.value === "full";
  canvas.hidden = full; invitation.hidden = !full;
  byId("speed-label").hidden = full; byId("seek-controls").hidden = full; byId("pause").hidden = full;
  byId("zoom-label").hidden = full;
  byId("full-link").hidden = !full;
  byId("candidate-title").textContent = full ? "전체 개봉 샘플" : "리본 샘플";
}
mode.onchange = () => {
  generation += 1; stop(); reference.pause();
  renderMode();
  invitation.removeAttribute("src");
  setStatus("처음부터 재생을 눌러 주세요.");
};
byId("layout").onclick = () => {
  const expanded = document.querySelector(".comparison").classList.toggle("candidate-large");
  byId("layout").setAttribute("aria-pressed", String(expanded));
  byId("layout").textContent = expanded ? "원본과 나란히 보기" : "샘플 크게 보기";
  if (manifest) applyPosition();
};
window.addEventListener("resize", () => { if (manifest) applyPosition(); });
window.addEventListener("pagehide", () => { generation += 1; stop(); loader?.cancel(); });
window.addEventListener("pageshow", (event) => {
  // A history-cached page contains a deliberately cancelled decoder. Reload
  // the same immutable review rather than retaining a half-disposed player.
  if (event.persisted) { window.location.reload(); return; }
  renderMode();
});
document.addEventListener("visibilitychange", () => { if (document.hidden) { playing = false; reference.pause(); byId("pause").textContent = "계속 재생"; } });
invitation.addEventListener("load", () => { if (mode.value === "full" && invitation.hasAttribute("src")) setStatus("전체 개봉 샘플입니다. 다시 보려면 처음부터 재생을 눌러 주세요."); });

try {
  const response = await fetch("/__review/config.json");
  if (!response.ok) throw new Error("Review configuration unavailable");
  config = await response.json(); manifest = await loadRibbonManifest(); loader = createRibbonFrameLoader(manifest);
  canvas.width = manifest.width; canvas.height = manifest.height; seek.max = manifest.frames.length - 1;
  await showFrame(0);
  renderMode();
  byId("restart").disabled = false; seek.disabled = false; setStatus("준비됐습니다. 처음부터 재생을 눌러 주세요.");
  requestAnimationFrame(animate);
} catch { setStatus("비교 파일을 불러오지 못했습니다."); loader?.cancel(); }
