/**
 * Um relógio fora da página.
 *
 * O navegador estrangula `setTimeout` de aba em segundo plano — depois de alguns minutos
 * oculta, a um disparo por minuto. Para o laço de consultas isso transformaria o espaçamento
 * de 5 s em 60 s, e um ciclo de 15 itens em quinze minutos. Timer de Web Worker não passa
 * por esse estrangulamento, então o laço dorme aqui e acorda com uma mensagem.
 *
 * Não faz rede nenhuma: as consultas continuam saindo da conexão, na aba do mercado.
 */

const timers = new Map<number, ReturnType<typeof setTimeout>>();

// O tsconfig do `web/` tem a lib do DOM, não a de worker: aqui `self` é tipado como janela,
// cujo `postMessage` exige origem. Num worker dedicado ele não recebe origem nenhuma.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; ms?: number; cancel?: boolean }>) => void) | null;
  postMessage(message: number): void;
};

scope.onmessage = (event) => {
  const { id, ms, cancel } = event.data;
  const current = timers.get(id);
  if (current !== undefined) clearTimeout(current);
  timers.delete(id);
  if (cancel) return;
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      scope.postMessage(id);
    }, ms ?? 0),
  );
};
