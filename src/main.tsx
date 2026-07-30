import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  }
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: String(error?.message || error) };
  }

  componentDidCatch(error: Error) {
    if (window.__TAURI_INTERNALS__) {
      window.__TAURI_INTERNALS__.invoke("debug_log", {
        msg: "RENDER_ERROR: " + (error?.message || String(error)),
      });
    }
  }

  render() {
    if (this.state.hasError) {
      return React.createElement(
        "div",
        { style: { padding: 20, color: "red", fontFamily: "monospace", whiteSpace: "pre-wrap", fontSize: 14 } },
        "Render Error:\n" + this.state.error
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
