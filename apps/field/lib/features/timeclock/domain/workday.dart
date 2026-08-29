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
    required this.state,
    required this.allowedActions,
    required this.entries,
    required this.workedMinutes,
    required this.breakMinutes,
    required this.inconsistencies,
    required this.pendingAdjustments,
  });

  final String date;
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
