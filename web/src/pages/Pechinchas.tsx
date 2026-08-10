import { useState } from "react";

import { findDeals } from "../api/client.js";
import { FreshnessBadge } from "../components/Freshness.js";
import { ItemCell } from "../components/ItemCell.js";
import { ItemLinksCell } from "../components/ItemLinksCell.js";
import { WindowSelect } from "../components/WindowSelect.js";
import { count, zeny } from "../lib/format.js";
import type { Catalogue } from "../state/useCatalogue.js";
import { useApi } from "../state/useApi.js";

export function PechinchasPage({
  catalogue,
  onSelectItem,
  server,
}: {
  catalogue: Catalogue;
  onSelectItem: (itemId: number) => void;
  /** Só entra nas dependências: quem carimba a requisição é o cliente da API. */
  server: string;
}) {
  const [days, setDays] = useState(14);
  // `loadDescriptions` é estável e ignora chamadas repetidas; só `days` deve refazer a
  // busca. Depender do objeto `catalogue` inteiro refazia a busca a cada render do App.
  const { data, error } = useApi(() => {
    catalogue.loadDescriptions();
    return findDeals(days, 50);
  }, [days, server, catalogue.loadDescriptions]);

  return (
    <section className="page">
      <h1>Pechinchas</h1>
      <p className="lead">
        Itens anunciados hoje bem abaixo do que costumam custar. O "usual" é a mediana
        das medianas diárias da janela — histórico que este projeto mede, e que o site
        oficial não publica.
      </p>

      <div className="filters">
        <WindowSelect days={days} onChange={setDays} options={[7, 14, 30]} />
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
                <th>Preço agora</th>
                <th>Usual</th>
                <th>Desconto</th>
                <th>Lojas</th>
                <th>Vendedor</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {data.deals.map((deal) => (
                <tr key={`${deal.item.itemId}-${deal.seller}`}>
                  <td>
                    <ItemCell
                      item={deal.item}
                      descriptions={catalogue.descriptions}
                      onSelect={onSelectItem}
                      part="icon"
                    />
                  </td>
                  <td>
                    <ItemCell
                      item={deal.item}
                      descriptions={catalogue.descriptions}
                      onSelect={onSelectItem}
                      part="name"
                    />
                  </td>
                  <td>{zeny(deal.price)}</td>
                  <td>{zeny(deal.usual)}</td>
                  <td>
                    <span className="trend down">−{deal.discountPct.toFixed(0)}%</span>
                  </td>
                  <td>{count(deal.stores)}</td>
                  <td>{deal.seller}</td>
                  <td>
                    <ItemLinksCell links={deal.item.links} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.deals.length === 0 && <p className="empty">Nenhuma pechincha nesta janela.</p>}
        </div>
      )}
    </section>
  );
}
