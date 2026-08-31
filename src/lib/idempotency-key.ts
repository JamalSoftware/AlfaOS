/**
 * Gera uma chave de idempotência aceita pelo servidor (`[A-Za-z0-9._:-]`, 8–200).
 *
 * `randomUUID` não existe em contexto não seguro; o `Math.random` de reserva
 * não precisa ser criptográfico, porque a chave **não autoriza nada** — ela só
 * distingue submissões, e o escopo dela já é `(empresa, usuário, operação)`.
 *
 * Vive aqui, e não colada em cada formulário, porque duas cópias da mesma
 * função são duas chances de uma delas passar a gerar chave fora do formato
 * que a rota aceita.
 *
 * **Uma chave por INTENÇÃO do usuário**, não por requisição: um reenvio da
 * mesma tentativa reutiliza a chave — é o que faz o servidor devolver o
 * desfecho guardado em vez de aplicar a operação de novo. Uma ação nova pede
 * uma chave nova.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
