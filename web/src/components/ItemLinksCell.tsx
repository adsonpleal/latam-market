import type { ItemLinks } from "../api/types.js";

/**
 * Os links já vêm prontos do backend (`core/links.ts`), inclusive com o cuidado de não
 * oferecer link de mercado para nome que o site recusa — daí `market` poder ser null.
 */
export function ItemLinksCell({ links }: { links: ItemLinks }) {
  return (
    <span className="links">
      <a href={links.divinePride} target="_blank" rel="noreferrer" title="Ver no Divine Pride">
        DP
      </a>
      {links.market && (
        <a href={links.market} target="_blank" rel="noreferrer" title="Lojas vendendo agora">
          Lojas
        </a>
      )}
      {links.marketHistory && (
        <a href={links.marketHistory} target="_blank" rel="noreferrer" title="Histórico no site oficial">
          Histórico
        </a>
      )}
    </span>
  );
}
