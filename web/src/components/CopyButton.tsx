import { useCopy } from "../state/useCopy.js";

/**
 * Copia um texto para a área de transferência.
 *
 * Serve para o que a pessoa vai colar dentro do jogo — nome de vendedor para procurar,
 * comando de navegação para o mapa. Digitar à mão erra acento e espaço, e nome de
 * personagem em Ragnarok tem os dois com frequência.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useCopy(value);

  return (
    <button
      type="button"
      className={`copy${copied ? " copy-done" : ""}`}
      onClick={copy}
      title={copied ? "Copiado!" : `Copiar ${label}`}
      aria-label={copied ? "Copiado" : `Copiar ${label}`}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}
