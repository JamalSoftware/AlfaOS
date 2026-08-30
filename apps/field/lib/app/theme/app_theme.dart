import 'package:flutter/material.dart';

import 'tokens.dart';

/// Temas claro e escuro do AlfaOS Field.
///
/// **Nenhuma cor é escrita direto num widget.** Tudo sai daqui, pelo mesmo
/// motivo da web: cor solta num componente é a que fica ilegível no dia em que
/// o tema muda, e ninguém descobre até um técnico reclamar de uma tela branca
/// no escuro.
class AppTheme {
  const AppTheme._();

  static const _seed = Color(0xFF2563EB);

  static ThemeData get light => _build(Brightness.light);
  static ThemeData get dark => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final scheme = ColorScheme.fromSeed(
      seedColor: _seed,
      brightness: brightness,
    );
    final isDark = brightness == Brightness.dark;

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
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
        elevation: 0,
        scrolledUnderElevation: 1,
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
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AlfaRadius.md),
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, AlfaSizing.minTouchTarget),
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
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AlfaSpacing.lg,
          vertical: AlfaSpacing.lg,
        ),
      ),
      listTileTheme: const ListTileThemeData(
        contentPadding: EdgeInsets.symmetric(horizontal: AlfaSpacing.lg),
      ),
      /*
        Barra principal com identidade, sem componente próprio.

        O padrão do Material deixa o destino ativo quase igual ao inativo — o
        primeiro piloto físico descreveu o app como "linear e cinza", e a barra
        é onde isso mais aparece, porque ela está em toda tela. Três ajustes,
        todos derivados do `ColorScheme`:

        * a pílula do indicador usa `primaryContainer` em vez do tom neutro;
        * o ícone ativo é `primary`, o inativo é `onSurfaceVariant` — diferença
          de COR e de peso, não só de preenchimento;
        * o rótulo ativo é semibold.

        Rótulo sempre visível (`alwaysShow`): ícone sozinho obriga o técnico a
        decodificar desenho, e "Jornada" e "OS" não são universais.
      */
      navigationBarTheme: NavigationBarThemeData(
        height: 68,
        backgroundColor: scheme.surface,
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
          return TextStyle(
            fontSize: 12,
            fontWeight: active ? FontWeight.w700 : FontWeight.w500,
            color: active ? scheme.primary : scheme.onSurfaceVariant,
          );
        }),
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        space: 1,
        thickness: 1,
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
