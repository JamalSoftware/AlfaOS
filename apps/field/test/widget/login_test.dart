import 'package:alfaos_field/features/auth/ui/login_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

void main() {
  Future<void> preencher(WidgetTester tester) async {
    await tester.enterText(find.byKey(const Key('login-email')), 'a@b.test');
    await tester.enterText(find.byKey(const Key('login-password')), 'segredo');
  }

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

  testWidgets('credencial inválida mostra a mensagem do servidor', (
    tester,
  ) async {
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
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('login-error')), findsOneWidget);
    /*
      A frase é a MESMA do servidor para conta inexistente, senha errada,
      usuário inativo e perfil sem acesso. O app não acrescenta detalhe: fazê-lo
      entregaria, a quem baixasse o aplicativo, uma forma de descobrir quem
      trabalha na empresa.
    */
    expect(find.text('Credenciais inválidas.'), findsOneWidget);
  });

  testWidgets('sem rede mostra estado de conexão, não erro de credencial', (
    tester,
  ) async {
    final h = Harness();
    h.transport.offline = true;
    await h.pump(tester, const LoginScreen());

    await preencher(tester);
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pumpAndSettle();

    expect(find.textContaining('conexão'), findsOneWidget);
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
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pumpAndSettle();

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
