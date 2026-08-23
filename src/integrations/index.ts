import type { ERPProvider } from "@prisma/client";
import type { ERPIntegrationContract } from "./contract";
import { IntegrationError } from "./errors";
import { MockERPAdapter } from "./MockERPAdapter";
import { ReceitanetAdapter } from "./ReceitanetAdapter";
import type { FetchLike } from "./receitanet/CallCenterClient";

/**
 * O que um adapter precisa para existir, além do provider.
 *
 * O token chega JÁ DECIFRADO, resolvido por `resolveCompanyAdapter`
 * (`src/lib/erp-adapter.ts`). Esta camada não sabe como o segredo é
 * armazenado e não deve saber — é o que mantém o adapter testável sem banco
 * e o que permitirá trocar o esquema de credenciais sem tocar aqui.
 */
export interface ERPAdapterConfig {
  token?: string | null;
  baseUrl?: string | null;
  /** Injetável nos testes, para exercitar a integração sem tocar a rede. */
  fetchImpl?: FetchLike;
}

/**
 * Fábrica de adapters. O código de negócio depende do contrato, nunca de uma
 * implementação concreta.
 */
export function getERPAdapter(
  provider: ERPProvider,
  config: ERPAdapterConfig = {},
): ERPIntegrationContract {
  switch (provider) {
    case "RECEITANET": {
      /**
       * Sem token não existe adapter ReceitaNet utilizável, e devolver um que
       * falha em toda chamada empurraria o erro para longe da causa. Falha na
       * construção, onde a causa ainda é óbvia.
       */
      if (!config.token) {
        throw new IntegrationError(
          "AUTHENTICATION_FAILED",
          "RECEITANET",
          "adapter construído sem credencial",
        );
      }
      return new ReceitanetAdapter({
        token: config.token,
        baseUrl: config.baseUrl,
        fetchImpl: config.fetchImpl,
      });
    }
    case "MOCK":
    default:
      return new MockERPAdapter();
  }
}
