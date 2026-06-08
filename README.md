# Atlas — Claude-powered browser

A Chromium browser with vertical tabs and a Claude AI Studio panel built in.

## Setup

```bash
cd claude-atlas
npm install
npm start
```

Node.js 18+ required. First launch takes a minute while Electron downloads.

## First use

1. Click the ⚡ button (top right) to open the Studio panel
2. Paste your Anthropic API key (`sk-ant-...`) and hit Save
3. Browse normally — Claude can see whatever page you're on

## Studio modes

- **Chat** — Ask Claude anything about the current page. Full conversation memory for the session.
- **Actions** — One-click: Summarize, Extract Data, Explain, Draft Email

## Notes

- Your API key is stored in the app's local storage (not sent anywhere except Anthropic's API)
- Google Workspace works — cookies persist between sessions, so you stay logged in
- New tabs/windows opened by sites open as Atlas tabs
- Cmd+R to reload the app UI if anything goes sideways
