/**
 * A aba Favoritos.
 *
 * Não busca preço nenhum: quem é dono dessa requisição é o laço, e o porquê está no
 * cabeçalho de `state/useFavoriteWatch.ts`. Aqui só se mostra o que ele leu.
 *
 * A única requisição que sai daqui é o `useMovers`, para as colunas "Antes" e "Variação".
 */

import { useEffect, useMemo, useState } from "react";

import type { Server } from "../api/client.js";
import { AlertModal } from "../components/AlertModal.js";
import { FavoritesTable, type FavoriteRow } from "../components/FavoritesTable.js";
import { FreshnessBadge } from "../components/Freshness.js";
import { NotifyBar } from "../components/NotifyBar.js";
import { plural } from "../lib/format.js";
import { parseItemId } from "../lib/persist.js";
import type { Catalogue } from "../state/useCatalogue.js";
import type { FavoriteWatch } from "../state/useFavoriteWatch.js";
import { useMovers } from "../state/useMovers.js";

interface Props {
  catalogue: Catalogue;
  watch: FavoriteWatch;
  onSelectItem: (itemId: number) => void;
  server: Server;
}

export function FavoritosPage({ catalogue, watch, onSelectItem, server }: Props) {
  const { favorites, alerts, notify, prices, missing } = watch;

  const movers = useMovers(server);
  const [addInput, setAddInput] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  // A descrição alimenta o hover do ícone; quem chega direto nesta aba não passou por
  // upload nenhum.
  useEffect(() => {
    void catalogue.loadDescriptions();
  }, [catalogue.loadDescriptions]);

  useEffect(() => {
    if (feedback === null) return;
    const id = window.setTimeout(() => setFeedback(null), 2_500);
    return () => window.clearTimeout(id);
  }, [feedback]);

  const rows = useMemo<FavoriteRow[]>(
    () =>
      favorites.ids.map((itemId) => {
        const mover = movers.get(itemId);
        return {
          itemId,
          price: prices.get(itemId),
          alert: alerts.get(server, itemId),
          before: mover?.before ?? null,
          changePct: mover?.changePct ?? null,
        };
      }),
    // `alerts.get` e não o objeto `alerts`: aquele é um `useCallback` sobre os alertas, e
    // portanto muda exatamente quando eles mudam. O objeto é novo a cada render, e depender
    // dele remontava as linhas — e com elas o modelo ordenado da tabela — a cada tique.
    [favorites.ids, prices, alerts.get, server, movers],
  );

  const submitId = (): void => {
    const itemId = parseItemId(addInput);
    if (itemId === null) {
      setFeedback("ID inválido");
      return;
    }
    // `add` e não `toggle`: enviar duas vezes o mesmo id não pode desfavoritar.
    if (favorites.add(itemId)) {
      setFeedback(`Adicionado #${itemId}`);
      setAddInput("");
    } else {
      setFeedback(`#${itemId} já está nos favoritos`);
    }
  };

  const editingPrice = editing === null ? undefined : prices.get(editing);

  return (
    <section className="page">
      <h1>Favoritos</h1>
      <p className="lead">
        Sua lista de itens para acompanhar, com alerta de preço no celular. A lista vale para
        os dois servidores — o <strong>alvo</strong> de cada alerta é por servidor, porque
        FREYA e NIDHOGG cobram preços bem diferentes pelo mesmo item.
      </p>

      <NotifyBar
        notify={notify}
        enabledCount={alerts.enabledCount(server)}
        lastRun={watch.lastRun}
        running={watch.running}
        nextTradingAt={watch.nextTradingAt}
        onCheckNow={watch.checkNow}
      />

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
            {watch.fired.length > 5 && (
              <p>e mais {plural(watch.fired.length - 5, "item", "itens")}.</p>
            )}
          </div>
          <button className="ghost" onClick={watch.dismissFired}>
            Limpar
          </button>
        </div>
      )}

      <div className="filters">
        <span>
          {favorites.ids.length === 0
            ? "nenhum favorito"
            : `${plural(favorites.ids.length, "favorito", "favoritos")} em ${server}`}
        </span>
        {watch.freshness && <FreshnessBadge freshness={watch.freshness} />}

        <div className="fav-add">
          <input
            type="text"
            inputMode="numeric"
            placeholder="Colar um ID"
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitId()}
            aria-label="Adicionar favorito por ID"
          />
          <button onClick={submitId} disabled={addInput.trim() === ""}>
            Adicionar
          </button>
        </div>
        {feedback && <span className="fav-feedback">{feedback}</span>}
      </div>

      {watch.error && <p className="error">{watch.error}</p>}

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

      {favorites.ids.length === 0 ? (
        <div className="empty">
          <p>
            Clique na estrela ao lado de um item — na aba <strong>Buscar</strong> ou no painel
            de detalhe — para favoritar. Ou cole um <strong>ID</strong> no campo acima.
          </p>
          <p>
            Os favoritos ficam salvos neste navegador. Configure um alvo de preço em cada um e
            o alerta chega no celular quando o mercado bater o número.
          </p>
        </div>
      ) : (
        <FavoritesTable
          rows={rows}
          descriptions={catalogue.descriptions}
          onSelect={onSelectItem}
          onEditAlert={setEditing}
        />
      )}

      {editing !== null && (
        <AlertModal
          itemId={editing}
          itemName={editingPrice?.name ?? `#${editing}`}
          server={server}
          currentMin={editingPrice?.offers?.min ?? null}
          alert={alerts.get(server, editing)}
          onSave={(patch) => alerts.set(server, editing, patch)}
          onRemove={() => alerts.remove(server, editing)}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
