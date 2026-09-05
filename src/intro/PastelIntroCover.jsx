import { useEffect, useRef, useState } from "react";
import {
  assertRibbonFrameDimensions,
  createFinalFrameGate,
  createFrameStallGate,
  createRibbonFrameLoader,
  createSequentialRibbonScheduler,
  loadRibbonManifest,
} from "./ribbon-player.mjs";
import "./pastel-intro.css";

const MANIFEST_URL = "/assets/design/ribbon-sequence/manifest.json";
const ASSET_WAIT_MS = 5_000;
const SKIP_MS = 270;
const FRAME_STALL_MS = 1_500;
const PLAYBACK_SLACK_MS = 2_500;
const MAX_PLAYBACK_WATCHDOG_MS = 12_000;

function drawFrame(canvas, frame, manifest) {
  assertRibbonFrameDimensions(frame, manifest);
  const context = canvas?.getContext("2d");
  if (!context) throw new Error("Ribbon sequence canvas is unavailable.");
  if (canvas.width !== manifest.width) canvas.width = manifest.width;
  if (canvas.height !== manifest.height) canvas.height = manifest.height;
  context.clearRect(0, 0, manifest.width, manifest.height);
  context.drawImage(frame, 0, 0, manifest.width, manifest.height);
}

export function PastelIntroCover({ onFinish, manifestUrl = MANIFEST_URL, loaderFactory = createRibbonFrameLoader }) {
  const canvasRef = useRef(null);
  const finishRef = useRef(onFinish);
  const finishedRef = useRef(false);
  const skipRef = useRef(() => {});
  const [leaving, setLeaving] = useState(false);
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [panelDurationMs, setPanelDurationMs] = useState(1200);

  useEffect(() => { finishRef.current = onFinish; }, [onFinish]);

  useEffect(() => {
    let active = true;
    let loader;
    let scheduler;
    let finalGate;
    let animationFrame = 0;
    let assetTimer = 0;
    let skipTimer = 0;
    let stallGate;
    let playbackWatchdog = 0;
    const prepared = new Map();
    const ready = new Map();
    const manifestController = new AbortController();
    finishedRef.current = false;

    const clearStall = () => {
      stallGate?.clear();
    };
    const cancelRuntime = () => {
      window.clearTimeout(assetTimer);
      window.clearTimeout(skipTimer);
      clearStall();
      window.clearTimeout(playbackWatchdog);
      window.cancelAnimationFrame(animationFrame);
      scheduler?.stop();
      manifestController.abort();
      finalGate?.cancel();
      stallGate?.cancel();
      loader?.cancel();
      prepared.clear();
      ready.clear();
    };
    const finish = () => {
      if (!active || finishedRef.current) return;
      finishedRef.current = true;
      active = false;
      cancelRuntime();
      document.body.classList.remove("intro-lock");
      finishRef.current?.();
    };
    const skip = () => {
      if (!active || finishedRef.current || skipTimer) return;
      setLeaving(true);
      skipTimer = window.setTimeout(finish, SKIP_MS);
    };
    skipRef.current = skip;
    const prepareFrame = (index) => {
      if (!active || index === null || ready.has(index) || prepared.has(index) || prepared.size >= 2) return;
      const pending = loader.getFrame(index).then((frame) => {
        if (active && !finishedRef.current) ready.set(index, frame);
      }).catch(() => {
        if (active) finish();
      }).finally(() => prepared.delete(index));
      prepared.set(index, pending);
    };
    const prepareWindow = (manifest) => {
      prepareFrame(scheduler.nextFrameIndex);
      prepareFrame(Math.min(scheduler.nextFrameIndex + 1, manifest.frames.length - 1));
    };
    const startPlayback = (manifest) => {
      const terminalIdealMs = manifest.holdMs + manifest.frames.length * (1000 / manifest.fps);
      playbackWatchdog = window.setTimeout(
        finish,
        Math.min(MAX_PLAYBACK_WATCHDOG_MS, Math.max(ASSET_WAIT_MS, terminalIdealMs + PLAYBACK_SLACK_MS)),
      );
      stallGate = createFrameStallGate({
        timeoutMs: FRAME_STALL_MS,
        schedule: window.setTimeout,
        cancelSchedule: window.clearTimeout,
        onTimeout: finish,
      });
      finalGate = createFinalFrameGate({
        panelDelayMs: manifest.panelDelayMs,
        panelDurationMs: manifest.panelDurationMs,
        requestPaint: window.requestAnimationFrame,
        cancelPaint: window.cancelAnimationFrame,
        schedule: window.setTimeout,
        cancelSchedule: window.clearTimeout,
        onPanelsOpen: () => {
          if (active) setPanelsOpen(true);
        },
        onFinish: finish,
      });
      scheduler = createSequentialRibbonScheduler(manifest, { startedAt: performance.now() });
      const animate = (now) => {
        if (!active || finishedRef.current) return;
        const frameIndex = scheduler.dueFrame(now);
        if (frameIndex !== null) {
          const frame = ready.get(frameIndex);
          if (!frame) {
            prepareWindow(manifest);
            stallGate.begin();
            animationFrame = window.requestAnimationFrame(animate);
            return;
          }
          clearStall();
          ready.delete(frameIndex);
          try {
            drawFrame(canvasRef.current, frame, manifest);
            const terminal = scheduler.markDrawn(frameIndex, now);
            if (terminal) {
              window.clearTimeout(playbackWatchdog);
              finalGate.markTerminalDrawn();
              return;
            }
            prepareWindow(manifest);
          } catch {
            finish();
            return;
          }
        }
        animationFrame = window.requestAnimationFrame(animate);
      };
      animationFrame = window.requestAnimationFrame(animate);
    };
    const start = async () => {
      try {
        const manifest = await loadRibbonManifest(manifestUrl, { signal: manifestController.signal });
        if (!active) return;
        setPanelDurationMs(manifest.panelDurationMs);
        loader = loaderFactory(manifest, { maxInFlightDecodes: 2 });
        await loader.prefetch();
        if (!active) return;
        const firstFrame = await loader.getFrame(0);
        if (!active) return;
        const initialWindow = await Promise.all(
          [1, 2].filter((index) => index < manifest.frames.length).map((index) => loader.getFrame(index)),
        );
        if (!active) return;
        drawFrame(canvasRef.current, firstFrame, manifest);
        initialWindow.forEach((frame, offset) => ready.set(offset + 1, frame));
        window.clearTimeout(assetTimer);
        startPlayback(manifest);
      } catch {
        if (active) finish();
      }
    };

    document.body.classList.add("intro-lock");
    assetTimer = window.setTimeout(finish, ASSET_WAIT_MS);
    const keydown = (event) => {
      if (event.key === "Escape") skip();
    };
    window.addEventListener("keydown", keydown);
    void start();
    return () => {
      active = false;
      cancelRuntime();
      document.body.classList.remove("intro-lock");
      window.removeEventListener("keydown", keydown);
      if (skipRef.current === skip) skipRef.current = () => {};
    };
  }, [loaderFactory, manifestUrl]);

  return (
    <div
      className={`pastel-intro-cover${leaving ? " pastel-intro-cover--leaving" : ""}${panelsOpen ? " pastel-intro-cover--opening-panels" : ""}`}
      style={{ "--pastel-intro-panel-duration": `${panelDurationMs}ms` }}
      aria-hidden="true"
      onPointerDown={() => skipRef.current()}
    >
      <div className="pastel-intro-cover__panel pastel-intro-cover__panel--left" />
      <div className="pastel-intro-cover__panel pastel-intro-cover__panel--right" />
      <div className="pastel-intro-cover__seam" />
      <canvas ref={canvasRef} className="pastel-intro-cover__ribbon" width="960" height="640" />
    </div>
  );
}
