/**
 * Publica as novidades da versão atual num canal do Discord.
 *
 * Usa a API REST de bot (não webhook), como o projeto irmão latam-ro-calc — assim o
 * post sai com a identidade do bot já conhecido da comunidade em vez de aparecer como
 * um integrador anônimo.
 *
 * A fonte do texto é o topo do CHANGELOG.md: o changelog já precisa existir e estar
 * correto, então mantê-lo como fonte única evita a versão escrita duas vezes e
 * divergindo.
 *
 * Uso:
 *   node tools/post-novidades.mjs            # publica
 *   node tools/post-novidades.mjs --dry-run  # mostra o payload e não envia nada
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const PROJECT_NAME = "Mercado RO LATAM";
const SITE_URL = "https://mercado.latam-tools.com.br";
const EMBED_COLOR = 0x22c55e;
const DISCORD_DESC_LIMIT = 4096;

/**
 * Lê a primeira seção do CHANGELOG.
 *
 * O formato é `## <versão> — <data>` seguido de bullets. Paramos no próximo `## `,
 * que é a versão anterior.
 */
function readChangelogEntry() {
  const lines = readFileSync(resolve(root, "CHANGELOG.md"), "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("## "));
  if (start === -1) return null;

  const header = lines[start].slice(3).trim();
  const [version, date] = header.split(/\s+[—-]\s+/);

  const bullets = [];
  for (const raw of lines.slice(start + 1)) {
    if (raw.startsWith("## ")) break;
    const trimmed = raw.trim();
    if (trimmed === "") continue;

    const isSubBullet = /^\s{2,}-\s/.test(raw);
    if (isSubBullet && bullets.length > 0) {
      // Sub-item vira uma linha recuada dentro do item anterior, em vez de um tópico
      // solto sem contexto.
      bullets[bullets.length - 1] += `\n  ↳ ${trimmed.replace(/^-\s*/, "")}`;
    } else if (trimmed.startsWith("- ")) {
      bullets.push(trimmed.slice(2).trim());
    } else if (bullets.length > 0) {
      // O CHANGELOG quebra linha por largura, então uma linha que não começa item é
      // continuação do anterior. Sem isto, cada tópico chegava ao Discord cortado na
      // primeira quebra.
      bullets[bullets.length - 1] += ` ${trimmed}`;
    }
  }

  return { version: version?.trim() ?? "", date: date?.trim() ?? "", bullets };
}

function buildEmbed({ version, date, bullets }) {
  let description = bullets.map((b) => `• ${b}`).join("\n\n");
  if (description.length > DISCORD_DESC_LIMIT) {
    description = `${description.slice(0, DISCORD_DESC_LIMIT - 1)}…`;
  }
  return {
    title: `${PROJECT_NAME} — ${version}`,
    url: SITE_URL,
    description,
    color: EMBED_COLOR,
    footer: { text: date ? `Publicado em ${date} • mercado.latam-tools.com.br` : "mercado.latam-tools.com.br" },
    timestamp: new Date().toISOString(),
  };
}

const entry = readChangelogEntry();
if (!entry || entry.bullets.length === 0) {
  console.error("CHANGELOG.md sem seção de versão utilizável — nada a publicar.");
  process.exit(1);
}

const payload = { embeds: [buildEmbed(entry)] };

if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;

// Não configurado não é falha: quem clonar o projeto e fizer deploy sem Discord não
// deve ver o pipeline vermelho por causa disso.
if (!token || !channelId) {
  console.warn("DISCORD_BOT_TOKEN/DISCORD_CHANNEL_ID ausentes — post pulado.");
  process.exit(0);
}

const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
  method: "POST",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

// Aqui sim é falha: o token existe, então alguém espera o post sair.
if (!res.ok) {
  console.error(`API do Discord respondeu ${res.status}: ${await res.text()}`);
  process.exit(1);
}

console.log(`Novidades da ${entry.version} publicadas no Discord.`);
