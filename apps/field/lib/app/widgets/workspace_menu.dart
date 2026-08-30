import 'package:flutter/material.dart';

/// O mapa do Technician Workspace, declarado uma vez.
///
/// ## Por que uma lista de dados, e não widgets
///
/// A gaveta tem seis categorias e vinte itens. Escrevê-los como árvore de
/// widgets repetidos faria cada item novo copiar-colar `ListTile`, ícone,
/// padding e navegação — e o vigésimo primeiro sairia sutilmente diferente dos
/// vinte anteriores. Aqui o item é DADO; quem desenha é um widget só.
///
/// ## PLANNED aparece — e isso foi uma decisão revista
///
/// O PRD §256 dizia originalmente "item que não existe não aparece". O primeiro
/// piloto físico do App Shell mostrou o custo dessa regra: a gaveta com seis
/// linhas não comunicava o Workspace, e o técnico não tinha como saber o que o
/// AlfaOS vai fazer por ele. A política nova (§256, revisada) é outra:
///
/// * **barra principal** — só o que está implementado e é operacional;
/// * **gaveta** — pode apresentar o roadmap, com o planejado CLARAMENTE
///   marcado;
/// * **planejado nunca aparenta estar pronto** — sem rota falsa, sem API, sem
///   dado inventado.
///
/// A distinção mora em [WorkspaceItem.route]: item implementado tem rota; item
/// planejado tem `null`, e é isso — não um texto, não uma convenção — que
/// impede a navegação de acontecer.
enum WorkspaceCategory {
  operacional('OPERACIONAL'),
  clientes('CLIENTES'),
  meuTrabalho('MEU TRABALHO'),
  rede('REDE'),
  comunicacao('COMUNICAÇÃO'),
  conta('CONTA');

  const WorkspaceCategory(this.label);

  final String label;
}

/// Como um destino da gaveta se comporta ao ser tocado.
enum WorkspaceItemAction {
  /// Troca a aba ativa da barra principal. Não empilha.
  goBranch,

  /// Empilha por cima da tela atual — o back volta para onde estava.
  push,

  /// Não navega: abre a superfície única de módulo em preparação.
  planned,

  /// Encerra a sessão pelo controlador existente.
  logout,
}

@immutable
class WorkspaceItem {
  const WorkspaceItem({
    required this.id,
    required this.label,
    required this.icon,
    required this.action,
    this.route,
  });

  /// Identidade estável do item, independente do rótulo.
  ///
  /// Explícita de propósito, e não derivada de `label`: derivar produziria
  /// chaves ilegíveis para rótulos acentuados (`Início` → `in-cio`) e — pior —
  /// **mudaria a chave junto com o texto**, quebrando testes num dia em que
  /// alguém só ajustou uma palavra da interface.
  final String id;

  final String label;
  final IconData icon;
  final WorkspaceItemAction action;

  /// `null` para item planejado — e é a **ausência da rota**, não um rótulo,
  /// que garante que tocá-lo nunca leve a lugar nenhum falso.
  final String? route;

  bool get isPlanned => action == WorkspaceItemAction.planned;

  String get testKey => 'drawer-$id';
}

@immutable
class WorkspaceSection {
  const WorkspaceSection({required this.category, required this.items});

  final WorkspaceCategory category;
  final List<WorkspaceItem> items;
}

/// O Workspace inteiro, na ordem em que a gaveta o apresenta.
///
/// A ordem não é alfabética nem por módulo do backend: as categorias respondem
/// a perguntas do técnico (§256). `OPERACIONAL` é "o meu dia"; `CLIENTES` é
/// "sobre quem eu trabalho"; `MEU TRABALHO` é "o que é meu e eu levo comigo";
/// `REDE` é "o que eu mexo na casa do cliente"; `CONTA` é "eu".
const workspaceMenu = <WorkspaceSection>[
  WorkspaceSection(
    category: WorkspaceCategory.operacional,
    items: [
      WorkspaceItem(
        id: 'inicio',
        label: 'Início',
        icon: Icons.home_outlined,
        action: WorkspaceItemAction.goBranch,
        route: '/inicio',
      ),
      WorkspaceItem(
        id: 'orders',
        label: 'Ordens de Serviço',
        icon: Icons.assignment_outlined,
        action: WorkspaceItemAction.goBranch,
        route: '/orders',
      ),
      WorkspaceItem(
        id: 'jornada',
        label: 'Minha Jornada',
        icon: Icons.schedule_outlined,
        action: WorkspaceItemAction.goBranch,
        route: '/jornada',
      ),
      WorkspaceItem(
        id: 'mapa',
        label: 'Mapa Operacional',
        icon: Icons.map_outlined,
        action: WorkspaceItemAction.planned,
      ),
    ],
  ),
  WorkspaceSection(
    category: WorkspaceCategory.clientes,
    items: [
      WorkspaceItem(
        id: 'clientes',
        label: 'Clientes',
        icon: Icons.people_outline,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'contratos',
        label: 'Contratos e Assinaturas',
        icon: Icons.draw_outlined,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'rede-cliente',
        label: 'Rede do Cliente',
        icon: Icons.router_outlined,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'equipamentos',
        label: 'Equipamentos',
        icon: Icons.devices_other_outlined,
        action: WorkspaceItemAction.planned,
      ),
    ],
  ),
  WorkspaceSection(
    category: WorkspaceCategory.meuTrabalho,
    items: [
      WorkspaceItem(
        id: 'escala',
        label: 'Minha Escala',
        icon: Icons.calendar_month_outlined,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'estoque',
        label: 'Meu Estoque',
        icon: Icons.inventory_2_outlined,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'agenda',
        label: 'Agenda e Lembretes',
        icon: Icons.event_note_outlined,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'ferramentas',
        label: 'Ferramentas',
        icon: Icons.handyman_outlined,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'base-conhecimento',
        label: 'Base de Conhecimento',
        icon: Icons.menu_book_outlined,
        action: WorkspaceItemAction.planned,
      ),
    ],
  ),
  WorkspaceSection(
    category: WorkspaceCategory.rede,
    items: [
      WorkspaceItem(
        id: 'roteador',
        label: 'Configurar Roteador',
        icon: Icons.settings_input_antenna_outlined,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'diagnosticos',
        label: 'Diagnósticos',
        icon: Icons.troubleshoot_outlined,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'wifi',
        label: 'Wi-Fi',
        icon: Icons.wifi_outlined,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'fibra',
        label: 'Ferramentas de Fibra',
        icon: Icons.cable_outlined,
        action: WorkspaceItemAction.planned,
      ),
    ],
  ),
  WorkspaceSection(
    category: WorkspaceCategory.comunicacao,
    items: [
      WorkspaceItem(
        id: 'notifications',
        label: 'Notificações',
        icon: Icons.notifications_outlined,
        action: WorkspaceItemAction.push,
        route: '/notifications',
      ),
    ],
  ),
  WorkspaceSection(
    category: WorkspaceCategory.conta,
    items: [
      // Não existe tela de Perfil: o que a sessão expõe hoje já está em
      // Configurações. Prometer uma tela que não existe é o que a política
      // revisada proíbe — então ele entra como planejado, igual aos outros.
      WorkspaceItem(
        id: 'perfil',
        label: 'Perfil',
        icon: Icons.person_outline,
        action: WorkspaceItemAction.planned,
      ),
      WorkspaceItem(
        id: 'settings',
        label: 'Configurações',
        icon: Icons.settings_outlined,
        action: WorkspaceItemAction.push,
        route: '/settings',
      ),
      WorkspaceItem(
        id: 'logout',
        label: 'Sair',
        icon: Icons.logout_outlined,
        action: WorkspaceItemAction.logout,
      ),
    ],
  ),
];
