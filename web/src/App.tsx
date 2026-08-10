import { useCallback, useEffect, useState } from "react";
import { NavLink, Route, Routes, useSearchParams } from "react-router-dom";

import { ItemDrawer } from "./components/ItemDrawer.js";
import { McpDialog } from "./components/McpDialog.js";
import { EXTERNAL } from "./lib/links.js";
import { FavoritosPage } from "./pages/Favoritos.js";
import { MercadoPage } from "./pages/Mercado.js";
import { PechinchasPage } from "./pages/Pechinchas.js";
import { ReplayPage } from "./pages/Replay.js";
import { StatusPage } from "./pages/Status.js";
import { VariacoesPage } from "./pages/Variacoes.js";
import { useCatalogue } from "./state/useCatalogue.js";
import { useFavoriteWatch } from "./state/useFavoriteWatch.js";
import { useReplay } from "./state/useReplay.js";
import { SERVERS, useServer } from "./state/useServer.js";
import type { Server } from "./api/client.js";

export function App() {
  const catalogue = useCatalogue();
  const replay = useReplay(catalogue.loadDescriptions);
  const [params, setParams] = useSearchParams();
  const [mcpOpen, setMcpOpen] = useState(false);
  const { server, change } = useServer();

  // Mora aqui pelo mesmo motivo do `useReplay` acima: a rota desmonta ao navegar. O
  // argumento completo está no cabeçalho de `useFavoriteWatch`.
  const watch = useFavoriteWatch(server);

  /**
   * Trocar de servidor troca todos os preços da tela.
   *
   * O replay é reprecificado com o mesmo arquivo — nada de pedir o upload de novo. As
   * demais páginas recebem `server` nas dependências dos seus efeitos e refazem a
   * busca sozinhas.
   */
  const changeServer = useCallback(
    (next: Server) => {
      if (next === server) return;
      change(next);
      replay.reprice();
    },
    [server, change, replay],
  );

  /**
   * O detalhe é `?item=<id>` em vez de uma rota própria.
   *
   * Como parâmetro de busca ele funciona igual como link compartilhável (o MCP e o
   * Discord podem apontar para `/?item=501`), mas não desmonta a página de baixo — com
   * uma rota `/item/:id`, abrir um resultado da busca jogaria a busca fora.
   */
  const raw = params.get("item");
  const selected = raw === null ? null : Number(raw);

  const select = useCallback(
    (itemId: number) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("item", String(itemId));
        return next;
      });
    },
    [setParams],
  );

  const close = useCallback(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("item");
      return next;
    });
  }, [setParams]);

  // Quem chega direto por link precisa da descrição sem ter passado por upload.
  useEffect(() => {
    if (selected !== null) void catalogue.loadDescriptions();
  }, [selected, catalogue]);

  return (
    <>
      <nav className="nav">
        <span className="brand">Mercado RO LATAM</span>
        <NavLink to="/" end>
          Meu inventário
        </NavLink>
        <NavLink to="/mercado">Buscar</NavLink>
        <NavLink to="/pechinchas">Pechinchas</NavLink>
        <NavLink to="/variacoes">Variações</NavLink>
        <NavLink to="/favoritos">
          Favoritos
          {/* Os que dispararam vêm primeiro: é o que a pessoa precisa ver. Sem nenhum, a
              contagem da lista já diz o que há para acompanhar. */}
          {watch.fired.length > 0 ? (
            <span className="nav-count is-fired">{watch.fired.length}</span>
          ) : (
            watch.favorites.ids.length > 0 && (
              <span className="nav-count">{watch.favorites.ids.length}</span>
            )
          )}
        </NavLink>
        <NavLink to="/status">Estado</NavLink>

        <label className="server-picker" title="Servidor do mercado">
          <select value={server} onChange={(e) => changeServer(e.target.value as Server)}>
            {SERVERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <button className="mcp-button" onClick={() => setMcpOpen(true)} title="Conectar uma IA ao mercado">
          ✨ <span>MCP</span>
        </button>
      </nav>

      {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}

      <main>
        <Routes>
          <Route
            path="/"
            element={<ReplayPage catalogue={catalogue} replay={replay} onSelectItem={select} server={server} />}
          />
          <Route path="/mercado" element={<MercadoPage catalogue={catalogue} onSelectItem={select} server={server} />} />
          <Route
            path="/pechinchas"
            element={<PechinchasPage catalogue={catalogue} onSelectItem={select} server={server} />}
          />
          <Route
            path="/variacoes"
            element={<VariacoesPage catalogue={catalogue} onSelectItem={select} server={server} />}
          />
          <Route
            path="/favoritos"
            element={
              <FavoritosPage
                catalogue={catalogue}
                watch={watch}
                onSelectItem={select}
                server={server}
              />
            }
          />
          <Route path="/status" element={<StatusPage server={server} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      {selected !== null && Number.isFinite(selected) && (
        <ItemDrawer
          key={`${server}-${selected}`}
          itemId={selected}
          description={catalogue.descriptions[String(selected)]}
          onClose={close}
        />
      )}

      <footer className="footer">
        <div className="footer-links">
          <a href={EXTERNAL.tools} target="_blank" rel="noreferrer noopener">
            LATAM Tools
          </a>
          <span>•</span>
          <a href={EXTERNAL.discord} target="_blank" rel="noreferrer noopener">
            Discord
          </a>
          <span>•</span>
          <a href={EXTERNAL.repo} target="_blank" rel="noreferrer noopener">
            Código no GitHub
          </a>
          <span>•</span>
          Ícones por{" "}
          <a href={EXTERNAL.ragassets} target="_blank" rel="noreferrer noopener">
            ragassets
          </a>
        </div>
        <div className="footer-note">
          Dados do mercado de jogadores de {SERVERS.join(" e ")}. Ragnarok Online © Gravity
          Co., Ltd. &amp; Lee Myoungjin. Todos os ativos, dados e imagens pertencem aos seus
          respectivos donos. Não é um serviço oficial.
        </div>
      </footer>
    </>
  );
}

function NotFound() {
  return (
    <section className="page">
      <h1>Página não encontrada</h1>
      <p className="lead">
        <NavLink to="/">Voltar para o começo</NavLink>
      </p>
    </section>
  );
}
