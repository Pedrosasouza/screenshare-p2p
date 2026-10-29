# Privacy Policy for StreamGrid

Last updated: October 2026

**StreamGrid** is an open-source real-time multi-screen sharing application developed by Pedro Souza. This Privacy Policy explains how StreamGrid handles information across both the web application and the Windows desktop package.

StreamGrid is designed with a strict privacy-first architecture: we do not collect personal identifying information, sell user data, or inject third-party trackers or advertisements.

---

## 1. Peer-to-Peer (WebRTC) Media Streams

* **Direct Transmission:** All audio and video streams transmitted between participants in a room travel directly peer-to-peer (P2P Mesh) via WebRTC.
* **End-to-End Encryption:** Peer-to-peer connections utilize industry-standard cryptographic protocols (DTLS and SRTP). Media payloads are encrypted between peers and never pass through a central media server (SFU/MCU).
* **No Media Recording or Storage:** StreamGrid does not record, archive, analyze, or inspect video or audio streams.

---

## 2. Signaling Server & Ephemeral Room Data

The signaling server (hosted on Render) coordinates the initial WebRTC connection setup:
* **Session Metadata:** The server facilitates the exchange of SDP (Session Description Protocol) offers, answers, and ICE candidates between clients. Once the peer-to-peer connection is established, ongoing media traffic does not traverse the signaling server.
* **Room Passwords:** When a private room is created with a password, the password is never stored in plain text. It is hashed using cryptographic hashing with random salts (`scrypt`/`bcrypt`) in server memory.
* **Ephemeral Lifecycle:** Room states, participant sockets, and password hashes exist solely in volatile memory during the active session. Once all participants leave a room, the room and its associated state are evicted from memory.
* **Abuse Prevention & Rate Limiting:** The server maintains temporary, rolling counters in memory to prevent brute-force password guessing and denial-of-service attempts. IP addresses used for rate limiting are not logged persistently or linked to personal profiles.

---

## 3. Windows Desktop Audio Helper (`streamgrid-audio-helper.exe`)

The Windows desktop version includes a native companion module for selective process audio capture (WASAPI Loopback):
* **Local Loopback Only:** The audio helper communicates exclusively over local loopback (`ws://127.0.0.1`) with the StreamGrid desktop application running on the same machine.
* **Security Tokens:** Communication between the main desktop window and the audio helper requires a cryptographically random, ephemeral security token and strict origin validation.
* **No Remote Telemetry:** The audio helper never sends captured audio, process identifiers (PIDs), or system information to remote servers. All audio processing and process filtering happen strictly within your local machine's memory.

---

## 4. Third-Party Services & Infrastructure

* **Turn / STUN Servers:** StreamGrid utilizes public Google STUN servers (`stun:stun.l.google.com:19302`) solely for NAT traversal (discovering public IP candidates for WebRTC handshakes). STUN servers only assist in establishing the direct P2P connection and cannot inspect or decrypt media contents.
* **Hosting:** The public web demonstration and signaling instance run on Render infrastructure. Standard connection logs (such as IP addresses and request timestamps) may be processed by Render in accordance with their privacy policy to maintain network availability and security.

---

## 5. Cookies & Local Storage

* StreamGrid does not use persistent tracking cookies or advertising identifiers.
* Local browser storage (`sessionStorage`) is used strictly to retain non-sensitive session preferences (such as the ephemeral local audio helper token across page reloads).

---

## 6. Open Source Verification

Because StreamGrid is 100% open source under the MIT License, users, developers, and security researchers can independently audit the source code, network requests, and build pipelines directly on GitHub:  
👉 [https://github.com/Pedrosasouza/screenshare-p2p](https://github.com/Pedrosasouza/screenshare-p2p)

---

## 7. Contact & Inquiries

If you have questions, feedback, or concerns regarding privacy in StreamGrid, please open an issue on the official GitHub repository:  
* **GitHub Repository:** [Pedrosasouza/screenshare-p2p](https://github.com/Pedrosasouza/screenshare-p2p)  
* **Maintainer:** Pedro Souza ([@Pedrosasouza](https://github.com/Pedrosasouza))
