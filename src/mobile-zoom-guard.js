const TOUCH_FIRST_QUERY = "(pointer: coarse) and (hover: none)";

export function isTouchFirstEnvironment(targetWindow = window) {
  const maxTouchPoints = Number(targetWindow.navigator?.maxTouchPoints ?? 0);
  const mediaQuery = targetWindow.matchMedia?.(TOUCH_FIRST_QUERY);
  return maxTouchPoints > 0 && mediaQuery?.matches === true;
}

export function installMobilePageZoomGuard({
  targetWindow = window,
  targetDocument = document,
} = {}) {
  if (!isTouchFirstEnvironment(targetWindow)) return () => {};

  const preventNativeZoom = (event) => event.preventDefault();
  const preventMultiTouchZoom = (event) => {
    if (event.touches?.length > 1) event.preventDefault();
  };

  targetDocument.addEventListener("gesturestart", preventNativeZoom, { passive: false });
  targetDocument.addEventListener("gesturechange", preventNativeZoom, { passive: false });
  targetDocument.addEventListener("touchstart", preventMultiTouchZoom, { passive: false });
  targetDocument.addEventListener("touchmove", preventMultiTouchZoom, { passive: false });

  return () => {
    targetDocument.removeEventListener("gesturestart", preventNativeZoom);
    targetDocument.removeEventListener("gesturechange", preventNativeZoom);
    targetDocument.removeEventListener("touchstart", preventMultiTouchZoom);
    targetDocument.removeEventListener("touchmove", preventMultiTouchZoom);
  };
}
