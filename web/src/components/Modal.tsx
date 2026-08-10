/**
 * A casca de tudo que abre por cima da página.
 *
 * O portal, o fundo clicável, o botão de fechar e o `useDismissable` estavam repetidos em
 * cada diálogo — e com eles o contrato de acessibilidade (`role`, `aria-modal`,
 * `aria-label`), que é justamente o que não deve depender de alguém lembrar.
 *
 * A gaveta de item (`ItemDrawer`) fica de fora de propósito: ela é um painel lateral com
 * layout próprio, não um diálogo centrado, e só compartilha o fundo.
 */

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { useDismissable } from "../state/useDismissable.js";

interface Props {
  /** Lido por leitor de tela ao abrir. */
  label: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ label, onClose, children }: Props) {
  useDismissable(onClose);

  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={label}>
        <button className="drawer-close" onClick={onClose} aria-label="Fechar">
          ×
        </button>
        {children}
      </div>
    </>,
    document.body,
  );
}
