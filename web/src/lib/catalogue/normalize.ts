/**
 * Minúsculo, sem acento, espaços colapsados.
 *
 * Todo nome do jogo é pt-BR e cheio de acento (`Poção`, `Espadão`), mas ninguém digita acento
 * numa busca. Compara-se sempre normalizado contra normalizado.
 *
 * Módulo à parte, sem dependência nenhuma, porque o script de build do catálogo o importa
 * (pela taxonomia) antes de os arquivos gerados existirem.
 */
export function normalizeName(raw: string): string {
  return (
    raw
      .normalize("NFD")
      // \p{M} = marcas combinantes, exatamente o que o NFD acabou de separar das letras.
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
  );
}
