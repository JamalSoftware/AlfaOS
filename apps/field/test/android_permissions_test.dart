import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// # A fronteira de permissões do Android
///
/// ## O que esta auditoria descobriu
///
/// O manifesto de FONTE não é o que vai no aparelho. O Gradle funde o nosso com
/// o de cada plugin e o de cada AAR, e o resultado pode conter permissões que
/// ninguém neste repositório escreveu. No AlfaOS são quatro, todas de
/// `firebase_messaging` e suas dependências.
///
/// O `NF2-13` afirmava que o aplicativo não usava `WAKE_LOCK`. A afirmação era
/// verdadeira sobre o arquivo que ele lia e **falsa sobre o APK**, que a tem
/// desde que a `NF-2` acrescentou o Firebase. Um teste que documenta uma crença
/// errada é pior que a ausência do teste: ele encerra a discussão.
///
/// ## Por que duas camadas
///
/// Os dois vetores de entrada de permissão são diferentes e nenhum deles cobre
/// o outro:
///
/// - alguém acrescenta uma linha ao nosso manifesto — visível na FONTE;
/// - alguém acrescenta um plugin que traz permissão própria — invisível na
///   fonte, e só aparece no manifesto FUNDIDO.
///
/// Por isso o conjunto esperado é declarado por extenso e comparado por
/// IGUALDADE, não por ausência: uma lista de proibidas só pega o que já
/// imaginamos: a igualdade pega o que não imaginamos.

// ---------------------------------------------------------------------------
// O que o aplicativo declara, e por quê
// ---------------------------------------------------------------------------

/// Permissões que NÓS declaramos. Cada uma tem funcionalidade em produção.
const declaradasPorNos = {
  // Falar com a API do AlfaOS.
  'android.permission.INTERNET',
  // Evidência fotográfica do atendimento (PRD §162).
  'android.permission.CAMERA',
  // Aviso de OS atribuída (NF-2..NF-5).
  'android.permission.POST_NOTIFICATIONS',
  // Ponto e check-in, ENQUANTO EM USO. As duas juntas porque o Android 12+
  // deixa conceder só a aproximada — validado em aparelho: concedendo
  // "Aproximada", o ponto foi registrado com precisão de 2000 m.
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
};

/// Permissões que os PLUGINS acrescentam. Nenhuma é de runtime; nenhuma
/// aparece para o usuário.
///
/// Origem apurada no relatório de blame do próprio merger do Gradle, não
/// presumida.
const injetadasPorPlugins = {
  // firebase_messaging: acordar o aparelho para entregar a mensagem.
  'android.permission.WAKE_LOCK',
  // firebase_messaging: decidir quando repetir o envio.
  'android.permission.ACCESS_NETWORK_STATE',
  // com.google.firebase:firebase-messaging — receber do Google Play Services.
  'com.google.android.c2dm.permission.RECEIVE',
  // androidx.core: permissão de nível `signature`, escopada a este pacote,
  // para os receivers dinâmicos da própria biblioteca.
  'com.jamalsoftware.alfaos.field.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
};

/// Permissões que NÃO podem entrar sem decisão explícita de produto.
///
/// Não é uma lista de "coisas feias": é a lista do que, entrando de carona num
/// plugin, mudaria o que o AlfaOS pode fazer com o aparelho e com a pessoa —
/// e passaria despercebido, porque nada na tela mudaria.
const proibidas = {
  // Mensagens e agenda do técnico. O AlfaOS não manda SMS nem lê contatos.
  'android.permission.READ_SMS',
  'android.permission.SEND_SMS',
  'android.permission.RECEIVE_SMS',
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  // Discar é Intent para o app externo (`tel:`), e Intent não pede permissão.
  'android.permission.CALL_PHONE',
  'android.permission.READ_PHONE_STATE',
  'android.permission.READ_PHONE_NUMBERS',
  // Destrava o GPS do EXIF de foto vinda da galeria no Android 10+. É o
  // vizinho direto da pendência de EXIF registrada em `SECURITY.md` §8.16.8:
  // enquanto a coordenada não for removida na saída, esta permissão só
  // aumentaria o que sai do aparelho.
  'android.permission.ACCESS_MEDIA_LOCATION',
  // Listar todo aplicativo instalado. As `<queries>` nominais bastam para
  // Maps e Waze.
  'android.permission.QUERY_ALL_PACKAGES',
  // Armazenamento amplo. O seletor de fotos do Android atende sem nada disso.
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  // Rastreamento com o app fechado. É outra capability, com outro
  // consentimento (PRD §138) — nunca efeito colateral desta.
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  // Microfone: rádio/voz é futuro, e não tem código.
  'android.permission.RECORD_AUDIO',
  // Equipamento por Bluetooth não existe hoje.
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH_ADVERTISE',
  // Especiais: desenhar por cima, instalar pacote, ler uso de apps.
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.PACKAGE_USAGE_STATS',
  // Acordar sozinho no boot.
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
};

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/// Extrai os nomes de `uses-permission` de um manifesto, sem parser de XML.
///
/// A expressão casa o atributo `android:name` de uma tag `uses-permission`, que
/// é a única forma que o merger do Gradle emite. Um parser completo não pagaria
/// por si aqui e traria dependência nova.
Set<String> permissoesDe(String xml) {
  final re = RegExp(
    r'<uses-permission[^>]*android:name\s*=\s*"([^"]+)"',
    multiLine: true,
  );
  return re.allMatches(xml).map((m) => m.group(1)!).toSet();
}

String? leSeExistir(String caminho) {
  final f = File(caminho);
  return f.existsSync() ? f.readAsStringSync() : null;
}

/// Onde o Gradle escreve os manifestos fundidos, por variante.
///
/// `release` entra na lista e **não** é exigido: este repositório não produz
/// APK assinado, então o de release costuma não existir. Quando existir, ele é
/// conferido igual — é ele, e não o de debug, que vai para a loja.
const _caminhosFundidos = {
  'debug': [
    'build/app/intermediates/merged_manifests/debug/'
        'processDebugManifest/AndroidManifest.xml',
    'build/app/intermediates/merged_manifest/debug/'
        'processDebugMainManifest/AndroidManifest.xml',
  ],
  'release': [
    'build/app/intermediates/merged_manifests/release/'
        'processReleaseManifest/AndroidManifest.xml',
    'build/app/intermediates/merged_manifest/release/'
        'processReleaseMainManifest/AndroidManifest.xml',
  ],
};

File? _arquivoFundido(String variante) {
  for (final caminho in _caminhosFundidos[variante]!) {
    final f = File(caminho);
    if (f.existsSync()) return f;
  }
  return null;
}

/// O manifesto FUNDIDO de debug — **exigido**, não opcional.
///
/// ## Por que isto FALHA em vez de pular
///
/// A versão anterior chamava `markTestSkipped` quando o arquivo faltava, e a
/// auditoria independente mostrou que isso anulava a única proteção do
/// repositório contra permissão injetada por plugin. `build/` é ignorado pelo
/// Git, então em clone novo, em CI ou depois de `flutter clean` o artefato não
/// existe — e o resumo dizia `~2`, que ninguém lê como "a asserção de segurança
/// não rodou". Pior: o README mandava rodar `flutter test` ANTES de
/// `flutter build apk`, que é exatamente a ordem em que a proteção não existia.
///
/// É o mesmo erro que este arquivo nasceu para corrigir no `NF2-13`: concluir
/// sobre o artefato a partir de algo que não é o artefato. Pular em silêncio é
/// a forma mais educada de fazer isso.
File exigirFundido(String variante) {
  final f = _arquivoFundido(variante);
  if (f != null) return f;
  fail(
    'manifesto fundido de $variante ausente. Esta asserção é a ÚNICA que vê '
    'permissão injetada por plugin, e não pode passar sem rodar. '
    'Rode `flutter build apk --debug` ANTES de `flutter test`.',
  );
}

/// O fundido é mais novo que a declaração de dependências?
///
/// Um manifesto obsoleto é pior que um ausente: ele passa. Acrescente um plugin
/// ao `pubspec.yaml`, rode o teste sem reconstruir, e a comparação acontece
/// contra o mundo de ontem — verde, sem skip, sem sinal nenhum.
///
/// ## Por que `pubspec.yaml` e não `pubspec.lock`
///
/// A primeira versão comparava com o `lock`, e ela estava errada — descoberto
/// ao rodar o gate, não em teoria. O `lock` é reescrito por qualquer
/// `flutter pub get`, inclusive quando nada muda, enquanto o Gradle NÃO
/// reescreve o manifesto quando considera a tarefa atualizada. O resultado era
/// vermelho depois de um `pub get` inocente — e gate que grita à toa é gate que
/// as pessoas aprendem a ignorar, que é exatamente o desfecho que este arquivo
/// existe para evitar.
///
/// `pubspec.yaml` é o arquivo que uma PESSOA edita para acrescentar plugin.
/// Nenhuma ferramenta o reescreve sozinha, então um alarme aqui sempre
/// corresponde a uma mudança deliberada de dependência.
void exigirFrescor(File fundido) {
  final spec = File('pubspec.yaml');
  if (!spec.existsSync()) return;
  final doFundido = fundido.lastModifiedSync();
  final doSpec = spec.lastModifiedSync();
  expect(
    doFundido.isAfter(doSpec),
    isTrue,
    reason:
        'o manifesto fundido ($doFundido) é anterior ao pubspec.yaml '
        '($doSpec): as dependências mudaram depois do último build, e esta '
        'comparação estaria olhando para um artefato vencido. '
        'Rode `flutter build apk --debug` de novo.',
  );
}

void main() {
  group('PERM-01 · o manifesto de fonte é exatamente o esperado', () {
    test('nada a mais, nada a menos', () {
      final xml = File('android/app/src/main/AndroidManifest.xml')
          .readAsStringSync();

      /*
        IGUALDADE, e não `containsAll`.

        Uma asserção de ausência só pega o que alguém já imaginou proibir. A
        igualdade obriga quem acrescentar QUALQUER permissão a vir aqui,
        escrever por que ela existe, e assumir a decisão por escrito.
      */
      expect(permissoesDe(xml), declaradasPorNos);
    });

    test('debug e profile só acrescentam INTERNET', () {
      // São manifestos de FERRAMENTA — hot reload e breakpoint. Se um deles
      // ganhar permissão de produto, ela entraria só no build de quem
      // desenvolve, e passaria despercebida até o release.
      for (final variante in ['debug', 'profile']) {
        final xml = leSeExistir(
          'android/app/src/$variante/AndroidManifest.xml',
        );
        if (xml == null) continue;
        expect(permissoesDe(xml), {
          'android.permission.INTERNET',
        }, reason: 'manifesto de $variante');
      }
    });
  });

  group('PERM-02 · nenhuma permissão proibida, em lugar nenhum', () {
    test('na fonte', () {
      final xml = File('android/app/src/main/AndroidManifest.xml')
          .readAsStringSync();
      expect(permissoesDe(xml).intersection(proibidas), isEmpty);
    });

    test('no manifesto fundido de debug, que é o APK construído aqui', () {
      final fundido = exigirFundido('debug');
      exigirFrescor(fundido);
      /*
        Esta é a asserção que o `NF2-13` não conseguia fazer.

        Ele lia a FONTE e concluía sobre o APK. Um plugin novo que trouxesse
        `RECORD_AUDIO` ou `ACCESS_BACKGROUND_LOCATION` passaria por ele sem
        tocar em nada — e é exatamente assim que permissão perigosa entra num
        aplicativo: de carona, sem uma linha de diff que a mostre.
      */
      expect(
        permissoesDe(fundido.readAsStringSync()).intersection(proibidas),
        isEmpty,
      );
    });

    test('no de release, quando ele existe', () {
      /*
        O que vai para a loja é o RELEASE, e ele não é o debug: o de debug
        carrega `debuggable` e `usesCleartextTraffic`, que o outro não tem.
        Hoje o delta é a favor da segurança, mas uma dependência declarada só
        em `releaseImplementation` passaria por baixo da asserção acima.

        Este repositório não produz APK assinado, então o artefato costuma não
        existir — e por isso ele NÃO é exigido. Quando existir, é conferido.
      */
      final fundido = _arquivoFundido('release');
      if (fundido == null) {
        markTestSkipped('sem build de release neste repositório');
        return;
      }
      expect(
        permissoesDe(fundido.readAsStringSync()).intersection(proibidas),
        isEmpty,
      );
    });
  });

  group('PERM-03 · o que os plugins injetam é conhecido', () {
    test('o fundido é a fonte mais exatamente as injeções declaradas', () {
      final fundido = exigirFundido('debug');
      exigirFrescor(fundido);

      final fundidas = permissoesDe(fundido.readAsStringSync());
      final esperadas = {...declaradasPorNos, ...injetadasPorPlugins};

      /*
        A diferença nos dois sentidos, e cada uma diz uma coisa.

        SOBRANDO: um plugin passou a pedir algo que ninguém registrou. É o caso
        que motivou este arquivo — quatro permissões entraram com o Firebase e
        nenhum teste as viu.

        FALTANDO: uma injeção que declaramos deixou de existir. Não é falha de
        segurança, e ainda assim precisa ser sabida: significa que a lista aqui
        está descrevendo um mundo que não existe mais.
      */
      expect(
        fundidas.difference(esperadas),
        isEmpty,
        reason: 'permissão nova veio de um plugin e não está documentada',
      );
      expect(
        esperadas.difference(fundidas),
        isEmpty,
        reason: 'injeção documentada sumiu; a lista está desatualizada',
      );
    });
  });

  group('PERM-04 · nenhuma permissão é pedida na subida', () {
    test('só a localização pede, e é dentro da leitura de posição', () {
      /*
        A regra do §13: pedido de permissão é CONTEXTUAL. Login e abertura não
        podem depender de câmera nem de GPS.

        Quem pede no aplicativo são exatamente dois pontos, e nenhum está na
        subida: `GeolocatorLocationService.current()`, chamado pelo ponto e pelo
        check-in, e o `PushCoordinator`, chamado DEPOIS do primeiro login. A
        câmera não aparece aqui porque quem pede é o `image_picker`, no
        momento em que a foto é acionada.
      */
      final dart = Directory('lib')
          .listSync(recursive: true)
          .whereType<File>()
          .where((f) => f.path.endsWith('.dart'));

      final pedintes = <String>[];
      for (final f in dart) {
        if (f.readAsStringSync().contains('requestPermission()')) {
          pedintes.add(f.path.replaceAll(r'\', '/'));
        }
      }

      expect(pedintes..sort(), [
        'lib/core/location/location_service.dart',
        'lib/core/push/field_push_service.dart',
        'lib/core/push/push_coordinator.dart',
      ]);
    });

    test('a subida do app não toca em localização nem em câmera', () {
      /*
        `main.dart` entra junto com `app.dart`, e a razão é que a subida não
        cabe num arquivo só: `main` decide o que roda antes da árvore existir,
        e é o lugar mais fácil de alguém "adiantar" um pedido de permissão.

        `providers.dart` e `router.dart` ficam de fora de propósito — o
        primeiro DECLARA `locationServiceProvider` e proibir a string ali seria
        proibir a própria injeção de dependência. Quem responde por eles é o
        teste acima, que limita QUEM pode pedir.
      */
      for (final caminho in ['lib/app/app.dart', 'lib/main.dart']) {
        final fonte = leSeExistir(caminho);
        if (fonte == null) continue;
        for (final proibido in [
          'locationService',
          'photoCapture',
          'requestPermission',
          'requestNow',
        ]) {
          expect(
            fonte,
            isNot(contains(proibido)),
            reason: '$caminho: a subida não pede permissão nem usa sensor',
          );
        }
      }
    });
  });
}
