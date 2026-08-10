/**
 * Exportação em CSV (RFC 4180).
 *
 * Duas decisões que parecem detalhe e não são:
 *  - **BOM de UTF-8.** Sem ele o Excel em pt-BR abre o arquivo em ANSI e estropia o
 *    acento de todo nome de item ("Poção" vira "PoÃ§Ã£o").
 *  - **Número cru, não formatado.** A tabela mostra "1.234.567z"; aqui vai 1234567,
 *    senão a coluna chega na planilha como texto e não dá para somar.
 */

const BOM = "﻿";

function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escape).join(","), ...rows.map((r) => r.map(escape).join(","))];
  return BOM + lines.join("\r\n") + "\r\n";
}

export function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
