/// # O que o Voltar do Android faz na casca (DQ-6)
///
/// Bug encontrado no piloto físico: o botão/gesto **Voltar** fechava o
/// aplicativo em telas principais. O técnico estava em `OS`, apertava Voltar
/// esperando ir para o `Início`, e o aplicativo simplesmente sumia.
///
/// A causa é estrutural, não um esquecimento: as três abas são branches de um
/// `StatefulShellRoute.indexedStack`, e trocar de aba **não empilha rota**.
/// Sem pilha para desempilhar, o `Navigator` raiz entrega o pop ao sistema — e
/// o sistema fecha o aplicativo. Do ponto de vista do Flutter estava tudo
/// certo; do ponto de vista de quem segura o celular, o aplicativo fechou
/// sozinho.
///
/// A decisão é uma função **pura** de propósito: ela precisa ser verificável
/// sem montar navegador, e o widget test prova que a casca realmente a
/// consulta.
library;

/// O que fazer com o Voltar, na ordem em que o usuário espera.
enum ShellBackAction {
  /// Há gaveta aberta: ela fecha, e nada mais acontece.
  closeDrawer,

  /// Está numa aba que não é o Início: volta para o Início.
  goHome,

  /// Início, sem nada aberto por cima: aqui — e **só** aqui — sair é a
  /// resposta certa.
  exitApp,
}

/// Índice do `Início` na barra principal.
const int homeBranchIndex = 0;

/// Resolve o Voltar da casca.
///
/// A ordem das perguntas é a ordem da expectativa: o que está **por cima**
/// fecha primeiro, depois a navegação recua, e sair é o último recurso.
///
/// Detalhe e execução não passam por aqui: eles são rotas do navegador raiz
/// (`parentNavigatorKey: _rootKey`) e têm pilha de verdade, então o `pop`
/// nativo já os devolve à tela anterior — que é o comportamento correto e o
/// motivo de esta função **não** mandar todo mundo para o Início.
ShellBackAction resolveShellBack({
  required int branchIndex,
  required bool drawerOpen,
}) {
  if (drawerOpen) return ShellBackAction.closeDrawer;
  if (branchIndex != homeBranchIndex) return ShellBackAction.goHome;
  return ShellBackAction.exitApp;
}
