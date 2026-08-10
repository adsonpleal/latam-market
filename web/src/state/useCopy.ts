import { useEffect, useRef, useState } from "react";

/** Tempo do "copiado!" na tela. */
const FLASH_MS = 1400;

/**
 * Copia um texto para a área de transferência e sinaliza por um instante.
 *
 * Dois componentes precisam do mesmo par copiar/piscar: o botão de ícone
 * (`CopyButton`) e o destino de navegação clicável dentro da descrição
 * (`DescriptionText`). O temporizador e o silêncio no erro ficam num lugar só.
 */
export function useCopy(value: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = (): void => {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), FLASH_MS);
      },
      () => {
        // `navigator.clipboard` exige contexto seguro e permissão. Falhou, o texto
        // continua na tela para copiar à mão — melhor que um alerta no meio da tabela.
      },
    );
  };

  return { copied, copy };
}
