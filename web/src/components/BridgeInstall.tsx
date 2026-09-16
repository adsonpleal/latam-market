/**
 * Como instalar a conexão: arrastar um link para a barra de favoritos.
 *
 * O React 19 recusa `javascript:` em `href` passado por prop — é uma proteção contra XSS
 * que aqui atrapalha, porque o link É o favorito. Por isso o atributo entra por `ref`,
 * depois da montagem, com um código que esta própria página gerou.
 */

import { useEffect, useMemo, useRef } from "react";

import { bookmarkletCode, bookmarkletHref } from "../bridge/bookmarklet.js";
import { WINDOW_CAP } from "../lib/market/budget.js";
import { useCopy } from "../state/useCopy.js";

export function BridgeInstall() {
  const link = useRef<HTMLAnchorElement>(null);
  const origin = window.location.origin;
  // `Function.prototype.toString` sobre a conexão inteira, a cada render, não: o painel fica
  // aberto por padrão enquanto não há conexão.
  const code = useMemo(() => `javascript:${bookmarkletCode(origin)}`, [origin]);
  const { copied, copy } = useCopy(code);

  useEffect(() => {
    link.current?.setAttribute("href", bookmarkletHref(origin));
  }, [origin]);

  return (
    <div className="bridge-install">
      <p className="transparency">
        <strong>As consultas de preço saem deste computador, com o seu IP</strong>, direto para o
        site oficial do mercado — nada passa pelo nosso servidor. O site limita requisições por
        IP: se ele bloquear (HTTP 429), o mercado também fica indisponível para você no navegador
        por um tempo. Por isso as consultas são espaçadas e limitadas a {WINDOW_CAP} a cada 15
        minutos.
      </p>

      <ol className="help-steps">
        <li>
          Arraste este botão para a barra de favoritos do navegador:{" "}
          <a
            ref={link}
            className="bridge-bookmarklet"
            // Clicar aqui mesmo não faz nada útil — a conexão só roda na aba do mercado.
            onClick={(e) => e.preventDefault()}
            title="Arraste para a barra de favoritos"
          >
            🔗 Conectar latam-market
          </a>
          <br />
          <small>
            Sem barra de favoritos? <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> mostra. No
            celular, crie um favorito qualquer e cole{" "}
            <button className="ghost" onClick={copy}>
              {copied ? "✓ copiado" : "este código"}
            </button>{" "}
            no lugar do endereço.
          </small>
        </li>
        <li>
          Clique em <strong>Abrir aba do mercado</strong>. Ela abre o site oficial numa aba nova.
        </li>
        <li>
          Nessa aba, clique no favorito <strong>Conectar latam-market</strong>. Um selo aparece no canto
          da página do mercado, e aqui o estado muda para <strong>Conectado ao mercado</strong>.
        </li>
      </ol>
      <p className="note">
        Deixe a aba do mercado aberta — pode ficar em segundo plano. Se ela recarregar, clique no
        favorito de novo. No Chrome, a economia de memória pode descarregar abas paradas: em{" "}
        <em>Configurações › Desempenho</em>, adicione <code>ro.gnjoyamericas.com</code> aos sites
        sempre ativos.
      </p>
    </div>
  );
}
