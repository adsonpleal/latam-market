/**
 * Painel de detalhe de um item: histórico, ofertas abertas e o avaliador.
 *
 * Os três endpoints já existiam e não tinham consumidor nenhum. O avaliador devolve o
 * veredito e um `summary` já redigido em pt-BR pelo backend — a interface mostra o
 * texto dele em vez de reescrever a regra aqui e arriscar divergir.
 */

import { useEffect, useState } from "react";

import { appraise, itemHistory, itemOffers, itemPrice, messageOf } from "../api/client.js";
import type { AppraiseResponse } from "../api/types.js";
import { count, zeny } from "../lib/format.js";
import { parseDescription } from "../lib/description.js";
import { useApi } from "../state/useApi.js";
import { useDismissable } from "../state/useDismissable.js";
import { CopyButton } from "./CopyButton.js";
import { DescriptionText } from "./DescriptionText.js";
import { FreshnessBadge } from "./Freshness.js";
import { ItemIcon } from "./ItemIcon.js";
import { ItemLinksCell } from "./ItemLinksCell.js";
import { PriceChart } from "./PriceChart.js";
import { StarButton } from "./StarButton.js";

interface Props {
  itemId: number;
  description: string | undefined;
  onClose: () => void;
}

export function ItemDrawer({ itemId, description, onClose }: Props) {
  useDismissable(onClose);

  // Os três chegam juntos e são zerados juntos a cada item — um estado só, e o
  // `useApi` já cuida do cancelamento quando a pessoa pula para outro item.
  const { data, error } = useApi(
    () =>
      Promise.all([itemPrice(itemId, 5), itemHistory(itemId, 30), itemOffers(itemId, 20)]).then(
        ([price, history, offers]) => ({ price, history, offers }),
      ),
    [itemId],
  );

  const [askInput, setAskInput] = useState("");
  const [verdict, setVerdict] = useState<AppraiseResponse | null>(null);
  const [appraising, setAppraising] = useState(false);
  const [appraiseError, setAppraiseError] = useState<string | null>(null);

  // Trocar de item invalida a avaliação do anterior.
  useEffect(() => {
    setVerdict(null);
    setAskInput("");
    setAppraiseError(null);
  }, [itemId]);

  const runAppraise = async (): Promise<void> => {
    const value = Number(askInput.replace(/\D/g, ""));
    if (!Number.isFinite(value) || value <= 0) return;
    setAppraising(true);
    setAppraiseError(null);
    try {
      setVerdict(await appraise(itemId, value));
    } catch (err) {
      setAppraiseError(messageOf(err, "Falha ao avaliar o preço."));
    } finally {
      setAppraising(false);
    }
  };

  const { price, history, offers } = data ?? {};

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Detalhes do item">
        <button className="drawer-close" onClick={onClose} aria-label="Fechar">
          ×
        </button>

        {error && <p className="error">{error}</p>}
        {!data && !error && <p className="empty">Carregando…</p>}

        {price && (
          <>
            <header className="drawer-head">
              <ItemIcon itemId={itemId} size={40} />
              <div>
                {/* A estrela é irmã do título, não conteúdo dele: dentro do `h3` ela herdava
                    o negrito e a entrelinha do cabeçalho e saía com outro tamanho e fora do
                    eixo. Aqui é o mesmo componente e o mesmo desenho da lista de busca.

                    Só favoritar. O alvo do alerta se configura na aba Favoritos, para o
                    modal não ter dois lugares de onde abrir. */}
                <div className="drawer-title">
                  <StarButton itemId={itemId} />
                  <h3>{price.name}</h3>
                </div>
                <ItemLinksCell links={price.links} />
              </div>
            </header>

            <FreshnessBadge freshness={price.freshness} />

            <section>
              <h4>Agora, nas lojas abertas</h4>
              {price.offers ? (
                <dl className="stats">
                  <Stat label="Menor" value={zeny(price.offers.min)} />
                  <Stat label="Mediana" value={zeny(price.offers.median)} />
                  <Stat label="Maior" value={zeny(price.offers.max)} />
                  <Stat label="Lojas" value={count(price.offers.stores)} />
                  <Stat label="Unidades" value={count(price.offers.units)} />
                </dl>
              ) : (
                <p className="empty">Ninguém vendendo agora.</p>
              )}
            </section>

            <section>
              <h4>Histórico publicado pelo site</h4>
              {price.market ? (
                <dl className="stats">
                  <Stat label="Média" value={zeny(price.market.avg)} />
                  <Stat label="Mínimo" value={zeny(price.market.min)} />
                  <Stat label="Máximo" value={zeny(price.market.max)} />
                  <Stat label="Já vendidos" value={count(price.market.totalSold)} />
                </dl>
              ) : (
                <p className="empty">O site nunca publicou venda deste item.</p>
              )}
            </section>

            <section>
              <h4>Por quanto devo vender?</h4>
              <div className="appraise">
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Preço pretendido"
                  value={askInput}
                  onChange={(e) => setAskInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void runAppraise()}
                />
                <button onClick={() => void runAppraise()} disabled={appraising || askInput === ""}>
                  Avaliar
                </button>
              </div>
              {appraiseError && <p className="error">{appraiseError}</p>}
              {verdict && (
                <p className={`verdict verdict-${verdict.verdict}`}>{verdict.summary}</p>
              )}
            </section>

            {history && (
              <section>
                <h4>Últimos 30 dias</h4>
                <PriceChart points={history.points} />
              </section>
            )}

            {offers && offers.offers.length > 0 && (
              <section>
                <h4>Lojas mais baratas</h4>
                <table className="offers">
                  <thead>
                    <tr>
                      <th>Preço</th>
                      <th>Qtd</th>
                      <th>Vendedor</th>
                      <th>Loja</th>
                    </tr>
                  </thead>
                  <tbody>
                    {offers.offers.map((offer, i) => (
                      <tr key={`${offer.seller}-${offer.price}-${i}`}>
                        <td>{zeny(offer.price)}</td>
                        <td>{count(offer.qty)}</td>
                        <td>
                          <span className="copyable">
                            {offer.seller}
                            <CopyButton value={offer.seller} label="o nome do vendedor" />
                          </span>
                        </td>
                        <td>{offer.store}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {description && (
              <section>
                <h4>Descrição</h4>
                <p className="description">
                  <DescriptionText runs={parseDescription(description)} clickable />
                </p>
              </section>
            )}
          </>
        )}
      </aside>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
