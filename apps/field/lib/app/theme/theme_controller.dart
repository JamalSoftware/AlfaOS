import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Preferência de tema do técnico.
///
/// Fica **no aparelho**, não no servidor: é escolha de conforto visual, não
/// dado de domínio, e mandá-la ao backend criaria uma escrita autenticada para
/// algo que nem precisa de sessão.
///
/// O padrão é `system` — o aparelho já sabe se é dia ou noite, e o técnico que
/// configurou o Android para escurecer à noite espera que o app acompanhe.
class ThemeController extends StateNotifier<ThemeMode> {
  ThemeController({SharedPreferences? prefs})
    : _prefs = prefs,
      super(ThemeMode.system);

  static const _key = 'alfaos.field.theme_mode';

  SharedPreferences? _prefs;

  Future<SharedPreferences> get _preferences async =>
      _prefs ??= await SharedPreferences.getInstance();

  /// Allowlist fechada.
  ///
  /// Um valor estranho no armazenamento — arquivo editado, migração futura,
  /// corrupção — cai no padrão em vez de quebrar a construção do tema.
  static ThemeMode _parse(String? raw) {
    switch (raw) {
      case 'light':
        return ThemeMode.light;
      case 'dark':
        return ThemeMode.dark;
      case 'system':
      default:
        return ThemeMode.system;
    }
  }

  static String encode(ThemeMode mode) {
    switch (mode) {
      case ThemeMode.light:
        return 'light';
      case ThemeMode.dark:
        return 'dark';
      case ThemeMode.system:
        return 'system';
    }
  }

  Future<void> load() async {
    final prefs = await _preferences;
    state = _parse(prefs.getString(_key));
  }

  Future<void> setMode(ThemeMode mode) async {
    state = mode;
    final prefs = await _preferences;
    await prefs.setString(_key, encode(mode));
  }

  static String label(ThemeMode mode) {
    switch (mode) {
      case ThemeMode.light:
        return 'Claro';
      case ThemeMode.dark:
        return 'Escuro';
      case ThemeMode.system:
        return 'Sistema';
    }
  }
}
