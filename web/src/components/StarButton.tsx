/**
 * A estrela de favoritar.
 *
 * Lê os favoritos direto do hook, sem receber nada por prop: é para isso que o evento
 * intra-janela do `usePersistent` existe. Uma estrela clicada na busca acende na hora na
 * tabela e no contador da navegação, sem ninguém coordenar.
 */

import { useFavorites } from "../state/useFavorites.js";

export function StarButton({ itemId }: { itemId: number }) {
  const { has, toggle } = useFavorites();
  const on = has(itemId);

  return (
    <button
      type="button"
      className={on ? "star on" : "star"}
      aria-pressed={on}
      title={on ? "Remover dos favoritos" : "Favoritar"}
      aria-label={on ? "Remover dos favoritos" : "Favoritar"}
      onClick={(e) => {
        // A linha e o nome do item têm os próprios cliques (abrir o detalhe, ordenar a
        // coluna). Sem isto, favoritar abriria a gaveta junto.
        e.stopPropagation();
        toggle(itemId);
      }}
    >
      {on ? "★" : "☆"}
    </button>
  );
}
