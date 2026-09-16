/**
 * A aba Favoritos: os itens favoritados, o preço consultado de cada um e os alertas.
 *
 * Não consulta nada sozinha: quem é dono das consultas ao site é o laço, e o porquê está no
 * cabeçalho de `state/useFavoriteWatch.ts`. Aqui só se mostra o que ele leu e se oferece o
 * que ele sabe fazer.
 */

import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";

import type { Server } from "../lib/server.js";
import { AlertModal } from "../components/AlertModal.js";
import { ClearFavoritesModal } from "../components/ClearFavoritesModal.js";
import { FavoritesTable, type FavoriteRow } from "../components/FavoritesTable.js";
import { NotifyBar } from "../components/NotifyBar.js";
import { PageTitle } from "../components/PageTitle.js";
import { PauseBanner } from "../components/PauseBanner.js";
import { PriceWatchPanel } from "../components/PriceWatchPanel.js";
import { plural } from "../lib/format.js";
import { activePause } from "../lib/market/quarantine.js";
import type { Catalogue } from "../state/useCatalogue.js";
import type { FavoriteWatch } from "../state/useFavoriteWatch.js";
import { useNow } from "../state/useNow.js";

interface Props {
  catalogue: Catalogue;
  watch: FavoriteWatch;
  onSelectItem: (itemId: number) => void;
  server: Server;
}

export function FavoritosPage({ catalogue, watch, onSelectItem, server }: Props) {
  const { favorites, alerts, notify, index, checkOf, queue, current } = watch;
  const [editing, setEditing] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  // Um segundo, porque a faixa de pausa conta o tempo que falta.
  const pause = activePause(watch.quarantine, useNow(1_000));

  // A descrição alimenta o hover do ícone; quem chega direto nesta aba não passou por
  // replay nenhum.
  useEffect(() => {
    void catalogue.loadDescriptions();
  }, [catalogue.loadDescriptions]);

  const rows = useMemo<FavoriteRow[]>(
    () =>
      favorites.ids.map((itemId) => ({
        item: index?.get(itemId) ?? { itemId, name: `#${itemId}`, slots: null },
        check: checkOf(itemId),
        alert: alerts.get(server, itemId),
        pending: current.includes(itemId) ? "current" : queue.includes(itemId) ? "queued" : null,
      })),
    // `alerts.get` e não o objeto `alerts`: aquele é um `useCallback` sobre os alertas, e
    // portanto muda exatamente quando eles mudam. O objeto é novo a cada render, e depender
    // dele remontava as linhas — e com elas o modelo ordenado da tabela — a cada tique.
    [favorites.ids, index, checkOf, alerts.get, server, current, queue],
  );

  /** Favoritos cujo id o catálogo não conhece. Nada enquanto o catálogo não chegou. */
  const missing = useMemo(() => (index ? favorites.ids.filter((id) => !index.has(id)) : []), [index, favorites.ids]);

  const editingName = editing === null ? "" : (index?.get(editing)?.name ?? `#${editing}`);
  const canCheck = watch.bridge.state === "connected" && pause === null;

  return (
    <section className="page">
      <PageTitle title="Favoritos">
        <p>
          Os itens que você favoritou na <NavLink to="/buscar">busca</NavLink> ou no inventário.
        </p>
        <p>
          Conecte-se ao site do mercado, atualize os preços e configure um alvo: quando o mercado
          bater o número, o alerta chega no celular.
        </p>
        <p>
          A lista vale para os dois servidores, mas o <strong>alvo</strong> de cada alerta é por
          servidor — FREYA e NIDHOGG cobram preços bem diferentes.
        </p>
      </PageTitle>

      {pause && (
        <PauseBanner
          pause={pause}
          strikes={watch.quarantine.strikes}
          onRetryChallenge={watch.retryChallenge}
        />
      )}

      <PriceWatchPanel watch={watch} server={server} />

      <NotifyBar notify={notify} enabledCount={alerts.enabledCount(server)} />

      {watch.fired.length > 0 && (
        <div className="alert-banner">
          <div>
            <strong>{plural(watch.fired.length, "alerta disparou", "alertas dispararam")}</strong>
            <ul>
              {watch.fired.slice(0, 5).map((n, i) => (
                <li key={`${n.itemId}-${i}`}>
                  {n.title} — {n.body}
                </li>
              ))}
            </ul>
            {watch.fired.length > 5 && <p>e mais {plural(watch.fired.length - 5, "item", "itens")}.</p>}
          </div>
          <button className="ghost" onClick={watch.dismissFired}>
            Limpar
          </button>
        </div>
      )}

      {missing.length > 0 && (
        <p className="error">
          {missing.length === 1
            ? `O id #${missing[0]} não existe no catálogo.`
            : `Estes ids não existem no catálogo: ${missing.join(", ")}.`}{" "}
          <button className="ghost" onClick={() => missing.forEach(favorites.remove)}>
            Remover da lista
          </button>
        </p>
      )}

      {favorites.ids.length > 0 && (
        <div className="result-head">
          <span>{plural(favorites.ids.length, "favorito", "favoritos")}</span>
          <button className="ghost" onClick={() => setClearing(true)}>
            Limpar favoritos
          </button>
        </div>
      )}

      {favorites.ids.length === 0 ? (
        <div className="empty">
          <p>
            Procure seus itens na aba <NavLink to="/buscar">Buscar</NavLink> e clique na estrela — ou
            em <strong>Favoritar todos</strong> para levar a busca inteira. A estrela também aparece
            em <strong>Meu inventário</strong>.
          </p>
          <p>
            Os favoritos ficam salvos neste navegador. Configure um alvo de preço em cada um, conecte
            a aba do mercado e o alerta chega no celular quando o preço bater.
          </p>
        </div>
      ) : (
        <FavoritesTable
          rows={rows}
          server={server}
          descriptions={catalogue.descriptions}
          onSelect={onSelectItem}
          onEditAlert={setEditing}
          onCheck={watch.checkItem}
          canCheck={canCheck}
        />
      )}

      {clearing && <ClearFavoritesModal favorites={favorites} alerts={alerts} onClose={() => setClearing(false)} />}

      {editing !== null && (
        <AlertModal
          itemId={editing}
          itemName={editingName}
          server={server}
          currentMin={checkOf(editing)?.min ?? null}
          alert={alerts.get(server, editing)}
          onSave={(patch) => alerts.set(server, editing, patch)}
          onRemove={() => alerts.remove(server, editing)}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
