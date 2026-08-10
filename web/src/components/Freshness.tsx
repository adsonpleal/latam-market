import type { Freshness } from "../api/types.js";
import { ago } from "../lib/format.js";

/**
 * Idade do dado, sempre visível.
 *
 * O projeto trata frescor como conceito de primeira classe — toda resposta com preço
 * carrega `{marketAt, tradingAt, tradingAgeMin}`. Mostrar preço sem mostrar a idade
 * contradiz isso, então este selo acompanha toda tela que exibe número.
 */
export function FreshnessBadge({ freshness }: { freshness: Freshness }) {
  const stale = freshness.tradingAgeMin !== null && freshness.tradingAgeMin > 180;

  return (
    <span className={`freshness${stale ? " freshness-stale" : ""}`}>
      <span className="dot" aria-hidden />
      Lojas coletadas {ago(freshness.tradingAt)}
      {freshness.marketAt !== null && ` · histórico ${ago(freshness.marketAt)}`}
    </span>
  );
}
