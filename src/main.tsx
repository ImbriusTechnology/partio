import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { platform } from "./lib/platform";
import "./App.css";

// Lets the stylesheet adapt per platform (the macOS overlay title bar needs room for the traffic lights).
document.documentElement.classList.add(`platform-${platform}`);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
