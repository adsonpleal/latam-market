/**
 * A tabela dos favoritos.
 *
 * As colunas são a união do que Pechinchas e Variações mostram — "Preço agora", "Usual",
 * "Desconto", "Lojas", "Vendedor" de um lado; "Antes" e "Variação" do outro — mais as duas
 * que só existem aqui: "Alerta" e "Falta". Como em "Meu inventário", a pessoa escolhe o que
 * fica à vista, e a escolha sobrevive à sessão.
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

import type { ItemPrice } from "../api/types.js";
import { gapToTarget } from "../lib/alerts.js";
import {
  TrendArrow,
  discountVsSold,
  makeNumCol,
  makePctCol,
  missingLast,
  orUndefined,
} from "../lib/columns.js";
import { count, zeny } from "../lib/format.js";
import { FAVORITES_COLUMNS_KEY, type Alert } from "../lib/persist.js";
import { useColumnVisibility } from "../state/useColumnVisibility.js";
import { CopyButton } from "./CopyButton.js";
import { DataTable } from "./DataTable.js";
import { ItemCell, type ItemLabel } from "./ItemCell.js";
import { ItemLinksCell } from "./ItemLinksCell.js";
import { StarButton } from "./StarButton.js";

export interface FavoriteRow {
  itemId: number;
  /** Fica indefinido enquanto o primeiro ciclo não respondeu. */
  price: ItemPrice | undefined;
  alert: Alert | undefined;
  /** Do cruzamento com `/movers`: mediana no começo da janela e variação até hoje. */
  before: number | null;
  changePct: number | null;
}

const helper = createColumnHelper<FavoriteRow>();
const numCol = makeNumCol(helper);
const pctCol = makePctCol(helper);

const DEFAULT_HIDDEN: VisibilityState = {
  median: false,
  stores: false,
  units: false,
  seller: false,
  before: false,
  sold: false,
};

interface Props {
  rows: FavoriteRow[];
  descriptions: Record<string, string>;
  onSelect: (itemId: number) => void;
  /** Abre o modal de configuração do alerta. */
  onEditAlert: (itemId: number) => void;
}

export function FavoritesTable({ rows, descriptions, onSelect, onEditAlert }: Props) {
  // Abre pelo que está mais perto de disparar — a pergunta que traz a pessoa aqui.
  const [sorting, setSorting] = useState<SortingState>([{ id: "gap", desc: false }]);
  const [visibility, setVisibility] = useColumnVisibility(FAVORITES_COLUMNS_KEY, DEFAULT_HIDDEN);

  const columns = useMemo(
    () => buildColumns({ descriptions, onSelect, onEditAlert }),
    [descriptions, onSelect, onEditAlert],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnVisibility: visibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => String(row.itemId),
  });

  return <DataTable table={table} />;
}

/**
 * Item mínimo para a célula do nome enquanto o preço não chegou.
 *
 * Sem isto a tabela ficaria vazia até o primeiro ciclo responder, e quem acabou de colar um
 * id não veria nada acontecer.
 */
const briefOf = (row: FavoriteRow): ItemLabel =>
  row.price ?? { itemId: row.itemId, name: `#${row.itemId}`, slots: null };

// `any` no segundo parâmetro é o que a própria TanStack recomenda para uma lista com
// colunas de tipos de valor diferentes.
function buildColumns(ctx: {
  descriptions: Record<string, string>;
  onSelect: (itemId: number) => void;
  onEditAlert: (itemId: number) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): ColumnDef<FavoriteRow, any>[] {
  const { descriptions, onSelect, onEditAlert } = ctx;

  return [
    helper.display({
      id: "estrela",
      header: "",
      cell: ({ row }) => <StarButton itemId={row.original.itemId} />,
    }),
    helper.display({
      id: "ícone",
      header: "",
      cell: ({ row }) => (
        <ItemCell
          item={briefOf(row.original)}
          descriptions={descriptions}
          onSelect={onSelect}
          part="icon"
        />
      ),
    }),
    helper.accessor((row) => row.price?.name ?? `#${row.itemId}`, {
      id: "name",
      header: "Item",
      cell: ({ row }) => (
        <>
          <ItemCell
            item={briefOf(row.original)}
            descriptions={descriptions}
            onSelect={onSelect}
            part="name"
          />
          <TrendArrow pct={row.original.changePct} />
        </>
      ),
    }),

    // --- o alerta ---------------------------------------------------------
    helper.accessor((row) => orUndefined(row.alert?.targetPrice), {
      id: "alert",
      header: "Alerta",
      ...missingLast,
      cell: ({ row }) => <AlertCell row={row.original} onEdit={onEditAlert} />,
    }),
    // Negativo é "já passou do alvo", que é a boa notícia — daí `good: "down"`.
    pctCol("gap", "Falta", (row) => gapToTarget(row.alert, row.price?.offers?.min), "down"),

    // --- agora, nas lojas abertas (herdado de Pechinchas) -----------------
    numCol("now", "Preço agora", (row) => row.price?.offers?.min, zeny),
    numCol("median", "Mediana", (row) => row.price?.offers?.median, zeny),
    numCol("stores", "Lojas", (row) => row.price?.offers?.stores, count),
    numCol("units", "Un. à venda", (row) => row.price?.offers?.units, count),
    helper.accessor((row) => row.price?.cheapest[0]?.seller ?? "", {
      id: "seller",
      header: "Vendedor",
      cell: ({ row }) => {
        const seller = row.original.price?.cheapest[0]?.seller;
        if (!seller) return "—";
        return (
          <span className="copyable">
            {seller}
            <CopyButton value={seller} label="o nome do vendedor" />
          </span>
        );
      },
    }),

    // --- o usual e a variação (herdado de Pechinchas e Variações) ---------
    // `usual` é a média do que o site publica como JÁ VENDIDO. É outra medida que as
    // colunas de cima, e não se somam a elas — ver o cabeçalho de `core/prices.ts`.
    numCol("usual", "Usual", (row) => row.price?.market?.avg, zeny),
    pctCol(
      "discount",
      "vs. média vendida",
      (row) => discountVsSold(row.price?.offers?.min, row.price?.market?.avg),
      "up",
    ),
    numCol("before", "Antes", (row) => row.before, zeny),
    pctCol("change", "Variação", (row) => row.changePct, "up"),
    numCol("sold", "Já vendidos", (row) => row.price?.market?.totalSold, count),

    helper.display({
      id: "links",
      header: "Links",
      cell: ({ row }) =>
        row.original.price ? <ItemLinksCell links={row.original.price.links} /> : null,
    }),
  ];
}

function AlertCell({ row, onEdit }: { row: FavoriteRow; onEdit: (itemId: number) => void }) {
  const { alert } = row;
  const state = !alert ? "is-empty" : alert.enabled ? "is-on" : "is-off";
  const arrow = alert?.direction === "up" ? "↑" : "↓";

  return (
    <button
      type="button"
      className={`alert-button ${state}`}
      onClick={() => onEdit(row.itemId)}
      title={
        alert
          ? `Avisar quando o menor preço ${alert.direction === "down" ? "cair" : "subir"} para ` +
            `${zeny(alert.targetPrice)} — clique para editar`
          : "Configurar alerta de preço"
      }
    >
      {alert ? (
        <>
          {alert.enabled ? "🔔" : "🔕"} {arrow} {zeny(alert.targetPrice)}
        </>
      ) : (
        "Configurar"
      )}
    </button>
  );
}
