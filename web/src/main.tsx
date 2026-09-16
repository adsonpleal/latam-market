import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root não existe no index.html");

// BrowserRouter (e não HashRouter) porque o Cloudflare Pages devolve o `index.html` para
// qualquer rota que não é arquivo (não há `404.html`): o roteamento acontece aqui.
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
