import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../../app/providers.dart';
import '../../../core/api/idempotency.dart';
import '../../../core/errors/field_error.dart';
import '../../../core/location/location_service.dart';
import '../../../core/media/photo_capture.dart';
import '../../../core/sync/pending_operation.dart';
import '../data/execution_repository.dart';
import '../domain/execution.dart';

/// Uma foto que ainda não chegou ao servidor.
///
/// Existe por causa da §58: **a foto não some porque a rede caiu**. Ela fica no
/// aparelho, visível, com o estado dela — e o técnico reenvia quando quiser.
///
/// Isto NÃO é o motor offline da v0.11. É memória de sessão: se o app for
/// fechado, a lista se perde, e o aplicativo não afirma em lugar nenhum que
/// sincronizou. O que a v0.11 acrescenta é persistência e reenvio automático —
/// e os estados aqui são os mesmos de `SyncStatus`, de propósito, para que
/// migrar não signifique renomear.
@immutable
class PendingPhoto {
  const PendingPhoto({
    required this.localId,
    required this.idempotencyKey,
    required this.file,
    required this.category,
    required this.status,
    required this.capturedAt,
    this.error,
  });

  final String localId;

  /// Chave da INTENÇÃO, criada quando a foto foi tirada.
  ///
  /// Reusada em toda retentativa: gerada a cada envio, o servidor veria fotos
  /// distintas e a mesma imagem entraria várias vezes no relatório.
  final String idempotencyKey;

  final File file;
  final String category;
  final SyncStatus status;
  final DateTime capturedAt;
  final String? error;

  PendingPhoto copyWith({SyncStatus? status, String? error}) => PendingPhoto(
    localId: localId,
    idempotencyKey: idempotencyKey,
    file: file,
    category: category,
    status: status ?? this.status,
    capturedAt: capturedAt,
    error: error,
  );
}

@immutable
class ExecutionState {
  const ExecutionState({
    this.bundle,
    this.stock = const [],
    this.pendingPhotos = const [],
    this.loading = true,
    this.busy = false,
    this.error,
    this.notFound = false,
    this.message,
    this.locationMessage,
    this.completionPendencies = const [],
    this.completed = false,
  });

  final ExecutionBundle? bundle;
  final List<StockLine> stock;
  final List<PendingPhoto> pendingPhotos;
  final bool loading;

  /// Um comando em voo. Trava as ações para impedir duplo toque — a proteção
  /// real é a chave de idempotência, mas piscar o botão evita a corrida antes
  /// de ela existir.
  final bool busy;

  final String? error;
  final bool notFound;
  final String? message;

  /// Aviso sobre GPS — permissão negada, sinal ausente. **Nunca bloqueia.**
  final String? locationMessage;

  /// Pendências devolvidas pela ÚLTIMA tentativa de conclusão.
  ///
  /// Separado de `bundle.pendencies` de propósito: aquela é a leitura da tela,
  /// esta é a resposta do servidor a um comando real, e é a que vale quando as
  /// duas discordam.
  final List<CompletionPendency> completionPendencies;

  final bool completed;

  ExecutionState copyWith({
    ExecutionBundle? bundle,
    List<StockLine>? stock,
    List<PendingPhoto>? pendingPhotos,
    bool? loading,
    bool? busy,
    String? error,
    bool? notFound,
    String? message,
    String? locationMessage,
    List<CompletionPendency>? completionPendencies,
    bool? completed,
    bool clearError = false,
    bool clearMessage = false,
    bool clearLocationMessage = false,
  }) => ExecutionState(
    bundle: bundle ?? this.bundle,
    stock: stock ?? this.stock,
    pendingPhotos: pendingPhotos ?? this.pendingPhotos,
    loading: loading ?? this.loading,
    busy: busy ?? this.busy,
    error: clearError ? null : (error ?? this.error),
    notFound: notFound ?? this.notFound,
    message: clearMessage ? null : (message ?? this.message),
    locationMessage: clearLocationMessage
        ? null
        : (locationMessage ?? this.locationMessage),
    completionPendencies: completionPendencies ?? this.completionPendencies,
    completed: completed ?? this.completed,
  );
}

/// Estado da tela de execução.
///
/// ## Uma regra atravessa tudo aqui
///
/// **O aplicativo não decide.** Toda ação chama o servidor e recarrega o
/// pacote; nenhuma calcula saldo, pendência ou permissão de conclusão
/// localmente. Isso custa uma ida à rede por ação e compra a única propriedade
/// que importa: um APK antigo em campo não consegue fechar uma OS que o
/// servidor recusaria.
///
/// ## Conflito recarrega, não reenvia
///
/// `409` significa que o mundo mudou. Insistir com a versão velha produziria o
/// mesmo 409 para sempre. A tela recarrega e conta ao técnico.
class ExecutionController extends StateNotifier<ExecutionState> {
  ExecutionController({
    required ExecutionRepository repository,
    required LocationService location,
    required PhotoCapture photos,
    required this.orderId,
  }) : _repository = repository,
       _location = location,
       _photos = photos,
       super(const ExecutionState());

  final ExecutionRepository _repository;
  final LocationService _location;
  final PhotoCapture _photos;
  final String orderId;

  static const _uuid = Uuid();

  /// Chaves de intenção das ações de disparo único.
  ///
  /// Guardadas até a intenção se cumprir: reapresentar a MESMA chave é o que
  /// torna a retentativa segura. Uma chave nova a cada envio faria o servidor
  /// ver comandos distintos.
  final Map<String, String> _intentKeys = {};

  String _intentKey(String operation) =>
      _intentKeys[operation] ??= IdempotencyKey.forOperation(operation);

  void _clearIntent(String operation) => _intentKeys.remove(operation);

  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true, notFound: false);
    try {
      final bundle = await _repository.load(orderId);
      state = state.copyWith(
        bundle: bundle,
        loading: false,
        clearError: true,
        // O que o servidor diz agora substitui o resultado da tentativa
        // anterior: manter a lista velha mostraria pendência já resolvida.
        completionPendencies: const [],
      );
    } on FieldException catch (error) {
      if (error.code == FieldErrorCode.notFound) {
        state = state.copyWith(loading: false, notFound: true);
        return;
      }
      state = state.copyWith(loading: false, error: error.message);
    }
  }

  Future<void> loadStock() async {
    try {
      state = state.copyWith(stock: await _repository.stock());
    } on FieldException {
      // Catálogo é conveniência da tela: falhar aqui não pode derrubar a
      // execução inteira. O técnico continua com as outras seções.
    }
  }

  /// Executa um comando e recarrega o pacote.
  ///
  /// Centraliza o que TODA ação precisa fazer igual: travar o botão, tratar
  /// conflito recarregando, e recarregar em caso de sucesso. Espalhar isso
  /// significaria que uma das doze ações esqueceria o tratamento de 409.
  Future<bool> _run(
    String operation,
    Future<void> Function(ExecutionBundle bundle) action, {
    String? successMessage,
  }) async {
    final bundle = state.bundle;
    if (bundle == null || state.busy) return false;

    state = state.copyWith(busy: true, clearError: true, clearMessage: true);
    try {
      await action(bundle);
      _clearIntent(operation);
      await load();
      state = state.copyWith(busy: false, message: successMessage);
      return true;
    } on FieldException catch (error) {
      state = state.copyWith(busy: false);
      if (error.conflict) {
        // A intenção representava um mundo que não existe mais.
        _clearIntent(operation);
        state = state.copyWith(
          message: 'O atendimento mudou em outro lugar. Recarregando...',
        );
        await load();
        return false;
      }
      state = state.copyWith(error: error.message);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Localização
  // -------------------------------------------------------------------------

  /// Lê o GPS para uma ação. Devolve `null` quando não há posição — e isso é
  /// caminho normal, não falha.
  Future<DeviceLocation?> _readPosition() async {
    final reading = await _location.current();
    state = state.copyWith(
      locationMessage: reading.message,
      clearLocationMessage: reading.hasPosition,
    );
    return reading.position;
  }

  /// Confirma que o ponto cadastrado está correto.
  ///
  /// O GPS entra como OBSERVAÇÃO — de onde o técnico confirmou — e não como a
  /// localização do cliente. Mover o ponto é `correctLocation`, que é outra
  /// ação e exige motivo.
  Future<bool> confirmLocation() async {
    final version = state.bundle?.location.version;
    if (version == null) {
      state = state.copyWith(
        error: 'Este cliente ainda não tem localização. Use "Corrigir".',
      );
      return false;
    }
    final position = await _readPosition();
    return _run(
      'location-confirm',
      (_) => _repository.confirmLocation(
        orderId: orderId,
        expectedVersion: version,
        idempotencyKey: _intentKey('location-confirm'),
        observedLatitude: position?.latitude,
        observedLongitude: position?.longitude,
        observedAccuracyMeters: position?.accuracyMeters,
      ),
      successMessage: 'Localização confirmada.',
    );
  }

  /// Corrige endereço e/ou coordenada.
  ///
  /// `useCurrentPosition` lê o GPS e envia como `TECHNICIAN_GPS`. Sem ele, e
  /// sem coordenada digitada, a correção é só de endereço — e não toca
  /// `verified`, porque o texto estar errado não diz nada sobre o ponto.
  Future<bool> correctLocation({
    required String reason,
    String? note,
    bool useCurrentPosition = false,
    Map<String, String?>? address,
  }) async {
    DeviceLocation? position;
    if (useCurrentPosition) {
      position = await _readPosition();
      if (position == null) {
        // Sem posição não há o que corrigir no mapa. O aviso já foi para o
        // estado; recusar aqui evita mandar uma correção vazia.
        return false;
      }
    }

    return _run(
      'location-correct',
      (bundle) => _repository.correctLocation(
        orderId: orderId,
        expectedVersion: bundle.location.version,
        reason: reason,
        note: note,
        idempotencyKey: _intentKey('location-correct'),
        latitude: position?.latitude,
        longitude: position?.longitude,
        accuracyMeters: position?.accuracyMeters,
        source: position != null ? 'TECHNICIAN_GPS' : null,
        address: address,
      ),
      successMessage: 'Cadastro corrigido.',
    );
  }

  // -------------------------------------------------------------------------
  // Check-in
  // -------------------------------------------------------------------------

  Future<bool> checkIn() async {
    final position = await _readPosition();
    return _run(
      'check-in',
      (bundle) => _repository.checkIn(
        orderId: orderId,
        expectedVersion: bundle.version,
        idempotencyKey: _intentKey('check-in'),
        // Sem GPS o check-in vale igual: a chegada é o fato.
        latitude: position?.latitude,
        longitude: position?.longitude,
        accuracyMeters: position?.accuracyMeters,
      ),
      successMessage: 'Check-in registrado.',
    );
  }

  // -------------------------------------------------------------------------
  // Checklist
  // -------------------------------------------------------------------------

  Future<bool> answerChecklist(
    ChecklistItem item, {
    bool? valueBoolean,
    String? valueText,
    num? valueNumber,
  }) {
    // Chave por ITEM: a mesma chave para dois itens faria o segundo receber o
    // desfecho do primeiro, e o técnico daria por respondida uma pergunta que
    // ninguém respondeu.
    final operation = 'checklist-${item.id}';
    return _run(
      operation,
      (bundle) => _repository.answerChecklistItem(
        orderId: orderId,
        itemId: item.id,
        expectedVersion: bundle.version,
        idempotencyKey: _intentKey(operation),
        valueBoolean: valueBoolean,
        valueText: valueText,
        valueNumber: valueNumber,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Evidências
  // -------------------------------------------------------------------------

  /// Captura e envia uma foto.
  ///
  /// A foto entra na lista local ANTES do envio e só sai de lá quando o
  /// servidor confirma. É o que cumpre a §58: rede caindo no meio não apaga a
  /// foto — ela fica visível, marcada como falha, e o técnico reenvia.
  Future<void> addPhoto(String category, {bool fromGallery = false}) async {
    final file = fromGallery
        ? await _photos.pickFromGallery()
        : await _photos.takePhoto();
    if (file == null) return;

    final pending = PendingPhoto(
      localId: _uuid.v4(),
      // Chave criada AGORA, junto com a intenção — não no envio.
      idempotencyKey: IdempotencyKey.forOperation('evidence'),
      file: file,
      category: category,
      status: SyncStatus.pending,
      capturedAt: DateTime.now(),
    );

    state = state.copyWith(
      pendingPhotos: [...state.pendingPhotos, pending],
      clearError: true,
    );
    await _uploadPhoto(pending);
  }

  /// Reenvia uma foto que falhou. Mesma chave, mesma intenção.
  Future<void> retryPhoto(PendingPhoto photo) => _uploadPhoto(photo);

  /// Descarta uma foto que nunca chegou ao servidor.
  ///
  /// Só remove da lista LOCAL: uma foto já enviada é removida pelo comando do
  /// servidor, que audita a remoção.
  void discardPendingPhoto(PendingPhoto photo) {
    state = state.copyWith(
      pendingPhotos: state.pendingPhotos
          .where((p) => p.localId != photo.localId)
          .toList(growable: false),
    );
  }

  Future<void> _uploadPhoto(PendingPhoto photo) async {
    final bundle = state.bundle;
    if (bundle == null) return;

    _updatePending(photo.localId, (p) => p.copyWith(status: SyncStatus.syncing));

    try {
      await _repository.addEvidence(
        orderId: orderId,
        expectedVersion: bundle.version,
        category: photo.category,
        file: photo.file,
        idempotencyKey: photo.idempotencyKey,
        capturedAt: photo.capturedAt,
      );
      // Confirmada: sai da lista local e passa a existir no pacote do servidor.
      state = state.copyWith(
        pendingPhotos: state.pendingPhotos
            .where((p) => p.localId != photo.localId)
            .toList(growable: false),
      );
      await load();
      state = state.copyWith(message: 'Foto anexada.');
    } on FieldException catch (error) {
      _updatePending(
        photo.localId,
        (p) => p.copyWith(status: SyncStatus.failed, error: error.message),
      );
      if (error.conflict) await load();
    }
  }

  void _updatePending(String localId, PendingPhoto Function(PendingPhoto) f) {
    state = state.copyWith(
      pendingPhotos: state.pendingPhotos
          .map((p) => p.localId == localId ? f(p) : p)
          .toList(growable: false),
    );
  }

  Future<bool> removeEvidence(ExecutionEvidence evidence) {
    final operation = 'evidence-remove-${evidence.id}';
    return _run(
      operation,
      (bundle) => _repository.removeEvidence(
        orderId: orderId,
        evidenceId: evidence.id,
        expectedVersion: bundle.version,
        idempotencyKey: _intentKey(operation),
      ),
      successMessage: 'Foto removida.',
    );
  }

  // -------------------------------------------------------------------------
  // Materiais, equipamentos, contato e impedimento
  // -------------------------------------------------------------------------

  Future<bool> useMaterial({
    required String itemId,
    required num quantity,
    String? notes,
  }) async {
    final operation = 'material-$itemId-$quantity';
    final ok = await _run(
      operation,
      (bundle) => _repository.useMaterial(
        orderId: orderId,
        itemId: itemId,
        quantity: quantity,
        expectedVersion: bundle.version,
        idempotencyKey: _intentKey(operation),
        notes: notes,
      ),
      successMessage: 'Material registrado.',
    );
    // O saldo mudou; a lista da tela precisa acompanhar.
    if (ok) await loadStock();
    return ok;
  }

  Future<bool> addEquipment({
    required String equipmentType,
    String? manufacturer,
    String? model,
    String? serial,
    String? macAddress,
    String? notes,
  }) {
    final operation = 'equipment-${serial ?? macAddress ?? equipmentType}';
    return _run(
      operation,
      (bundle) => _repository.addEquipment(
        orderId: orderId,
        expectedVersion: bundle.version,
        equipmentType: equipmentType,
        idempotencyKey: _intentKey(operation),
        manufacturer: manufacturer,
        model: model,
        serial: serial,
        macAddress: macAddress,
        notes: notes,
      ),
      successMessage: 'Equipamento registrado.',
    );
  }

  Future<bool> removeEquipment(ExecutionEquipment equipment) {
    final operation = 'equipment-remove-${equipment.id}';
    return _run(
      operation,
      (bundle) => _repository.removeEquipment(
        orderId: orderId,
        equipmentId: equipment.id,
        expectedVersion: bundle.version,
        idempotencyKey: _intentKey(operation),
      ),
      successMessage: 'Equipamento removido.',
    );
  }

  Future<bool> recordContact({
    required String channel,
    required String result,
    String? notes,
  }) {
    final operation = 'contact-$channel-$result-${DateTime.now().minute}';
    return _run(
      operation,
      (bundle) => _repository.recordContactAttempt(
        orderId: orderId,
        expectedVersion: bundle.version,
        channel: channel,
        result: result,
        idempotencyKey: _intentKey(operation),
        notes: notes,
      ),
      successMessage: 'Tentativa de contato registrada.',
    );
  }

  Future<bool> recordImpediment({required String reason, String? notes}) {
    final operation = 'impediment-$reason';
    return _run(
      operation,
      (bundle) => _repository.recordImpediment(
        orderId: orderId,
        expectedVersion: bundle.version,
        reason: reason,
        idempotencyKey: _intentKey(operation),
        notes: notes,
      ),
      // A OS continua em andamento: o impedimento é registro, não conclusão.
      successMessage: 'Impedimento registrado. A OS continua em andamento.',
    );
  }

  // -------------------------------------------------------------------------
  // Assinatura e conclusão
  // -------------------------------------------------------------------------

  Future<bool> signOff({
    required String signerName,
    required List<int> pngBytes,
  }) {
    return _run(
      'signature',
      (bundle) => _repository.putSignature(
        orderId: orderId,
        expectedVersion: bundle.version,
        signerName: signerName,
        pngBytes: pngBytes,
        idempotencyKey: _intentKey('signature'),
      ),
      successMessage: 'Assinatura registrada.',
    );
  }

  /// Conclui o atendimento.
  ///
  /// A recusa por pendências NÃO é erro de rede nem conflito: é o servidor
  /// dizendo o que falta, com códigos estáveis. A lista vai para a tela, que
  /// leva o técnico ao item — em vez de mostrar uma frase e deixá-lo procurar.
  Future<bool> complete() async {
    final bundle = state.bundle;
    if (bundle == null || state.busy) return false;

    final executionVersion = bundle.executionVersion;
    if (executionVersion == null) {
      state = state.copyWith(
        error: 'Este atendimento ainda não foi iniciado.',
      );
      return false;
    }

    state = state.copyWith(
      busy: true,
      clearError: true,
      clearMessage: true,
      completionPendencies: const [],
    );

    try {
      await _repository.complete(
        orderId: orderId,
        expectedVersion: bundle.version,
        expectedExecutionVersion: executionVersion,
        idempotencyKey: _intentKey('complete'),
      );
      _clearIntent('complete');
      state = state.copyWith(
        busy: false,
        completed: true,
        message: 'Atendimento concluído.',
      );
      return true;
    } on FieldException catch (error) {
      state = state.copyWith(busy: false);

      if (error.pendencies.isNotEmpty) {
        // A intenção continua válida — o técnico vai resolver e tentar de novo
        // com a mesma chave, e o servidor tratará como a mesma intenção.
        state = state.copyWith(
          completionPendencies: error.pendencies
              .map(CompletionPendency.fromJson)
              .toList(growable: false),
        );
        await load();
        return false;
      }

      if (error.conflict) {
        _clearIntent('complete');
        state = state.copyWith(
          message: 'O atendimento mudou em outro lugar. Recarregando...',
        );
        await load();
        return false;
      }

      state = state.copyWith(error: error.message);
      return false;
    }
  }

  void consumeMessage() => state = state.copyWith(clearMessage: true);
  void consumeError() => state = state.copyWith(clearError: true);
  void consumeLocationMessage() =>
      state = state.copyWith(clearLocationMessage: true);
}

/// Controlador da execução, descartado quando a tela sai.
///
/// `autoDispose` aqui tem a mesma razão do detalhe da OS: o estado carrega
/// caminhos de arquivo de fotos capturadas, e mantê-lo vivo depois de o técnico
/// sair da OS guardaria referência a mídia de um atendimento que ele já
/// terminou.
final executionControllerProvider = StateNotifierProvider.autoDispose
    .family<ExecutionController, ExecutionState, String>((ref, orderId) {
      return ExecutionController(
        repository: ref.watch(executionRepositoryProvider),
        location: ref.watch(locationServiceProvider),
        photos: ref.watch(photoCaptureProvider),
        orderId: orderId,
      );
    });
