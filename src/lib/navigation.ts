import { AccessProfile } from "@prisma/client";

export type IconName =
  | "dashboard"
  | "orders"
  | "technicians"
  | "clients"
  | "users"
  | "integrations"
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
