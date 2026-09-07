"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PublicCtoDetail } from "@/lib/cto";

const inputClass =
  "w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft";

const labelClass = "mb-1 block text-sm font-medium text-fg-secondary";

const STATE_LABELS: Record<string, string> = {
  FREE: "Livre",
  OCCUPIED: "Ocupada",
  RESERVED: "Reservada",
  DAMAGED: "Danificada",
};

const STATE_CLASSES: Record<string, string> = {
  FREE: "bg-success-bg text-success-text",
  OCCUPIED: "bg-info-bg text-primary-text",
  RESERVED: "bg-warning-bg text-warning-text",
  DAMAGED: "bg-danger-bg text-danger-text",
};

/**
 * Onde a mensagem de erro pertence.
 *
 * A página tem quatro ações independentes e é LONGA — a lista de portas pode
 * ter 256 linhas. Um bloco único de erro no topo funcionava para quem estava
 * no topo, e desaparecia da vista de quem clicou lá embaixo. Foi assim que uma
 * recusa de redução de capacidade, respondida corretamente com 409, chegou à
 * validação humana como "cliquei e não aconteceu nada".
 *
 * Uma recusa invisível é indistinguível de um botão quebrado.
 */
type ErrorScope = "details" | "capacity" | "ports" | "photo" | "active";

interface ScopedError {
  scope: ErrorScope;
  message: string;
}

export function CtoDetailManager({ cto }: { cto: PublicCtoDetail }) {
  const router = useRouter();
  const [error, setError] = useState<ScopedError | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState(cto.name);
  const [addressReference, setAddressReference] = useState(
    cto.addressReference ?? "",
  );
  const [notes, setNotes] = useState(cto.notes ?? "");
  const [latitude, setLatitude] = useState(cto.latitude ?? "");
  const [longitude, setLongitude] = useState(cto.longitude ?? "");
  const [capacity, setCapacity] = useState(String(cto.capacity));

  /**
   * A mensagem da seção, ou nada.
   *
   * É uma FUNÇÃO que devolve JSX, e não um componente declarado aqui dentro. A
   * primeira versão era um componente interno (`function SectionError(...)`), e
   * ele não renderizava: declarado dentro do pai, ele é uma referência nova a
   * cada render, o React o trata como outro tipo de componente e desmonta e
   * remonta o nó — e a mensagem, que só existe entre dois renders, não
   * sobrevivia a esse ciclo. O campo voltava ao valor autoritativo, provando
   * que o handler rodara, e o erro não aparecia.
   *
   * Chamá-la (`sectionError("capacity")`) em vez de montá-la (`<SectionError/>`)
   * a torna o que ela sempre foi: um trecho de JSX condicional.
   *
   * `role="alert"` é o padrão que o resto do AlfaOS usa: leitores de tela
   * anunciam sem precisar de foco, e a mensagem não depende de cor para ser
   * percebida — tem borda, fundo e texto próprios.
   */
  function sectionError(scope: ErrorScope) {
    if (error?.scope !== scope) return null;
    return (
      <p
        className="mt-4 rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text"
        role="alert"
        data-testid={`cto-${scope}-error`}
      >
        {error.message}
      </p>
    );
  }

  async function send(
    scope: ErrorScope,
    url: string,
    body: unknown,
    method = "POST",
  ) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        /*
          A mensagem vem do servidor, e é ele quem decide o que é seguro dizer.
          O domínio já responde em português, sem id, sem SQL e sem detalhe
          interno — repassá-la é melhor que reescrevê-la aqui, onde a razão da
          recusa não é conhecida.
        */
        setError({
          scope,
          message: payload?.error ?? "Não foi possível concluir a operação.",
        });
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError({ scope, message: "Erro de conexão. Tente novamente." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDetails(e: React.FormEvent) {
    e.preventDefault();
    const hasLat = latitude.trim().length > 0;
    const hasLon = longitude.trim().length > 0;
    if (hasLat !== hasLon) {
      setError({ scope: "details", message: "Informe latitude e longitude juntas, ou nenhuma das duas." });
      return;
    }
    /*
      Texto que não é número FINITO precisa ser barrado AQUI, e a razão é do
      transporte, não da tela.

      `JSON.stringify` converte `NaN` **e** `Infinity` em `null`. O servidor
      recebe `null`, que é a forma legítima de dizer "remova a coordenada" — e
      não tem como distinguir uma da outra. Mandar o valor cru transformaria
      "digitei errado" em "apague as coordenadas", em silêncio e com resposta
      200.

      A primeira versão desta guarda usava `Number.isNaN`, o que fechava
      `"abc"` e deixava `"Infinity"` passar inteiro — `Number.isNaN(Infinity)`
      é `false`. `Number.isFinite` cobre os dois, e é o único predicado que
      corresponde ao que o `JSON.stringify` de fato descarta.
    */
    const lat = hasLat ? Number(latitude) : null;
    const lon = hasLon ? Number(longitude) : null;
    if ((hasLat && !Number.isFinite(lat)) || (hasLon && !Number.isFinite(lon))) {
      setError({ scope: "details", message: "Latitude e longitude devem ser números válidos." });
      return;
    }
    await send(
      "details",
      `/api/ctos/${cto.id}`,
      {
        name,
        addressReference: addressReference.trim() || null,
        notes: notes.trim() || null,
        latitude: lat,
        longitude: lon,
      },
      "PATCH",
    );
  }

  async function handleCapacity(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number(capacity);
    if (!Number.isInteger(parsed) || parsed < 1) {
      setError({
        scope: "capacity",
        message: "Capacidade deve ser um número inteiro maior que zero.",
      });
      // Mesmo na recusa local o campo volta ao autoritativo: a regra é uma só,
      // e não "depende de quem recusou".
      setCapacity(String(cto.capacity));
      return;
    }
    if (parsed > 256) {
      // O teto também é verificado aqui, e não só pelo `max` do input: com a
      // validação nativa desligada (ver `noValidate`), esta é a mensagem que a
      // pessoa vê, e ela precisa dizer o limite.
      setError({
        scope: "capacity",
        message: "Capacidade máxima é 256 portas.",
      });
      setCapacity(String(cto.capacity));
      return;
    }
    const ok = await send("capacity", `/api/ctos/${cto.id}/capacity`, {
      capacity: parsed,
    });
    if (!ok) {
      /*
        A tela não pode fingir que passou.

        Recusada a mudança, a caixa continua com a capacidade que tinha, e o
        campo precisa dizer isso — junto com o motivo, que fica logo abaixo.
        Deixar o número tentado no input, com a nota acima informando outro
        valor, obriga a pessoa a adivinhar qual dos dois é real.
      */
      setCapacity(String(cto.capacity));
    }
  }

  async function handlePortState(portId: string, state: string) {
    await send("ports", `/api/ctos/${cto.id}/ports/${portId}/state`, {
      administrativeState: state,
    });
  }

  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/ctos/${cto.id}/photo`, {
        method: "POST",
        body: form,
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError({ scope: "photo", message: payload?.error ?? "Falha ao enviar a foto." });
        return;
      }
      router.refresh();
    } catch {
      setError({ scope: "photo", message: "Erro de conexão. Tente novamente." });
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <div className="space-y-6">
      {/*
        Ocupação é honesta: não há vínculo de cliente no produto ainda, então o
        contador de ocupadas é zero e a nota diz por quê. Inventar um número, ou
        esconder a linha, faria a tela prometer o que a CTO-1 não entrega.
      */}
      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">Ocupação</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <div>
            <dt className="text-xs text-fg-muted">Capacidade</dt>
            <dd className="text-xl font-semibold text-fg">
              {cto.summary.capacity}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Livres</dt>
            <dd className="text-xl font-semibold text-fg" data-testid="cto-free">
              {cto.summary.free}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Reservadas</dt>
            <dd className="text-xl font-semibold text-fg">
              {cto.summary.reserved}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Danificadas</dt>
            <dd className="text-xl font-semibold text-fg">
              {cto.summary.damaged}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Ocupadas</dt>
            <dd className="text-xl font-semibold text-fg">
              {cto.summary.occupied}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-fg-muted">
          A vinculação de clientes a portas ainda não está disponível. Enquanto
          isso, nenhuma porta aparece como ocupada.
        </p>
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">Portas</h2>
        <div className="space-y-2">
          {cto.ports.map((port) => (
            <div
              key={port.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
              data-testid="cto-port-row"
            >
              <span className="w-16 text-sm font-medium text-fg">
                {String(port.number).padStart(2, "0")}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_CLASSES[port.effectiveState]}`}
                data-testid={`cto-port-state-${port.number}`}
              >
                {STATE_LABELS[port.effectiveState]}
              </span>
              {!port.offerable && port.number > cto.capacity && (
                <span
                  className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted"
                  title="Acima da capacidade atual. Mantida para preservar o histórico."
                >
                  Fora da capacidade
                </span>
              )}
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  disabled={busy || port.administrativeState === "AVAILABLE"}
                  onClick={() => handlePortState(port.id, "AVAILABLE")}
                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-40"
                >
                  Liberar
                </button>
                <button
                  type="button"
                  disabled={busy || port.administrativeState === "RESERVED"}
                  onClick={() => handlePortState(port.id, "RESERVED")}
                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-40"
                >
                  Reservar
                </button>
                <button
                  type="button"
                  disabled={busy || port.administrativeState === "DAMAGED"}
                  onClick={() => handlePortState(port.id, "DAMAGED")}
                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-40"
                >
                  Danificada
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Falha ao mudar o estado de uma porta aparece na seção das portas. */}
        {sectionError("ports")}
      </section>

      {/*
        `noValidate`: a validação nativa do navegador é DESLIGADA aqui de
        propósito.

        Com `min`/`max` no input, o navegador bloqueia o submit por conta
        própria e mostra um balão nativo — que aparece só em alguns casos,
        some sozinho, não é `role="alert"` e vem no idioma do navegador. O
        resultado era uma tela que às vezes fala pelo padrão do AlfaOS e às
        vezes pelo do Chrome, para o mesmo formulário.

        Os atributos ficam: eles dão os limites do spinner e a dica visual. O
        que sai é a interceptação do submit, para que a mensagem seja sempre a
        nossa, sempre no mesmo lugar e sempre anunciável.
      */}
      <form
        noValidate
        onSubmit={handleCapacity}
        className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
      >
        <h2 className="mb-1 text-base font-semibold text-fg">Capacidade</h2>
        {/*
          A capacidade AUTORITATIVA, escrita ao lado do campo.

          Depois de uma recusa o campo volta a este valor, e não fica no número
          tentado: um input dizendo 8 ao lado de uma caixa que tem 16 é a mesma
          ambiguidade do placeholder de coordenada — a tela mostrando um número
          que o servidor não tem.
        */}
        <p className="mb-4 text-xs text-fg-muted" data-testid="cto-capacity-current">
          Esta CTO oferece {cto.capacity} portas hoje.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <label className={labelClass} htmlFor="cto-capacity-edit">
              Portas
            </label>
            <input
              id="cto-capacity-edit"
              type="number"
              min={1}
              max={256}
              className={inputClass}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            Alterar capacidade
          </button>
        </div>

        {/* O motivo da recusa nasce AQUI, ao lado do botão que a provocou. */}
        {sectionError("capacity")}

        <p className="mt-3 text-xs text-fg-muted">
          Aumentar cria as portas que faltam. Reduzir não apaga portas: as que
          ficam acima da capacidade são preservadas como histórico e deixam de
          ser oferecidas. A redução é recusada se alguma delas estiver reservada
          ou danificada.
        </p>
      </form>

      <form
        onSubmit={handleSaveDetails}
        className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
      >
        <h2 className="mb-4 text-base font-semibold text-fg">Dados da caixa</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="cto-name-edit">
              Nome
            </label>
            <input
              id="cto-name-edit"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cto-code-view">
              Código
            </label>
            <input
              id="cto-code-view"
              className={`${inputClass} opacity-60`}
              value={cto.code ?? "—"}
              readOnly
              disabled
            />
            <p className="mt-1 text-xs text-fg-muted">
              O código não pode ser alterado depois da criação.
            </p>
          </div>
          {/*
            O placeholder NÃO pode parecer um valor gravado.

            Ele era `-23.5505199` e `-46.6333094`: coordenada real, completa e
            plausível. Tecnicamente correto — `placeholder` não é serializado e
            o banco recebia `NULL` —, e mesmo assim levou a validação humana a
            relatar que "o sistema inventou coordenada". Um exemplo que se
            parece com o dado não é exemplo, é ambiguidade.

            Agora o prefixo `ex.:` torna impossível ler como valor, e a nota
            abaixo dos campos diz explicitamente que a caixa não tem coordenada
            — a informação que faltava para desfazer a dúvida sem abrir o banco.
          */}
          <div>
            <label className={labelClass} htmlFor="cto-lat">
              Latitude
            </label>
            <input
              id="cto-lat"
              className={inputClass}
              value={latitude}
              onChange={(e) => setLatitude(e.target.value)}
              placeholder="ex.: -23.5505199"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cto-lon">
              Longitude
            </label>
            <input
              id="cto-lon"
              className={inputClass}
              value={longitude}
              onChange={(e) => setLongitude(e.target.value)}
              placeholder="ex.: -46.6333094"
            />
          </div>
          <div className="md:col-span-2 -mt-2">
            <p className="text-xs text-fg-muted" data-testid="cto-geo-state">
              {cto.latitude === null && cto.longitude === null
                ? "Esta CTO não tem coordenada cadastrada. Os campos acima estão vazios; o texto em cinza é apenas um exemplo de formato."
                : `Coordenada cadastrada: ${cto.latitude}, ${cto.longitude}.`}
            </p>
          </div>
          <div className="md:col-span-2">
            <label className={labelClass} htmlFor="cto-address-edit">
              Referência de endereço
            </label>
            <input
              id="cto-address-edit"
              className={inputClass}
              value={addressReference}
              onChange={(e) => setAddressReference(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass} htmlFor="cto-notes">
              Observações
            </label>
            <textarea
              id="cto-notes"
              className={inputClass}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          Salvar
        </button>
        {sectionError("details")}
      </form>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">Foto da caixa</h2>
        <p className="mb-3 text-sm text-fg-secondary">
          {cto.hasPhoto
            ? "Esta CTO já tem uma foto. Enviar outra substitui a atual."
            : "Nenhuma foto enviada. É opcional."}
        </p>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handlePhoto}
          disabled={busy}
          className="text-sm text-fg-secondary"
          data-testid="cto-photo-input"
        />
        {sectionError("photo")}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-2 text-base font-semibold text-fg">Situação</h2>
        <p className="mb-4 text-sm text-fg-secondary">
          Inativar mantém a caixa e todo o histórico dela. Não existe exclusão
          de CTO.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            send("active", `/api/ctos/${cto.id}/active`, { active: !cto.active })
          }
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-60"
        >
          {cto.active ? "Inativar CTO" : "Reativar CTO"}
        </button>
        {sectionError("active")}
      </section>
    </div>
  );
}
