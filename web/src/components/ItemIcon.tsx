import { useState } from "react";

/**
 * Ícone servido pelo ragassets (https://github.com/adsonpleal/ragassets), o mesmo
 * gateway que o simulador usa. É `<img>` puro, então não há CORS envolvido — mas o
 * catálogo tem ids que o gateway não serve, daí o `onError`.
 */
const BASE = "https://assets.latam-tools.com.br/icons/item";

export function ItemIcon({ itemId, size = 24 }: { itemId: number; size?: number }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span className="icon-fallback" style={{ width: size, height: size }} aria-hidden />;
  }

  return (
    <img
      src={`${BASE}/${itemId}.png`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      // Largura e altura fixas: sem elas a tabela pula conforme os ícones chegam.
      className="item-icon"
      onError={() => setFailed(true)}
    />
  );
}
