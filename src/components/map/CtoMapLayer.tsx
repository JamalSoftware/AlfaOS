"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { BoundingBox, CtoMapView } from "@/lib/cto-map";
import {
  CTO_MAP_SEARCH_MAX_QUERY,
  CTO_MAP_STATUS_PRESENTATION as CTO_MAP_LEGEND,
  CTO_MAP_SEARCH_MIN_QUERY,
  CTO_MAP_VIEWPORT_DEBOUNCE_MS,
  boundingBoxToQuery,
  createLatestRequestGuard,
  usefulSearchLength,
} from "@/lib/cto-map-presentation";
import type { MapInitialView, MapTilesConfig } from "@/lib/map-config";
/*
  Do .mjs PURO, pela mesma razão de sempre: `map-config` importa `prisma`, e um
  valor importado dele num componente de cliente arrastaria o Prisma para o
  bundle do navegador. Foi o que a `DQ-4` pagou com a página de login inteira,
  e o que a `CTO-3.2.1b` quase repetiu ao centralizar constantes de zoom.
*/
import { MAP_LABEL_MIN_ZOOM } from "@/lib/map-tiles.config.mjs";
import { nextMapActivityStep } from "@/lib/map-activity-indicator";
import {
  DEFAULT_CUSTOMER_FILTER,
  DEFAULT_MAP_LAYERS,
  DEFAULT_MAP_MODE,
  MAP_LAYERS,
  MAP_MODE_STORAGE_KEY,
  buildMapViewQuery,
  parseMapMode,
  type CustomerFilter,
  type MapLayer,
  type MapMode,
  type MapViewState,
} from "@/lib/map-view-params";
import type {
  CtoPortCustomer,
  CustomerMapView,
  ServiceOrderMapView,
} from "@/lib/operational-map";
import type { MapSearchHit, MapSearchResult } from "@/lib/map-search";
import {
  connectivityAge,
  connectivityPresentation,
} from "@/lib/connectivity-presentation";
import { OperationalMap } from "./OperationalMap";
import type { MapCamera, MapCanvasHandle } from "./MapCanvas";

/**
 * # A camada de CTO do Mapa Operacional
 *
 * O que é **de CTO** vive aqui: o DTO, a leitura de `/api/ctos/map`, a busca,
 * os marcadores, o popup, a seleção e os avisos de truncamento e de caixa sem
 * localização. O que é **do mapa** — Leaflet, tiles, viewport, moldura, modo,
 * carregamento e erro — está em `OperationalMap` e `MapCanvas`.
 *
 * ## Nada é recalculado aqui
 *
 * `status`, `free`, `occupied`, `reserved` e `damaged` chegam prontos do
 * servidor (`CTO-3.1`) e são exibidos como vieram. A tela **não** deriva estado
 * a partir do `summary`, e não conhece a precedência `INACTIVE > DAMAGED > FULL
 * > AVAILABLE`: ela conhece a tradução de cada valor para forma, glifo e
 * rótulo.
 *
 * ## A vista vive na URL (`CTO-3.2.1`)
 *
 * Centro, zoom, modo, busca e seleção são espelhados na barra de endereço a
 * cada mudança. É isso que faz o operador voltar de uma CTO para o **bairro
 * onde estava**, e não para o Brasil inteiro — o defeito que o dono encontrou
 * na validação da `CTO-3.2`.
 */

/**
 * Os marcadores entram por `dynamic`, e não por `import` normal.
 *
 * `leaflet` e `react-leaflet` tocam `window` **na carga do módulo**, e um
 * componente de cliente ainda é renderizado no servidor pelo Next. Um `import`
 * estático aqui derrubaria o `next build` com `window is not defined` — que é
 * exatamente o gate obrigatório desta fase.
 */
const CtoMarkers = dynamic(() => import("./CtoMarkers"), { ssr: false });

/*
  As camadas novas entram pela MESMA porta, e por engano quase não entraram.

  `OperationalMarkers` importa `leaflet` e `react-leaflet`, que tocam `window`
  na carga do módulo. Importado normalmente, ele derrubaria o `next build` com
  `window is not defined` — e foi exatamente isso que o teste de SSR acusou na
  primeira versão desta fase, antes de qualquer navegador abrir.
*/
const CustomerMarkers = dynamic(
  () => import("./OperationalMarkers").then((m) => m.CustomerMarkers),
  { ssr: false },
);
const ServiceOrderMarkers = dynamic(
  () => import("./OperationalMarkers").then((m) => m.ServiceOrderMarkers),
  { ssr: false },
);

/**
 * Um array vazio ESTAVEL.
 *
 * Sem ele, cada render produziria um array novo, e o memo de `CtoMarkers`
 * nunca bloquearia nada. Aquele memo existe para fechar a realimentacao
 * popup -> autoPan -> moveend -> render; uma prop que muda de identidade a
 * cada render a reabriria em silencio.
 */
const SEM_MARCADORES: CtoMapView["markers"] = [];
const SEM_CLIENTES: CustomerMapView["markers"] = [];
const SEM_ORDENS: ServiceOrderMapView["markers"] = [];

interface CtoMapLayerProps {
  tiles: MapTilesConfig;
  /** Os modos que a configuração consegue desenhar. */
  modes: MapMode[];
  initialView: MapInitialView;
  /** A vista que veio da URL, já validada pelo servidor. */
  initialState: Partial<MapViewState>;
  /** `ADMIN` abre `/ctos/[id]`; `DISPATCHER` lê o mapa e não o detalhe. */
  canOpenDetail: boolean;
  /** `ADMIN` corrige a posição da caixa pelo mapa (`CTO-3.2.1d`). */
  canEditPosition: boolean;
  /**
   * `ADMIN` vê a carteira nominal — camada de clientes e lista por porta.
   *
   * O `DISPATCHER` continua com caixas e OS abertas. Ampliar a ele a
   * localização de cada assinante é decisão de privacidade, e não efeito
   * colateral de uma fase de mapa (`CTO-3.2.2`).
   */
  canSeeCustomers: boolean;
}

/** O estado de uma camada que carrega sozinha. */
interface EstadoDeCamada<T> {
  dados: T | null;
  carregando: boolean;
  erro: string | null;
}

const CAMADA_VAZIA = { dados: null, carregando: false, erro: null };

/** Como cada tipo de resultado se apresenta na lista da busca. */
const ROTULO_DO_TIPO: Record<MapSearchHit["type"], string> = {
  CTO: "CTO",
  CUSTOMER: "Cliente",
  SERVICE_ORDER: "OS",
};

/** Os rótulos do controle de camadas. */
const ROTULO_DA_CAMADA: Record<MapLayer, string> = {
  CTOS: "CTOs",
  ORDERS: "OS abertas",
  CUSTOMERS: "Clientes ativos",
};

/** Os filtros da camada de clientes, na ordem em que aparecem. */
const ROTULO_DO_FILTRO: Record<CustomerFilter, string> = {
  ALL: "Todos ativos",
  ONLINE: "Online",
  OFFLINE: "Offline",
  UNKNOWN: "Sem leitura",
  WITH_OPEN_OS: "Com OS aberta",
  WITHOUT_OPEN_OS: "Sem OS aberta",
};

/**
 * A área segura da caixa em EDIÇÃO, em pixels do mapa — `CTO-3.2.2e`.
 *
 * Medido em coordenadas do contêiner: o zoom ocupa (10–44, 10–74), o seletor
 * de base termina em y=42, a atribuição ocupa os 22px de baixo à direita, e o
 * painel de edição fica no canto inferior esquerdo com 304px de largura mais
 * 12 de margem, e 214px de altura (mais com mensagem de erro).
 *
 * Os respiros valem para a ÂNCORA da caixa, que é a base do ícone de 32px:
 *
 * ```text
 * topo      106  zoom termina em 74; 106 − 32 deixa o ícone inteiro abaixo dele
 * esquerda  64   zoom termina em 44; 64 − 16 deixa o ícone à direita dele
 * direita   40   meio ícone e folga
 * base      48   meio ícone acima da atribuição
 * painel    332 × 250   304 + 12 de margem + folga; 214 + 12 + folga
 * ```
 *
 * Não é uma engine: são números medidos, e o `panInside` do Leaflet faz o
 * resto. Uma caixa que já está na área segura não se move.
 */
const AREA_SEGURA_DE_EDICAO = {
  paddingTopLeft: [64, 106] as [number, number],
  paddingBottomRight: [40, 48] as [number, number],
  avoidBottomLeft: { width: 332, height: 250 },
};

/** Onde a caixa em edição está agora, antes de qualquer escrita. */
interface PosicaoEsboco {
  latitude: number;
  longitude: number;
}

/** Seis casas decimais: cerca de 11 cm no equador, muito além do que um poste pede. */
function formatarCoordenada(valor: number): string {
  return valor.toFixed(6);
}

/** Um modo pedido que a configuração não desenha cai no padrão. */
function modoUtilizavel(pedido: MapMode | undefined, modes: MapMode[]): MapMode {
  if (pedido && modes.includes(pedido)) return pedido;
  return modes.includes(DEFAULT_MAP_MODE) ? DEFAULT_MAP_MODE : modes[0];
}

export function CtoMapLayer({
  tiles,
  modes,
  initialView,
  initialState,
  canOpenDetail,
  canEditPosition,
  canSeeCustomers,
}: CtoMapLayerProps) {
  const [view, setView] = useState<CtoMapView | null>(null);
  const [loading, setLoading] = useState(false);
  /*
    O indicador de atualização, com ATRASO para aparecer e tempo MÍNIMO na
    tela — e os dois são só da UI. O pedido sai na hora; quem espera é o aviso.

    A cadência é uma função pura (`nextMapActivityStep`), testada com relógio
    de mentira; aqui só se executa o que ela responde.
  */
  const [mostrarAtualizando, setMostrarAtualizando] = useState(false);
  const atualizandoDesdeRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<MapMode>(() =>
    modoUtilizavel(initialState.mode, modes),
  );
  /*
    A câmera nasce COM o que veio na URL, e não vazia.

    Isto foi encontrado pela suíte completa, e é defeito e não instabilidade: o
    efeito que espelha a vista dispara antes de o mapa reportar a primeira
    posição, e com a câmera vazia ele montava uma query SEM `lat`/`lng` — e
    reescrevia a barra de endereço apagando justamente as coordenadas que a
    navegação acabara de trazer. Quem recarregasse ou copiasse a URL naquela
    janela perdia o lugar.

    Semeando daqui, o primeiro espelhamento escreve exatamente o que chegou.
  */
  const [camera, setCamera] = useState<MapCamera | null>(() =>
    initialState.latitude !== undefined && initialState.longitude !== undefined
      ? {
          latitude: initialState.latitude,
          longitude: initialState.longitude,
          zoom: initialState.zoom ?? 15,
        }
      : null,
  );
  const [search, setSearch] = useState(initialState.search ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialState.selectedId ?? null,
  );

  /*
    As CAMADAS operacionais — `CTO-3.2.2`.

    Não confundir com a base do mapa: `NORMAL`/`SATELLITE`/`HYBRID` é o fundo,
    isto é o que se desenha em cima. São dois controles diferentes, e a tela os
    separa visualmente por isso.

    Clientes nasce DESLIGADA. É a camada de milhares de pontos, e ligada por
    padrão cobriria a rede de bolinhas antes de alguém pedir.
  */
  const [layers, setLayers] = useState<Record<MapLayer, boolean>>(() => ({
    ...DEFAULT_MAP_LAYERS,
    ...(initialState.layers ?? {}),
  }));
  const [customerFilter, setCustomerFilter] = useState<CustomerFilter>(
    initialState.customerFilter ?? DEFAULT_CUSTOMER_FILTER,
  );

  const [clientes, setClientes] =
    useState<EstadoDeCamada<CustomerMapView>>(CAMADA_VAZIA);
  const [ordens, setOrdens] =
    useState<EstadoDeCamada<ServiceOrderMapView>>(CAMADA_VAZIA);

  /** A lista nominal de uma caixa, buscada só ao clicar em "Ver clientes". */
  const [clientesDaCto, setClientesDaCto] = useState<{
    ctoId: string;
    nome: string;
    lista: CtoPortCustomer[] | null;
    erro: string | null;
  } | null>(null);

  const bboxRef = useRef<BoundingBox | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const guardRef = useRef(createLatestRequestGuard());
  const mapRef = useRef<MapCanvasHandle | null>(null);
  const modoVeioDaUrl = useRef(initialState.mode !== undefined);

  // ---------------------------------------------------------------------
  // Preferência de base — do aparelho
  // ---------------------------------------------------------------------

  /*
    A URL VENCE a preferência guardada, e a ordem não é arbitrária.

    Um link com `mode=SATELLITE` é uma escolha explícita para AQUELA vista —
    quem voltou de uma CTO pediu a base em que estava. A preferência do
    aparelho é o padrão de quem chega sem pedir nada.

    Lido num efeito, e não no `useState` inicial, por causa da hidratação: o
    servidor não tem `localStorage`, então ler durante o render produziria um
    HTML diferente do da primeira pintura do cliente. O preço é uma troca de
    camada logo após a montagem, e num mapa — cujos tiles chegam de forma
    assíncrona de qualquer jeito — isso não é visível.
  */
  useEffect(() => {
    if (modoVeioDaUrl.current) return;
    try {
      const guardado = parseMapMode(
        window.localStorage.getItem(MAP_MODE_STORAGE_KEY),
      );
      if (guardado && modes.includes(guardado)) setMode(guardado);
    } catch {
      // Janela anônima ou armazenamento bloqueado. O mapa não depende disso.
    }
  }, [modes]);

  const trocarModo = useCallback((novo: MapMode) => {
    setMode(novo);
    try {
      window.localStorage.setItem(MAP_MODE_STORAGE_KEY, novo);
    } catch {
      // Idem: preferência é conveniência, nunca requisito.
    }
  }, []);

  // ---------------------------------------------------------------------
  // A vista, espelhada na URL
  // ---------------------------------------------------------------------

  const viewQuery = useMemo(
    () =>
      buildMapViewQuery({
        latitude: camera?.latitude,
        longitude: camera?.longitude,
        zoom: camera?.zoom,
        mode,
        search,
        selectedId,
        /*
          As camadas e o filtro entram na URL — `CTO-3.2.2`.

          É o que faz `Mapa → cliente → voltar` devolver o mapa **como estava**,
          e não só no lugar onde estava. Quem tinha a camada de clientes ligada
          com filtro "offline" e voltasse para o padrão teria de reconstruir a
          vista inteira a cada ida e volta.

          Só o ESTADO MÍNIMO viaja: nomes de camada e um identificador de filtro.
          Nenhum array de marcadores, nenhum payload — a URL descreve a vista,
          não guarda o conteúdo dela.
        */
        layers,
        customerFilter,
      }),
    [camera, mode, search, selectedId, layers, customerFilter],
  );

  /*
    `history.replaceState`, e NÃO `router.replace`.

    O `router` do Next trataria cada arrasto como navegação: re-renderiza o
    componente de servidor, refaz a consulta de enquadramento inicial e pode
    remontar o mapa. `replaceState` troca só a barra de endereço, que é
    exatamente o que se quer — a URL passa a descrever a vista atual, e nada
    mais acontece.

    `replace` e não `push`: cada pan viraria uma entrada no histórico, e o botão
    voltar do navegador levaria trinta cliques para sair do mapa.
  */
  useEffect(() => {
    if (!viewQuery) return;
    /*
      Nunca escreve antes de o mapa saber onde está.

      A segunda metade da mesma correção: sem esta linha, qualquer render
      anterior ao primeiro `moveend` poderia publicar uma vista incompleta. A
      regra é simples — o espelho só reflete o que já existe.
    */
    if (!camera) return;

    /*
      O PRIMEIRO argumento é `history.state`, e passar `null` ali quebra a
      navegação do Next.

      Isto não é teoria: a primeira versão passava `null`, e o teste de
      navegador mostrou o clique em "Abrir CTO" simplesmente não acontecendo —
      a URL continuava em `/mapa`, sem erro no console. O App Router guarda o
      próprio estado de roteamento em `history.state`, e sobrescrevê-lo com
      `null` deixa o roteador sem a árvore que ele usa para navegar. O sintoma é
      um link que não faz nada.

      Repassar `window.history.state` troca só a URL e devolve ao Next
      exatamente o que ele havia guardado.
    */
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?${viewQuery}`,
    );
  }, [viewQuery, camera]);

  // ---------------------------------------------------------------------
  // Leitura do recorte
  // ---------------------------------------------------------------------

  const carregar = useCallback(async (bbox: BoundingBox) => {
    // Cancela a leitura anterior: ninguém precisa do bairro que já saiu da tela.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const bilhete = guardRef.current.begin();
    setLoading(true);

    try {
      const res = await fetch(`/api/ctos/map?${boundingBoxToQuery(bbox)}`, {
        signal: controller.signal,
        // Uma leitura de mapa servida do cache mostra a rede de dez minutos
        // atrás sem nenhum sinal — a mesma razão do `no-store` da `DQ-5`.
        cache: "no-store",
      });
      const payload = await res.json().catch(() => null);

      /*
        Defesa em profundidade atrás do aborto — e isso foi MEDIDO.

        O modo de falha é o do bairro lento: a leitura de A demora mais que a de
        B, chega depois, e o mapa fica no lugar certo com os marcadores do outro
        lugar, sem erro nenhum na tela. No navegador quem impede isso é o
        `abort()` acima; a sabotagem `S2` da `CTO-3.2` provou que removendo esta
        linha o spec do mapa continua verde.

        Ela fica porque cobre o que o aborto não cobre: um chamador que esqueça
        o `signal`, uma troca de transporte, ou qualquer refatoração que afaste
        a decisão de escrever no estado da promessa cancelada.
      */
      if (!guardRef.current.isCurrent(bilhete)) return;

      if (!res.ok) {
        setError(
          payload?.error ?? "Não foi possível carregar as CTOs desta área.",
        );
        return;
      }
      setView(payload?.data?.map ?? null);
      setError(null);
    } catch {
      if (controller.signal.aborted) return;
      if (!guardRef.current.isCurrent(bilhete)) return;
      /*
        Falha de rede NÃO limpa os marcadores.

        Zerar a lista aqui produziria um mapa vazio, que é indistinguível de uma
        região sem caixas — e essa leitura errada é a perigosa, porque levaria o
        despachante a concluir que não há infraestrutura no bairro. O que
        aparece é o erro por cima do que já estava.
      */
      setError("Erro de conexão ao carregar as CTOs desta área.");
    } finally {
      if (guardRef.current.isCurrent(bilhete)) setLoading(false);
    }
  }, []);

  /*
    Cada camada tem o PRÓPRIO aborto e o próprio bilhete de sequência.

    Compartilhá-los faria a leitura de clientes cancelar a de CTO no mesmo
    arrasto — e a tela perderia as caixas por causa de uma camada que o operador
    nem ligou. A regra de "resposta atrasada não substitui resposta nova" vale
    por camada, não para o mapa inteiro.
  */
  const abortClientesRef = useRef<AbortController | null>(null);
  const guardaClientesRef = useRef(createLatestRequestGuard());
  const abortOrdensRef = useRef<AbortController | null>(null);
  const guardaOrdensRef = useRef(createLatestRequestGuard());

  /*
    Um indicador SÓ, e não três.

    Três camadas atualizando produziriam três avisos empilhados numa faixa de
    dezesseis pixels. Erro continua sendo por camada, porque ali a pergunta
    "qual falhou?" muda o que a pessoa faz.
  */
  const atualizando = loading || clientes.carregando || ordens.carregando;

  /*
    Sem flash, nos DOIS sentidos — `CTO-3.2.2e`.

    Leitura rápida: o `show` fica pendente e a limpeza do efeito o cancela
    quando `atualizando` cai — o aviso nunca existe. Leitura lenta: aparece
    depois do atraso e, se a resposta chegar logo em seguida, o `hide` espera
    completar o tempo mínimo. Leitura emendada na anterior enquanto o aviso
    está na tela: a função responde "nada", e a limpeza cancela o `hide`
    pendente — o aviso não apaga e reacende.
  */
  useEffect(() => {
    const passo = nextMapActivityStep(
      atualizando,
      mostrarAtualizando,
      atualizandoDesdeRef.current,
      Date.now(),
    );
    if (passo.action === "none") return;
    const t = setTimeout(() => {
      if (passo.action === "show") {
        atualizandoDesdeRef.current = Date.now();
        setMostrarAtualizando(true);
      } else {
        atualizandoDesdeRef.current = null;
        setMostrarAtualizando(false);
      }
    }, passo.afterMs);
    return () => clearTimeout(t);
  }, [atualizando, mostrarAtualizando]);

  const carregarClientes = useCallback(
    async (bbox: BoundingBox, filtro: CustomerFilter) => {
      abortClientesRef.current?.abort();
      const controller = new AbortController();
      abortClientesRef.current = controller;
      const bilhete = guardaClientesRef.current.begin();
      setClientes((atual) => ({ ...atual, carregando: true }));

      /*
        O filtro vai para o SERVIDOR junto do recorte.

        Filtrar no navegador exigiria trazer todos os clientes para descartar a
        maioria — e o teto seria aplicado antes do filtro, de modo que "trezentos
        e truncado" poderia render quatro marcadores.
      */
      const params = new URLSearchParams(boundingBoxToQuery(bbox));
      if (filtro === "ONLINE" || filtro === "OFFLINE" || filtro === "UNKNOWN") {
        params.set("connectivity", filtro);
      } else if (filtro === "WITH_OPEN_OS") {
        params.set("openOs", "true");
      } else if (filtro === "WITHOUT_OPEN_OS") {
        params.set("openOs", "false");
      }

      try {
        const res = await fetch(`/api/map/customers?${params.toString()}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const payload = await res.json().catch(() => null);
        if (!guardaClientesRef.current.isCurrent(bilhete)) return;

        if (!res.ok) {
          /*
            Erro da camada de clientes NÃO derruba o mapa.

            CTO e OS continuam desenhadas, e a mensagem é específica. Dizer
            "0 clientes" seria pior que dizer que falhou: o operador concluiria
            que o bairro não tem assinantes.
          */
          setClientes({
            dados: null,
            carregando: false,
            erro: payload?.error ?? "Não foi possível carregar os clientes.",
          });
          return;
        }
        setClientes({
          dados: payload?.data?.map ?? null,
          carregando: false,
          erro: null,
        });
      } catch {
        if (controller.signal.aborted) return;
        if (!guardaClientesRef.current.isCurrent(bilhete)) return;
        setClientes({
          dados: null,
          carregando: false,
          erro: "Erro de conexão ao carregar os clientes.",
        });
      }
    },
    [],
  );

  const carregarOrdens = useCallback(async (bbox: BoundingBox) => {
    abortOrdensRef.current?.abort();
    const controller = new AbortController();
    abortOrdensRef.current = controller;
    const bilhete = guardaOrdensRef.current.begin();
    setOrdens((atual) => ({ ...atual, carregando: true }));

    try {
      const res = await fetch(
        `/api/map/service-orders?${boundingBoxToQuery(bbox)}`,
        { signal: controller.signal, cache: "no-store" },
      );
      const payload = await res.json().catch(() => null);
      if (!guardaOrdensRef.current.isCurrent(bilhete)) return;

      if (!res.ok) {
        setOrdens({
          dados: null,
          carregando: false,
          erro: payload?.error ?? "Não foi possível carregar as OS abertas.",
        });
        return;
      }
      setOrdens({
        dados: payload?.data?.map ?? null,
        carregando: false,
        erro: null,
      });
    } catch {
      if (controller.signal.aborted) return;
      if (!guardaOrdensRef.current.isCurrent(bilhete)) return;
      setOrdens({
        dados: null,
        carregando: false,
        erro: "Erro de conexão ao carregar as OS abertas.",
      });
    }
  }, []);

  /*
    As camadas ligadas são lidas a cada mudança de recorte — e as DESLIGADAS
    não são lidas nunca.

    Uma camada apagada que continuasse consultando gastaria banco e banda para
    desenhar nada, e é o tipo de custo que ninguém percebe porque não aparece na
    tela.
  */
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const filtroRef = useRef(customerFilter);
  filtroRef.current = customerFilter;

  const handleViewport = useCallback(
    (bbox: BoundingBox, cameraAtual: MapCamera) => {
      bboxRef.current = bbox;
      setCamera(cameraAtual);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (layersRef.current.CTOS) void carregar(bbox);
        if (layersRef.current.ORDERS) void carregarOrdens(bbox);
        if (layersRef.current.CUSTOMERS) {
          void carregarClientes(bbox, filtroRef.current);
        }
      }, CTO_MAP_VIEWPORT_DEBOUNCE_MS);
    },
    [carregar, carregarClientes, carregarOrdens],
  );

  /**
   * Ligar ou desligar uma camada.
   *
   * Ligar dispara a leitura imediatamente — esperar o próximo `moveend` faria a
   * camada parecer quebrada até alguém mexer no mapa. Desligar descarta os
   * dados: manter centenas de marcadores invisíveis na memória não serve a
   * ninguém, e o próximo "ligar" relê o que estiver na tela naquele momento.
   */
  const alternarCamada = useCallback(
    (camada: MapLayer, ligada: boolean) => {
      setLayers((atual) => ({ ...atual, [camada]: ligada }));
      const bbox = bboxRef.current;

      if (!ligada) {
        if (camada === "CUSTOMERS") {
          abortClientesRef.current?.abort();
          guardaClientesRef.current.begin();
          setClientes(CAMADA_VAZIA);
        }
        if (camada === "ORDERS") {
          abortOrdensRef.current?.abort();
          guardaOrdensRef.current.begin();
          setOrdens(CAMADA_VAZIA);
        }
        if (camada === "CTOS") {
          abortRef.current?.abort();
          guardRef.current.begin();
          setView(null);
        }
        return;
      }

      if (!bbox) return;
      if (camada === "CUSTOMERS") void carregarClientes(bbox, filtroRef.current);
      if (camada === "ORDERS") void carregarOrdens(bbox);
      if (camada === "CTOS") void carregar(bbox);
    },
    [carregar, carregarClientes, carregarOrdens],
  );

  const trocarFiltro = useCallback(
    (filtro: CustomerFilter) => {
      setCustomerFilter(filtro);
      filtroRef.current = filtro;
      const bbox = bboxRef.current;
      if (bbox && layersRef.current.CUSTOMERS) {
        void carregarClientes(bbox, filtro);
      }
    },
    [carregarClientes],
  );

  /** A lista nominal da caixa — buscada só quando alguém pede. */
  const verClientesDaCto = useCallback(
    async (ctoId: string) => {
      const caixa = view?.markers.find((m) => m.id === ctoId);
      setClientesDaCto({
        ctoId,
        nome: caixa?.name ?? "CTO",
        lista: null,
        erro: null,
      });
      try {
        const res = await fetch(`/api/ctos/${ctoId}/customers`, {
          cache: "no-store",
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          setClientesDaCto((atual) =>
            atual && atual.ctoId === ctoId
              ? {
                  ...atual,
                  erro:
                    payload?.error ??
                    "Não foi possível carregar os clientes desta caixa.",
                }
              : atual,
          );
          return;
        }
        setClientesDaCto((atual) =>
          atual && atual.ctoId === ctoId
            ? { ...atual, lista: payload?.data?.customers ?? [] }
            : atual,
        );
      } catch {
        setClientesDaCto((atual) =>
          atual && atual.ctoId === ctoId
            ? { ...atual, erro: "Erro de conexão." }
            : atual,
        );
      }
    },
    [view],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const tentarNovamente = useCallback(() => {
    const bbox = bboxRef.current;
    if (!bbox) return;
    setError(null);
    void carregar(bbox);
  }, [carregar]);

  /*
    Estavel, e nao um arrow inline.

    O efeito de `CanvasHandle` depende desta funcao; um arrow novo a cada
    render faria o efeito reexecutar a cada movimento do mapa.
  */
  const guardarMapa = useCallback((handle: MapCanvasHandle) => {
    mapRef.current = handle;
  }, []);

  const focarEm = useCallback((hit: MapSearchHit) => {
    if (hit.latitude === null || hit.longitude === null) return;
    mapRef.current?.focusOn(hit.latitude, hit.longitude);
    setSelectedId(hit.id);
  }, []);

  const markers = view?.markers ?? SEM_MARCADORES;

  /*
    A caixa em edição é GUARDADA, e não apenas apontada por id — CTO-3.2.1d.

    A `§7` exige que arrastar e dar zoom continuem funcionando durante a edição,
    e isso dispara releitura do recorte. Se o operador afastar o mapa ou
    arrastar para o lado, a caixa que ele está movendo pode sair da lista que o
    servidor devolve — e com só o id em mãos o marcador sumiria debaixo da mão,
    levando o painel junto.

    Guardando a cópia, ela continua desenhada enquanto a edição durar. O par
    gravado dentro dela é a ORIGEM para o Cancelar, e é o que torna o cancelamento
    confiável depois de quantos arrastos forem: nada nele é alterado pelo arrasto.
  */
  const [ctoEmEdicao, setCtoEmEdicao] = useState<CtoMapView["markers"][number] | null>(
    null,
  );
  const [esboco, setEsboco] = useState<PosicaoEsboco | null>(null);
  const [salvandoPosicao, setSalvandoPosicao] = useState(false);
  const [erroPosicao, setErroPosicao] = useState<string | null>(null);

  const marcadores = useMemo(() => {
    if (!ctoEmEdicao) return markers;
    return markers.some((m) => m.id === ctoEmEdicao.id)
      ? markers.map((m) => (m.id === ctoEmEdicao.id ? ctoEmEdicao : m))
      : [...markers, ctoEmEdicao];
  }, [markers, ctoEmEdicao]);

  const iniciarEdicao = useCallback(
    (id: string) => {
      const alvo = markers.find((m) => m.id === id);
      if (!alvo) return;
      setCtoEmEdicao(alvo);
      setEsboco(null);
      setErroPosicao(null);
      /*
        O popup FECHA ao entrar em edição.

        Ele cobriria justamente a caixa que se quer arrastar, e um popup aberto
        durante o arrasto reabre a briga entre `click`, `drag` e `autoPan` que
        custou o popup inteiro na `CTO-3.2.1`.
      */
      mapRef.current?.closePopup();
      /*
        E a caixa é trazida para a ÁREA SEGURA — `CTO-3.2.2e`.

        O dono via a caixa "lá embaixo" ao entrar em edição, e a medição
        explica: o `autoPan` do popup empurra a vista para o popup caber ACIMA
        do marcador, então o marcador vai parar no rodapé do mapa (medido:
        y=354 num mapa de 400). Fechado o popup, ele fica lá — a 14px da borda
        e, no canto esquerdo, debaixo do painel de edição.

        `panInside` move o mínimo que resolve, e só se precisar. É pan de
        VISTA: a coordenada da caixa não muda, nada é gravado, e quem escreve
        continua sendo o arrasto explícito do marcador.
      */
      if (alvo.latitude !== null && alvo.longitude !== null) {
        mapRef.current?.panInside(alvo.latitude, alvo.longitude, AREA_SEGURA_DE_EDICAO);
      }
    },
    [markers],
  );

  const moverEsboco = useCallback((latitude: number, longitude: number) => {
    setEsboco({ latitude, longitude });
    // Um arrasto novo é uma tentativa nova: o erro anterior deixa de valer.
    setErroPosicao(null);
  }, []);

  /*
    CANCELAR não faz requisição nenhuma.

    Só descarta o rascunho. O marcador volta ao par gravado porque é ele que a
    prop de posição passa a devolver — não existe "desfazer" a executar, existe
    uma origem que nunca foi tocada.
  */
  const cancelarEdicao = useCallback(() => {
    setCtoEmEdicao(null);
    setEsboco(null);
    setErroPosicao(null);
    setSalvandoPosicao(false);
  }, []);

  const salvarPosicao = useCallback(async () => {
    if (!ctoEmEdicao || !esboco) return;
    setSalvandoPosicao(true);
    setErroPosicao(null);
    try {
      /*
        O MESMO caminho de escrita da tela de detalhe, com payload estreito.

        `PATCH /api/ctos/[id]` já valida com `.strict()`, já exige `ADMIN` e a
        capability em `requireCtoAccess`, já filtra tenant no `updateMany` e já
        chama `assertCoordinates` no domínio. Mandando SÓ o par, `updateCto`
        monta um `data` com só ele — nenhum outro campo é sequer lido, então não
        há como sobrescrever nome, capacidade ou observações por acidente.

        Criar `PATCH /api/ctos/[id]/location` seria uma segunda implementação da
        mesma regra, e a que divergisse seria a que ninguém revisou.
      */
      const res = await fetch(`/api/ctos/${ctoEmEdicao.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: esboco.latitude,
          longitude: esboco.longitude,
        }),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        /*
          Falhou: o modo de edição CONTINUA aberto.

          É a alternativa mais honesta das duas que o enunciado admite. O
          marcador fica onde a mão o deixou, mas o painel segue na tela dizendo
          "Ajustando posição" e mostrando o erro — ninguém pode confundir isso
          com uma posição salva. Devolver o marcador ao ponto antigo apagaria o
          trabalho de quem acabou de posicionar a caixa, por causa de uma falha
          que pode ser de rede.
        */
        setErroPosicao(
          payload?.error ?? "Não foi possível salvar a posição da CTO.",
        );
        return;
      }

      /*
        A posição GRAVADA ganha na hora — RC-1D.

        Sem isto, limpar o rascunho devolvia a caixa ao par ANTIGO do recorte
        até a releitura chegar: um salto para trás e outro para frente logo
        depois de "Salvar". O par usado aqui é o que o SERVIDOR devolveu da
        escrita — a verdade gravada, e não o rascunho da tela —, e a releitura
        abaixo continua sendo quem confirma o resto.

        A tela não confere o par: ele vem do domínio, que já o validou — uma
        segunda conferência aqui seria a segunda autoridade sobre coordenada
        que o `MAPEDIT-SEC` proíbe. Sem par na resposta, fica a releitura.
      */
      const gravada = payload?.data?.cto;
      if (gravada?.latitude != null && gravada?.longitude != null) {
        const latitudeGravada = Number(gravada.latitude);
        const longitudeGravada = Number(gravada.longitude);
        const id = ctoEmEdicao.id;
        setView((atual) =>
          atual
            ? {
                ...atual,
                markers: atual.markers.map((m) =>
                  m.id === id
                    ? { ...m, latitude: latitudeGravada, longitude: longitudeGravada }
                    : m,
                ),
              }
            : atual,
        );
      }
      setCtoEmEdicao(null);
      setEsboco(null);
      /*
        A LEITURA CANÔNICA confirma o que foi salvo.

        Sair do modo de edição com o rascunho na tela seria afirmar sucesso com
        estado local. Relendo o recorte, a posição que aparece é a que o
        servidor devolve — e se ela não for a esperada, o mapa mostra a verdade
        em vez da esperança.
      */
      const bbox = bboxRef.current;
      if (bbox) void carregar(bbox);
    } catch {
      setErroPosicao("Erro de conexão ao salvar a posição da CTO.");
    } finally {
      setSalvandoPosicao(false);
    }
  }, [carregar, ctoEmEdicao, esboco]);

  /*
    A política de densidade da plaqueta, em uma linha.

    Um BOOLEANO atravessa a fronteira, e nunca o zoom. `CtoMarkers` é `memo`, e
    booleano só muda quando o operador cruza o limiar — arrastar o mapa dentro
    da mesma faixa não re-renderiza marcador nenhum. Passar o número daqui
    reabriria a realimentação `popup → autoPan → moveend → render` que custou o
    popup inteiro na `CTO-3.2.1`.

    Câmera ainda nula é o instante entre montar o mapa e ele reportar a primeira
    posição. Não aparece na tela: nesse intervalo ainda não houve leitura de
    recorte, então também não há marcador para rotular.

    O porquê do 16 está medido em `map-tiles.config.mjs`.
  */
  const mostrarPlaquetas = (camera?.zoom ?? 0) >= MAP_LABEL_MIN_ZOOM;

  return (
    <div className="space-y-4">
      <CtoMapSearch
        value={search}
        onValueChange={setSearch}
        onSelect={focarEm}
        canOpenDetail={canOpenDetail}
      />

      {/*
        Os AVISOS das camadas ficam no fluxo, o CONTROLE vai para dentro do
        mapa.

        O controle custava 82px de altura de página — medido —, e a legenda
        caía exatamente esses 82px abaixo da primeira dobra, quebrando a regra
        que a `CTO-3.2.1b` validou. A altura do mapa é faixa de leitura e não
        paga por chrome novo, então o controle foi para o canto do mapa, que é
        onde controle de camada mora.

        Aviso de erro, não: mensagem de falha em cima do mapa tapa justamente o
        que a pessoa está tentando ver, e some junto com o resto quando o mapa
        rola. Ela fica aqui, e só existe quando há o que dizer.
      */}
      {clientes.erro || ordens.erro ? (
        <div data-testid="map-layer-notices">
        {/*
          Erro POR CAMADA, e nunca "0 clientes".

          Se a leitura de clientes falha, CTO e OS continuam desenhadas e a
          mensagem diz qual camada falhou. Mostrar zero seria uma afirmação
          falsa sobre a rede — e a leitura errada é a perigosa.
        */}
        {clientes.erro ? (
          <p
            className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs font-medium text-danger-fg"
            role="alert"
            data-testid="map-customers-error"
          >
            {clientes.erro}
          </p>
        ) : null}
        {ordens.erro ? (
          <p
            className="mt-2 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs font-medium text-danger-fg"
            role="alert"
            data-testid="map-orders-error"
          >
            {ordens.erro}
          </p>
        ) : null}
        </div>
      ) : null}

      {/*
        O controle de CAMADAS vive FORA do canvas, e isso é decisão do dono.

        Ele esteve dentro do mapa por uma fase: fora, custava 82px de altura de
        página e empurrava a legenda para baixo da primeira dobra. Na validação
        manual o preço apareceu do outro lado — ele cobria os botões `+`/`−` do
        Leaflet, que moram no canto superior esquerdo, e disputava a área útil
        justamente onde o operador clica para aproximar.

        Um controle que tapa o controle do mapa é pior que um controle que
        ocupa altura. Ele volta para o fluxo, como um cartão logo abaixo da
        busca, e o orçamento vertical foi refeito na altura do mapa
        (`MapCanvas`), não espremendo legenda ou resumo.

        `Mapa`/`Satélite`/`Híbrido` continua sendo a BASE e continua no canto do
        mapa. São dois controles diferentes: um é o fundo, o outro é o que se
        desenha em cima.
      */}
      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-sm"
        data-testid="map-layer-control"
      >
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <legend className="float-left mr-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Camadas
          </legend>
          {MAP_LAYERS.map((camada) => {
            // A camada de clientes nem aparece para quem não pode vê-la.
            if (camada === "CUSTOMERS" && !canSeeCustomers) return null;
            return (
              <label
                key={camada}
                className="flex items-center gap-2 text-sm text-fg"
              >
                <input
                  type="checkbox"
                  checked={layers[camada]}
                  onChange={(e) => alternarCamada(camada, e.target.checked)}
                  className="h-4 w-4 rounded border-input-border text-primary focus:ring-2 focus:ring-focus-soft"
                  data-testid={`map-layer-${camada.toLowerCase()}`}
                />
                {ROTULO_DA_CAMADA[camada]}
              </label>
            );
          })}
        </fieldset>

        {/* O filtro só existe enquanto a camada que ele filtra está ligada. */}
        {canSeeCustomers && layers.CUSTOMERS ? (
          <div className="flex items-center gap-2">
            <label
              className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted"
              htmlFor="map-customer-filter"
            >
              Filtrar clientes
            </label>
            <select
              id="map-customer-filter"
              value={customerFilter}
              onChange={(e) => trocarFiltro(e.target.value as CustomerFilter)}
              className="rounded-lg border border-input-border bg-input-bg px-2 py-1 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
              data-testid="map-customer-filter"
            >
              {(Object.keys(ROTULO_DO_FILTRO) as CustomerFilter[]).map((valor) => (
                <option key={valor} value={valor}>
                  {ROTULO_DO_FILTRO[valor]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <OperationalMap
        tiles={tiles}
        modes={modes}
        mode={mode}
        onModeChange={trocarModo}
        initialView={initialView}
        onViewportChange={handleViewport}
        onReady={guardarMapa}
        error={error}
        onRetry={tentarNovamente}
        /*
          O painel vive DENTRO do mapa, e a razão foi medida.

          Renderizado no fluxo da página, acima do mapa, entrar em modo de
          edição descia o mapa 206 pixels — o mapa saltava debaixo da mão no
          instante exato em que a pessoa vai arrastar com precisão. Ancorado no
          canto, nada no fluxo se move.
        */
        editor={
          ctoEmEdicao ? (
            <PainelDePosicao
              cto={ctoEmEdicao}
              esboco={esboco}
              salvando={salvandoPosicao}
              erro={erroPosicao}
              onCancelar={cancelarEdicao}
              onSalvar={salvarPosicao}
            />
          ) : null
        }
        overlay={
          <>
            {/*
              A pílula de atualização vive DENTRO do mapa, e isso é o conserto.

              Ela estava no fluxo, acima do mapa: aparecia no refresh, empurrava
              o mapa para baixo e sumia empurrando de volta. O dono relatou
              exatamente isso — a página descia e subia a cada zoom ou arrasto.

              Em overlay absoluto ela não ocupa altura nenhuma: nem o mapa, nem
              os chips, nem a legenda se movem.
            */}
            {mostrarAtualizando ? (
              <p
                className="pointer-events-auto rounded-full border border-border bg-surface/95 px-3 py-1 text-xs font-medium text-fg-secondary shadow-sm"
                data-testid="map-updating"
                role="status"
              >
                Atualizando mapa…
              </p>
            ) : null}
            {view?.truncated ? (
              <p
                className="pointer-events-auto rounded-lg border border-warning-border bg-warning-bg px-3 py-1.5 text-xs font-medium text-warning-fg shadow-sm"
                role="status"
                data-testid="map-truncated"
              >
                Esta área tem mais de {view.limit} CTOs. Aproxime o mapa
                para carregar todas.
              </p>
            ) : null}
          </>
        }
      >
        {/*
          Cada camada entra como `children` do canvas, e sai da árvore quando é
          desligada. O canvas continua sem saber o que é CTO, cliente ou OS — a
          fronteira que a `CTO-3.2` estabeleceu não muda por haver três camadas
          em vez de uma.
        */}
        {layers.CTOS ? (
          <CtoMarkers
            markers={marcadores}
            selectedId={selectedId}
            onSelect={setSelectedId}
            canOpenDetail={canOpenDetail}
            showLabels={mostrarPlaquetas}
            canEditPosition={canEditPosition}
            editingId={ctoEmEdicao?.id ?? null}
            draftPosition={esboco}
            onStartEdit={iniciarEdicao}
            onDragEnd={moverEsboco}
            canSeeCustomers={canSeeCustomers}
            onShowCustomers={verClientesDaCto}
          />
        ) : null}

        {layers.ORDERS ? (
          <ServiceOrderMarkers
            markers={ordens.dados?.markers ?? SEM_ORDENS}
            canOpenCustomer={canSeeCustomers}
          />
        ) : null}

        {layers.CUSTOMERS && canSeeCustomers ? (
          <CustomerMarkers
            markers={clientes.dados?.markers ?? SEM_CLIENTES}
            canOpenCustomer={canSeeCustomers}
          />
        ) : null}
      </OperationalMap>

      {/*
        O RESUMO OPERACIONAL em chips, e não em frases soltas.

        Antes eram sentenças cinzas numa linha só — "1 CTO nesta área · 2 OS
        abertas nesta área" —, do mesmo tamanho e peso do resto da página. O
        dono leu isso como texto perdido, e estava certo: são as cinco
        contagens que dizem o que há na tela, e elas competiam com legenda e
        rodapé pelo mesmo cinza.

        Agora o NÚMERO tem peso próprio e o rótulo fica embaixo. A regra que
        sobrevive da `CTO-3.2`: com a leitura falhando, nenhuma contagem é
        afirmada — dizer "0 nesta área" faria o mapa mentir sobre a rede.
      */}
      <div
        className="flex flex-wrap gap-2"
        data-testid="map-summary"
        aria-label="Resumo desta área"
      >
        {error ? (
          <p
            className="rounded-lg border border-border-subtle bg-surface-muted px-3 py-2 text-xs text-fg-muted"
            data-testid="map-count-unavailable"
          >
            Contagem indisponível enquanto a leitura desta área falha.
          </p>
        ) : (
          <ResumoChip
            valor={markers.length}
            rotulo={markers.length === 1 ? "CTO nesta área" : "CTOs nesta área"}
            testId="map-marker-count"
          />
        )}

        {layers.CUSTOMERS && canSeeCustomers && clientes.dados && !clientes.erro ? (
          <ResumoChip
            valor={clientes.dados.markers.length}
            rotulo={
              clientes.dados.markers.length === 1
                ? "cliente nesta área"
                : "clientes nesta área"
            }
            testId="map-customer-count"
          />
        ) : null}

        {layers.ORDERS && ordens.dados && !ordens.erro ? (
          <ResumoChip
            valor={ordens.dados.markers.length}
            rotulo={
              ordens.dados.markers.length === 1
                ? "OS aberta nesta área"
                : "OS abertas nesta área"
            }
            tom="warning"
            testId="map-order-count"
          />
        ) : null}

        {/*
          SEM LOCALIZAÇÃO é outra pergunta, e por isso outro tom.

          O contador de caixas sem coordenada é da EMPRESA, não do recorte
          (`CTO-3.1`): uma caixa sem coordenada não está em região nenhuma. Ele
          não muda quando o mapa se move, e o rótulo diz "no cadastro" para
          ninguém o ler como "aqui perto".
        */}
        {view && view.missingLocationCount > 0 ? (
          <ResumoChip
            valor={view.missingLocationCount}
            rotulo={
              view.missingLocationCount === 1
                ? "CTO sem localização no cadastro"
                : "CTOs sem localização no cadastro"
            }
            tom="ausente"
            testId="map-missing-location"
            href={canOpenDetail ? "/ctos" : undefined}
            hrefRotulo="ver cadastro"
          />
        ) : null}

        {layers.CUSTOMERS &&
        canSeeCustomers &&
        clientes.dados &&
        clientes.dados.missingLocationCount > 0 ? (
          <ResumoChip
            valor={clientes.dados.missingLocationCount}
            rotulo={
              clientes.dados.missingLocationCount === 1
                ? "cliente ativo sem localização"
                : "clientes ativos sem localização"
            }
            tom="ausente"
            testId="map-customers-missing"
          />
        ) : null}

        {layers.ORDERS && ordens.dados && ordens.dados.missingLocationCount > 0 ? (
          <ResumoChip
            valor={ordens.dados.missingLocationCount}
            rotulo={
              ordens.dados.missingLocationCount === 1
                ? "OS aberta sem localização"
                : "OS abertas sem localização"
            }
            tom="ausente"
            testId="map-orders-missing"
          />
        ) : null}

        {clientes.dados?.truncated ? (
          <ResumoChip
            valor={clientes.dados.markers.length}
            rotulo="Aproxime para carregar todos os clientes"
            tom="warning"
            testId="map-customers-truncated"
          />
        ) : null}

        {ordens.dados?.truncated ? (
          <ResumoChip
            valor={ordens.dados.markers.length}
            rotulo="Aproxime para carregar todas as OS"
            tom="warning"
            testId="map-orders-truncated"
          />
        ) : null}
      </div>

      {clientesDaCto ? (
        <ClientesDaCaixa
          estado={clientesDaCto}
          onFechar={() => setClientesDaCto(null)}
        />
      ) : null}

      <MapLegend layers={layers} canSeeCustomers={canSeeCustomers} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clientes por porta — CTO-3.2.2
// ---------------------------------------------------------------------------

/**
 * A lista nominal de uma caixa, aberta sob demanda.
 *
 * ## Ela não vem no recorte, e isso é decisão de privacidade
 *
 * O recorte devolve **contagens**. Mandar os nomes dos clientes de cada caixa
 * visível seria payload enorme e espalharia nome de assinante por uma resposta
 * cujo trabalho é desenhar pontos. O nome só viaja quando alguém pede aquela
 * caixa — e quem pede é `ADMIN`.
 *
 * ## Porta a porta, e só vínculo ATIVO
 *
 * A relação vem exclusivamente de `CustomerNetworkConnection` aberta. Nunca
 * proximidade, endereço ou mesma rua: o mapa mostra o que foi registrado, não o
 * que parece provável.
 */
function ClientesDaCaixa({
  estado,
  onFechar,
}: {
  estado: {
    ctoId: string;
    nome: string;
    lista: CtoPortCustomer[] | null;
    erro: string | null;
  };
  onFechar: () => void;
}) {
  return (
    <div
      className="rounded-2xl border border-border bg-surface p-4 shadow-sm"
      data-testid="cto-customers-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-fg">Clientes da caixa</p>
          <p className="mt-0.5 text-xs text-fg-muted">{estado.nome}</p>
        </div>
        <button
          type="button"
          onClick={onFechar}
          className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted"
          data-testid="cto-customers-close"
        >
          Fechar
        </button>
      </div>

      {estado.erro ? (
        <p
          className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs font-medium text-danger-fg"
          role="alert"
        >
          {estado.erro}
        </p>
      ) : null}

      {!estado.erro && estado.lista === null ? (
        <p className="mt-3 text-xs text-fg-muted">Carregando…</p>
      ) : null}

      {estado.lista && estado.lista.length === 0 ? (
        <p className="mt-3 text-sm text-fg-secondary">
          Nenhum cliente vinculado a esta caixa.
        </p>
      ) : null}

      {estado.lista && estado.lista.length > 0 ? (
        <ul className="mt-3 divide-y divide-border-subtle rounded-lg border border-border">
          {estado.lista.map((cliente) => {
            const apresentacao = connectivityPresentation(
              cliente.connectivityStatus,
            );
            const idade = connectivityAge(cliente.connectivityObservedAt);
            return (
              <li
                key={`${cliente.portNumber}:${cliente.customerId}`}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                data-testid="cto-customers-row"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">
                    <span className="text-fg-muted">
                      Porta {String(cliente.portNumber).padStart(2, "0")}
                    </span>{" "}
                    · {cliente.customerName}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                    {/*
                      CADASTRO e CONECTIVIDADE, nomeados e separados.

                      Um cliente pode estar ATIVO e OFFLINE — é o caso mais
                      comum, e é o que faz alguém abrir uma OS. Colapsar os dois
                      num selo só faria "inativo" e "sem sinal" parecerem a
                      mesma coisa.
                    */}
                    <span
                      className={
                        cliente.customerActive
                          ? "text-fg-muted"
                          : "font-medium text-neutral-fg"
                      }
                      data-testid="cto-customers-registration"
                    >
                      {cliente.customerActive ? "Ativo" : "INATIVO"}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-medium ${
                        {
                          success:
                            "border-success-border bg-success-bg text-success-fg",
                          danger:
                            "border-danger-border bg-danger-bg text-danger-fg",
                          neutral:
                            "border-neutral-border bg-neutral-bg text-neutral-fg",
                        }[apresentacao.tone]
                      }`}
                      data-testid="cto-customers-connectivity"
                      data-status={cliente.connectivityStatus}
                    >
                      {apresentacao.glyph && (
                        <span aria-hidden="true">{apresentacao.glyph}</span>
                      )}
                      {apresentacao.mapLabel}
                    </span>
                    {idade ? (
                      <span className="text-fg-muted">Leitura {idade}</span>
                    ) : null}
                    {cliente.openServiceOrderCount > 0 ? (
                      <span
                        className="rounded-full border border-warning-border bg-warning-bg px-1.5 py-px font-medium text-warning-fg"
                        data-testid="cto-customers-open-os"
                      >
                        {cliente.openServiceOrderCount} OS aberta
                        {cliente.openServiceOrderCount === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </p>
                </div>

                <Link
                  href={`/clientes/${cliente.customerId}/editar`}
                  className="shrink-0 text-xs font-medium text-primary-text underline underline-offset-2 hover:text-primary-text-hover"
                >
                  Abrir cliente
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ajuste de posição — CTO-3.2.1d
// ---------------------------------------------------------------------------

/**
 * O painel que torna a edição um ATO, e não um efeito colateral do arrasto.
 *
 * ## Por que ele existe, em vez de "arrastou = salvou"
 *
 * Num mapa a mão está sempre arrastando alguma coisa. Se soltar o marcador
 * gravasse, uma coordenada correta viraria uma errada sem que ninguém tivesse
 * pedido, e sem nada na tela para desfazer. O painel transforma a sequência em
 * uma intenção declarada: entrar, mover, conferir, e só então salvar.
 *
 * ## Ele mostra as DUAS posições
 *
 * A anterior e a nova, lado a lado. Sem a anterior não há como conferir nada —
 * e conferir é o passo que separa "corrigi a caixa" de "movi a caixa".
 */
function PainelDePosicao({
  cto,
  esboco,
  salvando,
  erro,
  onCancelar,
  onSalvar,
}: {
  cto: CtoMapView["markers"][number];
  esboco: PosicaoEsboco | null;
  salvando: boolean;
  erro: string | null;
  onCancelar: () => void;
  onSalvar: () => void;
}) {
  return (
    <div
      /*
        Fundo OPACO e sombra, como a plaqueta e o popup.

        Ele flutua sobre imagem que não é nossa — mapa, satélite, telhado,
        vegetação. `bg-surface` com sombra é a mesma solução que o popup e a
        plaqueta já usam sobre as três bases, e a borda em `primary` é o que o
        liga ao halo tracejado do marcador em edição.

        Uma tentativa anterior usou `bg-primary-soft`, que **não existe**: o
        design system tem `primary` em `DEFAULT`, `hover`, `fg`, `text` e
        `text-hover`. Classe inexistente é o defeito da `CTO-1.5` — o Tailwind a
        ignora em silêncio, e o painel sairia transparente sem nada falhar.
      */
      className="rounded-xl border border-primary bg-surface p-3 shadow-lg"
      role="region"
      aria-label="Ajuste de posição da CTO"
      data-testid="cto-map-position-panel"
    >
      <p className="text-sm font-semibold text-fg">Ajustando posição</p>
      <p className="mt-0.5 text-sm text-fg-secondary">{cto.name}</p>
      <p className="mt-2 text-xs text-fg-muted">
        Arraste a caixa no mapa até o ponto correto. Nada é gravado até você
        salvar.
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-fg-muted">Posição anterior</dt>
        <dt className="text-fg-muted">Nova posição</dt>
        <dd className="font-mono text-fg" data-testid="cto-map-position-before">
          {formatarCoordenada(cto.latitude)}, {formatarCoordenada(cto.longitude)}
        </dd>
        <dd className="font-mono text-fg" data-testid="cto-map-position-after">
          {/*
            Sem arrasto ainda, não existe "nova posição" — e inventar uma
            repetindo a anterior faria o botão Salvar parecer disponível para
            gravar o que já está gravado.
          */}
          {esboco
            ? `${formatarCoordenada(esboco.latitude)}, ${formatarCoordenada(
                esboco.longitude,
              )}`
            : "—"}
        </dd>
      </dl>

      {erro ? (
        <p
          className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs font-medium text-danger-fg"
          role="alert"
          data-testid="cto-map-position-error"
        >
          {erro}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCancelar}
          disabled={salvando}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted disabled:opacity-60"
          data-testid="cto-map-position-cancel"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onSalvar}
          /*
            Sem arrasto, não há o que salvar.

            Desabilitar aqui evita a requisição que o domínio recusaria como
            no-op — e evita que alguém conclua que salvou algo por ter clicado.
          */
          disabled={salvando || !esboco}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60"
          data-testid="cto-map-position-save"
        >
          {salvando ? "Salvando…" : "Salvar posição"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

/**
 * A busca é GLOBAL no tenant, e não do recorte.
 *
 * Quem procura a `A16` quase sempre está olhando outro bairro. Limitar ao que
 * está na tela responderia *"não existe"* sobre uma caixa que existe — a pior
 * resposta que um campo de busca pode dar.
 *
 * O fluxo é achar → **recentralizar** → o recorte carregar. Nada aqui desenha
 * marcador: quem desenha continua sendo a leitura do recorte.
 *
 * **O termo é CONTROLADO pelo pai** desde a `CTO-3.2.1`, porque ele agora
 * atravessa a navegação: quem volta de uma CTO precisa reencontrar o que
 * digitou. Estado local aqui morreria exatamente no momento em que precisaria
 * sobreviver.
 */
function CtoMapSearch({
  value,
  onValueChange,
  onSelect,
  canOpenDetail,
}: {
  value: string;
  onValueChange: (termo: string) => void;
  onSelect: (hit: MapSearchHit) => void;
  canOpenDetail: boolean;
}) {
  const [resultado, setResultado] = useState<MapSearchResult | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const guardRef = useRef(createLatestRequestGuard());

  useEffect(() => {
    /*
      Abaixo do mínimo não consulta.

      A constante é a MESMA que o domínio usa (`normalizeMapSearchQuery`), e não
      uma cópia — é uma regra só, com dois consumidores. E o servidor continua
      valendo: quem chamar a rota direto com um termo curto recebe lista vazia
      pela decisão dele, não pela desta tela.
    */
    const limpo = value.trim();
    if (usefulSearchLength(limpo) < CTO_MAP_SEARCH_MIN_QUERY) {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
      guardRef.current.begin();
      setResultado(null);
      setErro(null);
      setBuscando(false);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void (async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const bilhete = guardRef.current.begin();
        setBuscando(true);
        try {
          const res = await fetch(
            `/api/map/search?q=${encodeURIComponent(limpo)}`,
            { signal: controller.signal, cache: "no-store" },
          );
          const payload = await res.json().catch(() => null);
          if (!guardRef.current.isCurrent(bilhete)) return;
          if (!res.ok) {
            setErro(payload?.error ?? "Não foi possível buscar agora.");
            setResultado(null);
            return;
          }
          setResultado(payload?.data?.search ?? null);
          setErro(null);
        } catch {
          if (controller.signal.aborted) return;
          if (!guardRef.current.isCurrent(bilhete)) return;
          setErro("Erro de conexão na busca.");
          setResultado(null);
        } finally {
          if (guardRef.current.isCurrent(bilhete)) setBuscando(false);
        }
      })();
    }, CTO_MAP_VIEWPORT_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value]);

  const hits = resultado?.hits ?? [];
  const digitando = usefulSearchLength(value.trim()) < CTO_MAP_SEARCH_MIN_QUERY;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <label
        className="mb-1 block text-sm font-medium text-fg-secondary"
        htmlFor="cto-map-search"
      >
        Buscar CTO
      </label>
      <input
        id="cto-map-search"
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        maxLength={CTO_MAP_SEARCH_MAX_QUERY}
        placeholder="ex.: A16 ou o código da caixa"
        autoComplete="off"
        aria-describedby="cto-map-search-hint"
        className="w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        data-testid="cto-map-search-input"
      />
      <p id="cto-map-search-hint" className="mt-1 text-xs text-fg-muted">
        A busca procura em toda a sua rede, e não apenas na área visível.
      </p>

      <div aria-live="polite" data-testid="cto-map-search-results">
        {erro ? (
          <p className="mt-3 text-sm font-medium text-danger-fg" role="alert">
            {erro}
          </p>
        ) : null}

        {!erro && buscando ? (
          <p className="mt-3 text-xs text-fg-muted">Buscando…</p>
        ) : null}

        {!erro && !buscando && !digitando && resultado && hits.length === 0 ? (
          <p className="mt-3 text-sm text-fg-secondary">
            Nada encontrado com esse nome, código ou número de OS.
          </p>
        ) : null}

        {!erro && hits.length > 0 ? (
          <ul className="mt-3 divide-y divide-border-subtle rounded-lg border border-border">
            {hits.map((hit) => {
              const semLocalizacao =
                hit.latitude === null || hit.longitude === null;
              return (
                <li
                  key={`${hit.type}:${hit.id}`}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                  data-testid="cto-map-search-hit"
                  data-hit-type={hit.type}
                >
                  <div className="min-w-0">
                    {/*
                      O TIPO é dito, e não deduzido do formato do texto.

                      Numa lista com caixas, clientes e OS misturados, "A16"
                      poderia ser qualquer um dos três. Sem o selo, o operador
                      clicaria para descobrir — e a busca existe justamente para
                      ele não ter de fazer isso.
                    */}
                    <span
                      className="mb-0.5 inline-block rounded-full border border-border bg-surface-muted px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-fg-secondary"
                      data-testid="cto-map-search-hit-kind"
                    >
                      {ROTULO_DO_TIPO[hit.type]}
                    </span>
                    <p className="truncate text-sm font-medium text-fg">
                      {hit.label}
                    </p>
                    {hit.secondaryLabel ? (
                      <p className="truncate text-xs text-fg-muted">
                        {hit.secondaryLabel}
                      </p>
                    ) : null}
                  </div>

                  {/*
                    Sem coordenada NÃO recentraliza, e o botão nem existe.

                    Um "ver no mapa" que não faz nada — ou que leva a um ponto
                    inventado — é pior que a ausência dele. A caixa aparece na
                    busca, dita o motivo, e oferece o que ela realmente tem.
                  */}
                  {semLocalizacao ? (
                    <span
                      className="shrink-0 rounded-full border border-neutral-border bg-neutral-bg px-2 py-0.5 text-[11px] font-medium text-neutral-fg"
                      data-testid="cto-map-search-hit-unlocated"
                    >
                      Sem localização
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelect(hit)}
                      className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted"
                      data-testid="cto-map-search-hit-focus"
                    >
                      Ver no mapa
                    </button>
                  )}

                  {/*
                    A ação de abrir depende do TIPO, e a autorização de cada
                    destino continua sendo do servidor: `/ctos/[id]` é de
                    ADMIN, e a camada esconde o link quando sabe que ele
                    redirecionaria — oferecer algo que não funciona é pior que
                    não oferecer.
                  */}
                  {hit.type === "CTO" && canOpenDetail ? (
                    <Link
                      href={`/ctos/${hit.id}`}
                      className="shrink-0 text-xs font-medium text-primary-text underline underline-offset-2 hover:text-primary-text-hover"
                      data-testid="cto-map-search-hit-open"
                    >
                      Abrir CTO
                    </Link>
                  ) : null}
                  {hit.type === "CUSTOMER" ? (
                    <Link
                      href={`/clientes/${hit.id}/editar`}
                      className="shrink-0 text-xs font-medium text-primary-text underline underline-offset-2 hover:text-primary-text-hover"
                      data-testid="cto-map-search-hit-open"
                    >
                      Abrir cliente
                    </Link>
                  ) : null}
                  {hit.type === "SERVICE_ORDER" ? (
                    <Link
                      href={`/ordens/${hit.id}`}
                      className="shrink-0 text-xs font-medium text-primary-text underline underline-offset-2 hover:text-primary-text-hover"
                      data-testid="cto-map-search-hit-open"
                    >
                      Abrir OS
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {!erro && resultado?.truncated ? (
          <p className="mt-2 text-xs text-fg-muted">
            Mostrando as {resultado.limit} primeiras. Use um termo mais
            específico.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legenda
// ---------------------------------------------------------------------------

/**
 * Uma contagem do resumo: número grande, rótulo pequeno.
 *
 * O tom `ausente` é o das contagens de "sem localização", que respondem uma
 * pergunta diferente das de "nesta área" — elas não mudam quando o mapa se
 * move. Dar a elas o mesmo peso faria o operador somar as duas.
 */
function ResumoChip({
  valor,
  rotulo,
  tom,
  testId,
  href,
  hrefRotulo,
}: {
  valor: number;
  rotulo: string;
  tom?: "warning" | "ausente";
  testId: string;
  href?: string;
  hrefRotulo?: string;
}) {
  const cores =
    tom === "warning"
      ? "border-warning-border bg-warning-bg"
      : tom === "ausente"
        ? "border-dashed border-border bg-surface"
        : "border-border bg-surface";
  const corDoNumero =
    tom === "warning"
      ? "text-warning-fg"
      : tom === "ausente"
        ? "text-fg-muted"
        : "text-fg";

  return (
    <p
      className={`flex min-w-[7.5rem] flex-col rounded-lg border px-3 py-1.5 shadow-sm ${cores}`}
      data-testid={testId}
    >
      <span className={`text-lg font-semibold leading-tight tabular-nums ${corDoNumero}`}>
        {valor}
      </span>
      {/*
        O espaço antes do rótulo é PROPOSITAL.

        Número e rótulo ficam em linhas diferentes, então ele não aparece na
        tela — e faz o texto do elemento ler "0 CTOs nesta área" em vez de
        "0CTOs nesta área", que é o que uma leitura de tela (e um teste)
        recebe.
      */}
      <span className="text-[11px] leading-snug text-fg-secondary">
        {" "}
        {rotulo}
        {href && hrefRotulo ? (
          <>
            {" · "}
            <Link
              href={href}
              className="font-medium text-primary-text underline underline-offset-2 hover:text-primary-text-hover"
            >
              {hrefRotulo}
            </Link>
          </>
        ) : null}
      </span>
    </p>
  );
}

/** Um símbolo da legenda, desenhado igual ao marcador que ele explica. */
function SimboloDeLegenda({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

/**
 * A legenda, em TRÊS grupos — e só dos que estão desenhados.
 *
 * Antes ela explicava apenas as caixas, numa fila de quatro itens sem título.
 * Com clientes e OS no mapa, o operador via três famílias de símbolo e uma
 * legenda que respondia por uma. Agora cada grupo é nomeado.
 *
 * Grupo de camada DESLIGADA não aparece: explicar símbolo que não está na tela
 * é ruído, e a legenda cresceria justamente onde há menos espaço.
 *
 * Os símbolos são os MESMOS desenhos dos marcadores, não aproximações — um
 * quadradinho colorido "representando" o ponto faria a legenda divergir do
 * mapa na primeira mudança de forma.
 */
function MapLegend({
  layers,
  canSeeCustomers,
}: {
  layers: Record<MapLayer, boolean>;
  canSeeCustomers: boolean;
}) {
  const mostrarClientes = layers.CUSTOMERS && canSeeCustomers;

  return (
    <div
      className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-border-subtle bg-surface-muted px-3 py-1.5 text-xs text-fg-secondary"
      data-testid="map-legend"
    >
      {layers.CTOS ? (
        <section className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="map-legend-ctos">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Caixas
          </h3>
          {(["AVAILABLE", "FULL", "DAMAGED", "INACTIVE"] as const).map((status) => {
            const apresentacao = CTO_MAP_LEGEND[status];
            return (
              <span key={status} className="flex items-center gap-1.5">
                <SimboloDeLegenda>
                  <span
                    className={`cto-marker cto-marker--${apresentacao.shape} cto-marker--${apresentacao.tone}`}
                    style={{ width: 18, height: 18, fontSize: 10 }}
                  >
                    <span>{apresentacao.glyph}</span>
                  </span>
                </SimboloDeLegenda>
                {apresentacao.label}
              </span>
            );
          })}
        </section>
      ) : null}

      {mostrarClientes ? (
        <section
          className="flex flex-wrap items-center gap-x-4 gap-y-1"
          data-testid="map-legend-customers"
        >
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Clientes
          </h3>
          {(
            [
              /*
                "Cliente online", e não "Online".

                Na mesma legenda existe um grupo de OS com "Aberta" e "Urgente",
                e a caixa tem "Com vaga". Sem o sujeito, "Online" ficava solto —
                online o quê? O dono pediu o nome da coisa.
              */
              ["ONLINE", "success", "Cliente online"],
              ["OFFLINE", "danger", "Cliente offline"],
              ["UNKNOWN", "neutral", "Sem leitura"],
            ] as const
          ).map(([status, tom, rotulo]) => (
            <span key={status} className="flex items-center gap-1.5">
              <SimboloDeLegenda>
                <svg
                  className={`cto-dot cto-dot--${tom}`}
                  viewBox="0 0 18 18"
                  width="16"
                  height="16"
                >
                  {status === "ONLINE" ? (
                    <circle className="cto-dot__body" cx="9" cy="9" r="6" />
                  ) : status === "OFFLINE" ? (
                    <>
                      <circle className="cto-dot__body" cx="9" cy="9" r="6" />
                      <circle className="cto-dot__hollow" cx="9" cy="9" r="2.2" />
                    </>
                  ) : (
                    <circle
                      className="cto-dot__body cto-dot__body--sem-leitura"
                      cx="9"
                      cy="9"
                      r="5.6"
                    />
                  )}
                </svg>
              </SimboloDeLegenda>
              {rotulo}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <SimboloDeLegenda>
              <svg className="cto-dot cto-dot--neutral" viewBox="0 0 18 18" width="16" height="16">
                <circle className="cto-dot__order" cx="9" cy="9" r="8" />
                <circle className="cto-dot__body" cx="9" cy="9" r="6" />
              </svg>
            </SimboloDeLegenda>
            Com OS aberta
          </span>
          {/*
            O cliente com OS URGENTE — `CTO-3.2.2e`.

            O MESMO símbolo adicional do marcador: anel vermelho e o selo `!`
            no canto. O miolo neutro aqui não é um estado — é o lugar onde, no
            mapa, fica o online, o offline ou o sem leitura. É por isso que
            esta entrada vem por último e não substitui nenhuma das quatro.
          */}
          <span className="flex items-center gap-1.5" data-testid="map-legend-urgent-customer">
            <SimboloDeLegenda>
              <svg
                className="cto-dot cto-dot--neutral cto-dot--urgente"
                viewBox="0 0 18 18"
                width="16"
                height="16"
                overflow="visible"
              >
                <circle className="cto-dot__order cto-dot__order--urgente" cx="9" cy="9" r="8" />
                <circle className="cto-dot__body" cx="9" cy="9" r="6" />
                <circle className="cto-dot__bang-bg" cx="15.4" cy="2.6" r="3.6" />
                <text
                  className="cto-dot__bang"
                  x="15.4"
                  y="2.9"
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  !
                </text>
              </svg>
            </SimboloDeLegenda>
            Cliente com OS urgente
          </span>
        </section>
      ) : null}

      {layers.ORDERS ? (
        <section
          className="flex flex-wrap items-center gap-x-4 gap-y-1"
          data-testid="map-legend-orders"
        >
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            OS
          </h3>
          {/*
            DUAS entradas, porque são duas leituras diferentes.

            O laranja diz "há trabalho aberto aqui"; o vermelho com `!` diz
            "isto é urgente", e a urgência vem da prioridade do domínio — nunca
            do tipo, do status ou do tempo em aberto.

            Vermelho aqui e vermelho no cliente não se confundem: lá é OFFLINE,
            e as formas, os rótulos e estes dois grupos separam a semântica.
          */}
          <span className="flex items-center gap-1.5">
            <SimboloDeLegenda>
              <svg className="cto-order" viewBox="0 0 20 20" width="16" height="16">
                <polygon
                  className="cto-order__body"
                  points="10,1.5 18.5,10 10,18.5 1.5,10"
                />
              </svg>
            </SimboloDeLegenda>
            Aberta
          </span>
          <span className="flex items-center gap-1.5" data-testid="map-legend-urgent">
            <SimboloDeLegenda>
              <svg
                className="cto-order cto-order--urgente"
                viewBox="0 0 20 20"
                width="16"
                height="16"
              >
                <polygon
                  className="cto-order__body"
                  points="10,1.5 18.5,10 10,18.5 1.5,10"
                />
                <text
                  className="cto-order__bang"
                  x="10"
                  y="10"
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  !
                </text>
              </svg>
            </SimboloDeLegenda>
            Urgente
          </span>
        </section>
      ) : null}
    </div>
  );
}
