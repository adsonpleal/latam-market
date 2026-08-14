/**
 * Normalização de nome de item.
 *
 * Todo nome do jogo é pt-BR e cheio de acento (`Poção`, `Espadão`, `Açaí`), mas
 * ninguém digita acento numa busca. Guardamos a forma normalizada numa coluna e
 * comparamos sempre normalizado-contra-normalizado — nunca com LIKE sobre o nome cru.
 */

/** Minúsculo, sem acento, espaços colapsados. */
export function normalizeName(raw: string): string {
  return (
    raw
      .normalize("NFD")
      // \p{M} = marcas combinantes, que é exatamente o que o NFD acabou de separar
      // das letras base. Precisa da flag `u` para a classe Unicode valer.
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Remove o sufixo de slots que o cliente concatena no nome (`Espada [3]`).
 *
 * O site do mercado devolve nomes com esse sufixo, o catálogo não — sem tirar,
 * o mesmo item vira duas entradas na busca.
 */
export function stripSlotSuffix(name: string): string {
  return name.replace(/\s*\[\d+\]\s*$/, "").trim();
}

/**
 * Concorda o texto com o número: "1 loja concorrendo", "3 lojas concorrendo".
 *
 * Recebe as duas formas por inteiro, e não um sufixo, porque em português a concordância
 * pega mais de uma palavra — "carta identificada" vira "cartas identificadas", com dois
 * plurais. É o `+"s"` que não dá conta disso que produz o "(s)" que ninguém quer ler.
 *
 * O `web/` tem a sua própria cópia em `lib/format.ts`: a fronteira entre os dois só deixa
 * passar tipo, e este texto sai formatado do backend antes de chegar lá.
 */
export const plural = (n: number, um: string, muitos: string): string =>
  `${n.toLocaleString("pt-BR")} ${n === 1 ? um : muitos}`;

/**
 * Junta uma lista em prosa: vírgula entre os itens e "e" antes do último.
 *
 * Existe porque um `join(" e ")` só passa por português enquanto a lista tem dois itens.
 * O aviso de preço de `core/replay.ts` chega a quatro — refino, grau, cartas e bônus
 * aleatórios — e saía como "refino +11 e grau C e 2 cartas e 2 bônus", que ninguém
 * escreveria.
 */
export function enumerate(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}
