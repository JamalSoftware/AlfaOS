import 'dart:io';

import 'package:alfaos_field/core/errors/field_error.dart';
import 'package:alfaos_field/core/location/location_service.dart';
import 'package:alfaos_field/core/location/operational_position.dart';
import 'package:alfaos_field/core/media/photo_capture.dart';
import 'package:alfaos_field/core/sync/pending_operation.dart';
import 'package:alfaos_field/features/execution/data/execution_repository.dart';
import 'package:alfaos_field/features/execution/domain/execution.dart';
import 'package:alfaos_field/features/execution/state/execution_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_geolocator_platform.dart';
import 'support/fake_position_source.dart';
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
  int loads = 0;
  final List<String> evidenceKeys = [];
  final List<Map<String, Object?>> confirmacoes = [];
  final List<Map<String, Object?>> correcoes = [];

  @override
  Future<void> confirmLocation({
    required String orderId,
    required int expectedVersion,
    required String idempotencyKey,
    double? observedLatitude,
    double? observedLongitude,
    double? observedAccuracyMeters,
  }) async {
    confirmacoes.add({
      'expectedVersion': expectedVersion,
      'observedLatitude': observedLatitude,
      'observedLongitude': observedLongitude,
      'observedAccuracyMeters': observedAccuracyMeters,
    });
  }

  @override
  Future<void> correctLocation({
    required String orderId,
    required int? expectedVersion,
    required String reason,
    required String idempotencyKey,
    String? note,
    double? latitude,
    double? longitude,
    double? accuracyMeters,
    String? source,
    Map<String, String?>? address,
  }) async {
    correcoes.add({
      'expectedVersion': expectedVersion,
      'latitude': latitude,
      'longitude': longitude,
      'accuracyMeters': accuracyMeters,
      'source': source,
      'address': address,
    });
  }

  @override
  Future<ExecutionBundle> load(String orderId) async {
    loads += 1;
    return (bundleBuilder ?? _defaultBundle)();
  }

  @override
  Future<List<StockLine>> stock() async => const [];

  @override
  Future<String?> addEvidence({
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
    // Id da evidência criada: o registro de equipamento aponta para ele.
    return 'evidencia-$evidenceCalls';
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

ExecutionBundle _bundleComPonto(
  int versaoDoPonto, {
  String status = 'UNCONFIRMED',
  int? limitePrecisao = 50,
}) => ExecutionBundle.fromJson({
  'orderId': 'os-1',
  'version': 5,
  'executionVersion': 2,
  'report': {'diagnosis': null, 'workPerformed': null, 'notes': null},
  'location': {
    'status': status,
    'latitude': status == 'MISSING' ? null : -20.3155,
    'longitude': status == 'MISSING' ? null : -40.3128,
    'verified': status == 'CONFIRMED',
    'version': status == 'MISSING' ? null : versaoDoPonto,
    'confirmMaxDistanceMeters': 100,
    'gpsMaxAccuracyMeters': ?limitePrecisao,
  },
  'requirements': const <String, dynamic>{},
  'pendencies': const <Map<String, dynamic>>[],
});

/// A posição que a captura entregaria: perto do ponto, 8 m de precisão.
const _perto = ScriptedReading(-20.3154, -40.3128, accuracy: 8);

ExecutionController build(
  StubRepository repository, {
  PositionSource? positions,
}) => ExecutionController(
  repository: repository,
  location: StubLocation(),
  positions: positions ?? FakePositionSource(),
  // Caminho FICTÍCIO: o dublê nunca lê o arquivo, então ele não precisa
  // existir. É o que mantém o teste longe de I/O real.
  photos: StubPhotoCapture(File('/tmp/foto-ficticia.png')),
  orderId: 'os-1',
);

Future<OperationalFix> capturar(ExecutionController controller) async {
  final r = await controller.acquireFix();
  if (r case OperationalFixAcquired(:final fix)) return fix;
  fail('a captura devia ter entregado posição: $r');
}

OperationalFix _posicao({double precisao = 8}) => OperationalFix(
  latitude: -20.3154,
  longitude: -40.3128,
  accuracyMeters: precisao,
  capturedAt: DateTime.now(),
);

void main() {
  group(
    'RC-1C-HOTFIX-3 — a precisão que o Android mediu chega ao servidor',
    () {
      test('17,5 m pelo plugin do Android: Confirmar envia 17,5 e Corrigir envia 17,5', () async {
        /*
          A validação física: o Android media, e a captura recusava toda leitura
          como "sem precisão" — `geolocator_android` 4.6.2 perde a bandeira
          `hasAccuracy` ao reconstruir a leitura. Aqui a posição entra pela
          MESMA conversão do plugin (a `GeolocatorPositionSource` real sobre o
          canal nativo) e é seguida até o corpo das duas requisições: nenhum
          mapeamento do AlfaOS pode perder nem arredondar o número.
        */
        final plugin = installFakeAndroidGeolocator()
          ..script = [
            nativeAndroidLocation(
              latitude: -20.3154,
              longitude: -40.3128,
              timestamp: DateTime.now().subtract(const Duration(seconds: 5)),
              accuracy: 17.5,
            ),
          ];
        final repository = StubRepository()
          ..bundleBuilder = () => _bundleComPonto(3);
        final controller = build(
          repository,
          positions: const GeolocatorPositionSource(),
        );
        await controller.load();

        final paraConfirmar = await capturar(controller);
        expect(paraConfirmar.accuracyMeters, 17.5);
        final medida = controller.measureForConfirm(paraConfirmar)!;
        expect(medida.withinLimit, isTrue);
        expect(await controller.confirmLocation(medida), isTrue);
        expect(repository.confirmacoes.single['observedAccuracyMeters'], 17.5);

        final paraCorrigir = await capturar(controller);
        expect(
          await controller.correctLocation(
            reason: 'INCORRECT_LOCATION',
            useGps: true,
            fix: paraCorrigir,
          ),
          isTrue,
        );
        final correcao = repository.correcoes.single;
        expect(correcao['accuracyMeters'], 17.5);
        expect(correcao['latitude'], -20.3154);
        expect(correcao['longitude'], -40.3128);
        expect(correcao['source'], 'TECHNICIAN_GPS');
        expect(plugin.streamOpens, 2, reason: 'uma captura por ação');
        expect(plugin.listening, isFalse);
      });
    },
  );

  group('confirmar localização (RC-1C + RC-1C-HOTFIX)', () {
    test('confirma o ponto que foi MEDIDO: a versão e a posição enviadas são as da medida', () async {
      /*
          Entre medir e confirmar o pacote pode ser relido — e o ponto pode ter
          mudado nesse meio-tempo. A confirmação leva a versão contra a qual a
          distância foi mostrada: se o ponto andou, o servidor responde conflito
          em vez de confirmar um ponto que o técnico não viu medido.
        */
      final repository = StubRepository()
        ..bundleBuilder = () => _bundleComPonto(3);
      final controller = build(
        repository,
        positions: FakePositionSource(script: const [_perto]),
      );
      await controller.load();

      final fix = await capturar(controller);
      final medida = controller.measureForConfirm(fix);
      expect(medida, isNotNull);
      expect(medida!.withinLimit, isTrue);

      // O pacote é relido com o ponto em outra versão.
      repository.bundleBuilder = () => _bundleComPonto(7);
      await controller.load();

      await controller.confirmLocation(medida);
      expect(repository.confirmacoes, hasLength(1));
      final enviada = repository.confirmacoes.single;
      expect(enviada['expectedVersion'], 3);
      expect(enviada['observedLatitude'], -20.3154);
      expect(enviada['observedLongitude'], -40.3128);
      // O valor REAL da precisão, que o servidor julga sem arredondar.
      expect(enviada['observedAccuracyMeters'], 8.0);
    });

    test(
      'posição fora do contrato NÃO é enviada — nem montada à mão (1200 m)',
      () async {
        final repository = StubRepository()
          ..bundleBuilder = () => _bundleComPonto(3);
        final controller = build(repository);
        await controller.load();

        final medida = controller.measureForConfirm(_posicao(precisao: 1200));
        expect(await controller.confirmLocation(medida!), isFalse);
        expect(repository.confirmacoes, isEmpty);
        expect(controller.state.error, contains('precisão necessária'));
      },
    );

    test('o limite de precisão é o do pacote; sem ele, o do contrato', () async {
      final repository = StubRepository()
        ..bundleBuilder = () => _bundleComPonto(3, limitePrecisao: 30);
      final controller = build(repository);
      await controller.load();
      expect(controller.fixPolicy.maxAccuracyMeters, 30);

      repository.bundleBuilder = () => _bundleComPonto(3, limitePrecisao: null);
      await controller.load();
      expect(controller.fixPolicy.maxAccuracyMeters, 50);

      // E o limite do pacote vale na hora de enviar: 35 m passa pelo contrato,
      // não pelo servidor que mandou 30.
      repository.bundleBuilder = () => _bundleComPonto(3, limitePrecisao: 30);
      await controller.load();
      final medida = controller.measureForConfirm(_posicao(precisao: 35));
      expect(await controller.confirmLocation(medida!), isFalse);
    });
  });

  group('corrigir localização (RC-1C-HOTFIX)', () {
    test('com GPS: envia a posição CAPTURADA e RECARREGA o pacote — a seção sai de "Sem localização"', () async {
      /*
          A pergunta da validação física: depois de corrigir, a tela ainda
          dizia "Sem localização". O servidor criou o ponto; a tela precisa
          mostrar o que o SERVIDOR diz agora, e não o pacote de antes.
        */
      final repository = StubRepository()
        ..bundleBuilder = () => _bundleComPonto(0, status: 'MISSING');
      final controller = build(
        repository,
        positions: FakePositionSource(script: const [_perto]),
      );
      await controller.load();
      expect(controller.state.bundle!.location.status, LocationStatus.missing);
      final cargas = repository.loads;

      final fix = await capturar(controller);
      repository.bundleBuilder = () => _bundleComPonto(1, status: 'CONFIRMED');
      final ok = await controller.correctLocation(
        reason: 'INCORRECT_LOCATION',
        useGps: true,
        fix: fix,
      );

      expect(ok, isTrue);
      final enviada = repository.correcoes.single;
      expect(enviada['latitude'], fix.latitude);
      expect(enviada['longitude'], fix.longitude);
      expect(enviada['accuracyMeters'], fix.accuracyMeters);
      expect(enviada['source'], 'TECHNICIAN_GPS');
      // Criação: o cliente não tinha ponto.
      expect(enviada['expectedVersion'], isNull);

      expect(repository.loads, cargas + 1, reason: 'recarregou do servidor');
      expect(
        controller.state.bundle!.location.status,
        LocationStatus.confirmed,
      );
      expect(
        controller.state.message,
        'Localização corrigida. Precisão do GPS: 8 m.',
      );
    });

    test(
      'GPS escolhido e SEM posição: recusa — não vira correção só de endereço',
      () async {
        final repository = StubRepository()
          ..bundleBuilder = () => _bundleComPonto(2);
        final controller = build(repository);
        await controller.load();

        final ok = await controller.correctLocation(
          reason: 'INCORRECT_LOCATION',
          useGps: true,
          address: const {'address': 'Rua Que Não Pode Entrar Sozinha'},
        );

        expect(ok, isFalse);
        expect(repository.correcoes, isEmpty);
        expect(
          controller.state.error,
          contains('Usar minha localização atual'),
        );
      },
    );

    test('GPS escolhido com posição imprecisa (1200 m): recusa', () async {
      final repository = StubRepository()
        ..bundleBuilder = () => _bundleComPonto(2);
      final controller = build(repository);
      await controller.load();

      expect(
        await controller.correctLocation(
          reason: 'INCORRECT_LOCATION',
          useGps: true,
          fix: _posicao(precisao: 1200),
        ),
        isFalse,
      );
      expect(repository.correcoes, isEmpty);
    });

    test(
      'GPS desligado: só endereço, sem coordenada, sem precisão e sem GPS',
      () async {
        final gps = FakePositionSource(script: const [_perto]);
        final repository = StubRepository()
          ..bundleBuilder = () => _bundleComPonto(2);
        final controller = build(repository, positions: gps);
        await controller.load();

        final ok = await controller.correctLocation(
          reason: 'INCORRECT_ADDRESS',
          useGps: false,
          // Uma posição que sobrou não entra numa correção de endereço.
          fix: _posicao(),
          address: const {'number': '77'},
        );

        expect(ok, isTrue);
        final enviada = repository.correcoes.single;
        expect(enviada['latitude'], isNull);
        expect(enviada['accuracyMeters'], isNull);
        expect(enviada['source'], isNull);
        expect(enviada['address'], {'number': '77'});
        expect(gps.watchCalls, 0);
        expect(controller.state.message, 'Cadastro corrigido.');
      },
    );
  });

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
