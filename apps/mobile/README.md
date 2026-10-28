# DeepSeek Harness Android App

[简体中文](README.zh-CN.md) · [Back to the project](../../README.en.md)

DeepSeek Harness is the display name of this community-maintained Android WebView app. It opens the plugin's authenticated HTTPS page rather than bundling another DSH frontend. The app and mobile browsers receive the same DSH features and computer-side mobile customizations.

The current stable app is **0.6.5** (build 81). The npm plugin and Android App have independent versions: a plugin update does not automatically require another APK. See the [0.6.5 changes](#065-update).

Android 10 or later is supported. The local iOS experiment is not a published or supported client.

## Install and pair

1. Install and enable the plugin using the [project quick start](../../README.en.md#quick-start). Complete LAN setup from the command line or the computer's **Mobile Access** panel.
2. Install the signed Android APK from [GitHub Releases](https://github.com/saya-ch/dsh-mobile/releases/tag/android-v0.6.5). Upgrade an official installation in place using the same release signer to retain its pairings. A differently signed Debug APK cannot replace it; do not uninstall or clear data just to bypass that mismatch.
3. On the computer, generate a pairing key/link under **Mobile Access → Local network**, or configure a remote provider and generate its remote pairing QR code. In the app, choose the matching connection mode and scan or paste the link.
4. Name the computer. The app stores each LAN or remote pairing as its own record. The phone does not need a cpolar, Cloudflare or Tailscale app.

For LAN, the app also offers a scan and manual `https://IP:port` entry. Discovery cannot bypass firewall rules, campus-network isolation or missing routes; use a reachable address or a remote channel when necessary. Browser pairing has its own [connection instructions](../../README.en.md).

## Devices and settings

The **Paired computers** list shows names, connection types, addresses, reachability and recent connections. Tap a row to connect; long-press or use **More** to rename, check, reorder or delete its local record. New records append to the list; **Move up / Move to top** changes presentation, not the startup choice. **Add computer** accepts a fresh pairing link; pairing the same installation in the same mode retains its custom name.

| Location | Setting or action |
| --- | --- |
| Device list → Settings → Startup behavior | **Open DSH directly** (default) selects the last-used eligible pairing, even when several computers are saved. **Show device list** asks you to choose at each launch. |
| Device list → Settings → App icon | Choose the mascot or one of six whale-mark colors without changing package identity or paired data. |
| DSH page → Settings → General → Switch computer | Return to the paired-computer list. Holding the top-left drawer toggle provides another entry. These actions belong inside the app's webpage, not the device-list settings. |
| <a id="062-update"></a>DSH page → Settings → General → Page zoom | App 0.6.2+ with plugin 0.6.3+: 80–125%, reset to 100%. Saved app-wide without reloading the conversation. |
| DSH page → Settings → General → Mobile font size | Default 16px, range 12–32px; saved for the current address. Supported themes also expose code size and body/code font choices. Editable inputs retain a 16px minimum; terminal fonts remain DSH-owned. |
| DSH page → Settings → General → Mobile page modules → Manage | Choose optional frontend modules for this paired device. This neither uninstalls computer plugins nor revokes their authorization; [module rules](../../docs/CLIENT_MODULES.en.md) describe dependencies and applying changes. |
| DSH page → Settings → General → Task notifications | Request Android notification access or open the app's system notification settings. See [notification limits](#notifications-and-extensions). |

Page zoom changes the whole page and is separate from per-address text preferences. App-only actions are shown only when the native bridge supports them. Native screens follow the Android system language in Simplified Chinese, English or Italian; webpage copy follows DSH's selected locale. DSH does not currently expose Italian.

Deleting a local record removes its saved token and pinned CA, not the computer's authorization or every short-lived WebView cookie. Use **Mobile Access** on the computer to revoke access immediately. A full Android clear-app-data reset removes all pairings and web data and is not a normal reconnection step.

## 0.6.5 update

Android 0.6.5/build 81 adds an immediate **Cancel connection** action during startup, saved-computer connection, LAN scanning and pairing. Cancellation returns to the device list or editable form without deleting existing pairings. **Stop reconnecting** retains a usable DSH page; a blank or failed document returns to the list.

The initial wait uses the whale-girl background, a centered loading indicator and a cancellation button, without a separate modal dialog. A trusted page's first visible commit reveals its own loading progress immediately. A small, nonblocking Cancel button remains until usable page controls appear; the app does not wait for every image or require a particular layout class.

One overall budget covers each connection, including queued work, native authentication, retries and initial page loading: **30 seconds for LAN, 60 seconds for remote access**. Retries do not restart it. Manual failures settle visibly, a cached unreachable status still permits retry, and failure never silently selects another computer.

Cancellation withdraws queued retries and late navigation results and requests native network disconnection. It cannot roll back a pairing already accepted on the computer; generate a new QR code if its one-time code was consumed. These native controls require App 0.6.5 or later; updating npm alone does not install them.

## Connections, recovery and trust

Device records, long-lived revocable tokens and pinned CAs are encrypted with Android Keystore. Existing LAN/remote slots migrate without re-pairing. Temporarily unreadable encrypted data is reported, not treated as an empty list or overwritten. An expired CA record remains available for deletion or re-pairing, while TLS continues to reject the expired certificate.

The app renews a short Web session only at the exact saved Origin. After a LAN address change, it can discover the same installation on the default port and renew under the existing pin. A rotated remote Origin cannot be discovered through its expired predecessor: scan the computer's current remote QR code to verify the new address. The old device token is never sent to that unverified address.

Discovery carries metadata only. DNS-SD/mDNS, UDP announcements and active port-3443 queries are supplemented by bounded HTTPS probes of visible private Wi-Fi/hotspot `/24` subnets. For other ports or routed subnets, enter the address manually. Discovery success is not pairing authorization.

LAN and self-signed FRP pairings fetch the CA without device credentials, verify its validity and fingerprint against the pairing key, and pin it privately for the exact Origin. Other TLS errors are rejected; no CA is installed in Android's system trust store. A leaf renewed under the same CA does not require re-pairing, but a changed or expired CA does.

Ordinary remote entries use publicly trusted HTTPS. The [managed FRP](../../docs/SELF_HOSTED_FRP.en.md) public-CA path supports App 0.3.3+; [existing-frps self-signed ingress](../../docs/ATTACH_EXISTING_FRPS.en.md) requires App 0.4.6+. Normal browsers do not automatically trust that private CA. Certificate lifetimes do not guarantee unattended availability.

Temporary network failures are not revocation. An online computer-side revocation marks the row **Removed on computer** and prevents later probes from restoring it. A device revoked while offline may instead receive the generic **Pairing expired** result; re-pair with a fresh code. The app does not reveal whether an unknown token belonged to a removed device.

Automatic recovery tries to retain an already mounted DSH document after renewal. Renderer loss or a failed boot may require reopening, so unsaved state cannot always be recovered. Supported rotation, window and keyboard changes retain the WebView; system theme/font/language changes, process termination and renderer failure may recreate it.

## Files, camera and input

### Standard attachments

App 0.6.4+ uses the system Photo Picker on Android 13+ for supported image filters. It preserves the webpage's MIME and multiple-selection settings within system limits. Other filters, capture requests, older Android or an unavailable picker use Documents. No storage permission is added and no manufacturer's gallery is guaranteed.

Standard file callbacks belong to the current WebView, Origin and document. With navigation-listener support, pending requests are withdrawn before document replacement and new selection waits for navigation to finish. Older WebViews use available callbacks; if selection stops opening after changing pages, update WebView or return to the device list and reopen the computer, without clearing data.

DSH keeps its file action in **Add**; Mobile adds **Take photo** when the active attachment owner accepts images. Camera capture explicitly requests permission and returns a full-resolution JPEG. For troubleshooting, select one small JPEG/PNG and inspect the unsent draft preview. Files awaiting submission need not already exist as computer-side image objects; no model request is necessary to check selection.

### Keyboard and page space

System Back first dismisses supported webpage layers, then handles same-origin WebView history, and exits at the root. Model submenus return to their parent before closing. No extra native toolbar is shown above the WebView.

The native soft-keyboard adapter uses plain Enter for a line break only with a visible inset-backed keyboard, no reported hardware keyboard, and a focused active-session composer. The plugin's separate touch-browser rule also uses Enter for draft line breaks, including external keyboards on touch-primary browsers. Menus, composition and modified shortcuts remain DSH-owned; non-touch desktop behavior is unchanged. Use Send for multiline messages or Shift+Enter where DSH's normal keyboard policy applies.

System bars, cutouts and keyboard occupancy are reserved once. WebView 151+ receives a minimum 64 MiB HTTP-cache quota for reusable versioned DSH resources; older engines retain their default quota. A Chromium-below-100 reminder is advisory, not a promise that every DSH API is supported on that engine.

A successful App connection does not establish that its engine can execute the page. The DSH 0.2.1-rc.2 frontend contains syntax Chromium 92 cannot parse. If system WebView cannot be updated, use a browser confirmed to work without clearing pairings. See the [old-engine notes](../../README.en.md#app-or-mobile-browser) for the plugin's startup feedback and support limits.

### Voice

DSH records audio through `getUserMedia` and sends it to the configured computer-side speech provider, not browser SpeechRecognition or the extension bridge. Android asks for microphone permission and accepts audio-only capture from the paired HTTPS Origin. Provider components, models and network access must work; granting recording permission does not verify transcription. Same-origin frontend plugins share that page permission.

## Notifications and extensions

Task reminders use Host completion events and pending-input cards while the page remains alive. Lock-screen text is generic and tapping returns to the app. They are not an offline push service: completion reminders require SSE, with no event replay after disconnection. Cloudflare Quick Tunnels do not support this stream; see [channel limits](../../docs/CLOUDFLARE_TUNNEL.en.md#quick-tunnel-feature-limits).

The authenticated page may use the `dshMobile` bridge for `files.pick`, `camera.capture`, `share`, clipboard read/write, task notifications/settings, computer switching and page scaling. The separate extension `files.pick` returns one file, follows its requested MIME types and limits bridge-returned file bytes to 8 MiB. This is not the standard DSH attachment selector's limit.

Bridge file/camera operations are serialized with a five-minute deadline. Cancellation, document/session changes or WebView teardown reject stale results and clean up owned resources. Browser media selection waits for an actual result, explicit cancellation, abort or deadline; returning focus is not itself cancellation. Unsupported capabilities return `unsupported`.

Computer-side `host.mjs` extensions are trusted Node.js code, separate from this native bridge; the bridge cannot edit or upload their source. Computer-managed frontend assets and extension activation are documented in the [project guide](../../README.en.md), and optional Worker execution in the [Worker guide](../../docs/EXTENSION_WORKERS.en.md).

## Security properties

| Control | Android behavior |
| --- | --- |
| Transport | HTTPS only; Manifest cleartext traffic is disabled. |
| Trust | Exact-Origin platform trust or a privately pinned pairing CA. User-installed system CAs are not broadly trusted. |
| Navigation | Same-origin main frames remain inside; explicit external HTTPS links open in the system browser. |
| Permissions | Camera for explicit scanning/capture, microphone for DSH recording, notifications through a foreground permission/settings action; standard file selection needs no storage permission. |
| Bridge | WebMessage listener validates exact top-level Origin and main frame; no `addJavascriptInterface` or arbitrary Android API. |
| Limits | Inbound message 1 MiB, clipboard 256 KiB, binary bridge result 8 MiB, reply 12 MiB. |
| Credentials | Bridge replies do not automatically include stored pairing credentials; there is no direct bridge API for reading the credential store or private keys. Clipboard contents and selected files may contain sensitive data: use only trusted extensions. |
| Downloads | Foreground GET from the exact Origin only; authentication-control paths are excluded. |
| Storage | Keystore-encrypted pairings and sandboxed web data; cloud backup and device transfer are disabled. Signing/TLS private keys must stay outside the repository. |

## Build

Use Android Studio or Android SDK 36 and JDK 17. The repository includes the Gradle 9.7.1 Wrapper.

```powershell
Set-Location apps/mobile/android
./gradlew.bat :app:lintDebug :app:testDebugUnitTest :app:assembleDebug -x :app:lintAnalyzeDebugUnitTest -x :app:lintAnalyzeDebugAndroidTest
```

The Debug APK is `app/build/outputs/apk/debug/app-debug.apk`. Official releases use the established signing key stored only in repository Secrets. A local unsigned Release build or a Debug install is not official-signer evidence.

The verified stable release is [Android 0.6.5](https://github.com/saya-ch/dsh-mobile/releases/tag/android-v0.6.5), SHA-256 `41bd476c5ccf90020ecf624844a29886d55060a79533b599e9aa5bf0a1d71844`. Earlier release history belongs in [CHANGELOG](../../CHANGELOG.md).

## Acceptance and known limits

- Connection-control development builds used Debug metadata 0.6.4/build 80 on PJW110, Android 16 and Google WebView 153.0.8010.36. Against an isolated DSH 0.2.0-rc.2/plugin 0.6.10 instance over USB and pinned HTTPS, checks covered pairing/startup/saved-connection cancellation, Back, failed manual connections and return from a failed page after stopping native recovery. Held module responses also verified early webpage display, touch-through outside compact cancellation, cancellation and later completion. Pairings were retained and owned QA records removed.
- Debug builds of App 0.6.4 retained one WebView across document replacement/reload, rejected an old selection, and received controlled PNG bytes with a decoded DSH draft preview. A held navigation and HTTP 204 also checked selector availability. Earlier checks covered model-menu Back, rotation with draft/reference/image retention, known revocation, re-pairing, icon choices and list ordering. None required a model prompt.
- These observations do not establish final 0.6.5/build 81 official-signer device acceptance, every public provider, remote 60-second timing, full native recovery with a still-live draft, HyperOS/older WebViews or every screen/gesture configuration. Self-signed FRP still lacks a recorded real-VPS-plus-phone end-to-end check. Permission grants alone do not establish voice transcription, and process-death restoration is not guaranteed.

Apache-2.0 licensed. See [LICENSE](../../LICENSE).
