import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

/// Captura da assinatura do cliente.
///
/// ## Sem dependência
///
/// Um `CustomPainter` e um `GestureDetector`. Trazer um pacote para desenhar
/// uma polilinha seria superfície de terceiro — atualização, permissão,
/// abandono — em troca de cem linhas.
///
/// ## Fundo branco e tinta escura, fixos
///
/// É a única exceção deliberada à regra de tokens de tema do projeto, e pelo
/// mesmo motivo que `SignatureCanvas` da web: isto não é interface, é uma
/// IMAGEM renderizada que sai do aplicativo e vai para um relatório. Assinatura
/// clara sobre fundo escuro viraria um retângulo preto no PDF.
///
/// ## O que ela é, e o que não é
///
/// A assinatura confirma recebimento e execução do serviço. Ela **não**
/// autentica juridicamente a identidade de quem assinou além do que o contrato
/// entre empresa e cliente já previr, e o aplicativo não afirma o contrário em
/// lugar nenhum.
class SignaturePad extends StatefulWidget {
  const SignaturePad({super.key, required this.controller, this.height = 220});

  final SignaturePadController controller;
  final double height;

  @override
  State<SignaturePad> createState() => _SignaturePadState();
}

/// Guarda os traços e sabe virar PNG.
class SignaturePadController extends ChangeNotifier {
  final List<List<Offset>> _strokes = [];
  Size _size = Size.zero;

  List<List<Offset>> get strokes => List.unmodifiable(_strokes);

  /// Há traço suficiente para chamar de assinatura?
  ///
  /// Um toque acidental produz um traço de um ponto. Exigir movimento real
  /// evita enviar um ponto como se fosse assinatura — e o servidor não tem como
  /// distinguir isso: um PNG de um pixel preto é uma imagem válida.
  bool get hasSignature =>
      _strokes.any((stroke) => stroke.length > 2) &&
      _totalLength > _minimumLength;

  static const _minimumLength = 40.0;

  double get _totalLength {
    var total = 0.0;
    for (final stroke in _strokes) {
      for (var i = 1; i < stroke.length; i++) {
        total += (stroke[i] - stroke[i - 1]).distance;
      }
    }
    return total;
  }

  void startStroke(Offset point) {
    _strokes.add([point]);
    notifyListeners();
  }

  void extendStroke(Offset point) {
    if (_strokes.isEmpty) return;
    _strokes.last.add(point);
    notifyListeners();
  }

  void clear() {
    _strokes.clear();
    notifyListeners();
  }

  void setSize(Size size) => _size = size;

  /// Renderiza os traços num PNG.
  ///
  /// `null` quando não há assinatura — quem chama nunca envia um canvas em
  /// branco, e o servidor recusa imagem vazia de qualquer forma.
  Future<Uint8List?> toPngBytes() async {
    if (!hasSignature || _size.isEmpty) return null;

    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);

    // Fundo branco explícito: um PNG transparente sobre papel branco some, e
    // sobre fundo escuro de visualizador vira um borrão.
    canvas.drawRect(
      Rect.fromLTWH(0, 0, _size.width, _size.height),
      Paint()..color = const Color(0xFFFFFFFF),
    );

    _paintStrokes(canvas, _strokes);

    final picture = recorder.endRecording();
    final image = await picture.toImage(
      _size.width.round(),
      _size.height.round(),
    );
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    picture.dispose();
    return data?.buffer.asUint8List();
  }
}

void _paintStrokes(Canvas canvas, List<List<Offset>> strokes) {
  final paint = Paint()
    ..color = const Color(0xFF111827)
    ..strokeWidth = 2.6
    ..strokeCap = StrokeCap.round
    ..strokeJoin = StrokeJoin.round
    ..style = PaintingStyle.stroke;

  for (final stroke in strokes) {
    if (stroke.length < 2) {
      // Um ponto isolado ainda é tinta no papel: desenha um pingo.
      if (stroke.length == 1) {
        canvas.drawCircle(stroke.first, 1.3, paint..style = PaintingStyle.fill);
        paint.style = PaintingStyle.stroke;
      }
      continue;
    }
    final path = Path()..moveTo(stroke.first.dx, stroke.first.dy);
    for (var i = 1; i < stroke.length; i++) {
      path.lineTo(stroke[i].dx, stroke[i].dy);
    }
    canvas.drawPath(path, paint);
  }
}

class _SignaturePadState extends State<SignaturePad> {
  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final size = Size(constraints.maxWidth, widget.height);
        widget.controller.setSize(size);

        return GestureDetector(
          onPanStart: (details) =>
              widget.controller.startStroke(details.localPosition),
          onPanUpdate: (details) =>
              widget.controller.extendStroke(details.localPosition),
          child: Container(
            width: size.width,
            height: size.height,
            decoration: BoxDecoration(
              // Branco fixo: ver o comentário da classe.
              color: const Color(0xFFFFFFFF),
              border: Border.all(color: const Color(0xFF9CA3AF)),
              borderRadius: BorderRadius.circular(12),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: AnimatedBuilder(
                animation: widget.controller,
                builder: (context, _) => CustomPaint(
                  size: size,
                  painter: _SignaturePainter(widget.controller.strokes),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _SignaturePainter extends CustomPainter {
  const _SignaturePainter(this.strokes);

  final List<List<Offset>> strokes;

  @override
  void paint(Canvas canvas, Size size) => _paintStrokes(canvas, strokes);

  // Os traços mudam a cada movimento do dedo, e a lista é recriada: comparar
  // conteúdo custaria mais que repintar.
  @override
  bool shouldRepaint(_SignaturePainter oldDelegate) => true;
}
