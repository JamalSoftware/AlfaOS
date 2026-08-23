import {
  type ERPConnectionResult,
  type ERPIntegrationContract,
} from "./contract";
import type {
  ERPConnectivityObservation,
  ERPDiagnosticsCapability,
} from "./diagnostics";
import { IntegrationError } from "./errors";

/**
 * ReceitanetAdapter — structurally complete, functionally unimplemented.
 *
 * ## Why nothing here calls ReceitaNet
 *
 * As of v0.5 the repository contains NO ReceitaNet API documentation: no
 * OpenAPI/Swagger, no Postman collection, no PDF, no payload sample, no
 * authentication description, no base URL. A full-repository scan found none
 * of these.
 *
 * `docs/PRD.md` §27 records that official APIs were *identified as existing*
 * for clientes, chamados, contratos, dados da empresa, central do assinante
 * and informações financeiras. Identifying that an API exists is not the same
 * as holding its contract — it gives no endpoint, no method, no auth scheme
 * and no response shape. §64 makes the consequence explicit: an integration is
 * only implemented once there is official documentation, Swagger/OpenAPI,
 * Postman, official support information, or authorized testing.
 *
 * Guessing any of those would produce code that looks finished, passes its own
 * invented tests, and fails against the real API — while a technician in the
 * field trusts what it renders. So every operation below refuses, explicitly,
 * with `NOT_SUPPORTED`.
 *
 * ## Additionally blocked on credentials
 *
 * Even with documentation, live authentication could not ship today:
 * `ERPIntegration.apiKey` is a plaintext column, currently unused by any code
 * path, with no encryption-at-rest, key rotation or per-tenant key management
 * behind it. Storing a real provider credential there would be exactly the
 * "plaintext token in the database without deliberate architecture" that
 * `docs/SECURITY.md` forbids. That design is a prerequisite for live auth, not
 * something to improvise alongside a first integration.
 *
 * ## What to do when documentation arrives
 *
 * Implement one capability at a time, and for each one record in
 * `docs/ERP-INTEGRATIONS.md`: the source of the confirmation, the endpoint,
 * the method, the authentication scheme, the fields consumed, and the mapping
 * to the AlfaOS model. Route HTTP through a dedicated client so auth, timeout
 * and error normalization stay in one place — the shape `docs/PRD.md` §28
 * already anticipates. `withIntegrationTimeout` at the call site already
 * bounds any adapter in time, so a new adapter inherits that guarantee.
 */
export class ReceitanetAdapter
  implements ERPIntegrationContract, ERPDiagnosticsCapability
{
  readonly provider = "RECEITANET";

  async testConnection(): Promise<ERPConnectionResult> {
    return {
      ok: false,
      provider: this.provider,
      latencyMs: 0,
      message:
        "Integração com o ReceitaNet ainda não implementada. " +
        "Aguardando documentação oficial da API.",
    };
  }

  /**
   * Declares the capability and refuses every call.
   *
   * Declaring-and-refusing beats omitting the method: `supportsDiagnostics()`
   * would report `false` for an omission, and the UI would silently hide the
   * panel as though diagnostics were irrelevant for this provider. Refusing
   * explicitly surfaces "this provider cannot do this yet", which is the true
   * and actionable state.
   *
   * It never returns fabricated data, and never returns OFFLINE — AlfaOS not
   * having an integration says nothing about the customer's link.
   */
  async fetchCustomerConnectivity(): Promise<ERPConnectivityObservation> {
    throw new IntegrationError(
      "NOT_SUPPORTED",
      this.provider,
      "consulta de conectividade ReceitaNet não implementada: sem documentação oficial da API",
    );
  }
}
