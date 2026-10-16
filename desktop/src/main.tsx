import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Overlay from "./Overlay";
import "@fontsource-variable/inter";
import "./styles.css";

const isOverlay = location.hash === "#overlay";
if (isOverlay) document.documentElement.classList.add("overlay-window");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isOverlay ? <Overlay /> : <App />}</StrictMode>,
);
