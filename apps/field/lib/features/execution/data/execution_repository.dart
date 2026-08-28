import 'dart:io';

import 'package:dio/dio.dart';

import '../../../core/api/field_api_client.dart';
import '../domain/execution.dart';

/// Comandos de execução em campo.
///
/// Cada método é um comando do contrato, e nenhum decide regra: posse, estado,
/// saldo, obrigatoriedade e conclusão são do servidor. O repositório monta a
/// requisição, entrega `expectedVersion` e a chave de idempotência, e traduz a
/// resposta.
///
/// **Toda mutação leva as duas proteções, e elas respondem perguntas
/// diferentes:** a chave cobre a REPETIÇÃO (a mesma intenção reenviada quando a
/// rede volta); `expectedVersion` cobre a DIVERGÊNCIA (alguém mexeu na OS
/// enquanto o técnico estava sem sinal). Uma não substitui a outra.
class ExecutionRepository {
  ExecutionRepository({required FieldApiClient api}) : _api = api;

  final FieldApiClient _api;

  /// O pacote inteiro da tela, numa leitura.
  Future<ExecutionBundle> load(String orderId) async {
    final data = await _api.get('/service-orders/$orderId/execution');
    return ExecutionBundle.fromJson(data);
  }

  /// Estoque do próprio técnico. Não existe parâmetro de técnico: o dono sai do
  /// token no servidor.
  Future<List<StockLine>> stock() async {
    final data = await _api.get('/inventory');
    final items = data['items'];
    if (items is! List) return const [];
    return items
        .whereType<Map>()
        .map((e) => StockLine.fromJson(Map<String, dynamic>.from(e)))
        .toList(growable: false);
  }

  Future<void> checkIn({
    required String orderId,
    required int expectedVersion,
    required String idempotencyKey,
    double? latitude,
    double? longitude,
    int? accuracyMeters,
  }) async {
    await _api.post(
      '/service-orders/$orderId/check-in',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        // Coordenada é opcional: sem GPS o check-in vale igual, porque a
        // chegada é o fato operacional e a coordenada é o detalhe.
        if (latitude != null) 'latitude': latitude,
        if (longitude != null) 'longitude': longitude,
        if (accuracyMeters != null) 'accuracyMeters': accuracyMeters,
      },
    );
  }

  /// Confirma o ponto JÁ cadastrado.
  ///
  /// `expectedVersion` é o da LOCALIZAÇÃO, não o da OS. A coordenada observada
  /// é registrada como evidência de onde o técnico estava — ela não vira a
  /// localização do cliente, que continua onde estava.
  Future<void> confirmLocation({
    required String orderId,
    required int expectedVersion,
    required String idempotencyKey,
    double? observedLatitude,
    double? observedLongitude,
    int? observedAccuracyMeters,
  }) async {
    await _api.post(
      '/service-orders/$orderId/location/confirm',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        if (observedLatitude != null) 'observedLatitude': observedLatitude,
        if (observedLongitude != null) 'observedLongitude': observedLongitude,
        if (observedAccuracyMeters != null)
          'observedAccuracyMeters': observedAccuracyMeters,
      },
    );
  }

  /// Corrige endereço e/ou coordenada, com motivo obrigatório.
  ///
  /// `expectedVersion` aceita `null` — é o compare-and-set da CRIAÇÃO, para o
  /// cliente que ainda não tem ponto.
  ///
  /// `source` só pode ser `TECHNICIAN_GPS` ou `MANUAL`: origens de processo
  /// automático descrevem o servidor, e o app não pode alegá-las.
  Future<void> correctLocation({
    required String orderId,
    required int? expectedVersion,
    required String reason,
    required String idempotencyKey,
    String? note,
    double? latitude,
    double? longitude,
    int? accuracyMeters,
    String? source,
    Map<String, String?>? address,
  }) async {
    await _api.post(
      '/service-orders/$orderId/location/correct',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        'reason': reason,
        if (note != null && note.isNotEmpty) 'note': note,
        if (latitude != null) 'latitude': latitude,
        if (longitude != null) 'longitude': longitude,
        if (accuracyMeters != null) 'accuracyMeters': accuracyMeters,
        if (source != null) 'source': source,
        if (address != null && address.isNotEmpty) 'address': address,
      },
    );
  }

  Future<void> answerChecklistItem({
    required String orderId,
    required String itemId,
    required int expectedVersion,
    required String idempotencyKey,
    bool? valueBoolean,
    String? valueText,
    num? valueNumber,
  }) async {
    await _api.post(
      '/service-orders/$orderId/checklist/$itemId',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        if (valueBoolean != null) 'valueBoolean': valueBoolean,
        if (valueText != null) 'valueText': valueText,
        if (valueNumber != null) 'valueNumber': valueNumber,
      },
    );
  }

  /// Anexa uma foto categorizada.
  ///
  /// O `capturedAt` do aparelho vai junto, mas é informativo: o relógio do
  /// celular é ajustável pelo próprio usuário, e a integridade vem do carimbo
  /// que o servidor grava quando o arquivo chega.
  Future<void> addEvidence({
    required String orderId,
    required int expectedVersion,
    required String category,
    required File file,
    required String idempotencyKey,
    String? caption,
    DateTime? capturedAt,
  }) async {
    final form = FormData.fromMap({
      'file': await MultipartFile.fromFile(file.path),
      'expectedOrderVersion': expectedVersion,
      'category': category,
      if (caption != null && caption.isNotEmpty) 'caption': caption,
      if (capturedAt != null) 'capturedAt': capturedAt.toUtc().toIso8601String(),
    });

    await _api.upload(
      '/service-orders/$orderId/evidence',
      form: form,
      idempotencyKey: idempotencyKey,
    );
  }

  Future<void> removeEvidence({
    required String orderId,
    required String evidenceId,
    required int expectedVersion,
    required String idempotencyKey,
  }) async {
    await _api.post(
      '/service-orders/$orderId/evidence/$evidenceId',
      idempotencyKey: idempotencyKey,
      body: {'expectedVersion': expectedVersion},
    );
  }

  /// Baixa material do estoque do técnico.
  ///
  /// O aplicativo envia item e quantidade. **Quem valida saldo é o servidor**,
  /// dentro da transação e sob lock — o número que a tela mostra pode estar
  /// velho quando o comando chegar.
  Future<void> useMaterial({
    required String orderId,
    required String itemId,
    required num quantity,
    required int expectedVersion,
    required String idempotencyKey,
    String? notes,
  }) async {
    await _api.post(
      '/service-orders/$orderId/materials',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        'itemId': itemId,
        'quantity': quantity,
        if (notes != null && notes.isNotEmpty) 'notes': notes,
      },
    );
  }

  Future<void> addEquipment({
    required String orderId,
    required int expectedVersion,
    required String equipmentType,
    required String idempotencyKey,
    String? manufacturer,
    String? model,
    String? serial,
    String? macAddress,
    String? notes,
  }) async {
    await _api.post(
      '/service-orders/$orderId/equipment',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        'equipmentType': equipmentType,
        if (manufacturer != null && manufacturer.isNotEmpty)
          'manufacturer': manufacturer,
        if (model != null && model.isNotEmpty) 'model': model,
        if (serial != null && serial.isNotEmpty) 'serial': serial,
        if (macAddress != null && macAddress.isNotEmpty)
          'macAddress': macAddress,
        if (notes != null && notes.isNotEmpty) 'notes': notes,
      },
    );
  }

  Future<void> removeEquipment({
    required String orderId,
    required String equipmentId,
    required int expectedVersion,
    required String idempotencyKey,
  }) async {
    await _api.post(
      '/service-orders/$orderId/equipment/$equipmentId',
      idempotencyKey: idempotencyKey,
      body: {'expectedVersion': expectedVersion},
    );
  }

  Future<void> recordContactAttempt({
    required String orderId,
    required int expectedVersion,
    required String channel,
    required String result,
    required String idempotencyKey,
    String? notes,
  }) async {
    await _api.post(
      '/service-orders/$orderId/contact-attempts',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        'channel': channel,
        'result': result,
        // Observação curta. NUNCA a transcrição da conversa.
        if (notes != null && notes.isNotEmpty) 'notes': notes,
      },
    );
  }

  Future<void> recordImpediment({
    required String orderId,
    required int expectedVersion,
    required String reason,
    required String idempotencyKey,
    String? notes,
  }) async {
    await _api.post(
      '/service-orders/$orderId/impediments',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        'reason': reason,
        if (notes != null && notes.isNotEmpty) 'notes': notes,
      },
    );
  }

  /// Recolhe (ou substitui) a assinatura do cliente.
  ///
  /// `PUT`: há no máximo uma por OS, e redesenhar substitui em vez de acumular.
  Future<void> putSignature({
    required String orderId,
    required int expectedVersion,
    required String signerName,
    required List<int> pngBytes,
    required String idempotencyKey,
  }) async {
    final form = FormData.fromMap({
      'file': MultipartFile.fromBytes(pngBytes, filename: 'assinatura.png'),
      'expectedOrderVersion': expectedVersion,
      'signerName': signerName,
    });

    await _api.upload(
      '/service-orders/$orderId/signature',
      form: form,
      idempotencyKey: idempotencyKey,
      method: 'PUT',
    );
  }

  /// Conclui o atendimento.
  ///
  /// Leva as DUAS versões: a da OS e a da execução. Colapsá-las faria um
  /// despachante mexendo na OS invalidar o texto que o técnico está digitando,
  /// e faria uma edição de texto invalidar o fechamento.
  Future<void> complete({
    required String orderId,
    required int expectedVersion,
    required int expectedExecutionVersion,
    required String idempotencyKey,
  }) async {
    await _api.post(
      '/service-orders/$orderId/complete',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        'expectedExecutionVersion': expectedExecutionVersion,
      },
    );
  }
}
