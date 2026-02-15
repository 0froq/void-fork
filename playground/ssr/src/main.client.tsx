import { hydrateRoot } from "react-dom/client";
import App from "./App";

declare global {
  interface Window {
    __STATE__: {
      visits: number;
    };
  }
}

hydrateRoot(
  document.getElementById("root")!,
  <App url={window.location.pathname} visitCount={window.__STATE__.visits} />,
);
