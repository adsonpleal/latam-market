import type { HistoryPoint } from "../api/types.js";
import { date, zeny } from "../lib/format.js";

/**
 * Gráfico de linha em SVG à mão.
 *
 * Uma biblioteca de gráficos seriam ~100 KB para desenhar duas séries num painel
 * lateral; o servidor inteiro deste projeto tem três dependências de runtime.
 *
 * As duas séries são independentes: um ponto pode ter `offerMin` sem `marketAvg` e
 * vice-versa, porque vêm de coletas diferentes. Cada linha pula os pontos que não tem,
 * em vez de interpolar valor que ninguém mediu.
 */

const W = 560;
const H = 180;
const PAD = { top: 12, right: 12, bottom: 22, left: 62 };

interface Series {
  key: "offerMin" | "offerMedian" | "marketAvg";
  label: string;
  color: string;
}

const SERIES: Series[] = [
  { key: "offerMin", label: "Menor oferta", color: "#3b82f6" },
  { key: "offerMedian", label: "Mediana das ofertas", color: "#8b5cf6" },
  { key: "marketAvg", label: "Média vendida (site)", color: "#f59e0b" },
];

export function PriceChart({ points }: { points: HistoryPoint[] }) {
  const values = points.flatMap((p) =>
    SERIES.map((s) => p[s.key]).filter((v): v is number => typeof v === "number"),
  );

  if (points.length < 2 || values.length === 0) {
    return <p className="empty">Ainda não há histórico suficiente para este item.</p>;
  }

  const minTs = points[0]!.ts;
  const maxTs = points[points.length - 1]!.ts;
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const span = maxVal - minVal || 1;

  const x = (ts: number): number =>
    PAD.left + ((ts - minTs) / (maxTs - minTs || 1)) * (W - PAD.left - PAD.right);
  const y = (v: number): number =>
    PAD.top + (1 - (v - minVal) / span) * (H - PAD.top - PAD.bottom);

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Histórico de preço">
        {[0, 0.5, 1].map((t) => {
          const value = minVal + span * (1 - t);
          const yy = PAD.top + t * (H - PAD.top - PAD.bottom);
          return (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={yy} y2={yy} className="grid" />
              <text x={PAD.left - 6} y={yy + 4} className="axis" textAnchor="end">
                {zeny(value)}
              </text>
            </g>
          );
        })}

        {SERIES.map((series) => {
          const path = points
            .filter((p) => typeof p[series.key] === "number")
            .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts).toFixed(1)},${y(p[series.key]!).toFixed(1)}`)
            .join(" ");
          return path ? (
            <path key={series.key} d={path} fill="none" stroke={series.color} strokeWidth={1.8} />
          ) : null;
        })}

        <text x={PAD.left} y={H - 6} className="axis">
          {date(minTs)}
        </text>
        <text x={W - PAD.right} y={H - 6} className="axis" textAnchor="end">
          {date(maxTs)}
        </text>
      </svg>

      <figcaption className="chart-legend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} aria-hidden /> {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
