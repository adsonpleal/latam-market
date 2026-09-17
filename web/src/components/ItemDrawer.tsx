/**
 * Painel de detalhe de um item: nome, links e a descrição do cliente.
 *
 * Já teve histórico, ofertas abertas e um avaliador de preço — tudo alimentado pela coleta
 * do servidor, que acabou em 2026-09-15. O que sobrou é o que vem do catálogo; o mercado
 * mora nos links para o site oficial, que é quem tem preço de agora e série passada.
 */

import type { Server } from "../lib/server.js";
import { itemLabel } from "../lib/format.js";
import { parseDescription } from "../lib/description.js";
import { useDismissable } from "../state/useDismissable.js";
import { useItemIndex } from "../state/useItemIndex.js";
import { CopyButton } from "./CopyButton.js";
import { DescriptionText } from "./DescriptionText.js";
import { ItemIcon } from "./ItemIcon.js";
import { ItemLinksCell } from "./ItemLinksCell.js";
import { StarButton } from "./StarButton.js";

interface Props {
  itemId: number;
  server: Server;
  description: string | undefined;
  onClose: () => void;
}

export function ItemDrawer({ itemId, server, description, onClose }: Props) {
  useDismissable(onClose);
  const { index } = useItemIndex();
  const brief = index?.get(itemId);
  const missing = index !== null && brief === undefined;

  const label = brief ? itemLabel(brief.name, 0, brief.slots) : `#${itemId}`;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Detalhes do item">
        <button className="drawer-close" onClick={onClose} aria-label="Fechar">
          ×
        </button>

        <header className="drawer-head">
          <ItemIcon itemId={itemId} size={40} />
          <div>
            {/* A estrela é irmã do título, não conteúdo dele: dentro do `h3` ela herdava o
                negrito e a entrelinha do cabeçalho. O botão ao lado copia exatamente o que
                está escrito, slots incluídos. */}
            <div className="drawer-title">
              <StarButton itemId={itemId} />
              <h3>{label}</h3>
              <CopyButton value={label} label="o nome do item" />
            </div>
            {brief && <ItemLinksCell itemId={itemId} name={brief.name} server={server} />}
          </div>
        </header>

        {missing && <p className="error">Este id não existe no catálogo.</p>}

        <p className="note">
          Para ver quem está vendendo agora, abra <strong>Lojas</strong> no site oficial, e{" "}
          <strong>Histórico</strong> para o preço que o site registrou ao longo do tempo — ou
          favorite o item e consulte o preço pela aba Favoritos.
        </p>

        {description && (
          <section>
            <h4>Descrição</h4>
            <p className="description">
              <DescriptionText runs={parseDescription(description)} clickable />
            </p>
          </section>
        )}
      </aside>
    </>
  );
}
