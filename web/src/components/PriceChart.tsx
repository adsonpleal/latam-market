import { useState, type CSSProperties } from "react";

import type { HistoryPoint } from "../api/types.js";
import { date, dateTime, zeny } from "../lib/format.js";

/**
 * Gráfico de linha em SVG à mão.
 *
 * Uma biblioteca de gráficos seriam ~100 KB para desenhar duas séries num painel
 * lateral; o servidor inteiro deste projeto tem três dependências de runtime.
 *
 * As duas séries são independentes: um ponto pode ter `offerMin` sem `marketAvg` e
 * vice-versa, porque vêm de coletas diferentes. Cada linha pula os pontos que não tem,
 * em vez de interpolar valor que ninguém mediu.
 *
 * O hover mede pela data, não pela linha mais próxima: uma faixa invisível por ponto
 * cobre toda a altura, então o cartão abre em qualquer altura do gráfico e mostra as
 * séries daquele dia de uma vez. A faixa também dispensa converter pixel de tela para
 * coordenada do `viewBox` — o próprio SVG faz a conta ao escalar, e uma faixa larga por
 * ponto é mais barata que um `getBoundingClientRect()` a cada movimento do mouse.
 *
 * O cartão é melhoria para quem aponta: o SVG continua sendo `role="img"` com rótulo,
 * e os mesmos números estão nas tabelas e no painel do item, em texto.
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

interface Measure extends Series {
  value: number;
}

/**
 * As séries que têm medida neste ponto.
 *
 * A escala, o marcador do hover e as linhas do cartão saem todos daqui: a regra de "o que
 * ninguém mediu não aparece" é escrita uma vez só, e uma quarta série entra sem que quatro
 * lugares tenham que concordar sobre o que é um valor.
 */
const measured = (p: HistoryPoint): Measure[] =>
  SERIES.flatMap((s) => {
    const value = p[s.key];
    return typeof value === "number" ? [{ ...s, value }] : [];
  });

export function PriceChart({ points }: { points: HistoryPoint[] }) {
  const [hover, setHover] = useState<HistoryPoint | null>(null);

  const values = points.flatMap((p) => measured(p).map((m) => m.value));

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

  // Buckets de hora cabem em janelas curtas; aí a data sozinha repetiria três vezes.
  const when = maxTs - minTs <= 3 * 86400 ? dateTime : date;

  const marks = points.filter((p) => measured(p).length > 0);

  /**
   * Faixa de captura do ponto `i`: metade do caminho até cada vizinho, e as das pontas
   * vão até a borda do SVG. Faixa nenhuma pode sobrar: um vão morto sobre a margem
   * deixaria o cartão do ponto anterior aberto enquanto o mouse já saiu dele.
   */
  const band = (i: number): { from: number; width: number } => {
    const cur = x(marks[i]!.ts);
    const from = i === 0 ? 0 : (x(marks[i - 1]!.ts) + cur) / 2;
    const to = i === marks.length - 1 ? W : (cur + x(marks[i + 1]!.ts)) / 2;
    return { from, width: Math.max(to - from, 1) };
  };

  /**
   * Onde o cartão pousa.
   *
   * No eixo x fica preso à data, encostando na borda quando o ponto está numa das pontas
   * em vez de vazar para fora do gráfico. No eixo y vai para o lado oposto às linhas, para
   * não cobrir justamente o trecho que a pessoa foi olhar.
   */
  const tipStyle = (p: HistoryPoint): CSSProperties => {
    const at = x(p.ts) / W;
    const high = Math.min(...measured(p).map((m) => y(m.value))) < (PAD.top + H - PAD.bottom) / 2;
    return {
      left: `${at * 100}%`,
      transform: `translateX(${at < 0.25 ? "0" : at > 0.75 ? "-100%" : "-50%"})`,
      ...(high ? { bottom: 6 } : { top: 6 }),
    };
  };

  return (
    <figure className="chart">
      <div className="chart-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Histórico de preço"
          onPointerLeave={() => setHover(null)}
        >
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

          {marks.map((p, i) => {
            const b = band(i);
            return (
              <rect
                key={p.ts}
                x={b.from}
                y={0}
                width={b.width}
                height={H}
                fill="transparent"
                onPointerEnter={() => setHover(p)}
                onPointerDown={() => setHover(p)}
              />
            );
          })}

          {hover && (
            <g pointerEvents="none">
              <line
                className="chart-cursor"
                x1={x(hover.ts)}
                x2={x(hover.ts)}
                y1={PAD.top}
                y2={H - PAD.bottom}
              />
              {measured(hover).map((m) => (
                <circle key={m.key} cx={x(hover.ts)} cy={y(m.value)} r={3.2} fill={m.color} />
              ))}
            </g>
          )}
        </svg>

        {hover && (
          <div className="chart-tip" aria-hidden style={tipStyle(hover)}>
            <div className="chart-tip-when">{when(hover.ts)}</div>
            {measured(hover).map((m) => (
              <div key={m.key} className="chart-tip-row">
                <i style={{ background: m.color }} />
                <span>{m.label}</span>
                <b>{zeny(m.value)}</b>
              </div>
            ))}
          </div>
        )}
      </div>

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
