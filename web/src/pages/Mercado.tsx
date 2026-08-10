import type { OnChangeFn, SortingState } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";

import { messageOf, searchItems, taxonomy, type SearchFilters } from "../api/client.js";
import type { FilterOption, SearchResponse, TaxonomyResponse } from "../api/types.js";
import { FreshnessBadge } from "../components/Freshness.js";
import { SearchTable, sortOf } from "../components/SearchTable.js";
import { plural } from "../lib/format.js";
import type { Catalogue } from "../state/useCatalogue.js";
import { useMoverChanges } from "../state/useMovers.js";

const SEARCH_FAILED = "Falha na busca.";

/**
 * Rótulo de tipo por id, para marcar cada resultado.
 *
 * Sai das próprias opções: as entradas sem `slot` são exatamente as categorias, com o
 * mesmo id e o mesmo rótulo — publicar a lista de categorias à parte seria mandar a
 * mesma informação duas vezes.
 */
const labelsOf = (options: FilterOption[]): Map<string, string> =>
  new Map(options.filter((o) => o.type && !o.slot).map((o) => [o.type!, o.label]));

export function MercadoPage({
  catalogue,
  onSelectItem,
  server,
}: {
  catalogue: Catalogue;
  onSelectItem: (itemId: number) => void;
  server: string;
}) {
  const [query, setQuery] = useState("");
  /** Opção escolhida no seletor, no formato `type:<id>` ou `slot:<id>`. */
  const [filter, setFilter] = useState("");
  const [includeOutOfMarket, setIncludeOutOfMarket] = useState(false);
  // Ligado por padrão: quem busca no mercado quase sempre quer o que dá para comprar
  // agora, não o catálogo do jogo.
  const [forSale, setForSale] = useState(true);
  /** Vazio é a relevância do backend. Ordenar é uma busca nova — ver `changeSorting`. */
  const [sorting, setSorting] = useState<SortingState>([]);

  const [tax, setTax] = useState<TaxonomyResponse | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Os parâmetros que produziram o resultado na tela.
   *
   * "Carregar mais" precisa repetir a MESMA busca com outro offset — se lesse os
   * campos atuais, digitar algo sem apertar Buscar e depois pedir mais traria a página
   * seguinte de outra busca, misturada com a que está na tela.
   */
  const [active, setActive] = useState<{ query: string; filters: SearchFilters } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * Qual busca é a mais recente. Ver o descarte em `run`.
   *
   * Virou necessário quando ordenar passou a ser uma busca: um clique por coluna deixa
   * várias requisições no ar, e sem isto quem manda na tela é quem responder por último.
   */
  const lastRun = useRef(0);

  // A taxonomia vem do backend para não existirem duas listas de tipos para manter.
  useEffect(() => {
    let alive = true;
    taxonomy()
      .then((t) => alive && setTax(t))
      .catch(() => {
        // Sem a lista, os seletores somem e a busca por texto continua funcionando.
      });
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo(() => {
    if (!tax) return [];
    const byGroup = new Map<string, FilterOption[]>();
    for (const option of tax.options) {
      const list = byGroup.get(option.group) ?? [];
      list.push(option);
      byGroup.set(option.group, list);
    }
    return [...byGroup];
  }, [tax]);

  const labels = useMemo(() => labelsOf(tax?.options ?? []), [tax]);

  // A seta de tendência ao lado do nome. `enabled` segura a chamada até haver resultado:
  // quem abre a aba e não busca nada não precisa pedir os movers.
  const movers = useMoverChanges(server, result !== null);

  const canSearch = query.trim().length > 0 || filter !== "";

  /** Do id da opção para os parâmetros da busca — que podem ser os dois ao mesmo tempo. */
  const paramsFor = (optionId: string): SearchFilters => {
    const option = tax?.options.find((o) => o.id === optionId);
    if (!option) return {};
    return { type: option.type, slot: option.slot };
  };

  // A busca é disparada por ação, não por digitação: um `useEffect` em cima do texto
  // mandaria uma requisição por tecla. Mas trocar o seletor é uma ação completa, então
  // esse caminho busca sozinho.
  /**
   * `over` existe porque quem chama daqui acabou de marcar uma caixa (ou clicado num
   * cabeçalho): o `setState` ainda não refletiu quando o handler roda, e ler o estado
   * traria o valor anterior. Por cima do que o estado diz, então.
   */
  const run = async (overrideFilter?: string, over?: Partial<SearchFilters>): Promise<void> => {
    const chosen = overrideFilter ?? filter;
    if (query.trim().length === 0 && !chosen) {
      setResult(null);
      return;
    }
    const filters: SearchFilters = {
      ...paramsFor(chosen),
      all: includeOutOfMarket,
      forSale,
      ...sortOf(sorting),
      ...over,
    };
    const text = query.trim();
    const id = ++lastRun.current;

    setBusy(true);
    setError(null);
    catalogue.loadDescriptions();
    try {
      const found = await searchItems(text, filters);
      // Uma busca mais nova já saiu: esta resposta é passado. Sem a checagem, clicar dois
      // cabeçalhos seguidos deixa na tela a ordem de quem RESPONDEU por último, que não é
      // necessariamente a que a pessoa pediu por último.
      if (id !== lastRun.current) return;
      setResult(found);
      setActive({ query: text, filters });
    } catch (err) {
      if (id !== lastRun.current) return;
      setError(messageOf(err, SEARCH_FAILED));
      setResult(null);
      setActive(null);
    } finally {
      if (id === lastRun.current) setBusy(false);
    }
  };

  const loadMore = async (): Promise<void> => {
    if (!result || !active) return;
    setLoadingMore(true);
    try {
      const next = await searchItems(active.query, active.filters, result.items.length);
      // `total` e `freshness` vêm da resposta nova: a coleta pode ter virado entre uma
      // página e outra, e mostrar a idade antiga seria mentir sobre o dado novo.
      setResult({ ...next, items: [...result.items, ...next.items] });
    } catch (err) {
      setError(messageOf(err, "Falha ao carregar mais."));
    } finally {
      setLoadingMore(false);
    }
  };

  /**
   * Trocar de servidor refaz a busca que está na tela.
   *
   * Sem isto os resultados continuariam ali com os preços do servidor anterior — sem
   * nenhum aviso de que passaram a ser de outro mercado.
   */
  useEffect(() => {
    if (!active) return;
    let alive = true;
    setBusy(true);
    searchItems(active.query, active.filters)
      .then((r) => alive && setResult(r))
      .catch((err: unknown) => alive && setError(messageOf(err, SEARCH_FAILED)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
    // Só o servidor dispara: `active` muda a cada busca nova, que já traz o resultado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  const changeFilter = (value: string): void => {
    setFilter(value);
    void run(value);
  };

  /**
   * Clicar num cabeçalho refaz a busca do zero, em vez de rearranjar o que está na tela.
   *
   * É o que faz "ordenar por mais barato" significar o mais barato do TOTAL: o servidor
   * ordena o conjunto inteiro e devolve a primeira página dele. Rearranjar as cinquenta
   * linhas daqui responderia outra pergunta, parecida o bastante para enganar.
   */
  const changeSorting: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    setSorting(next);
    void run(undefined, sortOf(next));
  };

  const clear = (): void => {
    setQuery("");
    setFilter("");
    // As caixas também são filtro, então voltam ao padrão junto.
    setForSale(true);
    setIncludeOutOfMarket(false);
    setSorting([]);
    setResult(null);
    setActive(null);
    setError(null);
  };

  return (
    <section className="page">
      <h1>Buscar no mercado</h1>
      <p className="lead">
        Procure pelo nome, por um id ou por vários de uma vez (<code>502,501</code>), ou
        filtre por tipo e por onde a peça é equipada — os filtros funcionam sozinhos, sem
        precisar digitar nada. Clique num cabeçalho para ordenar, e em "Colunas" para
        escolher o que fica à vista.
      </p>

      <div className="search-bar">
        <input
          type="search"
          placeholder="Ex.: elixir, bota temporal, 502,501…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void run()}
        />
        <button onClick={() => void run()} disabled={busy || !canSearch}>
          Buscar
        </button>
      </div>

      {tax && (
        <div className="filters">
          <label className="toggle">
            Tipo
            <select value={filter} onChange={(e) => changeFilter(e.target.value)}>
              <option value="">Qualquer</option>
              {groups.map(([group, options]) => (
                <optgroup key={group} label={group}>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={forSale}
              onChange={(e) => {
                setForSale(e.target.checked);
                void run(undefined, { forSale: e.target.checked });
              }}
            />
            À venda agora
          </label>

          {/* Enquanto "à venda agora" está ligado, este não muda nada: o conjunto já é
              um subconjunto do que existe no mercado. Desabilitado em vez de escondido
              para a opção não sumir e reaparecer conforme o outro é marcado. */}
          <label className="toggle">
            <input
              type="checkbox"
              checked={includeOutOfMarket}
              disabled={forSale}
              onChange={(e) => {
                setIncludeOutOfMarket(e.target.checked);
                void run(undefined, { all: e.target.checked });
              }}
            />
            Incluir itens nunca vistos à venda
          </label>

          {(filter || query) && (
            <button className="ghost" onClick={clear}>
              Limpar filtros
            </button>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {result && (
        <>
          <div className="result-head">
            <span>
              {result.total > result.items.length
                ? `Mostrando ${result.items.length} de ${result.total}`
                : plural(result.total, "resultado", "resultados")}
            </span>
            <FreshnessBadge freshness={result.freshness} />
          </div>
          <SearchTable
            rows={result.items}
            descriptions={catalogue.descriptions}
            onSelect={onSelectItem}
            typeLabels={labels}
            movers={movers}
            sorting={sorting}
            onSortingChange={changeSorting}
          />

          {result.items.length < result.total && (
            <div className="load-more">
              <button onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore
                  ? "Carregando…"
                  : `Carregar mais (${result.total - result.items.length} restantes)`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
