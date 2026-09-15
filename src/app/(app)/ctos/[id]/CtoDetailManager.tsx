"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  connectivityAge,
  connectivityPresentation,
  type ConnectivityTone,
} from "@/lib/connectivity-presentation";
import type { CtoClientConnectivity } from "@/lib/cto-client-connectivity";
import {
  CTO_PORT_CUSTOMER_FILTERS,
  CTO_PORT_FILTER_LABELS,
  CTO_PORT_OCCUPANCY_FILTERS,
  countPortFilters,
  portMatchesFilter,
  type CtoPortFilter,
} from "@/lib/cto-port-filters";
import type { OperationalCtoDetail } from "@/lib/cto-read-model";
import { PortConnectionPanel } from "./PortConnectionPanel";

/** O selo de conectividade: borda, fundo e texto do MESMO tom — nunca só cor. */
const CONNECTIVITY_TONE_CLASSES: Record<ConnectivityTone, string> = {
  success: "border-success-border bg-success-bg text-success-fg",
  danger: "border-danger-border bg-danger-bg text-danger-fg",
  neutral: "border-neutral-border bg-neutral-bg text-neutral-fg",
};

/*
  A classe do campo é montada em DUAS partes, e a separação é necessária.

  Concatenar `border-danger-border` a uma base que já traz
  `border-input-border` não pinta a borda de vermelho: as duas produzem
  `border-color`, e quem vence é a ordem em que o Tailwind as emite no CSS, não
  a ordem na string de classes. O campo em erro ficava com `aria-invalid="true"`
  e borda cinza — visualmente idêntico a um campo correto.

  Separando a base da borda, só uma das duas entra em cada render, e não há
  conflito a resolver.
*/
const inputBaseClass =
  "w-full rounded-lg border px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2";
const inputNormalClass = "border-input-border focus:border-focus focus:ring-focus-soft";
const inputClass = `${inputBaseClass} ${inputNormalClass}`;

const labelClass = "mb-1 block text-sm font-medium text-fg-secondary";

const STATE_LABELS: Record<string, string> = {
  FREE: "Livre",
  OCCUPIED: "Ocupada",
  RESERVED: "Reservada",
  DAMAGED: "Danificada",
};

const STATE_CLASSES: Record<string, string> = {
  FREE: "bg-success-bg text-success-fg",
  OCCUPIED: "bg-info-bg text-primary-text",
  RESERVED: "bg-warning-bg text-warning-fg",
  DAMAGED: "bg-danger-bg text-danger-fg",
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
  /**
   * Quais campos ficam destacados. Vazio quando a recusa não é de um input.
   *
   * É uma LISTA porque o par de coordenadas é uma regra da combinação: quando
   * falta metade dele, os dois campos estão envolvidos e marcar só um apontaria
   * o dedo para o lado errado metade das vezes.
   */
  fields?: string[];
}

/**
 * A borda do campo em erro, com os tokens que o design system realmente tem.
 *
 * `danger.border` e `danger.bg` existem em `tailwind.config.ts`; `danger.text`
 * não existe, e foi exatamente uma classe inventada assim que fez a mensagem da
 * `CTO-1.5` sair preta sobre rosa e passar despercebida na validação humana.
 * Antes de escrever qualquer classe aqui, os tokens foram conferidos no config.
 */
const inputErrorClass =
  "border-danger-border bg-danger-bg ring-1 ring-danger-border focus:ring-danger-border";

export function CtoDetailManager({
  cto,
  clientes,
  renderedAt,
}: {
  cto: OperationalCtoDetail;
  /** Os clientes da caixa — RC-1D. Só leitura, o mesmo resumo do popup do mapa. */
  clientes: CtoClientConnectivity;
  /** O instante da renderização no servidor: a idade da leitura é contra ele. */
  renderedAt: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<ScopedError | null>(null);
  const [busy, setBusy] = useState(false);

  /*
    O filtro da lista de portas — RC-1D. Estado de tela e só: filtra o que a
    página já trouxe, e nada volta ao servidor.
  */
  const [filtro, setFiltro] = useState<CtoPortFilter>("ALL");
  const ocupantes = useMemo(
    () => new Map(clientes.customers.map((c) => [c.portNumber, c])),
    [clientes.customers],
  );
  const contagemDosFiltros = useMemo(
    () => countPortFilters(cto.ports, clientes.customers),
    [cto.ports, clientes.customers],
  );
  const portasVisiveis = cto.ports.filter((port) =>
    portMatchesFilter(filtro, port, ocupantes.get(port.number)),
  );
  const relogio = new Date(renderedAt);
  const inativosNasPortas = clientes.customers.filter(
    (c) => !c.customerActive,
  ).length;

  const [name, setName] = useState(cto.name);
  const [addressReference, setAddressReference] = useState(
    cto.addressReference ?? "",
  );
  const [notes, setNotes] = useState(cto.notes ?? "");
  const [latitude, setLatitude] = useState(cto.latitude ?? "");
  const [longitude, setLongitude] = useState(cto.longitude ?? "");
  const [capacity, setCapacity] = useState(String(cto.capacity));

  /** Arquivo escolhido e ainda NÃO enviado. Enviar é ação separada. */
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  /**
   * Confirmação do envio, em texto.
   *
   * A miniatura sozinha não serve como confirmação: quem substitui uma foto por
   * outra parecida não distingue as duas, e foi assim que a troca ficou
   * "funcionalmente desconhecida" na validação humana. A frase diz o que
   * aconteceu; a miniatura mostra o resultado.
   */
  const [photoOk, setPhotoOk] = useState<string | null>(null);
  /*
    A foto está cadastrada e o navegador NÃO conseguiu abri-la.

    Não é hipótese: a validação humana viu exatamente isto. A rota respondia
    200 com `image/jpeg` e o quadro ficava vazio, mostrando só o `alt` — e um
    `<img>` quebrado não é distinguível, para quem olha, de um bug de layout ou
    de uma tela ainda carregando. O estado existe porque o blob pode ser
    ilegível por razões que a rota não tem como perceber: um arquivo truncado
    por escrita parcial, um formato que aquele navegador não abre, um conteúdo
    que nunca foi imagem. A tela precisa DIZER isso e oferecer a saída, em vez
    de ficar quebrada em silêncio.
  */
  const [photoBroken, setPhotoBroken] = useState(false);

  /**
   * Confirmação da última ação administrativa de PORTA.
   *
   * Vive no mesmo nível da mensagem de vínculo, e pelo mesmo motivo: a seção de
   * portas é reconstruída pela releitura, e uma mensagem presa dentro da linha
   * desapareceria com ela. Foi esse o defeito que a `CTO-2.3` corrigiu no
   * diálogo de conflito, e repeti-lo aqui seria pagar duas vezes pela mesma
   * lição.
   */


  /** Resultado da última operação de vínculo, no nível da PÁGINA. */
  const [connectionMsg, setConnectionMsg] = useState<
    { porta: number; texto: string; tipo: "ok" | "conflito"; testId: string } | null
  >(null);

  /*
    Toda operação de vínculo termina relendo do servidor.

    Não há atualização otimista: inventar ocupação antes da confirmação
    produziria exatamente o erro que a guarda de obsolescência existe para
    evitar — uma tela afirmando um mundo que o servidor não confirmou. E é o
    mesmo caminho no sucesso e no conflito, porque nos dois casos o estado
    autoritativo mudou.
  */
  function onConnectionChanged(
    porta: number,
    mensagem: string,
    tipo: "ok" | "conflito",
  ) {
    /*
      A mensagem vive na PÁGINA, não no diálogo.

      No conflito, a releitura remove a premissa do diálogo — a porta deixa de
      estar ocupada — e ele desmonta. Uma mensagem presa lá dentro sumiria junto,
      devolvendo ao operador um clique sem resposta.
    */
    /*
      Limpar NÃO vai ao servidor.

      Abrir um diálogo apaga a confirmação anterior, e isso é estado de tela: o
      `router.refresh()` ali só acrescentava uma ida ao servidor no meio da
      interação — e uma corrida, porque a releitura podia pousar enquanto a
      pessoa montava a operação. Releitura é para quando o estado
      autoritativo MUDOU.
    */
    if (!mensagem) {
      setConnectionMsg(null);
      return;
    }

    setConnectionMsg(
      mensagem
        ? {
            porta,
            texto: mensagem,
            tipo,
            testId: tipo === "ok" ? "cto-connection-success" : "cto-connection-error",
          }
        : null,
    );
    router.refresh();
  }

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
        className="mt-4 rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg"
        role="alert"
        data-testid={`cto-${scope}-error`}
        id={`cto-${scope}-error`}
      >
        {error.message}
      </p>
    );
  }

  /** Este campo está marcado como responsável pela recusa atual? */
  function campoInvalido(nome: string) {
    return error?.fields?.includes(nome) ?? false;
  }

  /**
   * Atributos de um input que pode entrar em estado de erro.
   *
   * `aria-invalid` e `aria-describedby` juntos: o primeiro anuncia que o campo
   * está errado, o segundo diz **por quê**, apontando para a mensagem da seção.
   * Sem o segundo, um leitor de tela informa que há erro e não informa qual —
   * e a borda colorida não ajuda quem não a enxerga. A cor nunca é o único
   * sinal.
   */
  function atributosDeCampo(nome: string, scope: ErrorScope) {
    const invalido = campoInvalido(nome);
    return {
      "aria-invalid": invalido,
      "aria-describedby": invalido ? `cto-${scope}-error` : undefined,
      // Uma das duas, nunca as duas: ver a nota em `inputBaseClass`.
      className: `${inputBaseClass} ${invalido ? inputErrorClass : inputNormalClass}`,
    };
  }

  async function send(
    scope: ErrorScope,
    url: string,
    body: unknown,
    method = "POST",
  ) {
    /*
      Toda mutação apaga o feedback ANTERIOR, seja ele qual for.

      Sem isto, o banner verde de "cliente vinculado à porta 02" sobrevivia ao
      clique em "Danificada" e passava por confirmação da ação nova. Não é
      silêncio, é pior: uma mensagem ERRADA ocupando o lugar da certa, e foi
      assim que a validação humana leu o botão como quebrado.

      A mensagem mais recente é a única autoridade visual.
    */
    setError(null);
    setConnectionMsg(null);
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
          A mensagem e o CAMPO vêm do servidor, e é ele quem decide o que é
          seguro dizer. O domínio responde em português, sem id, sem SQL e sem
          detalhe interno — repassar é melhor que reescrever aqui, onde a razão
          da recusa não é conhecida.

          O campo vem do SERVIDOR, quando ele sabe qual é.

          Nada aqui interpreta o texto da mensagem para adivinhar o input — isso
          quebraria na primeira melhoria de redação. Quando `field` não vem, a
          recusa não é de um campo (uma porta reservada, um conflito de nome) e
          nenhum input é marcado.
        */
        setError({
          scope,
          message: payload?.error ?? "Não foi possível concluir a operação.",
          fields:
            typeof payload?.field === "string" ? [payload.field] : undefined,
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
      // Os DOIS marcados: o erro é da combinação, e apontar só o preenchido
      // sugeriria que o problema está nele.
      setError({
        scope: "details",
        message: "Coordenadas incompletas. Preencha latitude e longitude juntas ou deixe os dois campos vazios.",
        fields: ["latitude", "longitude"],
      });
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

    // Cada campo responde por si: quem digitou letra na latitude não deve ver a
    // longitude marcada junto.
    if (hasLat && !Number.isFinite(lat)) {
      setError({
        scope: "details",
        message: "Latitude inválida. Informe o valor correto.",
        fields: ["latitude"],
      });
      return;
    }
    if (hasLon && !Number.isFinite(lon)) {
      setError({
        scope: "details",
        message: "Longitude inválida. Informe o valor correto.",
        fields: ["longitude"],
      });
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
    /*
      UMA mensagem para a faixa inteira, e ela diz os dois limites.

      Antes eram duas: "maior que zero" para o piso e "máxima é 256 portas"
      para o teto. Quem digitou `0` ficava sabendo que precisa de mais, e não
      de quanto; quem digitou `300` descobria o teto e não o piso. A regra é uma
      só — a capacidade vive entre 1 e 256 —, e a mensagem passou a ser a
      regra, não o lado dela que foi violado.

      A verificação é local porque o formulário não tem validação nativa (ver
      `noValidate`); o servidor recusa igual, e o `CHECK` do banco também.
    */
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 256) {
      setError({
        scope: "capacity",
        message: "A capacidade deve ser um número inteiro entre 1 e 256 portas.",
      });
      // O campo volta ao autoritativo mesmo na recusa local: a regra é uma só,
      // e não "depende de quem recusou".
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

  /** O que cada estado significa para quem clicou. */
  const PORT_STATE_FEEDBACK: Record<string, string> = {
    AVAILABLE: "liberada",
    RESERVED: "reservada",
    DAMAGED: "marcada como danificada",
  };

  async function handlePortState(
    portId: string,
    state: string,
    numero: number,
  ) {
    const ok = await send("ports", `/api/ctos/${cto.id}/ports/${portId}/state`, {
      administrativeState: state,
    });
    /*
      Só o SUCESSO se anuncia.

      Numa recusa, `send` já deixou o erro da seção no lugar; acrescentar um
      verde ali seria dizer duas coisas contraditórias sobre o mesmo clique.
      E a mensagem nomeia a porta e a ação — "operação realizada" não diz à
      pessoa o que acabou de acontecer.
    */
    if (ok) {
      setConnectionMsg({
        porta: numero,
        texto: `Porta ${String(numero).padStart(2, "0")} ${PORT_STATE_FEEDBACK[state] ?? "atualizada"}.`,
        tipo: "ok",
        testId: "cto-port-state-feedback",
      });
    }
  }

  /**
   * Envia a foto escolhida. Ação separada, disparada por botão.
   *
   * Antes o envio acontecia no `onChange` do input: escolher o arquivo já o
   * subia, sem confirmação, sem estado de progresso e sem nada mudar na tela
   * além do input voltar a "Nenhum arquivo escolhido". A troca funcionava e era
   * invisível — o pior desfecho possível, porque a pessoa não sabe se deve
   * tentar de novo.
   *
   * `uploadingPhoto` desabilita o botão durante o envio, o que fecha o duplo
   * clique; a nova foto substitui a atual no servidor, e a substituição é
   * atômica do ponto de vista da linha: `setCtoPhoto` só troca a referência
   * depois de a imagem nova estar gravada, então uma falha no meio deixa a
   * anterior intacta.
   */
  async function handlePhotoUpload() {
    if (!photoFile) return;
    setError(null);
    setPhotoOk(null);
    setUploadingPhoto(true);
    setBusy(true);

    const substituindo = cto.hasPhoto;
    try {
      const form = new FormData();
      form.append("file", photoFile);
      const res = await fetch(`/api/ctos/${cto.id}/photo`, {
        method: "POST",
        body: form,
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError({
          scope: "photo",
          message: payload?.error ?? "Não foi possível enviar a foto.",
        });
        return;
      }
      setPhotoOk(
        substituindo
          ? "Foto atualizada com sucesso."
          : "Foto enviada com sucesso.",
      );
      // A foto trocou: o veredito do navegador sobre a ANTERIOR não vale mais.
      setPhotoBroken(false);
      // Limpa a escolha só no SUCESSO: se falhou, o arquivo continua
      // selecionado e a pessoa tenta de novo sem procurá-lo outra vez.
      setPhotoFile(null);
      router.refresh();
    } catch {
      setError({ scope: "photo", message: "Erro de conexão. Tente novamente." });
    } finally {
      setUploadingPhoto(false);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/*
        Ocupação é das PORTAS: as contagens vêm de `summarizePortCounts`, sobre
        o vínculo ativo real. As pessoas estão na seção seguinte.
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
        {/*
          As categorias SE SOBREPÕEM, e a tela precisa dizer isso.

          Uma porta pode ser danificada E ocupada ao mesmo tempo, então a soma
          das quatro pode passar da capacidade. Sem esta linha, quem lê "4 de 4"
          somando as colunas conclui que há erro — e um gráfico de fatias
          exclusivas estaria simplesmente errado.
        */}
        <p className="mt-3 text-xs text-fg-muted">
          Uma porta pode estar em mais de uma categoria — danificada e ocupada,
          por exemplo. A soma pode passar da capacidade.
        </p>
      </section>

      {/*
        OS CLIENTES da caixa — RC-1D.

        Separado das portas de propósito: acima é infraestrutura, aqui é gente,
        e "livres" e "online" nunca aparecem como parcelas da mesma soma (PRD
        §373). Os números são os do popup da caixa no mapa — a MESMA função
        (`getCtoOperationalSummaries`) —, e a semântica é a da PRD §372: ativos
        são os de cadastro ativo com vínculo ativo, e online, offline e sem
        leitura contam esses. Sem leitura nunca é somado a offline.

        Nada aqui é consultado no provedor: é o último snapshot conhecido.
      */}
      <section
        className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
        aria-labelledby="cto-clients-title"
        data-testid="cto-clients-summary"
      >
        <h2 id="cto-clients-title" className="mb-4 text-base font-semibold text-fg">
          Clientes
        </h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <div>
            <dt className="text-xs text-fg-muted">Ativos</dt>
            <dd
              className="text-xl font-semibold text-fg"
              data-testid="cto-clients-active"
            >
              {clientes.summary.activeCustomerCount}
            </dd>
          </div>
          {(
            [
              ["ONLINE", clientes.summary.onlineCount, "cto-clients-online"],
              ["OFFLINE", clientes.summary.offlineCount, "cto-clients-offline"],
              ["UNKNOWN", clientes.summary.unknownCount, "cto-clients-unknown"],
            ] as const
          ).map(([status, valor, testId]) => {
            const apresentacao = connectivityPresentation(status);
            return (
              <div key={status}>
                {/* Rótulo em texto, glifo e cor: o estado nunca é só cor. */}
                <dt className="flex items-center gap-1 text-xs text-fg-muted">
                  <span
                    aria-hidden="true"
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none ${CONNECTIVITY_TONE_CLASSES[apresentacao.tone]}`}
                  >
                    {apresentacao.glyph}
                  </span>
                  {apresentacao.mapLabel}
                </dt>
                <dd className="text-xl font-semibold text-fg" data-testid={testId}>
                  {valor}
                </dd>
              </div>
            );
          })}
          <div>
            <dt className="text-xs text-fg-muted">OS abertas</dt>
            <dd
              className="text-xl font-semibold text-fg"
              data-testid="cto-clients-open-orders"
            >
              {clientes.summary.openServiceOrderCount}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-fg-muted">
          Ativos são os clientes com cadastro ativo ligados a uma porta desta
          caixa. Online, offline e sem leitura vêm da última leitura conhecida de
          cada um — não da situação cadastral. Abrir esta página não consulta o
          provedor.
        </p>
        {inativosNasPortas > 0 && (
          <p
            className="mt-2 text-xs text-fg-muted"
            data-testid="cto-clients-inactive-note"
          >
            {inativosNasPortas === 1
              ? "1 porta está ocupada por cliente com cadastro inativo: ela continua ocupada e não entra nas contagens de clientes."
              : `${inativosNasPortas} portas estão ocupadas por clientes com cadastro inativo: elas continuam ocupadas e não entram nas contagens de clientes.`}
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">Portas</h2>

        {/*
          A confirmação fica ACIMA da lista, não dentro da linha.

          A lista inteira é remontada pela releitura, e uma mensagem presa na
          linha da porta desapareceria junto com ela — exatamente o defeito que
          a `CTO-2.3` corrigiu no diálogo de conflito.
        */}

        {/*
          Os filtros — RC-1D. Duas linhas, uma por unidade: PORTAS conta
          posição, CLIENTES conta cliente de cadastro ativo (o conjunto do
          resumo acima). Botões com `aria-pressed`: operáveis por teclado, e o
          selecionado é dito ao leitor de tela, não só pintado.
        */}
        <div className="mb-4 space-y-2" data-testid="cto-port-filters">
          {(
            [
              ["Portas", CTO_PORT_OCCUPANCY_FILTERS, "Filtrar a lista por ocupação da porta"],
              ["Clientes", CTO_PORT_CUSTOMER_FILTERS, "Filtrar a lista pela conectividade do cliente"],
            ] as const
          ).map(([titulo, filtros, rotuloDoGrupo]) => (
            <div
              key={titulo}
              role="group"
              aria-label={rotuloDoGrupo}
              className="flex flex-wrap items-center gap-2"
            >
              <span
                aria-hidden="true"
                className="w-16 text-[11px] font-semibold uppercase tracking-wide text-fg-muted"
              >
                {titulo}
              </span>
              {filtros.map((f) => {
                const ativo = filtro === f;
                return (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={ativo}
                    onClick={() => setFiltro(f)}
                    data-testid={`cto-port-filter-${f.toLowerCase()}`}
                    className={`inline-flex min-h-[32px] items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                      ativo
                        ? "border-primary bg-primary text-primary-fg"
                        : "border-border bg-surface text-fg-secondary hover:bg-surface-muted"
                    }`}
                  >
                    {CTO_PORT_FILTER_LABELS[f]}
                    <span className="tabular-nums">({contagemDosFiltros[f]})</span>
                  </button>
                );
              })}
            </div>
          ))}
          <p
            className="text-xs text-fg-muted"
            role="status"
            data-testid="cto-port-filter-status"
          >
            {filtro === "ALL"
              ? `Mostrando todas as ${cto.ports.length} portas.`
              : `Mostrando ${portasVisiveis.length} de ${cto.ports.length} portas — ${CTO_PORT_FILTER_LABELS[filtro]}.`}
          </p>
        </div>

        {portasVisiveis.length === 0 && (
          <p
            className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-fg-muted"
            data-testid="cto-port-filter-empty"
          >
            Nenhuma porta neste filtro.
          </p>
        )}

        <div className="space-y-2">
          {portasVisiveis.map((port) => {
            /*
              Histórica: a posição existe na linha do tempo da caixa e não na
              caixa que a empresa oferece hoje.

              A condição é só a FAIXA. Uma porta reservada dentro da capacidade
              também não é ofertável, e continua tendo de aceitar "Liberar" —
              usar `offerable` aqui trancaria toda reserva no lugar. É a mesma
              distinção que o domínio faz entre `isPortWithinCapacity` e
              `isPortOfferable`, e ela precisa ser a mesma nos dois lados.
            */
            const historica = port.number > cto.capacity;
            const acoes: Array<[string, string]> = [
              ["Liberar", "AVAILABLE"],
              ["Reservar", "RESERVED"],
              ["Danificada", "DAMAGED"],
            ];
            return (
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
                {historica && (
                  <span
                    className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted"
                    title="Acima da capacidade atual. Mantida para preservar o histórico."
                    data-testid={`cto-port-historic-${port.number}`}
                  >
                    Fora da capacidade
                  </span>
                )}
                {/*
                  As DUAS dimensões, lado a lado.

                  O selo de estado acima mostra `effectiveState`, que colapsa em
                  "Ocupada" sempre que há vínculo — de propósito, é o rótulo
                  principal. Mas colapsar não pode APAGAR: uma porta danificada
                  com cliente dentro precisa continuar dizendo que está
                  danificada, senão a operação perde justamente a informação que
                  a fez marcar a porta. Por isso o selo administrativo aparece
                  ao lado quando as duas coisas são verdade ao mesmo tempo.
                */}
                {port.occupied && port.administrativeState !== "AVAILABLE" && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_CLASSES[port.administrativeState]}`}
                    data-testid={`cto-port-admin-${port.number}`}
                  >
                    {STATE_LABELS[port.administrativeState]}
                  </span>
                )}
                {port.activeConnection && (
                  <div className="min-w-0">
                    <Link
                      href={`/clientes/${port.activeConnection.customer.id}/editar`}
                      className="text-sm font-medium text-primary-text underline-offset-2 hover:text-primary-text-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      data-testid={`cto-port-customer-${port.number}`}
                    >
                      {port.activeConnection.customer.name}
                    </Link>
                    {/*
                      CADASTRO ao lado da CONECTIVIDADE — PRD §372. Um cliente
                      inativo que ainda ocupa a porta aparece como inativo,
                      porque o cabo continua lá. "Offline" é o link, nunca a
                      situação do contrato.

                      Porta LIVRE não chega aqui: sem ocupante não existe
                      conectividade, e ela nunca diz "Sem leitura".
                    */}
                    {(() => {
                      const ocupante = ocupantes.get(port.number);
                      if (!ocupante) return null;
                      const apresentacao = connectivityPresentation(
                        ocupante.connectivityStatus,
                      );
                      const idade = connectivityAge(
                        ocupante.connectivityObservedAt,
                        relogio,
                      );
                      return (
                        <p
                          className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                          data-testid={`cto-port-client-${port.number}`}
                        >
                          <span
                            className={
                              ocupante.customerActive
                                ? "text-fg-muted"
                                : "font-medium text-neutral-fg"
                            }
                            data-testid={`cto-port-registration-${port.number}`}
                          >
                            {ocupante.customerActive
                              ? "Cadastro ativo"
                              : "Cadastro inativo"}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-medium ${CONNECTIVITY_TONE_CLASSES[apresentacao.tone]}`}
                            data-testid={`cto-port-connectivity-${port.number}`}
                            data-status={ocupante.connectivityStatus}
                          >
                            <span aria-hidden="true">{apresentacao.glyph}</span>
                            {apresentacao.mapLabel}
                          </span>
                          <span
                            className="text-fg-muted"
                            data-testid={`cto-port-reading-${port.number}`}
                          >
                            {idade
                              ? `Última leitura ${idade}`
                              : "Nenhuma leitura disponível"}
                          </span>
                          {ocupante.openServiceOrderCount > 0 && (
                            <span
                              className="rounded-full border border-warning-border bg-warning-bg px-1.5 py-px font-medium text-warning-fg"
                              data-testid={`cto-port-open-orders-${port.number}`}
                            >
                              {ocupante.openServiceOrderCount} OS aberta
                              {ocupante.openServiceOrderCount === 1 ? "" : "s"}
                            </span>
                          )}
                        </p>
                      );
                    })()}
                  </div>
                )}
                <div className="ml-auto flex flex-wrap justify-end gap-2">
                  <PortConnectionPanel
                    cto={cto}
                    port={port}
                    onChanged={onConnectionChanged}
                    feedback={
                      connectionMsg?.porta === port.number
                        ? {
                            texto: connectionMsg.texto,
                            tipo: connectionMsg.tipo,
                            testId: connectionMsg.testId,
                          }
                        : null
                    }
                  />
                  {acoes.map(([rotulo, alvo]) => (
                    <button
                      key={alvo}
                      type="button"
                      /*
                        A desabilitação da porta histórica é EXPLÍCITA e vem
                        primeiro. O servidor recusa de qualquer forma — a tela
                        não é a autoridade —, mas um botão que parece disponível
                        e responde 409 ensina a pessoa que o sistema é errático.
                      */
                      disabled={
                        busy || historica || port.administrativeState === alvo
                      }
                      onClick={() => handlePortState(port.id, alvo, port.number)}
                      title={
                        historica
                          ? "Porta fora da capacidade atual. Aumente a capacidade para voltar a operá-la."
                          : undefined
                      }
                      /*
                        O motivo não fica só no `title`, que leitor de tela não
                        anuncia de forma confiável em botão desabilitado, e não
                        fica só na opacidade, que é cor. O rótulo acessível
                        carrega a explicação inteira.
                      */
                      aria-label={
                        historica
                          ? `${rotulo} — indisponível: porta ${port.number} está fora da capacidade atual`
                          : `${rotulo} porta ${port.number}`
                      }
                      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-40"
                      data-testid={`cto-port-${alvo.toLowerCase()}-${port.number}`}
                    >
                      {rotulo}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
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
              {...atributosDeCampo("latitude", "details")}
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
              {...atributosDeCampo("longitude", "details")}
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
        {sectionError("details")}

        {/*
          A FOTO fica dentro do formulário, e antes do botão principal.

          Ela era uma seção separada, DEPOIS do "Salvar" — o operador via a ação
          de conclusão no meio da edição e ainda tinha um campo pela frente. A
          ordem agora acompanha o que a pessoa faz: percorre os campos, olha a
          foto, e só então encontra a ação que fecha o trabalho.

          O envio da foto continua tendo botão PRÓPRIO, e é `type="button"` para
          não submeter o formulário de dados junto. Os dois caminhos são
          separados no servidor — a foto é `multipart` numa rota própria, com
          auditoria própria — e unificá-los exigiria mudar o contrato da API
          para carregar arquivo no `PATCH` de JSON. A ordem visual é o que o
          operador precisava; a fusão dos dois envios seria uma mudança
          arquitetural que não paga por si.
        */}
        <div className="mt-6 border-t border-border pt-5">
          <h3 className="mb-3 text-sm font-semibold text-fg">Foto da caixa</h3>

          {cto.hasPhoto ? (
            <div className="mb-3 flex flex-wrap items-start gap-4">
              {/*
                A miniatura vem da MESMA rota autenticada que já servia os bytes
                — sessão, capability, perfil e tenant. A chave do storage nunca
                aparece no HTML; o `src` é o id da CTO, que a pessoa já conhece.

                `updatedAt` no fim da URL é o que faz a imagem trocar na tela
                depois de uma substituição: sem ele, o navegador pode reexibir a
                cópia que já tinha e a troca pareceria não ter acontecido — que
                é exatamente o defeito relatado.
              */}
              {/*
                O `<img>` permanece montado mesmo quando falha, e é isso que
                permite ao próprio navegador desmentir o diagnóstico: se um
                carregamento posterior der certo, `onLoad` devolve o quadro sem
                exigir F5. Trocar o elemento por texto no erro apagaria a única
                fonte capaz de dizer que a imagem voltou a abrir.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/ctos/${cto.id}/photo?v=${new Date(cto.updatedAt).getTime()}`}
                alt="Foto atual da CTO"
                className="h-28 w-40 rounded-lg border border-border bg-surface-muted object-cover"
                data-testid="cto-photo-preview"
                hidden={photoBroken}
                onLoad={() => setPhotoBroken(false)}
                onError={() => setPhotoBroken(true)}
              />
              {photoBroken ? (
                /*
                  O que a pessoa vê quando os bytes não abrem.

                  Diz o que houve, não esconde, e aponta a saída — o botão de
                  substituir está logo abaixo. Um quadro vazio com `alt` dentro
                  não comunica nada: foi assim que a validação humana encontrou
                  o problema e não teve como interpretá-lo.
                */
                <p
                  className="max-w-xs rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-fg"
                  role="status"
                  data-testid="cto-photo-broken"
                >
                  Não foi possível carregar a foto atual.
                  <br />
                  <span className="text-xs">
                    O arquivo cadastrado não pôde ser exibido. Envie outra
                    imagem para substituí-la.
                  </span>
                </p>
              ) : (
                <p className="text-sm text-fg-secondary">
                  Foto atual cadastrada.
                  <br />
                  <span className="text-xs text-fg-muted">
                    Enviar outra substitui esta.
                  </span>
                </p>
              )}
            </div>
          ) : (
            <p
              className="mb-3 text-sm text-fg-secondary"
              data-testid="cto-photo-empty"
            >
              Nenhuma foto enviada. É opcional.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {/*
              A `key` muda quando a CTO é regravada, o que remonta o input e o
              devolve a "Nenhum arquivo escolhido". Um `<input type="file">` é
              não-controlado: zerar o estado do React não limpa o que ele
              mostra, e o nome do arquivo já enviado ficaria na tela como se
              ainda estivesse pendente.
            */}
            <input
              key={`foto-${new Date(cto.updatedAt).getTime()}`}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
              disabled={busy}
              className="text-sm text-fg-secondary"
              data-testid="cto-photo-input"
              aria-label="Escolher foto da CTO"
            />
            {/*
              Ação EXPLÍCITA. Antes o arquivo subia só por ter sido escolhido —
              upload silencioso, sem confirmação e sem estado; o operador não
              tinha como saber se a troca acontecera.
            */}
            <button
              type="button"
              onClick={() => void handlePhotoUpload()}
              disabled={busy || photoFile === null}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-50"
              data-testid="cto-photo-submit"
            >
              {uploadingPhoto
                ? "Enviando..."
                : cto.hasPhoto
                  ? "Substituir foto"
                  : "Enviar foto"}
            </button>
          </div>

          {photoFile && !uploadingPhoto && (
            <p className="mt-2 text-xs text-fg-muted">
              Arquivo escolhido: {photoFile.name}. Clique em{" "}
              {cto.hasPhoto ? "Substituir foto" : "Enviar foto"} para enviar.
            </p>
          )}

          {photoOk && (
            <p
              className="mt-3 rounded-lg border border-success-border bg-success-bg px-4 py-3 text-sm text-success-fg"
              role="status"
              data-testid="cto-photo-success"
            >
              {photoOk}
            </p>
          )}

          {sectionError("photo")}
        </div>

        <button
          type="submit"
          disabled={busy}
          className="mt-6 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60"
          data-testid="cto-save"
        >
          Salvar alterações
        </button>
      </form>

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
