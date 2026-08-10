/**
 * Descrição do cliente: `^RRGGBB` liga uma cor e vale até o próximo código.
 *
 * Portado do projeto irmão (`latam-ro-calc/src/app/utils/pretty-item-desc.ts`) com duas
 * mudanças de propósito:
 *
 *  1. Devolve trechos, não HTML. O irmão monta `<font color>` e joga em `innerHTML`;
 *     aqui o React renderiza `<span style>`, então uma entrada estranha do catálogo não
 *     tem como virar injeção. Não existe `dangerouslySetInnerHTML` neste projeto.
 *  2. Regex apertada. A do irmão é `/\^(.{6})/g` e engole seis caracteres quaisquer
 *     depois de um `^` — um acento circunflexo no meio da frase come o texto seguinte.
 */

export interface DescriptionRun {
  text: string;
  /** `#RRGGBB`, ou undefined para a cor padrão. */
  color?: string;
  /** `/navi mapa x/y` quando o trecho é um destino do cliente (`<NAVI>`). */
  navi?: string;
}

/**
 * Igual ao de `scripts/catalogue-rules.mjs`, mas com grupo de captura: aqui a COR é o
 * dado, e lá os códigos só são apagados.
 *
 * Tentei compartilhar um padrão só entre os dois e não vale a pena — o grupo tem de
 * envolver apenas o hexadecimal, e montar isso a partir de uma fonte comum ficou mais
 * fácil de errar do que manter as duas linhas. Se mexer numa, mexa na outra.
 */
const COLOR_CODE = /\^([0-9a-fA-F]{6})/g;

/** `^000000` é a convenção de "voltar ao normal" e não vira preto forçado. */
const RESET = "000000";

/**
 * Destino de navegação: `<NAVI>[Loja Fashion]<INFO>mal_in01,20,107,0,100,0,0</INFO></NAVI>`.
 *
 * 855 dos 14.379 itens do catálogo trazem pelo menos um. Sem tratamento a marcação
 * inteira aparecia crua na tela.
 */
const NAVI_BLOCK = /<NAVI>([\s\S]*?)<INFO>([\s\S]*?)<\/INFO>\s*<\/NAVI>/g;

/**
 * Mapa e coordenadas dentro do `<INFO>`. Extrai por padrão em vez de fatiar por
 * vírgula porque o catálogo entrega o campo sujo: espaço antes do nome
 * (`<INFO> spl_in01,…`), `.gat` no fim (`alberta.gat,140,170,…`) e até um `<INFO>`
 * repetido (`<INFO><INFO>itemmall,16,75,…`). Os campos seguintes são do cliente e não
 * entram no comando — daí a cauda ser ignorada, e não conferida.
 */
const NAVI_TARGET = /([A-Za-z0-9_@]+?)(?:\.gat)?\s*,\s*(\d+)\s*,\s*(\d+)/;

/** `mal_in01,20,107,0,100,0,0` → `/navi mal_in01 20/107`, o comando do cliente. */
function naviCommand(info: string): string | undefined {
  const target = NAVI_TARGET.exec(info);
  return target ? `/navi ${target[1]} ${target[2]}/${target[3]}` : undefined;
}

export function parseDescription(description: string | undefined): DescriptionRun[] {
  if (!description) return [];

  const runs: DescriptionRun[] = [];
  let color: string | undefined;

  const push = (text: string, navi?: string): void => {
    if (text.length === 0) return;
    runs.push({ text, ...(color !== undefined && { color }), ...(navi !== undefined && { navi }) });
  };

  /** A cor atravessa a fronteira dos trechos: o `^RRGGBB` vale até o próximo código. */
  const pushColored = (chunk: string, navi?: string): void => {
    let cursor = 0;
    for (const match of chunk.matchAll(COLOR_CODE)) {
      push(chunk.slice(cursor, match.index), navi);
      const code = match[1]!.toLowerCase();
      color = code === RESET ? undefined : `#${code}`;
      cursor = match.index + match[0].length;
    }
    push(chunk.slice(cursor), navi);
  };

  let cursor = 0;
  for (const block of description.matchAll(NAVI_BLOCK)) {
    pushColored(description.slice(cursor, block.index));

    /* O rótulo vem com cor dentro (`^4D4DFF[Loja Fashion]^000000`) e às vezes com um
       espaço colado na tag (`[Acampamento] <INFO>`). A cor passa pelo parser normal, para
       o `^000000` do fim continuar fechando o que o `^4D4DFF` abriu; o espaço sai do link,
       senão o sublinhado se estende sobre ele. */
    const label = block[1]!;
    const trailing = /\s*$/.exec(label)![0];
    pushColored(label.slice(0, label.length - trailing.length), naviCommand(block[2]!));
    push(trailing);

    cursor = block.index + block[0].length;
  }
  pushColored(description.slice(cursor));

  return runs;
}

/** Descrição sem código nenhum — para busca em texto e para o CSV. */
export const plainDescription = (description: string | undefined): string =>
  (description ?? "")
    .replace(NAVI_BLOCK, "$1")
    .replace(COLOR_CODE, "")
    .trim();
