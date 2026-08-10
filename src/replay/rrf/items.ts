/**
 * Leitura do container Items (tipo 8) de um replay `.rrf`.
 *
 * Portado de latam-ro-calc (`src/app/replay/rrf/decode.ts`), com uma diferença
 * deliberada: **lá todos os chunks são fundidos num Map único indexado por `pos`**,
 * o que funciona para um simulador de dano (que só quer o equipamento) mas quebra
 * aqui. Inventário e carrinho numeram as posições a partir do zero cada um, então
 * fundir os dois faz um item do carrinho na posição 4 sumir atrás do item do
 * inventário na posição 4 — ou pior, vazar para dentro do inventário quando a
 * posição só existe num dos dois. Aqui cada container é lido separadamente.
 *
 * Os offsets dentro do registro vêm do parser de referência
 * (`Tokeiburu/Rrf-Parser`, `ReplayService.cs:154-184`) e são os mesmos nas duas
 * larguras de registro conhecidas — só o passo muda:
 *
 *   +22  pos      i16   índice do slot, com base -2
 *   +42  equipped i32   bitmask de equipLocation (0 = não equipado)
 *   +52  qty      i16
 *   +82  card[0..3] i32 × 4
 *   +104 nameid   i32
 *   +134 refine   u8
 *   +190 opções aleatórias (só no registro de 221 bytes; TLV tag 0x012d)
 */

import { ContainerType, findContainer, type AnyContainer } from "./containers.js";

export interface RandomOption {
  id: number;
  value: number;
  param: number;
}

export interface ItemRecord {
  /** Índice do slot dentro do próprio container (não é global). */
  slot: number;
  itemId: number;
  qty: number;
  /** Bitmask de equipLocation; 0 quando não está sendo usado. */
  equipped: number;
  refine: number;
  /** Ids de carta/encantamento; zeros já removidos. */
  cards: number[];
  options: RandomOption[];
}

/**
 * De que container cada chunk vem.
 *
 * - 4510: mochila principal.
 * - 4516/4518: carrinho de mercador. Confirmado decodificando um replay com
 *   carrinho carregado — os dois chunks trazem bytes idênticos, então o segundo é
 *   espelho do primeiro e a fusão é first-writer-wins.
 * - 4601: equipamento em uso (elmo, arma, armadura...).
 * - 4603: costume e equipamento sombrio em uso.
 */
const CHUNK_KIND: Record<number, ItemContainerKind> = {
  4510: "inventory",
  4516: "cart",
  4518: "cart",
  4601: "equipped",
  4603: "equipped-costume",
};

/**
 * 4602/4604 são os presets do equip-switch: mesma forma, mas não estão vestidos.
 * 4605/4606 são slots fantasma (qty=0). Nenhum dos quatro descreve o estado atual.
 */
const SKIP_CHUNKS = new Set([4602, 4604, 4605, 4606]);

export type ItemContainerKind = "inventory" | "cart" | "equipped" | "equipped-costume";

export interface ItemContainers {
  inventory: ItemRecord[];
  cart: ItemRecord[];
  equipped: ItemRecord[];
  equippedCostume: ItemRecord[];
  /**
   * Chunks de item que carregavam registros mas cujo significado não conhecemos.
   *
   * Os ids 4511-4515, 4517 e 4519-4522 existem e vêm vazios no replay que serviu de
   * base — provavelmente armazém da Kafra e as abas de aluguel. Guardar em vez de
   * descartar deixa rotular depois sem precisar re-portar nada: basta olhar o que
   * apareceu aqui num replay que tenha aquele container aberto.
   */
  unknown: Record<number, ItemRecord[]>;
}

/** Larguras conhecidas do EQUIPITEM_INFO, mais nova primeiro. */
const RECORD_SIZES = [221, 172] as const;
const NAMEID_OFFSET = 104;
const OPTIONS_OFFSET = 190;
const OPTIONS_TAG = 0x012d;
const MAX_OPTIONS = 5;

/**
 * Descobre o passo dos registros de um chunk.
 *
 * Valida TODOS os registros, não só os primeiros: os chunks de equipamento começam
 * com registros vazios (`nameid` 0) de preenchimento, então checar só o início
 * rejeitaria o passo certo e o chunk inteiro seria pulado — perdendo todo o
 * equipamento vestido. Com o passo correto todo `nameid` lê ou como 0 ou como um id
 * plausível, e ao menos um é item de verdade; com o passo errado a maioria cai em lixo.
 */
function detectRecordSize(view: DataView, byteLength: number): number {
  const plausible = (id: number) => id > 0 && id < 5_000_000;
  for (const size of RECORD_SIZES) {
    if (byteLength < size || byteLength % size !== 0) continue;
    let anyValid = false;
    let ok = true;
    for (let r = 0; r < byteLength / size; r++) {
      const id = view.getInt32(r * size + NAMEID_OFFSET, true);
      if (id === 0) continue;
      if (!plausible(id)) {
        ok = false;
        break;
      }
      anyValid = true;
    }
    if (ok && anyValid) return size;
  }
  return 0;
}

/**
 * Lê as 5 opções aleatórias do registro.
 *
 * Reconfere o tag e o comprimento do campo TLV 6 e 4 bytes antes do valor, para um
 * layout inesperado falhar fechado (lista vazia) em vez de inventar bônus. O
 * registro de 172 bytes termina antes desse campo e cai nesse caminho.
 */
function readOptions(view: DataView, base: number, recordSize: number): RandomOption[] {
  if (recordSize < OPTIONS_OFFSET + MAX_OPTIONS * 5) return [];
  const tag = view.getUint16(base + OPTIONS_OFFSET - 6, true);
  const len = view.getUint32(base + OPTIONS_OFFSET - 4, true);
  if (tag !== OPTIONS_TAG || len !== MAX_OPTIONS * 5) return [];

  const out: RandomOption[] = [];
  for (let i = 0; i < MAX_OPTIONS; i++) {
    const o = base + OPTIONS_OFFSET + i * 5;
    const id = view.getUint16(o, true);
    if (id === 0) continue;
    out.push({ id, value: view.getInt16(o + 2, true), param: view.getUint8(o + 4) });
  }
  return out;
}

function readChunk(data: Uint8Array): ItemRecord[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stride = detectRecordSize(view, data.byteLength);
  if (!stride) return [];

  const bySlot = new Map<number, ItemRecord>();
  for (let p = 0; p + stride <= data.byteLength; p += stride) {
    const slot = view.getInt16(p + 22, true) - 2;
    const qty = view.getInt16(p + 52, true);
    const itemId = view.getInt32(p + 104, true);
    // Registros de preenchimento e slots esvaziados aparecem com nameid ou qty
    // zerados; ambos não descrevem item nenhum.
    if (itemId <= 0 || qty <= 0 || slot < 0) continue;
    // Um mesmo slot pode repetir dentro do chunk (o cliente reescreve o registro
    // quando o item muda). O primeiro é o estado válido.
    if (bySlot.has(slot)) continue;

    bySlot.set(slot, {
      slot,
      itemId,
      qty,
      equipped: view.getInt32(p + 42, true),
      refine: view.getUint8(p + 134),
      cards: [82, 86, 90, 94].map((o) => view.getInt32(p + o, true)).filter((c) => c > 0),
      options: readOptions(view, p, stride),
    });
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}

/** Funde `extra` em `into` sem deixar um slot repetido sobrescrever o anterior. */
function mergeBySlot(into: ItemRecord[], extra: ItemRecord[]): void {
  const seen = new Set(into.map((r) => r.slot));
  for (const rec of extra) {
    if (seen.has(rec.slot)) continue;
    seen.add(rec.slot);
    into.push(rec);
  }
  into.sort((a, b) => a.slot - b.slot);
}

export function readItemContainers(containers: AnyContainer[]): ItemContainers {
  const out: ItemContainers = {
    inventory: [],
    cart: [],
    equipped: [],
    equippedCostume: [],
    unknown: {},
  };

  const itemsContainer = findContainer(containers, ContainerType.Items);
  if (!itemsContainer) return out;

  for (const chunk of itemsContainer.chunks) {
    if (SKIP_CHUNKS.has(chunk.id) || chunk.length === 0) continue;
    const records = readChunk(chunk.data);
    if (records.length === 0) continue;

    switch (CHUNK_KIND[chunk.id]) {
      case "inventory":
        mergeBySlot(out.inventory, records);
        break;
      case "cart":
        mergeBySlot(out.cart, records);
        break;
      case "equipped":
        mergeBySlot(out.equipped, records);
        break;
      case "equipped-costume":
        mergeBySlot(out.equippedCostume, records);
        break;
      default:
        out.unknown[chunk.id] = records;
    }
  }

  return out;
}
