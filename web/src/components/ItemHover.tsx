/**
 * Cartão de descrição no hover, como no simulador irmão.
 *
 * Vai por `createPortal` no `body` porque o container rolável da tabela recorta
 * qualquer filho posicionado, e o cartão é maior que a linha. A posição sai do
 * `getBoundingClientRect()` do gatilho e é presa ao viewport nos dois eixos — o irmão
 * precisou de uma diretiva inteira (`tooltip-clamp.directive.ts`) para consertar isso
 * no PrimeNG, que não prende.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { parseDescription } from "../lib/description.js";
import { DescriptionText } from "./DescriptionText.js";

const SHOW_DELAY_MS = 350;
const MARGIN = 8;

interface Props {
  title: string;
  description: string | undefined;
  children: ReactNode;
}

export function ItemHover({ title, description, children }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const anchor = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = (): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  };
  const hide = (): void => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (!open || !anchor.current || !card.current) return;
    const trigger = anchor.current.getBoundingClientRect();
    const box = card.current.getBoundingClientRect();

    // Abre à direita; se não couber, à esquerda. Depois prende nos dois eixos.
    let left = trigger.right + MARGIN;
    if (left + box.width > window.innerWidth - MARGIN) left = trigger.left - box.width - MARGIN;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - box.width - MARGIN));

    const top = Math.max(
      MARGIN,
      Math.min(trigger.top, window.innerHeight - box.height - MARGIN),
    );

    setPos({ left, top });
  }, [open, description]);

  // Só quando o cartão está aberto: fora do `open` isto rodava a cada render de cada
  // linha da tabela, parseando centenas de descrições cujo resultado ia para o lixo.
  const runs = open ? parseDescription(description) : [];

  return (
    <>
      <span
        ref={anchor}
        className="hover-anchor"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        tabIndex={0}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div ref={card} className="hover-card" style={{ left: pos.left, top: pos.top }} role="tooltip">
            <div className="hover-card-title">{title}</div>
            {runs.length > 0 ? (
              <div className="hover-card-body">
                <DescriptionText runs={runs} />
              </div>
            ) : (
              <div className="hover-card-empty">Descrição indisponível.</div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
