/**
 * O shipper: o que continua rodando no EC2.
 *
 * É a metade da migração que NÃO atravessou. O coletor precisa da saída de rede que só ele
 * administra, e um Cron Trigger não a tem — então ele fica onde está, com um processo
 * mínimo ao lado que o agenda e manda o resultado para o Worker.
 *
 * O que este processo NÃO faz mais, e é o ponto: não abre banco, não serve HTTP, não sobe
 * thread nenhuma. Ele coleta e empurra. Quando o coletor for migrado, este arquivo some e
 * quem chama `/internal/ingest` passa a ser o próprio Worker.
 */

import { applyEnv, config } from "../config.js";
import { startScheduler, type Scheduler } from "./scheduler.js";

applyEnv(process.env);

const url = process.env["INGEST_URL"] ?? `${config.publicUrl}/internal/ingest`;
const secret = process.env["INGEST_SECRET"] ?? "";

if (!secret) {
  // Falha fechado: sem segredo todo POST seria recusado com 401, e o processo ficaria
  // coletando de hora em hora contra o site para jogar tudo fora.
  console.error("[boot] INGEST_SECRET não configurado — nada seria aceito pelo Worker.");
  process.exit(1);
}
if (!config.crawl.enabled) {
  console.error("[boot] CRAWL_ENABLED != 1 — o shipper não tem outra função além de coletar.");
  process.exit(1);
}

console.log(`[boot] shipper apontando para ${new URL(url).origin}`);

const scheduler: Scheduler = startScheduler({ url, secret });

/**
 * Encerramento limpo.
 *
 * Sem banco para fechar, só os timers — e são eles que seguram o event loop (ver o porquê
 * do `unref` ausente em `scheduler.ts`). Por isso a saída precisa ser explícita: o systemd
 * manda SIGTERM e espera, e sem isto uma coleta em curso seguraria a saída até o timeout
 * da unit.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[boot] ${signal} — parando o agendador`);
    scheduler.stop();
    process.exit(0);
  });
}
