/// Contexto do técnico logado, como `/me` o devolve.
///
/// **O que NÃO existe aqui**, porque a API não envia: credencial de ERP,
/// configuração administrativa da empresa, dados de outros técnicos, internals
/// de auditoria. O que não desce não vaza de um celular roubado.
class FieldSession {
  const FieldSession({
    required this.userId,
    required this.userName,
    required this.userEmail,
    required this.technicianId,
    required this.technicianActive,
    required this.executionIssue,
    required this.companyName,
    required this.deviceId,
    required this.canStartOrder,
    required this.canRevealPassword,
  });

  final String userId;
  final String userName;
  final String userEmail;
  final String technicianId;
  final bool technicianActive;

  /// Por que este técnico não pode ESCREVER, ou null quando pode.
  ///
  /// Frase pronta, vinda do servidor. A leitura nunca é bloqueada por ela: um
  /// técnico desativado continua abrindo as OS que já tinha.
  final String? executionIssue;

  final String companyName;
  final String deviceId;

  /// Capabilities do servidor. Servem para o app **não desenhar** um botão que
  /// a API recusaria — nunca como autorização. UI não é controle de segurança,
  /// e cada rota reconfere.
  final bool canStartOrder;
  final bool canRevealPassword;

  factory FieldSession.fromJson(Map<String, dynamic> json) {
    final user = Map<String, dynamic>.from(json['user'] as Map? ?? {});
    final technician = Map<String, dynamic>.from(
      json['technician'] as Map? ?? {},
    );
    final company = Map<String, dynamic>.from(json['company'] as Map? ?? {});
    final device = Map<String, dynamic>.from(json['device'] as Map? ?? {});
    final capabilities = Map<String, dynamic>.from(
      json['capabilities'] as Map? ?? {},
    );

    return FieldSession(
      userId: user['id'] as String? ?? '',
      userName: user['name'] as String? ?? '',
      userEmail: user['email'] as String? ?? '',
      technicianId: technician['id'] as String? ?? '',
      technicianActive: technician['active'] as bool? ?? false,
      executionIssue: technician['executionIssue'] as String?,
      companyName: company['name'] as String? ?? '',
      deviceId: device['id'] as String? ?? '',
      canStartOrder: capabilities['startOrder'] as bool? ?? false,
      canRevealPassword:
          capabilities['revealConnectionPassword'] as bool? ?? false,
    );
  }

  /// Primeiro nome, para o cabeçalho. "Bom dia, Tecnico" cabe na tela; o nome
  /// completo não.
  String get firstName {
    final parts = userName.trim().split(RegExp(r'\s+'));
    return parts.isEmpty ? userName : parts.first;
  }
}
