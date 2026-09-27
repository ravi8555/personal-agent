import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./context/ThemeContext";
import { ConsentProvider } from "./context/ConsentContext";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <ConsentProvider>
        <App />
      </ConsentProvider>
    </ThemeProvider>
  </StrictMode>
);