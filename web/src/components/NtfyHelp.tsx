/**
 * Como ligar o push no celular, e por que o nome do tópico importa.
 *
 * O aviso sobre o tópico não é formalidade: no ntfy sem autenticação **quem souber o nome
 * pode publicar** nele. É a única coisa que separa as notificações da pessoa de qualquer
 * um, então precisa estar dito sem jargão e antes de ela escolher um nome óbvio.
 */

import { Modal } from "./Modal.js";

export function NtfyHelp({ topicExample, onClose }: { topicExample: string; onClose: () => void }) {
  return (
    <Modal label="Como configurar o ntfy" onClose={onClose}>
      <h3>Alertas no celular com ntfy</h3>
      <p className="lead">
        O <strong>ntfy</strong> é um serviço gratuito de notificação. Esta página manda uma mensagem
        para um <em>tópico</em>, e o app do ntfy no seu celular recebe e mostra — sem cadastro e sem
        chave de API.
      </p>

      <ol className="help-steps">
        <li>
          Instale o app <strong>ntfy</strong>: no Android pela Play Store ou em{" "}
          <a href="https://ntfy.sh/app" target="_blank" rel="noreferrer noopener">
            ntfy.sh/app
          </a>
          ; no iPhone busque por "ntfy" na App Store.
        </li>
        <li>
          No app, toque em <strong>"Subscribe to topic"</strong> e use um nome único. Clique em{" "}
          <strong>Gerar</strong> aqui para receber um pronto, como <code>{topicExample}</code>.
        </li>
        <li>
          Cole o mesmo nome no campo <strong>Tópico</strong>, marque o canal e clique em{" "}
          <strong>Testar</strong> para confirmar que chegou.
        </li>
      </ol>

      <h4>O nome do tópico é uma senha curta</h4>
      <p>
        Qualquer pessoa que souber o nome pode mandar notificação para o seu celular. Não publique
        em print nem no Discord, e prefira o nome que o botão <strong>Gerar</strong> sugere —{" "}
        <code>latam-market-alertas</code> alguém adivinha na primeira tentativa.
      </p>

      <h4>De onde vêm os preços</h4>
      <p>
        Os alertas leem a coleta deste projeto, que roda a cada 30 minutos, e não o site oficial —
        então o seu navegador não corre risco de ser bloqueado por ele. Esta página checa{" "}
        <strong>uma vez por coleta</strong>, logo depois de o dado novo chegar: perguntar com mais
        frequência não traria preço mais novo.
      </p>

      <h4>Onde isso fica guardado</h4>
      <p>
        O tópico e os alvos ficam neste navegador e o push vai direto daqui para o ntfy. Nosso
        servidor nunca vê o seu tópico nem a sua lista de itens. Em troca, os alertas só rodam
        enquanto esta aba estiver aberta.
      </p>

      <p className="footer-note">
        O servidor usado é o público{" "}
        <a href="https://ntfy.sh" target="_blank" rel="noreferrer noopener">
          ntfy.sh
        </a>
        . Mais detalhes em{" "}
        <a href="https://docs.ntfy.sh" target="_blank" rel="noreferrer noopener">
          docs.ntfy.sh
        </a>
        .
      </p>

      <div className="modal-actions">
        <button onClick={onClose}>Entendi</button>
      </div>
    </Modal>
  );
}
