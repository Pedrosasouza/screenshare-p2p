# Privacy Policy for StreamGrid

Last updated: October 2026

**StreamGrid** is an open-source real-time multi-screen sharing application developed by Pedro Souza. This Privacy Policy explains how StreamGrid handles information across both the web application and the Windows desktop package.

StreamGrid is designed with a strict privacy-first architecture: we do not collect personal identifying information, sell user data, or inject third-party trackers or advertisements.

---

## 1. Peer-to-Peer (WebRTC) Media Streams & Cryptographic Model

* **Direct Transmission:** All audio and video streams transmitted between participants in a room travel directly peer-to-peer (P2P Mesh) via WebRTC.
* **Media Encryption (DTLS/SRTP):** Peer-to-peer connections utilize industry-standard cryptographic protocols (DTLS 1.2/1.3 and SRTP). Media payloads are encrypted and authenticated directly between peers and never pass through a central media server (SFU/MCU).
* **Signaling Trust Model:** Users should understand the cryptographic boundaries of WebRTC signaling: during connection setup, DTLS certificate fingerprints are exchanged in Session Description Protocol (SDP) messages via the signaling server. Because StreamGrid does not currently implement out-of-band identity verification (such as Short Authentication Strings or independent public key pinning), the confidentiality of the session against active Man-in-the-Middle (MitM) attacks depends on the integrity of the signaling channel (HTTPS/WSS connection to the signaling host).
* **Peer IP Visibility in WebRTC:** Because StreamGrid establishes direct P2P connections without an intermediary relay server, WebRTC relies on ICE candidates to discover viable network paths. Participating in a room requires exchanging ICE candidates that reveal your public and local IP addresses directly to the other peers in that room.
* **No Media Recording or Storage:** StreamGrid does not record, archive, analyze, or inspect video or audio streams.

---

## 2. Signaling Server & Ephemeral Room Data

The signaling server coordinates the initial WebRTC connection setup:
* **Application-Level Privacy:** The application server (Node.js/Socket.io) does not write access logs to persistent disk, database storage, or third-party analytics services. Server console output tracks ephemeral socket connection and room lifecycle events without printing or recording client IP addresses.
* **Session Metadata:** The server facilitates the exchange of SDP offers, answers, and ICE candidates between clients. Once the peer-to-peer connection is established, ongoing media traffic does not traverse the signaling server.
* **Room Passwords:** When a private room is created with a password, the password is never stored in plain text. It is hashed using cryptographic hashing with random salts (`scrypt`) in server memory.
* **Ephemeral Lifecycle:** Room states, participant sockets, and password hashes exist solely in volatile memory during the active session. Once all participants leave a room, the room and its associated state are evicted from memory.
* **Abuse Prevention & Rate Limiting:** The server maintains temporary, rolling counters in memory to prevent brute-force password guessing and denial-of-service attempts. IP addresses used for rate limiting are stored in a volatile in-memory map and automatically evicted after 10 minutes of inactivity; they are never logged persistently or linked to personal profiles.

---

## 3. Windows Desktop Audio Helper (`streamgrid-audio-helper.exe`)

The Windows desktop version includes a native companion module for selective process audio capture (WASAPI Loopback):
* **Local Loopback Only:** The audio helper communicates exclusively over local loopback (`ws://127.0.0.1`) with the StreamGrid desktop application running on the same machine.
* **Security Tokens:** Communication between the main desktop window and the audio helper requires a cryptographically random, ephemeral security token and strict origin validation.
* **No Remote Telemetry:** The audio helper never sends captured audio, process identifiers (PIDs), or system information to remote servers. All audio processing and process filtering happen strictly within your local machine's memory.

---

## 4. Third-Party Services & Infrastructure

* **STUN Servers:** StreamGrid utilizes public Google STUN servers (`stun:stun.l.google.com:19302`) solely for NAT traversal (discovering external reflexive IP candidates for WebRTC handshakes). STUN requests do not carry room names, user identities, or media content.
* **Hosting Infrastructure Logs (Render):** The public web demonstration and signaling instance are deployed on Render infrastructure. Standard connection logs (such as IP addresses, User-Agent strings, and request timestamps) are automatically processed and temporarily retained by Render's edge proxies in accordance with their privacy policy to maintain network availability, DDoS mitigation, and operational security.

---

## 5. Cookies & Local Storage

* StreamGrid does not use persistent tracking cookies or advertising identifiers.
* Local browser storage (`localStorage`) is used strictly to retain non-sensitive client preferences (such as your chosen display name, preferred resolution, and framerate).
* Session storage (`sessionStorage`) is used to retain ephemeral session tokens (such as the local audio helper connection token across page reloads).

---

## 6. Open Source Verification

Because StreamGrid is 100% open source under the MIT License, users, developers, and security researchers can independently audit the source code, network requests, and build pipelines directly on GitHub:  
👉 [https://github.com/Pedrosasouza/screenshare-p2p](https://github.com/Pedrosasouza/screenshare-p2p)

---

## 7. Contact & Inquiries

If you have questions, feedback, or concerns regarding privacy in StreamGrid, please open an issue on the official GitHub repository:  
* **GitHub Repository:** [Pedrosasouza/screenshare-p2p](https://github.com/Pedrosasouza/screenshare-p2p)  
* **Maintainer:** Pedro Souza ([@Pedrosasouza](https://github.com/Pedrosasouza))
