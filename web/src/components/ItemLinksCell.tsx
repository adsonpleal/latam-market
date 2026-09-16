import type { Server } from "../lib/server.js";
import { linksFor } from "../lib/market/url.js";

/**
 * Divine Pride e a busca de lojas no site oficial.
 *
 * Montados aqui a partir do nome, com o cuidado de não oferecer link de mercado para nome
 * que o site recusa — daí `market` poder faltar (ver `lib/market/url.ts`).
 */
export function ItemLinksCell({ itemId, name, server }: { itemId: number; name: string; server: Server }) {
  const links = linksFor(itemId, name, server);
  return (
    <span className="links">
      <a href={links.divinePride} target="_blank" rel="noreferrer" title="Ver no Divine Pride">
        DP
      </a>
      {links.market && (
        <a href={links.market} target="_blank" rel="noreferrer" title="Lojas vendendo agora, no site oficial">
          Lojas
        </a>
      )}
    </span>
  );
}
