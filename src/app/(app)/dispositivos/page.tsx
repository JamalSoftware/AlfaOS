import type { Metadata } from "next";
import { requirePageProfile } from "@/lib/guards";
import { listCompanyMobileDevices } from "@/lib/mobile-devices";
import { EmptyState } from "@/components/EmptyState";
import { RevokeDeviceButton } from "@/components/RevokeDeviceButton";

export const metadata: Metadata = {
  title: "Dispositivos",
};

/**
 * Aparelhos do Field registrados na empresa.
 *
 * Existe por um motivo só, e é o cenário que justifica o `MobileDevice`
 * existir: **celular perdido**. Sem esta tela, cortar o acesso exigia abrir o
 * banco — e a alternativa prática era trocar a senha do técnico, o que derruba
 * os outros aparelhos dele e ainda deixa o push entregando OS ao aparelho
 * perdido.
 *
 * Deliberadamente pequena. Sessões por aparelho, versão mínima do app e
 * bloqueio de versão insegura continuam DIFERENCIAL (`docs/SECURITY.md` §8.9)
 * e não entram só porque a tela passou a existir.
 */

function formatDateTime(date: Date | null): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default async function MobileDevicesPage() {
  const session = await requirePageProfile(["ADMIN"]);
  const devices = await listCompanyMobileDevices(session.companyId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-fg">Dispositivos</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Aparelhos com o aplicativo do técnico instalado. Revogar corta o
          acesso imediatamente e interrompe as notificações.
        </p>
      </div>

      {devices.length === 0 ? (
        <EmptyState
          title="Nenhum dispositivo registrado"
          description="Os aparelhos aparecem aqui depois que um técnico entra pelo aplicativo do AlfaOS Field."
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-surface shadow-sm">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Técnico</th>
                <th className="px-4 py-3 font-semibold">Aparelho</th>
                <th className="px-4 py-3 font-semibold">Versão</th>
                <th className="px-4 py-3 font-semibold">Sessão</th>
                <th className="px-4 py-3 font-semibold">Visto por último</th>
                <th className="px-4 py-3 font-semibold text-right">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {devices.map((device) => (
                <tr key={device.id} data-testid="device-row">
                  <td className="px-4 py-3">
                    <div className="font-medium text-fg">{device.userName}</div>
                    <div className="text-xs text-fg-muted">
                      {device.userEmail}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-fg-secondary">
                    {device.deviceName ?? "—"}
                    <div className="text-xs text-fg-muted">
                      {device.platform}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-fg-secondary">
                    {device.appVersion ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {device.revokedAt !== null ? (
                      <span className="text-xs font-medium text-danger-fg">
                        Revogado
                      </span>
                    ) : device.hasActiveSession ? (
                      <span className="text-xs font-medium text-success-fg">
                        Ativa
                      </span>
                    ) : (
                      /*
                        "Expirada" e "revogado" são fatos diferentes e a tela
                        não os mistura: o primeiro se resolve sozinho no
                        próximo login, o segundo exige decisão de gente.
                      */
                      <span className="text-xs text-fg-muted">Expirada</span>
                    )}
                    {device.pushEnabled && device.revokedAt === null && (
                      <div className="text-xs text-fg-muted">
                        Notificações ativas
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-fg-secondary">
                    {formatDateTime(device.lastSeenAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RevokeDeviceButton
                      deviceId={device.id}
                      userName={device.userName}
                      revoked={device.revokedAt !== null}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
