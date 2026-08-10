import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root não existe no index.html");

// BrowserRouter (e não HashRouter) porque o Caddy faz `try_files {path} /index.html`:
// qualquer rota desconhecida cai no index e o roteamento acontece aqui.
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
