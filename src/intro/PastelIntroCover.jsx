import { useEffect, useRef, useState } from "react";
import { INVITATION_MAX_WIDTH, assertRibbonFrameDimensions, calculatePanelHingeTurn, calculateRootTranslation, createFrameStallGate, createRibbonFrameLoader, createSequentialRibbonScheduler, loadInitialRibbonFrames, loadRibbonManifest } from "./ribbon-player.mjs";
import "./pastel-intro.css";

const MANIFEST_URL = "/assets/design/ribbon-sequence/manifest.json";
const ASSET_WAIT_MS = 5_000;
const FRAME_STALL_MS = 1_500;
const PLAYBACK_SLACK_MS = 2_500;
const MINIMUM_POSTER_HOLD_MS = 800;

function drawFrame(canvas, frame, manifest) {
  assertRibbonFrameDimensions(frame, manifest);
  const context = canvas?.getContext("2d");
  if (!context) throw new Error("Ribbon sequence canvas is unavailable.");
  if (canvas.width !== manifest.width) canvas.width = manifest.width;
  if (canvas.height !== manifest.height) canvas.height = manifest.height;
  context.clearRect(0, 0, manifest.width, manifest.height);
  context.drawImage(frame, 0, 0, manifest.width, manifest.height);
}

function earlyIntroState() { return window.__pastelIntroEarly || null; }
function remainingEarlyDeadline(state) { return state?.deadlineAt ? Math.max(0, state.deadlineAt - performance.now()) : ASSET_WAIT_MS; }

function panelCurveProgress(curve, elapsed) {
  const point = Math.min(1, Math.max(0, elapsed));
  if (!Array.isArray(curve) || curve.length < 2) return { progress: point, leftProgress: point, rightProgress: point };
  const right = curve.find((entry) => entry.offset >= point) || curve.at(-1);
  const left = curve[Math.max(0, curve.indexOf(right) - 1)];
  if (right === left || right.offset === left.offset) return right;
  const fraction = (point - left.offset) / (right.offset - left.offset);
  const interpolate = (key) => left[key] + (right[key] - left[key]) * fraction;
  return {
    progress: interpolate("progress"),
    leftProgress: interpolate("leftProgress"),
    rightProgress: interpolate("rightProgress"),
  };
}

function waitForHeroLayout(signal) {
  const hero = document.querySelector(".pastel-hero-photo img");
  if (!hero) return Promise.reject(new Error("Published hero image is unavailable."));
  const loaded = hero.complete
    ? (hero.naturalWidth > 0 ? Promise.resolve() : Promise.reject(new Error("Published hero image failed to load.")))
    : new Promise((resolve, reject) => {
      const cleanup = () => {
        hero.removeEventListener("load", onLoad);
        hero.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onLoad = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("Published hero image failed to load.")); };
      const onAbort = () => { cleanup(); reject(new DOMException("Hero preparation was cancelled.", "AbortError")); };
      hero.addEventListener("load", onLoad, { once: true });
      hero.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  return loaded.then(async () => {
    if (typeof hero.decode === "function") await hero.decode();
    if (hero.naturalWidth < 1) throw new Error("Published hero image has no decoded pixels.");
    hero.getBoundingClientRect();
  });
}

function verifyEarlyPosterIdentity(manifest) {
  const poster = document.getElementById("pastel-intro-early-poster");
  if (!poster) return;
  const frameName = poster.dataset.ribbonFrame;
  if (Number(poster.dataset.ribbonWidth) !== manifest.width || Number(poster.dataset.ribbonHeight) !== manifest.height
    || !frameName || !manifest.frames[0]?.endsWith(`/${frameName}`)) {
    throw new Error("The early poster does not match the active ribbon manifest.");
  }
  if (manifest.schemaVersion === 2 && manifest.poster?.sha256 !== poster.dataset.ribbonPosterSha256) {
    throw new Error("The early poster digest does not match the active ribbon manifest.");
  }
}

function earlyPosterManifestText() {
  const encoded = document.getElementById("pastel-intro-early-poster")?.dataset.ribbonManifestBase64;
  if (!encoded) return undefined;
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function handoffPaperImage() {
  const inherited = getComputedStyle(document.documentElement).getPropertyValue("--pastel-intro-paper-image").trim();
  return inherited || 'url("/assets/design/intro-paper-ivory.webp")';
}

function waitForVisibleDocument(signal) {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      signal?.removeEventListener("abort", onAbort);
    };
    const onVisibilityChange = () => {
      if (document.hidden) return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Ribbon preparation was cancelled.", "AbortError"));
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function PastelIntroCover({ onFinish, manifestUrl = MANIFEST_URL, loaderFactory = createRibbonFrameLoader }) {
  const coverRef = useRef(null);
  const canvasRef = useRef(null);
  const ribbonTrackRef = useRef(null);
  const finishRef = useRef(onFinish);
  const sessionRef = useRef(null);
  const skipRef = useRef(() => {});
  const panelOpeningRef = useRef(false);
  const [posterSource] = useState(() => document.querySelector("#pastel-intro-early-poster img")?.currentSrc || "");
  const [posterDimensions] = useState(() => {
    const poster = document.querySelector("#pastel-intro-early-poster");
    const width = Number(poster?.dataset.ribbonWidth);
    const height = Number(poster?.dataset.ribbonHeight);
    return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
      ? { width, height } : { width: 960, height: 640 };
  });
  const [paperImage] = useState(handoffPaperImage);
  const [frameLive, setFrameLive] = useState(false);
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [panelDurationMs, setPanelDurationMs] = useState(1400);

  useEffect(() => { finishRef.current = onFinish; }, [onFinish]);

  useEffect(() => {
    let session = sessionRef.current;
    const existingEarly = earlyIntroState();
    // A genuine React remount shares the early page-load state. Do not begin
    // any manifest or frame request once that state has already terminated or
    // belongs to another controller. Fixtures without early boot still run.
    if (!session && existingEarly && existingEarly.status !== "poster") {
      finishRef.current?.();
      return undefined;
    }
    if (!session) {
      let active = true;
      let loader;
      let scheduler;
      let manifest;
      let animationFrame = 0;
      let panelFrame = 0;
      let assetTimer = 0;
      let playbackTimer = 0;
      let assetDeadline = performance.now() + ASSET_WAIT_MS;
      let playbackDeadline = 0;
      let preparationComplete = false;
      let hiddenAt = document.hidden ? performance.now() : null;
      let panelElapsed = 0;
      let panelLastPaint = 0;
      let panelDelayRemaining = 0;
      let stallGate;
      let firstDrawn = false;
      const prepared = new Map();
      const ready = new Map();
      const manifestController = new AbortController();
      const early = earlyIntroState();

      const clearTimers = () => {
        window.clearTimeout(assetTimer); window.clearTimeout(playbackTimer);
        window.cancelAnimationFrame(animationFrame); window.cancelAnimationFrame(panelFrame);
        assetTimer = 0; playbackTimer = 0; animationFrame = 0; panelFrame = 0;
        stallGate?.clear();
      };
      const cancelRuntime = () => {
        clearTimers(); scheduler?.stop(); manifestController.abort(); stallGate?.cancel(); loader?.cancel(); prepared.clear(); ready.clear();
      };
      const finish = (reason = "finished") => {
        if (!active) return;
        active = false;
        cancelRuntime();
        if (reason !== "early" && early?.status !== "consumed") early?.consume?.(reason);
        document.body.classList.remove("intro-lock");
        finishRef.current?.();
      };
      skipRef.current = () => finish("skip");
      const armAssetWatchdog = () => {
        window.clearTimeout(assetTimer);
        assetTimer = window.setTimeout(() => finish("timeout"), Math.min(Math.max(0, assetDeadline - performance.now()), remainingEarlyDeadline(early)));
      };
      const armPlaybackWatchdog = () => {
        if (!playbackDeadline) return;
        window.clearTimeout(playbackTimer);
        playbackTimer = window.setTimeout(() => finish("timeout"), Math.max(0, playbackDeadline - performance.now()));
      };
      const applyRootTranslation = (index) => {
        if (!manifest) return;
        const translation = calculateRootTranslation(manifest, index, { width: window.innerWidth, height: window.innerHeight });
        const registration = manifest.registration || { x: manifest.width / 2, y: manifest.height / 2 };
        const scale = Math.min(window.innerWidth, INVITATION_MAX_WIDTH) / manifest.width;
        const track = ribbonTrackRef.current;
        if (!track) return;
        // Registration is constant until a resize; most early frames have no
        // root movement either. Avoid scheduling style work for identical values.
        for (const [property, value] of [
          ["aspect-ratio", `${manifest.width} / ${manifest.height}`],
          ["--pastel-intro-registration-x", `${(manifest.width / 2 - registration.x) * scale}px`],
          ["--pastel-intro-registration-y", `${(manifest.height / 2 - registration.y) * scale}px`],
          ["--pastel-intro-ribbon-y", `${translation.y}px`],
        ]) {
          if (track.style.getPropertyValue(property) !== value) track.style.setProperty(property, value);
        }
      };
      const applyPanelProgress = ({ leftProgress, rightProgress }) => {
        const cover = coverRef.current;
        if (!cover) return;
        const left = calculatePanelHingeTurn(leftProgress);
        const right = calculatePanelHingeTurn(rightProgress);
        // sin(theta) is the exposed turning face: neutral when closed and
        // strongest as the panel approaches edge-on. The zero-width terminal
        // face cannot flash because its projected span has already collapsed.
        // The reference left catches light while the right turns into a much
        // darker book-cover shadow.
        const faceLight = (progress, strength) => Math.sqrt(1 - (1 - progress) ** 2) * strength;
        cover.style.setProperty("--pastel-intro-left-progress", String(left.progress));
        cover.style.setProperty("--pastel-intro-right-progress", String(right.progress));
        cover.style.setProperty("--pastel-intro-left-turn", `${-left.degrees}deg`);
        cover.style.setProperty("--pastel-intro-right-turn", `${right.degrees}deg`);
        cover.style.setProperty("--pastel-intro-left-light", String(faceLight(left.progress, 0.28)));
        cover.style.setProperty("--pastel-intro-right-light", String(faceLight(right.progress, 0.46)));
      };
      const paintPanels = (now) => {
        if (!active || document.hidden || !manifest) return;
        if (!panelLastPaint) panelLastPaint = now;
        const delta = now - panelLastPaint;
        panelLastPaint = now;
        if (panelDelayRemaining > 0) {
          panelDelayRemaining = Math.max(0, panelDelayRemaining - delta);
          // The first opening paint is the measured 0% state. Reset the
          // accumulation origin as the delay ends so its elapsed time begins
          // on the following rAF rather than borrowing one opening frame.
          if (panelDelayRemaining === 0) panelLastPaint = 0;
          panelFrame = window.requestAnimationFrame(paintPanels);
          return;
        }
        if (!panelOpeningRef.current) {
          panelOpeningRef.current = true;
          // The closed-poster seam belongs only to the folded cover. Once the
          // panels begin turning, leaving a fixed sibling at x=50% would draw
          // a line over the newly exposed invitation instead of moving with a
          // paper edge.
          coverRef.current?.style.setProperty("--pastel-intro-seam-opacity", "0");
          setPanelsOpen(true);
        }
        panelElapsed += delta;
        const progress = panelCurveProgress(manifest.panelCurve, panelElapsed / manifest.panelDurationMs);
        applyPanelProgress(progress);
        // Measured curves may reach a zero projected paper width before their
        // recorded 1400ms controller lifetime. Keep the transparent cover
        // alive through that contract; only elapsed panel time ends it.
        if (panelElapsed >= manifest.panelDurationMs) { finish(); return; }
        panelFrame = window.requestAnimationFrame(paintPanels);
      };
      const openPanels = () => {
        panelDelayRemaining = manifest.panelDelayMs;
        panelElapsed = 0;
        panelLastPaint = 0;
        panelFrame = window.requestAnimationFrame(paintPanels);
      };
      const prepareFrame = (index) => {
        if (!active || index === null || ready.has(index) || prepared.has(index) || prepared.size >= 2) return;
        const pending = loader.getFrame(index).then((frame) => { if (active) ready.set(index, frame); })
          .catch(() => { if (active) finish("asset-error"); }).finally(() => prepared.delete(index));
        prepared.set(index, pending);
      };
      const prepareWindow = () => {
        prepareFrame(scheduler.nextFrameIndex);
        prepareFrame(Math.min(scheduler.nextFrameIndex + 1, manifest.frames.length - 1));
      };
      const animate = (now) => {
        if (!active || document.hidden) return;
        const frameIndex = scheduler.dueFrame(now);
        if (frameIndex !== null) {
          const frame = ready.get(frameIndex);
          if (!frame) {
            prepareWindow(); stallGate.begin(); animationFrame = window.requestAnimationFrame(animate); return;
          }
          stallGate.clear(); ready.delete(frameIndex);
          try {
            drawFrame(canvasRef.current, frame, manifest);
            applyRootTranslation(frameIndex);
            if (!firstDrawn) { firstDrawn = true; setFrameLive(true); }
            if (scheduler.markDrawn(frameIndex, now)) {
              openPanels();
              return;
            }
            prepareWindow();
          } catch { finish("asset-error"); return; }
        }
        animationFrame = window.requestAnimationFrame(animate);
      };
      const startPlayback = (initialFrames) => {
        window.clearTimeout(assetTimer);
        assetTimer = 0;
        const now = performance.now();
        const posterShownAt = early?.shownAt ?? now;
        const manifestHoldUntil = posterShownAt + Math.max(manifest.holdMs, MINIMUM_POSTER_HOLD_MS);
        // Early boot extends this deadline by hidden preparation time. It
        // therefore measures visible poster hold instead of wall-clock time.
        const residualHold = Math.max(0, Math.max(manifestHoldUntil, early?.minimumHoldUntil || 0) - now);
        const scheduledManifest = { ...manifest, holdMs: residualHold };
        initialFrames.slice(1).forEach((frame, offset) => ready.set(offset + 1, frame));
        drawFrame(canvasRef.current, initialFrames[0], manifest);
        applyRootTranslation(0);
        // A persisted early state belongs to this page load. If another cover
        // already consumed or claimed it, a remount must restore access rather
        // than replay a second ribbon sequence. Test fixtures without early
        // boot retain their direct playback path.
        if (early && !early.claim?.()) {
          finish("duplicate-claim");
          return;
        }
        playbackDeadline = performance.now()
          + residualHold
          + manifest.frames.length * (1000 / manifest.fps)
          + manifest.panelDelayMs
          + manifest.panelDurationMs
          + PLAYBACK_SLACK_MS;
        armPlaybackWatchdog();
        stallGate = createFrameStallGate({ timeoutMs: FRAME_STALL_MS, schedule: window.setTimeout, cancelSchedule: window.clearTimeout, onTimeout: () => finish("asset-stall") });
        scheduler = createSequentialRibbonScheduler(scheduledManifest, { startedAt: performance.now() });
        animationFrame = window.requestAnimationFrame(animate);
      };
      const start = async () => {
        try {
          manifest = await loadRibbonManifest(manifestUrl, {
            signal: manifestController.signal,
            expectedText: earlyPosterManifestText(),
          });
          if (!active) return;
          verifyEarlyPosterIdentity(manifest);
          setPanelDurationMs(manifest.panelDurationMs);
          loader = loaderFactory(manifest, { maxInFlightDecodes: 2, maxPrefetchBytes: 4 * 1024 * 1024 });
          await Promise.all([loader.prefetch(), waitForHeroLayout(manifestController.signal)]);
          if (!active) return;
          const initialFrames = await loadInitialRibbonFrames(loader, manifest);
          if (!active) return;
          // Do not start the scheduler or consume its hold clock while a
          // hidden document cannot present the poster or first canvas frame.
          await waitForVisibleDocument(manifestController.signal);
          if (!active) return;
          preparationComplete = true;
          early?.preparationReady?.();
          startPlayback(initialFrames);
        } catch { if (active) finish("asset-error"); }
      };
      const onEarlyFinish = () => finish("early");
      const onVisibilityChange = () => {
        if (document.hidden) {
          hiddenAt = performance.now(); scheduler?.pause(hiddenAt); clearTimers(); return;
        }
        const resumedAt = performance.now();
        if (hiddenAt !== null) {
          const pauseLength = resumedAt - hiddenAt;
          if (!preparationComplete) assetDeadline += pauseLength;
          if (playbackDeadline) playbackDeadline += pauseLength;
          scheduler?.resume(resumedAt); hiddenAt = null;
        }
        if (!preparationComplete) armAssetWatchdog();
        armPlaybackWatchdog();
        if (scheduler?.completed) { panelLastPaint = 0; panelFrame = window.requestAnimationFrame(paintPanels); }
        else if (scheduler) animationFrame = window.requestAnimationFrame(animate);
      };
      const onResize = () => applyRootTranslation(Math.max(0, (scheduler?.nextFrameIndex || 1) - 1));

      session = {
        mounts: 0,
        disposeTimer: 0,
        dispose() {
          active = false; cancelRuntime();
          // A real unmount differs from the 0 ms StrictMode effect turnover:
          // only this deferred zero-mount path persists the terminal state.
          // It prevents a later React mount from replaying the early poster.
          early?.consume?.("unmount");
          document.removeEventListener("pastel-intro-early-finish", onEarlyFinish);
          document.removeEventListener("visibilitychange", onVisibilityChange);
          window.removeEventListener("resize", onResize);
          document.body.classList.remove("intro-lock");
        },
      };
      sessionRef.current = session;
      document.body.classList.add("intro-lock");
      document.addEventListener("pastel-intro-early-finish", onEarlyFinish);
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("resize", onResize);
      if (!document.hidden) armAssetWatchdog();
      void start();
    }
    window.clearTimeout(session.disposeTimer);
    session.mounts += 1;
    return () => {
      session.mounts -= 1;
      session.disposeTimer = window.setTimeout(() => { if (session.mounts === 0) session.dispose(); }, 0);
    };
  }, [loaderFactory, manifestUrl]);

  return (
    <div ref={coverRef} className={`pastel-intro-cover${panelsOpen ? " pastel-intro-cover--opening-panels" : ""}`} style={{ "--pastel-intro-panel-duration": `${panelDurationMs}ms`, "--pastel-intro-paper-image": paperImage }} aria-hidden="true" onPointerDown={() => {
      const early = earlyIntroState();
      if (early?.consume) early.consume("skip");
      else skipRef.current();
    }}>
      <div className="pastel-intro-cover__envelope">
        <div className="pastel-intro-cover__panel pastel-intro-cover__panel--left" />
        <div className="pastel-intro-cover__panel pastel-intro-cover__panel--right" />
        <div className="pastel-intro-cover__seam" />
      </div>
      <div ref={ribbonTrackRef} className="pastel-intro-cover__ribbon-track" style={{ aspectRatio: `${posterDimensions.width} / ${posterDimensions.height}` }}>
        {posterSource && <img className={`pastel-intro-cover__poster${frameLive ? " is-hidden" : ""}`} src={posterSource} width={posterDimensions.width} height={posterDimensions.height} alt="" />}
        <canvas ref={canvasRef} className="pastel-intro-cover__ribbon" width={posterDimensions.width} height={posterDimensions.height} />
      </div>
    </div>
  );
}
