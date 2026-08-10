import { useMemo, useState } from "react";

import { Dropzone } from "../components/Dropzone.js";
import { FilterBar } from "../components/FilterBar.js";
import { ItemsTable } from "../components/ItemsTable.js";
import { SellCandidates } from "../components/SellCandidates.js";
import { SummaryHeader } from "../components/SummaryHeader.js";
import { download, toCsv } from "../lib/csv.js";
import { itemLabel, stamp } from "../lib/format.js";
import { plainDescription } from "../lib/description.js";
import {
  ALL_ORIGINS,
  applyFilters,
  countUnpriced,
  flatten,
  sumValue,
  ORIGIN_LABEL,
  type Filters,
  type Origin,
  type Row,
} from "../lib/rows.js";
import type { Catalogue } from "../state/useCatalogue.js";
import { useMoverChanges } from "../state/useMovers.js";
import type { ReplayController } from "../state/useReplay.js";

const DEFAULT_FILTERS: Filters = {
  // "unidentified" fica de fora por padrão pelo mesmo motivo que o backend o mantém
  // fora do total: são containers cujo significado ainda não foi identificado.
  origins: new Set<Origin>(["inventory", "cart", "equipped"]),
  hideUntradable: true,
  search: "",
};

export function ReplayPage({
  catalogue,
  replay,
  onSelectItem,
  server,
}: {
  catalogue: Catalogue;
  /** Mora no App: sair para "Buscar" e voltar não pode perder o replay carregado. */
  replay: ReplayController;
  onSelectItem: (itemId: number) => void;
  server: string;
}) {
  const { state, upload, clear } = replay;
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const trends = useMoverChanges(server, state.kind === "loaded");

  const rows = useMemo(
    () => (state.kind === "loaded" ? flatten(state.valuation) : []),
    [state],
  );

  /**
   * "Não dá para vender", em um lugar só: alimenta o filtro, a coluna e o CSV.
   *
   * São dois sinais somados, porque nenhum dos dois basta sozinho:
   *
   *  1. a descrição do cliente dizer "Intransferível" (1.202 itens);
   *  2. o item nunca ter aparecido no mercado em semanas de coleta (8.919 itens).
   *
   * O (2) entrou depois de o Emblema do Éden passar pelo filtro: ele é preso à conta
   * no jogo, mas a descrição não diz isso e a tabela do GRF marca os oito flags como
   * liberados. Nenhuma fonte que temos o classifica — só a ausência dele no mercado.
   *
   * O (2) parece largo (62% do catálogo), e a medição diz que não é perigoso: dos
   * 4.184 itens com anúncio ativo agora, a união esconde 7 — exatamente os mesmos 7
   * que a descrição já escondia. Ou seja, "nunca visto à venda" não tira da tabela
   * nada que dê para vender hoje, que é a única garantia que importa aqui.
   */
  const isUnsellable = useMemo(() => {
    const byDescription = catalogue.untradableFailed
      ? () => false
      : (row: Row) => catalogue.untradable.has(row.item.itemId);
    return (row: Row) => byDescription(row) || !row.item.inMarket;
  }, [catalogue.untradable, catalogue.untradableFailed]);

  const visible = useMemo(
    () => applyFilters(rows, filters, isUnsellable),
    [rows, filters, isUnsellable],
  );

  const unsellableCount = useMemo(
    () => rows.filter(isUnsellable).length,
    [rows, isUnsellable],
  );

  const availableOrigins = useMemo(
    () => ALL_ORIGINS.filter((origin) => rows.some((row) => row.origin === origin)),
    [rows],
  );

  if (state.kind === "idle" || state.kind === "loading" || state.kind === "error") {
    return (
      <section className="page">
        <h1>Quanto vale o seu inventário?</h1>
        <p className="lead">
          Suba um replay do Ragnarok LATAM e veja, item por item, por quanto ele está
          sendo vendido no mercado de jogadores de {server}.
        </p>
        <Dropzone onFile={(file) => void upload(file)} busy={state.kind === "loading"} />
        {state.kind === "error" && <p className="error">{state.message}</p>}
      </section>
    );
  }

  const exportCsv = (): void => {
    const headers = [
      "id", "item", "origem", "qtd", "refino", "cartas",
      "menor_oferta", "mediana_oferta", "lojas", "unidades_a_venda", "total",
      "media_vendida", "min_vendido", "max_vendido", "ja_vendidos",
      "vendivel", "visto_no_mercado", "aviso", "divine_pride", "mercado",
    ];
    const body = visible.map((row) => [
      row.item.itemId,
      itemLabel(row.item.name, row.refine, row.item.slots),
      ORIGIN_LABEL[row.origin],
      row.qty,
      row.refine,
      row.cardNames.join(" / "),
      // Número cru: formatado, a planilha trataria a coluna como texto.
      row.unitPrice,
      row.unitMedian,
      row.stores,
      row.units,
      row.total,
      row.market?.avg ?? null,
      row.market?.min ?? null,
      row.market?.max ?? null,
      row.market?.totalSold ?? null,
      isUnsellable(row) ? "não" : "sim",
      row.item.inMarket ? "sim" : "nunca",
      plainDescription(row.priceCaveat ?? undefined),
      row.item.links.divinePride,
      row.item.links.market ?? "",
    ]);

    download(
      `${state.valuation.character.name}-${stamp(state.valuation.recordedAt)}.csv`,
      toCsv(headers, body),
    );
  };

  const reset = (): void => {
    clear();
    setFilters(DEFAULT_FILTERS);
    // As tendências não precisam ser limpas à mão: sem replay carregado a tabela some, e
    // `useMovers` só busca de novo quando o próximo entra.
  };

  return (
    <section className="page">
      <SummaryHeader
        valuation={state.valuation}
        filteredValue={sumValue(visible)}
        filteredCount={visible.length}
        filteredUnpriced={countUnpriced(visible)}
      />

      <FilterBar
        filters={filters}
        onChange={setFilters}
        availableOrigins={availableOrigins}
        unsellableCount={unsellableCount}
        untradableFailed={catalogue.untradableFailed}
        onExport={exportCsv}
        onClear={reset}
      />

      <ItemsTable
        rows={visible}
        descriptions={catalogue.descriptions}
        isUnsellable={isUnsellable}
        movers={trends}
        onSelect={onSelectItem}
      />

      <SellCandidates
        candidates={state.valuation.sellCandidates}
        descriptions={catalogue.descriptions}
        onSelect={onSelectItem}
      />
    </section>
  );
}
