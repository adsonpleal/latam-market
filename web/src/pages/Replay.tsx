import { useMemo, useState } from "react";

import type { Server } from "../lib/server.js";
import { Dropzone } from "../components/Dropzone.js";
import { PageTitle } from "../components/PageTitle.js";
import { FilterBar } from "../components/FilterBar.js";
import { ItemsTable } from "../components/ItemsTable.js";
import { SummaryHeader } from "../components/SummaryHeader.js";
import { download, toCsv } from "../lib/csv.js";
import { itemLabel, stamp } from "../lib/format.js";
import { linksFor } from "../lib/market/url.js";
import {
  ALL_ORIGINS,
  applyFilters,
  flatten,
  ORIGIN_LABEL,
  type Filters,
  type Origin,
  type Row,
} from "../lib/rows.js";
import type { Catalogue } from "../state/useCatalogue.js";
import type { ReplayController } from "../state/useReplay.js";

const DEFAULT_FILTERS: Filters = {
  // Os containers não identificados ficam de fora de saída: o decodificador ainda não sabe o
  // que são, e misturá-los com a mochila confundiria mais que ajudaria.
  origins: new Set<Origin>(ALL_ORIGINS.filter((o) => o !== "unidentified")),
  hideUntradable: false,
  search: "",
};

export function ReplayPage({
  catalogue,
  replay,
  onSelectItem,
  server,
}: {
  catalogue: Catalogue;
  /** Mora no App: sair para "Favoritos" e voltar não pode perder o replay carregado. */
  replay: ReplayController;
  onSelectItem: (itemId: number) => void;
  /** Só para os links de lojas: o inventário em si não depende de servidor. */
  server: Server;
}) {
  const { state, upload, clear } = replay;
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);

  const rows = useMemo(() => (state.kind === "loaded" ? flatten(state.inventory) : []), [state]);

  /**
   * "Não dá para vender", em um lugar só: alimenta o filtro, a coluna e o CSV.
   *
   * Vem da descrição do cliente dizer "Intransferível". Até a coleta acabar havia um segundo
   * sinal — o item nunca ter aparecido no mercado —, que pegava casos como o Emblema do
   * Éden; sem coleta não há mais como sabê-lo, e o filtro volta a ser só a descrição.
   */
  const isUnsellable = useMemo(
    () =>
      catalogue.untradableFailed ? () => false : (row: Row) => catalogue.untradable.has(row.item.itemId),
    [catalogue.untradable, catalogue.untradableFailed],
  );

  const visible = useMemo(() => applyFilters(rows, filters, isUnsellable), [rows, filters, isUnsellable]);
  const visibleUnits = useMemo(() => visible.reduce((n, row) => n + row.qty, 0), [visible]);
  const unsellableCount = useMemo(() => rows.filter(isUnsellable).length, [rows, isUnsellable]);
  const availableOrigins = useMemo(
    () => ALL_ORIGINS.filter((origin) => rows.some((row) => row.origin === origin)),
    [rows],
  );

  if (state.kind === "idle" || state.kind === "loading" || state.kind === "error") {
    return (
      <section className="page">
        <PageTitle title="Meu inventário">
          <p>
            Abra um replay do Ragnarok LATAM e veja tudo o que o personagem carrega — mochila,
            carrinho, equipamento e os armazéns que estavam abertos na gravação.
          </p>
          <p>Favorite um item com a estrela para acompanhar o preço dele na aba Favoritos.</p>
        </PageTitle>
        <Dropzone onFile={(file) => void upload(file)} busy={state.kind === "loading"} />
        {state.kind === "error" && <p className="error">{state.message}</p>}
      </section>
    );
  }

  const exportCsv = (): void => {
    const headers = ["id", "item", "origem", "qtd", "refino", "cartas", "vendivel", "divine_pride", "mercado"];
    const body = visible.map((row) => {
      const links = linksFor(row.item.itemId, row.item.name, server);
      return [
        row.item.itemId,
        itemLabel(row.item.name, row.refine, row.item.slots),
        ORIGIN_LABEL[row.origin],
        row.qty,
        row.refine,
        row.cardNames.join(" / "),
        isUnsellable(row) ? "não" : "sim",
        links.divinePride,
        links.market ?? "",
      ];
    });

    download(`${state.inventory.character.name}-${stamp(state.inventory.recordedAt)}.csv`, toCsv(headers, body));
  };

  const reset = (): void => {
    clear();
    setFilters(DEFAULT_FILTERS);
  };

  return (
    <section className="page">
      <SummaryHeader
        inventory={state.inventory}
        filteredCount={visible.length}
        filteredUnits={visibleUnits}
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
        server={server}
        descriptions={catalogue.descriptions}
        isUnsellable={isUnsellable}
        onSelect={onSelectItem}
      />
    </section>
  );
}
