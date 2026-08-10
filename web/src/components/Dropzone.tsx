import { useRef, useState } from "react";

interface Props {
  onFile: (file: File) => void;
  busy: boolean;
}

export function Dropzone({ onFile, busy }: Props) {
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = (file: File | undefined): void => {
    if (file) onFile(file);
    // Sem isto, escolher o MESMO arquivo de novo não dispara `change` e a tela trava
    // parecendo quebrada.
    if (input.current) input.current.value = "";
  };

  return (
    <div
      className={`dropzone${dragging ? " dragging" : ""}${busy ? " busy" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        take(e.dataTransfer.files[0]);
      }}
      onClick={() => input.current?.click()}
    >
      <input
        ref={input}
        type="file"
        accept=".rrf"
        hidden
        onChange={(e) => take(e.target.files?.[0])}
      />
      <p className="dropzone-title">
        {busy ? "Lendo o replay…" : "Arraste seu arquivo .rrf aqui"}
      </p>
      <p className="dropzone-hint">
        Ou clique para escolher. O replay fica em <code>Ragnarok/Replay</code>.
      </p>
      <p className="dropzone-privacy">
        O arquivo é enviado ao servidor para ser lido. Ele contém o nome do seu
        personagem, o mapa e o nível — nada é gravado depois da resposta.
      </p>
    </div>
  );
}
