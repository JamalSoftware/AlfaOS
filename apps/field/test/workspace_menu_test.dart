import 'package:alfaos_field/app/widgets/workspace_menu.dart';
import 'package:flutter_test/flutter_test.dart';

/// O registry da gaveta, auditado como DADO.
///
/// A política revisada do §256 só é honesta se duas coisas forem verdade ao
/// mesmo tempo: item planejado nunca navega, e item implementado navega para
/// algo que existe de verdade. As duas são propriedades do registry, não da
/// pintura — e por isso dá para prová-las sem montar widget nenhum.
void main() {
  final todos = workspaceMenu.expand((s) => s.items).toList();

  test('nenhum item PLANEJADO carrega rota', () {
    /*
      A garantia estrutural da política: é a AUSÊNCIA da rota que impede a
      navegação, não um `if` na tela. Um item planejado com rota preenchida
      seria uma navegação esperando para acontecer no dia em que alguém
      simplificasse o `switch` do drawer.
    */
    final planejadosComRota = todos.where(
      (i) => i.isPlanned && i.route != null,
    );

    expect(planejadosComRota, isEmpty);
  });

  test('todo item que NAVEGA tem rota conhecida pelo router', () {
    /*
      O contrário do teste acima, e o mais perigoso dos dois: um item
      implementado apontando para uma rota que o `GoRouter` não conhece só
      falha em tempo de execução, no aparelho, com a tela de erro do router.

      A lista é a das rotas reais de `router.dart`. Ela é curta e explícita de
      propósito: se alguém acrescentar um destino ao menu sem criar a rota,
      este teste falha antes de o APK sair.
    */
    const rotasReais = {
      '/inicio',
      '/orders',
      '/jornada',
      '/notifications',
      '/settings',
    };

    final navegam = todos.where(
      (i) =>
          i.action == WorkspaceItemAction.goBranch ||
          i.action == WorkspaceItemAction.push,
    );

    expect(navegam, isNotEmpty, reason: 'controle positivo');
    for (final item in navegam) {
      expect(
        item.route,
        isNotNull,
        reason: '${item.label} navega mas não tem rota',
      );
      expect(
        rotasReais,
        contains(item.route),
        reason: '${item.label} aponta para rota inexistente: ${item.route}',
      );
    }
  });

  test('os identificadores são únicos — chaves de teste não colidem', () {
    final ids = todos.map((i) => i.id).toList();
    expect(ids.toSet(), hasLength(ids.length));
  });

  test('sair não tem rota: encerra a sessão, não navega', () {
    final sair = todos.singleWhere(
      (i) => i.action == WorkspaceItemAction.logout,
    );
    // Quem decide para onde ir depois do logout é o `redirect` do router,
    // reagindo à fase da sessão — não o item do menu.
    expect(sair.route, isNull);
  });
}
