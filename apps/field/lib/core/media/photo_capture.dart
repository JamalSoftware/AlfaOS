import 'dart:io';

import 'package:image_picker/image_picker.dart';

import '../logging/log.dart';

/// Captura de foto para evidência.
///
/// Abstraído pelo mesmo motivo do GPS: um widget test não tem câmera, e sem
/// esta fronteira toda tela que anexa foto viraria intestável.
///
/// ## Compressão na origem
///
/// A foto é reduzida ANTES de sair do aparelho. Uma câmera de 50 MP produz
/// arquivo de dezenas de megabytes, e o teto do servidor é 8 MB — mas o
/// problema real não é o teto: é a rede do técnico. Enviar o original em borda
/// de sinal transforma um anexo de trinta segundos numa espera indefinida, e o
/// técnico contorna deixando de fotografar. A regra que atrapalha o registro
/// produz menos evidência, não mais (PRD §163).
///
/// 1600 px no maior lado e qualidade 80 preservam serial de ONU legível e
/// acabamento de instalação, que é o que a foto precisa provar.
library;

abstract class PhotoCapture {
  /// Abre a câmera. `null` quando o técnico desiste.
  Future<File?> takePhoto();

  /// Abre a galeria — para a foto que já foi tirada antes de abrir a OS.
  Future<File?> pickFromGallery();
}

class ImagePickerPhotoCapture implements PhotoCapture {
  const ImagePickerPhotoCapture();

  static const _maxDimension = 1600.0;
  static const _quality = 80;

  @override
  Future<File?> takePhoto() => _pick(ImageSource.camera);

  @override
  Future<File?> pickFromGallery() => _pick(ImageSource.gallery);

  Future<File?> _pick(ImageSource source) async {
    try {
      final picked = await ImagePicker().pickImage(
        source: source,
        maxWidth: _maxDimension,
        maxHeight: _maxDimension,
        imageQuality: _quality,
      );
      return picked == null ? null : File(picked.path);
    } catch (error) {
      // Câmera indisponível ou permissão negada não derruba a tela: o técnico
      // continua o atendimento e anexa depois.
      Log.error('falha ao capturar foto', error: error);
      return null;
    }
  }
}
