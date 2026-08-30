import 'package:flutter/foundation.dart';

/// Jornada de trabalho do funcionário — **não** é o check-in da OS.
///
/// As duas gravam "cheguei", com GPS, e param de se parecer aí (PRD §226). O
/// check-in é preso a uma `ServiceOrder`; a jornada é presa à pessoa e ao dia.
/// Este módulo não conhece OS nenhuma, e é assim de propósito.

/// As quatro marcações. Os nomes são os do servidor, sem tradução no meio.
enum TimeEntryType { clockIn, breakStart, breakEnd, clockOut, unknown }

TimeEntryType timeEntryTypeFrom(String? raw) {
  switch (raw) {
    case 'CLOCK_IN':
      return TimeEntryType.clockIn;
    case 'BREAK_START':
      return TimeEntryType.breakStart;
    case 'BREAK_END':
      return TimeEntryType.breakEnd;
    case 'CLOCK_OUT':
      return TimeEntryType.clockOut;
    default:
      return TimeEntryType.unknown;
  }
}

String timeEntryTypeWire(TimeEntryType type) {
  switch (type) {
    case TimeEntryType.clockIn:
      return 'CLOCK_IN';
    case TimeEntryType.breakStart:
      return 'BREAK_START';
    case TimeEntryType.breakEnd:
      return 'BREAK_END';
    case TimeEntryType.clockOut:
      return 'CLOCK_OUT';
    case TimeEntryType.unknown:
      return 'UNKNOWN';
  }
}

/// O rótulo do BOTÃO. Verbo, porque é uma ação que a pessoa vai executar.
String timeEntryAction(TimeEntryType type) {
  switch (type) {
    case TimeEntryType.clockIn:
      return 'REGISTRAR ENTRADA';
    case TimeEntryType.breakStart:
      return 'INICIAR INTERVALO';
    case TimeEntryType.breakEnd:
      return 'RETORNAR DO INTERVALO';
    case TimeEntryType.clockOut:
      return 'ENCERRAR JORNADA';
    case TimeEntryType.unknown:
      return 'REGISTRAR';
  }
}

/// O rótulo do FATO. Substantivo, porque já aconteceu.
String timeEntryLabel(TimeEntryType type) {
  switch (type) {
    case TimeEntryType.clockIn:
      return 'Entrada';
    case TimeEntryType.breakStart:
      return 'Início do intervalo';
    case TimeEntryType.breakEnd:
      return 'Retorno do intervalo';
    case TimeEntryType.clockOut:
      return 'Saída';
    case TimeEntryType.unknown:
      return 'Marcação';
  }
}

enum WorkdayState { notStarted, working, onBreak, finished, unknown }

WorkdayState workdayStateFrom(String? raw) {
  switch (raw) {
    case 'NOT_STARTED':
      return WorkdayState.notStarted;
    case 'WORKING':
      return WorkdayState.working;
    case 'ON_BREAK':
      return WorkdayState.onBreak;
    case 'FINISHED':
      return WorkdayState.finished;
    default:
      return WorkdayState.unknown;
  }
}

String workdayStateLabel(WorkdayState state) {
  switch (state) {
    case WorkdayState.notStarted:
      return 'NÃO INICIADA';
    case WorkdayState.working:
      return 'TRABALHANDO';
    case WorkdayState.onBreak:
      return 'EM INTERVALO';
    case WorkdayState.finished:
      return 'ENCERRADA';
    case WorkdayState.unknown:
      return 'DESCONHECIDA';
  }
}

@immutable
class TimeEntry {
  const TimeEntry({
    required this.id,
    required this.type,
    required this.occurredAt,
    required this.fromAdjustment,
  });

  final String id;
  final TimeEntryType type;

  /// O horário OFICIAL, carimbado pelo servidor. O aplicativo **apresenta**;
  /// ele não tem horário próprio para mostrar (PRD §227).
  final DateTime occurredAt;

  /// Nasceu de uma correção aprovada, não de um toque.
  final bool fromAdjustment;

  factory TimeEntry.fromJson(Map<String, dynamic> json) => TimeEntry(
    id: json['id'] as String,
    type: timeEntryTypeFrom(json['type'] as String?),
    occurredAt:
        DateTime.tryParse(json['occurredAt'] as String? ?? '')?.toLocal() ??
        DateTime.now(),
    fromAdjustment: json['fromAdjustment'] as bool? ?? false,
  );
}

@immutable
class Workday {
  const Workday({
    required this.date,
    this.utcOffset = '',
    required this.state,
    required this.allowedActions,
    required this.entries,
    required this.workedMinutes,
    required this.breakMinutes,
    required this.inconsistencies,
    required this.pendingAdjustments,
  });

  final String date;

  /// Deslocamento do fuso da EMPRESA neste dia, como `-03:00`.
  ///
  /// **O relógio do aparelho não é autoridade sobre horário de jornada.** Um
  /// celular configurado noutro fuso — viagem, roaming, ajuste manual — fazia
  /// o técnico escolher `08:30` e o servidor receber outro instante, sem nada
  /// na tela denunciar (§253, LOW-3).
  ///
  /// Vem calculado pelo servidor porque o Dart não traz a base de fusos: com
  /// `America/Sao_Paulo` sozinho o aplicativo não chegaria a deslocamento
  /// nenhum. É a mesma resposta que o painel do gestor já usa para o navegador.
  ///
  /// Vazio significa servidor antigo: aí o aparelho volta a ser a única
  /// referência disponível — o comportamento anterior, e não uma falha.
  final String utcOffset;

  final WorkdayState state;

  /// **O servidor decide a transição** (PRD §229). A tela desenha o botão a
  /// partir desta lista e não deriva nada: um aplicativo que decidisse sozinho
  /// seria uma segunda máquina de estados, e um APK antigo continuaria
  /// oferecendo uma ação que o servidor já não aceita.
  final List<TimeEntryType> allowedActions;

  final List<TimeEntry> entries;

  /// Calculados NO SERVIDOR. Somar horas no cliente seria uma segunda
  /// contabilidade, e a que divergisse primeiro seria a que ninguém revisou.
  final int workedMinutes;
  final int breakMinutes;

  final List<String> inconsistencies;
  final int pendingAdjustments;

  TimeEntry? get lastEntry => entries.isEmpty ? null : entries.last;

  static const empty = Workday(
    date: '',
    state: WorkdayState.notStarted,
    allowedActions: [TimeEntryType.clockIn],
    entries: [],
    workedMinutes: 0,
    breakMinutes: 0,
    inconsistencies: [],
    pendingAdjustments: 0,
  );

  factory Workday.fromJson(Map<String, dynamic> json) {
    List<T> listOf<T>(String key, T Function(dynamic) parse) {
      final raw = json[key];
      if (raw is! List) return const [];
      return raw.map(parse).toList(growable: false);
    }

    return Workday(
      date: json['date'] as String? ?? '',
      utcOffset: json['utcOffset'] as String? ?? '',
      state: workdayStateFrom(json['state'] as String?),
      allowedActions: listOf(
        'allowedActions',
        (e) => timeEntryTypeFrom(e as String?),
      ).where((t) => t != TimeEntryType.unknown).toList(growable: false),
      entries: listOf(
        'entries',
        (e) => TimeEntry.fromJson(Map<String, dynamic>.from(e as Map)),
      ),
      workedMinutes: (json['workedMinutes'] as num?)?.toInt() ?? 0,
      breakMinutes: (json['breakMinutes'] as num?)?.toInt() ?? 0,
      inconsistencies: listOf('inconsistencies', (e) => e as String),
      pendingAdjustments: (json['pendingAdjustments'] as num?)?.toInt() ?? 0,
    );
  }
}

// ---------------------------------------------------------------------------
// O relógio da empresa
// ---------------------------------------------------------------------------

/*
  O fuso da EMPRESA é a única referência de horário de jornada.

  Estas duas funções são o par que fecha o LOW-3 (§253): uma lê um instante no
  relógio da empresa, a outra monta um instante a partir dele. As duas recebem
  o deslocamento que o servidor calculou para AQUELE dia — nada aqui consulta
  base de fuso, nem tenta deduzir horário de verão, porque a conversão civil
  já foi feita por quem tem autoridade e tabela para fazê-la.

  Uma tabela de offsets embutida no APK envelheceria na primeira mudança de
  lei, e um aplicativo em campo é justamente o que não se atualiza a tempo.
*/

/// `+HH:MM` / `-HH:MM` como `Duration`. `null` quando não é um deslocamento.
Duration? parseUtcOffset(String? raw) {
  if (raw == null) return null;
  final m = RegExp(r'^([+-])(\d{2}):(\d{2})$').firstMatch(raw.trim());
  if (m == null) return null;
  final horas = int.parse(m.group(2)!);
  final minutos = int.parse(m.group(3)!);
  if (horas > 14 || minutos > 59) return null;
  final magnitude = Duration(hours: horas, minutes: minutos);
  return m.group(1) == '-' ? -magnitude : magnitude;
}

/// O mesmo instante, lido no relógio de parede da empresa.
///
/// O resultado serve para LER campos (`hour`, `minute`) — não é um instante
/// novo, e somá-lo a outra coisa não faz sentido. Sem deslocamento utilizável,
/// devolve o horário local do aparelho: é o que existia antes, e continua
/// melhor que exibir UTC como se fosse a hora da pessoa.
DateTime inCompanyTime(DateTime instant, String utcOffset) {
  final deslocamento = parseUtcOffset(utcOffset);
  if (deslocamento == null) return instant.toLocal();
  return instant.toUtc().add(deslocamento);
}

/// O instante absoluto de uma hora civil no fuso da EMPRESA.
///
/// `date` é o dia operacional que o servidor informou (`AAAA-MM-DD`), nunca
/// `DateTime.now()`: perto da meia-noite os dois discordam, e ancorar no
/// relógio do aparelho mandaria a correção para o dia seguinte.
///
/// Sem deslocamento utilizável, cai no fuso do aparelho — de novo, o
/// comportamento anterior, e o servidor continua validando o que chegar.
DateTime? instantFromCompanyTime(
  String date,
  int hour,
  int minute,
  String utcOffset,
) {
  final partes = date.split('-');
  if (partes.length != 3) return null;
  final ano = int.tryParse(partes[0]);
  final mes = int.tryParse(partes[1]);
  final dia = int.tryParse(partes[2]);
  if (ano == null || mes == null || dia == null) return null;

  if (parseUtcOffset(utcOffset) == null) {
    return DateTime(ano, mes, dia, hour, minute);
  }

  String pad(int valor, int casas) => valor.toString().padLeft(casas, '0');
  final civil =
      '${pad(ano, 4)}-${pad(mes, 2)}-${pad(dia, 2)}'
      'T${pad(hour, 2)}:${pad(minute, 2)}:00';

  // `DateTime.parse` entende o deslocamento ISO e devolve o instante absoluto.
  // Montar a conta à mão duplicaria a aritmética que ele já faz certo.
  return DateTime.tryParse('$civil${utcOffset.trim()}');
}

/// Um dia no histórico. Resumo, não a lista de marcações.
@immutable
class WorkdaySummary {
  const WorkdaySummary({
    required this.date,
    required this.state,
    required this.workedMinutes,
    required this.breakMinutes,
    required this.entryCount,
    required this.pendingAdjustments,
  });

  final String date;
  final WorkdayState state;
  final int workedMinutes;
  final int breakMinutes;
  final int entryCount;
  final int pendingAdjustments;

  factory WorkdaySummary.fromJson(Map<String, dynamic> json) => WorkdaySummary(
    date: json['date'] as String? ?? '',
    state: workdayStateFrom(json['state'] as String?),
    workedMinutes: (json['workedMinutes'] as num?)?.toInt() ?? 0,
    breakMinutes: (json['breakMinutes'] as num?)?.toInt() ?? 0,
    entryCount: (json['entryCount'] as num?)?.toInt() ?? 0,
    pendingAdjustments: (json['pendingAdjustments'] as num?)?.toInt() ?? 0,
  );
}

/// Um pedido de correção, do ponto de vista de quem pediu.
///
/// O técnico precisa ver TRÊS coisas: o que pediu, para quando, e no que deu.
/// Sem a terceira, um pedido rejeitado é indistinguível de um pedido esquecido
/// — e quem pediu fica esperando por algo que já foi decidido (PRD §229).
@immutable
class TimeAdjustment {
  const TimeAdjustment({
    required this.id,
    required this.status,
    required this.requestedEntryType,
    required this.requestedOccurredAt,
    required this.reason,
    required this.workdayDate,
    this.decisionReason,
  });

  final String id;

  /// `PENDING`, `APPROVED` ou `REJECTED`, como o servidor os nomeia.
  ///
  /// String crua, e não enum: um status novo do servidor precisa aparecer como
  /// texto num APK antigo, não sumir da lista por não ter case.
  final String status;

  final TimeEntryType requestedEntryType;
  final DateTime requestedOccurredAt;
  final String reason;
  final String workdayDate;

  /// Por que foi recusado. Sem isto a recusa chega sem contraditório.
  final String? decisionReason;

  bool get isPending => status == 'PENDING';

  factory TimeAdjustment.fromJson(Map<String, dynamic> json) => TimeAdjustment(
    id: json['id'] as String? ?? '',
    status: json['status'] as String? ?? 'PENDING',
    requestedEntryType: timeEntryTypeFrom(
      json['requestedEntryType'] as String?,
    ),
    requestedOccurredAt:
        DateTime.tryParse(json['requestedOccurredAt'] as String? ?? '')
            ?.toLocal() ??
        DateTime.fromMillisecondsSinceEpoch(0),
    reason: json['reason'] as String? ?? '',
    workdayDate: json['workdayDate'] as String? ?? '',
    decisionReason: json['decisionReason'] as String?,
  );
}

String adjustmentStatusLabel(String status) {
  switch (status) {
    case 'PENDING':
      return 'Aguardando aprovação';
    case 'APPROVED':
      return 'Aprovada';
    case 'REJECTED':
      return 'Rejeitada';
    default:
      return status;
  }
}

/// Estado de sincronização de uma marcação.
///
/// Os três valores existem desde já para a UI não precisar ser redesenhada
/// quando a fila offline chegar (PRD §232). **Hoje só `synced` acontece** — o
/// aplicativo não finge suporte offline que não tem.
enum PunchSyncStatus { synced, pendingSync, failed }

String minutesLabel(int minutes) {
  final h = minutes ~/ 60;
  final m = minutes % 60;
  if (h == 0) return '${m}min';
  if (m == 0) return '${h}h';
  return '${h}h ${m}min';
}
