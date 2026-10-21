import React from "react";
import { createRoot } from "react-dom/client";
import { testBridge } from "./bridge.test";
import { App } from "./App";
import { BrowserRouter } from "react-router-dom";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><BrowserRouter><App bridge={testBridge} /></BrowserRouter></React.StrictMode>);
