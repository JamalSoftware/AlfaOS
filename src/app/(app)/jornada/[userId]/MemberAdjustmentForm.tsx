"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

interface EntryOption {
  id: string;
  type: string;
  /** `HH:MM` já formatado no servidor — o cliente não recalcula fuso. */
  time: string;
  label: string;
}

interface MemberAdjustmentFormProps {
  userId: string;
  /** Dia operacional em `AAAA-MM-DD`, como o servidor o resolveu. */
  date: string;
  /** Deslocamento do fuso da EMPRESA naquele dia, como `-03:00`. */
  offset: string;
  entries: EntryOption[];
}

/**
 * Um identificador aceito pelo servidor (`[A-Za-z0-9._:-]`, 8–200).
 *
 * `randomUUID` não existe em contexto não seguro; o `Math.random` de reserva
 * não precisa ser criptográfico, porque a chave não autoriza nada — ela só
 * distingue submissões, e o escopo dela já é `(empresa, gestor, operação)`.
 */
function novaChave(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const ENTRY_TYPES = [
  { value: "CLOCK_IN", label: "Entrada" },
  { value: "BREAK_START", label: "Início do intervalo" },
  { value: "BREAK_END", label: "Retorno do intervalo" },
  { value: "CLOCK_OUT", label: "Saída" },
];

/**
 * Abre uma correção na jornada de um funcionário.
 *
 * ## O gestor não edita a marcação
 *
 * Este formulário cria um **pedido**, com `status = PENDING`, que cai na mesma
 * fila "Correções aguardando decisão" dos pedidos abertos pelo aplicativo. A
 * marcação original continua intacta até alguém aprovar — e, quando aprovar,
 * ela continua no histórico, superada e visível (PRD §229).
 *
 * Por isso o botão diz **solicitar**, e não "salvar": prometer edição direta
 * numa tela cuja gravação é um pedido seria mentir sobre o que acontece.
 */
export function MemberAdjustmentForm({
  userId,
  date,
  offset,
  entries,
}: MemberAdjustmentFormProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targetEntryId, setTargetEntryId] = useState("");
  const [entryType, setEntryType] = useState("CLOCK_IN");
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
    A chave da SUBMISSÃO LÓGICA, não da requisição.

    Mesma intenção — duplo clique, reenvio depois de um timeout, o gestor
    apertando de novo porque a tela pareceu travada — carrega a MESMA chave, e
    o servidor abre um pedido só.

    Mudou o que está sendo pedido, muda a assinatura e nasce chave nova: uma
    correção realmente diferente é outro comando, e reaproveitar a chave dela
    receberia `IDEMPOTENCY_CONFLICT` por conteúdo divergente — travando
    justamente o pedido legítimo.

    Fica em `ref`, e não em estado: trocá-la não redesenha nada, e um
    `useState` aqui provocaria uma renderização no meio do envio.
  */
  const chave = useRef<{ assinatura: string; valor: string } | null>(null);

  function chaveDe(assinatura: string): string {
    if (chave.current?.assinatura !== assinatura) {
      chave.current = { assinatura, valor: novaChave() };
    }
    return chave.current.valor;
  }

  /** Ao escolher uma marcação existente, o tipo e a hora partem dela. */
  function pickTarget(id: string) {
    setTargetEntryId(id);
    const found = entries.find((entry) => entry.id === id);
    if (found) {
      setEntryType(found.type);
      setTime(found.time);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!time) {
      setError("Informe o horário correto.");
      return;
    }
    if (reason.trim().length === 0) {
      setError("Descreva o motivo da correção.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      /*
        O horário digitado é do fuso da EMPRESA, não do navegador.

        O deslocamento vem do servidor, calculado para AQUELE dia. Montar o
        instante sem ele faria um gestor noutro fuso — ou um navegador com o
        relógio em outra região — abrir a correção para uma hora diferente da
        que digitou, sem nada na tela denunciar.
      */
      const requestedOccurredAt = new Date(`${date}T${time}:00${offset}`);
      if (Number.isNaN(requestedOccurredAt.getTime())) {
        setError("Horário inválido.");
        setSaving(false);
        return;
      }

      const payload = {
        requestedType: targetEntryId ? "WRONG_TIME" : "MISSING_ENTRY",
        requestedEntryType: entryType,
        requestedOccurredAt: requestedOccurredAt.toISOString(),
        reason: reason.trim(),
        targetEntryId: targetEntryId || null,
      };

      const res = await fetch(`/api/time-clock/members/${userId}/adjustments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": chaveDe(JSON.stringify(payload)),
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        // Intenção cumprida: um pedido igual, depois disto, é outro comando e
        // merece chave nova. Sem isto, corrigir a MESMA marcação de novo — o
        // gestor errou o horário duas vezes — receberia o desfecho guardado do
        // primeiro pedido em vez de abrir o segundo.
        chave.current = null;
        setOpen(false);
        setTargetEntryId("");
        setTime("");
        setReason("");
        router.refresh();
        return;
      }

      /*
        A recusa do servidor FICA na tela.

        Fechar o formulário aqui faria a tela dizer "pronto" para um pedido que
        o servidor não aceitou — e o gestor descobriria só ao não encontrar nada
        na fila.
      */
      const recusa = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(recusa.error ?? "Não foi possível abrir a correção.");
    } catch {
      setError("Falha de rede. Tente de novo.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="open-member-adjustment"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-fg"
      >
        Solicitar correção
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      data-testid="member-adjustment-form"
      className="space-y-4 rounded-lg border border-border p-4"
    >
      <div>
        <label
          htmlFor="adjustment-target"
          className="block text-sm font-medium text-fg"
        >
          Marcação
        </label>
        <select
          id="adjustment-target"
          value={targetEntryId}
          onChange={(event) => pickTarget(event.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
        >
          <option value="">Marcação que faltou (incluir)</option>
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label} às {entry.time}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="adjustment-type"
            className="block text-sm font-medium text-fg"
          >
            Deveria ser
          </label>
          <select
            id="adjustment-type"
            value={entryType}
            onChange={(event) => setEntryType(event.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
          >
            {ENTRY_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="adjustment-time"
            className="block text-sm font-medium text-fg"
          >
            Horário correto
          </label>
          <input
            id="adjustment-time"
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="adjustment-reason"
          className="block text-sm font-medium text-fg"
        >
          Motivo
        </label>
        <input
          id="adjustment-reason"
          type="text"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Por que esta jornada precisa ser corrigida"
          className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
        />
      </div>

      {error && (
        <p data-testid="member-adjustment-error" className="text-sm text-danger-fg">
          {error}
        </p>
      )}

      <p className="text-xs text-fg-muted">
        A correção entra como pedido pendente. A marcação original não é
        alterada, e a aprovação continua sendo uma decisão à parte.
      </p>

      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="submit-member-adjustment"
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg disabled:opacity-60"
        >
          {saving ? "Enviando…" : "Solicitar correção"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-fg"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
