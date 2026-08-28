import 'dart:io';

import 'package:alfaos_field/core/errors/field_error.dart';
import 'package:alfaos_field/core/location/location_service.dart';
import 'package:alfaos_field/core/media/photo_capture.dart';
import 'package:alfaos_field/core/sync/pending_operation.dart';
import 'package:alfaos_field/features/execution/data/execution_repository.dart';
import 'package:alfaos_field/features/execution/domain/execution.dart';
import 'package:alfaos_field/features/execution/state/execution_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_transport.dart';

/// # O controlador da execução
///
/// Aqui ficam os invariantes que a tela não consegue exercitar: o envio de foto
/// monta um multipart a partir de um `File`, e ler arquivo é I/O real — dentro
/// da zona de tempo falso de um widget test ele nunca completa, e o teste
/// pendura em vez de falhar.
///
/// O dublê abaixo substitui o repositório e não toca disco, então o caminho de
/// resiliência da foto (§58) fica testável de verdade.

/// Repositório dublê. Só o que estes testes exercitam é sobrescrito.
class StubRepository extends ExecutionRepository {
  StubRepository()
    : super(api: buildTestClientWith(FakeTransport(), FakeSessionStore()));

  ExecutionBundle Function()? bundleBuilder;
  Object? evidenceError;
  int evidenceCalls = 0;
  final List<String> evidenceKeys = [];

  @override
  Future<ExecutionBundle> load(String orderId) async {
    return (bundleBuilder ?? _defaultBundle)();
  }

  @override
  Future<List<StockLine>> stock() async => const [];

  @override
  Future<void> addEvidence({
    required String orderId,
    required int expectedVersion,
    required String category,
    required File file,
    required String idempotencyKey,
    String? caption,
    DateTime? capturedAt,
  }) async {
    evidenceCalls += 1;
    evidenceKeys.add(idempotencyKey);
    final error = evidenceError;
    if (error != null) throw error;
  }
}

ExecutionBundle _defaultBundle() => ExecutionBundle.fromJson({
  'orderId': 'os-1',
  'version': 5,
  'executionVersion': 2,
  'report': {
    'diagnosis': 'Diagnóstico.',
    'workPerformed': 'Serviço.',
    'notes': null,
  },
  'location': {'status': 'CONFIRMED', 'verified': true, 'version': 1},
  'requirements': const <String, dynamic>{},
  'pendencies': const <Map<String, dynamic>>[],
});

class StubPhotoCapture implements PhotoCapture {
  StubPhotoCapture(this.file);
  final File file;

  @override
  Future<File?> takePhoto() async => file;

  @override
  Future<File?> pickFromGallery() async => file;
}

class StubLocation implements LocationService {
  @override
  Future<LocationReading> current() async =>
      const LocationReading.failed(LocationOutcome.unavailable);
}

ExecutionController build(StubRepository repository) => ExecutionController(
  repository: repository,
  location: StubLocation(),
  // Caminho FICTÍCIO: o dublê nunca lê o arquivo, então ele não precisa
  // existir. É o que mantém o teste longe de I/O real.
  photos: StubPhotoCapture(File('/tmp/foto-ficticia.png')),
  orderId: 'os-1',
);

void main() {
  group('foto resiliente (§58)', () {
    test('falha no envio NÃO apaga a foto — ela fica para reenviar', () async {
      final repository = StubRepository()
        ..evidenceError = const FieldException(
          code: FieldErrorCode.upstreamUnavailable,
          message: 'Servidor indisponível.',
          retryable: true,
        );
      final controller = build(repository);
      await controller.load();

      await controller.addPhoto('ONU_ONT');

      final pending = controller.state.pendingPhotos;
      expect(pending, hasLength(1));
      expect(pending.single.status, SyncStatus.failed);
      expect(pending.single.category, 'ONU_ONT');
      expect(pending.single.error, 'Servidor indisponível.');
    });

    test('reenviar usa a MESMA chave — é a mesma intenção', () async {
      final repository = StubRepository()
        ..evidenceError = const FieldException(
          code: FieldErrorCode.upstreamUnavailable,
          message: 'Servidor indisponível.',
        );
      final controller = build(repository);
      await controller.load();
      await controller.addPhoto('CTO');

      await controller.retryPhoto(controller.state.pendingPhotos.single);

      expect(repository.evidenceCalls, 2);
      /*
        Chave nova a cada tentativa faria o servidor ver DUAS fotos diferentes,
        e a mesma imagem entraria duas vezes no relatório. A chave nasce com a
        intenção — quando o técnico tirou a foto —, não no envio.
      */
      expect(repository.evidenceKeys.first, repository.evidenceKeys.last);
    });

    test('envio bem-sucedido tira a foto da fila local', () async {
      final repository = StubRepository();
      final controller = build(repository);
      await controller.load();

      await controller.addPhoto('AFTER_SERVICE');

      expect(repository.evidenceCalls, 1);
      // Confirmada pelo servidor: ela existe no pacote, não mais na fila.
      expect(controller.state.pendingPhotos, isEmpty);
    });

    test('descartar remove só do aparelho', () async {
      final repository = StubRepository()
        ..evidenceError = const FieldException(
          code: FieldErrorCode.internal,
          message: 'falhou',
        );
      final controller = build(repository);
      await controller.load();
      await controller.addPhoto('OTHER');

      controller.discardPendingPhoto(controller.state.pendingPhotos.single);

      expect(controller.state.pendingPhotos, isEmpty);
      // Nenhuma chamada de remoção ao servidor: a foto nunca chegou lá.
      expect(repository.evidenceCalls, 1);
    });
  });

  group('carregamento', () {
    test('load e loadStock concorrentes não se atropelam', () async {
      /*
        Regressão de um defeito real: `state.copyWith(stock: await ...)` lê
        `state` ANTES do await, então o `loadStock` aplicava o resultado sobre
        um estado velho e apagava o pacote que o `load` tinha acabado de
        gravar. A tela ficava presa em "carregando" com os dados na mão.
      */
      final controller = build(StubRepository());

      await Future.wait([controller.load(), controller.loadStock()]);

      expect(controller.state.loading, isFalse);
      expect(controller.state.bundle, isNotNull);
      expect(controller.state.bundle!.version, 5);
    });
  });
}
