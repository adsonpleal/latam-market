/**
 * Qual aba toca o laço, quando há mais de uma aberta.
 *
 * Sem isto, três abas do app significam três vezes mais consultas ao site oficial — todas
 * saindo do MESMO IP, gastando a mesma cota (ver `lib/market/budget.ts`) — e até três pushes
 * idênticos no celular. O `lastAlertedPrice` **não** resolve sozinho: duas
 * abas podem ler `null` no mesmo ciclo, as duas concluírem "posso avisar" e as duas
 * avisarem antes de qualquer uma gravar.
 *
 * **A validade do lease é curta e fixa, e NÃO derivada do intervalo de checagem.** Foi a
 * primeira tentativa e estava errada: um ciclo pode ficar uma hora dormindo entre uma volta e
 * a seguinte, então uma validade proporcional a ele significaria que uma aba fechada travaria
 * os alertas de todas as outras por duas horas. A aba dona reafirma o lease a cada tique do
 * laço (15 s, sem tocar a rede) — assim "a dona está viva mas dormindo" deixa de ser
 * indistinguível de "a dona foi embora".
 *
 * `Storage` e `now` entram por parâmetro para isto ser testável sem navegador — e é lógica
 * que merece teste, porque o modo de falhar é "às vezes chega push dobrado", que ninguém
 * reproduz sob demanda.
 */

import { ALERTS_LEASE_KEY, type AlertsLease } from "./persist.js";

/**
 * Depois disto sem reafirmação, o lease é de quem quiser.
 *
 * Folgado o suficiente para sobreviver ao estrangulamento de timer em aba de fundo (cerca de
 * um tique por minuto, contra os 15 s do laço), e curto o suficiente para outra aba assumir
 * em pouco mais de um minuto.
 */
export const LEASE_TTL_MS = 90_000;

type ReadWrite = Pick<Storage, "getItem" | "setItem">;

/**
 * Assume, reafirma ou perde o lease. Grava antes de devolver `true`.
 *
 * Chamado tanto pelo batimento quanto imediatamente antes da requisição do ciclo: ler e
 * escrever no `localStorage` é síncrono, mas o par não é atômico, então quanto menor a
 * distância entre a decisão e a escrita, menor a janela em que duas abas se acham donas.
 */
export function claimLease(store: ReadWrite, tabId: string, now: number): boolean {
  const current = readLease(store);

  if (current !== null && current.tabId !== tabId) {
    const elapsed = now - current.at;
    // `elapsed < 0` é relógio que andou para trás (suspensão da máquina, NTP). Tratar como
    // abandonado: o contrário deixaria uma aba morta trancando os alertas para sempre.
    const abandonado = elapsed < 0 || elapsed > LEASE_TTL_MS;
    if (!abandonado) return false;
  }

  try {
    store.setItem(ALERTS_LEASE_KEY, JSON.stringify({ tabId, at: now } satisfies AlertsLease));
  } catch {
    // Sem storage não há como coordenar. Melhor rodar o laço do que não avisar nada — o
    // risco é push repetido, e no modo privado normalmente há uma aba só.
  }
  return true;
}

/** Conteúdo malformado conta como "não existe", e o lease fica livre. */
function readLease(store: ReadWrite): AlertsLease | null {
  try {
    const raw = store.getItem(ALERTS_LEASE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { tabId, at } = parsed as Record<string, unknown>;
    if (typeof tabId !== "string" || tabId === "") return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    return { tabId, at };
  } catch {
    return null;
  }
}
