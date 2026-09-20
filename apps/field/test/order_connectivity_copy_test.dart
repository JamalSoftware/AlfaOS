import 'package:flutter_test/flutter_test.dart';

import 'package:alfaos_field/features/orders/domain/service_order.dart';

/// # Conectividade na OS — duração do estado ≠ idade da verificação
///
/// O dono viu, em aparelho real, *"Online há 25 d"* numa OS. A frase afirma há
/// quanto tempo o cliente está no ar — e o número saía de `observedAt`, que é
/// quando alguém CONFERIU pela última vez. Os dois fatos são independentes:
/// um cliente pode estar online há 25 dias e ter sido verificado há 3 minutos,
/// e é exatamente esse o caso normal de um ciclo que reconfere de 5 em 5
/// minutos.
///
/// ```text
/// statusSince   desde quando o estado atual dura      "Online há 25 d"
/// observedAt    quando o provedor confirmou           "Verificado há 3 min"
/// stale         a confirmação envelheceu (SERVIDOR)   "Leitura desatualizada"
/// ```
///
/// `stale` NÃO é um quarto estado: os estados continuam `ONLINE`, `OFFLINE` e
/// `UNKNOWN`. Ele é um aviso sobre a idade da leitura, e os dois fatos são
/// verdadeiros ao mesmo tempo.

OrderDiagnostic _diag({
  String status = 'ONLINE',
  DateTime? statusSince,
  DateTime? observedAt,
  bool stale = false,
}) {
  return OrderDiagnostic.fromJson({
    'connectivityStatus': status,
    'statusSince': statusSince?.toIso8601String(),
    'observedAt': observedAt?.toIso8601String(),
    'verificationIsStale': stale,
  });
}

void main() {
  final agora = DateTime.utc(2026, 9, 20, 12, 0);

  group('CONN-COPY — as duas frases saem de datas diferentes', () {
    test('CONN-COPY-A · ONLINE: 25 d de estado, 3 min de verificação', () {
      final d = _diag(
        status: 'ONLINE',
        statusSince: agora.subtract(const Duration(days: 25)),
        observedAt: agora.subtract(const Duration(minutes: 3)),
      );

      expect(d.statusDurationLabel(now: agora), 'Online há 25 d');
      expect(d.verificationAgeLabel(now: agora), 'Verificado há 3 min');
    });

    test('CONN-COPY-B · OFFLINE: 2 h de estado, 4 min de verificação', () {
      final d = _diag(
        status: 'OFFLINE',
        statusSince: agora.subtract(const Duration(hours: 2)),
        observedAt: agora.subtract(const Duration(minutes: 4)),
      );

      expect(d.statusDurationLabel(now: agora), 'Offline há 2 h');
      expect(d.verificationAgeLabel(now: agora), 'Verificado há 4 min');
    });

    test(
      'CONN-COPY-C · leitura velha: o ESTADO continua, o aviso acompanha',
      () {
        final d = _diag(
          status: 'ONLINE',
          statusSince: agora.subtract(const Duration(days: 25)),
          observedAt: agora.subtract(const Duration(hours: 2)),
          stale: true,
        );

        // O estado não vira "desatualizado": ele continua sendo ONLINE.
        expect(d.connectivityStatus, 'ONLINE');
        expect(d.label, 'Online');
        expect(d.verificationIsStale, isTrue);
        expect(d.statusDurationLabel(now: agora), 'Online há 25 d');
        expect(d.verificationAgeLabel(now: agora), 'Verificado há 2 h');
      },
    );

    test('CONN-COPY-D · UNKNOWN não ganha duração inventada', () {
      final d = _diag(
        status: 'UNKNOWN',
        statusSince: agora.subtract(const Duration(days: 3)),
        observedAt: agora.subtract(const Duration(days: 3)),
      );

      /*
        `label` é "Desconhecido" e não "Sem leitura": a tabela canônica
        (`connectivity-presentation.ts`) guarda as duas grafias na mesma
        linha de propósito — "Sem leitura" é a do MAPA, onde se varre dezenas
        de pontos, e "Desconhecido" é a da OS, onde se fala de um cliente por
        vez. Esta é a tela da OS.
      */
      expect(d.label, 'Desconhecido');
      expect(d.statusDurationLabel(now: agora), isNull);
      // A verificação continua sendo um fato observável, e pode ser mostrada.
      expect(d.verificationAgeLabel(now: agora), 'Verificado há 3 d');
    });

    test('CONN-COPY-E · sem statusSince, NÃO se usa observedAt no lugar', () {
      final d = _diag(
        status: 'ONLINE',
        statusSince: null,
        observedAt: agora.subtract(const Duration(days: 25)),
      );

      // A tentação é escrever "Online há 25 d" com a data que existe — e é
      // literalmente o defeito relatado.
      expect(d.statusDurationLabel(now: agora), isNull);
      expect(d.verificationAgeLabel(now: agora), 'Verificado há 25 d');
    });

    test('CONN-COPY-F · sem observedAt, nenhuma idade é fabricada', () {
      final d = _diag(
        status: 'ONLINE',
        statusSince: agora.subtract(const Duration(hours: 5)),
        observedAt: null,
      );

      expect(d.verificationAgeLabel(now: agora), isNull);
      expect(d.statusDurationLabel(now: agora), 'Online há 5 h');
    });

    test('CONN-COPY-G · servidor antigo: sem os campos novos, nada quebra', () {
      // Um APK novo contra um servidor anterior a esta versão: sem
      // `statusSince` não há duração, e sem `verificationIsStale` não há
      // aviso — em vez de um limiar local decidindo por conta própria.
      final d = OrderDiagnostic.fromJson({
        'connectivityStatus': 'ONLINE',
        'observedAt': agora
            .subtract(const Duration(minutes: 9))
            .toIso8601String(),
      });

      expect(d.statusDurationLabel(now: agora), isNull);
      expect(d.verificationIsStale, isFalse);
      expect(d.verificationAgeLabel(now: agora), 'Verificado há 9 min');
    });
  });
}
