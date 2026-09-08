"use client";

import { useEffect, useRef, useState } from "react";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import type { OperationalCtoDetail, OperationalCtoPort } from "@/lib/cto-read-model";

/**
 * # `CTO-2.3` — vincular, mover e desconectar pela tela
 *
 * ## O que ESTE componente não é
 *
 * Não é a autoridade. `availableForConnection` decide o que **oferecer**, e
 * nada mais: quem autoriza é a transação do servidor, que revalida CTO ativa,
 * faixa, estado e ocupação com a caixa travada. Copiar `isPortOfferable` para
 * cá criaria uma segunda regra que diverge na primeira correção — e daria a
 * impressão de proteção onde só há conveniência.
 *
 * ## Toda recusa recarrega
 *
 * Um `409` significa que a tela estava velha. Manter o estado local depois dele
 * é o que produz a pior classe de erro deste módulo: o operador vê um mundo que
 * já não existe e clica de novo. Por isso todo desfecho de conflito dispara
 * releitura autoritativa, e a mensagem diz que os dados foram atualizados.
 */

// ---------------------------------------------------------------------------
// Diálogo — o projeto não tinha um, e este é o mínimo
// ---------------------------------------------------------------------------

/**
 * Um diálogo modal simples, com o que acessibilidade exige e nada além.
 *
 * `role="dialog"` + `aria-modal` + rótulo, foco levado para dentro ao abrir,
 * `Esc` fecha e o retorno do foco ao elemento que abriu. Sem biblioteca nova:
 * a única coisa que faltava era um contêiner, e trazer uma dependência para
 * isso custaria mais do que resolve.
 */
function Dialog({
  titulo,
  onClose,
  children,
  testId,
}: {
  titulo: string;
  onClose: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  const caixa = useRef<HTMLDivElement>(null);
  const anterior = useRef<HTMLElement | null>(null);

  useEffect(() => {
    anterior.current = document.activeElement as HTMLElement | null;
    caixa.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Devolver o foco a quem abriu: sem isso, quem navega por teclado volta
      // ao topo do documento e perde o lugar na lista de portas.
      anterior.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div
        ref={caixa}
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        tabIndex={-1}
        data-testid={testId}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-surface p-5 shadow-lg outline-none sm:rounded-2xl"
      >
        <h3 className="mb-4 text-base font-semibold text-fg">{titulo}</h3>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tipos das leituras que este painel consome
// ---------------------------------------------------------------------------

interface ClienteResumo {
  id: string;
  name: string;
  document: string | null;
}

interface Colocacao {
  connectionId: string;
  cto: { id: string; name: string; active: boolean };
  port: { id: string; number: number };
}

interface CtoResumo {
  id: string;
  name: string;
  active: boolean;
}

const botao =
  "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-40";
const botaoPrimario =
  "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60";

// ---------------------------------------------------------------------------

export function PortConnectionPanel({
  cto,
  port,
  onChanged,
}: {
  cto: OperationalCtoDetail;
  port: OperationalCtoPort;
  onChanged: (mensagem: string, tipo: "ok" | "conflito") => void;
}) {
  const [aberto, setAberto] = useState<null | "connect" | "move" | "disconnect">(null);

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {port.availableForConnection && (
          <button
            type="button"
            className={botao}
            onClick={() => setAberto("connect")}
            data-testid={`cto-port-connect-${port.number}`}
          >
            Vincular cliente
          </button>
        )}
        {/*
          Ocupada continua operável mesmo em CTO INATIVA e mesmo em porta
          histórica: desativar uma caixa ou reduzir a capacidade não pode
          aprisionar quem está dentro. O que some é só o "Vincular".
        */}
        {port.occupied && (
          <>
            <button
              type="button"
              className={botao}
              onClick={() => setAberto("move")}
              data-testid={`cto-port-move-${port.number}`}
            >
              Mover
            </button>
            <button
              type="button"
              className={botao}
              onClick={() => setAberto("disconnect")}
              data-testid={`cto-port-disconnect-${port.number}`}
            >
              Desconectar
            </button>
          </>
        )}
      </div>

      {aberto === "connect" && (
        <ConnectDialog
          port={port}
          onClose={() => setAberto(null)}
          onDone={onChanged}
        />
      )}
      {aberto === "move" && port.activeConnection && (
        <MoveDialog
          cto={cto}
          port={port}
          onClose={() => setAberto(null)}
          onDone={onChanged}
        />
      )}
      {aberto === "disconnect" && port.activeConnection && (
        <DisconnectDialog
          cto={cto}
          port={port}
          onClose={() => setAberto(null)}
          onDone={onChanged}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Chave de idempotência
// ---------------------------------------------------------------------------

/**
 * Uma tentativa lógica, uma chave.
 *
 * Mesmo padrão do ajuste de jornada: a chave só troca quando a **assinatura
 * semântica** da ação muda. Repetir o mesmo clique — inclusive um duplo clique
 * que escape do `disabled` — reenvia a mesma chave e o servidor devolve a
 * resposta gravada. Gerar chave nova a cada tentativa transformaria retry em
 * duplicação, que é exatamente o que o cabeçalho existe para impedir.
 *
 * É um `ref` e não estado: trocar a chave não deve provocar renderização no
 * meio do envio.
 */
function useChave() {
  const atual = useRef<{ assinatura: string; valor: string } | null>(null);
  return (assinatura: string) => {
    if (atual.current?.assinatura !== assinatura) {
      atual.current = { assinatura, valor: newIdempotencyKey() };
    }
    return atual.current.valor;
  };
}

interface Resultado {
  ok: boolean;
  status: number;
  erro?: string;
}

async function enviar(
  url: string,
  corpo: unknown,
  chave: string,
): Promise<Resultado> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": chave },
    body: JSON.stringify(corpo),
  });
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: string }
    | null;
  return { ok: res.ok, status: res.status, erro: payload?.error ?? undefined };
}

/**
 * A frase que a pessoa lê quando o servidor recusa.
 *
 * O `409` do domínio já vem escrito para quem opera — "esta porta já está
 * ocupada", "este vínculo mudou desde que a tela foi carregada" — e repeti-lo é
 * melhor que trocá-lo por um genérico. Os demais códigos viram texto fixo,
 * porque a mensagem crua deles não é para o operador.
 */
function mensagemDeErro(r: Resultado): string {
  if (r.status === 409) {
    return `${r.erro ?? "A operação entrou em conflito."} Os dados da CTO foram atualizados.`;
  }
  if (r.status === 403) return "Você não tem permissão para esta ação.";
  if (r.status === 404) return "O recurso não está mais disponível.";
  if (r.status === 400) return r.erro ?? "Dados inválidos.";
  return "Não foi possível concluir a operação.";
}

function Erro({ texto }: { texto: string | null }) {
  if (!texto) return null;
  return (
    <p
      role="alert"
      data-testid="cto-connection-error"
      className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg"
    >
      {texto}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Vincular
// ---------------------------------------------------------------------------

function ConnectDialog({
  port,
  onClose,
  onDone,
}: {
  port: OperationalCtoPort;
  onClose: () => void;
  onDone: (m: string, tipo: "ok" | "conflito") => void;
}) {
  const [termo, setTermo] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [resultados, setResultados] = useState<ClienteResumo[] | null>(null);
  const [escolhido, setEscolhido] = useState<ClienteResumo | null>(null);
  const [atual, setAtual] = useState<Colocacao | null | undefined>(undefined);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const chaveDe = useChave();

  /*
    Busca no SERVIDOR, com atraso.

    A base de clientes cresce, e um `<select>` com todos seria uma consulta
    inteira por abertura de modal. `GET /api/customers?search=` já existe,
    pagina e filtra por tenant — criar uma rota nova para isto seria uma
    segunda superfície de leitura sem motivo.

    O atraso evita uma requisição por tecla; o `ignorar` evita que uma resposta
    lenta de um termo antigo sobrescreva a de um termo novo.
  */
  useEffect(() => {
    const alvo = termo.trim();
    if (alvo.length < 2) {
      setResultados(null);
      return;
    }
    let ignorar = false;
    setBuscando(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/customers?search=${encodeURIComponent(alvo)}&pageSize=10`,
        );
        const payload = (await res.json()) as {
          data?: { customers?: ClienteResumo[] };
        };
        if (!ignorar) setResultados(payload.data?.customers ?? []);
      } catch {
        if (!ignorar) setResultados([]);
      } finally {
        if (!ignorar) setBuscando(false);
      }
    }, 300);
    return () => {
      ignorar = true;
      clearTimeout(t);
    };
  }, [termo]);

  /*
    Ao escolher o cliente, descobrir onde ele JÁ está.

    É o que decide qual operação a tela oferece. Conectar alguém que já tem
    vínculo receberia `409` do servidor — a tela existe para não empurrar a
    pessoa contra essa parede, e para oferecer a operação certa: mover.
  */
  async function escolher(c: ClienteResumo) {
    setEscolhido(c);
    setAtual(undefined);
    setErro(null);
    const res = await fetch(
      `/api/cto-connections?customerId=${encodeURIComponent(c.id)}`,
    );
    const payload = (await res.json().catch(() => null)) as {
      data?: { network?: { current: Colocacao | null } };
    } | null;
    setAtual(payload?.data?.network?.current ?? null);
  }

  async function confirmar() {
    if (!escolhido) return;
    setEnviando(true);
    setErro(null);
    try {
      const mover = atual != null;
      const r = mover
        ? await enviar(
            `/api/cto-connections/${atual!.connectionId}/move`,
            { targetCtoPortId: port.id },
            chaveDe(`move:${atual!.connectionId}:${port.id}`),
          )
        : await enviar(
            "/api/cto-connections",
            { customerId: escolhido.id, ctoPortId: port.id },
            chaveDe(`connect:${escolhido.id}:${port.id}`),
          );
      if (!r.ok) {
        /*
          Conflito FECHA o diálogo e devolve a mensagem ao pai.

          A releitura autoritativa some com a premissa da caixa aberta — a porta
          deixa de estar ocupada, e o diálogo desmonta levando a mensagem junto.
          O operador veria um clique sem resposta: o mesmo defeito da `CTO-1.3`,
          em que recusa invisível é indistinguível de botão quebrado.

          Erro de payload ou de permissão NÃO fecha: ali a premissa continua de
          pé e a pessoa tem o que corrigir sem perder o contexto.
        */
        if (r.status === 409 || r.status === 404) {
          onDone(mensagemDeErro(r), "conflito");
          onClose();
          return;
        }
        setErro(mensagemDeErro(r));
        return;
      }
      onDone(
        mover
          ? `${escolhido.name} movido para a porta ${String(port.number).padStart(2, "0")}.`
          : `${escolhido.name} vinculado à porta ${String(port.number).padStart(2, "0")}.`,
        "ok",
      );
      onClose();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Dialog
      titulo={`Vincular cliente à porta ${String(port.number).padStart(2, "0")}`}
      onClose={onClose}
      testId="cto-connect-dialog"
    >
      <label className="mb-1 block text-sm font-medium text-fg-secondary" htmlFor="cto-customer-search">
        Buscar cliente
      </label>
      <input
        id="cto-customer-search"
        type="search"
        value={termo}
        onChange={(e) => setTermo(e.target.value)}
        placeholder="ex.: nome, documento ou telefone"
        className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        data-testid="cto-customer-search"
      />

      {buscando && <p className="mt-2 text-xs text-fg-muted">Buscando…</p>}
      {resultados?.length === 0 && !buscando && (
        <p className="mt-2 text-sm text-fg-secondary" data-testid="cto-customer-empty">
          Nenhum cliente encontrado.
        </p>
      )}

      {resultados && resultados.length > 0 && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
          {resultados.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => void escolher(c)}
                aria-pressed={escolhido?.id === c.id}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  escolhido?.id === c.id
                    ? "border-focus bg-surface-muted text-fg"
                    : "border-border text-fg-secondary hover:bg-surface-muted"
                }`}
                data-testid={`cto-customer-option-${c.id}`}
              >
                {c.name}
                {c.document ? (
                  <span className="ml-2 text-xs text-fg-muted">{c.document}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {escolhido && atual === undefined && (
        <p className="mt-3 text-xs text-fg-muted">Verificando vínculo atual…</p>
      )}

      {escolhido && atual === null && (
        <p className="mt-3 text-sm text-fg-secondary" data-testid="cto-connect-plain">
          {escolhido.name} não está conectado a nenhuma porta.
        </p>
      )}

      {escolhido && atual && (
        /*
          O cliente já está em algum lugar, e a tela DIZ onde antes de agir.

          A operação passa a ser movimentação — nunca desconectar e conectar em
          duas requisições, que abriria uma janela sem vínculo e perderia a
          atomicidade que o domínio garante numa transação só.
        */
        <p className="mt-3 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg" data-testid="cto-connect-move-notice">
          Atualmente conectado em {atual.cto.name} · porta{" "}
          {String(atual.port.number).padStart(2, "0")}. A ação abaixo vai
          <strong> mover</strong> o cliente para esta porta.
        </p>
      )}

      <Erro texto={erro} />

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={botao} onClick={onClose} disabled={enviando}>
          Cancelar
        </button>
        <button
          type="button"
          className={botaoPrimario}
          disabled={!escolhido || atual === undefined || enviando}
          onClick={() => void confirmar()}
          data-testid="cto-connect-confirm"
        >
          {enviando ? "Enviando…" : atual ? "Mover para esta porta" : "Vincular"}
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Mover
// ---------------------------------------------------------------------------

function MoveDialog({
  cto,
  port,
  onClose,
  onDone,
}: {
  cto: OperationalCtoDetail;
  port: OperationalCtoPort;
  onClose: () => void;
  onDone: (m: string, tipo: "ok" | "conflito") => void;
}) {
  const conexao = port.activeConnection!;
  const [ctos, setCtos] = useState<CtoResumo[] | null>(null);
  const [destinoCtoId, setDestinoCtoId] = useState(cto.id);
  const [destino, setDestino] = useState<OperationalCtoDetail | null>(cto);
  const [portaId, setPortaId] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const chaveDe = useChave();

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/ctos");
      const payload = (await res.json().catch(() => null)) as {
        data?: { ctos?: CtoResumo[] };
      } | null;
      setCtos(payload?.data?.ctos ?? []);
    })();
  }, []);

  useEffect(() => {
    if (destinoCtoId === cto.id) {
      setDestino(cto);
      return;
    }
    let ignorar = false;
    setDestino(null);
    void (async () => {
      const res = await fetch(`/api/ctos/${destinoCtoId}`);
      const payload = (await res.json().catch(() => null)) as {
        data?: { cto?: OperationalCtoDetail };
      } | null;
      if (!ignorar) setDestino(payload?.data?.cto ?? null);
    })();
    return () => {
      ignorar = true;
    };
  }, [destinoCtoId, cto]);

  /*
    Candidatas segundo o read model, menos a porta de origem.

    Tirar a origem da lista é conveniência: o servidor recusa a mesma porta com
    `409` de qualquer forma, e continuar oferecendo-a só faria a pessoa
    descobrir isso clicando.
  */
  const candidatas = (destino?.ports ?? []).filter(
    (p) => p.availableForConnection && p.id !== port.id,
  );

  async function confirmar() {
    if (!portaId) return;
    setEnviando(true);
    setErro(null);
    try {
      const r = await enviar(
        `/api/cto-connections/${conexao.id}/move`,
        { targetCtoPortId: portaId },
        chaveDe(`move:${conexao.id}:${portaId}`),
      );
      if (!r.ok) {
        /*
          Conflito FECHA o diálogo e devolve a mensagem ao pai.

          A releitura autoritativa some com a premissa da caixa aberta — a porta
          deixa de estar ocupada, e o diálogo desmonta levando a mensagem junto.
          O operador veria um clique sem resposta: o mesmo defeito da `CTO-1.3`,
          em que recusa invisível é indistinguível de botão quebrado.

          Erro de payload ou de permissão NÃO fecha: ali a premissa continua de
          pé e a pessoa tem o que corrigir sem perder o contexto.
        */
        if (r.status === 409 || r.status === 404) {
          onDone(mensagemDeErro(r), "conflito");
          onClose();
          return;
        }
        setErro(mensagemDeErro(r));
        return;
      }
      onDone(`${conexao.customer.name} movido com sucesso.`, "ok");
      onClose();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Dialog
      titulo={`Mover ${conexao.customer.name}`}
      onClose={onClose}
      testId="cto-move-dialog"
    >
      <p className="mb-3 text-sm text-fg-secondary">
        Origem: {cto.name} · porta {String(port.number).padStart(2, "0")}
      </p>

      <label className="mb-1 block text-sm font-medium text-fg-secondary" htmlFor="cto-move-cto">
        CTO de destino
      </label>
      <select
        id="cto-move-cto"
        value={destinoCtoId}
        onChange={(e) => {
          setDestinoCtoId(e.target.value);
          setPortaId("");
        }}
        className="mb-3 w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        data-testid="cto-move-cto"
      >
        {/*
          Só CTOs ATIVAS entram como destino: uma caixa desativada não recebe
          ninguém. A de ORIGEM pode estar inativa, e é por isso que ela aparece
          aqui apenas quando ainda está ativa — sair dela continua sendo feito
          escolhendo outra.
        */}
        {(ctos ?? []).filter((c) => c.active).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <label className="mb-1 block text-sm font-medium text-fg-secondary" htmlFor="cto-move-port">
        Porta de destino
      </label>
      <select
        id="cto-move-port"
        value={portaId}
        onChange={(e) => setPortaId(e.target.value)}
        disabled={!destino}
        className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft disabled:opacity-50"
        data-testid="cto-move-port"
      >
        <option value="">Selecione…</option>
        {candidatas.map((p) => (
          <option key={p.id} value={p.id}>
            Porta {String(p.number).padStart(2, "0")}
          </option>
        ))}
      </select>
      {destino && candidatas.length === 0 && (
        <p className="mt-2 text-sm text-fg-secondary" data-testid="cto-move-empty">
          Nenhuma porta disponível nesta CTO.
        </p>
      )}

      <Erro texto={erro} />

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={botao} onClick={onClose} disabled={enviando}>
          Cancelar
        </button>
        <button
          type="button"
          className={botaoPrimario}
          disabled={!portaId || enviando}
          onClick={() => void confirmar()}
          data-testid="cto-move-confirm"
        >
          {enviando ? "Movendo…" : "Mover"}
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Desconectar
// ---------------------------------------------------------------------------

function DisconnectDialog({
  cto,
  port,
  onClose,
  onDone,
}: {
  cto: OperationalCtoDetail;
  port: OperationalCtoPort;
  onClose: () => void;
  onDone: (m: string, tipo: "ok" | "conflito") => void;
}) {
  const conexao = port.activeConnection!;
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const chaveDe = useChave();

  async function confirmar() {
    setEnviando(true);
    setErro(null);
    try {
      /*
        O id do VÍNCULO que esta tela viu, e não o do cliente.

        É o que impede o pior desfecho do módulo: entre carregar a tela e
        clicar, outra pessoa move o cliente, e um comando por `customerId`
        encerraria o vínculo NOVO — que este operador nunca viu.
      */
      const r = await enviar(
        `/api/cto-connections/${conexao.id}/disconnect`,
        {},
        chaveDe(`disconnect:${conexao.id}`),
      );
      if (!r.ok) {
        /*
          Conflito FECHA o diálogo e devolve a mensagem ao pai.

          A releitura autoritativa some com a premissa da caixa aberta — a porta
          deixa de estar ocupada, e o diálogo desmonta levando a mensagem junto.
          O operador veria um clique sem resposta: o mesmo defeito da `CTO-1.3`,
          em que recusa invisível é indistinguível de botão quebrado.

          Erro de payload ou de permissão NÃO fecha: ali a premissa continua de
          pé e a pessoa tem o que corrigir sem perder o contexto.
        */
        if (r.status === 409 || r.status === 404) {
          onDone(mensagemDeErro(r), "conflito");
          onClose();
          return;
        }
        setErro(mensagemDeErro(r));
        return;
      }
      onDone(`${conexao.customer.name} desconectado.`, "ok");
      onClose();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Dialog titulo="Desconectar cliente" onClose={onClose} testId="cto-disconnect-dialog">
      <p className="text-sm text-fg-secondary">
        Desconectar <strong className="text-fg">{conexao.customer.name}</strong> da
        porta {String(port.number).padStart(2, "0")} da CTO {cto.name}?
      </p>
      <p className="mt-2 text-xs text-fg-muted">
        O histórico do vínculo é preservado.
      </p>

      <Erro texto={erro} />

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={botao} onClick={onClose} disabled={enviando}>
          Cancelar
        </button>
        <button
          type="button"
          className={botaoPrimario}
          disabled={enviando}
          onClick={() => void confirmar()}
          data-testid="cto-disconnect-confirm"
        >
          {enviando ? "Desconectando…" : "Desconectar"}
        </button>
      </div>
    </Dialog>
  );
}
