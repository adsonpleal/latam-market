/**
 * Limpar a lista de favoritos, com a opção de manter os que têm alerta.
 *
 * A pergunta existe porque os dois casos são comuns e opostos: quem favoritou meio catálogo
 * pela busca quer começar de novo, mas raramente quer perder os alvos que configurou um a um.
 *
 * "Com alerta" é ter alerta ligado em QUALQUER servidor: o favorito é compartilhado entre FREYA
 * e NIDHOGG, e tirá-lo silenciaria o alerta do outro mercado também.
 *
 * Os alertas em si não são apagados: um item removido que for favoritado de novo volta com o
 * alvo que tinha (ver `planAlerts`, que só avalia o que está nos favoritos).
 */

import { useMemo } from "react";

import { favoritesWithAlert } from "../lib/alerts.js";
import { count, plural } from "../lib/format.js";
import type { AlertsApi } from "../state/useAlerts.js";
import type { FavoritesApi } from "../state/useFavorites.js";
import { Modal } from "./Modal.js";

interface Props {
  favorites: FavoritesApi;
  alerts: AlertsApi;
  onClose: () => void;
}

export function ClearFavoritesModal({ favorites, alerts, onClose }: Props) {
  const withAlert = useMemo(() => favoritesWithAlert(alerts.all, favorites.set), [alerts.all, favorites.set]);

  const total = favorites.ids.length;
  const removable = total - withAlert.size;

  const clear = (keepAlerts: boolean) => {
    favorites.removeAllExcept((id) => keepAlerts && withAlert.has(id));
    onClose();
  };

  return (
    <Modal label="Limpar favoritos" onClose={onClose}>
      <h3>Limpar os favoritos?</h3>
      <p className="lead">
        A lista tem {plural(total, "item", "itens")}
        {withAlert.size > 0 && <>, {count(withAlert.size)} com alerta ligado</>}.
      </p>

      {withAlert.size > 0 && (
        <p className="note">
          Quer manter os itens com alerta? Os outros {count(removable)} saem da lista.
        </p>
      )}
      <p className="note">
        Os alvos dos alertas ficam guardados: se você favoritar um item de novo, o alerta dele volta
        como estava.
      </p>

      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>
          Cancelar
        </button>
        {withAlert.size > 0 && removable > 0 && (
          <button onClick={() => clear(true)}>
            {withAlert.size === 1 ? "Manter o que tem alerta" : `Manter os ${withAlert.size} com alerta`}
          </button>
        )}
        <button className="danger" onClick={() => clear(false)}>
          Remover todos ({count(total)})
        </button>
      </div>
    </Modal>
  );
}
