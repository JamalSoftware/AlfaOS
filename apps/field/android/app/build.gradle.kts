plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

/*
    Google Services: aplicado SOMENTE quando o google-services.json existe.

    O plugin gera recursos nativos a partir daquele arquivo, e FALHA o build
    quando ele falta. Aplicando-o incondicionalmente, ninguem conseguiria
    compilar o Field sem antes ter acesso ao projeto Firebase da plataforma —
    nem para rodar em emulador, nem para abrir um APK de depuracao.

    Com a condicao, os dois estados sao validos e explicitos:

      sem o arquivo   o APK compila, o app roda, o push fica indisponivel
      com o arquivo   o plugin entra e o push funciona

    O arquivo NAO e versionado (ver .gitignore). Ele e configuracao de
    CLIENTE, e nao a credencial de servidor — essa vive so no worker, no
    firebase-admin, e nunca chega ao aparelho.
*/
val googleServicesJson = file("google-services.json")
if (googleServicesJson.exists()) {
    apply(plugin = "com.google.gms.google-services")
} else {
    logger.lifecycle(
        "[alfaos] google-services.json ausente: push desativado neste build.",
    )
}

android {
    namespace = "com.jamalsoftware.alfaos.field"

    // Fixado em 37 porque `flutter_secure_storage` 11 o exige — sem isto o
    // build falha em `checkDebugAarMetadata`. Compilar contra 37 NAO muda em
    // quais aparelhos o app instala; quem decide isso e o `minSdk` abaixo.
    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.jamalsoftware.alfaos.field"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
