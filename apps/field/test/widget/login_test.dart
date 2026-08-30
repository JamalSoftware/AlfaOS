import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/core/errors/field_error.dart';
import 'package:alfaos_field/features/auth/state/session_controller.dart';
import 'package:alfaos_field/features/auth/ui/login_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// # LOGIN
///
/// Duas regras se cruzam aqui, e nenhuma pode ceder para a outra:
///
/// 1. **A recusa por credencial não revela qual metade estava errada.** Conta
///    inexistente, senha errada, usuário inativo, perfil sem acesso e técnico
///    inativo produzem a MESMA frase. Distinguir entregaria, a quem baixasse o
///    aplicativo, uma forma de descobrir quem trabalha na empresa.
/// 2. **A pessoa precisa saber o que aconteceu.** Uma tela que volta muda faz o
///    técnico repetir a senha certa até o bloqueio por tentativas — o pior
///    desfecho possível para um problema de rede.
///
/// Fixtures fictícias.

void main() {
  Future<void> preencher(WidgetTester tester) async {
    await tester.enterText(find.byKey(const Key('login-email')), 'a@b.test');
    await tester.enterText(find.byKey(const Key('login-password')), 'segredo');
  }

  Future<void> entrar(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pumpAndSettle();
  }

  String textoDoErro(WidgetTester tester) => tester
      .widget<Text>(
        find.descendant(
          of: find.byKey(const Key('login-error')),
          matching: find.byType(Text),
        ),
      )
      .data!;

  testWidgets('mostra os campos e o botão', (tester) async {
    await Harness().pump(tester, const LoginScreen());

    expect(find.text('AlfaOS Field'), findsOneWidget);
    expect(find.byKey(const Key('login-email')), findsOneWidget);
    expect(find.byKey(const Key('login-password')), findsOneWidget);
    expect(find.text('ENTRAR'), findsOneWidget);
  });

  testWidgets('valida campos vazios sem chamar a API', (tester) async {
    final h = Harness();
    await h.pump(tester, const LoginScreen());

    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pump();

    expect(find.text('Informe seu e-mail.'), findsOneWidget);
    expect(find.text('Informe sua senha.'), findsOneWidget);
    expect(h.transport.requests, isEmpty);
  });

  testWidgets('o campo de senha alterna visibilidade', (tester) async {
    await Harness().pump(tester, const LoginScreen());

    EditableText campo() => tester.widget<EditableText>(
      find.descendant(
        of: find.byKey(const Key('login-password')),
        matching: find.byType(EditableText),
      ),
    );

    expect(campo().obscureText, isTrue);
    await tester.tap(find.byKey(const Key('login-toggle-password')));
    await tester.pump();
    expect(campo().obscureText, isFalse);
  });

  group('a recusa por credencial não enumera contas', () {
    testWidgets('senha errada e conta inexistente dão a MESMA frase', (
      tester,
    ) async {
      final mensagens = <String>[];

      /*
        O servidor já devolve a mesma coisa nos dois casos — mesmo código, mesma
        frase, mesmo custo de bcrypt. Este teste prova que o APLICATIVO também
        não diferencia, ainda que o servidor um dia diferencie: são frases
        distintas chegando, e uma só saindo.
      */
      for (final vinda in [
        'Credenciais inválidas.',
        'Usuário não encontrado.',
      ]) {
        final h = Harness();
        h.transport.onError(
          'POST',
          '/auth/login',
          status: 401,
          code: 'UNAUTHENTICATED',
          message: vinda,
        );
        await h.pump(tester, const LoginScreen());
        await preencher(tester);
        await entrar(tester);

        expect(find.byKey(const Key('login-error')), findsOneWidget);
        mensagens.add(textoDoErro(tester));
      }

      expect(mensagens, [
        'Usuário ou senha inválidos.',
        'Usuário ou senha inválidos.',
      ]);
    });

    testWidgets('nada técnico atravessa para a tela', (tester) async {
      final h = Harness();
      h.transport.onError(
        'POST',
        '/auth/login',
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'bcrypt mismatch em users.passwordHash (id=cku123)',
      );
      await h.pump(tester, const LoginScreen());
      await preencher(tester);
      await entrar(tester);

      final texto = textoDoErro(tester);
      expect(texto, 'Usuário ou senha inválidos.');
      // Sem hash, sem tabela, sem id, sem status, sem endpoint.
      expect(texto, isNot(contains('bcrypt')));
      expect(texto, isNot(contains('401')));
      expect(texto, isNot(contains('/auth/login')));
    });
  });

  group('conexão não é credencial', () {
    testWidgets('sem rede diz que não conseguiu conectar', (tester) async {
      final h = Harness();
      h.transport.offline = true;
      await h.pump(tester, const LoginScreen());
      await preencher(tester);
      await entrar(tester);

      expect(textoDoErro(tester), 'Não foi possível conectar ao AlfaOS.');
    });

    testWidgets('timeout diz que o servidor demorou, não que a senha errou', (
      tester,
    ) async {
      final h = Harness();
      h.transport.timeout = true;
      await h.pump(tester, const LoginScreen());
      await preencher(tester);
      await entrar(tester);

      /*
        Sinal cheio e servidor lento. "Sem conexão" mandaria a pessoa procurar
        um problema de rede que não existe; "senha inválida" a faria repetir a
        senha certa até o bloqueio.
      */
      expect(textoDoErro(tester), contains('demorou'));
      expect(textoDoErro(tester), isNot(contains('senha')));
    });

    testWidgets('servidor com falha interna não vira credencial inválida', (
      tester,
    ) async {
      final h = Harness();
      h.transport.onError(
        'POST',
        '/auth/login',
        status: 500,
        code: 'INTERNAL',
        message: 'Erro interno.',
      );
      await h.pump(tester, const LoginScreen());
      await preencher(tester);
      await entrar(tester);

      expect(textoDoErro(tester), contains('Não foi possível conectar'));
    });

    testWidgets('bloqueio por tentativas explica o ritmo', (tester) async {
      final h = Harness();
      h.transport.onError(
        'POST',
        '/auth/login',
        status: 429,
        code: 'RATE_LIMITED',
        message:
            'Muitas tentativas de login. Tente novamente em alguns minutos.',
      );
      await h.pump(tester, const LoginScreen());
      await preencher(tester);
      await entrar(tester);

      // Quantas tentativas restam é informação sobre o RITMO, não sobre a
      // conta: escondê-la faria a pessoa insistir e piorar o bloqueio.
      expect(textoDoErro(tester), contains('Muitas tentativas'));
    });
  });

  group('a tela continua utilizável depois do erro', () {
    testWidgets('o botão volta, o e-mail fica e a senha some', (tester) async {
      final h = Harness();
      h.transport.onError(
        'POST',
        '/auth/login',
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'Credenciais inválidas.',
      );
      await h.pump(tester, const LoginScreen());
      await preencher(tester);
      await entrar(tester);

      // Sem isto a tela fica com o indicador girando para sempre.
      final botao = tester.widget<FilledButton>(
        find.byKey(const Key('login-submit')),
      );
      expect(botao.onPressed, isNotNull);
      expect(find.byType(CircularProgressIndicator), findsNothing);

      // Redigitar o e-mail é atrito puro; deixar a senha errada no campo
      // convida a reenviar exatamente a mesma coisa.
      expect(find.text('a@b.test'), findsOneWidget);
      expect(find.text('segredo'), findsNothing);
    });

    testWidgets('a segunda tentativa, agora correta, entra', (tester) async {
      final h = Harness();
      h.transport.onError(
        'POST',
        '/auth/login',
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'Credenciais inválidas.',
      );
      await h.pump(tester, const LoginScreen());
      await preencher(tester);
      await entrar(tester);
      expect(find.byKey(const Key('login-error')), findsOneWidget);

      // O servidor volta a aceitar, e a mesma tela consegue tentar de novo.
      h.transport.onJson('POST', '/auth/login', data: {'token': 'tok-1'});
      h.transport.onJson(
        'GET',
        '/me',
        data: {
          'user': {
            'id': 'u-1',
            'name': 'Técnico',
            'email': 'a@b.test',
            'profile': 'TECHNICIAN',
          },
          'company': {'id': 'c-1', 'name': 'Alfa'},
          'technician': {'id': 't-1', 'name': 'Técnico'},
        },
      );
      h.transport.onJson('POST', '/devices/register');

      await tester.enterText(
        find.byKey(const Key('login-password')),
        'a-certa',
      );
      await entrar(tester);

      // O token foi guardado: o login realmente aconteceu.
      expect(h.store.token, 'tok-1');
      expect(find.byKey(const Key('login-error')), findsNothing);
    });

    testWidgets('erro nenhum produz login falso', (tester) async {
      final h = Harness();
      h.transport.onError(
        'POST',
        '/auth/login',
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'Credenciais inválidas.',
      );
      await h.pump(tester, const LoginScreen());
      await preencher(tester);
      await entrar(tester);

      // Nenhuma credencial guardada, e nenhuma chamada autenticada tentada.
      expect(h.store.token, isNull);
      expect(h.transport.countOf('GET', '/me'), 0);
    });
  });

  group('a fase da sessão não derruba a tela de login', () {
    test('um login recusado NUNCA passa por bootstrapping', () async {
      /*
        ESTE é o defeito que o piloto em aparelho real encontrou.

        `login()` começava indo para `bootstrapping`, que é uma PORTA de
        navegação: o `redirect` trocava `/login` por `/splash`, e a volta para
        `unauthenticated` construía um `LoginScreen` NOVO. A mensagem de erro e
        o e-mail digitado moravam no estado do widget antigo, que já tinha sido
        descartado — a tela voltava limpa e muda.
      */
      final h = Harness();
      h.transport.onError(
        'POST',
        '/auth/login',
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'Credenciais inválidas.',
      );

      final container = ProviderContainer(overrides: h.overrides);
      addTearDown(container.dispose);

      /*
        O ponto de partida importa: o app JÁ abriu.

        bootstrap() sem token guardado leva a unauthenticated, que é o estado
        real de quem está olhando a tela de login. Medir a partir do estado
        inicial do controlador — que já é bootstrapping — esconderia a
        regressão inteira: reentrar num estado onde já se está não emite
        notificação nenhuma, e o teste passaria sabotado. Foi o que a prova de
        reversão pegou.
      */
      await container.read(sessionControllerProvider.notifier).bootstrap();
      expect(
        container.read(sessionControllerProvider).phase,
        SessionPhase.unauthenticated,
      );

      final fases = <SessionPhase>[];
      container.listen<SessionPhase>(
        sessionControllerProvider.select((s) => s.phase),
        (_, next) => fases.add(next),
      );

      await expectLater(
        container
            .read(sessionControllerProvider.notifier)
            .login(email: 'a@b.test', password: 'errada'),
        throwsA(isA<FieldException>()),
      );

      // Nenhuma passagem por bootstrapping: a tela de login não é desmontada.
      expect(fases, isNot(contains(SessionPhase.bootstrapping)));
      expect(
        container.read(sessionControllerProvider).phase,
        SessionPhase.unauthenticated,
      );
    });

    testWidgets('a sessão expirada explica por que o login voltou', (
      tester,
    ) async {
      final h = Harness();
      await h.pump(tester, const LoginScreen());

      // O token venceu enquanto o app estava em segundo plano. Antes, esta
      // frase era montada pelo controlador e não aparecia em lugar nenhum.
      final container = ProviderScope.containerOf(
        tester.element(find.byType(LoginScreen)),
      );
      container.read(sessionSignalProvider).sessionEnded();
      await tester.pumpAndSettle();

      expect(find.text('Sua sessão expirou. Entre novamente.'), findsOneWidget);
    });
  });

  testWidgets('aparelho revogado não vira mensagem de credencial', (
    tester,
  ) async {
    final h = Harness();
    h.transport.onError(
      'POST',
      '/auth/login',
      status: 403,
      code: 'DEVICE_REVOKED',
      message: 'Este aparelho foi revogado.',
    );
    await h.pump(tester, const LoginScreen());

    await preencher(tester);
    await entrar(tester);

    // Revogação tem tela própria; o login não a trata como senha errada.
    expect(find.byKey(const Key('login-error')), findsNothing);
  });

  testWidgets('tela de revogado explica e não pede senha de novo', (
    tester,
  ) async {
    await Harness().pump(tester, const RevokedScreen());

    expect(find.text('Dispositivo revogado'), findsOneWidget);
    expect(find.textContaining('administrador'), findsOneWidget);
    // Nada de campo de senha: insistir nunca vai funcionar com esta instalação.
    expect(find.byType(TextFormField), findsNothing);
  });
}
