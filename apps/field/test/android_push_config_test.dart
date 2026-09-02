import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// # A configuração nativa do Android para push (`NF-2`)
///
/// Testes de INSPEÇÃO. Eles leem os arquivos reais do módulo Android, e
/// existem porque manifesto e Gradle são exatamente o tipo de coisa que
/// ninguém revisa: quebram no build de release, meses depois, longe de quem
/// mexeu.
File _arquivo(String caminho) {
  final f = File(caminho);
  // Roda a partir de `apps/field`, que é onde `flutter test` é invocado.
  expect(f.existsSync(), isTrue, reason: 'arquivo ausente: $caminho');
  return f;
}

void main() {
  group('NF2-13 · manifesto', () {
    test('declara POST_NOTIFICATIONS', () {
      final manifesto = _arquivo('android/app/src/main/AndroidManifest.xml')
          .readAsStringSync();

      /*
        Sem esta linha o Android 13+ nunca exibe o diálogo, e a permissão fica
        permanentemente negada — sem nenhum erro visível. O aplicativo apenas
        deixa de receber, em silêncio.
      */
      expect(manifesto, contains('android.permission.POST_NOTIFICATIONS'));
    });

    test('não pede permissão que o push não precisa', () {
      final manifesto = _arquivo('android/app/src/main/AndroidManifest.xml')
          .readAsStringSync();

      // Cada permissão a mais é uma pergunta a mais na loja e no aparelho.
      expect(manifesto, isNot(contains('RECEIVE_BOOT_COMPLETED')));
      expect(manifesto, isNot(contains('SCHEDULE_EXACT_ALARM')));
      expect(manifesto, isNot(contains('WAKE_LOCK')));
    });
  });

  group('NF2-14 · Gradle', () {
    test('o plugin do Google Services é aplicado CONDICIONALMENTE', () {
      final gradle = _arquivo('android/app/build.gradle.kts')
          .readAsStringSync();

      /*
        O plugin falha o build quando o `google-services.json` falta. Aplicado
        sem condição, ninguém compilaria o Field sem antes ter acesso ao
        projeto Firebase da plataforma — nem para rodar em emulador.
      */
      expect(gradle, contains('googleServicesJson'));
      expect(gradle, contains('com.google.gms.google-services'));
      expect(gradle, contains('if (googleServicesJson.exists())'));
    });

    test('a versão do plugin é declarada no settings, sem aplicar', () {
      final settings = _arquivo('android/settings.gradle.kts')
          .readAsStringSync();

      expect(settings, contains('com.google.gms.google-services'));
      // `apply false`: quem decide aplicar é o módulo, sob condição.
      expect(
        settings,
        contains(
          'id("com.google.gms.google-services") version "4.4.4" apply false',
        ),
      );
    });
  });

  group('NF2-15 · nenhum segredo no Android', () {
    test('não existe google-services.json versionado', () {
      // Ele é fornecido pelo operador, por ambiente, e fica fora do Git.
      expect(File('android/app/google-services.json').existsSync(), isFalse);
    });

    test('o .gitignore cobre o google-services.json', () {
      final ignore = _arquivo('.gitignore').readAsStringSync();
      expect(ignore, contains('android/app/google-services.json'));
    });

    test('nenhuma chave de conta de serviço no módulo Android', () {
      /*
        A credencial de SERVIDOR vive só no worker, no `firebase-admin`. Uma
        chave de conta de serviço dentro do APK seria extraível por qualquer
        pessoa que baixasse o aplicativo — e daria poder de enviar push em nome
        de todas as empresas do AlfaOS.
      */
      final suspeitos = Directory('android')
          .listSync(recursive: true)
          .whereType<File>()
          .where((f) {
            final nome = f.path.toLowerCase();
            return nome.endsWith('.json') ||
                nome.endsWith('.pem') ||
                nome.endsWith('.p12');
          })
          .where((f) => !f.path.contains('.gradle'))
          .where((f) => !f.path.contains('build'))
          .where((f) => f.readAsStringSync().contains('private_key'))
          .toList();

      expect(suspeitos, isEmpty);
    });
  });
}
