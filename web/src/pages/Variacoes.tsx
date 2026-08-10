import { useState } from "react";

import { topMovers } from "../api/client.js";
import { FreshnessBadge } from "../components/Freshness.js";
import { ItemCell } from "../components/ItemCell.js";
import { ItemLinksCell } from "../components/ItemLinksCell.js";
import { WindowSelect } from "../components/WindowSelect.js";
import { count, zeny } from "../lib/format.js";
import type { Catalogue } from "../state/useCatalogue.js";
import { useApi } from "../state/useApi.js";

export function VariacoesPage({
  catalogue,
  onSelectItem,
  server,
}: {
  catalogue: Catalogue;
  onSelectItem: (itemId: number) => void;
  /** Só entra nas dependências: quem carimba a requisição é o cliente da API. */
  server: string;
}) {
  const [days, setDays] = useState(7);
  const { data, error } = useApi(() => {
    catalogue.loadDescriptions();
    return topMovers(days, 50);
  }, [days, server, catalogue.loadDescriptions]);

  return (
    <section className="page">
      <h1>Quem subiu e quem caiu</h1>
      <p className="lead">
        Variação da mediana das ofertas na janela escolhida. Só entram itens com pelo
        menos três lojas vendendo, para não confundir movimento real com item que uma
        pessoa só anuncia.
      </p>

      <div className="filters">
        {/* 90 dias é o teto do backend (MAX_DAYS em core/movers.ts). */}
        <WindowSelect days={days} onChange={setDays} options={[7, 14, 30, 90]} />
        {data && <FreshnessBadge freshness={data.freshness} />}
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="empty">Carregando…</p>}

      {data && (
        <div className="table-scroll">
          <table className="items">
            <thead>
              <tr>
                <th />
                <th>Item</th>
                <th>Antes</th>
                <th>Agora</th>
                <th>Variação</th>
                <th>Lojas</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {data.movers.map((mover) => (
                <tr key={mover.item.itemId}>
                  <td>
                    <ItemCell
                      item={mover.item}
                      descriptions={catalogue.descriptions}
                      onSelect={onSelectItem}
                      part="icon"
                    />
                  </td>
                  <td>
                    <ItemCell
                      item={mover.item}
                      descriptions={catalogue.descriptions}
                      onSelect={onSelectItem}
                      part="name"
                    />
                  </td>
                  <td>{zeny(mover.before)}</td>
                  <td>{zeny(mover.now)}</td>
                  <td>
                    <span className={mover.changePct > 0 ? "trend up" : "trend down"}>
                      {mover.changePct > 0 ? "↑ +" : "↓ "}
                      {mover.changePct.toFixed(0)}%
                    </span>
                  </td>
                  <td>{count(mover.stores)}</td>
                  <td>
                    <ItemLinksCell links={mover.item.links} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.movers.length === 0 && <p className="empty">Nenhuma variação relevante.</p>}
        </div>
      )}
    </section>
  );
}
