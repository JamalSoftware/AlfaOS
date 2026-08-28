import 'package:flutter/material.dart';

/// Tokens do AlfaOS Field.
///
/// A web tem tokens semânticos em CSS; aqui eles são reconstruídos em Dart, não
/// copiados classe por classe do Tailwind. Copiar literalmente amarraria o app
/// a decisões de um meio diferente — um celular ao sol precisa de contraste e
/// alvo de toque que uma tela de escritório não precisa.
///
/// O que é compartilhado é a INTENÇÃO: mesmos papéis semânticos, mesma família
/// de cor de estado, para que o técnico reconheça "urgente" como a mesma coisa
/// nas duas telas.
class AlfaSpacing {
  const AlfaSpacing._();

  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}

class AlfaRadius {
  const AlfaRadius._();

  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double pill = 999;
}

/// Alvos de toque.
///
/// 48dp é o mínimo da diretriz do Android; a ação principal usa mais que isso
/// porque ela é tocada com o polegar, de pé, segurando outra coisa.
class AlfaSizing {
  const AlfaSizing._();

  static const double minTouchTarget = 48;
  static const double primaryActionHeight = 56;
}

/// Cores de ESTADO, iguais em papel nos dois temas.
///
/// Elas não são "verde" e "vermelho": são "conectado" e "problema". Nomear pelo
/// papel é o que impede alguém de reusar o vermelho de erro para um detalhe
/// decorativo e, mais tarde, tornar impossível mudar a paleta.
class AlfaStatusColors {
  const AlfaStatusColors({
    required this.success,
    required this.successContainer,
    required this.warning,
    required this.warningContainer,
    required this.danger,
    required this.dangerContainer,
    required this.info,
    required this.infoContainer,
    required this.neutral,
    required this.neutralContainer,
  });

  final Color success;
  final Color successContainer;
  final Color warning;
  final Color warningContainer;
  final Color danger;
  final Color dangerContainer;
  final Color info;
  final Color infoContainer;
  final Color neutral;
  final Color neutralContainer;

  static const light = AlfaStatusColors(
    success: Color(0xFF15803D),
    successContainer: Color(0xFFDCFCE7),
    warning: Color(0xFFB45309),
    warningContainer: Color(0xFFFEF3C7),
    danger: Color(0xFFB91C1C),
    dangerContainer: Color(0xFFFEE2E2),
    info: Color(0xFF1D4ED8),
    infoContainer: Color(0xFFDBEAFE),
    neutral: Color(0xFF475569),
    neutralContainer: Color(0xFFF1F5F9),
  );

  /// No escuro o texto clareia e o fundo escurece — não é a paleta clara com
  /// opacidade. Container escuro com texto escuro seria ilegível justamente no
  /// chip de status, que é o que o técnico lê de relance.
  static const dark = AlfaStatusColors(
    success: Color(0xFF4ADE80),
    successContainer: Color(0xFF14532D),
    warning: Color(0xFFFBBF24),
    warningContainer: Color(0xFF451A03),
    danger: Color(0xFFFCA5A5),
    dangerContainer: Color(0xFF450A0A),
    info: Color(0xFF93C5FD),
    infoContainer: Color(0xFF172554),
    neutral: Color(0xFFCBD5E1),
    neutralContainer: Color(0xFF1E293B),
  );
}

/// Acesso aos tokens de estado a partir do `ThemeData`.
///
/// Extensão, e não variável global, para que o valor siga o tema em vigor —
/// inclusive quando o sistema troca de claro para escuro com o app aberto.
@immutable
class AlfaTheme extends ThemeExtension<AlfaTheme> {
  const AlfaTheme({required this.status});

  final AlfaStatusColors status;

  @override
  AlfaTheme copyWith({AlfaStatusColors? status}) =>
      AlfaTheme(status: status ?? this.status);

  @override
  AlfaTheme lerp(ThemeExtension<AlfaTheme>? other, double t) {
    // Sem interpolação: são cores de significado, não de decoração. Um estado
    // a meio caminho entre "online" e "offline" não quer dizer nada.
    if (other is! AlfaTheme) return this;
    return t < 0.5 ? this : other;
  }
}

extension AlfaThemeAccess on BuildContext {
  AlfaStatusColors get statusColors =>
      Theme.of(this).extension<AlfaTheme>()?.status ?? AlfaStatusColors.light;
}
