/**
 * Classificação de item: que tipo ele é e em que parte do corpo ele entra.
 *
 * A fonte é a descrição do cliente, que traz duas linhas semi-estruturadas —
 * `Tipo:` e `Equipa em:`. Não é um banco de dados: é texto escrito à mão ao longo de
 * anos, e mostra isso. Medido sobre os 14.379 itens do catálogo LATAM:
 *
 *  - `Tipo:` aparece em 52,6% do catálogo — mas em ~100% do que é equipamento, carta
 *    ou visual. Quem não tem é consumível e "miscellaneous", que não têm subtipo.
 *  - São ~80 grafias distintas para ~40 tipos reais: "Equip. para Cabeça",
 *    "Equipamento para Cabeça", "Equipamento pra cabeça" e até "Equip. para Cabeуa"
 *    (com `у` cirílico). Várias vêm poluídas com o campo seguinte grudado —
 *    "Capa DEF: 18", "Topo Peso: 30" — porque a quebra de linha falhou na origem.
 *  - `Equipa em:` só aparece em 26% do catálogo, e essa é a parte contraintuitiva:
 *    é 98% em equipamento de cabeça, 100% em visual e 96% em carta, mas **0% em
 *    armadura, capa, calçado e acessório**. Nesses, o próprio tipo já é o slot — uma
 *    "Armadura" veste no torso e não há o que desambiguar.
 *
 * Daí o desenho: normaliza a grafia, mapeia por tabela explícita de sinônimos, e
 * quando não há `Equipa em:` deriva o slot do tipo.
 *
 * Roda no build (`scripts/build-catalogue.mjs`), que grava o resultado no asset de itens —
 * a descrição inteira pesa 5 MB e não vale baixar só para classificar. A interface importa
 * daqui só as listas de rótulos, para o filtro da busca.
 */

import { plainDescription } from "../description.js";
import { normalizeName } from "./normalize.js";

/** Um tipo de item, na granularidade que dá para filtrar. */
interface ItemCategory {
  id: string;
  label: string;
  /** Agrupamento para a interface montar um seletor legível. */
  group: string;
}

/** Onde a peça é equipada. Vazio quando não é equipamento. */
interface EquipSlot {
  id: string;
  label: string;
  /**
   * Como o slot aparece depois do travessão numa opção composta ("Visual — capa").
   *
   * É campo, e não um recorte de `label`: derivá-lo cortando na "—" faria um rótulo de
   * exibição virar dado, e trocar "Cabeça — topo" por "Cabeça (topo)" transformaria
   * doze opções do seletor em "Visual — Cabeça (topo)" sem nenhum aviso.
   */
  short: string;
}

export const EQUIP_SLOTS: EquipSlot[] = [
  { id: "topo", label: "Cabeça — topo", short: "topo" },
  { id: "meio", label: "Cabeça — meio", short: "meio" },
  { id: "baixo", label: "Cabeça — baixo", short: "baixo" },
  { id: "armadura", label: "Armadura", short: "armadura" },
  { id: "capa", label: "Capa", short: "capa" },
  { id: "calcado", label: "Calçado", short: "calçado" },
  { id: "acessorio", label: "Acessório", short: "acessório" },
  { id: "arma", label: "Arma", short: "arma" },
  { id: "escudo", label: "Escudo", short: "escudo" },
];

const G_ARMA = "Armas";
const G_EQUIP = "Equipamentos";
const G_OUTRO = "Outros";

export const ITEM_CATEGORIES: ItemCategory[] = [
  { id: "adaga", label: "Adaga", group: G_ARMA },
  { id: "espada", label: "Espada", group: G_ARMA },
  { id: "espada2m", label: "Espada de duas mãos", group: G_ARMA },
  { id: "machado", label: "Machado", group: G_ARMA },
  { id: "machado2m", label: "Machado de duas mãos", group: G_ARMA },
  { id: "lanca", label: "Lança", group: G_ARMA },
  { id: "lanca2m", label: "Lança de duas mãos", group: G_ARMA },
  { id: "maca", label: "Maça", group: G_ARMA },
  { id: "cajado", label: "Cajado", group: G_ARMA },
  { id: "cajado2m", label: "Cajado de duas mãos", group: G_ARMA },
  { id: "arco", label: "Arco", group: G_ARMA },
  { id: "katar", label: "Katar", group: G_ARMA },
  { id: "livro", label: "Livro", group: G_ARMA },
  { id: "chicote", label: "Chicote", group: G_ARMA },
  { id: "instrumento", label: "Instrumento musical", group: G_ARMA },
  { id: "soqueira", label: "Soqueira", group: G_ARMA },
  { id: "shuriken", label: "Shuriken Huuma", group: G_ARMA },
  { id: "pistola", label: "Pistola", group: G_ARMA },
  { id: "rifle", label: "Rifle", group: G_ARMA },
  { id: "espingarda", label: "Espingarda", group: G_ARMA },
  { id: "metralhadora", label: "Metralhadora", group: G_ARMA },
  { id: "granada", label: "Lança-granadas", group: G_ARMA },
  { id: "municao", label: "Munição", group: G_ARMA },

  { id: "cabeca", label: "Equip. para cabeça", group: G_EQUIP },
  { id: "armadura", label: "Armadura", group: G_EQUIP },
  { id: "capa", label: "Capa", group: G_EQUIP },
  { id: "calcado", label: "Calçado", group: G_EQUIP },
  { id: "acessorio", label: "Acessório", group: G_EQUIP },
  { id: "escudo", label: "Escudo", group: G_EQUIP },
  { id: "sombrio", label: "Equip. sombrio", group: G_EQUIP },
  { id: "visual", label: "Visual", group: G_EQUIP },

  { id: "carta", label: "Carta", group: G_OUTRO },
  { id: "consumivel", label: "Consumível", group: G_OUTRO },
  { id: "ovo", label: "Ovo de mascote", group: G_OUTRO },
  { id: "acessorio-mascote", label: "Acessório de mascote", group: G_OUTRO },
  { id: "isca", label: "Isca", group: G_OUTRO },
  { id: "essencia", label: "Essência", group: G_OUTRO },
  { id: "encantamento", label: "Encantamento", group: G_OUTRO },
  { id: "diversos", label: "Diversos", group: G_OUTRO },
];

/**
 * Uma opção de filtro, do jeito que a interface mostra: uma lista só.
 *
 * Tipo e slot são eixos diferentes no catálogo, mas quase todos os slots já têm um tipo
 * de mesmo nome — "Armadura" é os dois — e dois seletores lado a lado com metade das
 * opções repetidas confunde mais do que ajuda.
 *
 * Onde existe um tipo, ele é quem entra: os dois NÃO são sinônimos. `slot=acessorio`
 * pega também as cartas que vão em acessório e o equipamento sombrio do mesmo lugar,
 * enquanto `type=acessorio` traz só os acessórios. Para quem está procurando um item,
 * o tipo é a leitura esperada.
 *
 * Sobram quatro slots sem tipo correspondente, e esses entram como slot: as três
 * posições de cabeça (o tipo "Equip. para cabeça" não distingue topo de meio) e "arma",
 * que é o guarda-chuva de todas as categorias de arma.
 */
export interface FilterOption {
  /** Chave estável para a interface; não é parâmetro de busca. */
  id: string;
  label: string;
  group: string;
  /**
   * Os dois eixos que a busca aceita. Uma opção pode usar um, o outro, ou os dois.
   *
   * `type: null` é "sem tipo na descrição": metade do catálogo, quase tudo consumível e
   * diverso, que o cliente não rotula. Antes eles ganhavam um tipo pelo `db_type` do site do
   * mercado; sem a coleta, o jeito honesto de achá-los é dizer que não têm tipo, e não fingir
   * que são consumíveis.
   */
  type?: string | null;
  slot?: string;
}

const category = (id: string): ItemCategory => {
  const found = ITEM_CATEGORIES.find((c) => c.id === id);
  if (!found) throw new Error(`categoria desconhecida: ${id}`);
  return found;
};

const asType = (id: string): FilterOption => {
  const c = category(id);
  return { id: c.id, label: c.label, group: c.group, type: c.id };
};

/**
 * Um tipo dividido pelas posições que ele realmente ocupa.
 *
 * O tipo sozinho continua na lista, acima das divisões: "Visual" traz os 1.565, e
 * "Visual — topo" traz os 656. As duas perguntas são legítimas.
 */
const splitBySlot = (typeId: string, slots: string[]): FilterOption[] => {
  const c = category(typeId);
  return [
    asType(typeId),
    ...slots.map((slot) => ({
      id: `${typeId}-${slot}`,
      label: `${c.label} — ${EQUIP_SLOTS.find((s) => s.id === slot)!.short}`,
      group: c.group,
      type: typeId,
      slot,
    })),
  ];
};

export const FILTER_OPTIONS: FilterOption[] = [
  { id: "qualquer-arma", label: "Qualquer arma", group: G_ARMA, slot: "arma" },
  ...ITEM_CATEGORIES.filter((c) => c.group === G_ARMA).map((c) => asType(c.id)),

  // As três posições de cabeça, e as mesmas divisões para visual e sombrio — os dois
  // tipos que juntam peças de corpo inteiro sob um nome só.
  ...splitBySlot("cabeca", ["topo", "meio", "baixo"]),
  ...splitBySlot("visual", ["topo", "meio", "baixo", "capa"]),
  ...splitBySlot("sombrio", ["arma", "armadura", "escudo", "calcado", "acessorio"]),
  ...["armadura", "capa", "calcado", "acessorio", "escudo"].map(asType),

  ...ITEM_CATEGORIES.filter((c) => c.group === G_OUTRO).map((c) => asType(c.id)),
  { id: "sem-tipo", label: "Sem tipo na descrição", group: G_OUTRO, type: null },
];

/** O rótulo de cada tipo, para a coluna da busca. */
export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  ITEM_CATEGORIES.map((c) => [c.id, c.label]),
);


/**
 * Grafia crua -> id canônico.
 *
 * Escrito à mão a partir da contagem real de valores distintos no catálogo, incluindo
 * os erros de digitação que aparecem lá. É tabela explícita, e não heurística, porque
 * classificar errado é pior que não classificar: o filtro esconderia o item certo.
 */
const TYPE_ALIASES: Record<string, string> = {
  adaga: "adaga",
  espada: "espada",
  "espada de duas maos": "espada2m",
  "espadade duas maos": "espada2m",
  machado: "machado",
  "machado de duas maos": "machado2m",
  lanca: "lanca",
  "lanca de duas maos": "lanca2m",
  "lanza de dos manos": "lanca2m",
  maca: "maca",
  cajado: "cajado",
  "cajado de duas maos": "cajado2m",
  arco: "arco",
  arcos: "arco",
  katar: "katar",
  livro: "livro",
  chicote: "chicote",
  "chicote musical": "chicote",
  "instrumento musical": "instrumento",
  soqueira: "soqueira",
  "shuriken huuma": "shuriken",
  pistola: "pistola",
  rifle: "rifle",
  espingarda: "espingarda",
  metralhadora: "metralhadora",
  "metralhadora gatling": "metralhadora",
  "lanca-granadas": "granada",
  "lanca-granada": "granada",
  municao: "municao",

  "equip. para cabeca": "cabeca",
  "equip. para cabec": "cabeca",
  "equipamento para cabeca": "cabeca",
  "equipamento para a cabeca": "cabeca",
  "equipamento para a cabeca.": "cabeca",
  "equipamento pra cabeca": "cabeca",
  elmo: "cabeca",
  chapeu: "cabeca",
  mascara: "cabeca",

  armadura: "armadura",
  roupa: "armadura",
  capa: "capa",
  calcado: "calcado",
  acessorio: "acessorio",
  "aces. direito": "acessorio",
  "aces. esquerdo": "acessorio",
  escudo: "escudo",
  "equip. sombrio": "sombrio",
  visual: "visual",
  "7visual": "visual",

  carta: "carta",
  "ovo de mascote": "ovo",
  "ovo de bichinho": "ovo",
  "ovo de bichinho de estimacao": "ovo",
  "acessorio de mascote": "acessorio-mascote",
  isca: "isca",
  essencia: "essencia",
  "encantamento especial": "encantamento",
  "item de treinamento": "diversos",
  "item de domesticacao": "diversos",
};

const SLOT_ALIASES: Record<string, string[]> = {
  topo: ["topo"],
  meio: ["meio"],
  baixo: ["baixo"],
  "topo e meio": ["topo", "meio"],
  "topo e baixo": ["topo", "baixo"],
  "meio e baixo": ["meio", "baixo"],
  "meio baixo": ["meio", "baixo"],
  "topo, meio e baixo": ["topo", "meio", "baixo"],
  capa: ["capa"],
  armadura: ["armadura"],
  calcado: ["calcado"],
  escudo: ["escudo"],
  arma: ["arma"],
  acessorio: ["acessorio"],
  "aces. direito": ["acessorio"],
  "aces. esquerdo": ["acessorio"],
};

/** Tipos cujo próprio nome já diz o slot — os que nunca trazem `Equipa em:`. */
const SLOT_FROM_TYPE: Record<string, string[]> = {
  armadura: ["armadura"],
  capa: ["capa"],
  calcado: ["calcado"],
  acessorio: ["acessorio"],
  escudo: ["escudo"],
  // Toda arma entra no slot de arma — tirada do próprio grupo, para uma categoria nova de arma
  // não precisar ser lembrada aqui também. Munição é do grupo, mas não se empunha.
  ...Object.fromEntries(
    ITEM_CATEGORIES.filter((c) => c.group === G_ARMA && c.id !== "municao").map((c) => [c.id, ["arma"]]),
  ),
};

/**
 * Slot do equipamento sombrio, pela primeira palavra do nome.
 *
 * O conjunto sombrio quase nunca traz `Equipa em:` — só 45 dos 707 itens. Mas o nome
 * sempre diz a peça, e o cruzamento com esses 45 bate 100%: `manopla` sai como Arma
 * nos 9 que declaram, `malha` como Armadura nos 7, `brinco` e `colar` como acessório
 * direito e esquerdo nos 14. Nenhuma contradição, então a derivação cobre os 707.
 */
const SHADOW_SLOT_BY_PREFIX: Record<string, string> = {
  manopla: "arma",
  malha: "armadura",
  armadura: "armadura",
  escudo: "escudo",
  greva: "calcado",
  sapato: "calcado",
  brinco: "acessorio",
  colar: "acessorio",
};


/**
 * Tira acento, caixa e o campo seguinte que veio grudado.
 *
 * O `у` cirílico vira `c` porque existe literalmente um "Equip. para Cabeуa" no
 * catálogo — o caractere é visualmente idêntico ao `ç` renderizado no cliente.
 */
function normalize(raw: string): string {
  // A dobra de acento/caixa é a MESMA de `normalizeName`, a que a busca usa.
  // `resolveItem` usam. Reimplementá-la aqui deixaria o classificador e a busca
  // discordando sobre o mesmo nome no dia em que a regra mudar.
  return normalizeName(raw.replace(/\s*(DEF|Def|Defense|Peso|Weight)\s*:.*$/i, "")).replace(
    /у/g,
    "c",
  );
}

/** Lê uma linha `Campo: valor` da descrição já sem códigos de cor. */
function field(description: string, name: string): string | null {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(description);
  return match?.[1]?.trim() ?? null;
}

interface Classification {
  /** Id de `ITEM_CATEGORIES`, ou null quando nada permite classificar. */
  type: string | null;
  /** Ids de `EQUIP_SLOTS`. Vazio quando não é equipamento. */
  slots: string[];
}

export function classify(name: string, description: string | undefined): Classification {
  const plain = plainDescription(description);

  const rawType = field(plain, "Tipo");
  const type = (rawType ? TYPE_ALIASES[normalize(rawType)] : undefined) ?? null;

  const rawSlot = field(plain, "Equipa em");
  const fromDescription = rawSlot ? SLOT_ALIASES[normalize(rawSlot)] : undefined;

  // O sombrio vem antes da derivação por tipo: `sombrio` é um tipo só para seis peças
  // diferentes, então é o nome que desempata.
  const fromName =
    type === "sombrio"
      ? SHADOW_SLOT_BY_PREFIX[normalize(name).split(" ")[0] ?? ""]
      : undefined;

  // A descrição manda quando existe; o nome resolve o sombrio; o tipo cobre
  // armadura/capa/calçado/acessório, que nunca trazem a linha. Carta fica de fora do
  // derivado: a linha dela diz onde a carta ENTRA, e isso já vem por `Equipa em:`.
  const slots =
    fromDescription ??
    (fromName ? [fromName] : undefined) ??
    (type ? SLOT_FROM_TYPE[type] : undefined) ??
    [];

  return { type, slots };
}
