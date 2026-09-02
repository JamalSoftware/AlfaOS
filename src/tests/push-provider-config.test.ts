import { describe, it, expect, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { deleteApp, getApps } from "firebase-admin/app";
import {
  classifyFcmFailure,
  normalizePrivateKey,
  readFcmCredentials,
} from "@/lib/push/fcm";
import { installConfiguredPushProvider } from "@/lib/push/bootstrap";
import type { PushEnv } from "@/lib/push/fcm";
import { getPushProvider, resetPushProvider } from "@/lib/push/provider";

/**
 * # Configuração e seleção do provider de push (`NF-1`)
 *
 * Puro: nenhuma chamada ao Firebase, nenhuma rede, nenhum banco. O que se prova
 * aqui é a **decisão** — qual provider o processo instala, e por quê.
 *
 * A credencial usada é sintaticamente plausível e completamente falsa. Ela
 * nunca sai daqui e nunca é impressa.
 */

/**
 * Uma chave RSA de verdade, gerada agora e jogada fora no fim.
 *
 * Precisa ser válida porque `cert()` do SDK **valida o PEM** — uma chave de
 * mentira cai no ramo de credencial recusada e o teste do caminho feliz
 * passaria a medir o fail-safe. Gerada em processo: não é segredo, não vale
 * contra o Google, e nunca sai daqui.
 */
const CHAVE_REAL = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

/** A mesma chave no formato que o `.env` guarda: uma linha, `\n` escapado. */
const CHAVE_ESCAPADA = CHAVE_REAL.replace(/\n/g, "\\n");

/** Sintaticamente plausível e completamente inútil — só para o ramo de recusa. */
const CHAVE_QUEBRADA =
  "-----BEGIN PRIVATE KEY-----\\nTRUNCADA\\n-----END PRIVATE KEY-----\\n";

function envCompleto(): PushEnv {
  return {
    FIREBASE_PROJECT_ID: "alfaos-teste",
    FIREBASE_CLIENT_EMAIL: "worker@alfaos-teste.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: CHAVE_ESCAPADA,
  };
}

/*
  Cada teste começa com o Firebase zerado.

  O provider reaproveita o app pelo NOME — é o que faz `installConfigured`
  duas vezes não lançar (FCM-05), e em produção não tem outro efeito porque o
  bootstrap roda uma vez por processo. Aqui, sem esta limpeza, o app criado no
  primeiro teste sobreviveria aos seguintes e o ramo de credencial recusada
  nunca seria alcançado — o teste passaria pelo motivo errado.
*/
afterEach(async () => {
  resetPushProvider();
  for (const app of getApps().filter((a) => a.name === "alfaos-push")) {
    await deleteApp(app);
  }
});

describe("FCM-01 · configuração completa instala o provider real", () => {
  it("o processo passa a enviar pelo FCM", () => {
    const resultado = installConfiguredPushProvider(envCompleto());

    expect(resultado.provider).toBe("fcm");
    expect(resultado.reason).toBeUndefined();
    expect(getPushProvider().name).toBe("fcm");
  });
});

describe("FCM-02 · sem configuração, segue no Noop", () => {
  it("não derruba nada e diz por quê", () => {
    const resultado = installConfiguredPushProvider({});

    /*
      Ausência de Firebase é o caso NORMAL em desenvolvimento e em teste. Se
      isto lançasse, `npm test` e `npm run build` exigiriam uma conta no
      Google — e o push nunca foi o caminho crítico.
    */
    expect(resultado.provider).toBe("noop");
    expect(resultado.reason).toContain("não configurado");
    expect(getPushProvider().name).toBe("noop");
  });
});

describe("FCM-03 · configuração PELA METADE não inicializa nada", () => {
  it("fica no Noop e nomeia a variável que falta", () => {
    const parcial = {
      FIREBASE_PROJECT_ID: "alfaos-teste",
      FIREBASE_PRIVATE_KEY: CHAVE_ESCAPADA,
    };

    const resultado = installConfiguredPushProvider(parcial);

    expect(resultado.provider).toBe("noop");
    /*
      Quem definiu duas das três variáveis QUIS ligar o push. Silêncio aqui
      faria a fila parecer saudável enquanto nenhum técnico recebe nada.
    */
    expect(resultado.reason).toContain("incompleta");
    expect(resultado.reason).toContain("FIREBASE_CLIENT_EMAIL");
  });

  it("a mensagem nomeia a variável, e nunca o VALOR de nenhuma", () => {
    const parcial = {
      FIREBASE_PROJECT_ID: "alfaos-teste",
      FIREBASE_CLIENT_EMAIL: "worker@alfaos-teste.iam.gserviceaccount.com",
    };

    const resultado = installConfiguredPushProvider(parcial);

    expect(resultado.reason).toContain("FIREBASE_PRIVATE_KEY");
    // Nome de variável não é segredo; valor é. Nenhum valor aparece.
    expect(resultado.reason).not.toContain("alfaos-teste");
    expect(resultado.reason).not.toContain("gserviceaccount");
  });

  it("credencial em branco conta como ausente, não como presente", () => {
    const resultado = installConfiguredPushProvider({
      FIREBASE_PROJECT_ID: "  ",
      FIREBASE_CLIENT_EMAIL: "",
      FIREBASE_PRIVATE_KEY: "   ",
    });

    expect(resultado.provider).toBe("noop");
  });

  it("chave presente mas RECUSADA pelo SDK também cai no Noop", () => {
    /*
      Configuração completa aos olhos do bootstrap, chave truncada aos olhos do
      `cert()`. O worker não pode morrer por isso: ele tem outros motivos para
      existir, e derrubar o processo trocaria "push indisponível" por "nenhum
      evento processado".
    */
    const resultado = installConfiguredPushProvider({
      FIREBASE_PROJECT_ID: "alfaos-teste",
      FIREBASE_CLIENT_EMAIL: "worker@alfaos-teste.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: CHAVE_QUEBRADA,
    });

    expect(resultado.provider).toBe("noop");
    expect(resultado.reason).toContain("recusou a credencial");
  });
});

describe("FCM-04 · a chave privada recupera as quebras de linha", () => {
  it("converte `\\n` escapado em quebra real", () => {
    const normalizada = normalizePrivateKey(CHAVE_ESCAPADA);

    /*
      O `.env` guarda a chave PEM em UMA linha. O SDK precisa das quebras de
      verdade, e sem esta conversão o erro que aparece é "credencial inválida"
      — que manda quem estiver depurando procurar no lugar errado.
    */
    expect(normalizada).toContain("\n");
    expect(normalizada).not.toContain("\\n");
    // Volta a ser exatamente a chave gerada, linha por linha.
    expect(normalizada).toBe(CHAVE_REAL);
  });

  it("remove as aspas envolventes que o shell às vezes deixa passar", () => {
    const comAspas = `"${CHAVE_ESCAPADA}"`;
    const normalizada = normalizePrivateKey(comAspas);

    expect(normalizada.startsWith("-----BEGIN")).toBe(true);
    expect(normalizada).not.toContain('"');
  });

  it("uma chave que já tem quebras reais passa intacta", () => {
    const real = "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----";
    expect(normalizePrivateKey(real)).toBe(real);
  });

  it("`readFcmCredentials` entrega a chave já normalizada", () => {
    const cred = readFcmCredentials(envCompleto());
    expect(cred).not.toBeNull();
    expect(cred!.privateKey).toContain("\n");
    expect(cred!.privateKey).not.toContain("\\n");
  });
});

describe("FCM-05 · o app do Firebase é inicializado uma vez só", () => {
  it("instalar duas vezes no mesmo processo não lança", () => {
    /*
      `initializeApp` com nome repetido LANÇA. Um provider que criasse um app
      por mensagem jogaria fora o pool de conexões e o access token OAuth a
      cada envio — e quebraria na segunda notificação do mesmo lote.
    */
    const primeira = installConfiguredPushProvider(envCompleto());
    const segunda = installConfiguredPushProvider(envCompleto());

    expect(primeira.provider).toBe("fcm");
    expect(segunda.provider).toBe("fcm");
    expect(segunda.reason).toBeUndefined();
  });
});

describe("a classificação de erro do FCM", () => {
  it("token morto é PERMANENTE — e só o token morre", () => {
    expect(
      classifyFcmFailure("messaging/registration-token-not-registered"),
    ).toBe("PERMANENT");
    expect(classifyFcmFailure("messaging/invalid-registration-token")).toBe(
      "PERMANENT",
    );
    expect(classifyFcmFailure("messaging/mismatched-credential")).toBe(
      "PERMANENT",
    );
  });

  it("indisponibilidade e quota são TRANSITÓRIAS", () => {
    expect(classifyFcmFailure("messaging/server-unavailable")).toBe(
      "TRANSIENT",
    );
    expect(classifyFcmFailure("messaging/internal-error")).toBe("TRANSIENT");
    expect(classifyFcmFailure("messaging/message-rate-exceeded")).toBe(
      "TRANSIENT",
    );
    expect(classifyFcmFailure("messaging/authentication-error")).toBe(
      "TRANSIENT",
    );
  });

  it("código DESCONHECIDO é transitório, e a assimetria é a razão", () => {
    /*
      Chamar transitório de permanente APAGA o token e cala aquele aparelho
      para sempre, sem ninguém perceber. Chamar permanente de transitório gasta
      seis tentativas e aparece como FAILED, com motivo, na fila. O primeiro
      erro é silencioso e definitivo; o segundo é barulhento e reversível.
    */
    expect(classifyFcmFailure("messaging/codigo-que-ainda-nao-existe")).toBe(
      "TRANSIENT",
    );
    expect(classifyFcmFailure(undefined)).toBe("TRANSIENT");
    expect(classifyFcmFailure("")).toBe("TRANSIENT");
  });
});
