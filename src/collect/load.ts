/**
 * Carrega o coletor, se houver um instalado.
 *
 * O serviço não traz coletor embutido: sem `COLLECTOR_PATH` ele sobe normalmente e serve o
 * histórico que já estiver no banco. É o modo em que um clone deste repositório roda, e é
 * também o que acontece em produção se o coletor falhar em carregar — o histórico responde
 * a maior parte das perguntas, então derrubar o serviço junto seria trocar uma degradação
 * por uma indisponibilidade.
 *
 * O `import()` recebe uma variável, então o esbuild não tenta resolvê-lo em tempo de build:
 * o bundle sai sem nenhuma referência ao coletor, e nem `package.json` nem o lockfile
 * precisam conhecê-lo.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config } from "../server/config.js";
import type { Collector, CollectorModule } from "./port.js";

/**
 * `path` é injetável para os testes poderem carregar um coletor falso; em produção vem do
 * ambiente, como todo o resto da configuração.
 */
export async function loadCollector(path = config.collectorPath): Promise<Collector | null> {
  if (path === "") return null;

  // `import()` recebe um ESPECIFICADOR, não um caminho — e as duas coisas divergem
  // justamente nos casos que se usa. Um caminho relativo seria resolvido em relação a ESTE
  // módulo (`src/collect/` em dev, `dist/` no bundle), não ao diretório de trabalho; e no
  // Windows um caminho absoluto como `C:/…` é lido como uma URL de protocolo "c:". Passar
  // tudo por `resolve` + `pathToFileURL` dá uma regra só, igual à de `store/paths.ts`:
  // relativo ancora no cwd, absoluto passa direto.
  const url = pathToFileURL(resolve(path)).href;

  let mod: Partial<CollectorModule>;
  try {
    mod = (await import(url)) as Partial<CollectorModule>;
  } catch (err) {
    console.error(`[coletor] não carregou (${path}): ${String(err)}`);
    return null;
  }

  // Um módulo que carrega mas não exporta o que deveria é erro de instalação, e é melhor
  // dizer isso do que estourar num `undefined is not a function` na primeira coleta.
  if (typeof mod.createCollector !== "function") {
    console.error(`[coletor] ${path} não exporta createCollector()`);
    return null;
  }

  try {
    const collector = await mod.createCollector();
    console.log(`[coletor] carregado de ${path}`);
    return collector;
  } catch (err) {
    console.error(`[coletor] createCollector() falhou: ${String(err)}`);
    return null;
  }
}
