import { createPortal } from "react-dom";

import { EXTERNAL } from "../lib/links.js";
import { useDismissable } from "../state/useDismissable.js";
import { CopyButton } from "./CopyButton.js";

/**
 * Sempre o endereço de produção, mesmo rodando local.
 *
 * O que a pessoa vai colar no cliente de IA é o servidor público — apontar para
 * `localhost:5173` em desenvolvimento daria uma instrução que não funciona para
 * ninguém, inclusive para quem está desenvolvendo.
 */
const MCP_URL = "https://mercado.latam-tools.com.br/mcp";

const EXAMPLES: { title: string; prompt: string; note: string }[] = [
  {
    title: "Consultar preço",
    prompt: "Quanto custa um Elixir Dourado?",
    note: "Devolve a faixa histórica publicada pelo site e o resumo das lojas abertas agora — que são medidas diferentes e vêm separadas.",
  },
  {
    title: "Decidir um preço de venda",
    prompt: "Vender minha Escama Invertida por 500 mil é bom negócio?",
    note: "Diz quantas lojas estão mais baratas, quanto pedir para ser o mais barato e como isso se compara à média dos últimos dias.",
  },
  {
    title: "Avaliar o inventário",
    prompt: "Toma meu replay: quanto vale tudo que eu tenho? O que dá para vender com lucro?",
    note: "Mande o caminho do .rrf e peça para o agente usar a API — em base64 o arquivo gasta dezenas de milhares de tokens à toa.",
  },
  {
    title: "Caçar oportunidade",
    prompt: "Tem alguma pechincha no mercado agora? E o que subiu de preço essa semana?",
    note: "Varre o mercado inteiro usando o histórico que este projeto acumula — o site oficial não publica série temporal.",
  },
];

export function McpDialog({ onClose }: { onClose: () => void }) {
  useDismissable(onClose);

  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="Conectar uma IA ao mercado">
        <button className="drawer-close" onClick={onClose} aria-label="Fechar">
          ×
        </button>

        <h2 className="modal-title">
          ✨ Conecte uma IA ao mercado
          <span className="badge">experimental</span>
        </h2>

        <p className="lead">
          Este site tem um servidor <b>MCP</b> aberto. Você conecta uma IA (Claude,
          ChatGPT e outras) e ela passa a consultar exatamente os mesmos dados desta
          página — as mesmas coletas, os mesmos preços, a mesma idade de dado.
        </p>

        <div className="mcp-url">
          <code>{MCP_URL}</code>
          <CopyButton value={MCP_URL} label="o endereço do servidor MCP" />
        </div>

        <h3>O que dá para perguntar</h3>
        <div className="mcp-examples">
          {EXAMPLES.map((example) => (
            <div key={example.title} className="mcp-example">
              <strong>{example.title}</strong>
              <p className="mcp-prompt">“{example.prompt}”</p>
              <small>{example.note}</small>
            </div>
          ))}
        </div>

        <h3>Como conectar</h3>

        <details open>
          <summary>Claude</summary>
          <p>
            <b>Claude.ai / Claude Desktop:</b> Configurações → <b>Conectores</b> →{" "}
            <b>Adicionar conector personalizado</b>. Cole o endereço acima e salve. Não
            precisa de login nem de chave.
          </p>
          <p>
            <b>Claude Code</b>, pelo terminal:
          </p>
          <pre>claude mcp add --transport http mercado-ro {MCP_URL}</pre>
        </details>

        <details>
          <summary>ChatGPT</summary>
          <p>
            Conectores personalizados ficam no <b>modo desenvolvedor</b>, hoje em beta e
            disponível nos planos Plus e Pro.
          </p>
          <ol>
            <li>
              Configurações → <b>Conectores</b> → <b>Configurações avançadas</b>.
            </li>
            <li>
              Ative o <b>modo desenvolvedor</b>.
            </li>
            <li>Volte em Conectores e crie um conector personalizado com o endereço acima.</li>
            <li>
              Em autenticação, escolha <b>sem autenticação</b>.
            </li>
          </ol>
        </details>

        <details>
          <summary>Outro cliente com MCP remoto</summary>
          <pre>{`{
  "mcpServers": {
    "mercado-ro": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`}</pre>
        </details>

        <h3>Dúvidas comuns</h3>
        <ul className="mcp-faq">
          <li>
            <b>Precisa pagar ou criar conta?</b> Não. O servidor é público, sem cadastro
            e sem chave de API. Ele só lê dados — não altera nada.
          </li>
          <li>
            <b>Os dados são os mesmos daqui?</b> São. A interface e o MCP chamam a mesma
            camada, e existe um teste que falha se os dois divergirem.
          </li>
          <li>
            <b>O preço está sempre atualizado?</b> As lojas são recoletadas de hora em
            hora. Toda resposta traz a idade do dado — se a IA citar um preço sem dizer
            de quando é, pergunte.
          </li>
          <li>
            <b>Refino e cartas entram na conta?</b> Não. O mercado agrega por id de item,
            então uma arma +9 encantada aparece com o preço da base. As respostas avisam
            quando é o caso.
          </li>
        </ul>

        <p className="mcp-help">
          Deu problema?{" "}
          <a href={EXTERNAL.discord} target="_blank" rel="noreferrer noopener">
            Fale no Discord
          </a>
        </p>
      </div>
    </>,
    document.body,
  );
}
