import type { DescriptionRun } from "../lib/description.js";
import { useCopy } from "../state/useCopy.js";

interface Props {
  runs: DescriptionRun[];
  /**
   * Os destinos viram botão. Desligado no cartão de hover, que tem
   * `pointer-events: none` e fecha assim que o ponteiro sai da linha: lá o rótulo é só
   * texto, porque um link que não dá para clicar é pior que nenhum.
   */
  clickable?: boolean;
}

/**
 * Os trechos de uma descrição do cliente, com cor e com os destinos de navegação.
 *
 * O painel de detalhe e o cartão de hover renderizavam a mesma lista de trechos cada um
 * do seu jeito; agora renderizam por aqui, e o destino clicável nasceu em um lugar só.
 */
export function DescriptionText({ runs, clickable = false }: Props) {
  return (
    <>
      {runs.map((run, i) =>
        clickable && run.navi ? (
          <NaviLink key={i} command={run.navi} label={run.text} color={run.color} />
        ) : (
          <span key={i} style={run.color ? { color: run.color } : undefined}>
            {run.text}
          </span>
        ),
      )}
    </>
  );
}

/**
 * O destino: clicar copia o `/navi` inteiro, pronto para colar no jogo.
 *
 * Copiar em vez de navegar porque não há para onde navegar — quem move o personagem é o
 * cliente, e ele só entende o comando digitado no chat. O nome interno do mapa
 * (`mal_in01`) não aparece em lugar nenhum da interface do jogo, então é justamente o
 * que ninguém consegue digitar de cabeça.
 */
function NaviLink({ command, label, color }: { command: string; label: string; color?: string }) {
  const { copied, copy } = useCopy(command);

  return (
    <button
      type="button"
      className={`navi${copied ? " navi-done" : ""}`}
      // A cor do cliente sai de cena enquanto pisca o verde do "copiado" — inline
      // ganharia da folha de estilo, e o `!important` para reverter não vale a pena.
      style={color && !copied ? { color } : undefined}
      onClick={copy}
      title={copied ? `Copiado: ${command}` : `Copiar ${command}`}
    >
      {label}
    </button>
  );
}
