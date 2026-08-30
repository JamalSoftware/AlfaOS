import 'package:alfaos_field/features/timeclock/domain/workday.dart';
import 'package:flutter_test/flutter_test.dart';

/// # O relógio da EMPRESA, não o do aparelho
///
/// O piloto fechou com o Field montando `requestedOccurredAt` a partir do fuso
/// do Android (§253, LOW-3). Num SaaS isso está errado por construção: o
/// técnico que viaja, que está em roaming ou que mexeu no relógio escolhia
/// `08:30` e o servidor recebia outro instante — sem nada na tela denunciar.
///
/// Estes testes seguram o par de funções que resolve isso. Eles não dependem
/// do fuso da máquina que os executa, e é de propósito: um teste de fuso que
/// só passa no fuso de quem escreveu não prova nada sobre o aparelho de quem
/// usa.
void main() {
  group('parseUtcOffset', () {
    test('aceita os dois sinais', () {
      expect(parseUtcOffset('-03:00'), const Duration(hours: -3));
      expect(parseUtcOffset('+02:00'), const Duration(hours: 2));
      expect(parseUtcOffset('+00:00'), Duration.zero);
    });

    test('aceita fuso de meia hora', () {
      // `Asia/Kolkata`. Um parser que só lesse horas erraria a Índia inteira.
      expect(parseUtcOffset('+05:30'), const Duration(hours: 5, minutes: 30));
      expect(parseUtcOffset('-03:30'), const Duration(hours: -3, minutes: -30));
    });

    test('recusa o que não é deslocamento', () {
      // Vazio é o servidor antigo; o resto é lixo. Nenhum vira Duration.zero
      // por acidente — zero é um fuso REAL, e confundir os dois faria Londres
      // e "não sei" darem a mesma resposta.
      for (final ruim in [
        null,
        '',
        'America/Sao_Paulo',
        'GMT-03:00',
        '-3:00',
        '-03',
        '+99:00',
        '-03:99',
      ]) {
        expect(parseUtcOffset(ruim), isNull, reason: 'aceitou "$ruim"');
      }
    });
  });

  group('inCompanyTime', () {
    final instante = DateTime.utc(2026, 8, 29, 11, 0);

    test('lê o instante no fuso da empresa', () {
      expect(inCompanyTime(instante, '-03:00').hour, 8);
      expect(inCompanyTime(instante, '+02:00').hour, 13);
      expect(inCompanyTime(instante, '+05:30').hour, 16);
      expect(inCompanyTime(instante, '+05:30').minute, 30);
    });

    test('sem deslocamento cai no aparelho — o comportamento anterior', () {
      // Servidor antigo com APK novo. Não é o certo, mas é o que existia, e
      // exibir UTC como se fosse a hora da pessoa seria pior.
      expect(inCompanyTime(instante, ''), instante.toLocal());
    });
  });

  group('instantFromCompanyTime', () {
    /*
      O TESTE QUE IMPORTA.

      A MESMA hora civil, com deslocamentos diferentes, tem de produzir
      instantes diferentes. É isto que prova que o deslocamento — e não o
      relógio do aparelho — é a autoridade: voltar a usar o fuso do dispositivo
      faria os dois casos abaixo devolverem o MESMO instante, e o teste cai em
      qualquer máquina, em qualquer fuso.
    */
    test('o deslocamento decide o instante, não o aparelho', () {
      final saoPaulo = instantFromCompanyTime('2026-08-29', 8, 30, '-03:00');
      final lisboa = instantFromCompanyTime('2026-08-29', 8, 30, '+01:00');

      expect(saoPaulo!.toUtc(), DateTime.utc(2026, 8, 29, 11, 30));
      expect(lisboa!.toUtc(), DateTime.utc(2026, 8, 29, 7, 30));
      expect(saoPaulo, isNot(lisboa));
    });

    test('08:30 em America/Sao_Paulo é 11:30Z', () {
      final instante = instantFromCompanyTime('2026-08-29', 8, 30, '-03:00');
      expect(instante!.toUtc().toIso8601String(), '2026-08-29T11:30:00.000Z');
    });

    /*
      HORÁRIO DE VERÃO.

      O aplicativo não conhece regra de verão nenhuma, e não deve conhecer: uma
      tabela dentro do APK envelhece na primeira mudança de lei, e um celular
      em campo é o que menos se atualiza. Quem sabe é o servidor, que calcula o
      deslocamento PARA AQUELE DIA.

      O que se cobra aqui é que o aplicativo HONRE o deslocamento recebido:
      `America/New_York` manda `-05:00` em janeiro e `-04:00` em julho, e a
      mesma hora civil tem de virar instantes distintos.
    */
    test('honra o deslocamento do DIA num fuso com horário de verão', () {
      final inverno = instantFromCompanyTime('2026-01-15', 9, 0, '-05:00');
      final verao = instantFromCompanyTime('2026-07-15', 9, 0, '-04:00');

      expect(inverno!.toUtc(), DateTime.utc(2026, 1, 15, 14, 0));
      expect(verao!.toUtc(), DateTime.utc(2026, 7, 15, 13, 0));
    });

    test('meia-noite e o fim do dia não escorregam de data', () {
      expect(
        instantFromCompanyTime('2026-08-29', 0, 0, '-03:00')!.toUtc(),
        DateTime.utc(2026, 8, 29, 3, 0),
      );
      // 23:50 em São Paulo é 02:50Z do dia seguinte — o caso que a §226 cita.
      expect(
        instantFromCompanyTime('2026-08-29', 23, 50, '-03:00')!.toUtc(),
        DateTime.utc(2026, 8, 30, 2, 50),
      );
    });

    test('data malformada não vira instante', () {
      expect(instantFromCompanyTime('', 8, 30, '-03:00'), isNull);
      expect(instantFromCompanyTime('2026-08', 8, 30, '-03:00'), isNull);
      expect(instantFromCompanyTime('ontem', 8, 30, '-03:00'), isNull);
    });

    test('sem deslocamento cai no aparelho, com a data preservada', () {
      final instante = instantFromCompanyTime('2026-08-29', 8, 30, '');
      expect(instante, DateTime(2026, 8, 29, 8, 30));
    });
  });

  group('Workday.fromJson', () {
    test('lê o deslocamento que o servidor mandou', () {
      final workday = Workday.fromJson(const {
        'date': '2026-08-29',
        'timezone': 'America/Sao_Paulo',
        'utcOffset': '-03:00',
        'state': 'WORKING',
        'allowedActions': ['CLOCK_OUT'],
        'entries': [],
        'workedMinutes': 60,
        'breakMinutes': 0,
        'inconsistencies': [],
        'pendingAdjustments': 0,
      });

      expect(workday.utcOffset, '-03:00');
    });

    test('servidor antigo não quebra o aplicativo', () {
      final workday = Workday.fromJson(const {
        'date': '2026-08-29',
        'state': 'NOT_STARTED',
        'allowedActions': ['CLOCK_IN'],
        'entries': [],
        'workedMinutes': 0,
        'breakMinutes': 0,
        'inconsistencies': [],
        'pendingAdjustments': 0,
      });

      expect(workday.utcOffset, '');
    });
  });
}
