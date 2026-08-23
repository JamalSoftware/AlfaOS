"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ServiceOrderFormProps {
  customers: { id: string; name: string }[];
  types: { id: string; name: string }[];
  /** Busca no ERP só aparece quando há integração habilitada que a suporta. */
  erpLookup?: { enabled: boolean; providerLabel: string };
}

interface ErpHit {
  externalId: string;
  name: string;
  document: string | null;
  city: string | null;
  state: string | null;
  localCustomerId: string | null;
}

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

const labelClass = "mb-1 block text-sm font-medium text-slate-700";

export function ServiceOrderForm({
  customers,
  types,
  erpLookup,
}: ServiceOrderFormProps) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");

  /**
   * Clientes importados do ERP durante ESTA sessão do formulário.
   *
   * A lista veio do servidor no carregamento; um cliente importado agora não
   * está nela. Sem isto, o operador importaria e o select ficaria vazio.
   */
  const [imported, setImported] = useState<{ id: string; name: string }[]>([]);
  const [erpField, setErpField] = useState<"name" | "document" | "phone">("name");
  const [erpTerm, setErpTerm] = useState("");
  const [erpHits, setErpHits] = useState<ErpHit[] | null>(null);
  const [erpBusy, setErpBusy] = useState(false);
  const [erpError, setErpError] = useState<string | null>(null);
  const [erpNotice, setErpNotice] = useState<string | null>(null);

  const customerOptions = [...customers, ...imported];

  async function handleErpSearch() {
    setErpError(null);
    setErpNotice(null);
    if (!erpTerm.trim()) {
      setErpError("Informe um termo de busca.");
      return;
    }
    setErpBusy(true);
    try {
      // POST, não GET: o termo é dado pessoal e não pode ir na URL.
      const res = await fetch("/api/integrations/customers/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [erpField]: erpTerm }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setErpError(payload?.error ?? "Falha ao buscar no ERP.");
        setErpHits(null);
        return;
      }
      setErpHits(payload?.data?.hits ?? []);
    } catch {
      setErpError("Erro de conexão. Tente novamente.");
    } finally {
      setErpBusy(false);
    }
  }

  async function handleErpSelect(hit: ErpHit) {
    setErpError(null);
    setErpNotice(null);

    // Já existe localmente: usa o que existe em vez de reimportar.
    if (hit.localCustomerId) {
      setCustomerId(hit.localCustomerId);
      if (!customerOptions.some((c) => c.id === hit.localCustomerId)) {
        setImported((prev) => [...prev, { id: hit.localCustomerId as string, name: hit.name }]);
      }
      setErpNotice(`${hit.name} já estava cadastrado e foi selecionado.`);
      return;
    }

    setErpBusy(true);
    try {
      /**
       * Só o identificador do provider vai no corpo. Nome, documento e
       * endereço são relidos NO SERVIDOR a partir do ERP — enviá-los daqui
       * deixaria o formulário escrever no cadastro sob a aparência de
       * importação.
       */
      const res = await fetch("/api/integrations/customers/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalId: hit.externalId }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setErpError(payload?.error ?? "Falha ao importar o cliente.");
        return;
      }
      const data = payload.data;
      setImported((prev) =>
        prev.some((c) => c.id === data.customerId)
          ? prev
          : [...prev, { id: data.customerId, name: data.name }],
      );
      setCustomerId(data.customerId);
      setErpNotice(
        data.outcome === "CREATED"
          ? `${data.name} foi importado e selecionado.`
          : data.outcome === "LINKED"
            ? `${data.name} já existia no AlfaOS e foi vinculado ao ReceitaNet.`
            : `${data.name} já estava vinculado e foi selecionado.`,
      );
    } catch {
      setErpError("Erro de conexão. Tente novamente.");
    } finally {
      setErpBusy(false);
    }
  }
  const [typeId, setTypeId] = useState("");
  const [subtype, setSubtype] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!customerId) {
      setError("Selecione um cliente.");
      return;
    }
    if (!typeId) {
      setError("Selecione o tipo da OS.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/service-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId,
          typeId,
          subtype,
          description,
          priority,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao criar a OS.");
        return;
      }
      router.push(`/ordens/${payload.data.serviceOrder.id}`);
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {erpLookup?.enabled && (
        <div
          data-testid="erp-lookup"
          className="rounded-xl border border-slate-200 bg-slate-50 p-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">
            Buscar cliente no {erpLookup.providerLabel}
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Consulta somente leitura. A OS criada continua sendo interna do
            AlfaOS.
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="w-40">
              <label htmlFor="erpField" className={labelClass}>Buscar por</label>
              <select
                id="erpField"
                value={erpField}
                onChange={(e) =>
                  setErpField(e.target.value as "name" | "document" | "phone")
                }
                className={inputClass}
              >
                <option value="name">Nome</option>
                <option value="document">CPF/CNPJ</option>
                <option value="phone">Telefone</option>
              </select>
            </div>
            <div className="min-w-[200px] flex-1">
              <label htmlFor="erpTerm" className={labelClass}>Termo</label>
              <input
                id="erpTerm"
                type="text"
                maxLength={120}
                value={erpTerm}
                onChange={(e) => setErpTerm(e.target.value)}
                className={inputClass}
              />
            </div>
            <button
              type="button"
              data-testid="erp-search"
              disabled={erpBusy}
              onClick={handleErpSearch}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {erpBusy ? "Buscando..." : "Buscar"}
            </button>
          </div>

          {erpHits !== null && erpHits.length === 0 && (
            <p className="mt-3 text-sm text-slate-500">
              Nenhum cliente encontrado.
            </p>
          )}

          {erpHits !== null && erpHits.length > 0 && (
            <ul className="mt-3 space-y-2">
              {erpHits.map((hit) => (
                <li
                  key={hit.externalId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {hit.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {hit.document ?? "sem documento"}
                      {hit.city ? ` · ${hit.city}` : ""}
                      {hit.state ? `/${hit.state}` : ""}
                      {hit.localCustomerId ? " · já no AlfaOS" : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={erpBusy}
                    onClick={() => handleErpSelect(hit)}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {hit.localCustomerId ? "Selecionar" : "Importar e usar"}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {erpNotice && (
            <p data-testid="erp-notice" className="mt-3 text-sm text-emerald-700">
              {erpNotice}
            </p>
          )}
          {erpError && (
            <div
              role="alert"
              className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {erpError}
            </div>
          )}
        </div>
      )}

      <div>
        <label htmlFor="customerId" className={labelClass}>Cliente *</label>
        <select
          id="customerId"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className={inputClass}
        >
          <option value="">Selecione um cliente...</option>
          {customerOptions.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="typeId" className={labelClass}>Tipo *</label>
          <select
            id="typeId"
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className={inputClass}
            disabled={types.length === 0}
          >
            <option value="">
              {types.length === 0
                ? "Nenhum tipo cadastrado"
                : "Selecione o tipo..."}
            </option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {types.length === 0 && (
            <p className="mt-1 text-xs text-amber-700">
              Um ADMIN precisa cadastrar tipos de OS em Configurações › Tipos de
              OS antes de abrir uma ordem.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="subtype" className={labelClass}>Subtipo</label>
          <input
            id="subtype"
            type="text"
            maxLength={100}
            value={subtype}
            onChange={(e) => setSubtype(e.target.value)}
            className={inputClass}
            placeholder="Ex.: Internet lenta"
          />
        </div>
      </div>

      <div>
        <label htmlFor="description" className={labelClass}>Descrição *</label>
        <textarea
          id="description"
          required
          minLength={3}
          maxLength={2000}
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass}
          placeholder="Detalhe o problema ou o serviço a ser executado."
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="priority" className={labelClass}>Prioridade</label>
          <select
            id="priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className={inputClass}
          >
            <option value="LOW">Baixa</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">Alta</option>
            <option value="URGENT">Urgente</option>
          </select>
        </div>
        <div>
          <label htmlFor="scheduledAt" className={labelClass}>Agendamento</label>
          <input
            id="scheduledAt"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Criando..." : "Criar OS"}
        </button>
        <a
          href="/ordens"
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100"
        >
          Cancelar
        </a>
      </div>
    </form>
  );
}
