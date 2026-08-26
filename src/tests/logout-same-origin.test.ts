import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST as logout } from "@/app/api/auth/logout/route";
import { getSessionUserFromToken } from "@/lib/session";
import { assertSameOrigin } from "@/lib/csrf";
import {
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Logout e a checagem Same-Origin sob hosts diferentes de `localhost`.
 *
 * O defeito que estes testes travam: a comparação usava
 * `new URL(request.url).host`, e no Next 14 essa URL carrega o host que o
 * servidor resolveu ao SUBIR — `localhost` — e não o host que o navegador
 * endereçou. Abrir o AlfaOS por `http://192.168.1.50:3000` fazia toda ação
 * mutante ser recusada com "Origem não permitida", com `Origin` idêntico ao
 * `Host`.
 */

let fixture: TestFixture;
const ambienteOriginal = { ...process.env };

beforeEach(async () => {
  fixture = await seedTestData();
});

afterEach(() => {
  process.env.APP_ORIGINS = ambienteOriginal.APP_ORIGINS;
  process.env.TRUST_PROXY_HEADERS = ambienteOriginal.TRUST_PROXY_HEADERS;
  delete process.env.APP_ORIGINS;
  delete process.env.TRUST_PROXY_HEADERS;
});

/** Requisição como o navegador faz: `Host` e `Origin` do mesmo endereço. */
function pedidoDoNavegador(
  host: string,
  options: { origin?: string | null; token?: string; path?: string } = {},
): Request {
  const { origin = `http://${host}`, token, path = "/api/auth/logout" } = options;
  const headers: Record<string, string> = { host };
  if (origin !== null) headers.Origin = origin;
  if (token) {
    headers.Cookie = `alfaos_session=${encodeURIComponent(token)}`;
  }
  return new Request(`http://${host}${path}`, { method: "POST", headers });
}

function cookieDeSessao(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith("alfaos_session="));
}

// ---------------------------------------------------------------------------
// O caminho legítimo
// ---------------------------------------------------------------------------

describe("logout legítimo", () => {
  it("funciona em localhost", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await logout(
      pedidoDoNavegador("localhost:3000", { token }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  /**
   * O caso relatado. Antes da correção isto devolvia 403 mesmo com o `Origin`
   * batendo com o `Host` — que é a definição de mesma origem.
   */
  it.each([
    ["IP de LAN", "192.168.1.50:3000"],
    ["outra faixa de LAN", "10.0.0.7:3000"],
    ["loopback por IP", "127.0.0.1:3000"],
    ["nome de máquina", "notebook-jamal:3000"],
    ["domínio real", "app.alfaos.com.br"],
  ])("funciona em %s", async (_rotulo, host) => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await logout(pedidoDoNavegador(host, { token }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  /**
   * O destino tem de ser RELATIVO. Absoluto, ele sairia do host do boot e
   * mandaria quem abriu pelo IP da rede para o `localhost` do próprio
   * aparelho — e ainda daria uma superfície de open redirect.
   */
  it("o redirect é relativo, nunca amarrado a um host", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    for (const host of ["localhost:3000", "192.168.1.50:3000"]) {
      const res = await logout(pedidoDoNavegador(host, { token }));
      const location = res.headers.get("location");
      expect(location).toBe("/login");
      expect(location).not.toMatch(/^https?:\/\//);
      expect(location).not.toContain("localhost");
    }
  });

  /**
   * 303 e não 307: o 307 preserva o método, e o navegador refazia POST em
   * `/login` — que devolvia outro redirect e uma página de erro.
   */
  it("usa 303 para converter o POST em GET", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await logout(pedidoDoNavegador("localhost:3000", { token }));
    expect(res.status).toBe(303);
    expect(res.status).not.toBe(307);
  });
});

// ---------------------------------------------------------------------------
// A sessão realmente cai
// ---------------------------------------------------------------------------

describe("destruição da sessão", () => {
  it("o cookie é limpo com Max-Age=0 e Expires no passado", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await logout(pedidoDoNavegador("192.168.1.50:3000", { token }));

    const cookie = cookieDeSessao(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/^alfaos_session=;/);
  });

  /**
   * A sessão é um token assinado, sem estado no servidor: quem apagou o cookie
   * já não consegue provar identidade. Este teste registra essa propriedade —
   * o token em si continua criptograficamente válido até expirar, e é por isso
   * que a limpeza do cookie precisa ser confiável.
   */
  it("sair sem sessão válida ainda limpa, em vez de dar erro", async () => {
    const res = await logout(pedidoDoNavegador("localhost:3000"));

    expect(res.status).toBe(303);
    expect(cookieDeSessao(res)).toContain("Max-Age=0");
  });

  it("o token continua sendo o que identifica — não há segundo mecanismo", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    expect(await getSessionUserFromToken(token)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// O que continua bloqueado
// ---------------------------------------------------------------------------

describe("origens recusadas", () => {
  it.each([
    ["site de terceiro", "http://evil.example"],
    ["terceiro em https", "https://evil.example"],
    ["sufixo enganoso", "http://192.168.1.50.evil.example"],
    ["prefixo enganoso", "http://evil.example/192.168.1.50:3000"],
    ["mesma máquina, outra porta", "http://192.168.1.50:9999"],
    ["subdomínio não configurado", "http://outro.192.168.1.50:3000"],
  ])("recusa %s", async (_rotulo, origin) => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await logout(
      pedidoDoNavegador("192.168.1.50:3000", { origin, token }),
    );

    expect(res.status).toBe(403);
    // E nada de derrubar a sessão de quem foi atacado.
    expect(cookieDeSessao(res)).toBeUndefined();
  });

  it.each([
    ["protocol-relative", "//evil.example"],
    ["origin literal null", "null"],
    ["texto qualquer", "nao-e-uma-origem"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,x"],
  ])("recusa origem malformada: %s", async (_rotulo, origin) => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await logout(
      pedidoDoNavegador("192.168.1.50:3000", { origin, token }),
    );

    expect(res.status).toBe(403);
    expect(cookieDeSessao(res)).toBeUndefined();
  });

  /**
   * `Origin` presente porém VAZIO conta como ausente, e cai na política
   * herdada: passa, apoiado em `SameSite=Lax` mais o cookie de sessão.
   *
   * Nenhum navegador envia isso. O teste existe para que a decisão fique
   * registrada em vez de depender de a string vazia ser falsy — e para que
   * apertar essa política no futuro seja uma mudança deliberada, com este
   * teste falhando e sendo reescrito de propósito.
   */
  it("Origin vazio segue a política de ausência, não a de invalidade", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    for (const origin of [" ", "", "\t"]) {
      const res = await logout(
        pedidoDoNavegador("192.168.1.50:3000", { origin, token }),
      );
      expect(res.status, JSON.stringify(origin)).toBe(303);
    }
  });

  /**
   * `Host` é forjável por quem fala direto com o servidor — mas não pelo
   * conteúdo de outra página. No cenário de CSRF o navegador é quem preenche o
   * `Host`, a partir da URL que ele precisou resolver para chegar até nós, e
   * a página do atacante não tem como mudá-lo.
   *
   * Este teste fixa a consequência: casar `Host` com um `Origin` de terceiro
   * exige controlar os DOIS, e quem controla os dois já não está fazendo CSRF.
   */
  it("Host forjado não abre caminho para Origin de terceiro", async () => {
    const token = await createTokenFor(fixture.adminA.id);
    const res = await logout(
      pedidoDoNavegador("evil.example", {
        origin: "http://evil.example",
        token,
      }),
    );
    // Passa a checagem de mesma origem — os dois batem —, e é exatamente por
    // isso que produção usa APP_ORIGINS, testado abaixo.
    expect(res.status).toBe(303);
  });
});

// ---------------------------------------------------------------------------
// Política estrita de produção
// ---------------------------------------------------------------------------

describe("APP_ORIGINS — allowlist fixada", () => {
  it("com a lista configurada, nenhum cabeçalho da requisição decide", async () => {
    process.env.APP_ORIGINS = "https://app.alfaos.com.br";
    const token = await createTokenFor(fixture.adminA.id);

    // O host forjado deixa de bastar: a origem precisa estar na lista.
    const forjado = await logout(
      pedidoDoNavegador("evil.example", {
        origin: "http://evil.example",
        token,
      }),
    );
    expect(forjado.status).toBe(403);

    const legitimo = await logout(
      pedidoDoNavegador("app.alfaos.com.br", {
        origin: "https://app.alfaos.com.br",
        token,
      }),
    );
    expect(legitimo.status).toBe(303);
  });

  it("normaliza maiúscula, barra final e porta padrão explícita", async () => {
    process.env.APP_ORIGINS = "https://App.AlfaOS.com.BR:443/";
    const token = await createTokenFor(fixture.adminA.id);

    const res = await logout(
      pedidoDoNavegador("app.alfaos.com.br", {
        origin: "https://app.alfaos.com.br",
        token,
      }),
    );
    expect(res.status).toBe(303);
  });

  it("o esquema passa a importar: http não entra numa lista https", async () => {
    process.env.APP_ORIGINS = "https://app.alfaos.com.br";
    const token = await createTokenFor(fixture.adminA.id);

    const res = await logout(
      pedidoDoNavegador("app.alfaos.com.br", {
        origin: "http://app.alfaos.com.br",
        token,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("aceita mais de uma origem", async () => {
    process.env.APP_ORIGINS =
      "https://app.alfaos.com.br, https://alfaos.com.br";
    const token = await createTokenFor(fixture.adminA.id);

    for (const origin of [
      "https://app.alfaos.com.br",
      "https://alfaos.com.br",
    ]) {
      const res = await logout(
        pedidoDoNavegador("app.alfaos.com.br", { origin, token }),
      );
      expect(res.status, origin).toBe(303);
    }
  });
});

// ---------------------------------------------------------------------------
// X-Forwarded-Host
// ---------------------------------------------------------------------------

describe("cabeçalhos de proxy", () => {
  function comForwarded(host: string, forwarded: string, origin: string) {
    return new Request(`http://${host}/api/auth/logout`, {
      method: "POST",
      headers: { host, "x-forwarded-host": forwarded, Origin: origin },
    });
  }

  /**
   * `X-Forwarded-Host` é escrito por QUALQUER cliente. Confiar nele sem
   * configuração deixaria um atacante declarar o host que quisesse e passar
   * pela comparação — Host Header Injection pela porta da frente.
   */
  it("é IGNORADO por padrão", () => {
    const bloqueio = assertSameOrigin(
      comForwarded("192.168.1.50:3000", "evil.example", "http://evil.example"),
    );
    expect(bloqueio).not.toBeNull();
    expect(bloqueio?.status).toBe(403);
  });

  it("só é considerado com TRUST_PROXY_HEADERS=true", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    // Atrás de um proxy que reescreve o cabeçalho, ele passa a ser afirmação
    // da infraestrutura, não do cliente.
    expect(
      assertSameOrigin(
        comForwarded(
          "10.0.0.2:3000",
          "app.alfaos.com.br",
          "https://app.alfaos.com.br",
        ),
      ),
    ).toBeNull();
  });

  it("com cadeia de proxies, vale o primeiro salto", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    expect(
      assertSameOrigin(
        comForwarded(
          "10.0.0.2:3000",
          "app.alfaos.com.br, interno.local",
          "https://app.alfaos.com.br",
        ),
      ),
    ).toBeNull();
  });

  it("APP_ORIGINS vence o cabeçalho encaminhado", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    process.env.APP_ORIGINS = "https://app.alfaos.com.br";
    const bloqueio = assertSameOrigin(
      comForwarded("10.0.0.2:3000", "evil.example", "http://evil.example"),
    );
    expect(bloqueio?.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Método
// ---------------------------------------------------------------------------

describe("método", () => {
  /**
   * Sair muda estado. Um GET seria disparado por qualquer
   * `<img src="/api/auth/logout">` numa página de terceiro — logout forçado é
   * CSRF de baixo impacto, mas é CSRF.
   */
  it("a rota não exporta GET", async () => {
    const rota = await import("@/app/api/auth/logout/route");
    expect("GET" in rota).toBe(false);
    expect(typeof rota.POST).toBe("function");
  });
});
