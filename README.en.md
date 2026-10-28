# DSH Mobile (custom branch)

> A customized build of [`saya-ch/dsh-mobile`](https://github.com/saya-ch/dsh-mobile) `v0.6.13`.
> This branch keeps **one public direct-connect path of its own** and ships no third-party tunnel.

Use DeepSeek Harness from your phone, securely and in real time. The plugin does not modify DeepSeek Harness source.

## Differences from upstream

| Item | Upstream | This branch |
| --- | --- | --- |
| Remote channels | Tailscale / cpolar / cloudflared / FRP / own reverse proxy | **Own reverse proxy only (public IP direct connect)** |
| Channel picker | Five options | **Only "Own reverse proxy"** |
| Third-party tunnel components | Downloaded on demand | Removed; never downloaded |
| Android app download | Upstream release | This repository's release (`android-v0.6.14`) |
| Demo screenshots | Shipped in the repository | Removed (no images shipped) |

Plugin version `0.6.13`; matching Android app `0.6.14` (versionCode 82).

## What it does

- Continue the same sessions, workspaces, messages and tools from your phone.
- Touch-first layout: session drawer, tool details, settings, question cards and the composer are reorganized for phones.
- Pairing and multiple computers: pair once by QR code, link or key; connections usually recover after switching networks.
- One-click diagnostics with a redacted report.
- Android task notifications for completed turns and pending input.
- Security: private CA for the LAN gateway; the public entry terminates TLS inside the plugin; credentials stay in Android Keystore.

## How it works

```
Phone ──> Public IP:3444 (router port forwarding)
            │  built-in relay (rewrites Host/Origin, keeps WebSocket upgrade)
            ▼
     Computer LAN address:3443 (LAN gateway, self-signed + pinned CA)
            │
            ▼
        DSH Web (loopback)
```

The LAN path uses `3443`. The public path uses `3444` and is forwarded by a relay inside the plugin process — no third-party tunnel is involved.

## Quick start

Install this repository into the DSH profile by linking the local directory (see [Development](#development)), restart DSH, then:

1. Open **Mobile access → Local network**, enable it and generate a pairing key; scan it with the Android app.
2. To reach DSH from outside the home network, configure the public path as described in the [Connection guide](#connection-guide).

## Connection guide

The LAN and public direct paths are independent: prefer the LAN when near the computer, and enable the public path only when away. The computer manages switches and pairing grants separately.

### Local network

Best for the same Wi-Fi, Ethernet or phone hotspot, and the default choice.

1. Open **Mobile access → Local network** and choose **Enable LAN access**.
2. Choose **Generate and copy key**; a pairing QR code appears.
3. In the Android app pick **Local network**, then scan the code or paste the key.
4. Pairing creates persistent device trust; switching Wi-Fi or DHCP addresses usually needs no re-pairing.

Port notes: `dsh web --port` changes the DSH Web upstream port (default 3080) and the plugin follows it; `dsh-mobile setup --port` changes the Mobile HTTPS port (default 3443).

### Public direct connect

Useful when the phone leaves the home network. Requires a **public IPv4** and a router rule mapping public `3444` to the computer's `3444`.

1. Configure the plugin:

   ```yaml
   publicEntry: https://<your-public-address>:3444
   publicEntryAuto: true
   publicEntryPort: 3444
   ```

2. Restart DSH. The plugin probes the current public IPv4 and starts the built-in relay on `0.0.0.0:3444` using the DSH certificate.
3. Open **Mobile access → Remote** and choose **Generate remote pairing QR**.
4. In the Android app pick **Remote access** and scan; accept the certificate prompt (the app pins the LAN CA).

If the public address changes, the plugin re-probes on the next start; with `publicEntryAuto` disabled the configured value is used. Port forwarding is unavailable behind CGNAT.

## Extend and customize

Type `/mobile <request>` in a DSH conversation; the agent in that session handles the customization, and the phone usually refreshes within seconds once the files change.

```text
/mobile make the composer two lines tall and move the send button to the right
```

Custom files live under `$DSH_HOME/mobile-access/`: UI and interaction in `mobile.css` / `mobile.js`; computer capabilities via `extensions/`, whose `host.mjs` runs with local user privileges. This branch keeps `mobile.css` / `mobile.js` as empty stubs.

Customization starts from the **Mobile access pairing entry**; opening a normal DSH page is not the same as a paired mobile session.

## Optional modules and advanced configuration

Mobile page module settings ([module guide](docs/CLIENT_MODULES.md)) select which client plugins load, per computer or per device; changes apply on the next manual open.

**This branch does not recommend `excludedClientModules`**: excluding plugins makes the mobile startup module graph incomplete and the UI falls back to the stock DSH frontend (top tab bar, bottom usage bar). To diagnose a layout problem caused by a plugin, disable that plugin instead.

## App or mobile browser

| Option | Best for | Notes |
| --- | --- | --- |
| Android app | Daily use | Offers LAN and remote entries during pairing; auto-discovers the LAN; pins the LAN CA for the public entry |
| Mobile browser | Temporary or cross-platform | Open the HTTPS address shown in the Mobile access card; the LAN certificate may need manual confirmation |

The Android app is a thin Kotlin WebView shell; the browser loads the same page.

## Device management

The Android app lists paired computers and their connection records. LAN and remote grants are independent, so one computer may appear twice.

- Tap a row to connect; the "…" menu renames, re-checks, re-pairs or removes the local record.
- Startup behavior can be "Open DSH directly" or "Show device list".
- Revoking on the computer deletes the device record and token digest; old tokens then always return `401`.

## Third-party plugin compatibility

- The gateway allows only first-party DSH WebSocket paths by default (for example `/sidebar/ws/terminal`).
- Other WS paths from community plugins are blocked and listed under **Diagnostics → Third-party WebSocket paths**.
- Allow only exact paths you recognize; query strings and fuzzy prefixes are rejected.

## Security

- LAN listening is for trusted networks only. Public direct connect relies on router port forwarding — never expose the gateway without pairing.
- Unpaired requests cannot reach DSH. Disable remote access when unused.
- A paired device can operate DSH on the computer and must be treated as fully trusted. Revoke it immediately if the phone is lost.
- This branch does not weaken DSH pairing, CSRF or device checks.

## Troubleshooting

- **Repeated 401 after pairing**: stale cookies. Clear them for the site or reopen the app, then scan again.
- **`pairing_tls_failed`**: make sure `publicEntry` matches the address the phone actually dials and that pairing is issued by the LAN gateway.
- **Connects then drops in a loop**: the relay must keep `Connection: Upgrade` and `Upgrade: websocket`; check that no intermediate proxy strips them.
- **Mobile UI falls back to the desktop shell after an upgrade**: do not exclude plugins via `excludedClientModules`; disable the suspect plugin instead.
- **Unavailable after changing router or IP**: check port forwarding first, then whether the relay still listens on `3444`.

## Compatibility

- Based on upstream `v0.6.13`; verified on Windows x64 with the self-signed LAN gateway.
- Public direct connect needs a public IPv4 and router port forwarding; not usable behind CGNAT.
- This Android app pairs with this repository's plugin; its signature differs from the official app, so they cannot overwrite each other.

## Uninstall

```powershell
dsh plugin --profile <profile> remove dsh-mobile
# remove local data as well (irreversible):
dsh plugin --profile <profile> exec dsh-mobile purge --yes
```

Removing the plugin does not delete certificates, pairings or custom files under `$DSH_HOME/mobile-access/`.

## Development

```powershell
npm ci
npm run test
npm run build
```

Build output goes to `lib/` (git-ignored). Releasing the Android APK requires the signing keystore; signing secrets are never committed.

## License

Apache-2.0; see [LICENSE](LICENSE). Upstream credits are in [CONTRIBUTORS.md](CONTRIBUTORS.md).
