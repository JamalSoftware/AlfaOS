import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  // Retrato primeiro: a OS é lida e operada em pé, com uma mão. Paisagem não é
  // proibida por princípio — não há razão para bloqueá-la —, mas o layout é
  // desenhado para a orientação em que o técnico realmente usa o aparelho.
  SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  runApp(const ProviderScope(child: AlfaOsFieldApp()));
}
