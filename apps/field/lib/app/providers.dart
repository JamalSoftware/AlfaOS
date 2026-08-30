import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api/field_api_client.dart';
import '../core/location/location_service.dart';
import '../core/media/photo_capture.dart';
import '../core/storage/session_store.dart';
import '../features/auth/data/auth_repository.dart';
import '../features/auth/state/session_controller.dart';
import '../features/execution/data/execution_repository.dart';
import '../features/notifications/data/notifications_repository.dart';
import '../features/orders/data/orders_repository.dart';
import 'theme/theme_controller.dart';

/// Injeção de dependência do aplicativo.
///
/// ## Por que Riverpod
///
/// Uma solução só, e escolhida por três motivos concretos: o estado precisa ser
/// acessível fora da árvore de widgets (o interceptor de rede sinaliza sessão
/// encerrada), `AsyncValue` já modela carregando/erro/dado — que é exatamente a
/// forma de toda tela deste app —, e a substituição de provider em teste é
/// nativa, o que permite testar widget contra um repositório falso sem
/// framework de mock.
///
/// **Uma solução, não quatro.** Misturar Provider, Bloc e GetX na mesma Alpha
/// deixaria cada tela com uma convenção diferente antes mesmo de o app existir.

final sessionStoreProvider = Provider<SessionStore>((ref) {
  return SecureSessionStore();
});

/// Ponte entre a camada de rede e o controlador de sessão.
///
/// Não depende de nada, e é o que evita o ciclo: o cliente HTTP precisa avisar
/// sobre 401, e o controlador precisa do cliente para autenticar.
final sessionSignalProvider = Provider<SessionSignal>((ref) {
  final signal = SessionSignal();
  ref.onDispose(signal.dispose);
  return signal;
});

final apiClientProvider = Provider<FieldApiClient>((ref) {
  final store = ref.watch(sessionStoreProvider);
  final signal = ref.watch(sessionSignalProvider);
  return FieldApiClient(
    tokenProvider: store.readToken,
    onSessionEnded: () async {
      // Token morto sai do cofre imediatamente; a navegação é consequência do
      // sinal, não deste callback.
      await store.clear();
      signal.sessionEnded();
    },
  );
});

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return AuthRepository(
    api: ref.watch(apiClientProvider),
    store: ref.watch(sessionStoreProvider),
  );
});

final ordersRepositoryProvider = Provider<OrdersRepository>((ref) {
  return OrdersRepository(api: ref.watch(apiClientProvider));
});

final notificationsRepositoryProvider = Provider<NotificationsRepository>((
  ref,
) {
  return NotificationsRepository(api: ref.watch(apiClientProvider));
});

final executionRepositoryProvider = Provider<ExecutionRepository>((ref) {
  return ExecutionRepository(api: ref.watch(apiClientProvider));
});

/// GPS e câmera entram por provider para que o teste os substitua.
///
/// Um widget test não tem sensor nenhum. Sem esta fronteira, a tela de execução
/// — que é a mais importante do aplicativo — seria a única intestável.
final locationServiceProvider = Provider<LocationService>((ref) {
  return const GeolocatorLocationService();
});

final photoCaptureProvider = Provider<PhotoCapture>((ref) {
  return const ImagePickerPhotoCapture();
});

/// Registro de push — inerte nesta Alpha.
///
/// Existe como ponto de extensão. **Não finge entrega**: devolve null, e nada
/// no aplicativo afirma que push está funcionando.
final pushRegistrationProvider = Provider<PushRegistrationService>((ref) {
  return const NoopPushRegistrationService();
});

final sessionControllerProvider =
    StateNotifierProvider<SessionController, SessionState>((ref) {
      return SessionController(
        auth: ref.watch(authRepositoryProvider),
        signal: ref.watch(sessionSignalProvider),
      );
    });

final themeControllerProvider =
    StateNotifierProvider<ThemeController, ThemeMode>((ref) {
      return ThemeController();
    });

/// A chave do `Scaffold` do App Shell — o único que possui a gaveta global.
///
/// Cada tela da barra principal (Início, OS, Jornada) tem o PRÓPRIO `Scaffold`
/// para manter AppBar e título independentes. Se cada uma também possuísse a
/// própria `Drawer`, ela nasceria aninhada dentro do `Scaffold` do shell — que
/// já reserva a faixa inferior para a `NavigationBar` — e a gaveta herdaria
/// essa altura reduzida, colidindo com a barra bem no item de baixo. A gaveta
/// mora só aqui; cada tela abre ESTA, por referência, no toque do próprio
/// hambúrguer.
final shellScaffoldKeyProvider = Provider<GlobalKey<ScaffoldState>>((ref) {
  return GlobalKey<ScaffoldState>();
});
