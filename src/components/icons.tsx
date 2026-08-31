import type { IconName } from "@/lib/navigation";

const paths: Record<IconName, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </>
  ),
  // Lista numerada: o despacho e sobre ORDEM, nao sobre quantidade nem sobre
  // quem. Tres linhas com marcadores a esquerda leem como "1o, 2o, 3o".
  dispatch: (
    <>
      <path d="M4 7h1M4 12h1M4 17h1" />
      <path d="M9 7h11M9 12h11M9 17h11" />
    </>
  ),
  // Relogio: a jornada e sobre TEMPO, nao sobre pessoas nem sobre OS.
  workday: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  devices: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  ordertypes: (
    <>
      <path d="M4 6h10" />
      <path d="M4 12h10" />
      <path d="M4 18h10" />
      <circle cx="19" cy="6" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
      <circle cx="19" cy="18" r="1.5" />
    </>
  ),
  orders: (
    <>
      <path d="M8 2h8a2 2 0 0 1 2 2v16l-6-4-6 4V4a2 2 0 0 1 2-2Z" />
      <path d="M9 8h6" />
    </>
  ),
  technicians: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-1a6 6 0 0 1 12 0v1" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M15.5 13.5a4 4 0 0 1 5 3.8V21" />
    </>
  ),
  clients: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="11" r="2.5" />
      <path d="M5.5 17a3.5 3.5 0 0 1 7 0" />
      <path d="M15 9.5h4M15 12.5h4M15 15.5h3" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20v-1.5A5.5 5.5 0 0 1 8.5 13h1A5.5 5.5 0 0 1 15 18.5V20" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M17.5 13.2A4.8 4.8 0 0 1 21 18.5V20" />
    </>
  ),
  integrations: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </>
  ),
  myorders: (
    <>
      <path d="M9 3h6v4H9z" />
      <rect x="3" y="3" width="6" height="4" />
      <rect x="15" y="3" width="6" height="4" />
      <path d="M4 7v14h16V7" />
      <path d="M8 12h8M8 16h8" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
};

export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "h-5 w-5"}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
