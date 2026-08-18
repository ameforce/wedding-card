import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { installMobilePageZoomGuard, isTouchFirstEnvironment } from "../src/mobile-zoom-guard.js";

const main = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
const guardSource = await readFile(new URL("../src/mobile-zoom-guard.js", import.meta.url), "utf8");

function createEnvironment({ maxTouchPoints, touchFirst }) {
  const targetWindow = {
    navigator: { maxTouchPoints },
    matchMedia(query) {
      assert.equal(query, "(pointer: coarse) and (hover: none)");
      return { matches: touchFirst };
    },
  };
  return { targetWindow, targetDocument: new EventTarget() };
}

function touchEvent(type, touchCount) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "touches", { value: Array.from({ length: touchCount }) });
  return event;
}

test("touch-first detection requires both real touch points and a coarse hoverless primary input", () => {
  assert.equal(isTouchFirstEnvironment(createEnvironment({ maxTouchPoints: 5, touchFirst: true }).targetWindow), true);
  assert.equal(isTouchFirstEnvironment(createEnvironment({ maxTouchPoints: 0, touchFirst: true }).targetWindow), false);
  assert.equal(isTouchFirstEnvironment(createEnvironment({ maxTouchPoints: 5, touchFirst: false }).targetWindow), false);
});

test("mobile zoom guard installs before React renders and cancels page-wide native zoom", () => {
  assert.ok(main.indexOf("installMobilePageZoomGuard();") < main.indexOf("createRoot("));

  const environment = createEnvironment({ maxTouchPoints: 5, touchFirst: true });
  const cleanup = installMobilePageZoomGuard(environment);
  const gesture = new Event("gesturestart", { cancelable: true });
  const multiTouch = touchEvent("touchmove", 2);
  const singleTouch = touchEvent("touchmove", 1);

  environment.targetDocument.dispatchEvent(gesture);
  environment.targetDocument.dispatchEvent(multiTouch);
  environment.targetDocument.dispatchEvent(singleTouch);

  assert.equal(gesture.defaultPrevented, true);
  assert.equal(multiTouch.defaultPrevented, true);
  assert.equal(singleTouch.defaultPrevented, false);

  cleanup();
  const afterCleanup = new Event("gesturestart", { cancelable: true });
  environment.targetDocument.dispatchEvent(afterCleanup);
  assert.equal(afterCleanup.defaultPrevented, false);
});

test("desktop environments keep gesture, keyboard, and wheel browser zoom paths uncancelled", () => {
  const environment = createEnvironment({ maxTouchPoints: 5, touchFirst: false });
  installMobilePageZoomGuard(environment);

  const gesture = new Event("gesturestart", { cancelable: true });
  environment.targetDocument.dispatchEvent(gesture);

  assert.equal(gesture.defaultPrevented, false);
  assert.doesNotMatch(guardSource, /addEventListener\(["'](?:wheel|keydown)["']/);
});
