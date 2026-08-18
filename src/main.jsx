import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { installMobilePageZoomGuard } from "./mobile-zoom-guard.js";
import "./styles.css";

installMobilePageZoomGuard();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
