import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'tokens.dart';

/// Temas claro e escuro do AlfaOS Field.
///
/// **Nenhuma cor é escrita direto num widget.** Tudo sai daqui, pelo mesmo
/// motivo da web: cor solta num componente é a que fica ilegível no dia em que
/// o tema muda, e ninguém descobre até um técnico reclamar de uma tela branca
/// no escuro.
///
/// ## O que este arquivo decide, e por quê
///
/// O primeiro piloto físico descreveu o aplicativo como "monocromático, cinza,
/// linear, muito próximo do Material padrão". A causa não era falta de cor
/// espalhada: era **falta de decisão** em três lugares que só existem aqui.
///
/// 1. **A escala tipográfica era a do Material.** Sem `textTheme` próprio, todo
///    texto saía no tamanho de fábrica, sem `height` nem `letterSpacing`
///    ajustados, e as telas não tinham hierarquia — só tamanhos parecidos.
/// 2. **O `ColorScheme` era `fromSeed` cru.** O gerador entrega um esquema
///    correto e sem personalidade; ele é ponto de partida, não resposta.
/// 3. **Faltava tema para metade dos componentes**, então cada tela resolvia o
///    seu por conta e o conjunto não parecia o mesmo produto.
///
/// A cor continua **contida**: ela marca ação e estado (urgente, em
/// atendimento, jornada ativa, botão principal) e nunca decora. Numa ferramenta
/// de trabalho, cor decorativa gasta a atenção que o técnico precisa ter para
/// o que é urgente de verdade.
class AppTheme {
  const AppTheme._();

  /// Azul institucional do AlfaOS. Não é `Colors.blue` nem o roxo de fábrica.
  static const _seed = Color(0xFF2563EB);

  static ThemeData get light => _build(Brightness.light);
  static ThemeData get dark => _build(Brightness.dark);

  /// A escala tipográfica, construída **por esquema**.
  ///
  /// Nunca compartilhada entre claro e escuro: um `TextTheme` já colorido,
  /// reusado nos dois, leva a cor de um modo para dentro do outro — e o
  /// sintoma é texto claro sobre fundo claro depois de trocar o tema.
  ///
  /// Razão ~1.15 entre degraus, `height` ajustado (títulos 1.2, corpo 1.45) e
  /// `letterSpacing` negativo só nos tamanhos grandes, onde o espaçamento de
  /// fábrica abre demais. Nada de `height` abaixo de 1.1: aperta a linha e
  /// corta as descidas de "g", "p" e "y".
  static TextTheme _textTheme(ColorScheme scheme) {
    final base = Typography.material2021(colorScheme: scheme).black;

    return base
        .copyWith(
          headlineSmall: const TextStyle(
            fontSize: 24,
            height: 1.2,
            letterSpacing: -0.4,
            fontWeight: FontWeight.w700,
          ),
          titleLarge: const TextStyle(
            fontSize: 20,
            height: 1.25,
            letterSpacing: -0.2,
            fontWeight: FontWeight.w700,
          ),
          titleMedium: const TextStyle(
            fontSize: 16,
            height: 1.3,
            letterSpacing: 0,
            fontWeight: FontWeight.w600,
          ),
          bodyLarge: const TextStyle(
            fontSize: 16,
            height: 1.45,
            letterSpacing: 0,
          ),
          bodyMedium: const TextStyle(
            fontSize: 14,
            height: 1.45,
            letterSpacing: 0,
          ),
          bodySmall: const TextStyle(
            fontSize: 13,
            height: 1.4,
            letterSpacing: 0,
          ),
          /*
            O rótulo de botão do Material vem em 14. Aqui ele sobe para 15 com
            peso 600: a ação principal é tocada de pé, com uma mão, às vezes
            com luva, e às vezes contra o sol.
          */
          labelLarge: const TextStyle(
            fontSize: 15,
            height: 1.2,
            letterSpacing: 0.1,
            fontWeight: FontWeight.w600,
          ),
          labelMedium: const TextStyle(
            fontSize: 12,
            height: 1.3,
            letterSpacing: 0.2,
            fontWeight: FontWeight.w600,
          ),
          /*
            O degrau dos rótulos de seção e de selo — "ATENÇÃO AGORA",
            "EM BREVE", "OPERACIONAL". Maiúsculas com `letterSpacing` positivo,
            porque caixa alta sem espaçamento fecha demais e vira mancha.
          */
          labelSmall: const TextStyle(
            fontSize: 11,
            height: 1.3,
            letterSpacing: 0.6,
            fontWeight: FontWeight.w700,
          ),
        )
        // A cor entra DEPOIS, do esquema ativo. É o que faz a troca de tema
        // repintar o texto em vez de deixá-lo para trás.
        .apply(bodyColor: scheme.onSurface, displayColor: scheme.onSurface);
  }

  static ThemeData _build(Brightness brightness) {
    final isDark = brightness == Brightness.dark;

    /*
      `fidelity` em vez do padrão `tonalSpot`.

      O padrão puxa qualquer semente para um tom pastel do sistema — e era
      parte do "cinza demais" que o piloto viu. `fidelity` preserva o azul
      institucional reconhecível, que é o que dá identidade sem espalhar cor.
    */
    final generated = ColorScheme.fromSeed(
      seedColor: _seed,
      brightness: brightness,
      dynamicSchemeVariant: DynamicSchemeVariant.fidelity,
    );

    final scheme = isDark
        ? generated.copyWith(
            // Quase preto, nunca `#000`: preto puro apaga a escada de
            // elevação por tom, e todo cartão vira a mesma superfície.
            surface: const Color(0xFF0E1116),
            surfaceContainerLowest: const Color(0xFF121620),
            surfaceContainerLow: const Color(0xFF161B26),
            surfaceContainer: const Color(0xFF1A2029),
            surfaceContainerHigh: const Color(0xFF20262F),
            surfaceContainerHighest: const Color(0xFF262D37),
            outlineVariant: const Color(0xFF2C3440),
          )
        : generated.copyWith(
            surface: const Color(0xFFFBFCFE),
            surfaceContainerLowest: Colors.white,
            surfaceContainerLow: const Color(0xFFF6F8FC),
            surfaceContainer: const Color(0xFFF1F4F9),
            surfaceContainerHigh: const Color(0xFFEAEFF6),
            surfaceContainerHighest: const Color(0xFFE3EAF3),
            outlineVariant: const Color(0xFFDCE3EC),
          );

    final text = _textTheme(scheme);

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      textTheme: text,
      scaffoldBackgroundColor: scheme.surface,
      extensions: [
        AlfaTheme(
          status: isDark ? AlfaStatusColors.dark : AlfaStatusColors.light,
        ),
      ],
      appBarTheme: AppBarTheme(
        centerTitle: false,
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        // A linha só aparece quando o conteúdo passa por baixo. Cabeçalho com
        // sombra permanente rouba altura de uma tela que já é pequena.
        scrolledUnderElevation: 0.5,
        titleTextStyle: text.titleLarge?.copyWith(color: scheme.onSurface),
        // Ícones da barra de status acompanham o TEMA, não o sistema: com o
        // aplicativo forçado em claro num aparelho escuro, o relógio some.
        systemOverlayStyle: isDark
            ? SystemUiOverlayStyle.light
            : SystemUiOverlayStyle.dark,
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        margin: EdgeInsets.zero,
        color: scheme.surfaceContainerLow,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AlfaRadius.lg),
          side: BorderSide(color: scheme.outlineVariant),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          // A ação principal é tocada de pé, com uma mão, às vezes de luva.
          minimumSize: const Size.fromHeight(AlfaSizing.primaryActionHeight),
          textStyle: text.labelLarge,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AlfaRadius.md),
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, AlfaSizing.minTouchTarget),
          textStyle: text.labelLarge,
          side: BorderSide(color: scheme.outlineVariant),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AlfaRadius.md),
          ),
        ),
      ),
      // Sem tema, `TextButton` fica em 36dp de altura — abaixo do mínimo do
      // Android, e num aplicativo usado com luva isso é toque perdido.
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(0, AlfaSizing.minTouchTarget),
          textStyle: text.labelLarge,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AlfaRadius.md),
          ),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerHighest,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AlfaRadius.md),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AlfaRadius.md),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AlfaRadius.md),
          borderSide: BorderSide(color: scheme.primary, width: 1.5),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AlfaSpacing.lg,
          vertical: AlfaSpacing.lg,
        ),
      ),
      listTileTheme: const ListTileThemeData(
        contentPadding: EdgeInsets.symmetric(horizontal: AlfaSpacing.lg),
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        space: 1,
        thickness: 1,
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surfaceContainer,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(AlfaRadius.xl),
          ),
        ),
      ),
      /*
        Barra principal com identidade, sem componente próprio.

        O padrão do Material deixa o destino ativo quase igual ao inativo — e a
        barra está em toda tela, então é onde o "linear e cinza" mais aparecia.
        Três ajustes, todos derivados do `ColorScheme`: pílula em
        `primaryContainer`, ícone ativo em `primary` contra `onSurfaceVariant`,
        e rótulo ativo em peso maior.

        Rótulo sempre visível: ícone sozinho obriga a decodificar desenho, e
        "Jornada" e "OS" não são universais.
      */
      navigationBarTheme: NavigationBarThemeData(
        height: 68,
        backgroundColor: scheme.surfaceContainer,
        surfaceTintColor: Colors.transparent,
        indicatorColor: scheme.primaryContainer,
        elevation: 0,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        iconTheme: WidgetStateProperty.resolveWith((states) {
          final active = states.contains(WidgetState.selected);
          return IconThemeData(
            size: 24,
            color: active ? scheme.primary : scheme.onSurfaceVariant,
          );
        }),
        labelTextStyle: WidgetStateProperty.resolveWith((states) {
          final active = states.contains(WidgetState.selected);
          return (text.labelMedium ?? const TextStyle()).copyWith(
            fontWeight: active ? FontWeight.w700 : FontWeight.w500,
            color: active ? scheme.primary : scheme.onSurfaceVariant,
          );
        }),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AlfaRadius.md),
        ),
      ),
    );
  }
}
