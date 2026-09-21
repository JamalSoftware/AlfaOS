import 'dart:io';

import 'package:alfaos_field/core/config/env.dart';
import 'package:flutter_test/flutter_test.dart';

/// # `SEC-013` — um build de release não sai apontando para o laboratório
///
/// ## O achado
///
/// `flutter build apk --release` sem `--dart-define=ALFAOS_API_BASE_URL`
/// produzia um APK com `http://10.0.2.2:3000` — o endereço do emulador —
/// **sem avisar ninguém**. Num aparelho físico aquele host não existe, então o
/// aplicativo instalado não funcionaria e o sintoma apareceria como "sem
/// conexão", culpando a rede em vez do build.
///
/// ## O que já protegia
///
/// `android:usesCleartextTraffic="true"` existe só no manifesto de **debug**,
/// então um release já não fala HTTP em texto claro: o Android bloqueia na
/// plataforma. É o que mantém o achado em severidade baixa. O que faltava era
/// falhar ALTO em vez de em silêncio.
///
/// Os testes atacam a função pura: nenhum widget, nenhum canal nativo, e por
/// isso eles rodam nos dois modos sem depender de como a suíte foi compilada.
void main() {
  group('SEC-013 · configuração de release', () {
    test('SEC-013-01 · o padrão de desenvolvimento é RECUSADO num release', () {
      final erro = Env.releaseConfigurationError(Env.developmentDefault);
      expect(erro, isNotNull);
      expect(erro, contains('DESENVOLVIMENTO'));
    });

    test('SEC-013-02 · URL vazia é recusada, nomeando o define', () {
      for (final vazia in ['', '   ']) {
        final erro = Env.releaseConfigurationError(vazia);
        expect(erro, isNotNull, reason: 'aceitou "$vazia"');
        expect(erro, contains('ALFAOS_API_BASE_URL'));
      }
    });

    test('SEC-013-03 · http é recusado: o token viaja em Authorization', () {
      final erro = Env.releaseConfigurationError('http://campo.exemplo.com.br');
      expect(erro, isNotNull);
      expect(erro, contains('https'));
    });

    test('SEC-013-04 · https para endereço de laboratório é recusado', () {
      // Trocar o esquema não torna o host alcançável pelo aparelho.
      for (final url in [
        'https://10.0.2.2:3000',
        'https://localhost:3000',
        'https://127.0.0.1',
      ]) {
        expect(
          Env.releaseConfigurationError(url),
          isNotNull,
          reason: 'aceitou $url',
        );
      }
    });

    test('SEC-013-05 · endereço relativo ou sem host é recusado', () {
      for (final url in ['/api', 'campo.exemplo.com.br', 'https://']) {
        expect(
          Env.releaseConfigurationError(url),
          isNotNull,
          reason: 'aceitou $url',
        );
      }
    });

    test('SEC-013-06 · CONTROLE POSITIVO: https de produção é aceito', () {
      /*
        Sem este controle, a correção passaria mesmo se alguém tivesse recusado
        TODA URL — e aí nenhum release conseguiria ser gerado, com os cinco
        testes acima verdes.
      */
      for (final url in [
        'https://campo.exemplo.com.br',
        'https://app.exemplo.com.br:8443',
        'https://campo.exemplo.com.br/base',
      ]) {
        expect(
          Env.releaseConfigurationError(url),
          isNull,
          reason: 'recusou $url',
        );
      }
    });

    test('SEC-013-07 · em DEBUG o padrão local continua valendo', () {
      /*
        O guarda não pode atrapalhar o desenvolvimento nem o piloto físico, que
        aponta para o IP da rede do notebook em HTTP.
      */
      expect(Env.isDebug, isTrue, reason: 'a suíte deveria rodar em debug');
      expect(Env.startupConfigurationError, isNull);
    });

    test('SEC-013-09 · o RAMO DE RELEASE é o que bloqueia, e é testável', () {
      /*
        A lacuna que uma sabotagem encontrou: a suíte roda sempre em debug,
        então `startupConfigurationError` devolver `null` sempre passava por
        todos os testes — `null` é a resposta CERTA em debug. A linha mais
        importante do guarda (`isDebug ? null : ...`) não tinha detector.

        Com o modo como argumento, os dois ramos são afirmáveis. Este teste cai
        se alguém desligar a verificação de release.
      */
      expect(
        Env.configurationErrorFor(
          isDebugBuild: false,
          url: Env.developmentDefault,
        ),
        isNotNull,
        reason: 'o ramo de release precisa recusar a URL de desenvolvimento',
      );
      expect(
        Env.configurationErrorFor(
          isDebugBuild: false,
          url: 'http://campo.exemplo.com.br',
        ),
        isNotNull,
      );
      // E o ramo de debug continua liberando o fluxo local.
      expect(
        Env.configurationErrorFor(
          isDebugBuild: true,
          url: Env.developmentDefault,
        ),
        isNull,
      );
      // CONTROLE POSITIVO: release com https de produção passa.
      expect(
        Env.configurationErrorFor(
          isDebugBuild: false,
          url: 'https://campo.exemplo.com.br',
        ),
        isNull,
      );
    });

    test(
      'SEC-013-10 · o main CONSOME o guarda antes de subir o aplicativo',
      () {
        /*
        Prova estrutural, e ela é necessária: a decisão pode estar perfeita e não
        ser chamada. Um teste de widget sobre `main()` não é possível sem subir
        o binding real, então o que se afirma é a ligação — e ela precisa vir
        ANTES do `runApp` do aplicativo de verdade.
      */
        final fonte = File('lib/main.dart').readAsStringSync();
        final semComentarios = fonte
            .split('\n')
            .where((l) => !l.trimLeft().startsWith('//'))
            .join('\n')
            .replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '');

        expect(semComentarios, contains('Env.startupConfigurationError'));
        expect(semComentarios, contains('MisconfiguredBuildScreen'));

        final guarda = semComentarios.indexOf('Env.startupConfigurationError');
        final appReal = semComentarios.indexOf('AlfaOsFieldApp');
        expect(guarda, greaterThan(-1));
        expect(appReal, greaterThan(-1));
        expect(
          guarda,
          lessThan(appReal),
          reason: 'o guarda precisa vir antes de subir o aplicativo',
        );
      },
    );

    test('SEC-013-08 · o padrão de fábrica continua sendo o do emulador', () {
      // Trocar o padrão silenciosamente quebraria o fluxo de emulador que o
      // README documenta.
      expect(Env.developmentDefault, 'http://10.0.2.2:3000');
    });
  });
}
