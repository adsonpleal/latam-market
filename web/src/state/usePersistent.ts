/**
 * Um valor em `localStorage` que várias partes da árvore leem ao mesmo tempo.
 *
 * A estrela aparece na busca, na gaveta do item e na tabela de favoritos; o contador
 * aparece na navegação; o laço de alertas lê os mesmos dados no `App`. Clicar em uma
 * estrela tem que atualizar todos eles, e ninguém quer passar isso de pai para filho por
 * cinco níveis.
 *
 * Dois eventos, e o segundo é o que não é óbvio:
 *
 *  - `storage`, nativo, sincroniza entre ABAS — de graça, e aqui é requisito: com duas
 *    abas abertas, a que roda o laço grava o `lastAlertedPrice` e a outra precisa ver.
 *  - um evento próprio, para sincronizar dentro da MESMA janela. O `storage` nativo não
 *    dispara na janela que escreveu, então sem isto quem clicou na estrela seria o único
 *    a não ver a mudança.
 *
 * Por que não o padrão de estado de módulo que `api/client.ts` usa para o servidor ativo:
 * lá o consumidor principal não é o React (toda requisição carimba `activeServer`, inclusive
 * fora de componente). Aqui é o oposto — nada fora do React lê isto, e o que se precisa é
 * exatamente re-renderizar vários pontos juntos.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const eventNameOf = (key: string): string => `latam-market:persistido:${key}`;

export interface Persistent<T> {
  value: T;
  /** Aceita valor ou atualizador. O atualizador é obrigatório para escritas em sequência. */
  set: (next: T | ((prev: T) => T)) => void;
}

export function usePersistent<T>(
  key: string,
  fallback: T,
  /** Devolve `null` quando o conteúdo guardado não serve; aí vale o `fallback`. */
  parse: (raw: string | null) => T | null,
): Persistent<T> {
  const [value, setValue] = useState<T>(() => read(key, fallback, parse));

  /**
   * Espelho do valor atual, para `set` poder calcular o próximo SEM usar a forma de
   * atualizador do `setState`.
   *
   * Aqui está a parte que é fácil de errar — e que foi errada uma vez. Gravar no disco e
   * disparar o evento DENTRO do atualizador parece natural, mas o atualizador roda na fase
   * de render: o evento chega síncrono aos outros componentes que usam esta mesma chave, o
   * `setState` deles acontece no meio do render de outro componente, e o React recusa com
   * "Cannot update a component while rendering a different component" — a escrita se perde
   * em silêncio, e a estrela não acende.
   *
   * Com o espelho, `set` é uma função comum: calcula, grava e avisa, tudo fora do render. O
   * `ref` é atualizado na hora, então duas escritas no mesmo tique continuam vendo o
   * resultado da anterior — que era a razão de querer o atualizador.
   *
   * Gravar num `useEffect` sobre o valor, que seria o reflexo seguinte, também não serve:
   * o efeito redisparia o evento a cada leitura vinda de fora, e como `read()` devolve um
   * objeto novo toda vez, as abas ficariam se avisando em círculo.
   */
  const valueRef = useRef(value);

  // Ouve as duas pontas: outra aba (`storage`) e outro componente desta janela.
  useEffect(() => {
    const adopt = (next: T) => {
      valueRef.current = next;
      setValue(next);
    };
    const reread = () => adopt(read(key, fallback, parse));
    /**
     * O evento da própria janela carrega o valor já pronto.
     *
     * Sem o `detail`, cada instância do hook reabria o `localStorage` e reanalisava o mesmo
     * JSON — e são muitas: `StarButton` chama `useFavorites` uma vez por linha da busca,
     * que pagina de cinquenta em cinquenta. Uma estrela clicada custava dezenas de
     * `JSON.parse`, e cada instância recebia um objeto diferente do mesmo conteúdo, o que
     * fazia todas re-renderizarem. Com o valor no evento é uma referência só para todas.
     */
    const onLocal = (e: Event) => {
      const { detail } = e as CustomEvent<T>;
      if (detail === undefined) reread();
      else adopt(detail);
    };
    const onStorage = (e: StorageEvent) => {
      // `key === null` é o `localStorage.clear()` de outra aba.
      if (e.key === key || e.key === null) reread();
    };
    const eventName = eventNameOf(key);
    window.addEventListener("storage", onStorage);
    window.addEventListener(eventName, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(eventName, onLocal);
    };
    // `fallback` e `parse` são constantes de módulo em todos os usos; entrar aqui só
    // faria o efeito remontar a cada render de quem passasse um literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = valueRef.current;
      const computed = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      // Escrita idempotente não re-renderiza nem toca o disco. Não é luxo: um ciclo do
      // laço aplica vários patches e a maioria não muda nada.
      if (Object.is(computed, prev)) return;

      valueRef.current = computed;
      setValue(computed);
      try {
        localStorage.setItem(key, JSON.stringify(computed));
        // Depois de gravar, para quem ouvir por `storage` (outra aba) achar o valor novo.
        // O `detail` poupa as instâncias desta janela de reler e reanalisar.
        window.dispatchEvent(new CustomEvent(eventNameOf(key), { detail: computed }));
      } catch {
        // Modo privado ou cota cheia: o valor vale só para esta aba.
      }
    },
    [key],
  );

  return { value, set };
}

function read<T>(key: string, fallback: T, parse: (raw: string | null) => T | null): T {
  try {
    return parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    // Modo privado sem storage: a preferência só não sobrevive à aba.
    return fallback;
  }
}
