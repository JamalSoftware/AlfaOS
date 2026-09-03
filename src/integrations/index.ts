import type { ERPProvider } from "@prisma/client";
import type { ERPIntegrationContract } from "./contract";
import { IntegrationError } from "./errors";
import { MockERPAdapter } from "./MockERPAdapter";
import { ReceitanetAdapter } from "./ReceitanetAdapter";
import { SgpAdapter } from "./SgpAdapter";
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
  /**
   * Nome da aplicação no provider, quando o esquema de autenticação o exige.
   *
   * Existe para o par Token/App do SGP. **Não é segredo** — o segredo é o
   * token, e é por isso que este campo viaja em claro ao lado dele em vez de
   * passar pelo cofre de credenciais.
   */
  app?: string | null;
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
    case "SGP": {
      /**
       * O SGP exige os TRÊS: sem qualquer um deles não existe adapter
       * utilizável. `baseUrl` porque cada provedor tem instalação própria, e
       * `app` porque a documentação oficial o marca obrigatório junto do token.
       *
       * A recusa acontece na construção, onde a causa ainda é óbvia — mesma
       * política do ReceitaNet acima. `SgpClient` valida os três e lança
       * `AUTHENTICATION_FAILED` nomeando qual falta.
       */
      return new SgpAdapter({
        baseUrl: config.baseUrl ?? "",
        app: config.app ?? "",
        token: config.token ?? "",
        fetchImpl: config.fetchImpl,
      });
    }
    case "MOCK":
    default:
      return new MockERPAdapter();
  }
}
