/**
 * Catálogo do cliente, servido como asset estático (ver scripts/build-catalogue.mjs).
 *
 * Os dois arquivos carregam em momentos diferentes de propósito:
 *  - `untradable` (~7 KB) na montagem, porque o filtro vem LIGADO e precisa estar certo
 *    já na primeira pintura;
 *  - `descriptions` (~490 KB comprimido) só quando alguém vai precisar dele, disparado
 *    junto com o upload do replay — a ida e volta do upload cobre o download.
 *
 * Falhar em qualquer um dos dois degrada, não quebra: sem descrição o hover fica mudo,
 * e sem a lista de intransferíveis o filtro é DESLIGADO com um aviso, em vez de trocar
 * de critério calado.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DESCRIPTIONS_URL, UNTRADABLE_URL } from "../generated/catalogue.js";

export interface Catalogue {
  /** Ids que a descrição do cliente marca como intransferíveis. */
  untradable: Set<number>;
  /** Vazio até `loadDescriptions()` terminar. */
  descriptions: Record<string, string>;
  /** A lista de intransferíveis não chegou; quem filtra por ela precisa avisar. */
  untradableFailed: boolean;
  loadDescriptions: () => void;
}

const json = <T,>(url: string): Promise<T> =>
  fetch(url).then((res) => (res.ok ? (res.json() as Promise<T>) : Promise.reject(res.status)));

export function useCatalogue(): Catalogue {
  const [untradable, setUntradable] = useState<Set<number>>(() => new Set());
  const [untradableFailed, setUntradableFailed] = useState(false);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  // Uma requisição só, mesmo com vários chamadores concorrentes.
  const started = useRef(false);

  useEffect(() => {
    let alive = true;
    json<number[]>(UNTRADABLE_URL)
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
    void json<Record<string, string>>(DESCRIPTIONS_URL).then(setDescriptions).catch(() => {});
  }, []);

  // Sem o memo, o objeto novo a cada render de `App` re-dispara os efeitos das páginas
  // que o listam nas dependências — o que fazia `/deals` e `/movers` serem buscados de
  // novo a cada abrir e fechar do painel de item.
  return useMemo(
    () => ({ untradable, descriptions, untradableFailed, loadDescriptions }),
    [untradable, descriptions, untradableFailed, loadDescriptions],
  );
}
