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
  | "profile";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  profiles: AccessProfile[];
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

export function navigationFor(profile: AccessProfile): NavItem[] {
  return NAVIGATION.filter((item) => item.profiles.includes(profile));
}

export const PROFILE_LABELS: Record<AccessProfile, string> = {
  ADMIN: "Administrador",
  DISPATCHER: "Despachante",
  TECHNICIAN: "Técnico",
};
