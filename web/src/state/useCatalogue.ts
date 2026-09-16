/**
 * Catálogo do cliente, servido como asset estático (ver scripts/build-catalogue.mjs).
 *
 * Os dois arquivos carregam em momentos diferentes de propósito:
 *  - `untradable` (~7 KB) na montagem, porque o filtro vem LIGADO e precisa estar certo
 *    já na primeira pintura;
 *  - `descriptions` (~490 KB comprimido) só quando uma tela que mostra hover de item abre
 *    (inventário carregado, busca, favoritos, painel de item) — não na primeira pintura.
 *
 * Falhar em qualquer um dos dois degrada, não quebra: sem descrição o hover fica mudo,
 * e sem a lista de intransferíveis o filtro é DESLIGADO com um aviso, em vez de trocar
 * de critério calado.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DESCRIPTIONS_URL, UNTRADABLE_URL } from "../generated/catalogue.js";
import { fetchJson } from "../lib/catalogue/catalogue.js";

export interface Catalogue {
  /** Ids que a descrição do cliente marca como intransferíveis. */
  untradable: Set<number>;
  /** Vazio até `loadDescriptions()` terminar. */
  descriptions: Record<string, string>;
  /** A lista de intransferíveis não chegou; quem filtra por ela precisa avisar. */
  untradableFailed: boolean;
  loadDescriptions: () => void;
}

export function useCatalogue(): Catalogue {
  const [untradable, setUntradable] = useState<Set<number>>(() => new Set());
  const [untradableFailed, setUntradableFailed] = useState(false);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  // Uma requisição só, mesmo com vários chamadores concorrentes.
  const started = useRef(false);

  useEffect(() => {
    let alive = true;
    fetchJson<number[]>(UNTRADABLE_URL)
      .then((ids) => alive && setUntradable(new Set(ids)))
      .catch(() => alive && setUntradableFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const loadDescriptions = useCallback((): void => {
    if (started.current) return;
    started.current = true;
    // Silencioso no erro: o hover é acessório, e um alerta aqui atrapalharia mais do
    // que ajudaria. `descriptions` fica vazio e o cartão diz que não tem descrição.
    void fetchJson<Record<string, string>>(DESCRIPTIONS_URL).then(setDescriptions).catch(() => {});
  }, []);

  // Sem o memo, o objeto novo a cada render de `App` re-dispara os efeitos das páginas
  // que o listam nas dependências — o que fazia a busca ser refeita de
  // novo a cada abrir e fechar do painel de item.
  return useMemo(
    () => ({ untradable, descriptions, untradableFailed, loadDescriptions }),
    [untradable, descriptions, untradableFailed, loadDescriptions],
  );
}
