/// A posição que CONFIRMA ou MOVE o ponto do cliente — RC-1C-HOTFIX.
///
/// ## O defeito que esta captura fecha
///
/// Na validação física da RC-1C, no mesmo telefone, o Google Maps pôs o
/// aparelho no lugar certo e o AlfaOS gravou um ponto a mais de 1 km dali. A
/// causa, provada no aparelho e no banco:
///
/// 1. o aplicativo tinha só a permissão de localização APROXIMADA (Android 12+
///    oferece "precisa" ou "aproximada", e a escolha foi a segunda);
/// 2. o Android entrega posição aproximada deslocada numa grade de ~2 km e com
///    precisão de 2000 m — o número que ficou gravado;
/// 3. `Geolocator.getCurrentPosition` responde com a PRIMEIRA posição que o
///    sistema entregar (o plugin cancela as atualizações no primeiro retorno),
///    e ninguém olhava a precisão: nem o aplicativo, nem o servidor.
///
/// ## O contrato aprovado pelo dono (2026-09-15)
///
/// - precisão até 50 m, sobre o valor real — 50,1 m não serve;
/// - leitura recente: até 10 s, e nunca de antes de a captura começar;
/// - várias leituras até ~20 s, e a primeira ACEITÁVEL encerra — uma leitura
///   ruim nunca é usada, nem quando é a melhor que apareceu;
/// - sem posição aceitável, falha: nada é enviado, nada vira coordenada.
///
/// Uma captura só, usada por Confirmar E por Corrigir. O check-in e o ponto
/// continuam com `LocationService`: lá a coordenada é informação, nunca
/// bloqueia, e o contrato de precisão não os alcança.
///
/// ## O aparelho coleta; o servidor decide
///
/// O servidor aplica a mesma precisão (`requireGpsAccuracy`) — um APK antigo
/// ou hostil não passa por esta captura. Ele não recebe o instante da leitura:
/// a recência é garantida aqui.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';

import '../logging/log.dart';

/// O contrato, com os números do dono.
@immutable
class OperationalFixPolicy {
  const OperationalFixPolicy({
    this.maxAccuracyMeters = defaultMaxAccuracyMeters,
    this.maxAge = const Duration(seconds: 10),
    this.clockSkewTolerance = const Duration(seconds: 2),
    this.timeout = const Duration(seconds: 20),
  });

  /// O limite quando o servidor não mandou o dele (anterior à hotfix).
  ///
  /// É o número do contrato, e não "sem limite": ao contrário da distância —
  /// que é regra do servidor sobre o ponto —, a precisão é a própria condição
  /// de a leitura ser um GPS, e o dono a decidiu para o aplicativo também.
  static const double defaultMaxAccuracyMeters = 50;

  final double maxAccuracyMeters;

  /// Idade máxima da leitura no instante em que ela chega.
  final Duration maxAge;

  /// Quanto o relógio do aparelho pode discordar do instante da leitura.
  ///
  /// Dois segundos: cobre com folga a diferença de milissegundos entre o
  /// relógio do sistema e o do GNSS, e continua recusando uma posição
  /// guardada — que é velha em dezenas de segundos ou em minutos.
  final Duration clockSkewTolerance;

  /// Quanto esperar por uma leitura aceitável antes de desistir.
  final Duration timeout;
}

/// Uma leitura crua, como a plataforma a entregou — sem juízo nenhum.
@immutable
class RawPositionReading {
  const RawPositionReading({
    required this.latitude,
    required this.longitude,
    required this.timestamp,
    this.accuracyMeters,
  });

  final double latitude;
  final double longitude;

  /// `null` quando a plataforma não mediu.
  final double? accuracyMeters;

  /// O instante da leitura, no relógio de parede.
  final DateTime timestamp;
}

/// A posição que pode ir para o servidor: dentro do contrato, e só ela.
@immutable
class OperationalFix {
  const OperationalFix({
    required this.latitude,
    required this.longitude,
    required this.accuracyMeters,
    required this.capturedAt,
  });

  final double latitude;
  final double longitude;

  /// O valor REAL, sem arredondar: é ele que viaja e que o servidor julga.
  final double accuracyMeters;

  final DateTime capturedAt;
}

/// O juízo sobre UMA leitura.
enum ReadingVerdict {
  accepted,

  /// Fora do planeta, `NaN`, infinita ou a ilha nula.
  invalidCoordinate,

  /// Velha, anterior à captura, ou de um relógio que discorda demais.
  stale,

  /// A plataforma não mediu a precisão.
  noAccuracy,

  /// Precisão zero, negativa ou infinita — não é medida.
  invalidAccuracy,

  /// Leitura boa, precisão acima do limite.
  inaccurate,
}

/// A mesma definição de coordenada utilizável do servidor (`coordenadaValida`).
bool isUsableCoordinate(double latitude, double longitude) {
  if (!latitude.isFinite || !longitude.isFinite) return false;
  if (latitude.abs() > 90 || longitude.abs() > 180) return false;
  return !(latitude == 0 && longitude == 0);
}

/// Julga uma leitura contra o contrato.
///
/// A ordem importa só para dizer POR QUE uma leitura foi descartada: qualquer
/// veredito diferente de `accepted` é o mesmo desfecho — ela não é usada.
ReadingVerdict evaluateReading(
  RawPositionReading reading, {
  required DateTime now,
  required DateTime startedAt,
  required OperationalFixPolicy policy,
}) {
  if (!isUsableCoordinate(reading.latitude, reading.longitude)) {
    return ReadingVerdict.invalidCoordinate;
  }

  final instante = reading.timestamp;
  // De antes de a captura começar é posição que o sistema tinha guardada —
  // exatamente o que o contrato proíbe.
  if (instante.isBefore(startedAt.subtract(policy.clockSkewTolerance))) {
    return ReadingVerdict.stale;
  }
  final idade = now.difference(instante);
  if (idade > policy.maxAge) return ReadingVerdict.stale;
  // Do futuro além da tolerância: relógio e leitura discordam, e não há como
  // afirmar que ela é recente. Recusar custa uma espera; aceitar poderia
  // usar uma posição velha num aparelho com o relógio atrasado.
  if (idade < -policy.clockSkewTolerance) return ReadingVerdict.stale;

  final precisao = reading.accuracyMeters;
  if (precisao == null) return ReadingVerdict.noAccuracy;
  if (!precisao.isFinite || precisao <= 0)
    return ReadingVerdict.invalidAccuracy;
  if (precisao > policy.maxAccuracyMeters) return ReadingVerdict.inaccurate;
  return ReadingVerdict.accepted;
}

/// Por que a captura não entregou posição.
enum OperationalFixFailure {
  serviceDisabled,
  permissionDenied,
  permissionDeniedForever,

  /// O sistema só concedeu localização APROXIMADA — o defeito que abriu a
  /// hotfix. Com ela, nenhuma leitura chega perto de 50 m.
  approximateOnly,

  /// Nenhuma leitura aceitável dentro do tempo.
  timeout,

  /// O plugin falhou de um jeito que não é nenhum dos acima.
  unavailable,

  /// O técnico cancelou. Não é erro: nada é mostrado e nada é enviado.
  cancelled,
}

/// O desfecho de uma captura.
sealed class OperationalFixResult {
  const OperationalFixResult();
}

final class OperationalFixAcquired extends OperationalFixResult {
  const OperationalFixAcquired(this.fix);

  final OperationalFix fix;
}

final class OperationalFixFailed extends OperationalFixResult {
  const OperationalFixFailed(
    this.reason, {
    required this.maxAccuracyMeters,
    this.bestAccuracyMeters,
  });

  final OperationalFixFailure reason;
  final double maxAccuracyMeters;

  /// A melhor precisão RECENTE que apareceu — informação para a mensagem,
  /// nunca uma posição a usar.
  final double? bestAccuracyMeters;

  String get title => switch (reason) {
    OperationalFixFailure.timeout when bestAccuracyMeters != null =>
      'Precisão do GPS insuficiente',
    OperationalFixFailure.timeout => 'Localização não obtida',
    OperationalFixFailure.approximateOnly => 'Localização precisa desativada',
    OperationalFixFailure.serviceDisabled => 'GPS desligado',
    OperationalFixFailure.permissionDenied ||
    OperationalFixFailure.permissionDeniedForever => 'Permissão de localização',
    OperationalFixFailure.unavailable ||
    OperationalFixFailure.cancelled => 'Localização não obtida',
  };

  /// A frase para o técnico, com a saída de cada recusa. `null` no
  /// cancelamento, que não pede explicação.
  String? get message {
    final limite = formatAccuracyMeters(maxAccuracyMeters);
    final melhor = bestAccuracyMeters;
    return switch (reason) {
      OperationalFixFailure.cancelled => null,
      OperationalFixFailure.timeout when melhor != null =>
        'Precisão do GPS insuficiente: ${formatAccuracyMeters(melhor)}. '
            'Precisão necessária: até $limite. '
            'Aguarde alguns segundos em um local mais aberto e tente novamente.',
      OperationalFixFailure.timeout =>
        'Não foi possível obter uma localização com precisão suficiente. '
            'Precisão necessária: até $limite. '
            'Vá para um local mais aberto, aguarde alguns segundos e tente '
            'novamente.',
      OperationalFixFailure.approximateOnly =>
        'Ative Localização precisa para usar esta função. Nas configurações '
            'do aparelho, abra as permissões de localização do AlfaOS Field e '
            'ligue "Usar localização precisa".',
      OperationalFixFailure.serviceDisabled =>
        'O GPS do aparelho está desligado. Ligue a localização e tente '
            'novamente.',
      OperationalFixFailure.permissionDenied =>
        'A permissão de localização não foi concedida. Permita o acesso à '
            'localização para continuar.',
      OperationalFixFailure.permissionDeniedForever =>
        'A permissão de localização está bloqueada. Libere nas configurações '
            'do aparelho.',
      OperationalFixFailure.unavailable =>
        'Não foi possível obter a localização agora. Tente novamente.',
    };
  }
}

/// A precisão como uma pessoa lê — igual ao servidor
/// (`formatAccuracyMeters`, em `customer-location-presentation.ts`).
///
/// Arredondada PARA CIMA: abaixo de 100 m ao décimo ("50,1 m"), a partir dele
/// ao metro. Para cima porque "50 m" escrito numa recusa de 50,04 m faria a
/// regra parecer errada. O `1e-9` absorve o ruído de ponto flutuante.
String formatAccuracyMeters(double meters) {
  if (meters >= 100) return '${(meters - 1e-9).ceil()} m';
  final decimo = (meters * 10 - 1e-9).ceil() / 10;
  if (decimo == decimo.roundToDouble()) return '${decimo.round()} m';
  return '${decimo.toStringAsFixed(1).replaceAll('.', ',')} m';
}

/// Permissão como a captura precisa dela.
enum PositionPermission { granted, denied, deniedForever }

/// Uma falha tipada do plugin, levada pelo fluxo de leituras.
class PositionSourceException implements Exception {
  const PositionSourceException(this.reason);

  final OperationalFixFailure reason;

  @override
  String toString() => 'PositionSourceException(${reason.name})';
}

/// A fronteira com o plugin de GPS — o que um teste substitui.
abstract class PositionSource {
  Future<bool> isServiceEnabled();

  Future<PositionPermission> checkPermission();

  /// Pede a permissão. No Android 12+, com a APROXIMADA já concedida, é este
  /// mesmo pedido que mostra o diálogo de "usar localização precisa".
  Future<PositionPermission> requestPermission();

  /// `false` quando o sistema só concedeu localização aproximada.
  ///
  /// `true` também quando não dá para saber: aí quem decide é a precisão de
  /// cada leitura, que recusa a aproximada de qualquer forma.
  Future<bool> isPrecise();

  /// Um fluxo NOVO de leituras, a cada chamada — nunca a última conhecida.
  Stream<RawPositionReading> positions();
}

/// A captura. Uma instância serve para qualquer número de tentativas: cada
/// `acquire` abre um fluxo novo e o fecha ao terminar.
class OperationalPositionAcquirer {
  OperationalPositionAcquirer(this._source, {DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;

  final PositionSource _source;
  final DateTime Function() _clock;

  /// Procura uma posição dentro de [policy].
  ///
  /// [onReading] recebe a precisão de cada leitura RECENTE, aceitável ou
  /// não — é o "Precisão atual" da tela. [cancel], quando completa, encerra a
  /// captura como `cancelled`.
  ///
  /// Nunca devolve uma leitura fora do contrato: no tempo esgotado, a melhor
  /// precisão vista vai na FALHA, para a mensagem, e a posição fica para trás.
  Future<OperationalFixResult> acquire({
    OperationalFixPolicy policy = const OperationalFixPolicy(),
    void Function(double accuracyMeters)? onReading,
    Future<void>? cancel,
  }) async {
    OperationalFixFailed falha(
      OperationalFixFailure reason, [
      double? melhor,
    ]) => OperationalFixFailed(
      reason,
      maxAccuracyMeters: policy.maxAccuracyMeters,
      bestAccuracyMeters: melhor,
    );

    var cancelado = false;
    final pedidoDeCancelamento = Completer<void>();
    unawaited(
      cancel?.then((_) {
        cancelado = true;
        if (!pedidoDeCancelamento.isCompleted) pedidoDeCancelamento.complete();
      }),
    );

    final OperationalFixFailure? recusa;
    try {
      recusa = await _prontoParaMedir();
    } catch (error) {
      Log.error('gps_acquisition_failed stage=permission', error: error);
      return falha(OperationalFixFailure.unavailable);
    }
    if (recusa != null) {
      Log.debug('gps_acquisition_failed', data: {'reason': recusa.name});
      return falha(recusa);
    }
    if (cancelado) return falha(OperationalFixFailure.cancelled);

    final inicio = _clock();
    final desfecho = Completer<OperationalFixResult>();
    double? melhor;
    StreamSubscription<RawPositionReading>? assinatura;
    Timer? prazo;

    void encerrar(OperationalFixResult resultado) {
      if (desfecho.isCompleted) return;
      prazo?.cancel();
      // Fechar o fluxo é desligar o GPS: nada continua medindo depois da
      // resposta — nem em segundo plano, nem para "melhorar" a leitura.
      unawaited(assinatura?.cancel());
      desfecho.complete(resultado);
    }

    prazo = Timer(
      policy.timeout,
      () => encerrar(falha(OperationalFixFailure.timeout, melhor)),
    );
    unawaited(
      pedidoDeCancelamento.future.then(
        (_) => encerrar(falha(OperationalFixFailure.cancelled, melhor)),
      ),
    );

    assinatura = _source.positions().listen(
      (leitura) {
        if (desfecho.isCompleted) return;
        final veredito = evaluateReading(
          leitura,
          now: _clock(),
          startedAt: inicio,
          policy: policy,
        );
        if (veredito == ReadingVerdict.accepted ||
            veredito == ReadingVerdict.inaccurate) {
          final precisao = leitura.accuracyMeters!;
          melhor = melhor == null ? precisao : math.min(melhor!, precisao);
          onReading?.call(precisao);
        }
        if (veredito == ReadingVerdict.accepted) {
          encerrar(
            OperationalFixAcquired(
              OperationalFix(
                latitude: leitura.latitude,
                longitude: leitura.longitude,
                accuracyMeters: leitura.accuracyMeters!,
                capturedAt: leitura.timestamp,
              ),
            ),
          );
        }
      },
      onError: (Object error) {
        final motivo = error is PositionSourceException
            ? error.reason
            : OperationalFixFailure.unavailable;
        encerrar(falha(motivo, melhor));
      },
      onDone: () => encerrar(falha(OperationalFixFailure.unavailable, melhor)),
      cancelOnError: true,
    );
    // Uma fonte que responda de forma síncrona pode ter encerrado antes de a
    // assinatura existir.
    if (desfecho.isCompleted) unawaited(assinatura.cancel());

    final resultado = await desfecho.future;
    if (resultado case OperationalFixFailed(:final reason)) {
      // Sem coordenada no log: o motivo e a melhor precisão bastam para
      // diagnosticar, e a posição do técnico não tem lugar num log.
      Log.debug(
        reason == OperationalFixFailure.timeout
            ? (melhor != null ? 'accuracy_out_of_policy' : 'location_timeout')
            : 'gps_acquisition_failed',
        data: {'reason': reason.name, 'bestAccuracyMeters': melhor},
      );
    }
    return resultado;
  }

  /// Serviço, permissão e precisão — nesta ordem, cada um com a sua saída.
  Future<OperationalFixFailure?> _prontoParaMedir() async {
    if (!await _source.isServiceEnabled()) {
      return OperationalFixFailure.serviceDisabled;
    }
    var permissao = await _source.checkPermission();
    if (permissao == PositionPermission.denied) {
      permissao = await _source.requestPermission();
    }
    if (permissao == PositionPermission.deniedForever) {
      return OperationalFixFailure.permissionDeniedForever;
    }
    if (permissao == PositionPermission.denied) {
      return OperationalFixFailure.permissionDenied;
    }
    if (!await _source.isPrecise()) {
      // Pedir de novo, com a aproximada concedida, é o que faz o Android 12+
      // oferecer a localização precisa — no momento em que o técnico tocou
      // numa ação que precisa dela, e não na abertura do aplicativo.
      await _source.requestPermission();
      if (!await _source.isPrecise()) {
        return OperationalFixFailure.approximateOnly;
      }
    }
    return null;
  }
}

/// O plugin `geolocator`, atrás da fronteira.
///
/// ## A precisão pedida
///
/// `LocationAccuracy.best`, conferido na versão instalada (`geolocator_android`
/// 4.6.2): no Android, `high`, `best` e `bestForNavigation` viram TODOS
/// `PRIORITY_HIGH_ACCURACY` no provedor fundido (`FusedLocationClient.toPriority`)
/// — a maior prioridade que ele tem. Trocar o enum não mudaria nada no Android;
/// o que a hotfix muda é aceitar só a leitura que o contrato aceita. No iOS,
/// `best` é `kCLLocationAccuracyBest`.
///
/// Intervalo de 1 s (o padrão do plugin é 5 s): em 20 s de espera, a leitura
/// tem ~20 chances de melhorar em vez de 4.
class GeolocatorPositionSource implements PositionSource {
  const GeolocatorPositionSource();

  @override
  Future<bool> isServiceEnabled() => Geolocator.isLocationServiceEnabled();

  @override
  Future<PositionPermission> checkPermission() async =>
      _permissao(await Geolocator.checkPermission());

  @override
  Future<PositionPermission> requestPermission() async =>
      _permissao(await Geolocator.requestPermission());

  @override
  Future<bool> isPrecise() async {
    try {
      return await Geolocator.getLocationAccuracy() !=
          LocationAccuracyStatus.reduced;
    } catch (error) {
      Log.error('falha ao ler a precisão da permissão', error: error);
      return true;
    }
  }

  @override
  Stream<RawPositionReading> positions() {
    final settings = defaultTargetPlatform == TargetPlatform.android
        ? AndroidSettings(
            accuracy: LocationAccuracy.best,
            distanceFilter: 0,
            intervalDuration: const Duration(seconds: 1),
          )
        : const LocationSettings(
            accuracy: LocationAccuracy.best,
            distanceFilter: 0,
          );
    return Geolocator.getPositionStream(locationSettings: settings)
        .map(
          (p) => RawPositionReading(
            latitude: p.latitude,
            longitude: p.longitude,
            // `accuracy` vale 0 quando a plataforma não mediu; `hasAccuracy`
            // é quem diz se houve medida.
            accuracyMeters: p.hasAccuracy ? p.accuracy : null,
            timestamp: p.timestamp,
          ),
        )
        .handleError(
          (Object error) => throw PositionSourceException(switch (error) {
            LocationServiceDisabledException() =>
              OperationalFixFailure.serviceDisabled,
            PermissionDeniedException() =>
              OperationalFixFailure.permissionDenied,
            _ => OperationalFixFailure.unavailable,
          }),
        );
  }

  static PositionPermission _permissao(LocationPermission permission) =>
      switch (permission) {
        LocationPermission.whileInUse ||
        LocationPermission.always => PositionPermission.granted,
        LocationPermission.deniedForever => PositionPermission.deniedForever,
        LocationPermission.denied ||
        LocationPermission.unableToDetermine => PositionPermission.denied,
      };
}
