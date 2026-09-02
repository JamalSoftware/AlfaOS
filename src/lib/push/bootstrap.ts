import { FcmPushProvider, readFcmCredentials, type PushEnv } from "./fcm";
import { getPushProvider, setPushProvider } from "./provider";

/**
 * # Escolha do provider de push — uma vez por processo (`NF-1`)
 *
 * Roda na subida do worker, antes do primeiro lote. Não roda dentro do
 * handler: decidir provider por mensagem leria o ambiente N vezes e abriria a
 * porta para um processo enviar por dois caminhos diferentes no mesmo lote.
 *
 * ```text
 * credencial completa    → FcmPushProvider
 * credencial ausente     → segue com o Noop, e diz isso uma vez
 * credencial incompleta  → segue com o Noop, e diz QUAL falta
 * ```
 *
 * ## Fail-safe, e não fail-closed
 *
 * Ausência de Firebase **não derruba nada**. A web sobe, `npm test` roda,
 * `npm run build` passa e o worker processa a fila normalmente — só não
 * entrega push. É o comportamento que já existia antes desta fase, e mantê-lo
 * é o que permite desenvolver, testar e construir sem uma conta no Google.
 *
 * O oposto seria pior de um jeito específico: um worker que se recusa a subir
 * por falta de credencial de push também para de processar todo o resto do
 * outbox, e o push nunca foi o caminho crítico (PRD §157).
 */
export interface PushBootstrapResult {
  provider: string;
  /** Por que não é FCM, quando não é. Frase pronta para log. */
  reason?: string;
}

/** Nomes das variáveis, para a mensagem dizer exatamente o que falta. */
const REQUIRED = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
] as const;

function missingKeys(env: PushEnv): string[] {
  return REQUIRED.filter((key) => !(env[key] ?? "").trim());
}

/**
 * Instala o provider configurado e devolve o que foi escolhido.
 *
 * @param env injetável para teste. Nunca lê nem imprime o valor da chave.
 */
export function installConfiguredPushProvider(
  env: PushEnv = process.env,
): PushBootstrapResult {
  const missing = missingKeys(env);

  if (missing.length === REQUIRED.length) {
    return {
      provider: getPushProvider().name,
      reason: "Firebase não configurado — push desativado.",
    };
  }

  if (missing.length > 0) {
    /*
      Configuração PELA METADE é erro de operação, não ausência de intenção.

      Quem definiu duas das três variáveis quis ligar o push, e ficar em
      silêncio faria a fila parecer saudável enquanto nenhum técnico recebe
      nada. A mensagem nomeia as variáveis que faltam — nomes de variável não
      são segredo; valores são, e nenhum é lido aqui.
    */
    return {
      provider: getPushProvider().name,
      reason: `Configuração do Firebase incompleta: falta ${missing.join(", ")}. Push desativado.`,
    };
  }

  const credentials = readFcmCredentials(env);
  if (!credentials) {
    return {
      provider: getPushProvider().name,
      reason: "Credencial do Firebase inválida. Push desativado.",
    };
  }

  try {
    setPushProvider(new FcmPushProvider(credentials));
    return { provider: getPushProvider().name };
  } catch (error) {
    /*
      Credencial sintaticamente presente mas recusada pelo SDK — chave PEM
      truncada, por exemplo. O worker continua: a fila do outbox tem outros
      motivos para existir, e derrubar o processo transformaria um push
      indisponível em nenhum evento processado.
    */
    return {
      provider: getPushProvider().name,
      reason: `Firebase recusou a credencial: ${
        error instanceof Error ? error.message : "erro desconhecido"
      }. Push desativado.`,
    };
  }
}
