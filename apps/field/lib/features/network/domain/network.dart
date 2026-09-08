/// # A rede de distribuição vista do aparelho
///
/// Projeção do que `GET /api/field/v1/service-orders/:id/network*` devolve.
/// Nada aqui decide regra: ocupação, faixa de capacidade, ofertabilidade e CTO
/// inativa são do servidor, dentro da transação que escreve. O aplicativo
/// **recebe** e apresenta.
///
/// É por isso que `availableForConnection` chega pronto e não é recalculado:
/// copiar `isPortOfferable` para o Dart criaria uma segunda autoridade, e a
/// segunda a divergir seria a que ninguém revisou.
library;

import 'package:flutter/foundation.dart';

/// Estado administrativo da porta — a dimensão que o operador controla.
///
/// **Não é ocupação.** As duas são independentes: uma porta pode estar
/// `damaged` e ocupada ao mesmo tempo, e é exatamente esse o caso que o
/// aplicativo não pode esconder.
enum PortAdministrativeState {
  available,
  reserved,
  damaged,

  /// Estado que este APK não conhece. O aplicativo mostra o rótulo neutro e
  /// não oferece a porta, em vez de estourar num aparelho em campo.
  unknown;

  static PortAdministrativeState from(String? raw) => switch (raw) {
    'AVAILABLE' => PortAdministrativeState.available,
    'RESERVED' => PortAdministrativeState.reserved,
    'DAMAGED' => PortAdministrativeState.damaged,
    _ => PortAdministrativeState.unknown,
  };

  String get label => switch (this) {
    PortAdministrativeState.available => 'Livre',
    PortAdministrativeState.reserved => 'Reservada',
    PortAdministrativeState.damaged => 'Danificada',
    PortAdministrativeState.unknown => 'Estado desconhecido',
  };

  /// `available` é o estado normal e não merece selo: destacá-lo faria o
  /// alerta de `damaged` competir com ruído. `unknown` merece, porque é um
  /// aviso de que este APK está atrás do servidor.
  bool get deservesBadge => this != PortAdministrativeState.available;
}

@immutable
class NetworkCto {
  const NetworkCto({
    required this.id,
    required this.name,
    required this.code,
    required this.active,
  });

  final String id;
  final String name;
  final String? code;
  final bool active;

  factory NetworkCto.fromJson(Map<String, dynamic> json) => NetworkCto(
    id: json['id'] as String,
    name: json['name'] as String? ?? '',
    code: json['code'] as String?,
    active: json['active'] as bool? ?? true,
  );
}

@immutable
class NetworkPort {
  const NetworkPort({
    required this.id,
    required this.number,
    required this.administrativeState,
    required this.occupied,
    required this.availableForConnection,
  });

  final String id;
  final int number;
  final PortAdministrativeState administrativeState;

  /// Recebido do servidor. **Não é autoridade local** — nenhuma decisão de
  /// escrita sai daqui; a transação do domínio revalida tudo.
  final bool occupied;

  /// Consultivo, e o servidor já o calculou. A UI o usa para não oferecer o
  /// que seria recusado; a recusa de verdade continua sendo o `409`.
  final bool availableForConnection;

  factory NetworkPort.fromJson(Map<String, dynamic> json) => NetworkPort(
    id: json['id'] as String,
    number: (json['number'] as num?)?.toInt() ?? 0,
    administrativeState: PortAdministrativeState.from(
      json['administrativeState'] as String?,
    ),
    occupied: json['occupied'] as bool? ?? false,
    availableForConnection: json['availableForConnection'] as bool? ?? false,
  );

  /// `01`, `02`, `16`. O técnico lê o número na etiqueta da caixa, nunca um id.
  String get label => number.toString().padLeft(2, '0');
}

/// Onde o cliente da OS está agora.
@immutable
class NetworkPlacement {
  const NetworkPlacement({
    required this.connectionId,
    required this.cto,
    required this.port,
    required this.connectedAt,
  });

  final String connectionId;
  final NetworkCto cto;
  final NetworkPort port;
  final DateTime? connectedAt;

  factory NetworkPlacement.fromJson(Map<String, dynamic> json) =>
      NetworkPlacement(
        connectionId: json['connectionId'] as String,
        cto: NetworkCto.fromJson(Map<String, dynamic>.from(json['cto'] as Map)),
        port: NetworkPort.fromJson(
          Map<String, dynamic>.from(json['port'] as Map),
        ),
        connectedAt: _date(json['connectedAt']),
      );
}

/// Uma caixa candidata na lista de escolha.
@immutable
class CandidateCto {
  const CandidateCto({
    required this.id,
    required this.name,
    required this.code,
    required this.active,
    required this.capacity,
    required this.availablePorts,
  });

  final String id;
  final String name;
  final String? code;
  final bool active;
  final int capacity;
  final int availablePorts;

  factory CandidateCto.fromJson(Map<String, dynamic> json) => CandidateCto(
    id: json['id'] as String,
    name: json['name'] as String? ?? '',
    code: json['code'] as String?,
    active: json['active'] as bool? ?? true,
    capacity: (json['capacity'] as num?)?.toInt() ?? 0,
    availablePorts: (json['availablePorts'] as num?)?.toInt() ?? 0,
  );
}

/// A caixa aberta, com as posições dentro da capacidade.
@immutable
class CandidateCtoDetail {
  const CandidateCtoDetail({
    required this.id,
    required this.name,
    required this.code,
    required this.active,
    required this.capacity,
    required this.availablePorts,
    required this.ports,
  });

  final String id;
  final String name;
  final String? code;
  final bool active;
  final int capacity;
  final int availablePorts;
  final List<NetworkPort> ports;

  factory CandidateCtoDetail.fromJson(Map<String, dynamic> json) =>
      CandidateCtoDetail(
        id: json['id'] as String,
        name: json['name'] as String? ?? '',
        code: json['code'] as String?,
        active: json['active'] as bool? ?? true,
        capacity: (json['capacity'] as num?)?.toInt() ?? 0,
        availablePorts: (json['availablePorts'] as num?)?.toInt() ?? 0,
        ports: (json['ports'] as List? ?? const [])
            .whereType<Map>()
            .map((e) => NetworkPort.fromJson(Map<String, dynamic>.from(e)))
            .toList(growable: false),
      );

  /// As posições que o servidor considera ofertáveis agora.
  List<NetworkPort> get offerable =>
      ports.where((p) => p.availableForConnection).toList(growable: false);
}

/// O que a mutação devolveu — o vínculo vigente e o que ela encerrou.
///
/// Vem da própria resposta, nunca de uma releitura depois do commit: reler
/// repetiria o `START-01` da v0.9, em que a operação dava certo e o aparelho
/// recebia um erro.
@immutable
class NetworkMutationResult {
  const NetworkMutationResult({this.connection, this.previous});

  final NetworkConnectionRef? connection;
  final NetworkConnectionRef? previous;

  factory NetworkMutationResult.fromJson(Map<String, dynamic> json) =>
      NetworkMutationResult(
        connection: NetworkConnectionRef.tryParse(json['connection']),
        previous: NetworkConnectionRef.tryParse(json['previous']),
      );
}

@immutable
class NetworkConnectionRef {
  const NetworkConnectionRef({
    required this.connectionId,
    required this.ctoId,
    required this.ctoPortId,
    required this.portNumber,
  });

  final String connectionId;
  final String ctoId;
  final String ctoPortId;
  final int portNumber;

  static NetworkConnectionRef? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final json = Map<String, dynamic>.from(raw);
    final id = json['connectionId'];
    if (id is! String) return null;
    return NetworkConnectionRef(
      connectionId: id,
      ctoId: json['ctoId'] as String? ?? '',
      ctoPortId: json['ctoPortId'] as String? ?? '',
      portNumber: (json['portNumber'] as num?)?.toInt() ?? 0,
    );
  }

  String get portLabel => portNumber.toString().padLeft(2, '0');
}

DateTime? _date(Object? raw) {
  if (raw is! String || raw.isEmpty) return null;
  return DateTime.tryParse(raw)?.toLocal();
}
