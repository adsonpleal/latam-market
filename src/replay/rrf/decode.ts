/**
 * Decodificação de um replay `.rrf`, no recorte que este projeto precisa:
 * quem gravou, quando, e o que havia no inventário, no carrinho e vestido.
 *
 * O parser completo (dano, perícias, entidades, status, chat) vive no projeto irmão
 * latam-ro-calc e não foi portado — aqui seria código morto. O que foi portado são as
 * camadas de bytes (`header`, `crypt`, `containers`, `reader`), sem alteração.
 *
 * **O retrato é do início da gravação.** O container de itens é uma fotografia tirada
 * quando o replay começou; itens pegos ou consumidos durante a gravação chegam como
 * pacotes no stream e não são aplicados aqui. Na prática isso não atrapalha, porque
 * um replay gravado para conferir inventário dura segundos — mas é a razão de o campo
 * se chamar `recordedAt` e de a API devolver esse carimbo junto com os itens.
 */

import {
  ContainerType,
  findContainer,
  readContainers,
  type AnyContainer,
  type GenericContainer,
} from "./containers.js";
import { deriveKeys } from "./crypt.js";
import { readHeader } from "./header.js";
import { readItemContainers, type ItemContainers } from "./items.js";
import { readKoreanZ } from "./reader.js";

export interface ReplayCharacter {
  name: string;
  map: string;
  accountId: number;
  job: number;
  baseLevel: number;
  jobLevel: number;
}

export interface DecodedReplay {
  /** Momento da gravação, em epoch de segundos (o header guarda hora local). */
  recordedAt: number;
  character: ReplayCharacter;
  items: ItemContainers;
}

export function decodeReplay(buf: ArrayBuffer): DecodedReplay {
  const header = readHeader(buf);
  const keys = deriveKeys(header.recordedAt);
  const containers = readContainers(buf, header.containerTableOffset, keys);

  const r = header.recordedAt;
  // O header grava a hora local de quem gravou, sem fuso. Construir a data como
  // local e converter para epoch é o mais próximo da verdade que dá para chegar.
  const recordedAt = Math.floor(
    new Date(r.year, r.month - 1, r.day, r.hour, r.minute, r.second).getTime() / 1000,
  );

  return {
    recordedAt,
    character: readCharacter(containers),
    items: readItemContainers(containers),
  };
}

function readU32Chunk(container: GenericContainer | undefined, chunkId: number): number {
  const chunk = container?.chunks.find((c) => c.id === chunkId);
  if (!chunk || chunk.data.byteLength < 4) return 0;
  return new DataView(chunk.data.buffer, chunk.data.byteOffset, 4).getUint32(0, true);
}

function readCharacter(containers: AnyContainer[]): ReplayCharacter {
  const replayData = findContainer(containers, ContainerType.ReplayData);
  const session = findContainer(containers, ContainerType.Session);

  // Os chunks do ReplayData são posicionais, não têm id semântico: o de índice 4 é o
  // nome do personagem e o 5 é o mapa.
  const chunks = replayData?.chunks ?? [];
  const name = chunks.length > 4 ? readKoreanZ(chunks[4]!.data) : "";
  const map = chunks.length > 5 ? readKoreanZ(chunks[5]!.data) : "";

  return {
    name,
    map,
    accountId: readU32Chunk(session, 1010),
    job: readU32Chunk(session, 1014),
    baseLevel: readU32Chunk(session, 1016),
    jobLevel: readU32Chunk(session, 1019),
  };
}
