import { useEffect } from "react";

/**
 * O comportamento comum de tudo que abre por cima da página: fecha no Esc e trava a
 * rolagem de fundo enquanto está aberto.
 *
 * Os dois andam sempre juntos — o painel de item e o diálogo do MCP queriam exatamente
 * o mesmo par, e mantê-lo copiado significava que a compensação da barra de rolagem
 * (a parte fácil de errar) existia em dois lugares.
 */
export function useDismissable(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const { body, documentElement: html } = document;
    const previous = {
      html: html.style.overflow,
      body: body.style.overflow,
      paddingRight: body.style.paddingRight,
    };

    // Esconder a barra devolve a largura dela ao layout e a página inteira salta para a
    // direita. Compensar com um padding do mesmo tamanho evita o tranco.
    const scrollbar = window.innerWidth - html.clientWidth;

    // Nos dois elementos: quem rola a viewport é o `html`, e travar só o `body` depende
    // da regra de propagação de overflow — que deixa de valer se o `html` ganhar um
    // overflow próprio.
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    return () => {
      html.style.overflow = previous.html;
      body.style.overflow = previous.body;
      body.style.paddingRight = previous.paddingRight;
    };
  }, []);
}
