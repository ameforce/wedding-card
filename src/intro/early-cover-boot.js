(function installPastelIntroEarlyBoot() {
  var query = new URLSearchParams(window.location.search);
  var isPublicPastel = window.location.pathname === "/" && query.get("variant") !== "quiet";
  var eligible = isPublicPastel && query.get("capture") !== "1" && query.get("contentPreview") !== "draft";
  var state = {
    eligible: eligible,
    status: eligible ? "poster" : "consumed",
    shownAt: performance.now(),
    minimumHoldUntil: performance.now() + 800,
    deadlineAt: performance.now() + 5000,
    reason: eligible ? null : "ineligible",
  };
  window.__pastelIntroEarly = state;
  if (!eligible) return;

  document.documentElement.classList.add("early-intro-enabled");
  var timeoutId = 0;
  var hiddenAt = document.hidden ? performance.now() : null;
  function armDeadline() {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(function () { consume("timeout"); }, Math.max(0, state.deadlineAt - performance.now()));
  }
  function poster() { return document.getElementById("pastel-intro-early-poster"); }
  function consume(reason) {
    if (state.status === "consumed") return;
    state.status = "consumed";
    state.reason = reason;
    window.clearTimeout(timeoutId);
    document.dispatchEvent(new CustomEvent("pastel-intro-early-finish", { detail: { reason: reason } }));
    poster()?.remove();
    document.documentElement.classList.remove("early-intro-enabled");
  }
  state.consume = consume;
  state.claim = function () {
    if (state.status !== "poster") return false;
    state.status = "claimed";
    poster()?.setAttribute("data-handoff", "claimed");
    return true;
  };
  state.preparationReady = function () {
    if (state.status === "consumed") return false;
    state.preparationComplete = true;
    window.clearTimeout(timeoutId);
    state.deadlineAt = null;
    return true;
  };
  document.addEventListener("visibilitychange", function () {
    if (state.preparationComplete) return;
    if (document.hidden) {
      hiddenAt = performance.now();
      window.clearTimeout(timeoutId);
      return;
    }
    if (hiddenAt !== null) {
      state.deadlineAt += performance.now() - hiddenAt;
      state.minimumHoldUntil += performance.now() - hiddenAt;
      hiddenAt = null;
    }
    armDeadline();
  });
  if (!document.hidden) armDeadline();
  document.addEventListener("pointerdown", function (event) {
    if (event.target?.closest?.("#pastel-intro-early-poster")) consume("skip");
  }, { capture: true });
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") consume("skip");
  });
}());
