import 'package:url_launcher/url_launcher.dart';

import '../logging/log.dart';

/// Aberturas para fora do aplicativo: discador, Google Maps e Waze.
///
/// **Tudo é montado com `Uri`, nunca por concatenação de string.** Endereço de
/// cliente tem vírgula, espaço, acento e `&`; concatenar produziria uma URL
/// quebrada — e, no pior caso, um parâmetro extra colado no destino.
///
/// O AlfaOS **não** faz geocodificação própria: se a coordenada existe, ela é o
/// destino; se não, o endereço textual vai como busca e quem resolve é o app de
/// mapas, que faz isso melhor.
class ExternalLinks {
  const ExternalLinks._();

  /// Discador — nunca a chamada direta.
  ///
  /// `tel:` abre o discador com o número preenchido e deixa a decisão de ligar
  /// com a pessoa. Discagem automática exigiria permissão de telefone e
  /// tiraria dela o controle de um toque acidental no bolso.
  static Future<bool> dial(String phone) async {
    // Só dígitos e os separadores que o discador entende.
    final sanitized = phone.replaceAll(RegExp(r'[^0-9+*#]'), '');
    if (sanitized.isEmpty) return false;
    return _launch(Uri(scheme: 'tel', path: sanitized));
  }

  /// Google Maps por coordenada.
  static Future<bool> googleMapsByCoordinates(double lat, double lng) {
    return _launch(
      Uri.https('www.google.com', '/maps/search/', {
        'api': '1',
        'query': '$lat,$lng',
      }),
    );
  }

  /// Google Maps por endereço, quando não há coordenada utilizável.
  static Future<bool> googleMapsByAddress(String address) {
    return _launch(
      Uri.https('www.google.com', '/maps/search/', {
        'api': '1',
        'query': address,
      }),
    );
  }

  /// Waze por coordenada. `navigate=yes` já entra no modo de rota.
  static Future<bool> wazeByCoordinates(double lat, double lng) {
    return _launch(
      Uri.https('waze.com', '/ul', {'ll': '$lat,$lng', 'navigate': 'yes'}),
    );
  }

  static Future<bool> wazeByAddress(String address) {
    return _launch(Uri.https('waze.com', '/ul', {'q': address}));
  }

  /// Abre em aplicativo externo, e devolve se conseguiu.
  ///
  /// Não lança: um aparelho sem Waze é situação normal, e a tela precisa poder
  /// dizer "não foi possível abrir" em vez de quebrar.
  static Future<bool> _launch(Uri uri) async {
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (error) {
      // O log guarda o ESQUEMA, não a URL: a URL carrega o endereço do cliente.
      Log.error('falha ao abrir ${uri.scheme}', error: error);
      return false;
    }
  }
}
