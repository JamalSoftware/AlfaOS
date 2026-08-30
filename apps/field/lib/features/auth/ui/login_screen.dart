import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/errors/field_error.dart';
import '../state/session_controller.dart';

/// A frase que a pessoa lê quando o login falha.
///
/// ## Por que o APP decide o texto, e não o servidor
///
/// Em toda recusa por credencial o backend já devolve uma frase única — conta
/// inexistente, senha errada, usuário inativo, perfil sem acesso e técnico
/// inativo saem iguais, com o mesmo código e o mesmo custo de bcrypt. Repetir
/// a decisão aqui não é desconfiança do servidor: é fechar a porta pelos dois
/// lados. No dia em que alguém 'melhorar' a mensagem do backend para ajudar o
/// suporte, o aplicativo continua sem entregar a diferença — e a diferença é
/// o que permitiria descobrir quem trabalha na empresa testando e-mails.
///
/// ## E por que ela não é uma frase só
///
/// 'Usuário ou senha inválidos' diante de um servidor fora do ar faria o
/// técnico digitar a senha certa cinco vezes e concluir que perdeu o acesso —
/// até o bloqueio por tentativas, que é o pior desfecho possível para um
/// problema de rede. O que não pode vazar é QUAL PARTE da credencial estava
/// errada; se o problema foi credencial ou conexão, pode e deve ser dito.
///
/// Nada técnico atravessa: sem status, sem endpoint, sem exceção, sem corpo
/// de resposta.
String loginErrorMessage(FieldException error) {
  switch (error.code) {
    case FieldErrorCode.unauthenticated:
    case FieldErrorCode.forbidden:
    case FieldErrorCode.notFound:
      return 'Usuário ou senha inválidos.';

    // network cobre ausência de rede e timeout, e as duas frases são do
    // próprio app (FieldException.network e .timeout) — nunca do servidor,
    // que por definição não respondeu.
    case FieldErrorCode.network:
      return error.message;

    // O servidor respondeu, e respondeu que falhou. Para quem está na porta o
    // desfecho é o mesmo de não alcançá-lo.
    case FieldErrorCode.internal:
    case FieldErrorCode.upstreamUnavailable:
      return 'Não foi possível conectar ao AlfaOS. Tente de novo em instantes.';

    // Quantas tentativas restam é informação sobre o RITMO, não sobre a conta:
    // vale mostrar, porque sem ela a pessoa insiste e piora o bloqueio.
    case FieldErrorCode.rateLimited:
      return error.message;

    // Recusa do formato antes de qualquer consulta — 'E-mail inválido.' não
    // afirma nada sobre existir ou não uma conta.
    case FieldErrorCode.validationError:
      return error.message;

    case FieldErrorCode.deviceRevoked:
    case FieldErrorCode.conflict:
    case FieldErrorCode.idempotencyConflict:
    case FieldErrorCode.labelExpired:
    case FieldErrorCode.unknown:
      return 'Não foi possível entrar. Tente de novo.';
  }
}

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();

  bool _obscure = true;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;

    FocusScope.of(context).unfocus();
    setState(() {
      _submitting = true;
      _error = null;
    });

    try {
      await ref
          .read(sessionControllerProvider.notifier)
          .login(
            email: _emailController.text,
            password: _passwordController.text,
          );
    } on FieldException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.code == FieldErrorCode.deviceRevoked
            ? null // Vira tela própria; a rota reage ao estado.
            : loginErrorMessage(error);
      });
    } finally {
      /*
        O botão SEMPRE volta, e a senha SEMPRE some.

        Reabilitar é o que permite a segunda tentativa — sem isso a tela
        fica com o indicador girando para sempre depois de um erro. Limpar
        a senha, e só ela, é a outra metade: o e-mail continua digitado
        porque redigitá-lo é atrito puro, enquanto uma senha errada deixada
        no campo convida a reenviar exatamente a mesma coisa.
      */
      if (mounted) {
        setState(() {
          _submitting = false;
          if (_error != null) _passwordController.clear();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    /*
      A mensagem do CONTROLADOR também é exibida.

      É por ela que chega 'sua sessão expirou': o token venceu enquanto o
      aplicativo estava fechado, e a pessoa reabre já na tela de login. Sem
      isto, essa frase era montada e nunca aparecia em lugar nenhum — a tela
      voltava muda, e o técnico não tinha como saber por que precisava
      entrar de novo.

      O erro local vem primeiro: ele é a resposta à tentativa que a pessoa
      acabou de fazer.
    */
    final mensagemDaSessao = ref.watch(
      sessionControllerProvider.select(
        (s) => s.phase == SessionPhase.unauthenticated ? s.message : null,
      ),
    );
    final erro = _error ?? mensagemDaSessao;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AlfaSpacing.xl),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(
                      Icons.handyman_outlined,
                      size: 56,
                      color: theme.colorScheme.primary,
                    ),
                    const SizedBox(height: AlfaSpacing.lg),
                    Text(
                      'AlfaOS Field',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: AlfaSpacing.xs),
                    Text(
                      'Aplicativo do técnico',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: AlfaSpacing.xxl),
                    TextFormField(
                      key: const Key('login-email'),
                      controller: _emailController,
                      keyboardType: TextInputType.emailAddress,
                      autocorrect: false,
                      textInputAction: TextInputAction.next,
                      enabled: !_submitting,
                      decoration: const InputDecoration(
                        labelText: 'E-mail',
                        prefixIcon: Icon(Icons.alternate_email),
                      ),
                      validator: (value) =>
                          (value == null || value.trim().isEmpty)
                          ? 'Informe seu e-mail.'
                          : null,
                    ),
                    const SizedBox(height: AlfaSpacing.lg),
                    TextFormField(
                      key: const Key('login-password'),
                      controller: _passwordController,
                      obscureText: _obscure,
                      enabled: !_submitting,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _submit(),
                      decoration: InputDecoration(
                        labelText: 'Senha',
                        prefixIcon: const Icon(Icons.lock_outline),
                        suffixIcon: IconButton(
                          key: const Key('login-toggle-password'),
                          onPressed: () => setState(() => _obscure = !_obscure),
                          icon: Icon(
                            _obscure
                                ? Icons.visibility_outlined
                                : Icons.visibility_off_outlined,
                          ),
                          tooltip: _obscure ? 'Mostrar senha' : 'Ocultar senha',
                        ),
                      ),
                      validator: (value) => (value == null || value.isEmpty)
                          ? 'Informe sua senha.'
                          : null,
                    ),
                    if (erro != null) ...[
                      const SizedBox(height: AlfaSpacing.lg),
                      _ErrorBanner(message: erro),
                    ],
                    const SizedBox(height: AlfaSpacing.xl),
                    FilledButton(
                      key: const Key('login-submit'),
                      onPressed: _submitting ? null : _submit,
                      child: _submitting
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('ENTRAR'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final colors = context.statusColors;
    return Container(
      key: const Key('login-error'),
      padding: const EdgeInsets.all(AlfaSpacing.md),
      decoration: BoxDecoration(
        color: colors.dangerContainer,
        borderRadius: BorderRadius.circular(AlfaRadius.md),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: colors.danger, size: 20),
          const SizedBox(width: AlfaSpacing.sm),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: colors.danger, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}

/// Aparelho revogado.
///
/// Tela própria, e não uma mensagem no login, porque a saída é diferente:
/// tentar de novo com esta instalação **nunca** vai funcionar. Mandar a pessoa
/// digitar a senha de novo seria cruel e inútil.
class RevokedScreen extends ConsumerWidget {
  const RevokedScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = context.statusColors;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(AlfaSpacing.xxl),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.phonelink_erase_outlined,
                  size: 56,
                  color: colors.danger,
                ),
                const SizedBox(height: AlfaSpacing.lg),
                Text(
                  'Dispositivo revogado',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleLarge,
                ),
                const SizedBox(height: AlfaSpacing.md),
                Text(
                  'Este aparelho foi revogado. Entre em contato com o '
                  'administrador da empresa.',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: AlfaSpacing.xxl),
                OutlinedButton(
                  key: const Key('revoked-back'),
                  onPressed: () => ref
                      .read(sessionControllerProvider.notifier)
                      .dismissRevoked(),
                  child: const Text('Voltar ao início'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Abertura: lendo o token guardado.
class BootstrapScreen extends StatelessWidget {
  const BootstrapScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: Center(child: CircularProgressIndicator()));
  }
}

/// Há credencial, mas a rede falhou ao validá-la.
///
/// **Não desloga.** Internet caindo não é motivo para apagar a sessão de
/// alguém; quem for revogado de verdade recebe 401 e cai no login.
class OfflineBootstrapScreen extends ConsumerWidget {
  const OfflineBootstrapScreen({super.key, this.message});

  final String? message;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      body: SafeArea(
        child: ErrorViewScaffold(
          message: message ?? 'Não foi possível conectar ao AlfaOS.',
          onRetry: () =>
              ref.read(sessionControllerProvider.notifier).retryBootstrap(),
        ),
      ),
    );
  }
}

class ErrorViewScaffold extends StatelessWidget {
  const ErrorViewScaffold({
    super.key,
    required this.message,
    required this.onRetry,
  });

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AlfaSpacing.xxl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.wifi_off_outlined,
              size: 48,
              color: theme.colorScheme.outline,
            ),
            const SizedBox(height: AlfaSpacing.lg),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: AlfaSpacing.xl),
            OutlinedButton(
              onPressed: onRetry,
              child: const Text('Tentar novamente'),
            ),
          ],
        ),
      ),
    );
  }
}
