import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api/field_api_client.dart';
import '../core/location/location_service.dart';
import '../core/media/photo_capture.dart';
import '../core/storage/session_store.dart';
import '../features/auth/data/auth_repository.dart';
import '../features/auth/state/session_controller.dart';
import '../features/execution/data/execution_repository.dart';
import '../core/push/field_push_service.dart';
import '../core/push/push_coordinator.dart';
import '../core/push/push_prompt_memory.dart';
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

/// A fonte do token de push (`NF-2`).
///
/// Substituiu o `PushRegistrationService` inerte: manter os dois seria manter
/// duas costuras para a mesma coisa, e a fase seguinte teria de escolher entre
/// elas. Sem Firebase configurado esta implementação responde `unavailable` —
/// não finge entrega, e nada no aplicativo afirma que push está funcionando.
final fieldPushServiceProvider = Provider<FieldPushService>((ref) {
  return createFieldPushService();
});

/// Quando perguntar sobre notificações, e para onde o token vai (`NF-3`).
///
/// O destino é uma função, e não o repositório inteiro: o coordenador precisa
/// de UMA capacidade — entregar um token —, e recebê-la assim mantém `core/`
/// sem conhecer `features/` e deixa o teste substituir só isso.
final pushCoordinatorProvider = Provider<PushCoordinator>((ref) {
  return PushCoordinator(
    service: ref.watch(fieldPushServiceProvider),
    memory: const SharedPrefsPushPromptMemory(),
    sink: (token) =>
        ref.read(authRepositoryProvider).registerDevice(pushToken: token),
  );
});

final sessionControllerProvider =
    StateNotifierProvider<SessionController, SessionState>((ref) {
      return SessionController(
        auth: ref.watch(authRepositoryProvider),
        signal: ref.watch(sessionSignalProvider),
        push: ref.watch(pushCoordinatorProvider),
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
