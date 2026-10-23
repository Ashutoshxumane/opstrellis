import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Overlay from "./Overlay";
import "@fontsource-variable/inter";
import "./styles.css";
import { applyTheme, initialTheme, IS_MAC } from "./ui";

const isOverlay = location.hash === "#overlay";
if (isOverlay) document.documentElement.classList.add("overlay-window");
else if (IS_MAC && "__TAURI_INTERNALS__" in window) document.documentElement.classList.add("mac-window");
applyTheme(initialTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isOverlay ? <Overlay /> : <App />}</StrictMode>,
);
