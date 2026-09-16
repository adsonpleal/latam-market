import { useCallback, useEffect } from "react";
import { Navigate, NavLink, Route, Routes, useSearchParams } from "react-router-dom";

import { ItemDrawer } from "./components/ItemDrawer.js";
import { EXTERNAL } from "./lib/links.js";
import { activePause } from "./lib/market/quarantine.js";
import { BuscarPage } from "./pages/Buscar.js";
import { FavoritosPage } from "./pages/Favoritos.js";
import { ReplayPage } from "./pages/Replay.js";
import { useCatalogue } from "./state/useCatalogue.js";
import { useFavoriteWatch } from "./state/useFavoriteWatch.js";
import { useReplay } from "./state/useReplay.js";
import { SERVERS, useServer } from "./state/useServer.js";
import type { Server } from "./lib/server.js";

export function App() {
  const catalogue = useCatalogue();
  const replay = useReplay(catalogue.loadDescriptions);
  const [params, setParams] = useSearchParams();
  const { server, change } = useServer();

  // Mora aqui pelo mesmo motivo do `useReplay` acima: a rota desmonta ao navegar. O
  // argumento completo está no cabeçalho de `useFavoriteWatch`.
  const watch = useFavoriteWatch(server);
  // Sem relógio próprio: o ponto de exclamação some no próximo render depois de a pausa vencer,
  // e o laço re-renderiza o `App` a cada consulta.
  const navPause = activePause(watch.quarantine, Date.now());

  /**
   * Trocar de servidor troca o mercado das consultas e os alvos dos alertas.
   *
   * O inventário não depende mais de servidor: sem preço, a leitura do replay é a mesma nos
   * dois.
   */
  const changeServer = useCallback(
    (next: Server) => {
      if (next !== server) change(next);
    },
    [server, change],
  );

  /**
   * O detalhe é `?item=<id>` em vez de uma rota própria.
   *
   * Como parâmetro de busca ele funciona igual como link compartilhável (o Discord pode
   * apontar para `/?item=501`), mas não desmonta a página de baixo — com uma rota
   * `/item/:id`, abrir um item da tabela jogaria a tabela fora.
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

  // Quem chega direto por link precisa da descrição sem ter carregado replay nenhum.
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
        <NavLink to="/buscar">Buscar</NavLink>
        <NavLink to="/favoritos">
          Favoritos
          {/* Os que dispararam vêm primeiro: é o que a pessoa precisa ver. Sem nenhum, a
              contagem da lista já diz o que há para acompanhar. */}
          {navPause?.kind === "blocked" || navPause?.kind === "challenge" ? (
            <span className="nav-count is-blocked" title="Consultas pausadas: o site recusou">
              !
            </span>
          ) : watch.fired.length > 0 ? (
            <span className="nav-count is-fired">{watch.fired.length}</span>
          ) : (
            watch.favorites.ids.length > 0 && (
              <span className="nav-count">{watch.favorites.ids.length}</span>
            )
          )}
        </NavLink>

        <label className="server-picker" title="Servidor do mercado consultado pelos favoritos">
          <select value={server} onChange={(e) => changeServer(e.target.value as Server)}>
            {SERVERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </nav>

      <main>
        <Routes>
          <Route path="/" element={<ReplayPage catalogue={catalogue} replay={replay} onSelectItem={select} server={server} />} />
          <Route
            path="/favoritos"
            element={
              <FavoritosPage catalogue={catalogue} watch={watch} onSelectItem={select} server={server} />
            }
          />
          <Route
            path="/buscar"
            element={<BuscarPage catalogue={catalogue} onSelectItem={select} server={server} />}
          />
          {/* As abas que viviam da coleta do servidor. Links antigos (Discord, favoritos do
              navegador) caem no lugar mais próximo do que ofereciam, em vez de "não encontrada". */}
          <Route path="/mercado" element={<Navigate to="/buscar" replace />} />
          <Route path="/pechinchas" element={<Navigate to="/favoritos" replace />} />
          <Route path="/variacoes" element={<Navigate to="/favoritos" replace />} />
          <Route path="/status" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      {selected !== null && Number.isFinite(selected) && (
        <ItemDrawer
          key={`${server}-${selected}`}
          itemId={selected}
          server={server}
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
          <a href={EXTERNAL.reportar} target="_blank" rel="noreferrer noopener">
            Reportar
          </a>
          <span>•</span>
          <a href={EXTERNAL.issues} target="_blank" rel="noreferrer noopener">
            Acompanhar
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
          Preços consultados no site oficial do mercado de {SERVERS.join(" e ")}, a partir do seu
          navegador. Ragnarok Online © Gravity
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
