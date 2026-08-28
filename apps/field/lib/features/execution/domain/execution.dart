/// Modelos da execução em campo (v0.10).
///
/// Espelham o pacote que `GET /service-orders/:id/execution` devolve. Duas
/// regras governam tudo aqui, e as duas vêm do backend ser a autoridade:
///
/// 1. **O aplicativo não decide nada.** Pendência, saldo, obrigatoriedade e
///    conclusão são calculados no servidor. O que chega aqui orienta a tela;
///    reimplementar a regra produziria uma segunda verdade, e a que divergisse
///    seria a que ninguém revisou.
/// 2. **Só entra o que a tela usa.** Sem CPF, sem provider, sem interno de
///    auditoria — a ausência é o que impede um `if (RECEITANET)` no aplicativo.
library;

/// Como a tela deve tratar a localização do cliente.
enum LocationStatus {
  /// Alguém esteve lá e confirmou.
  confirmed,

  /// Existe um ponto, mas ninguém conferiu. Pode estar longe da porta.
  unconfirmed,

  /// Não há coordenada nenhuma.
  missing;

  static LocationStatus from(String? raw) => switch (raw) {
    'CONFIRMED' => LocationStatus.confirmed,
    'UNCONFIRMED' => LocationStatus.unconfirmed,
    _ => LocationStatus.missing,
  };

  String get label => switch (this) {
    LocationStatus.confirmed => 'Confirmada',
    LocationStatus.unconfirmed => 'Não confirmada',
    LocationStatus.missing => 'Sem localização',
  };
}

class ExecutionLocation {
  const ExecutionLocation({
    required this.status,
    this.latitude,
    this.longitude,
    this.accuracyMeters,
    this.source,
    this.verified = false,
    this.reference,
    this.version,
  });

  final LocationStatus status;
  final double? latitude;
  final double? longitude;
  final int? accuracyMeters;
  final String? source;
  final bool verified;
  final String? reference;

  /// Token do compare-and-set da LOCALIZAÇÃO — não o da OS.
  ///
  /// `null` significa "este cliente não tem ponto", e é o valor que a correção
  /// envia para criar. São locks diferentes de propósito: um despachante
  /// mexendo na OS não pode invalidar a confirmação que o técnico está
  /// mandando.
  final int? version;

  bool get hasCoordinate => latitude != null && longitude != null;

  factory ExecutionLocation.fromJson(Map<String, dynamic> json) {
    return ExecutionLocation(
      status: LocationStatus.from(json['status'] as String?),
      latitude: (json['latitude'] as num?)?.toDouble(),
      longitude: (json['longitude'] as num?)?.toDouble(),
      accuracyMeters: (json['accuracyMeters'] as num?)?.toInt(),
      source: json['source'] as String?,
      verified: json['verified'] as bool? ?? false,
      reference: json['reference'] as String?,
      version: (json['version'] as num?)?.toInt(),
    );
  }
}

class ExecutionCheckIn {
  const ExecutionCheckIn({
    required this.id,
    required this.checkedInAt,
    this.distanceMeters,
    this.hasCoordinate = false,
  });

  final String id;
  final DateTime checkedInAt;

  /// Distância até o ponto cadastrado, calculada NO SERVIDOR. Informação, nunca
  /// bloqueio — GPS de celular erra dezenas de metros e falha dentro de prédio.
  final int? distanceMeters;
  final bool hasCoordinate;

  factory ExecutionCheckIn.fromJson(Map<String, dynamic> json) {
    return ExecutionCheckIn(
      id: json['id'] as String,
      checkedInAt:
          DateTime.tryParse(json['checkedInAt'] as String? ?? '')?.toLocal() ??
          DateTime.now(),
      distanceMeters: (json['distanceMeters'] as num?)?.toInt(),
      hasCoordinate: json['hasCoordinate'] as bool? ?? false,
    );
  }
}

enum ChecklistItemType {
  boolean,
  text,
  number,
  select,
  photo;

  static ChecklistItemType from(String? raw) => switch (raw) {
    'BOOLEAN' => ChecklistItemType.boolean,
    'TEXT' => ChecklistItemType.text,
    'NUMBER' => ChecklistItemType.number,
    'SELECT' => ChecklistItemType.select,
    _ => ChecklistItemType.photo,
  };
}

class ChecklistItem {
  const ChecklistItem({
    required this.id,
    required this.label,
    required this.type,
    required this.required,
    this.description,
    this.options = const [],
    this.evidenceCategory,
    this.valueBoolean,
    this.valueText,
    this.valueNumber,
    this.answeredAt,
  });

  final String id;
  final String label;
  final String? description;
  final ChecklistItemType type;
  final bool required;
  final List<String> options;

  /// Só para `photo`: qual categoria de evidência satisfaz este item. A foto é
  /// a resposta — não existe "marcar que tirei".
  final String? evidenceCategory;

  final bool? valueBoolean;
  final String? valueText;
  final String? valueNumber;
  final DateTime? answeredAt;

  bool get answered => answeredAt != null;

  factory ChecklistItem.fromJson(Map<String, dynamic> json) {
    final rawOptions = json['options'];
    return ChecklistItem(
      id: json['id'] as String,
      label: json['label'] as String? ?? '',
      description: json['description'] as String?,
      type: ChecklistItemType.from(json['type'] as String?),
      required: json['required'] as bool? ?? false,
      options: rawOptions is List
          ? rawOptions.map((o) => o.toString()).toList(growable: false)
          : const [],
      evidenceCategory: json['evidenceCategory'] as String?,
      valueBoolean: json['valueBoolean'] as bool?,
      valueText: json['valueText'] as String?,
      valueNumber: json['valueNumber']?.toString(),
      answeredAt: json['answeredAt'] is String
          ? DateTime.tryParse(json['answeredAt'] as String)?.toLocal()
          : null,
    );
  }
}

/// Categorias de evidência, na ordem em que a tela as oferece.
///
/// A lista é fechada e espelha o enum do servidor. Um valor que o servidor não
/// conheça é recusado na rota — então o app não inventa categoria.
class EvidenceCategories {
  const EvidenceCategories._();

  static const all = <String, String>{
    'BEFORE_SERVICE': 'Antes do serviço',
    'INSTALLATION_LOCATION': 'Local da instalação',
    'CABLE_ROUTE': 'Passagem de cabo',
    'CTO': 'CTO',
    'ONU_ONT': 'ONU / ONT',
    'ROUTER': 'Roteador',
    'EQUIPMENT': 'Equipamento',
    'OPTICAL_READING': 'Leitura óptica',
    'WIFI_TEST': 'Teste de Wi-Fi',
    'SPEED_TEST': 'Teste de velocidade',
    'AFTER_SERVICE': 'Depois do serviço',
    'OTHER': 'Outra',
  };

  static String label(String? code) => all[code] ?? 'Outra';
}

class ExecutionEvidence {
  const ExecutionEvidence({
    required this.id,
    required this.category,
    required this.createdAt,
    this.caption,
  });

  final String id;
  final String category;
  final String? caption;
  final DateTime createdAt;

  factory ExecutionEvidence.fromJson(Map<String, dynamic> json) {
    return ExecutionEvidence(
      id: json['id'] as String,
      category: json['category'] as String? ?? 'OTHER',
      caption: json['caption'] as String?,
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '')?.toLocal() ??
          DateTime.now(),
    );
  }
}

class ExecutionMaterial {
  const ExecutionMaterial({
    required this.id,
    required this.description,
    required this.quantity,
    required this.unit,
    this.fromInventory = false,
  });

  final String id;
  final String description;

  /// String, não `double`: o servidor manda `Decimal` e converter para ponto
  /// flutuante aqui introduziria erro de arredondamento num número que a
  /// operação confere na prateleira.
  final String quantity;
  final String unit;
  final bool fromInventory;

  factory ExecutionMaterial.fromJson(Map<String, dynamic> json) {
    return ExecutionMaterial(
      id: json['id'] as String,
      description: json['description'] as String? ?? '',
      quantity: json['quantity']?.toString() ?? '0',
      unit: json['unit'] as String? ?? 'UNIT',
      fromInventory: json['fromInventory'] as bool? ?? false,
    );
  }
}

class ExecutionEquipment {
  const ExecutionEquipment({
    required this.id,
    required this.equipmentType,
    this.manufacturer,
    this.model,
    this.serial,
    this.macAddress,
  });

  final String id;
  final String equipmentType;
  final String? manufacturer;
  final String? model;
  final String? serial;
  final String? macAddress;

  factory ExecutionEquipment.fromJson(Map<String, dynamic> json) {
    return ExecutionEquipment(
      id: json['id'] as String,
      equipmentType: json['equipmentType'] as String? ?? '',
      manufacturer: json['manufacturer'] as String?,
      model: json['model'] as String?,
      serial: json['serial'] as String?,
      macAddress: json['macAddress'] as String?,
    );
  }
}

class ExecutionSignature {
  const ExecutionSignature({
    required this.id,
    required this.signerName,
    required this.signedAt,
    this.stale = false,
  });

  final String id;
  final String signerName;
  final DateTime signedAt;

  /// O atendimento mudou depois da assinatura.
  ///
  /// Não é detalhe cosmético: com isto verdadeiro a conclusão é RECUSADA pelo
  /// servidor, porque o cliente assinou outra coisa.
  final bool stale;

  factory ExecutionSignature.fromJson(Map<String, dynamic> json) {
    return ExecutionSignature(
      id: json['id'] as String,
      signerName: json['signerName'] as String? ?? '',
      signedAt:
          DateTime.tryParse(json['signedAt'] as String? ?? '')?.toLocal() ??
          DateTime.now(),
      stale: json['stale'] as bool? ?? false,
    );
  }
}

class ExecutionContactAttempt {
  const ExecutionContactAttempt({
    required this.id,
    required this.channel,
    required this.result,
    required this.attemptedAt,
  });

  final String id;
  final String channel;
  final String result;
  final DateTime attemptedAt;

  static const channelLabels = <String, String>{
    'PHONE_CALL': 'Ligação',
    'WHATSAPP': 'WhatsApp',
    'SMS': 'SMS',
    'OTHER': 'Outro',
  };

  static const resultLabels = <String, String>{
    'ANSWERED': 'Atendeu',
    'NO_ANSWER': 'Não atendeu',
    'BUSY': 'Ocupado',
    'INVALID_NUMBER': 'Número inválido',
    'CUSTOMER_REQUESTED_LATER': 'Pediu para remarcar',
  };

  factory ExecutionContactAttempt.fromJson(Map<String, dynamic> json) {
    return ExecutionContactAttempt(
      id: json['id'] as String,
      channel: json['channel'] as String? ?? 'OTHER',
      result: json['result'] as String? ?? 'OTHER',
      attemptedAt:
          DateTime.tryParse(json['attemptedAt'] as String? ?? '')?.toLocal() ??
          DateTime.now(),
    );
  }
}

class ExecutionImpediment {
  const ExecutionImpediment({
    required this.id,
    required this.reason,
    required this.reportedAt,
  });

  final String id;
  final String reason;
  final DateTime reportedAt;

  static const reasonLabels = <String, String>{
    'CUSTOMER_ABSENT': 'Cliente ausente',
    'CUSTOMER_NOT_ANSWERING': 'Cliente não atende',
    'NO_ACCESS': 'Sem acesso ao local',
    'MISSING_MATERIAL': 'Falta material',
    'EXTERNAL_NETWORK_ISSUE': 'Problema na rede externa',
    'WEATHER': 'Condição climática',
    'NEED_SECOND_TECHNICIAN': 'Precisa de segundo técnico',
    'NEED_SPECIAL_EQUIPMENT': 'Precisa de equipamento especial',
    'SAFETY_RISK': 'Risco de segurança',
    'OTHER': 'Outro',
  };

  factory ExecutionImpediment.fromJson(Map<String, dynamic> json) {
    return ExecutionImpediment(
      id: json['id'] as String,
      reason: json['reason'] as String? ?? 'OTHER',
      reportedAt:
          DateTime.tryParse(json['reportedAt'] as String? ?? '')?.toLocal() ??
          DateTime.now(),
    );
  }
}

/// O que falta para concluir, como o servidor calculou.
///
/// `code` é estável e é o que a tela usa para levar o técnico à seção certa.
/// `message` é só para exibir — decidir por ela quebraria o app na primeira
/// vírgula corrigida no servidor, num APK que já está em campo.
class CompletionPendency {
  const CompletionPendency({
    required this.code,
    required this.message,
    this.itemId,
    this.category,
  });

  final String code;
  final String message;
  final String? itemId;
  final String? category;

  factory CompletionPendency.fromJson(Map<String, dynamic> json) {
    return CompletionPendency(
      code: json['code'] as String? ?? 'UNKNOWN',
      message: json['message'] as String? ?? 'Pendência.',
      itemId: json['itemId'] as String?,
      category: json['category'] as String?,
    );
  }
}

class CompletionRequirements {
  const CompletionRequirements({
    this.requireChecklist = false,
    this.requireSignature = false,
    this.requireMaterials = false,
    this.requireEquipment = false,
    this.requireCheckIn = false,
    this.minEvidenceCount = 0,
    this.requiredEvidenceCategories = const [],
  });

  final bool requireChecklist;
  final bool requireSignature;
  final bool requireMaterials;
  final bool requireEquipment;
  final bool requireCheckIn;
  final int minEvidenceCount;
  final List<String> requiredEvidenceCategories;

  factory CompletionRequirements.fromJson(Map<String, dynamic> json) {
    final categories = json['requiredEvidenceCategories'];
    return CompletionRequirements(
      requireChecklist: json['requireChecklist'] as bool? ?? false,
      requireSignature: json['requireSignature'] as bool? ?? false,
      requireMaterials: json['requireMaterials'] as bool? ?? false,
      requireEquipment: json['requireEquipment'] as bool? ?? false,
      requireCheckIn: json['requireCheckIn'] as bool? ?? false,
      minEvidenceCount: (json['minEvidenceCount'] as num?)?.toInt() ?? 0,
      requiredEvidenceCategories: categories is List
          ? categories.map((c) => c.toString()).toList(growable: false)
          : const [],
    );
  }
}

/// Item do catálogo de estoque do técnico.
class StockLine {
  const StockLine({
    required this.itemId,
    required this.code,
    required this.name,
    required this.unit,
    required this.balance,
  });

  final String itemId;
  final String code;
  final String name;
  final String unit;

  /// String pelo mesmo motivo de `ExecutionMaterial.quantity`.
  final String balance;

  factory StockLine.fromJson(Map<String, dynamic> json) {
    return StockLine(
      itemId: json['itemId'] as String,
      code: json['code'] as String? ?? '',
      name: json['name'] as String? ?? '',
      unit: json['unit'] as String? ?? 'UNIT',
      balance: json['balance']?.toString() ?? '0',
    );
  }
}

/// Tudo que a tela de execução mostra, numa leitura só.
///
/// Nove seções em nove requisições seriam nove chances de falhar em rede de
/// borda, e a tela montaria aos pedaços.
class ExecutionBundle {
  const ExecutionBundle({
    required this.orderId,
    required this.version,
    required this.location,
    required this.requirements,
    this.executionVersion,
    this.checkIn,
    this.checklist = const [],
    this.evidences = const [],
    this.materials = const [],
    this.equipments = const [],
    this.signature,
    this.contactAttempts = const [],
    this.impediments = const [],
    this.pendencies = const [],
  });

  final String orderId;

  /// `expectedVersion` do próximo comando sobre a OS.
  final int version;
  final int? executionVersion;

  final ExecutionLocation location;
  final ExecutionCheckIn? checkIn;
  final List<ChecklistItem> checklist;
  final List<ExecutionEvidence> evidences;
  final List<ExecutionMaterial> materials;
  final List<ExecutionEquipment> equipments;
  final ExecutionSignature? signature;
  final List<ExecutionContactAttempt> contactAttempts;
  final List<ExecutionImpediment> impediments;
  final CompletionRequirements requirements;

  /// O que falta, segundo o SERVIDOR.
  ///
  /// A tela usa isto para mostrar progresso e desabilitar o botão. Não é
  /// autoridade: a conclusão revalida dentro da própria transação, e esta lista
  /// já pode estar velha quando o comando chegar. É por isso que a validação
  /// não pode morar só aqui.
  final List<CompletionPendency> pendencies;

  bool get canComplete => pendencies.isEmpty;

  /// Progresso simples das etapas (§47). Sem gamificação: é uma contagem.
  ///
  /// Conta apenas o que a política EXIGE, mais as duas etapas que valem para
  /// qualquer OS (relatório e checklist obrigatório). Uma barra que contasse
  /// etapas não exigidas nunca chegaria ao fim — e o técnico aprenderia a
  /// ignorá-la.
  ({int done, int total}) get progress {
    var total = 0;
    var done = 0;

    void step(bool required, bool complete) {
      if (!required) return;
      total += 1;
      if (complete) done += 1;
    }

    final hasReport = !pendencies.any(
      (p) =>
          p.code == 'EXECUTION_DIAGNOSIS_REQUIRED' ||
          p.code == 'EXECUTION_WORK_REQUIRED',
    );
    step(true, hasReport);

    step(requirements.requireCheckIn, checkIn != null);
    step(
      requirements.requireChecklist && checklist.any((i) => i.required),
      !pendencies.any((p) => p.code == 'CHECKLIST_ITEM_PENDING'),
    );
    step(
      requirements.minEvidenceCount > 0 ||
          requirements.requiredEvidenceCategories.isNotEmpty,
      !pendencies.any(
        (p) =>
            p.code == 'EVIDENCE_COUNT_BELOW_MINIMUM' ||
            p.code == 'EVIDENCE_CATEGORY_MISSING',
      ),
    );
    step(requirements.requireMaterials, materials.isNotEmpty);
    step(requirements.requireEquipment, equipments.isNotEmpty);
    step(
      requirements.requireSignature,
      signature != null && !signature!.stale,
    );

    return (done: done, total: total);
  }

  factory ExecutionBundle.fromJson(Map<String, dynamic> json) {
    List<T> listOf<T>(String key, T Function(Map<String, dynamic>) parse) {
      final raw = json[key];
      if (raw is! List) return const [];
      return raw
          .whereType<Map>()
          .map((e) => parse(Map<String, dynamic>.from(e)))
          .toList(growable: false);
    }

    return ExecutionBundle(
      orderId: json['orderId'] as String? ?? '',
      version: (json['version'] as num?)?.toInt() ?? 0,
      executionVersion: (json['executionVersion'] as num?)?.toInt(),
      location: ExecutionLocation.fromJson(
        Map<String, dynamic>.from(json['location'] as Map? ?? const {}),
      ),
      checkIn: json['checkIn'] == null
          ? null
          : ExecutionCheckIn.fromJson(
              Map<String, dynamic>.from(json['checkIn'] as Map),
            ),
      checklist: listOf('checklist', ChecklistItem.fromJson),
      evidences: listOf('evidences', ExecutionEvidence.fromJson),
      materials: listOf('materials', ExecutionMaterial.fromJson),
      equipments: listOf('equipments', ExecutionEquipment.fromJson),
      signature: json['signature'] == null
          ? null
          : ExecutionSignature.fromJson(
              Map<String, dynamic>.from(json['signature'] as Map),
            ),
      contactAttempts: listOf(
        'contactAttempts',
        ExecutionContactAttempt.fromJson,
      ),
      impediments: listOf('impediments', ExecutionImpediment.fromJson),
      requirements: CompletionRequirements.fromJson(
        Map<String, dynamic>.from(json['requirements'] as Map? ?? const {}),
      ),
      pendencies: listOf('pendencies', CompletionPendency.fromJson),
    );
  }
}
