# Code Signing Policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

---

## 1. Overview & Objectives

This document outlines the code signing policy, security governance, and build integrity practices for **StreamGrid** (`screenshare-p2p`), an open-source real-time multi-screen sharing application maintained by Pedro Souza.

The objective of code signing is to ensure:
* **Authenticity:** End users can verify that executables and packages originate from the legitimate StreamGrid project and have not been altered or tampered with by third parties.
* **Integrity:** Operating systems (such as Windows SmartScreen) and security tools can validate the cryptographic digital signatures of distributed binaries.
* **Auditability:** Complete traceability between publicly auditable source code in the Git repository and the compiled binary artifacts.

---

## 2. Project Roles & Responsibilities

In accordance with SignPath Foundation guidelines, the project defines the following administrative and development roles:

* **Author:**  
  * **Pedro Souza** ([@Pedrosasouza](https://github.com/Pedrosasouza))  
  * *Responsibilities:* Writing source code, implementing features, fixing security vulnerabilities, and creating pull requests and commits.
* **Reviewer:**  
  * **Pedro Souza** ([@Pedrosasouza](https://github.com/Pedrosasouza))  
  * *Responsibilities:* Reviewing all incoming code modifications, inspecting third-party dependency updates, and verifying test suite execution.
* **Approver:**  
  * **Pedro Souza** ([@Pedrosasouza](https://github.com/Pedrosasouza))  
  * *Responsibilities:* Authorizing release builds, tagging official semantic versions, and initiating code signing requests for release artifacts.

---

## 3. Account Security & Multi-Factor Authentication (MFA)

* **Mandatory MFA:** Multi-Factor Authentication (MFA / 2FA) is strictly required and enforced on all maintainer accounts, including GitHub and SignPath.
* **Secret Protection:** Signing credentials, API tokens, and access keys are stored exclusively as encrypted repository secrets in GitHub (`SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID`) and are never committed to version control or printed in CI logs.

---

## 4. Build Pipeline & Build Integrity

* **Automated CI/CD Only:** All official release binaries are compiled exclusively via automated GitHub Actions workflows running in clean, ephemeral Microsoft Windows virtual environments (`windows-latest`).
* **No Local Machine Signing:** Binaries compiled on personal workstations or local developer environments are **never** submitted for code signing.
* **Deterministic Build Triggers:** Signing workflows are triggered exclusively by version tags (`v*`) created by authorized project maintainers.
* **Automated Quality & Security Gates:** Every build must successfully pass automated WebRTC security tests, fuzzing tests, and token lifecycle tests (`npm test` and `npm run test:helper`) prior to packaging and signing.

---

## 5. Scope of Code Signing

The following artifacts fall within the scope of this code signing policy:
* **`StreamGrid-win_x64.exe`**: The main desktop runtime executable based on Neutralinojs.
* **`streamgrid-audio-helper.exe`**: The native companion process for Windows WASAPI loopback audio capture and process filtering.
* **`StreamGrid-Windows.zip`**: The portable Windows distribution archive containing the application bundle and assets.

---

## 6. Verification by End Users

Every official release published on [GitHub Releases](https://github.com/Pedrosasouza/screenshare-p2p/releases) includes:
1. The digitally signed binary package.
2. An official cryptographic checksum file (`StreamGrid-Windows.zip.sha256`).

Users can verify release integrity in Windows PowerShell with:
```powershell
Get-FileHash -Algorithm SHA256 StreamGrid-Windows.zip
```
Compare the output against the hash published in the `.sha256` asset to confirm binary authenticity.
