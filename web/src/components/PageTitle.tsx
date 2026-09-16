/**
 * O título de uma aba, com a explicação dela num balão ao lado.
 *
 * A explicação era um parágrafo fixo embaixo do título, e depois da primeira visita ninguém
 * relê — só empurra a tela para baixo. No balão ela continua a um clique para quem chega pela
 * primeira vez, sem ocupar espaço para quem já sabe.
 *
 * Abre no clique, e não no hover: é texto para ler, às vezes com link, e um balão que some
 * quando o ponteiro escorrega não deixa. Fecha no Esc, no clique fora ou no botão de novo.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

interface Props {
  title: string;
  children: ReactNode;
}

export function PageTitle({ title, children }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="page-title" ref={box}>
      <h1>{title}</h1>
      <button
        type="button"
        className={`info-button${open ? " is-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Sobre ${title}`}
        title="Como funciona"
      >
        i
      </button>
      {open && (
        <div className="info-popover" id={id} role="dialog" aria-label={`Sobre ${title}`}>
          {children}
        </div>
      )}
    </div>
  );
}
