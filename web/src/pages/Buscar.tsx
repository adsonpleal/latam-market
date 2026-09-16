/**
 * A aba Buscar: o catálogo inteiro do jogo, com filtro por tipo e posição.
 *
 * É a porta de entrada do fluxo de preço: a pessoa acha os itens que tem ou quer, favorita
 * (um a um ou todos os resultados de uma vez) e vai para Favoritos consultar os valores. A
 * busca em si não toca o site do mercado — roda no catálogo que o navegador baixou —, então
 * não gasta cota nenhuma.
 *
 * O texto e o filtro moram na URL (`?q=` e `?tipo=`): voltar de Favoritos, recarregar ou
 * mandar o link para alguém mantém a mesma busca.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ItemCell } from "../components/ItemCell.js";
import { ItemLinksCell } from "../components/ItemLinksCell.js";
import { Modal } from "../components/Modal.js";
import { PageTitle } from "../components/PageTitle.js";
import { StarButton } from "../components/StarButton.js";
import { countByFilter, searchItems } from "../lib/catalogue/search.js";
import { CATEGORY_LABEL, EQUIP_SLOTS, FILTER_OPTIONS } from "../lib/catalogue/taxonomy.js";
import { count, plural } from "../lib/format.js";
import type { Server } from "../lib/server.js";
import type { Catalogue } from "../state/useCatalogue.js";
import { useFavorites } from "../state/useFavorites.js";
import { useItemIndex } from "../state/useItemIndex.js";

const PAGE = 50;

/** Acima disto, favoritar todos pede confirmação: é fácil favoritar meio catálogo sem querer. */
const CONFIRM_ABOVE = 50;

const SLOT_LABEL: Record<string, string> = Object.fromEntries(EQUIP_SLOTS.map((s) => [s.id, s.short]));

interface Props {
  catalogue: Catalogue;
  onSelectItem: (itemId: number) => void;
  server: Server;
}

export function BuscarPage({ catalogue, onSelectItem, server }: Props) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const filterId = params.get("tipo") ?? "";
  const filter = FILTER_OPTIONS.find((o) => o.id === filterId) ?? null;

  const favorites = useFavorites();
  const { index, failed } = useItemIndex();
  const [shown, setShown] = useState(PAGE);
  const [confirming, setConfirming] = useState(false);

  // O hover do ícone mostra a descrição.
  useEffect(() => {
    void catalogue.loadDescriptions();
  }, [catalogue.loadDescriptions]);

  /** Troca um parâmetro sem apagar os outros — o `?item=` do painel inclusive. */
  const setParam = (key: string, value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
    setShown(PAGE);
  };

  const counts = useMemo(() => (index ? countByFilter(index, FILTER_OPTIONS) : null), [index]);
  const groups = useMemo(() => {
    const out = new Map<string, typeof FILTER_OPTIONS>();
    for (const option of FILTER_OPTIONS) {
      // Opção que não traria nada não entra no seletor.
      if (counts && (counts.get(option.id) ?? 0) === 0) continue;
      out.set(option.group, [...(out.get(option.group) ?? []), option]);
    }
    return out;
  }, [counts]);

  // A busca inteira só roda quando o texto ou o filtro mudam; "mostrar mais" só corta mais dela.
  const results = useMemo(() => (index ? searchItems(index, { query: q, filter }) : null), [index, q, filter]);
  const page = useMemo(() => results?.slice(0, shown) ?? [], [results, shown]);
  const missing = useMemo(() => results?.filter((e) => !favorites.has(e.itemId)).map((e) => e.itemId) ?? [], [results, favorites]);

  const favoriteAll = () => {
    favorites.addMany(missing);
    setConfirming(false);
  };

  return (
    <section className="page">
      <PageTitle title="Buscar itens">
        <p>
          Todo o catálogo do jogo. Ache os seus itens e favorite com a estrela — ou todos os
          resultados de uma vez — e consulte os preços na aba <strong>Favoritos</strong>.
        </p>
        <p>Buscar aqui não consulta o site do mercado: pode usar à vontade.</p>
      </PageTitle>

      <div className="search-bar">
        <input
          type="search"
          placeholder="Nome ou ID — ex.: Carta Poring, 4001, 502 501"
          value={q}
          onChange={(e) => setParam("q", e.target.value)}
          aria-label="Buscar item"
          autoFocus
        />
        <select value={filter?.id ?? ""} onChange={(e) => setParam("tipo", e.target.value)} aria-label="Tipo de item">
          <option value="">Qualquer tipo</option>
          {[...groups].map(([group, options]) => (
            <optgroup key={group} label={group}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                  {counts && ` (${count(counts.get(o.id))})`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {failed && <p className="error">O catálogo de itens não carregou. Recarregue a página.</p>}
      {!index && !failed && <p className="empty">Carregando o catálogo…</p>}

      {results && results.length === 0 && (
        <p className="empty">
          {q.trim() === "" && !filter ? "Digite um nome ou escolha um tipo para começar." : "Nenhum item com essa busca."}
        </p>
      )}

      {results && results.length > 0 && (
        <>
          <div className="result-head">
            <span>{plural(results.length, "item encontrado", "itens encontrados")}</span>
            <button
              onClick={() => (missing.length > CONFIRM_ABOVE ? setConfirming(true) : favoriteAll())}
              disabled={missing.length === 0}
              title="Adiciona aos favoritos todos os itens desta busca, não só os que estão na tela"
            >
              {missing.length === 0
                ? "★ Todos já estão nos favoritos"
                : missing.length === results.length
                  ? `☆ Favoritar todos (${count(missing.length)})`
                  : `☆ Favoritar os que faltam (${count(missing.length)})`}
            </button>
          </div>

          <div className="table-scroll">
            <table className="offers search-results">
              <thead>
                <tr>
                  <th />
                  <th>Item</th>
                  <th>ID</th>
                  <th>Tipo</th>
                  <th>Equipa em</th>
                  <th>Links</th>
                </tr>
              </thead>
              <tbody>
                {page.map((item) => (
                  <tr key={item.itemId}>
                    <td>
                      <StarButton itemId={item.itemId} />
                    </td>
                    <td className="item-cell">
                      <ItemCell item={item} descriptions={catalogue.descriptions} onSelect={onSelectItem} copiable />
                    </td>
                    <td className="muted">{item.itemId}</td>
                    <td>{item.type ? CATEGORY_LABEL[item.type] : <span className="muted">—</span>}</td>
                    <td>
                      {item.equipSlots.length > 0 ? (
                        item.equipSlots.map((s) => SLOT_LABEL[s] ?? s).join(", ")
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <ItemLinksCell itemId={item.itemId} name={item.name} server={server} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {results.length > page.length && (
            <div className="load-more">
              <button className="ghost" onClick={() => setShown((n) => n + PAGE)}>
                Mostrar mais ({count(results.length - page.length)} restantes)
              </button>
            </div>
          )}
        </>
      )}

      {confirming && (
        <Modal label="Favoritar todos" onClose={() => setConfirming(false)}>
          <h3>Favoritar {plural(missing.length, "item", "itens")}?</h3>
          <p className="lead">
            Todos os resultados desta busca vão para os favoritos, não só os que aparecem na tela.
          </p>
          <p className="note">
            Favoritar não consulta nada. Mas "Atualizar todos os preços" em Favoritos consulta a lista
            inteira, e uma lista grande leva tempo para passar pela cota do site — itens de nome
            parecido saem juntos, mas centenas de itens ainda são dezenas de consultas.
          </p>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
            <button onClick={favoriteAll}>Favoritar {count(missing.length)}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
