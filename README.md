<div align="center">

# 🎙️ LAN Voice Server

**Peer-to-peer voice chat for your local network — no internet required.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)]()

</div>

---

LAN Voice Server is a lightweight, self-hosted voice chat application for local networks. It uses **WebRTC** for peer-to-peer audio and a **Node.js/WebSocket** signaling server. No cloud account, no monthly fees, no internet connection needed — just run the server and talk.

## ✨ Features

- 🔒 **HTTPS / WSS** – auto-generated self-signed TLS certificate (no setup needed)
- 🎤 **Multi-room** – create and join named voice rooms
- 💬 **In-room chat** – text chat alongside voice
- 🔇 **Mute indicator** – shows who is muted in real time
- 👤 **User login** – login with persistent accounts (JWT + hashed passwords)
- 🖥️ **Runs as a single `.exe`** – portable Windows binary via [pkg](https://github.com/vercel/pkg) (no Node.js installation required for end users)
- 🌐 **Works across browsers** – Chrome, Edge, Firefox

## 📋 Requirements

- [Node.js](https://nodejs.org/) 18 or newer (for running from source)
- npm (included with Node.js)

## 🚀 Quick Start

### Option A — Run from source

```bash
# 1. Clone the repository
git clone https://github.com/FeiDEV007/LAN-Voice-Server.git
cd LAN-Voice-Server

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

Open `https://localhost:3443` in your browser.  
Share `https://<your-local-ip>:3443` with others on the same network.

> **First visit:** Your browser will warn about the self-signed certificate.  
> Click **Advanced → Proceed to \<IP\>** (Chrome/Edge) or **Accept the Risk** (Firefox).

### Option B — Windows portable `.exe`

Download the latest `LAN Voice Server.exe` from the [Releases](../../releases) page, place it in a folder alongside the `public/` directory, and double-click.

## 🔧 Configuration

Create a `.env` file in the project root (or copy `.env.example` to `.env`):

```env
PORT=8443
AUTH_ENABLED=true
JWT_SECRET=replace-with-a-long-random-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-password
```

| Environment variable | Default | Description |
|---|---|---|
| `PORT` | `3443` | HTTPS/WSS port |
| `AUTH_ENABLED` | `true` | `false` = LAN mode without login, `true` = internet mode with login/auth |
| `JWT_SECRET` | `change-me-in-production` | Secret key for login tokens |
| `ADMIN_USERNAME` | _(empty)_ | Optional bootstrap admin username |
| `ADMIN_PASSWORD` | _(empty)_ | Optional bootstrap admin password (min 8 chars) |

Example:
```bash
npm start
```

## 🔐 Authentication

- `AUTH_ENABLED=false`: LAN mode, no login required.
- `AUTH_ENABLED=true`: login/auth enabled.
- Public registration is disabled.
- New users can only be created by an admin in the `/admin` panel.
- Passwords are stored as bcrypt hashes.
- A JWT is stored in browser localStorage and used for API/WebSocket authentication.
- User data is stored in `data/users.json` (or next to the `.exe` in packaged mode).

### Admin setup (new installation)

- Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` when starting the server.
- On startup, the server creates that admin user if missing.
- If the user already exists, it is promoted/reactivated as admin and the password is updated from `ADMIN_PASSWORD`.
- Admin panel is available at `/admin` after login.

> For internet-facing deployments, always set a strong `JWT_SECRET` and use a valid TLS certificate.

## 🏗️ Build the Windows `.exe`

```bash
# Install dev dependencies (includes pkg)
npm install

# Build
npm run build
```

The executable is written to `dist/LAN Voice Server.exe`.  
Copy the `public/` folder next to it before distributing.

## 📁 Project Structure

```
lan-voice-server/
├── server.js          # Node.js signaling server (Express + WebSocket + TLS)
├── public/
│   ├── index.html     # Web UI
│   ├── app.js         # WebRTC client logic
│   └── style.css      # Styles
├── dist/              # Build output (.exe + public/)
├── package.json
└── LICENSE
```

## 🛠️ How It Works

```
Browser A ──WebSocket──▶ Node.js signaling server ◀──WebSocket── Browser B
         └────────────── WebRTC peer connection ──────────────┘
                          (audio streams directly)
```

1. Clients connect to the signaling server via WebSocket.
2. The server relays **offer/answer/ICE candidate** messages between peers.
3. Once a WebRTC connection is established, audio flows **directly** between browsers — the server only handles signaling.

## 🤝 Contributing

Pull requests are welcome! Please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the [MIT License](LICENSE).
