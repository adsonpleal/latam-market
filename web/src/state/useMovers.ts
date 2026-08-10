/**
 * As maiores variações da semana, indexadas por id.
 *
 * O truque é o que importa: UMA chamada a `/movers` cruzada por id dá a seta de tendência
 * de qualquer lista, sem varrer o histórico item a item — que no SQLite deste serviço
 * custaria caro. Estava copiado em `Replay` e em `Favoritos`, cada um com a sua janela e o
 * seu limite; agora os dois pedem a mesma coisa.
 *
 * Falha em silêncio de propósito: a seta é cosmética, e uma faixa vermelha por causa dela
 * seria pior que a sua ausência.
 */

import { useEffect, useMemo, useState } from "react";

import { topMovers } from "../api/client.js";
import type { Mover } from "../api/types.js";

/** A mesma janela que a coluna "Variação" anuncia. */
const DAYS = 7;
const LIMIT = 100;

/** `enabled` existe para o inventário não pedir tendência antes de haver um replay na tela. */
export function useMovers(server: string, enabled = true): Map<number, Mover> {
  const [movers, setMovers] = useState<Map<number, Mover>>(() => new Map());

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    topMovers(DAYS, LIMIT)
      .then((r) => {
        if (alive) setMovers(new Map(r.movers.map((m) => [m.item.itemId, m])));
      })
      .catch(() => {
        // Sem as setas a tela continua inteira.
      });
    return () => {
      alive = false;
    };
  }, [server, enabled]);

  return movers;
}

/**
 * Só a variação, por id — que é tudo o que a seta de tendência precisa.
 *
 * As tabelas recebem `Map<number, number>` e não o `Mover` inteiro, então cada tela
 * estreitava o mapa por conta própria com a mesma linha. Pelo mesmo motivo que este
 * módulo existe: a conversão copiada em dois lugares é uma a mais que o necessário.
 */
export function useMoverChanges(server: string, enabled = true): Map<number, number> {
  const movers = useMovers(server, enabled);
  return useMemo(() => new Map([...movers].map(([id, m]) => [id, m.changePct])), [movers]);
}
