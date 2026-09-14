import 'dart:math' as math;

import 'package:alfaos_field/core/location/location_service.dart';
import 'package:alfaos_field/features/execution/domain/execution.dart';
import 'package:alfaos_field/features/execution/domain/location_confirm.dart';
import 'package:flutter_test/flutter_test.dart';

/// # "Confirmar localização" — a medida do aplicativo (RC-1C)
///
/// O aplicativo mostra a distância e desabilita "Confirmar" acima do limite
/// que o servidor mandou. Para isso não virar uma segunda regra, a conta tem de
/// ser a MESMA do servidor: estes vetores são os de
/// `src/tests/customer-location-confirm.test.ts`, ponto por ponto.

const _raio = 6371008.8;
const _p = (latitude: -20.3155, longitude: -40.3128);

({double latitude, double longitude}) _aNorte(double metros) => (
  latitude: _p.latitude + (metros / _raio) * 180 / math.pi,
  longitude: _p.longitude,
);

int _ateP(({double latitude, double longitude}) o) => distanceInMeters(
  fromLatitude: o.latitude,
  fromLongitude: o.longitude,
  toLatitude: _p.latitude,
  toLongitude: _p.longitude,
);

ExecutionLocation _ponto({int? limite = 100}) => ExecutionLocation(
  status: LocationStatus.unconfirmed,
  latitude: _p.latitude,
  longitude: _p.longitude,
  version: 0,
  confirmMaxDistanceMeters: limite,
);

LocationReading _leitura(
  ({double latitude, double longitude}) o, {
  int? precisao = 9,
}) => LocationReading.ok(
  DeviceLocation(
    latitude: o.latitude,
    longitude: o.longitude,
    accuracyMeters: precisao,
  ),
);

void main() {
  group('distância — a mesma conta do servidor', () {
    for (final metros in [0, 20, 99, 100, 101, 500, 2357]) {
      test('um ponto $metros m ao norte mede $metros m', () {
        expect(_ateP(_aNorte(metros.toDouble())), metros);
      });
    }

    test('leste–oeste encolhe com a latitude: 0,001° a 23,55° S ≈ 102 m', () {
      final d = distanceInMeters(
        fromLatitude: -23.55,
        fromLongitude: -46.63,
        toLatitude: -23.55,
        toLongitude: -46.631,
      );
      expect(d, inInclusiveRange(101, 103));
    });

    test('São Paulo–Rio fica perto de 360 km, não dos ~392 km planos', () {
      final d = distanceInMeters(
        fromLatitude: -23.5505,
        fromLongitude: -46.6333,
        toLatitude: -22.9068,
        toLongitude: -43.1729,
      );
      expect(d, inExclusiveRange(355000, 365000));
    });

    test('arredonda para o metro inteiro, como o servidor', () {
      expect(_ateP(_aNorte(100.4)), 100);
      expect(_ateP(_aNorte(100.6)), 101);
    });
  });

  group('formato', () {
    test('metros abaixo de 1 km, quilômetros com vírgula a partir dele', () {
      expect(formatDistanceMeters(0), '0 m');
      expect(formatDistanceMeters(82), '82 m');
      expect(formatDistanceMeters(999), '999 m');
      expect(formatDistanceMeters(1000), '1,00 km');
      expect(formatDistanceMeters(2357), '2,36 km');
    });
  });

  group('a decisão, com o limite do servidor', () {
    test('a 100 m: pode confirmar (inclusivo)', () {
      final c = ConfirmLocationCheck.evaluate(
        location: _ponto(),
        reading: _leitura(_aNorte(100)),
      );
      expect(c.distanceMeters, 100);
      expect(c.withinLimit, isTrue);
    });

    test('a 101 m: não pode', () {
      final c = ConfirmLocationCheck.evaluate(
        location: _ponto(),
        reading: _leitura(_aNorte(101)),
      );
      expect(c.hasPosition, isTrue);
      expect(c.withinLimit, isFalse);
    });

    test('o número é o do pacote: com 50 m, 80 m não pode', () {
      final c = ConfirmLocationCheck.evaluate(
        location: _ponto(limite: 50),
        reading: _leitura(_aNorte(80)),
      );
      expect(c.withinLimit, isFalse);
    });

    test('sem GPS: nem distância, nem confirmação', () {
      final c = ConfirmLocationCheck.evaluate(
        location: _ponto(),
        reading: const LocationReading.failed(LocationOutcome.permissionDenied),
      );
      expect(c.hasPosition, isFalse);
      expect(c.distanceMeters, isNull);
      expect(c.withinLimit, isFalse);
    });

    test(
      'servidor anterior à RC-1C (sem limite): o app não bloqueia sozinho',
      () {
        final c = ConfirmLocationCheck.evaluate(
          location: _ponto(limite: null),
          reading: _leitura(_aNorte(2357)),
        );
        expect(c.withinLimit, isTrue);
      },
    );

    test('o pacote traz o limite pelo JSON', () {
      final l = ExecutionLocation.fromJson({
        'status': 'UNCONFIRMED',
        'latitude': _p.latitude,
        'longitude': _p.longitude,
        'version': 3,
        'confirmMaxDistanceMeters': 100,
      });
      expect(l.confirmMaxDistanceMeters, 100);
    });
  });
}
