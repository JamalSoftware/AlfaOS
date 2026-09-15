/**
 * # RC-1D — os eventos da OS em português
 *
 * A timeline de `/ordens/[id]` mostrava `EVENT_LABELS[code] ?? code`, e o
 * `?? code` era o defeito: dos dezenove códigos que o produto grava, seis
 * tinham rótulo. O dono via `PRIORITY_CHANGED` na tela, e ao lado dele
 * `CHECKED_IN`, `CTO_PORT_MOVED`, `LOCATION_CONFIRMED`.
 *
 * ## Apresentação, e só
 *
 * O código continua exatamente como está no banco e nos eventos: isto traduz
 * na hora de desenhar. Nada aqui muda o que é gravado, e um rótulo não pode
 * virar a chave de nenhuma regra.
 *
 * ## O desconhecido não vira código na tela
 *
 * Um evento sem rótulo — dado antigo, ou um código novo que alguém esqueceu de
 * mapear — vira **"Evento registrado"**, e o código cru fica no `title`, para
 * quem investiga. É a mesma escolha da "Atividade recente" do painel: a tela
 * não quebra, e o operador não recebe uma palavra em maiúsculas com underscore.
 *
 * Quem impede o esquecimento é o teste: ele varre `src/` atrás de todo
 * `event: "..."` gravado e exige rótulo para cada um.
 *
 * O vocabulário segue o da timeline do CLIENTE
 * (`customer-timeline-presentation.ts`), para os dois lugares não nomearem o
 * mesmo fato de dois jeitos.
 */
export const SERVICE_ORDER_EVENT_LABELS: Readonly<Record<string, string>> = {
  SERVICE_ORDER_CREATED: "OS criada",
  SERVICE_ORDER_IMPORTED: "OS importada do ERP",
  TECHNICIAN_ASSIGNED: "Técnico atribuído",
  TECHNICIAN_CHANGED: "Técnico alterado",
  /** Legado: nada escreve mais, e OS antiga pode ter. */
  SERVICE_ORDER_STATUS_CHANGED: "Status alterado",
  PRIORITY_CHANGED: "Prioridade alterada",
  OS_STARTED: "Atendimento iniciado",
  OS_COMPLETED: "Atendimento concluído",
  CHECKED_IN: "Técnico no local (check-in)",
  CONTACT_ATTEMPTED: "Tentativa de contato",
  IMPEDIMENT_REPORTED: "Impedimento registrado",
  MATERIAL_USED: "Material utilizado",
  EQUIPMENT_INSTALLED: "Equipamento instalado",
  SIGNATURE_CAPTURED: "Assinatura coletada",
  LOCATION_CONFIRMED: "Localização confirmada em campo",
  LOCATION_CORRECTED: "Localização corrigida",
  ADDRESS_CORRECTED: "Endereço corrigido",
  CTO_PORT_CONNECTED: "Cliente conectado à porta da CTO",
  CTO_PORT_DISCONNECTED: "Cliente desconectado da porta da CTO",
  CTO_PORT_MOVED: "Cliente movido de porta da CTO",
};

/** O que o operador lê. Código desconhecido vira frase, nunca o código. */
export function serviceOrderEventLabel(code: string): string {
  return Object.prototype.hasOwnProperty.call(SERVICE_ORDER_EVENT_LABELS, code)
    ? SERVICE_ORDER_EVENT_LABELS[code]
    : "Evento registrado";
}
