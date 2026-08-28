/// Modelos da OS, espelhando os DTOs do Field (`src/lib/field/dto.ts`).
///
/// **Nenhum campo fantasma.** O que não está no contrato não está aqui — e é
/// isso que impede a UI de exibir algo que a API nunca prometeu.
///
/// O que o backend deliberadamente NÃO envia, e por isso não existe neste
/// arquivo: CPF, senha, `externalProvider`, `externalId`, `externalNumber`,
/// payload de provider. Uma OS importada do ReceitaNet chega idêntica a uma
/// interna — como o dado do provedor não desce, **não existe `if (RECEITANET)`
/// possível neste aplicativo**.
library;

/// Status operacional, como o servidor o define.
///
/// O aplicativo **traduz para exibir** e não decide transição nenhuma: a
/// máquina de estados vive no domínio do AlfaOS, uma vez só.
enum OrderStatus {
  pending,
  assigned,
  inProgress,
  completed,
  cancelled,

  /// Status que este APK não conhece. Fallback seguro: o app mostra o texto
  /// cru e não oferece ação, em vez de estourar num aparelho em campo.
  unknown;

  static OrderStatus from(String? raw) {
    switch (raw) {
      case 'PENDING':
        return OrderStatus.pending;
      case 'ASSIGNED':
        return OrderStatus.assigned;
      case 'IN_PROGRESS':
        return OrderStatus.inProgress;
      case 'COMPLETED':
        return OrderStatus.completed;
      case 'CANCELLED':
        return OrderStatus.cancelled;
      default:
        return OrderStatus.unknown;
    }
  }

  String get label {
    switch (this) {
      case OrderStatus.pending:
        return 'Pendente';
      case OrderStatus.assigned:
        return 'Atribuída';
      case OrderStatus.inProgress:
        return 'Em atendimento';
      case OrderStatus.completed:
        return 'Concluída';
      case OrderStatus.cancelled:
        return 'Cancelada';
      case OrderStatus.unknown:
        return 'Desconhecido';
    }
  }
}

enum OrderPriority {
  low,
  normal,
  high,
  urgent,
  unknown;

  static OrderPriority from(String? raw) {
    switch (raw) {
      case 'LOW':
        return OrderPriority.low;
      case 'NORMAL':
        return OrderPriority.normal;
      case 'HIGH':
        return OrderPriority.high;
      case 'URGENT':
        return OrderPriority.urgent;
      default:
        return OrderPriority.unknown;
    }
  }

  String get label {
    switch (this) {
      case OrderPriority.low:
        return 'Baixa';
      case OrderPriority.normal:
        return 'Normal';
      case OrderPriority.high:
        return 'Alta';
      case OrderPriority.urgent:
        return 'Urgente';
      case OrderPriority.unknown:
        return '—';
    }
  }

  /// Só o que foge do normal merece destaque na lista. Pintar tudo é o mesmo
  /// que não pintar nada.
  bool get isElevated =>
      this == OrderPriority.high || this == OrderPriority.urgent;
}

DateTime? _parseDate(Object? raw) {
  if (raw is! String || raw.isEmpty) return null;
  return DateTime.tryParse(raw)?.toLocal();
}

double? _parseDouble(Object? raw) {
  if (raw is num) return raw.toDouble();
  if (raw is String) return double.tryParse(raw);
  return null;
}

/// Item da fila. Compacto de propósito — a lista não navega nem liga para
/// ninguém, então não recebe telefone, endereço nem coordenada.
class OrderSummary {
  const OrderSummary({
    required this.id,
    required this.number,
    required this.status,
    required this.priority,
    required this.type,
    required this.subtype,
    required this.customerName,
    required this.district,
    required this.city,
    required this.scheduledAt,
    required this.hasLocation,
    required this.updatedAt,
    required this.version,
  });

  final String id;
  final int number;
  final OrderStatus status;
  final OrderPriority priority;
  final String type;
  final String? subtype;
  final String customerName;
  final String? district;
  final String? city;
  final DateTime? scheduledAt;

  /// Existe coordenada utilizável? Booleano, não a coordenada — a lista só
  /// precisa decidir se mostra o ícone.
  final bool hasLocation;
  final DateTime updatedAt;

  /// Token do compare-and-set. Volta como `expectedVersion` na mutação.
  final int version;

  factory OrderSummary.fromJson(Map<String, dynamic> json) => OrderSummary(
    id: json['id'] as String,
    number: (json['number'] as num).toInt(),
    status: OrderStatus.from(json['status'] as String?),
    priority: OrderPriority.from(json['priority'] as String?),
    type: json['type'] as String? ?? '',
    subtype: json['subtype'] as String?,
    customerName: json['customerName'] as String? ?? '',
    district: json['district'] as String?,
    city: json['city'] as String?,
    scheduledAt: _parseDate(json['scheduledAt']),
    hasLocation: json['hasLocation'] as bool? ?? false,
    updatedAt: _parseDate(json['updatedAt']) ?? DateTime.now(),
    version: (json['version'] as num?)?.toInt() ?? 0,
  );

  /// "Centro · Guaçuí", pulando o que não veio. Nunca "null · null".
  String? get locationLabel {
    final parts = [district, city].where((p) => p != null && p.isNotEmpty);
    return parts.isEmpty ? null : parts.join(' · ');
  }
}

class OrderCustomer {
  const OrderCustomer({
    required this.name,
    required this.phone,
    required this.secondaryPhone,
    required this.address,
    required this.number,
    required this.complement,
    required this.district,
    required this.city,
    required this.state,
    required this.zipCode,
    required this.latitude,
    required this.longitude,
  });

  final String name;
  final String? phone;
  final String? secondaryPhone;
  final String? address;
  final String? number;
  final String? complement;
  final String? district;
  final String? city;
  final String? state;
  final String? zipCode;
  final double? latitude;
  final double? longitude;

  factory OrderCustomer.fromJson(Map<String, dynamic> json) => OrderCustomer(
    name: json['name'] as String? ?? '',
    phone: json['phone'] as String?,
    secondaryPhone: json['secondaryPhone'] as String?,
    address: json['address'] as String?,
    number: json['number'] as String?,
    complement: json['complement'] as String?,
    district: json['district'] as String?,
    city: json['city'] as String?,
    state: json['state'] as String?,
    zipCode: json['zipCode'] as String?,
    latitude: _parseDouble(json['latitude']),
    longitude: _parseDouble(json['longitude']),
  );

  List<String> get phones => [
    phone,
    secondaryPhone,
  ].whereType<String>().where((p) => p.isNotEmpty).toList();

  /// Endereço em uma linha, montado só com o que existe.
  ///
  /// A concatenação ingênua produz "Rua X, null - null/null" quando o cadastro
  /// está incompleto, que é o caso comum. Cada pedaço só entra se veio.
  String? get formattedAddress {
    final street = [
      if (address != null && address!.isNotEmpty) address,
      if (number != null && number!.isNotEmpty) number,
    ].join(', ');

    final region = [
      if (district != null && district!.isNotEmpty) district,
      if (city != null && city!.isNotEmpty) city,
    ].join(' · ');

    final parts = <String>[
      if (street.isNotEmpty) street,
      if (complement != null && complement!.isNotEmpty) complement!,
      if (region.isNotEmpty) region,
      if (state != null && state!.isNotEmpty) state!,
    ];
    return parts.isEmpty ? null : parts.join(' — ');
  }

  /// Coordenada utilizável para navegação.
  ///
  /// `(0, 0)` é rejeitado: fica no Atlântico e é o que um cadastro devolve
  /// quando o campo nunca foi preenchido. Mandar um técnico para lá é pior que
  /// não oferecer navegação. Mesma regra do `coordenadaValida` da web.
  bool get hasUsableCoordinates {
    final lat = latitude;
    final lng = longitude;
    if (lat == null || lng == null) return false;
    if (!lat.isFinite || !lng.isFinite) return false;
    if (lat.abs() > 90 || lng.abs() > 180) return false;
    if (lat == 0 && lng == 0) return false;
    return true;
  }
}

/// Credencial de acesso do cliente — **metadado, nunca o segredo**.
class OrderConnection {
  const OrderConnection({
    required this.id,
    required this.type,
    required this.username,
    required this.passwordConfigured,
  });

  final String id;
  final String type;
  final String username;

  /// Existe senha gravada. **Nunca a senha**, nem um fragmento: o texto claro
  /// sai apenas pela revelação explícita e auditada.
  final bool passwordConfigured;

  factory OrderConnection.fromJson(Map<String, dynamic> json) =>
      OrderConnection(
        id: json['id'] as String,
        type: json['type'] as String? ?? 'PPPOE',
        username: json['username'] as String? ?? '',
        passwordConfigured: json['passwordConfigured'] as bool? ?? false,
      );
}

class OrderExecution {
  const OrderExecution({
    required this.id,
    required this.diagnosis,
    required this.workPerformed,
    required this.notes,
    required this.version,
  });

  final String id;
  final String? diagnosis;
  final String? workPerformed;
  final String? notes;

  /// Lock PRÓPRIO da execução, separado do lock da OS.
  final int version;

  factory OrderExecution.fromJson(Map<String, dynamic> json) => OrderExecution(
    id: json['id'] as String,
    diagnosis: json['diagnosis'] as String?,
    workPerformed: json['workPerformed'] as String?,
    notes: json['notes'] as String?,
    version: (json['version'] as num?)?.toInt() ?? 0,
  );
}

/// Conectividade do cliente conforme o provedor.
///
/// `UNKNOWN` é resposta de primeira classe, não código de falha: "não
/// conseguimos falar com o ERP" e "o ERP diz que está fora" são fatos
/// diferentes, e colapsar o primeiro em OFFLINE mandaria um técnico ao
/// endereço por causa de uma integração instável.
class OrderDiagnostic {
  const OrderDiagnostic({
    required this.connectivityStatus,
    required this.observedAt,
  });

  final String connectivityStatus;
  final DateTime? observedAt;

  factory OrderDiagnostic.fromJson(Map<String, dynamic> json) =>
      OrderDiagnostic(
        connectivityStatus: json['connectivityStatus'] as String? ?? 'UNKNOWN',
        observedAt: _parseDate(json['observedAt']),
      );

  String get label {
    switch (connectivityStatus) {
      case 'ONLINE':
        return 'Online';
      case 'OFFLINE':
        return 'Offline';
      default:
        return 'Desconhecido';
    }
  }

  bool get isOnline => connectivityStatus == 'ONLINE';
  bool get isOffline => connectivityStatus == 'OFFLINE';
}

class OrderDetail {
  const OrderDetail({
    required this.id,
    required this.number,
    required this.status,
    required this.priority,
    required this.type,
    required this.subtype,
    required this.description,
    required this.scheduledAt,
    required this.assignedAt,
    required this.startedAt,
    required this.updatedAt,
    required this.version,
    required this.customer,
    required this.connection,
    required this.execution,
    required this.diagnostic,
  });

  final String id;
  final int number;
  final OrderStatus status;
  final OrderPriority priority;
  final String type;
  final String? subtype;
  final String description;
  final DateTime? scheduledAt;
  final DateTime? assignedAt;
  final DateTime? startedAt;
  final DateTime updatedAt;
  final int version;
  final OrderCustomer customer;
  final OrderConnection? connection;
  final OrderExecution? execution;
  final OrderDiagnostic? diagnostic;

  factory OrderDetail.fromJson(Map<String, dynamic> json) => OrderDetail(
    id: json['id'] as String,
    number: (json['number'] as num).toInt(),
    status: OrderStatus.from(json['status'] as String?),
    priority: OrderPriority.from(json['priority'] as String?),
    type: json['type'] as String? ?? '',
    subtype: json['subtype'] as String?,
    description: json['description'] as String? ?? '',
    scheduledAt: _parseDate(json['scheduledAt']),
    assignedAt: _parseDate(json['assignedAt']),
    startedAt: _parseDate(json['startedAt']),
    updatedAt: _parseDate(json['updatedAt']) ?? DateTime.now(),
    version: (json['version'] as num?)?.toInt() ?? 0,
    customer: OrderCustomer.fromJson(
      Map<String, dynamic>.from(json['customer'] as Map),
    ),
    connection: json['connection'] == null
        ? null
        : OrderConnection.fromJson(
            Map<String, dynamic>.from(json['connection'] as Map),
          ),
    execution: json['execution'] == null
        ? null
        : OrderExecution.fromJson(
            Map<String, dynamic>.from(json['execution'] as Map),
          ),
    diagnostic: json['diagnostic'] == null
        ? null
        : OrderDiagnostic.fromJson(
            Map<String, dynamic>.from(json['diagnostic'] as Map),
          ),
  );

  /// O técnico pode iniciar? Espelha o que o servidor aceita — mas **não
  /// decide**: a autoridade é a máquina de estados do domínio, e o botão só
  /// evita oferecer uma ação que a API recusaria.
  bool get canStart => status == OrderStatus.assigned;

  bool get isInProgress => status == OrderStatus.inProgress;

  /// Resultado de um `start`: o servidor devolve o estado da própria mutação.
  OrderDetail withStartResult({
    required OrderStatus status,
    required DateTime? startedAt,
    required DateTime updatedAt,
    required int version,
    required OrderExecution? execution,
  }) => OrderDetail(
    id: id,
    number: number,
    status: status,
    priority: priority,
    type: type,
    subtype: subtype,
    description: description,
    scheduledAt: scheduledAt,
    assignedAt: assignedAt,
    startedAt: startedAt,
    updatedAt: updatedAt,
    version: version,
    customer: customer,
    connection: connection,
    execution: execution ?? this.execution,
    diagnostic: diagnostic,
  );

  OrderDetail withDiagnostic(OrderDiagnostic? next) => OrderDetail(
    id: id,
    number: number,
    status: status,
    priority: priority,
    type: type,
    subtype: subtype,
    description: description,
    scheduledAt: scheduledAt,
    assignedAt: assignedAt,
    startedAt: startedAt,
    updatedAt: updatedAt,
    version: version,
    customer: customer,
    connection: connection,
    execution: execution,
    diagnostic: next ?? diagnostic,
  );
}

/// Página da fila, com o cursor da próxima.
class OrderPage {
  const OrderPage({required this.items, required this.nextCursor});

  final List<OrderSummary> items;
  final String? nextCursor;

  factory OrderPage.fromJson(Map<String, dynamic> json) => OrderPage(
    items: (json['items'] as List<dynamic>? ?? [])
        .map((e) => OrderSummary.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList(),
    nextCursor: json['nextCursor'] as String?,
  );
}
