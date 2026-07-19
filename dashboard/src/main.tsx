import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ExperimentDashboard from "./ExperimentDashboard";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ExperimentDashboard />
  </StrictMode>,
);
