# FlowToIt

LAN peer-to-peer communication app with real-time messaging over WebSockets.

## Features

- **LAN Discovery** — automatically detects peers on the local network
- **Real-time Messaging** — WebSocket-based instant communication
- **HTTPS / WSS** — auto-generated self-signed SSL certificates
- **PWA Support** — installable as a Progressive Web App on mobile and desktop
- **No Internet Required** — works entirely on your local network

## Tech Stack

- **Server:** Node.js, Express 5, WebSocket (`ws`)
- **Client:** Vanilla HTML/CSS/JS (single-page PWA)
- **Protocol:** HTTPS + WSS with auto-generated certs

## Getting Started

### Prerequisites

- Node.js (v18+)
- OpenSSL (for auto-generating SSL certs)

### Install

```bash
git clone <repo-url> flowtoit
cd flowtoit
npm install
```

### Run

```bash
npm start
```

The server starts on HTTPS and prints the LAN addresses you can use to connect from other devices:

```
🚀 FlowToIt running at:
   https://<your-lan-ip>:3000
```

> **Note:** Browsers will show a certificate warning for the self-signed cert. Accept it to proceed.

## Project Structure

```
flowtoit/
├── server.js          # Express + WebSocket server
├── package.json
├── public/
│   ├── index.html     # Main PWA client
│   ├── manifest.json  # PWA manifest
│   └── sw.js          # Service worker
└── data.json          # Runtime data (auto-generated)
```

## License

ISC
