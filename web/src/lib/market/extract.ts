/**
 * Tira a lista de anúncios de dentro da página de busca de lojas do site oficial.
 *
 * O site é um app Next.js e não tem API pública: os anúncios chegam embutidos no HTML, no
 * payload que o React usa para hidratar a página. Esse payload vem picado numa sequência de
 * `<script>self.__next_f.push([1,"<pedaço>"])</script>`, cada pedaço um literal de string
 * JavaScript escapado — e um objeto pode começar num pedaço e terminar no seguinte. Por
 * isso os pedaços são desescapados e concatenados antes de qualquer busca.
 *
 * Portado do extrator do coletor, que rodou meses contra o site. Até 2026-09-15 este código
 * era privado; com a coleta encerrada e a consulta rodando no navegador de cada pessoa, ele
 * passou a ser público por decisão.
 */

/** Um anúncio, como o site descreve. Só os campos que este app lê. */
export interface TradingRow {
  itemId: number;
  itemName: string;
  storeName: string;
  itemPrice: number;
  itemCnt: number;
  itemSellerCharName: string;
  /** Id único da vaga na loja (64 bits, chega como string). */
  ssi: string;
}

/**
 * A resposta chegou, mas sem a lista.
 *
 * É a forma de o site falhar sem avisar: HTTP 200, nenhuma linha e nenhum `totalCount`.
 * Tratar isso como "zero anúncios" registraria "ninguém vende" quando a verdade é "esta
 * consulta não funcionou" — e, num alerta de "à venda", rearmaria o aviso à toa.
 */
export class SoftFailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoftFailError";
  }
}

const SIMPLE_ESCAPE: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/**
 * Desescapa o corpo de um literal de string JavaScript.
 *
 * Numa passada de regex, e não caractere a caractere: o payload de uma consulta com mil
 * anúncios passa de 2 MB, e concatenar dois milhões de vezes era o trecho mais caro de cada
 * consulta. O `replace` copia os trechos sem escape de uma vez só, dentro do motor.
 */
function unescapeJsString(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_full, esc: string) => {
    const head = esc[0]!;
    if (head === "u" || head === "x") return String.fromCharCode(parseInt(esc.slice(1), 16));
    // \" \' \\ \/ e o resto: o próprio caractere.
    return SIMPLE_ESCAPE[head] ?? head;
  });
}

/**
 * O índice logo depois da aspa que fecha o literal que começa em `start`, sem montar o
 * valor.
 *
 * É tudo o que `matchBracket` precisa. Montar o valor ali significaria desescapar e alocar
 * milhares de nomes de loja por consulta só para descartá-los no passo seguinte.
 */
function scanStringEnd(src: string, start: number): number {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === quote) return i + 1;
  }
  return -1;
}

/**
 * Lê um literal de string que começa em `start` (a aspa de abertura). Devolve o conteúdo
 * desescapado e o índice logo depois da aspa de fechamento.
 */
function readStringLiteral(src: string, start: number): { value: string; end: number } | null {
  const quote = src[start];
  if (quote !== '"' && quote !== "'") return null;
  const end = scanStringEnd(src, start);
  if (end === -1) return null;
  return { value: unescapeJsString(src.slice(start + 1, end - 1)), end };
}

/**
 * Junta os pedaços do payload num texto só.
 *
 * Um corpo sem nenhum `push` é devolvido como veio: é o formato do payload cru, que o
 * coletor pedia com um cabeçalho próprio e que os testes ainda usam.
 */
export function toFlightText(body: string): string {
  const marker = "self.__next_f.push([1,";
  let idx = body.indexOf(marker);
  // Um corpo sem nenhum `push` é o payload cru. Procurado uma vez só: são megabytes.
  if (idx === -1) return body;

  const chunks: string[] = [];
  while (idx !== -1) {
    const literal = readStringLiteral(body, idx + marker.length);
    if (literal) chunks.push(literal.value);
    idx = body.indexOf(marker, idx + marker.length);
  }
  return chunks.join("");
}

/**
 * Do `{` (ou `[`) em `start` até o fechamento correspondente, pulando literais de string —
 * uma loja chamada "{VENDO}" não pode confundir a contagem.
 */
function matchBracket(src: string, start: number): number {
  const open = src[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"') {
      const end = scanStringEnd(src, i);
      if (end === -1) return -1;
      i = end - 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * As linhas e o total, ou `SoftFailError`.
 *
 * Âncora em `"queryParams":{`, e não em `"list":[`: o pacote de traduções embutido na mesma
 * página tem `"list":"Lista"`. `queryParams` só aparece no componente do resultado, e o
 * objeto inteiro que o contém é analisado de uma vez — assim `list` e `totalCount` saem
 * garantidamente da mesma resposta.
 */
export function extractRows(body: string): { rows: TradingRow[]; totalCount: number } {
  const flight = toFlightText(body);
  const anchor = flight.indexOf('"queryParams":{');
  const objStart = anchor === -1 ? -1 : flight.lastIndexOf("{", anchor - 1);
  const objEnd = objStart === -1 ? -1 : matchBracket(flight, objStart);

  if (objEnd !== -1) {
    try {
      const parsed = JSON.parse(flight.slice(objStart, objEnd + 1)) as {
        list?: unknown;
        totalCount?: unknown;
      };
      if (Array.isArray(parsed.list) && typeof parsed.totalCount === "number") {
        return { rows: parsed.list as TradingRow[], totalCount: parsed.totalCount };
      }
    } catch {
      // Cai no erro abaixo: JSON quebrado é o mesmo "esta consulta não funcionou".
    }
  }
  throw new SoftFailError("a página não trouxe a lista de anúncios");
}
