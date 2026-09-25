"use client";

import { useRouter } from "next/navigation";
import React, { useState } from "react";
import { EVIDENCE_CATEGORY_LABELS } from "@/lib/customer-timeline-presentation";
import {
  isPolicyEvidenceCategory,
  MAX_REQUIRED_EVIDENCE,
  POLICY_EVIDENCE_CATEGORIES,
} from "@/lib/evidence-category-policy";

/**
 * # Catálogo de tipos de OS + checklist de execução (PRD §382)
 *
 * A configuração do checklist morava só na API: `PUT /api/checklist-templates`
 * e `PUT /api/service-order-types/:id/completion-policy` existiam, e nenhuma
 * tela as chamava. Quem opera o provedor não configura cobertura por `curl`,
 * então na prática o §382 não tinha como ser atendido em produção.
 *
 * Esta tela NÃO é autoridade: toda ação chama a API e recarrega do servidor
 * (`router.refresh()`). Nada do estado local vira verdade, e nenhuma regra de
 * checklist é reimplementada aqui — a precedência (template do tipo → padrão da
 * empresa), a renumeração e o snapshot continuam no domínio.
 *
 * ## Duas exigências que são coisas diferentes
 *
 * Ter checklist faz o técnico VER as perguntas. Bloquear a conclusão exige,
 * além disso, `requireChecklist` na política do tipo. A tela mostra as duas,
 * separadas, porque configurar só a primeira produz um checklist que ninguém é
 * obrigado a responder.
 */

type ChecklistItemType = "BOOLEAN" | "TEXT" | "NUMBER" | "SELECT" | "PHOTO";

interface TypeRow {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  sortOrder: number;
}

interface ItemRow {
  id: string;
  label: string;
  description: string | null;
  type: ChecklistItemType;
  required: boolean;
  sortOrder: number;
  options: string[] | null;
  evidenceCategory: string | null;
}

interface TemplateRow {
  id: string;
  serviceOrderTypeId: string | null;
  name: string;
  version: number;
  active: boolean;
  items: ItemRow[];
}

interface PolicyRow {
  serviceOrderTypeId: string;
  requireChecklist: boolean;
  requireSignature: boolean;
  requireMaterials: boolean;
  requireEquipment: boolean;
  requireCheckIn: boolean;
  minEvidenceCount: number;
  requiredEvidenceCategories: string[];
}

interface Rascunho {
  label: string;
  description: string | null;
  type: ChecklistItemType;
  required: boolean;
  options: string[] | null;
  evidenceCategory: string | null;
}

const inputClass =
  "w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft";

const labelClass = "mb-1 block text-sm font-medium text-fg-secondary";

const botaoSecundario =
  "rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-fg-secondary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60";

/*
  `SELECT` fica de fora do seletor: ele exige uma lista de opções por item, que
  é um editor aninhado. O domínio continua aceitando — a API não mudou —, e
  nenhum dos tipos operacionais configurados precisa dele.
*/
const TIPOS_DE_ITEM: { valor: ChecklistItemType; rotulo: string }[] = [
  { valor: "BOOLEAN", rotulo: "Confirmação (sim/não)" },
  { valor: "TEXT", rotulo: "Texto" },
  { valor: "NUMBER", rotulo: "Número" },
  { valor: "PHOTO", rotulo: "Foto" },
];

function paraRascunho(items: ItemRow[]): Rascunho[] {
  return items.map((item) => ({
    label: item.label,
    description: item.description,
    type: item.type,
    required: item.required,
    options: item.options,
    evidenceCategory: item.evidenceCategory,
  }));
}

function ChecklistEditor({
  escopo,
  serviceOrderTypeId,
  template,
  nomeSugerido,
}: {
  escopo: string;
  serviceOrderTypeId: string | null;
  template: TemplateRow | undefined;
  nomeSugerido: string;
}) {
  const router = useRouter();
  const [nome, setNome] = useState(template?.name ?? nomeSugerido);
  const [itens, setItens] = useState<Rascunho[]>(
    template ? paraRascunho(template.items) : [],
  );
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  function alterar(indice: number, mudanca: Partial<Rascunho>) {
    setItens((atual) =>
      atual.map((item, i) => (i === indice ? { ...item, ...mudanca } : item)),
    );
  }

  function mover(indice: number, direcao: -1 | 1) {
    const destino = indice + direcao;
    if (destino < 0 || destino >= itens.length) return;
    setItens((atual) => {
      const copia = [...atual];
      [copia[indice], copia[destino]] = [copia[destino], copia[indice]];
      return copia;
    });
  }

  async function salvar() {
    setErro(null);
    setAviso(null);
    if (!nome.trim()) {
      setErro("Informe o nome do checklist.");
      return;
    }
    if (itens.length === 0) {
      setErro("Um checklist precisa de pelo menos um item.");
      return;
    }
    if (itens.some((item) => !item.label.trim())) {
      setErro("Todo item precisa de um texto.");
      return;
    }
    setSalvando(true);
    try {
      const res = await fetch("/api/checklist-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceOrderTypeId,
          name: nome.trim(),
          /*
            A ORDEM do array é a ordem do checklist: o domínio grava
            `sortOrder` pelo índice. Subir e descer item é reordenar aqui, sem
            campo de número para o operador administrar.
          */
          items: itens.map((item) => ({
            label: item.label.trim(),
            description: item.description?.trim() || null,
            type: item.type,
            required: item.required,
            options: item.type === "SELECT" ? item.options : null,
            evidenceCategory:
              item.type === "PHOTO" ? item.evidenceCategory : null,
          })),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setErro(payload?.error ?? "Falha ao salvar o checklist.");
        return;
      }
      setAviso("Checklist salvo.");
      router.refresh();
    } catch {
      setErro("Erro de conexão. Tente novamente.");
    } finally {
      setSalvando(false);
    }
  }

  async function alternarAtivo() {
    if (!template) return;
    setErro(null);
    setAviso(null);
    setSalvando(true);
    try {
      const res = await fetch("/api/checklist-templates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: template.id,
          active: !template.active,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setErro(payload?.error ?? "Falha ao alterar o checklist.");
        return;
      }
      router.refresh();
    } catch {
      setErro("Erro de conexão. Tente novamente.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="space-y-4" data-testid={`checklist-editor-${escopo}`}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <label htmlFor={`checklist-nome-${escopo}`} className={labelClass}>
            Nome do checklist
          </label>
          <input
            id={`checklist-nome-${escopo}`}
            data-testid={`checklist-name-${escopo}`}
            type="text"
            maxLength={120}
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            className={inputClass}
          />
        </div>
        {template && (
          <button
            type="button"
            onClick={() => void alternarAtivo()}
            disabled={salvando}
            data-testid={`checklist-active-${escopo}`}
            className={botaoSecundario}
          >
            {template.active ? "Desativar checklist" : "Reativar checklist"}
          </button>
        )}
      </div>

      {template && !template.active && (
        <p className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-fg-muted">
          Checklist desativado: ele não é aplicado a novas execuções enquanto
          estiver assim.
        </p>
      )}

      <ul className="space-y-3">
        {itens.map((item, indice) => (
          <li
            key={indice}
            className="rounded-xl border border-border-subtle p-3"
            data-testid={`checklist-item-${escopo}-${indice}`}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
              <div>
                <label
                  htmlFor={`item-${escopo}-${indice}`}
                  className={labelClass}
                >
                  Item {indice + 1}
                </label>
                <input
                  id={`item-${escopo}-${indice}`}
                  data-testid={`checklist-item-label-${escopo}-${indice}`}
                  type="text"
                  maxLength={200}
                  value={item.label}
                  onChange={(e) => alterar(indice, { label: e.target.value })}
                  className={inputClass}
                />
              </div>
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => mover(indice, -1)}
                  disabled={indice === 0}
                  aria-label={`Subir item ${indice + 1}`}
                  className={botaoSecundario}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => mover(indice, 1)}
                  disabled={indice === itens.length - 1}
                  aria-label={`Descer item ${indice + 1}`}
                  className={botaoSecundario}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setItens((atual) => atual.filter((_, i) => i !== indice))
                  }
                  aria-label={`Remover item ${indice + 1}`}
                  data-testid={`checklist-item-remove-${escopo}-${indice}`}
                  className={botaoSecundario}
                >
                  Remover
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4">
              <div>
                <label
                  htmlFor={`tipo-${escopo}-${indice}`}
                  className="mr-2 text-sm text-fg-secondary"
                >
                  Resposta
                </label>
                <select
                  id={`tipo-${escopo}-${indice}`}
                  value={item.type}
                  onChange={(e) =>
                    alterar(indice, {
                      type: e.target.value as ChecklistItemType,
                    })
                  }
                  className="rounded-lg border border-input-border px-2 py-1.5 text-sm text-fg"
                >
                  {TIPOS_DE_ITEM.map((tipo) => (
                    <option key={tipo.valor} value={tipo.valor}>
                      {tipo.rotulo}
                    </option>
                  ))}
                </select>
              </div>

              {item.type === "PHOTO" && (
                <div>
                  <label
                    htmlFor={`categoria-${escopo}-${indice}`}
                    className="mr-2 text-sm text-fg-secondary"
                  >
                    Categoria da foto
                  </label>
                  <select
                    id={`categoria-${escopo}-${indice}`}
                    value={item.evidenceCategory ?? ""}
                    onChange={(e) =>
                      alterar(indice, {
                        evidenceCategory: e.target.value || null,
                      })
                    }
                    className="rounded-lg border border-input-border px-2 py-1.5 text-sm text-fg"
                  >
                    <option value="">—</option>
                    {/*
                      Rótulo em português, valor canônico por baixo. A lista
                      mostrava o enum cru — "ONU_ONT" — para quem configura o
                      catálogo, e nome interno na tela é vocabulário do banco
                      vazando para o operador.
                    */}
                    {POLICY_EVIDENCE_CATEGORIES.map((categoria) => (
                      <option key={categoria} value={categoria}>
                        {EVIDENCE_CATEGORY_LABELS[categoria]}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <label className="flex items-center gap-2 text-sm text-fg-secondary">
                <input
                  type="checkbox"
                  checked={item.required}
                  data-testid={`checklist-item-required-${escopo}-${indice}`}
                  onChange={(e) =>
                    alterar(indice, { required: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-input-border"
                />
                Obrigatório
              </label>
            </div>
          </li>
        ))}
      </ul>

      {itens.length === 0 && (
        <p className="text-sm text-fg-muted">
          Nenhum item ainda. Acrescente o primeiro para salvar o checklist.
        </p>
      )}

      {erro && (
        <div
          role="alert"
          className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {erro}
        </div>
      )}
      {aviso && (
        <p
          role="status"
          className="rounded-lg border border-border bg-success-bg px-3 py-2 text-sm text-success-fg"
        >
          {aviso}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            setItens((atual) => [
              ...atual,
              {
                label: "",
                description: null,
                type: "BOOLEAN",
                required: true,
                options: null,
                evidenceCategory: null,
              },
            ])
          }
          data-testid={`checklist-add-item-${escopo}`}
          className={botaoSecundario}
        >
          Acrescentar item
        </button>
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          data-testid={`checklist-save-${escopo}`}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {salvando ? "Salvando..." : "Salvar checklist"}
        </button>
      </div>
    </div>
  );
}

/** Os cinco interruptores, na ordem em que o atendimento acontece. */
const EXIGENCIAS: {
  campo:
    | "requireCheckIn"
    | "requireChecklist"
    | "requireEquipment"
    | "requireMaterials"
    | "requireSignature";
  rotulo: string;
  ajuda: string;
}[] = [
  {
    campo: "requireCheckIn",
    rotulo: "Exigir check-in no local",
    ajuda: "O técnico precisa registrar a chegada antes de concluir.",
  },
  {
    campo: "requireChecklist",
    rotulo: "Exigir checklist preenchido",
    ajuda: "Todo item obrigatório do checklist precisa estar respondido.",
  },
  {
    campo: "requireEquipment",
    rotulo: "Exigir equipamento instalado",
    ajuda: "Ao menos um equipamento precisa estar registrado na OS.",
  },
  {
    campo: "requireMaterials",
    rotulo: "Exigir material utilizado",
    ajuda: "Ao menos um material precisa estar registrado na OS.",
  },
  {
    campo: "requireSignature",
    rotulo: "Exigir assinatura do cliente",
    ajuda: "A OS não fecha sem a assinatura colhida no aparelho.",
  },
];

/** O rascunho local do painel: os mesmos campos que a API grava. */
interface RascunhoPolitica {
  requireChecklist: boolean;
  requireSignature: boolean;
  requireMaterials: boolean;
  requireEquipment: boolean;
  requireCheckIn: boolean;
  minEvidenceCount: number;
  requiredEvidenceCategories: string[];
}

function rascunhoDaPolitica(policy: PolicyRow | undefined): RascunhoPolitica {
  /*
    Tipo SEM política é "não exige nada" — é o que
    `validateServiceOrderCompletion` faz ao sair depois do relatório quando não
    encontra linha. O painel mostra isso como tudo desmarcado, que é a verdade,
    e não como um estado especial de "não configurado".
  */
  return {
    requireChecklist: policy?.requireChecklist ?? false,
    requireSignature: policy?.requireSignature ?? false,
    requireMaterials: policy?.requireMaterials ?? false,
    requireEquipment: policy?.requireEquipment ?? false,
    requireCheckIn: policy?.requireCheckIn ?? false,
    minEvidenceCount: policy?.minEvidenceCount ?? 0,
    requiredEvidenceCategories: policy?.requiredEvidenceCategories ?? [],
  };
}

/**
 * O que este tipo de OS exige para o técnico conseguir concluir.
 *
 * A tela é CONFIGURAÇÃO — ela não decide nada. Quem responde "esta OS pode
 * fechar?" continua sendo `validateServiceOrderCompletion`, no servidor, e é o
 * mesmo motor que o Field consulta e que o fechamento executa dentro da
 * transação. Reproduzir qualquer pedaço dessa regra aqui criaria uma segunda
 * autoridade, e a que divergisse seria a que ninguém revisou.
 *
 * A política é SUBSTITUÍDA por inteiro pela API, então o painel envia SEMPRE
 * os sete campos. É a mesma armadilha da §382: mandar só o que mudou apagaria
 * em silêncio o resto da configuração daquele tipo.
 */
function RequisitosEditor({
  escopo,
  serviceOrderTypeId,
  policy,
}: {
  escopo: string;
  serviceOrderTypeId: string;
  policy: PolicyRow | undefined;
}) {
  const router = useRouter();
  const [rascunho, setRascunho] = useState<RascunhoPolitica>(() =>
    rascunhoDaPolitica(policy),
  );
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  /*
    Categoria gravada que esta tela não sabe editar.

    A API recusa `EQUIPMENT_LABEL` como exigência, e a tela oferece exatamente
    a lista que ela aceita. Mas uma linha gravada por fora pode carregar um
    valor fora dessa lista, e reenviar sem ele seria apagá-lo em silêncio — o
    defeito que esta fase existe para não repetir. Então a tela DIZ o que vai
    acontecer, em vez de decidir sozinha.
  */
  const foraDaLista = rascunho.requiredEvidenceCategories.filter(
    (c) => !isPolicyEvidenceCategory(c),
  );

  function alterar(mudanca: Partial<RascunhoPolitica>) {
    setAviso(null);
    setRascunho((atual) => ({ ...atual, ...mudanca }));
  }

  function alternarCategoria(categoria: string, marcada: boolean) {
    alterar({
      requiredEvidenceCategories: marcada
        ? [...rascunho.requiredEvidenceCategories, categoria]
        : rascunho.requiredEvidenceCategories.filter((c) => c !== categoria),
    });
  }

  async function salvar() {
    setErro(null);
    setAviso(null);

    /*
      Validação local é UX, não autoridade: ela evita uma ida ao servidor para
      dizer o óbvio. Quem recusa de verdade é o `zod` da rota, e há teste
      provando isso pela porta da API.
    */
    if (
      !Number.isInteger(rascunho.minEvidenceCount) ||
      rascunho.minEvidenceCount < 0 ||
      rascunho.minEvidenceCount > MAX_REQUIRED_EVIDENCE
    ) {
      setErro(
        `A quantidade mínima de fotos deve ser um número inteiro entre 0 e ${MAX_REQUIRED_EVIDENCE}.`,
      );
      return;
    }

    setSalvando(true);
    try {
      const res = await fetch(
        `/api/service-order-types/${serviceOrderTypeId}/completion-policy`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requireChecklist: rascunho.requireChecklist,
            requireSignature: rascunho.requireSignature,
            requireMaterials: rascunho.requireMaterials,
            requireEquipment: rascunho.requireEquipment,
            requireCheckIn: rascunho.requireCheckIn,
            minEvidenceCount: rascunho.minEvidenceCount,
            requiredEvidenceCategories:
              rascunho.requiredEvidenceCategories.filter(
                isPolicyEvidenceCategory,
              ),
          }),
        },
      );
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        // O rascunho NÃO é descartado: quem acabou de marcar cinco exigências
        // não pode perdê-las por uma falha de rede.
        setErro(payload?.error ?? "Falha ao salvar os requisitos.");
        return;
      }
      // O sucesso só é dito DEPOIS da confirmação do servidor.
      setAviso("Requisitos salvos.");
      router.refresh();
    } catch {
      setErro("Erro de conexão. Tente novamente.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="space-y-4" data-testid={`requisitos-editor-${escopo}`}>
      <p className="text-sm text-fg-muted">
        O técnico só consegue concluir uma OS deste tipo depois de cumprir o que
        estiver marcado aqui. Nada marcado significa que o relatório do
        atendimento basta.
      </p>

      <div className="space-y-2">
        {EXIGENCIAS.map(({ campo, rotulo, ajuda }) => (
          <label
            key={campo}
            className="flex items-start gap-2 text-sm text-fg-secondary"
          >
            <input
              type="checkbox"
              checked={rascunho[campo]}
              disabled={salvando}
              data-testid={`requisito-${campo}-${escopo}`}
              onChange={(e) => alterar({ [campo]: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-input-border"
            />
            <span>
              <span className="font-medium text-fg">{rotulo}</span>
              <span className="block text-xs text-fg-muted">{ajuda}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="border-t border-border-subtle pt-4">
        <h4 className="text-sm font-semibold text-fg">Fotos</h4>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label
            htmlFor={`min-fotos-${escopo}`}
            className="text-sm text-fg-secondary"
          >
            Quantidade mínima
          </label>
          <input
            id={`min-fotos-${escopo}`}
            type="number"
            min={0}
            max={MAX_REQUIRED_EVIDENCE}
            step={1}
            value={rascunho.minEvidenceCount}
            disabled={salvando}
            data-testid={`requisito-min-fotos-${escopo}`}
            onChange={(e) =>
              alterar({ minEvidenceCount: Number(e.target.value) })
            }
            className="w-20 rounded-lg border border-input-border px-2 py-1.5 text-sm text-fg"
          />
          <span className="text-xs text-fg-muted">
            0 significa sem mínimo. Máximo {MAX_REQUIRED_EVIDENCE}.
          </span>
        </div>

        <fieldset className="mt-4">
          <legend className="text-sm text-fg-secondary">
            Categorias obrigatórias
          </legend>
          <p className="mb-2 text-xs text-fg-muted">
            Cada categoria marcada exige ao menos uma foto daquele tipo, além da
            quantidade mínima acima.
          </p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {POLICY_EVIDENCE_CATEGORIES.map((categoria) => (
              <label
                key={categoria}
                className="flex items-center gap-2 text-sm text-fg-secondary"
              >
                <input
                  type="checkbox"
                  checked={rascunho.requiredEvidenceCategories.includes(
                    categoria,
                  )}
                  disabled={salvando}
                  data-testid={`requisito-categoria-${categoria}-${escopo}`}
                  onChange={(e) =>
                    alternarCategoria(categoria, e.target.checked)
                  }
                  className="h-4 w-4 rounded border-input-border"
                />
                {EVIDENCE_CATEGORY_LABELS[categoria]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {foraDaLista.length > 0 && (
        <p
          role="alert"
          data-testid={`requisitos-fora-da-lista-${escopo}`}
          className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning-fg"
        >
          Este tipo exige uma categoria que esta tela não edita (
          {foraDaLista
            .map(
              (c) =>
                EVIDENCE_CATEGORY_LABELS[
                  c as keyof typeof EVIDENCE_CATEGORY_LABELS
                ] ?? c,
            )
            .join(", ")}
          ). Salvar por aqui vai remover essa exigência.
        </p>
      )}

      {erro && (
        <p
          role="alert"
          data-testid={`requisitos-erro-${escopo}`}
          className="text-sm text-danger-fg"
        >
          {erro}
        </p>
      )}
      {aviso && (
        <p
          role="status"
          data-testid={`requisitos-aviso-${escopo}`}
          className="text-sm text-success-fg"
        >
          {aviso}
        </p>
      )}

      <button
        type="button"
        onClick={() => void salvar()}
        disabled={salvando}
        data-testid={`requisitos-save-${escopo}`}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {salvando ? "Salvando..." : "Salvar requisitos"}
      </button>
    </div>
  );
}

export function ServiceOrderTypeManager({
  types,
  templates,
  policies,
}: {
  types: TypeRow[];
  templates: TemplateRow[];
  policies: PolicyRow[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [aberto, setAberto] = useState<string | null>(null);
  // Painel próprio: quem está configurando requisitos não quer o editor de
  // checklist aberto junto, e vice-versa.
  const [requisitosAbertosId, setRequisitosAbertos] = useState<
    string | null
  >(null);
  const [padraoAberto, setPadraoAberto] = useState(false);

  const padrao = templates.find((t) => t.serviceOrderTypeId === null);
  const porTipo = new Map(
    templates
      .filter((t) => t.serviceOrderTypeId)
      .map((t) => [t.serviceOrderTypeId as string, t]),
  );
  const politicaPorTipo = new Map(
    policies.map((p) => [p.serviceOrderTypeId, p]),
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Informe o nome do tipo.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/service-order-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          sortOrder: Number(sortOrder) || 0,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao criar o tipo.");
        return;
      }
      setName("");
      setDescription("");
      setSortOrder("0");
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(type: TypeRow) {
    setError(null);
    setPendingId(type.id);
    try {
      const res = await fetch(`/api/service-order-types/${type.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !type.active }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao atualizar o tipo.");
        return;
      }
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setPendingId(null);
    }
  }

  /**
   * A política é SUBSTITUÍDA por inteiro pela API — um patch parcial obrigaria
   * a decidir o que um campo ausente significa. Então a tela lê a política
   * gravada e reenvia TODOS os campos, trocando só `requireChecklist`: sem
   * isso, marcar a exigência de checklist apagaria em silêncio a exigência de
   * assinatura, de evidência e de equipamento daquele tipo.
   */
  async function alternarExigencia(type: TypeRow) {
    setError(null);
    setPendingId(type.id);
    const atual = politicaPorTipo.get(type.id);
    const corpo = {
      requireChecklist: !(atual?.requireChecklist ?? false),
      requireSignature: atual?.requireSignature ?? false,
      requireMaterials: atual?.requireMaterials ?? false,
      requireEquipment: atual?.requireEquipment ?? false,
      requireCheckIn: atual?.requireCheckIn ?? false,
      minEvidenceCount: atual?.minEvidenceCount ?? 0,
      requiredEvidenceCategories: atual?.requiredEvidenceCategories ?? [],
    };
    try {
      const res = await fetch(
        `/api/service-order-types/${type.id}/completion-policy`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(corpo),
        },
      );
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao atualizar a exigência.");
        return;
      }
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setPendingId(null);
    }
  }

  function resumoDoChecklist(type: TypeRow) {
    const proprio = porTipo.get(type.id);
    if (proprio?.active) {
      const obrigatorios = proprio.items.filter((i) => i.required).length;
      return `${proprio.items.length} itens · ${obrigatorios} obrigatórios`;
    }
    if (padrao?.active) return "Padrão da empresa";
    return "Sem checklist";
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-fg">
              Checklist padrão da empresa
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-fg-muted">
              Usado quando o tipo de OS não tem checklist próprio e nas ordens
              importadas ou sem tipo. Nas ordens sem tipo ele aparece como
              orientação: a exigência de conclusão é configurada por tipo, então
              só uma OS com tipo pode ser bloqueada por checklist.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setPadraoAberto((v) => !v)}
            data-testid="checklist-configure-default"
            className={botaoSecundario}
          >
            {padraoAberto ? "Fechar" : "Configurar"}
          </button>
        </div>

        <p className="mt-3 text-sm text-fg-secondary">
          {padrao
            ? padrao.active
              ? `${padrao.items.length} itens configurados.`
              : "Configurado, mas desativado."
            : "Nenhum checklist padrão configurado."}
        </p>

        {padraoAberto && (
          <div className="mt-4 border-t border-border-subtle pt-4">
            <ChecklistEditor
              escopo="default"
              serviceOrderTypeId={null}
              template={padrao}
              nomeSugerido="Checklist padrão da empresa"
            />
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">Novo tipo</h2>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
            <div>
              <label htmlFor="name" className={labelClass}>
                Nome *
              </label>
              <input
                id="name"
                type="text"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
                placeholder="Ex.: Instalação"
              />
            </div>
            <div className="sm:w-28">
              <label htmlFor="sortOrder" className={labelClass}>
                Ordem
              </label>
              <input
                id="sortOrder"
                type="number"
                min={0}
                max={9999}
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label htmlFor="description" className={labelClass}>
              Descrição
            </label>
            <input
              id="description"
              type="text"
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputClass}
              placeholder="Opcional"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating ? "Criando..." : "Criar tipo"}
          </button>
        </form>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-border bg-surface-subtle text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th className="px-4 py-3">Nome</th>
                <th className="px-4 py-3">Ordem</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Checklist</th>
                <th className="px-4 py-3">Exigir para concluir</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {types.map((type) => {
                const politica = politicaPorTipo.get(type.id);
                const expandido = aberto === type.id;
                const requisitosAbertos = requisitosAbertosId === type.id;
                return (
                  <React.Fragment key={type.id}>
                    <tr className="border-b border-border-subtle">
                      <td className="px-4 py-3 font-medium text-fg">
                        {type.name}
                        {type.description && (
                          <span className="block text-xs font-normal text-fg-muted">
                            {type.description}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-fg-muted">
                        {type.sortOrder}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            type.active
                              ? "rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold text-success-fg"
                              : "rounded-full bg-surface-muted px-2 py-0.5 text-xs font-semibold text-fg-muted"
                          }
                        >
                          {type.active ? "Ativo" : "Inativo"}
                        </span>
                      </td>
                      <td
                        className="px-4 py-3 text-fg-muted"
                        data-testid={`checklist-summary-${type.id}`}
                      >
                        {resumoDoChecklist(type)}
                      </td>
                      <td className="px-4 py-3">
                        <label className="flex items-center gap-2 text-sm text-fg-secondary">
                          <input
                            type="checkbox"
                            checked={politica?.requireChecklist ?? false}
                            disabled={pendingId === type.id}
                            data-testid={`policy-require-checklist-${type.id}`}
                            onChange={() => void alternarExigencia(type)}
                            className="h-4 w-4 rounded border-input-border"
                          />
                          <span className="sr-only">
                            Exigir checklist para concluir {type.name}
                          </span>
                        </label>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setAberto(expandido ? null : type.id)
                            }
                            data-testid={`checklist-configure-${type.id}`}
                            className={botaoSecundario}
                          >
                            {expandido ? "Fechar" : "Checklist"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setRequisitosAbertos(
                                requisitosAbertos ? null : type.id,
                              )
                            }
                            data-testid={`requisitos-configure-${type.id}`}
                            className={botaoSecundario}
                          >
                            {requisitosAbertos ? "Fechar" : "Requisitos"}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleActive(type)}
                            disabled={pendingId === type.id}
                            className={botaoSecundario}
                          >
                            {pendingId === type.id
                              ? "..."
                              : type.active
                                ? "Desativar"
                                : "Reativar"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandido && (
                      <tr className="border-b border-border-subtle bg-surface-subtle">
                        <td colSpan={6} className="px-4 py-4">
                          <h3 className="mb-3 text-sm font-semibold text-fg">
                            Checklist de execução — {type.name}
                          </h3>
                          <ChecklistEditor
                            escopo={type.id}
                            serviceOrderTypeId={type.id}
                            template={porTipo.get(type.id)}
                            nomeSugerido={`Checklist — ${type.name}`}
                          />
                        </td>
                      </tr>
                    )}
                    {requisitosAbertos && (
                      <tr className="border-b border-border-subtle bg-surface-subtle">
                        <td colSpan={6} className="px-4 py-4">
                          <h3 className="mb-3 text-sm font-semibold text-fg">
                            Requisitos para finalizar esta OS — {type.name}
                          </h3>
                          <RequisitosEditor
                            escopo={type.id}
                            serviceOrderTypeId={type.id}
                            policy={politica}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
