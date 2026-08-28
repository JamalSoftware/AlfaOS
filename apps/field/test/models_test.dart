import 'package:alfaos_field/core/api/idempotency.dart';
import 'package:alfaos_field/core/logging/log.dart';
import 'package:alfaos_field/features/auth/domain/session.dart';
import 'package:alfaos_field/features/notifications/domain/app_notification.dart';
import 'package:alfaos_field/features/orders/domain/service_order.dart';
import 'package:flutter_test/flutter_test.dart';

/// Mapeamento de DTO, chave de idempotência e redação de log.
void main() {
  group('status e prioridade', () {
    test('traduz os valores conhecidos', () {
      expect(OrderStatus.from('ASSIGNED'), OrderStatus.assigned);
      expect(OrderStatus.from('IN_PROGRESS'), OrderStatus.inProgress);
      expect(OrderStatus.from('COMPLETED'), OrderStatus.completed);
      expect(OrderPriority.from('URGENT'), OrderPriority.urgent);
    });

    test('status desconhecido cai em fallback seguro', () {
      // Um APK antigo diante de um estado novo continua utilizável.
      expect(OrderStatus.from('ALGO_NOVO'), OrderStatus.unknown);
      expect(OrderStatus.from(null), OrderStatus.unknown);
      expect(OrderStatus.unknown.label, isNotEmpty);
    });

    test('só prioridade elevada recebe destaque', () {
      expect(OrderPriority.urgent.isElevated, isTrue);
      expect(OrderPriority.high.isElevated, isTrue);
      expect(OrderPriority.normal.isElevated, isFalse);
      expect(OrderPriority.low.isElevated, isFalse);
    });
  });

  group('OrderSummary', () {
    Map<String, dynamic> payload({bool location = true}) => {
      'id': 'os-1',
      'number': 7,
      'status': 'ASSIGNED',
      'priority': 'NORMAL',
      'type': 'Instalação',
      'subtype': null,
      'customerName': 'Maria da Silva',
      'district': 'Centro',
      'city': 'Guaçuí',
      'scheduledAt': null,
      'hasLocation': location,
      'updatedAt': '2026-08-27T10:00:00.000Z',
      'version': 3,
    };

    test('mapeia o contrato real', () {
      final order = OrderSummary.fromJson(payload());
      expect(order.number, 7);
      expect(order.status, OrderStatus.assigned);
      expect(order.customerName, 'Maria da Silva');
      expect(order.version, 3);
      expect(order.locationLabel, 'Centro · Guaçuí');
    });

    test('sem bairro nem cidade, não inventa rótulo', () {
      final order = OrderSummary.fromJson({
        ...payload(),
        'district': null,
        'city': null,
      });
      // Nunca "null · null".
      expect(order.locationLabel, isNull);
    });
  });

  group('OrderDetail e minimização', () {
    Map<String, dynamic> detailPayload({
      Map<String, dynamic>? connection,
      Map<String, dynamic>? diagnostic,
    }) => {
      'id': 'os-1',
      'number': 7,
      'status': 'ASSIGNED',
      'priority': 'NORMAL',
      'type': 'Chamado ReceitaNet',
      'subtype': null,
      'description': 'Sem sinal.',
      'scheduledAt': null,
      'assignedAt': '2026-08-27T09:00:00.000Z',
      'startedAt': null,
      'updatedAt': '2026-08-27T10:00:00.000Z',
      'version': 3,
      'customer': <String, dynamic>{
        'name': 'Maria da Silva',
        'phone': '(28) 99999-0001',
        'secondaryPhone': '(28) 99999-0002',
        'address': 'Rua das Flores',
        'number': '84',
        'complement': 'fundos',
        'district': 'Centro',
        'city': 'Guaçuí',
        'state': 'ES',
        'zipCode': '29560-000',
        'latitude': -20.7746,
        'longitude': -41.6789,
      },
      'connection': connection,
      'execution': null,
      'diagnostic': diagnostic,
    };

    test('mapeia cliente, endereço e coordenada', () {
      final order = OrderDetail.fromJson(detailPayload());
      expect(order.customer.phones, hasLength(2));
      expect(order.customer.hasUsableCoordinates, isTrue);
      expect(order.customer.formattedAddress, contains('Rua das Flores, 84'));
      expect(order.customer.formattedAddress, contains('fundos'));
      expect(order.canStart, isTrue);
    });

    test('OS EXTERNAL do ReceitaNet é indistinguível de uma interna', () {
      /*
        O backend não envia `origin`, `externalProvider`, `externalId` nem
        `externalNumber` — e o modelo não os tem. Como o dado não desce, não
        existe `if (RECEITANET)` possível no aplicativo: a ausência é a
        garantia, não uma convenção que alguém possa quebrar.
      */
      final order = OrderDetail.fromJson(detailPayload());
      expect(order.type, 'Chamado ReceitaNet');

      final campos = OrderDetail.fromJson(detailPayload()).toString();
      expect(campos, isNot(contains('externalProvider')));
      expect(campos, isNot(contains('externalId')));
    });

    test('endereço incompleto não vira "null"', () {
      final payload = detailPayload();
      (payload['customer'] as Map)['number'] = null;
      (payload['customer'] as Map)['complement'] = null;
      (payload['customer'] as Map)['state'] = null;

      final address = OrderDetail.fromJson(payload).customer.formattedAddress!;
      expect(address, isNot(contains('null')));
      expect(address, contains('Rua das Flores'));
    });

    test('coordenada (0,0) é recusada para navegação', () {
      final payload = detailPayload();
      (payload['customer'] as Map)['latitude'] = 0;
      (payload['customer'] as Map)['longitude'] = 0;

      // Fica no Atlântico, e é o que um cadastro vazio devolve. Mandar um
      // técnico para lá é pior que não oferecer navegação.
      expect(
        OrderDetail.fromJson(payload).customer.hasUsableCoordinates,
        isFalse,
      );
    });

    test('coordenada fora de faixa é recusada', () {
      final payload = detailPayload();
      (payload['customer'] as Map)['latitude'] = 120.0;

      expect(
        OrderDetail.fromJson(payload).customer.hasUsableCoordinates,
        isFalse,
      );
    });

    test('sem telefone, a lista fica vazia em vez de conter nulo', () {
      final payload = detailPayload();
      (payload['customer'] as Map)['phone'] = null;
      (payload['customer'] as Map)['secondaryPhone'] = null;

      expect(OrderDetail.fromJson(payload).customer.phones, isEmpty);
    });

    test('conexão traz metadado, e o modelo não tem campo de senha', () {
      final order = OrderDetail.fromJson(
        detailPayload(
          connection: {
            'id': 'conn-1',
            'type': 'PPPOE',
            'username': '11-teixeira-ftth',
            'passwordConfigured': true,
          },
        ),
      );
      expect(order.connection!.username, '11-teixeira-ftth');
      expect(order.connection!.passwordConfigured, isTrue);
      // Não existe `password` em `OrderConnection`: o texto claro só existe na
      // resposta da revelação, em memória, e nunca num modelo persistível.
      expect(order.connection.toString(), isNot(contains('password:')));
    });

    test('diagnóstico desconhecido não vira offline', () {
      final order = OrderDetail.fromJson(
        detailPayload(
          diagnostic: {'connectivityStatus': 'UNKNOWN', 'observedAt': null},
        ),
      );
      expect(order.diagnostic!.isOffline, isFalse);
      expect(order.diagnostic!.isOnline, isFalse);
      expect(order.diagnostic!.label, 'Desconhecido');
    });
  });

  group('FieldSession', () {
    test('lê contexto e capabilities', () {
      final session = FieldSession.fromJson({
        'user': {'id': 'u1', 'name': 'Tecnico Alfa', 'email': 't@a.test'},
        'technician': {'id': 't1', 'active': true, 'executionIssue': null},
        'company': {'id': 'c1', 'name': 'Alfa Telecom'},
        'device': {'id': 'd1', 'platform': 'ANDROID'},
        'capabilities': {
          'listOrders': true,
          'startOrder': true,
          'revealConnectionPassword': true,
          'refreshDiagnostic': true,
        },
      });

      expect(session.firstName, 'Tecnico');
      expect(session.canStartOrder, isTrue);
      expect(session.executionIssue, isNull);
    });

    test('técnico inelegível traz o motivo do servidor', () {
      final session = FieldSession.fromJson({
        'user': {'id': 'u1', 'name': 'X', 'email': 'x@a.test'},
        'technician': {
          'id': 't1',
          'active': false,
          'executionIssue': 'Seu cadastro de técnico está inativo.',
        },
        'company': {'id': 'c1', 'name': 'Alfa'},
        'device': {'id': 'd1', 'platform': 'ANDROID'},
        'capabilities': {'listOrders': true, 'startOrder': false},
      });

      // Leitura continua; escrita não. A frase vem pronta do servidor.
      expect(session.canStartOrder, isFalse);
      expect(session.executionIssue, isNotNull);
    });
  });

  group('notificações', () {
    test('mapeia e distingue lida de não lida', () {
      final unread = AppNotification.fromJson({
        'id': 'n1',
        'type': 'SERVICE_ORDER_ASSIGNED',
        'title': 'Nova OS atribuída',
        'body': 'OS Nº 7 · Instalação',
        'resourceType': 'ServiceOrder',
        'resourceId': 'os-1',
        'readAt': null,
        'createdAt': '2026-08-27T10:00:00.000Z',
      });

      expect(unread.isUnread, isTrue);
      expect(unread.pointsToServiceOrder, isTrue);
      expect(unread.markedRead(DateTime.now()).isUnread, isFalse);
    });

    test('sem resourceId não navega', () {
      final n = AppNotification.fromJson({
        'id': 'n2',
        'type': 'X',
        'title': 'T',
        'body': 'B',
        'resourceType': null,
        'resourceId': null,
        'readAt': null,
        'createdAt': '2026-08-27T10:00:00.000Z',
      });
      expect(n.pointsToServiceOrder, isFalse);
    });
  });

  group('chave de idempotência', () {
    test('cada intenção gera uma chave distinta', () {
      final a = IdempotencyKey.forOperation('start');
      final b = IdempotencyKey.forOperation('start');
      expect(a, isNot(b));
    });

    test('respeita o formato que o backend valida', () {
      final key = IdempotencyKey.forOperation('service-order.start');
      // 8–200 caracteres em [A-Za-z0-9._:-]
      expect(key.length, greaterThanOrEqualTo(8));
      expect(key.length, lessThanOrEqualTo(200));
      expect(RegExp(r'^[A-Za-z0-9._:-]+$').hasMatch(key), isTrue);
    });
  });

  group('redação de log', () {
    test('mascara segredo em qualquer profundidade', () {
      final redigido = Log.redact({
        'authorization': 'Bearer abc123',
        'nested': {
          'password': 'senha-secreta',
          'pushToken': 'fcm-token',
          'lista': [
            {'token': 'outro-token'},
          ],
        },
        'ok': 'valor-comum',
      }).toString();

      expect(redigido, isNot(contains('abc123')));
      expect(redigido, isNot(contains('senha-secreta')));
      expect(redigido, isNot(contains('fcm-token')));
      expect(redigido, isNot(contains('outro-token')));
      // Controle positivo: o que não é segredo continua legível, senão o teste
      // passaria com uma função que apaga tudo.
      expect(redigido, contains('valor-comum'));
    });

    test('mascara dado pessoal que não serve para depurar', () {
      final redigido = Log.redact({
        'phone': '(28) 99999-0001',
        'address': 'Rua das Flores',
        'document': '12345678901',
      }).toString();

      expect(redigido, isNot(contains('99999-0001')));
      expect(redigido, isNot(contains('Rua das Flores')));
      expect(redigido, isNot(contains('12345678901')));
    });
  });
}
