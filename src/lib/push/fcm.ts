import { cert, deleteApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

import type {
  PushDeliveryResult,
  PushMessage,
  PushNotificationProvider,
} from "./provider";

/**
 * # Provider real de push — Firebase Cloud Messaging (`NF-1`)
 *
 * Implementa `PushNotificationProvider` e mais nada. O domínio continua sem
 * saber que o Firebase existe: quem conhece esta classe é o bootstrap do
 * worker, e quem a usa é o handler do outbox, pela interface.
 *
 * ## Um Firebase da PLATAFORMA, não um por empresa
 *
 * Decisão de produto do `NF-1`: o AlfaOS tem **um** projeto Firebase, e não uma
 * credencial por tenant. Não existe `Company.firebaseKey`, e não deve passar a
 * existir. O isolamento entre empresas acontece onde sempre aconteceu — no
 * domínio, na consulta que escolhe os aparelhos —, e não numa segunda
 * credencial que alguém teria de rotacionar por cliente.
 *
 * O provider recebe uma lista de tokens já filtrada e **não decide tenant**.
 *
 * ## Onde este arquivo pode existir
 *
 * Só no worker. `outbox-handlers.ts` é alcançado por `scripts/outbox-worker.ts`
 * e pelos testes — por nenhuma rota do Next —, então `firebase-admin` fica fora
 * do bundle da web e a credencial de serviço nunca existe no runtime que
 * atende requisição de usuário.
 */

/**
 * Fonte de configuração. Um mapa de strings, e não `NodeJS.ProcessEnv`: a leitura
 * usa três chaves e nada mais, e o tipo estreito deixa o teste montar um
 * ambiente sem precisar fabricar o resto do processo.
 */
export type PushEnv = Readonly<Record<string, string | undefined>>;

/** Configuração de servidor. Nunca chega ao Flutter nem ao navegador. */
export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const APP_NAME = "alfaos-push";

/**
 * Lê a credencial do ambiente, ou `null` quando ela não está completa.
 *
 * ## Tudo ou nada
 *
 * Configuração pela metade é o caso perigoso: com `projectId` e sem chave, uma
 * inicialização parcial falharia no primeiro envio, dentro do worker, contando
 * tentativa e adiando o evento — um erro de configuração disfarçado de falha de
 * rede. Aqui ele vira uma decisão só, tomada na subida.
 */
export function readFcmCredentials(
  env: PushEnv = process.env,
): FcmCredentials | null {
  const projectId = env.FIREBASE_PROJECT_ID?.trim() ?? "";
  const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim() ?? "";
  const rawKey = env.FIREBASE_PRIVATE_KEY ?? "";

  if (!projectId || !clientEmail || !rawKey.trim()) return null;

  return { projectId, clientEmail, privateKey: normalizePrivateKey(rawKey) };
}

/**
 * Devolve a chave com quebras de linha reais.
 *
 * Um `.env` guarda a chave PEM em **uma** linha, com `\n` escapado — é como
 * quase toda hospedagem aceita valor multilinha. O SDK precisa das quebras de
 * verdade, e sem esta conversão o erro que aparece é de credencial inválida,
 * que manda quem estiver depurando procurar no lugar errado.
 *
 * As aspas envolventes também caem: `FIREBASE_PRIVATE_KEY="-----BEGIN..."` é
 * escrito assim com frequência, e o shell nem sempre as remove.
 */
export function normalizePrivateKey(raw: string): string {
  // `[\s\S]` em vez da flag `s`: o alvo do tsconfig base é anterior a ES2018.
  const unquoted = raw.replace(/^\s*"([\s\S]*)"\s*$/, "$1");
  return unquoted.replace(/\\n/g, "\n");
}

/**
 * Como uma falha do FCM deve ser tratada.
 *
 * ```text
 * PERMANENT   o token morreu. Sai do MobileDevice e não volta.
 * TRANSIENT   o FCM tropeçou. O outbox tenta de novo.
 * ```
 */
export type FcmFailureKind = "PERMANENT" | "TRANSIENT";

/**
 * Códigos que condenam o TOKEN — e só o token.
 *
 * `registration-token-not-registered` é o aplicativo desinstalado ou os dados
 * limpos. `invalid-registration-token` é token malformado. Os dois significam
 * que insistir nunca vai funcionar, e que a linha precisa perder o `pushToken`.
 *
 * `mismatched-credential` entra aqui por outro motivo: o token pertence a
 * OUTRO projeto Firebase. Insistir também não resolve, e a única saída é o
 * aparelho registrar um token novo.
 */
const PERMANENT_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
  "messaging/invalid-recipient",
  "messaging/mismatched-credential",
]);

/**
 * O mapper central. Existe num lugar só de propósito.
 *
 * Espalhar `if (code === ...)` pelo handler e pelo provider garantiria que um
 * código novo fosse tratado em um deles e esquecido no outro — e as duas
 * decisões são assimétricas demais para divergir em silêncio.
 *
 * ## O desconhecido é TRANSITÓRIO, e a assimetria é a razão
 *
 * Classificar um erro transitório como permanente **apaga o token** e cala
 * aquele aparelho para sempre, sem ninguém perceber. Classificar um permanente
 * como transitório gasta seis tentativas e depois aparece como `FAILED`, com
 * motivo, na fila. O primeiro erro é silencioso e definitivo; o segundo é
 * barulhento e reversível. Na dúvida, o barulhento.
 */
export function classifyFcmFailure(code: string | undefined): FcmFailureKind {
  if (!code) return "TRANSIENT";
  return PERMANENT_CODES.has(code) ? "PERMANENT" : "TRANSIENT";
}

/** Erro do SDK, na forma mínima que interessa aqui. */
function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export class FcmPushProvider implements PushNotificationProvider {
  readonly name = "fcm";

  private readonly app: App;

  /**
   * Inicializa o app do Firebase **uma vez**.
   *
   * O SDK guarda um pool de conexões e um access token OAuth renovado
   * sozinho; criar um app por mensagem jogaria os dois fora a cada envio e
   * trocaria uma requisição por três. `getApps()` é consultado porque um
   * processo pode instanciar o provider mais de uma vez — teste, sobretudo — e
   * `initializeApp` com nome repetido lança.
   */
  constructor(credentials: FcmCredentials) {
    const existing = getApps().find((app) => app.name === APP_NAME);
    this.app =
      existing ??
      initializeApp(
        {
          credential: cert({
            projectId: credentials.projectId,
            clientEmail: credentials.clientEmail,
            privateKey: credentials.privateKey,
          }),
          projectId: credentials.projectId,
        },
        APP_NAME,
      );
  }

  /**
   * Envia para todos os tokens numa chamada e classifica cada resposta.
   *
   * `sendEachForMulticast` devolve uma resposta **por token**, na mesma ordem
   * da entrada. É o que torna o sucesso parcial representável: numa lista de
   * três, um pode ter entregue, um ter morrido e um ter tropeçado — e os três
   * desfechos precisam sobreviver à mesma chamada.
   */
  async send(message: PushMessage): Promise<PushDeliveryResult> {
    if (message.tokens.length === 0) {
      return { delivered: 0, invalidTokens: [], retryableFailures: 0 };
    }

    let batch;
    try {
      batch = await getMessaging(this.app).sendEachForMulticast({
        tokens: message.tokens,
        notification: { title: message.title, body: message.body },
        ...(message.data ? { data: message.data } : {}),
      });
    } catch {
      /*
        Falha da CHAMADA inteira — rede, credencial recusada, FCM fora.

        O erro não é propagado nem registrado aqui: a mensagem do SDK pode
        carregar o corpo da requisição, e o corpo carrega os tokens. Quem
        reporta é o handler, com contagem e nome do provider.

        Nenhum token é condenado aqui: não houve resposta por token, e apagar
        `pushToken` de todo mundo porque a rede caiu deixaria a empresa inteira
        sem push até cada aparelho reabrir o aplicativo.
      */
      return {
        delivered: 0,
        invalidTokens: [],
        retryableFailures: message.tokens.length,
      };
    }

    const invalidTokens: string[] = [];
    let retryableFailures = 0;

    batch.responses.forEach((response, index) => {
      if (response.success) return;
      const kind = classifyFcmFailure(errorCode(response.error));
      if (kind === "PERMANENT") {
        invalidTokens.push(message.tokens[index]);
      } else {
        retryableFailures += 1;
      }
    });

    return {
      delivered: batch.successCount,
      invalidTokens,
      retryableFailures,
    };
  }

  /** Solta o app. Só o teste precisa disto; o worker termina o processo. */
  async dispose(): Promise<void> {
    await deleteApp(this.app);
  }
}
