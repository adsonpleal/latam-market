/**
 * Publicação no ntfy.sh, direto do navegador.
 *
 * Nosso servidor não participa: o push sai da máquina da pessoa para o ntfy, então o
 * tópico e a lista de itens vigiados nunca passam pelo EC2, pelo Caddy ou pelos logs.
 * Isso funciona porque o ntfy responde `access-control-allow-origin: *` no preflight —
 * conferido. Como `content-type: application/json` não é um cabeçalho simples, cada
 * publicação custa um `OPTIONS` antes do `POST`; são duas requisições no devtools por
 * design, não um bug.
 *
 * **O corpo é JSON, e não a forma `POST /<tópico>` com o texto cru** que a documentação do
 * ntfy mostra primeiro. Dois motivos, os dois descobertos na prática pelo app irmão:
 *
 *  1. a heurística de binário do ntfy trata corpo UTF-8 multibyte (acento, travessão)
 *     como ANEXO, e a notificação chega como arquivo em vez de texto;
 *  2. o título iria por cabeçalho HTTP, que é Latin-1 — "Poção" chegaria quebrado.
 *
 * O campo `title` do JSON não passa por nenhum dos dois caminhos.
 */

export type NtfyPriority = "default" | "high" | "max";

export interface NtfyMessage {
  title: string;
  body: string;
  priority?: NtfyPriority;
  tags?: string[];
  /** URL que a notificação abre ao ser tocada. */
  click?: string | null;
}

const NTFY_BASE = "https://ntfy.sh";
const PRIORITY: Record<NtfyPriority, number> = { default: 3, high: 4, max: 5 };
const TIMEOUT_MS = 8_000;

/**
 * Manda um push. Devolve se chegou ao ntfy; **nunca lança**.
 *
 * Um `throw` aqui derrubaria o resto do ciclo e os outros alertas ficariam sem aviso por
 * causa de um. Quem chama decide o que fazer com o `false` — o botão "Testar" mostra o
 * erro, o laço segue em frente.
 */
export async function sendNtfy(topic: string, msg: NtfyMessage): Promise<boolean> {
  const t = topic.trim();
  if (t === "") return false;

  try {
    const res = await fetch(`${NTFY_BASE}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: t,
        title: msg.title,
        message: msg.body,
        priority: PRIORITY[msg.priority ?? "default"],
        tags: msg.tags ?? [],
        ...(msg.click ? { click: msg.click } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Sem o tópico na mensagem: ele é a credencial do canal, e log de console é copiado
    // para issue e print sem ninguém pensar duas vezes.
    if (!res.ok) console.warn(`[ntfy] publicação recusada: HTTP ${res.status}`);
    return res.ok;
  } catch {
    console.warn("[ntfy] publicação falhou (rede ou tempo esgotado)");
    return false;
  }
}

/** O push do botão "Testar". */
export const sendNtfyTest = (topic: string): Promise<boolean> =>
  sendNtfy(topic, {
    title: "Mercado RO LATAM — teste",
    body: "Se você está lendo isso no celular, os alertas de preço estão prontos.",
    tags: ["test_tube"],
  });

/**
 * Sugere um tópico difícil de adivinhar.
 *
 * Sem autenticação, **quem souber o nome do tópico pode mandar notificação** para o
 * celular da pessoa. `latam-market-alertas` seria adivinhado na primeira tentativa; com o
 * sufixo aleatório, não.
 */
export const suggestTopic = (): string =>
  `latam-market-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
