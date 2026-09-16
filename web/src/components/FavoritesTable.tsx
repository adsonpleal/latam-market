/**
 * A tabela dos favoritos.
 *
 * Cada linha mostra a última consulta que a conexão fez ao site oficial — de quando ela é está
 * escrito na coluna "Consultado", porque o preço não se atualiza sozinho: só itens com
 * alerta entram no ciclo, e os outros esperam o botão "Consultar".
 *
 * "Falta" é a coluna que justifica a aba: diz o quanto ainda precisa andar para o alvo, e
 * ordenar por ela põe no topo o que está quase disparando.
 */

import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import type { Server } from "../lib/server.js";
import { describeAlert, gapToTarget, usesTarget } from "../lib/alerts.js";
import { Trend, missingLast, orUndefined } from "../lib/columns.js";
import { agoMs, count, zeny } from "../lib/format.js";
import type { MarketCheck } from "../lib/market/checks.js";
import { FAVORITES_COLUMNS_KEY, type Alert } from "../lib/persist.js";
import { useColumnVisibility } from "../state/useColumnVisibility.js";
import { useNow } from "../state/useNow.js";
import { CopyButton } from "./CopyButton.js";
import { DataTable } from "./DataTable.js";
import { ItemCell, type ItemLabel } from "./ItemCell.js";
import { ItemLinksCell } from "./ItemLinksCell.js";
import { StarButton } from "./StarButton.js";

export interface FavoriteRow {
  item: ItemLabel;
  /** A última consulta neste servidor; indefinida enquanto nunca foi consultado. */
  check: MarketCheck | undefined;
  alert: Alert | undefined;
  /** Na fila ou sendo consultado agora. */
  pending: "queued" | "current" | null;
}

const helper = createColumnHelper<FavoriteRow>();

const DEFAULT_HIDDEN: VisibilityState = { units: false, seller: false };

interface Props {
  rows: FavoriteRow[];
  server: Server;
  descriptions: Record<string, string>;
  onSelect: (itemId: number) => void;
  onEditAlert: (itemId: number) => void;
  onCheck: (itemId: number) => void;
  /** A conexão está pronta e sem pausa: sem isso, "Consultar" só enfileiraria. */
  canCheck: boolean;
}

export function FavoritesTable({ rows, server, descriptions, onSelect, onEditAlert, onCheck, canCheck }: Props) {
  // Abre pelo que está mais perto de disparar — a pergunta que traz a pessoa aqui.
  const [sorting, setSorting] = useState<SortingState>([{ id: "gap", desc: false }]);
  const [visibility, setVisibility] = useColumnVisibility(FAVORITES_COLUMNS_KEY, DEFAULT_HIDDEN);

  const columns = useMemo(
    () => buildColumns({ server, descriptions, onSelect, onEditAlert, onCheck, canCheck }),
    [server, descriptions, onSelect, onEditAlert, onCheck, canCheck],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnVisibility: visibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => String(row.item.itemId),
  });

  return <DataTable table={table} />;
}

// `any` no segundo parâmetro é o que a própria TanStack recomenda para uma lista com
// colunas de tipos de valor diferentes.
function buildColumns(ctx: {
  server: Server;
  descriptions: Record<string, string>;
  onSelect: (itemId: number) => void;
  onEditAlert: (itemId: number) => void;
  onCheck: (itemId: number) => void;
  canCheck: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): ColumnDef<FavoriteRow, any>[] {
  const { server, descriptions, onSelect, onEditAlert, onCheck, canCheck } = ctx;

  return [
    helper.display({
      id: "estrela",
      header: "",
      cell: ({ row }) => <StarButton itemId={row.original.item.itemId} />,
    }),
    helper.display({
      id: "ícone",
      header: "",
      cell: ({ row }) => (
        <ItemCell item={row.original.item} descriptions={descriptions} onSelect={onSelect} part="icon" />
      ),
    }),
    helper.accessor((row) => row.item.name, {
      id: "name",
      header: "Item",
      cell: ({ row }) => (
        <ItemCell item={row.original.item} descriptions={descriptions} onSelect={onSelect} part="name" />
      ),
    }),

    // --- o alerta ---------------------------------------------------------
    // O aviso de "à venda" ordena como alvo zero — é o "a qualquer preço" — e não pelo alvo
    // antigo que ele guarda sem usar.
    helper.accessor(
      (row) => orUndefined(row.alert && !usesTarget(row.alert.direction) ? 0 : row.alert?.targetPrice),
      {
        id: "alert",
        header: "Alerta",
        ...missingLast,
        cell: ({ row }) => <AlertCell row={row.original} onEdit={onEditAlert} />,
      },
    ),
    // Negativo é "já passou do alvo", que é a boa notícia — daí `good: "down"`.
    helper.accessor((row) => orUndefined(gapToTarget(row.alert, row.check?.min)), {
      id: "gap",
      header: "Falta",
      ...missingLast,
      cell: (info) => <Trend value={info.getValue()} good="down" />,
    }),

    // --- a última consulta ------------------------------------------------
    helper.accessor((row) => orUndefined(row.check?.min), {
      id: "now",
      header: "Mais barato",
      ...missingLast,
      cell: ({ row }) => <PriceCell check={row.original.check} />,
    }),
    floorCol("stores", "Lojas", (check) => check.stores),
    floorCol("units", "Un. à venda", (check) => check.units),
    helper.accessor((row) => row.check?.seller ?? "", {
      id: "seller",
      header: "Vendedor",
      cell: ({ row }) => {
        const seller = row.original.check?.seller;
        if (!seller) return "—";
        return (
          <span className="copyable">
            {seller}
            <CopyButton value={seller} label="o nome do vendedor" />
          </span>
        );
      },
    }),
    helper.accessor((row) => orUndefined(row.check?.at), {
      id: "checkedAt",
      header: "Consultado",
      ...missingLast,
      cell: ({ row }) => <CheckedCell row={row.original} onCheck={onCheck} canCheck={canCheck} />,
    }),

    helper.display({
      id: "links",
      header: "Links",
      cell: ({ row }) => (
        <ItemLinksCell itemId={row.original.item.itemId} name={row.original.item.name} server={server} />
      ),
    }),
  ];
}

/**
 * Contagem que vira piso ("≥ 12") quando a página do site veio cortada: o menor preço
 * continua exato, mas lojas e unidades além da página não foram vistas.
 */
function floorCol(id: string, header: string, pick: (check: MarketCheck) => number) {
  return helper.accessor((row) => (row.check?.status === "ok" ? pick(row.check) : undefined), {
    id,
    header,
    ...missingLast,
    cell: ({ row }) => {
      const { check } = row.original;
      if (check?.status !== "ok") return "—";
      return `${check.truncated ? "≥ " : ""}${count(pick(check))}`;
    },
  });
}

function PriceCell({ check }: { check: MarketCheck | undefined }) {
  if (!check) return <span className="muted">—</span>;
  switch (check.status) {
    case "ok":
      return <>{zeny(check.min)}</>;
    case "empty":
      return <span className="muted">ninguém vendendo</span>;
    case "incomplete":
      return (
        <span className="muted" title="A busca trouxe mil anúncios de outros itens e este não apareceu entre eles.">
          fora da página
        </span>
      );
    case "unsearchable":
      return (
        <span className="muted" title={check.detail ?? undefined}>
          não consultável
        </span>
      );
    case "error":
      return (
        <span className="warn" title={check.detail ?? undefined}>
          erro
        </span>
      );
  }
}

function CheckedCell({
  row,
  onCheck,
  canCheck,
}: {
  row: FavoriteRow;
  onCheck: (itemId: number) => void;
  canCheck: boolean;
}) {
  // Assina o relógio na célula: a linha reescreve "há 3 min" sozinha, sem a página inteira
  // re-renderizar por causa disso.
  useNow(30_000);
  const at = row.check?.at;
  const status =
    row.pending === "current" ? "consultando…" : row.pending === "queued" ? "na fila" : at === undefined ? "nunca" : agoMs(at);

  // A mesma forma em todo estado — texto e botão, sempre —, só com o texto trocando dentro de
  // uma largura fixa. Trocar a célula inteira por "consultando…" mudava a largura da coluna a
  // cada consulta, e a tabela toda pulava.
  return (
    <span className="checked-cell">
      <span className="muted checked-status">{status}</span>
      <button
        className="ghost small"
        onClick={() => onCheck(row.item.itemId)}
        disabled={!canCheck || row.pending !== null}
        title={canCheck ? "Consultar este item agora (usa uma consulta da cota)" : "Conecte-se ao mercado para consultar"}
      >
        Consultar
      </button>
    </span>
  );
}

function AlertCell({ row, onEdit }: { row: FavoriteRow; onEdit: (itemId: number) => void }) {
  const { alert } = row;
  const state = !alert ? "is-empty" : alert.enabled ? "is-on" : "is-off";
  const described = alert && describeAlert(alert);

  return (
    <button
      type="button"
      className={`alert-button ${state}`}
      onClick={() => onEdit(row.item.itemId)}
      title={described ? `${described.long} — clique para editar` : "Configurar alerta de preço"}
    >
      {alert && described ? `${alert.enabled ? "🔔" : "🔕"} ${described.short}` : "Configurar"}
    </button>
  );
}
