import { serviceStatus } from "../api/client.js";
import { FreshnessBadge } from "../components/Freshness.js";
import { count, dateTime } from "../lib/format.js";
import { useApi } from "../state/useApi.js";

export function StatusPage({ server }: { server: string }) {
  const { data, error } = useApi(() => serviceStatus(), [server]);

  return (
    <section className="page">
      <h1>Estado do serviço</h1>
      <p className="lead">
        As lojas abertas são recoletadas de hora em hora; o agregado que o site publica,
        a cada seis horas. Todo preço nesta interface carrega a idade do dado.
      </p>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="empty">Carregando…</p>}

      {data && (
        <>
          <FreshnessBadge freshness={data.freshness} />

          <div className="table-scroll">
            <table className="items">
              <thead>
                <tr>
                  <th>Coleta</th>
                  <th>Conjunto</th>
                  <th>Início</th>
                  <th>Fim</th>
                  <th>Linhas</th>
                  <th>Origem</th>
                </tr>
              </thead>
              <tbody>
                {data.collections.map((collection) => (
                  <tr key={collection.id}>
                    <td>#{collection.id}</td>
                    <td>{collection.dataset}</td>
                    <td>{dateTime(collection.startedAt)}</td>
                    <td>{collection.finishedAt === null ? "—" : dateTime(collection.finishedAt)}</td>
                    <td>{count(collection.rows)}</td>
                    <td>{collection.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
