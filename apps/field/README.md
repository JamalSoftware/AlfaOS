# AlfaOS Field — aplicativo do técnico (Alpha)

Aplicativo Android em Flutter que consome a **Field API** do AlfaOS
(`/api/field/v1`). Contrato completo em [`docs/FIELD-API.md`](../../docs/FIELD-API.md);
segurança em [`docs/SECURITY.md`](../../docs/SECURITY.md) §8.13.

```text
Flutter  →  AlfaOS Field API  →  Services/Application  →  Domain  →  PostgreSQL
```

Nunca `Flutter → ReceitaNet`. Nunca `Flutter → OLT`. Nunca `Flutter → banco`.

> **O aplicativo não decide nada.** Máquina de estados, posse, elegibilidade,
> compare-and-set e validação de conclusão vivem no domínio do AlfaOS. Aqui só
> se autentica, projeta e chama — e é por isso que a tela nunca "corrige" uma
> recusa do servidor.

---

## Pré-requisitos

| | |
|---|---|
| Flutter | 3.47.2 (stable) — Dart 3.13.2 |
| Android SDK | 37 |
| JDK | o do Android Studio |
| Aparelho | Android 6.0+ (o APK Alpha foi validado em Android 14, arm64) |

```bash
flutter doctor
```

Android verde basta. Visual Studio é irrelevante aqui.

---

## Configurar a URL da API

A URL **não** é constante de código: entra por `--dart-define`, para que o
mesmo binário sirva a notebook, homologação e produção — e para que nenhum IP
pessoal vire commit.

```bash
flutter run --dart-define=ALFAOS_API_BASE_URL=http://192.168.0.10:3000
```

O padrão, sem `--dart-define`, é `http://10.0.2.2:3000` — que é como o
**emulador** enxerga a máquina hospedeira.

### Aparelho físico

`localhost`, dentro do celular, é o próprio celular. Num aparelho real:

1. PC e celular na **mesma rede Wi-Fi**;
2. suba o backend escutando em todas as interfaces:

```bash
npm run dev -- --hostname 0.0.0.0
```

3. descubra o IP de rede local do PC (`ipconfig`) e passe-o:

```bash
flutter run --dart-define=ALFAOS_API_BASE_URL=http://SEU_IP_LAN:3000
```

HTTP em claro funciona **apenas em debug** — o manifesto de debug libera
cleartext, e ele não entra no APK de release. Produção exige HTTPS, e essa
obrigação não depende de ninguém lembrar de reverter uma flag.

---

## Rodar, testar, empacotar

```bash
flutter pub get
```

```bash
flutter analyze
```

```bash
flutter test
```

```bash
flutter build apk --debug
```

O APK sai em `build/app/outputs/flutter-apk/app-debug.apk`.

Instalar num aparelho conectado:

```bash
flutter install
```

**Release assinado não é gerado** — não há keystore oficial, e assinar com
chave de depuração produziria um artefato que não serve para distribuir.

---

## Arquitetura

```text
lib/
├── app/           router, tema, providers, shell
├── core/          api, erros, storage, logging, launchers, widgets, sync
└── features/
    ├── auth/      login, sessão, dispositivo
    ├── orders/    fila, detalhe, comandos
    ├── notifications/
    └── settings/
```

Cada feature separa `domain/` (modelo), `data/` (repositório), `state/`
(controlador) e `ui/` (tela). Sem cerimônia de camadas: quatro pastas, não
doze.

| decisão | escolha | por quê |
|---|---|---|
| estado | **Riverpod** | acessível fora da árvore (a rede sinaliza sessão encerrada), `AsyncValue` já é a forma de toda tela, e substituir provider em teste é nativo |
| navegação | **go_router** | declarativa, com um único `redirect` como guarda — tela nenhuma verifica sessão por conta própria, então nenhuma pode esquecer |
| HTTP | **Dio** | interceptação e adaptador substituível, o que permite testar o cliente real contra transporte falso |
| erro | **exceção**, nunca `Either` | uma estratégia só; Riverpod captura exceção sem adaptador |

### Um cliente, um lugar

`FieldApiClient` concentra URL base, `Authorization`, timeouts, tradução do
contrato de erro e redação de log. Nenhuma tela fala HTTP — espalhar isso
significaria que uma tela nova um dia esqueceria o Bearer ou a redação.

---

## Segurança

- **Token no cofre da plataforma** (`flutter_secure_storage` → Keystore).
  Nunca em `SharedPreferences`, arquivo ou banco local.
- **`Authorization: Bearer` e nada mais.** Nunca cookie, nunca query string —
  a URL entra em log de servidor, histórico e `Referer`.
- **Senha PPPoE não é persistida.** Ela é revelada sob demanda, vive em
  memória enquanto a tela está aberta, e "Ocultar" **descarta** o texto claro.
  Cache offline é armazenamento durável num aparelho que é roubado.
- **Log redigido em um ponto só**, e apenas em debug: `Authorization`, senha,
  token de push, telefone e endereço são mascarados na saída, não na chamada.
- **Uma permissão**: `INTERNET`. Sem câmera, sem localização, sem
  armazenamento, sem telefone — discar e navegar acontecem por Intent.
- **O corpo do login não escolhe autorização.** `companyId`, `userId`,
  `technicianId` e perfil não são enviados: quem os decide é o servidor.
- **Identidade de instalação por UUID**, gerado na primeira execução. Nunca
  IMEI, Android ID ou número de telefone — número é reciclado pela operadora e
  pertence à pessoa.

### Sessão

| situação | o que acontece |
|---|---|
| 401 | token apagado, volta ao login, **uma** vez — sem laço |
| `DEVICE_REVOKED` | tela própria: "fale com o administrador". Não pede a senha de novo |
| sem rede na abertura | estado de reconexão, **credencial preservada** — internet caindo não desloga ninguém |
| logout sem rede | limpa localmente assim mesmo; sair tem de funcionar offline |

---

## O que a Alpha faz

Login · registro de dispositivo · `/me` · Minhas OS com paginação por cursor ·
detalhe operacional · dois telefones com discador · Google Maps e Waze ·
PPPoE com máscara fixa e revelação explícita · diagnóstico com atualização ·
iniciar atendimento (idempotência + `expectedVersion`) · central de
notificações com marcar como lida · tema Claro/Escuro/Sistema · logout.

## O que a Alpha **não** faz

Fotos e evidências · materiais · assinatura · checklist · **conclusão de OS** ·
fila offline de mutações · FCM real · toolbox (Wi-Fi, speed test, OLT, ONU,
RADIUS, ACS/TR-069) · inventário · PTT · IA.

Nada disso está pela metade: o que não existe, não existe. O botão de
**concluir** é ausência deliberada — a conclusão depende de checklist, fotos,
materiais e assinatura, e a validação é do servidor. Um "concluir" incompleto
produziria OS fechadas sem evidência.

### Offline

O PRD classifica offline como P0 da trilha Field, e o backend já entrega o que
ele precisa: idempotência escopada, `version`/CAS e semântica determinística de
conflito. **O motor no cliente não existe nesta Alpha** — construí-lo com uma
única mutação implementada produziria um mecanismo sem consumidor.

O contrato está nomeado em `lib/core/sync/pending_operation.dart`
(`PENDING → SYNCING → SYNCED / CONFLICT / FAILED`), porque decidir nomes é
barato agora e caro depois.

### Push

`PushRegistrationService` existe como ponto de extensão e devolve `null`. O FCM
exigiria projeto no Google e credencial de serviço. **Nada no aplicativo afirma
que push funciona** — e enquanto ele não existir, a central de notificações é o
único caminho pelo qual uma atribuição chega ao técnico.

---

## Testes

```bash
flutter test
```

O transporte HTTP é substituído por um `HttpClientAdapter` falso — a tela, o
controlador, o repositório e o cliente são os de produção. Fakes, não mocks: um
mock do repositório testaria a reimplementação, não o código.

Cobrem, entre outros: tradução dos dez códigos de erro, código desconhecido sem
estouro, 401 que limpa a sessão *versus* `DEVICE_REVOKED` que não limpa, corpo
de login sem campos de autorização, endereço incompleto que não vira `"null"`,
coordenada `(0,0)` recusada, máscara PPPoE de tamanho fixo, revelação e
descarte, falha de diagnóstico que **não** vira OFFLINE falso, duplo toque que
não duplica mutação, 409 que recarrega em vez de sobrescrever, e a jornada
login → fila → detalhe → iniciar.
