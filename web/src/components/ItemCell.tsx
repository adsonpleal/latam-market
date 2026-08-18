import type { ItemBrief } from "../api/types.js";
import { itemLabel } from "../lib/format.js";
import { CopyButton } from "./CopyButton.js";
import { ItemHover } from "./ItemHover.js";
import { ItemIcon } from "./ItemIcon.js";

/**
 * O mínimo que esta célula lê de um item.
 *
 * Um `ItemBrief` inteiro satisfaz isto, então nada muda para quem já passava um. Mas a aba
 * Favoritos precisa desenhar a linha de um id colado antes de o preço chegar, e com o tipo
 * largo isso exigia forjar `links`/`type`/`inMarket` só para calar o compilador.
 */
export type ItemLabel = Pick<ItemBrief, "itemId" | "name" | "slots">;

interface Props {
  item: ItemLabel;
  descriptions: Record<string, string>;
  onSelect: (itemId: number) => void;
  /** Só o replay conhece refino; nas listas de mercado é sempre 0. */
  refine?: number;
  /** Quando o ícone e o nome ocupam células separadas, peça uma parte de cada vez. */
  part?: "both" | "icon" | "name";
  /**
   * Põe ao lado do nome o botão que copia o rótulo.
   *
   * Mora aqui, e não em quem chama, porque o rótulo é montado aqui: com o botão do lado de
   * fora, a lista remontaria `itemLabel` por conta própria e passaria a copiar algo que não
   * é o que está escrito na tela — o refino, por exemplo, que só o replay conhece.
   *
   * Opcional porque copiar nome não faz sentido em toda lista. Quem quiser, pede.
   */
  copiable?: boolean;
}

/**
 * Ícone com descrição no hover + nome clicável que abre o painel do item.
 *
 * Estava copiado em cinco lugares (as três listas de mercado, a tabela do replay e os
 * candidatos a venda), cada um refazendo a chave `String(itemId)` e, num dos casos,
 * remontando o rótulo à mão em vez de chamar `itemLabel`.
 */
export function ItemCell({
  item,
  descriptions,
  onSelect,
  refine = 0,
  part = "both",
  copiable = false,
}: Props) {
  const label = itemLabel(item.name, refine, item.slots);

  const icon = (
    <ItemHover title={label} description={descriptions[String(item.itemId)]}>
      <ItemIcon itemId={item.itemId} />
    </ItemHover>
  );

  const button = (
    <button className="item-name" onClick={() => onSelect(item.itemId)}>
      {label}
    </button>
  );

  const name = copiable ? (
    <span className="copyable">
      {button}
      <CopyButton value={label} label="o nome do item" />
    </span>
  ) : (
    button
  );

  if (part === "icon") return icon;
  if (part === "name") return name;
  return (
    <>
      {icon}
      {name}
    </>
  );
}
