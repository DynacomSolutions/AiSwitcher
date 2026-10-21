import React from "react";
import { createRoot } from "react-dom/client";
import { productionBridge } from "./bridge";
import { App } from "./App";
import { BrowserRouter } from "react-router-dom";
import "./styles.css";

const nativeGlass = (window as Window & { __TAURI__?: unknown }).__TAURI__ && /Macintosh|Windows/.test(navigator.userAgent);
if (nativeGlass) document.documentElement.classList.add("native-glass");

createRoot(document.getElementById("root")!).render(<React.StrictMode><BrowserRouter><App bridge={productionBridge} /></BrowserRouter></React.StrictMode>);
