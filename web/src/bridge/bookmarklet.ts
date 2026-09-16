/**
 * O texto do favorito.
 *
 * A origem vai carimbada no próprio favorito: é ela que a conexão usa para aceitar mensagens,
 * e montá-la a partir de `location.origin` faz o mesmo código servir em produção e no
 * `localhost` do desenvolvimento — cada um gera o seu favorito.
 *
 * `encodeURIComponent` porque o navegador decodifica a URL `javascript:` antes de rodar, e
 * um `%` ou `#` cru no código a quebraria.
 */

import { BRIDGE_VERSION, marketBridge } from "./bridge.js";

export const bookmarkletCode = (origin: string): string =>
  `(${marketBridge.toString()})(${JSON.stringify(origin)},${BRIDGE_VERSION});`;

export const bookmarkletHref = (origin: string): string =>
  `javascript:${encodeURIComponent(bookmarkletCode(origin))}void 0`;
