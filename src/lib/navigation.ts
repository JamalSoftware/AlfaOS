import { AccessProfile } from "@prisma/client";

export type IconName =
  | "dashboard"
  | "orders"
  | "technicians"
  | "clients"
  | "users"
  | "integrations"
  | "ordertypes"
  | "devices"
  | "workday"
  | "dispatch"
  | "settings"
  | "myorders"
  | "cto"
  | "map"
  | "profile";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  profiles: AccessProfile[];
  /**
   * Capability da empresa que este item exige, quando exige alguma.
   *
   * Esconder o item é conveniência, **não** controle: a rota responde 404 por
   * conta própria quando a capability está desligada. As duas coisas existem
   * porque servem a públicos diferentes — o menu evita oferecer o que a empresa
   * não tem, e o 404 é o que sobra quando alguém chama a API direto.
   */
  requires?: "ctoNetwork";
}

/** O que a empresa tem contratado. Vem do banco, nunca da sessão. */
export interface CompanyFeatures {
  ctoNetworkEnabled: boolean;
}

export const NAVIGATION: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: "dashboard",
    profiles: [AccessProfile.ADMIN, AccessProfile.DISPATCHER],
  },
  {
    href: "/ordens",
    label: "Ordens de Serviço",
    icon: "orders",
    profiles: [AccessProfile.ADMIN, AccessProfile.DISPATCHER],
  },
  {
    // Despacho: a ORDEM de atendimento por técnico (PRD Parte XII). Fica logo
    // depois das OS porque é onde a fila delas é decidida — e antes de
    // Técnicos, que é cadastro, não operação.
    href: "/despacho",
    label: "Despacho",
    icon: "dispatch",
    profiles: [AccessProfile.ADMIN, AccessProfile.DISPATCHER],
  },
  {
    /*
      Mapa Operacional — ao lado do Despacho, porque é a mesma pergunta vista de
      outro jeito: o Despacho responde "quem está com o quê", o mapa responde
      "onde as coisas estão" (§207).

      O nome é da SUPERFÍCIE, e não da camada. Hoje só existe a camada de CTO;
      técnico, cliente e OS entram sobre o mesmo motor (§136), e um item
      chamado "Mapa de CTOs" obrigaria a segunda camada a nascer como uma
      segunda tela.

      `requires: "ctoNetwork"` é verdade ENQUANTO a única camada for a de CTO —
      sem o módulo, o mapa abriria vazio. Quando a segunda camada existir, esta
      condição precisa ser revisitada, e não herdada.
    */
    href: "/mapa",
    label: "Mapa Operacional",
    icon: "map",
    profiles: [AccessProfile.ADMIN, AccessProfile.DISPATCHER],
    requires: "ctoNetwork",
  },
  {
    href: "/tecnicos",
    label: "Técnicos",
    icon: "technicians",
    profiles: [AccessProfile.ADMIN, AccessProfile.DISPATCHER],
  },
  {
    href: "/clientes",
    label: "Clientes",
    icon: "clients",
    profiles: [AccessProfile.ADMIN, AccessProfile.DISPATCHER],
  },
  {
    href: "/minhas-os",
    label: "Minhas OS",
    icon: "myorders",
    profiles: [AccessProfile.TECHNICIAN],
  },
  {
    href: "/usuarios",
    label: "Usuários",
    icon: "users",
    profiles: [AccessProfile.ADMIN],
  },
  {
    href: "/tipos-os",
    label: "Tipos de OS",
    icon: "ordertypes",
    profiles: [AccessProfile.ADMIN],
  },
  {
    // Lista para ADMIN e DISPATCHER: saber quem esta em jornada e insumo do
    // despacho. Decidir correcao, dentro dela, continua so do ADMIN.
    href: "/jornada",
    label: "Jornada",
    icon: "workday",
    profiles: [AccessProfile.ADMIN, AccessProfile.DISPATCHER],
  },
  {
    // Cadastro de infraestrutura, e por isso fica perto dos outros cadastros —
    // longe de Despacho, que é operação do dia.
    href: "/ctos",
    label: "CTOs",
    icon: "cto",
    profiles: [AccessProfile.ADMIN],
    requires: "ctoNetwork",
  },
  {
    href: "/dispositivos",
    label: "Dispositivos",
    icon: "devices",
    profiles: [AccessProfile.ADMIN],
  },
  {
    href: "/integracoes",
    label: "Integrações",
    icon: "integrations",
    profiles: [AccessProfile.ADMIN],
  },
  {
    href: "/configuracoes",
    label: "Configurações",
    icon: "settings",
    profiles: [AccessProfile.ADMIN],
  },
  {
    href: "/perfil",
    label: "Perfil",
    icon: "profile",
    profiles: [
      AccessProfile.ADMIN,
      AccessProfile.DISPATCHER,
      AccessProfile.TECHNICIAN,
    ],
  },
];

export function navigationFor(
  profile: AccessProfile,
  features: CompanyFeatures = { ctoNetworkEnabled: false },
): NavItem[] {
  return NAVIGATION.filter((item) => {
    if (!item.profiles.includes(profile)) return false;
    // Padrão FECHADO: um item com `requires` que ninguém informou fica de fora.
    // Se a assinatura ganhar uma capability nova e algum chamador não for
    // atualizado, o item some do menu — em vez de aparecer para todo mundo.
    if (item.requires === "ctoNetwork") return features.ctoNetworkEnabled;
    return true;
  });
}

/**
 * Quem tem a busca global (GS-1, PRD §384).
 *
 * Os perfis que têm as listagens que ela resume — clientes, OS, técnicos. O
 * TECHNICIAN não tem nenhuma listagem na web (decisão do dono na abertura da
 * GS-1): o campo não aparece para ele e `/busca` o manda para a tela dele. É a
 * mesma lista que a página e o domínio conferem; esconder o campo é
 * conveniência, e quem barra é o servidor.
 */
export const GLOBAL_SEARCH_PROFILES: readonly AccessProfile[] = [
  AccessProfile.ADMIN,
  AccessProfile.DISPATCHER,
];

export function canUseGlobalSearch(profile: AccessProfile): boolean {
  return GLOBAL_SEARCH_PROFILES.includes(profile);
}

export const PROFILE_LABELS: Record<AccessProfile, string> = {
  ADMIN: "Administrador",
  DISPATCHER: "Despachante",
  TECHNICIAN: "Técnico",
};
