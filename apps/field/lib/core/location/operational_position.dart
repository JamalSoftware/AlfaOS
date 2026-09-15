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
/// - leitura recente: até 10 s de IDADE, medida pelo instante da própria
///   leitura — ela pode ter nascido segundos antes de a captura abrir
///   (RC-1C-HOTFIX-2, abaixo);
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
///
/// ## RC-1C-HOTFIX-2 — frescor é IDADE, não "nascer depois da abertura"
///
/// A primeira versão recusava toda leitura nascida mais de 2 s antes de a
/// captura abrir. A validação física mostrou o preço: com o aparelho PARADO, o
/// provedor fundido do Google entra em modo estacionário (`device stationary`,
/// `engine stationary throttled` no `dumpsys`), entrega pouquíssimas leituras —
/// 13 em seis capturas de 20 s — e pode entregar a que já tinha, nascida
/// segundos antes da assinatura. Recusada essa, nenhuma nova chegava, e toda
/// captura esgotava o prazo em "Localização não obtida", com o sistema tendo
/// posições de 11 a 27 m. A regra do dono é a idade: até 10 s, venha a leitura
/// de onde vier NO FLUXO. A última posição conhecida (`getLastKnownPosition`)
/// continua proibida — ela não é leitura do fluxo, e a idade dela é qualquer.
///
/// ## RC-1C-HOTFIX-3 — a precisão que o plugin do Android esconde
///
/// A validação física seguinte chegou com `verdict=noAccuracy` e
/// `accuracyMeters=-` em toda leitura, com ~5 s de idade — dentro do frescor —
/// e o sistema medindo de 7 a 27 m. A causa está no plugin instalado, não no
/// aparelho: `geolocator_platform_interface` 4.3.0 criou `Position.hasAccuracy`
/// (padrão `false`) e o calcula certo em `Position.fromMap`, mas o
/// `geolocator_android` 4.6.2 reconstrói cada leitura em
/// `AndroidPosition.fromMap` por um construtor que não conhece o campo. No
/// Android, TODA leitura chega com `hasAccuracy == false` — e com o número
/// medido intacto em `accuracy`. A captura confiava na bandeira e recusava
/// todas; `measuredAccuracyMeters` decide agora pelo que o plugin garante.
///
/// Nenhum teste viu isso porque todos entregavam leituras ABAIXO da fronteira
/// `PositionSource`, pulando a conversão do plugin. Desde esta hotfix, a
/// `GeolocatorPositionSource` é testada através da própria conversão do
/// Android (`test/operational_position_platform_test.dart`).
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

  /// Idade máxima da leitura no instante em que ela chega — a ÚNICA regra de
  /// frescor. Não importa se ela nasceu antes ou depois de a captura abrir.
  final Duration maxAge;

  /// Quanto uma leitura pode estar no FUTURO do relógio do aparelho.
  ///
  /// Dois segundos: cobre com folga a diferença entre o relógio do sistema e o
  /// do GNSS (medida no aparelho da validação: ~0,3 s). Além disso, relógio e
  /// leitura discordam demais para a idade significar alguma coisa.
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
    this.platform,
  });

  final double latitude;
  final double longitude;

  /// `null` quando a plataforma não mediu.
  final double? accuracyMeters;

  /// O instante da leitura, no relógio de parede.
  final DateTime timestamp;

  /// O que a plataforma disse, antes de qualquer decisão — só para o
  /// diagnóstico (RC-1C-HOTFIX-3). `null` quando a leitura não veio do plugin.
  final PlatformPositionFacts? platform;
}

/// O que o plugin entregou numa `Position`, cru — RC-1C-HOTFIX-3.
///
/// É o que prova, no aparelho, de onde veio o `noAccuracy`: o tipo da leitura,
/// a bandeira `hasAccuracy` e o número de `accuracy` ANTES de a captura
/// decidir se ele é medida. **Sem coordenada, de propósito** — um teste
/// estrutural garante que esta classe não a carrega.
@immutable
class PlatformPositionFacts {
  const PlatformPositionFacts({
    required this.type,
    required this.hasAccuracy,
    required this.rawAccuracy,
    required this.timestamp,
  });

  /// `AndroidPosition` no Android.
  final String type;
  final bool hasAccuracy;
  final double rawAccuracy;
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

  /// Mais velha que o limite, ou no futuro além da tolerância.
  stale,

  /// A plataforma não mediu a precisão.
  noAccuracy,

  /// Precisão zero, negativa ou infinita — não é medida.
  invalidAccuracy,

  /// Leitura boa, precisão acima do limite.
  inaccurate,
}

/// O que a captura sabe de UMA leitura, para diagnóstico — RC-1C-HOTFIX-2.
///
/// É o que prova, no aparelho, por que uma leitura foi aceita ou recusada: a
/// idade, quanto antes de a captura abrir ela nasceu, e a precisão. **Sem
/// coordenada, de propósito** — a posição do técnico não tem lugar num log, e
/// um teste estrutural garante que esta classe não a carrega.
@immutable
class ReadingDiagnostic {
  const ReadingDiagnostic({
    required this.sequence,
    required this.verdict,
    required this.age,
    required this.bornBeforeCapture,
    required this.accuracyMeters,
    this.platform,
  });

  /// De onde as leituras vêm: o fluxo do provedor da plataforma, e só ele.
  ///
  /// Não existe fonte alternativa (RC-1C-HOTFIX-3): o `noAccuracy` da validação
  /// física era a bandeira perdida no plugin, não uma leitura sem medida, e
  /// corrigida a leitura do número o fluxo principal basta. O campo existe
  /// para o log dizer isso sem ninguém precisar deduzir.
  static const sourceMode = 'primary';

  /// 1 para a primeira leitura desta captura.
  final int sequence;
  final ReadingVerdict verdict;

  /// Idade quando chegou; negativa quando está no futuro do relógio.
  final Duration age;

  /// Quanto antes da abertura da captura ela nasceu; negativa quando depois.
  final Duration bornBeforeCapture;

  /// A precisão que a captura considerou MEDIDA — `null` quando não houve.
  final double? accuracyMeters;

  /// O que o plugin disse, cru. `null` quando a leitura não veio dele.
  final PlatformPositionFacts? platform;

  /// A linha do log: `gps_reading n=1 verdict=accepted ageMs=4000 …`.
  String get line =>
      'gps_reading n=$sequence verdict=${verdict.name} '
      'ageMs=${age.inMilliseconds} '
      'bornBeforeCaptureMs=${bornBeforeCapture.inMilliseconds} '
      'accuracyMeters=${accuracyMeters?.toStringAsFixed(1) ?? '-'}';

  /// A linha crua, ANTES do juízo: `raw_position n=1 sourceMode=primary
  /// type=AndroidPosition hasAccuracy=false rawAccuracy=18.0 …` — RC-1C-HOTFIX-3.
  ///
  /// `null` quando a leitura não veio do plugin.
  String? get rawLine {
    final cru = platform;
    if (cru == null) return null;
    return 'raw_position n=$sequence sourceMode=$sourceMode '
        'type=${cru.type} hasAccuracy=${cru.hasAccuracy} '
        'rawAccuracy=${cru.rawAccuracy} '
        'rawFinite=${cru.rawAccuracy.isFinite} '
        'rawPositive=${cru.rawAccuracy > 0} '
        'ageMs=${age.inMilliseconds} '
        'timestampMs=${cru.timestamp.millisecondsSinceEpoch}';
  }
}

/// O diagnóstico vai ao log da aplicação e, SÓ num build de depuração, ao
/// `logcat` — é por ele que a validação física lê o que aconteceu. `Log`
/// escreve no canal de depuração do Dart, que o `adb logcat` não mostra.
void _diagnostico(String linha) {
  Log.debug(linha);
  if (kDebugMode) debugPrint('alfaos.gps $linha');
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
///
/// O instante em que a captura abriu NÃO entra no juízo (RC-1C-HOTFIX-2): uma
/// leitura de 4 s de idade é recente, tenha ela nascido antes ou depois da
/// assinatura. Exigir o "depois" recusava a posição que o provedor fundido
/// entrega com o aparelho parado — e com ele parado nenhuma outra vinha.
ReadingVerdict evaluateReading(
  RawPositionReading reading, {
  required DateTime now,
  required OperationalFixPolicy policy,
}) {
  if (!isUsableCoordinate(reading.latitude, reading.longitude)) {
    return ReadingVerdict.invalidCoordinate;
  }

  final idade = now.difference(reading.timestamp);
  if (idade > policy.maxAge) return ReadingVerdict.stale;
  // Do futuro além da tolerância: relógio e leitura discordam, e não há como
  // afirmar que ela é recente. Recusar custa uma espera; aceitar poderia
  // usar uma posição velha num aparelho com o relógio atrasado.
  if (idade < -policy.clockSkewTolerance) return ReadingVerdict.stale;

  final precisao = reading.accuracyMeters;
  if (precisao == null) return ReadingVerdict.noAccuracy;
  if (!precisao.isFinite || precisao <= 0) {
    return ReadingVerdict.invalidAccuracy;
  }
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
  /// captura como `cancelled`. [onDiagnostic] recebe o juízo de cada leitura,
  /// sem coordenada — é o gancho de teste e de diagnóstico.
  ///
  /// Nunca devolve uma leitura fora do contrato: no tempo esgotado, a melhor
  /// precisão vista vai na FALHA, para a mensagem, e a posição fica para trás.
  Future<OperationalFixResult> acquire({
    OperationalFixPolicy policy = const OperationalFixPolicy(),
    void Function(double accuracyMeters)? onReading,
    void Function(ReadingDiagnostic diagnostic)? onDiagnostic,
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

    // Só para o diagnóstico: o juízo da leitura é pela idade dela, e não por
    // este instante (RC-1C-HOTFIX-2).
    final inicio = _clock();
    final desfecho = Completer<OperationalFixResult>();
    double? melhor;
    var recebidas = 0;
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

    final Stream<RawPositionReading> leituras;
    try {
      leituras = _source.positions();
    } catch (error) {
      // Um plugin que falha na hora de abrir o fluxo não pode deixar a tela
      // presa em "buscando" até o prazo: a falha é tipada, agora.
      Log.error('gps_acquisition_failed stage=open', error: error);
      encerrar(falha(OperationalFixFailure.unavailable));
      return desfecho.future;
    }
    assinatura = leituras.listen(
      (leitura) {
        if (desfecho.isCompleted) return;
        final agora = _clock();
        final veredito = evaluateReading(leitura, now: agora, policy: policy);
        recebidas += 1;
        final diagnostico = ReadingDiagnostic(
          sequence: recebidas,
          verdict: veredito,
          age: agora.difference(leitura.timestamp),
          bornBeforeCapture: inicio.difference(leitura.timestamp),
          accuracyMeters: leitura.accuracyMeters,
          platform: leitura.platform,
        );
        onDiagnostic?.call(diagnostico);
        final cru = diagnostico.rawLine;
        if (cru != null) _diagnostico(cru);
        _diagnostico(diagnostico.line);
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
    _diagnostico(
      'gps_capture outcome=${switch (resultado) {
        OperationalFixAcquired() => 'acquired',
        OperationalFixFailed(:final reason) => reason.name,
      }} readings=$recebidas '
      'bestAccuracyMeters=${melhor?.toStringAsFixed(1) ?? '-'}',
    );
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

/// A precisão horizontal que a plataforma MEDIU, ou `null` — RC-1C-HOTFIX-3.
///
/// `Position.hasAccuracy` sozinho NÃO serve no Android com as versões
/// instaladas: `geolocator_android` 4.6.2 reconstrói a leitura em
/// `AndroidPosition.fromMap` sem repassar o campo, e ele chega `false` em TODA
/// leitura, com o número medido intacto em `accuracy`. Confiar na bandeira era
/// recusar 100% das leituras do Android como `noAccuracy`.
///
/// O que o plugin garante, e é por isso que esta regra é medida e não
/// suposição: o `LocationMapper` nativo só escreve `accuracy` quando
/// `Location.hasAccuracy()` é verdadeiro (`Location.getAccuracy()`, em metros),
/// e a ausência chega como `0.0` pelo `_toDouble` do `Position.fromMap`. Então:
///
/// - a plataforma afirma que mediu → o valor como veio; zero, negativo ou
///   infinito são recusados adiante como `invalidAccuracy`;
/// - não afirma → só um número POSITIVO e finito é medida. O `0.0` é a marca
///   de "não mediu" e vira `null`: nunca "zero metros de erro", nunca um valor
///   presumido, nunca a precisão pedida ao provedor.
double? measuredAccuracyMeters(Position position) {
  if (position.hasAccuracy) return position.accuracy;
  final valor = position.accuracy;
  return valor.isFinite && valor > 0 ? valor : null;
}

/// A leitura crua de uma `Position` do plugin, com a precisão MEDIDA e os fatos
/// da plataforma para o diagnóstico — RC-1C-HOTFIX-3.
///
/// Nada se perde aqui: a coordenada, o instante e o número de precisão passam
/// como vieram, e a única decisão é se o número é medida.
RawPositionReading readingFromPlatformPosition(Position position) =>
    RawPositionReading(
      latitude: position.latitude,
      longitude: position.longitude,
      accuracyMeters: measuredAccuracyMeters(position),
      timestamp: position.timestamp,
      platform: PlatformPositionFacts(
        type: position.runtimeType.toString(),
        hasAccuracy: position.hasAccuracy,
        rawAccuracy: position.accuracy,
        timestamp: position.timestamp,
      ),
    );

/// O plugin `geolocator`, atrás da fronteira.
///
/// ## A precisão lida
///
/// Pela `readingFromPlatformPosition`: `hasAccuracy` sozinho mente no Android
/// (RC-1C-HOTFIX-3), e a regra de medida mora em `measuredAccuracyMeters`.
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
        .map(readingFromPlatformPosition)
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
