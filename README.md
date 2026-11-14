# 🖥️ StreamGrid — Multi-Screen Sharing over WebRTC

<p align="center">
  <a href="https://screenshare-p2p.onrender.com" target="_blank">
    <img src="public/icon.png" alt="StreamGrid Logo" width="90" />
  </a>
</p>

<p align="center">
  <strong>Compartilhamento simultâneo de múltiplas telas em tempo real com isolamento de áudio por processo para Windows.</strong>
</p>

<p align="center">
  <a href="https://screenshare-p2p.onrender.com">
    <img src="https://img.shields.io/badge/🌐_Live_Demo-Acessar_no_Render-46E3B7?style=for-the-badge&logo=render&logoColor=white" alt="Live Demo no Render">
  </a>
  <a href="https://github.com/Pedrosasouza/screenshare-p2p/releases/latest">
    <img src="https://img.shields.io/badge/📦_Download_Windows-Release_v1.1.0-blue?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows v1.1.0">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/WebRTC-P2P%20Mesh-3399FF?style=flat-square&logo=webrtc" alt="WebRTC">
  <img src="https://img.shields.io/badge/Rust-WASAPI%20Loopback-DEA584?style=flat-square&logo=rust" alt="Rust">
  <img src="https://img.shields.io/badge/Desktop-Tauri%20v2-FFC131?style=flat-square&logo=tauri&logoColor=black" alt="Tauri v2">
  <img src="https://img.shields.io/badge/Signaling-Node.js%20%2F%20Socket.io-339933?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
</p>

---

## 📌 O que é o StreamGrid?

O **StreamGrid** é uma aplicação de compartilhamento de tela desenvolvida para permitir que múltiplos participantes transmitam suas telas simultaneamente, com os fluxos organizados em uma grade visual e controles de volume independentes.

Além da visualização em grade, o projeto aborda um desafio comum em transmissões entre amigos e equipes: a **captura do áudio do sistema sem retransmitir a própria chamada de voz**. Na versão Desktop para Windows, um módulo nativo permite selecionar processos específicos para incluir ou excluir da captura de áudio, evitando retorno de voz sem a necessidade de instalar drivers ou cabos de áudio virtuais.

> 🚀 **Experimente no navegador:** A versão web da aplicação está hospedada e disponível para testes em:  
> **👉 [https://screenshare-p2p.onrender.com](https://screenshare-p2p.onrender.com)**

---

## ⚖️ Versão Web vs. Versão Desktop

Devido às restrições de segurança e sandbox dos navegadores (`getDisplayMedia`), determinadas operações de baixo nível no subsistema de som do sistema operacional são exclusivas do aplicativo desktop.

| Recurso | Versão Web (Navegador) | Versão Desktop (Windows) |
| :--- | :---: | :---: |
| **Acesso Imediato sem Instalação** | ✅ Sim (Link direto no Render) | ⚙️ Requer download/compilação |
| **Visualização Multi-Telas em Grade** | ✅ Sim | ✅ Sim |
| **Transmissão de Vídeo em Alta Resolução** | ✅ Sim | ✅ Sim |
| **Áudio de Abas e Sistema Básico** | ✅ Sim (nativo do navegador) | ✅ Sim |
| **Exclusão de Processos (Ex: Chamada do Discord)** | ❌ *Indisponível no browser* | ✅ **Exclusivo Desktop (Rust WASAPI)** |
| **Captura Isolada por Janela / Jogo** | ❌ *Indisponível no browser* | ✅ **Exclusivo Desktop (Rust WASAPI)** |

> [!IMPORTANT]
> **Ressalva de Áudio:**  
> A captura do som do computador com **exclusão do áudio da chamada** e a **captura seletiva por processo (PID)** funcionam exclusivamente no **aplicativo Desktop para Windows**.  
> No navegador (versão Web), o compartilhamento de áudio fica condicionado às opções oferecidas pela API padrão do navegador (áudio da aba ou dispositivo geral).

---

## 🎯 Funcionalidades Principais

### 1. Visualização & Transmissão
* **Grade Dinâmica Multi-Stream:** Visualização de múltiplas transmissões simultâneas na mesma sala, adaptando o layout conforme novos membros iniciam ou encerram transmissões.
* **Modo Spotlight & Picture-in-Picture (PiP):** Foco dedicado em uma transmissão principal com barra lateral/inferior de miniaturas (com saída rápida pela tecla `Escape`) e botão de Picture-in-Picture individual por tile para assistir em janela flutuante.
* **Controles por Transmissão & Acessibilidade:** Controle de volume individualizado para cada transmissão recebida, modo tela cheia, alternador de perfil de exibição e modais acessíveis com gerenciamento automático de foco, *focus trap* por teclado, fechamento via `Escape` e restauração do foco ao fechar.
* **Otimização de SDP:** Ajustes nos parâmetros de negociação de mídia do WebRTC (*Session Description Protocol*), incluindo configurações de áudio estéreo Opus e taxas de vídeo, para priorizar os perfis desejados de transmissão durante a sinalização.

### 2. Motor de Áudio Dedicado (Exclusivo Desktop / Rust)
* **WASAPI Loopback com Filtro por Processo (Inclusão e Exclusão):** Captura direta da sessão de áudio do Windows (`IAudioClient`), permitindo tanto isolar um aplicativo específico (PID) quanto excluir a chamada do Discord ou qualquer outro aplicativo selecionado (`exclude_discord` / `exclude_app`).
* **Monitoramento de Processo-Alvo & Fallback Limpo:** Detecção automática de encerramento do processo monitorado no motor WASAPI (com notificação na interface e remoção limpa da faixa de áudio encerrada) e fallback com único prompt de captura (`getDisplayMedia`) caso o isolamento por processo falhe.
* **Sem Dependência de Drivers Externos (VB-Cable Opcional):** Não requer instalação de cabos virtuais; caso o usuário já utilize VB-Cable, há opção explícita e opcional no modo de áudio completo do sistema (`system`).
* **Ciclo de Vida Unificado:** O módulo WASAPI em Rust é compilado diretamente no executável principal do Tauri v2, com encerramento imediato da captura ao parar a transmissão ou fechar a janela (sem processos externos ou portas locais abertas).

### 3. Gerenciamento de Salas, Servidor & Segurança
* **Salas Públicas ou Privadas:** Criação por identificadores legíveis (`grid-xxxx-xxxx`) ou códigos customizados.
* **Servidor de Sinalização Configurável:** O modal de Estatísticas & Conexão permite configurar e validar uma URL customizada de servidor de sinalização (com exigência de HTTPS fora de loopback) ou restaurar o servidor padrão.
* **Proteção por Senha Opcional:** As senhas das salas privadas são armazenadas como hashes com salt (`scrypt`) na memória do servidor.
* **CSP Estrita & Mitigação de Abusos:** Política de Segurança de Conteúdo (CSP) restritiva com `style-src 'self'` (sem estilos inline), validação estrita de `ALLOWED_ORIGINS` em produção (sem fallback wildcard `*`), rate-limiting por IP nos eventos `check-room`, `join-room` e `/ice-servers` para proteção contra brute-force/enumeração, além de sanitização contra DOM XSS.

---

## 🏗️ Arquitetura do Sistema & Decisões Técnicas

```mermaid
flowchart TD
    subgraph Host["💻 Host / Transmissor (Windows)"]
        WASAPI["🦀 Módulo WASAPI Integrado (Rust)\n• Filtro de PID (Exclusão da chamada)\n• Captura via Loopback"]
        DesktopApp["🖥️ StreamGrid App (Tauri v2 / Web)\n• WebRTC RTCPeerConnection\n• Web Audio API Mixer"]
        WASAPI -- "Fluxo PCM Interno\n(Tauri v2 IPC Channel f32le)" --> DesktopApp
    end

    subgraph Signaling["🌐 Servidor de Sinalização (Render / Node.js)"]
        Server["Node.js + Socket.io\n• Gerenciamento de Salas & Senhas\n• Troca de SDP & ICE Candidates\n• Proteção contra Brute-Force"]
    end

    subgraph Peer["📱 Visualizador / Membro"]
        PeerApp["🖥️ StreamGrid Client\n• Grid Dinâmica Multi-Stream\n• Controles de Volume Individuais"]
    end

    DesktopApp <-->|"Sinalização (Handshake Inicial)"| Server
    PeerApp <-->|"Sinalização (Handshake Inicial)"| Server

    DesktopApp <===>|"WebRTC P2P Direto (Vídeo + Áudio Opus)"| PeerApp
```

### Justificativas de Projeto

1. **Topologia WebRTC P2P (Full Mesh) vs. Servidor de Mídia Central (SFU/MCU):**
   * *Motivação:* A topologia P2P direta evita a necessidade de um servidor central de mídia para retransmitir os fluxos de vídeo, reduzindo a infraestrutura de backend necessária para grupos pequenos e permitindo a comunicação direta entre os clientes.
2. **Módulo em Rust com WASAPI vs. Drivers Virtuais:**
   * *Motivação:* A escolha de Rust permite combinar controle de baixo nível de memória com a biblioteca `windows-rs` para interagir diretamente com as APIs de sessão de áudio do Windows (WASAPI Loopback), viabilizando o filtro por processo sem depender de drivers de terceiros.
3. **Tauri v2 vs. Electron:**
   * *Motivação:* O Tauri v2 combina backend nativo em Rust no mesmo executável com o motor WebView2 já presente no Windows, eliminando processos auxiliares separados, reduzindo o consumo de memória e o tamanho de distribuição em comparação a runtimes Chromium dedicados.

---

## 💻 Como Executar Localmente

### Pré-requisitos
* [Node.js](https://nodejs.org/) (versão 18 ou superior)
* [Rust & Cargo](https://rustup.rs/) *(apenas se for recompilar o assistente de áudio a partir do código-fonte)*

### 1. Execução do Servidor Web
```bash
# Clonar o repositório
git clone https://github.com/Pedrosasouza/screenshare-p2p.git
cd screenshare-p2p

# Instalar dependências
npm install

# Iniciar servidor local
npm start
```

Acesse a interface no navegador em: `http://localhost:3000` (ou pelo endereço de IP local exibido no terminal).

---

## 📥 Download da Versão Desktop (Windows)

As versões oficiais pré-compiladas para Windows estão disponíveis diretamente na página de lançamentos:
* **Última Versão:** [GitHub Releases — StreamGrid](https://github.com/Pedrosasouza/screenshare-p2p/releases/latest)
* **Arquivo Portátil ou Instalador:** Baixe `StreamGrid-Windows.zip` (extraia e execute `StreamGrid.exe`) ou o instalador Windows gerado no release.
* **Verificação de Integridade:** Cada versão inclui o arquivo `StreamGrid-Windows.zip.sha256` para conferência de hash SHA-256 (validação de integridade do arquivo baixado contra corrupção em trânsito).
* **Aviso do Windows SmartScreen & Assinatura de Código:** Por ser um projeto open-source independente distribuído sem um certificado de assinatura Authenticode comercial pago da Microsoft, o Windows SmartScreen pode apresentar o aviso informativo *"O Windows protegeu o seu computador - Fornecedor desconhecido"*. Para abrir normalmente, clique em *"Mais informações"* e em seguida em *"Executar assim mesmo"*. Todos os pacotes são compilados publicamente a partir do código-fonte auditável via GitHub Actions com atestação de proveniência criptográfica.

---

## 📦 Compilação Manual a partir do Código-Fonte (Windows)

Se preferir compilar localmente em vez de baixar o executável pré-compilado:

```bash
npm run build-windows
```

O pacote portátil estará em `dist/StreamGrid-Windows.zip` e os instaladores em `src-tauri/target/release/bundle/`.

---

## 🧪 Bateria de Testes & Qualidade

O repositório inclui verificações estáticas e testes automatizados para validar a sinalização, UI, motor nativo em Rust e regras de segurança:

```bash
# Lint (ESLint) e checagem de tipos via JSDoc (TypeScript checkJs)
npm run lint
npm run typecheck

# Suíte principal (Sinalização, WebRTC, UI, Bridge Desktop e Segurança)
npm test

# Testes End-to-End em navegador real (Microsoft Edge Headless + CDP)
npm run test:e2e

# Testes unitários do motor de áudio WASAPI em Rust (src-tauri)
npm run test:rust
```

A suíte automatizada cobre:
* **Fuzzing & Resiliência:** Avalia a estabilidade do servidor diante de mensagens WebSocket com formatos inesperados ou incompletos (`test/fuzz-crash-test.js`).
* **Otimização de SDP & QoS:** Valida parâmetros SDP e adaptação de bitrate P2P (`test/sdp-optimization.test.js`, `test/qos-adaptation-and-modal.test.js`).
* **Hardening & Rate Limiting:** Testa bloqueios de tentativas de senha e enumeração por IP (`check-room`, `join-room`, `/ice-servers`), CSP `style-src 'self'`, `ALLOWED_ORIGINS` em produção e bloqueio de arquivos internos (`test/ip-rate-limit.test.js`, `test/server-security-hardening.test.js`).
* **Ciclo de Vida de Interface & Desktop:** Valida o fluxo multi-tela, Spotlight, PiP, acessibilidade de modais e integração da ponte Desktop (`test/screen-share-lifecycle.test.js`, `test/e2e-browser.test.js`).

---

## 🔒 Segurança & Privacidade

* **Criptografia de Mídia (DTLS/SRTP) e Canal de Sinalização:** Os fluxos de áudio e vídeo trafegam diretamente entre os participantes (P2P Mesh) protegidos por DTLS 1.2/1.3 e SRTP, sem decodificação por servidores de mídia centrais (SFU/MCU). Conforme detalhado em [PRIVACY.md](PRIVACY.md), a segurança do handshake inicial de chaves depende da integridade do canal de sinalização (HTTPS/WSS com o servidor), uma vez que o sistema não implementa verificação out-of-band de certificados entre os membros.
* **Política de Privacidade & Retenção de Dados:** Consulte [PRIVACY.md](PRIVACY.md) para detalhes completos sobre o ciclo de vida dos dados em memória volátil, a visibilidade mútua de endereços IP entre membros de uma sala (necessária para negociação ICE no WebRTC P2P) e logs temporários de infraestrutura de borda (Render).
* **Integridade dos Binários & Proveniência:** Todos os pacotes de lançamento para Windows são compilados de forma automatizada e auditável via GitHub Actions em runners isolados, acompanhados de somas de verificação SHA-256 e atestados de proveniência criptográfica gerados via Sigstore (*GitHub Artifact Attestations*).

---

## 👤 Autor

Desenvolvido por **Pedro Souza**  
* GitHub: [@Pedrosasouza](https://github.com/Pedrosasouza)  
* Portfólio: [Pedrosasouza.github.io](https://Pedrosasouza.github.io)

---

## 📄 Licença

Este projeto está licenciado sob os termos da licença [MIT](LICENSE).
