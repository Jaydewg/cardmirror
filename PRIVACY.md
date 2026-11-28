# CardReflex Privacy Policy

**Last updated: November 26, 2026**

CardReflex is a debate evidence editor. This policy explains, in plain
language, what happens to your data when you use it.

**The short version:** CardReflex keeps your work on your own device. Its
publisher runs **no servers** and has **no accounts**, **no analytics** and
**no tracking**. A few optional features connect to services that you choose,
and when they do, this policy says exactly what they send.

CardReflex is published by **Jayden Wang** ("I", "me"). It is a fork of
[CardMirror](https://github.com/ant981228/cardmirror) by Anthony Trufanov and is
not affiliated with or endorsed by the CardMirror project. CardMirror's own
services are covered by CardMirror's own policy, not this one.

> CardReflex is open source. If anything here is ever unclear, the code is
> the ground truth: <https://github.com/Jaydewg/cardmirror>.

---

## 1. What I don't do

- **No servers.** I don't operate any server, relay, or website for
  CardReflex. Nothing you do in the app is sent to me.
- **No accounts.** You never sign up or log in to use CardReflex. All core features are completely
  free and bundled in.
- **No analytics, tracking or telemetry.** The app contains no analytics or
  advertising code and sends no usage data. I don't build profiles, and I
  don't sell, rent or share anyone's data.

---

## 2. Data stored on your device

Everything CardReflex keeps is stored on your own computer:

- your documents, plus crash-recovery journals of unsaved work;
- your settings and preferences, including any API keys or display name you
  enter;
- recent files, pinned items, quick cards, study annotations and flashcards;
- if you use card sharing: a key pair generated on your device, your
  contacts' pairing codes, and an inbox of cards sent to you;
- if you use co-editing: a local record of your sessions and a **session
  history file** per session, so you can recover an earlier version. History
  files are deleted automatically after 30 days, or whenever you delete them;
- installed plugins and the data they store;
- crash logs and crash dumps (see §8).

**Retention:** this data stays on your device until you delete it or
uninstall the app (session history files also expire after 30 days). I have
no copy and no way to reach it. Protect your device as you would any folder
of personal files.

---

## 3. Card sharing and co-editing (optional, off by default)

Card sharing (sending a card to another machine) and co-editing (editing a
document together live) need a **relay server**. **CardReflex has no default
relay.** These features do nothing until you enter the address of a relay
that you, your team or your school runs (Settings → Collaboration).

- **The relay's operator is responsible for it**, including its logs and how
  long it keeps data. That operator is not me. CardReflex ships the relay
  software in its repository so anyone can run their own.
- **End-to-end encryption.** Cards and co-editing content (edits, comments,
  cursor positions) are encrypted on your device before they leave it, so a
  relay passes them along **without being able to read them**. Cards use
  X25519 key exchange with AES-256-GCM; a co-editing session's key exists
  only in its invite link or share code and on participants' devices.
- **What any relay necessarily sees:** your IP address and connection times,
  routing codes (one-way hashes of pairing keys, not names or emails),
  message sizes and timestamps, the encrypted data itself, and the version of
  the app making the request. The encrypted data can't be opened by the relay.
- **Retention with the relay software as shipped:** a shared card is deleted
  once delivered and in any case after 3 hours; a co-editing session's
  encrypted data is deleted when the host ends the session or after 7 days of
  inactivity. A relay's operator can change these settings.
- **Your display name**, if you set one, travels inside the encrypted content
  to the people you share with; a relay can't read it.
- **Invite links.** A co-editing invite link opens the **CardMirror web app at
  cardmirror.app**, which is run by the CardMirror project, not by me. The
  session key and any guest pass are in the part of the link after `#`, which
  browsers never send to the website's server. Treat an invite link like a
  key: anyone holding it can join while the session lasts.
- **If you point CardReflex at CardMirror's official relay**, that relay's
  operator, terms, privacy policy and membership requirements apply.

---

## 4. AI features (optional, off by default, your own key)

AI features (such as citation generation, flashcard drafting, text clean-up
and dictation clean-up) are off until you choose a provider and enter **your
own API key**. The key is stored on your device and sent only to that
provider.

When you use an AI feature, the content it needs (the text you selected,
some surrounding document text, any image you ask about, and the prompt) goes
**directly from your device** to your chosen provider:

- **Anthropic** (`api.anthropic.com`), under Anthropic's terms and privacy
  policy;
- **OpenRouter** (`openrouter.ai`), which forwards it to the operator of the
  model you picked. OpenRouter's terms and the model operator's terms both
  apply. Some models, especially free ones, may allow the operator to train
  on what you send; check the model's listing before sending anything
  sensitive.

None of this passes through me. If you don't add a key, nothing is ever sent
to an AI provider.

---

## 5. Translation (optional, when you use it)

The translate action sends the text you're translating to
**MyMemory** (`api.mymemory.translated.net`, the default, no key) or to
**Google Cloud Translation** if you supply your own Google API key. That
provider's terms apply. If you never translate, nothing is sent.

---

## 6. Plugins (optional, off by default)

Plugins are off until you enable them, and none are installed by default.

- **Installing or updating a plugin** downloads it from GitHub, which sees
  your IP address.
- **Plugins run with full access** to the app and your documents. A plugin
  may store data on your device and may contact services of its own. What a
  third-party plugin does with your data is its author's responsibility,
  under that author's terms. Install only plugins whose author you trust.

---

## 7. Updates and downloads

- **Microsoft Store version:** updates are delivered by the Microsoft Store.
  The app itself makes no update checks.
- **Versions downloaded from GitHub** check GitHub for a newer release at
  launch and once a day. This reveals your IP address and app version to
  GitHub and nothing else. You can turn it off or pause it in Settings →
  General → About this install.
- **Voice control**, if you turn it on, downloads its speech engine once (from
  the npm registry, `registry.npmjs.org`) and its recognition model (from the
  sherpa-onnx project on GitHub). Speech recognition then runs entirely on your
  device: **no audio ever leaves it.** If you also turn on AI dictation
  clean-up, the dictated *text* (never the audio) goes to your AI provider as
  in §4.
- **Microphone:** CardReflex uses the microphone only for voice control and
  dictation, and only while you have one of them turned on. Windows controls
  whether it may use the microphone at all: Windows Settings → Privacy &
  security → Microphone.

---

## 8. Crashes

If CardReflex crashes, it writes a crash dump and a short log **to your
device only**. The app never uploads them. If you want to help fix a bug, you
can choose to send me a file yourself.

Separately, **Windows Error Reporting** may send crash information to
Microsoft, depending on your Windows settings. For the Microsoft Store
version, Microsoft may make aggregate crash and reliability reports available
to me in Partner Center; these don't include your documents.

---

## 9. Microsoft Store

If you get CardReflex from the Microsoft Store, Microsoft handles the
download, installation, updates and any reviews you leave, under Microsoft's
own privacy statement. Microsoft gives me only aggregate statistics (such as
install counts), not your identity.

---

## 10. Third parties at a glance

I don't share your data with anyone. Data reaches an outside service only
when you use a feature that needs it:

| Service | When | What it receives |
|---|---|---|
| A relay you configure (its operator) | Card sharing / co-editing (opt-in) | End-to-end-encrypted data it can't read; IP address and connection metadata |
| cardmirror.app (CardMirror project) | Opening a co-editing invite link in a browser | A normal page request; the session key stays in the link fragment and isn't sent |
| Anthropic | AI features (opt-in, your key) | The text, images and prompt you submit |
| OpenRouter, plus the model operator | AI features (opt-in, your key) | The text, images and prompt you submit |
| MyMemory or Google | Translate action | The text you translate |
| GitHub | Update checks (GitHub versions only), plugin installs and updates, voice model download | Your IP address and app version |
| npm registry | Voice engine download (opt-in) | Your IP address |
| Microsoft | Microsoft Store install and updates; Windows Error Reporting per your Windows settings | What Microsoft's own privacy statement describes |

Each service handles what it receives under its own privacy policy.

---

## 11. Children's privacy

CardReflex is a general-purpose writing tool for a general audience, which
includes high school and college students. It is not directed to children
under 13. Because it has no accounts and keeps your work on your device, I
don't collect personal information from anyone. If your school deploys
CardReflex, its own policies also apply.

---

## 12. Your controls

- **Local data:** delete the document or item, clear the field in Settings,
  or uninstall the app.
- **Card sharing:** turn it off, or regenerate your pairing code to cut off
  cards addressed to the old one.
- **Co-editing:** the host's **End session** deletes the session's data from
  the relay (per the relay's settings); you can clear a session's local
  record any time.
- **AI and translation:** remove your API key, or just don't use those
  features.
- **Microphone:** Windows Settings → Privacy & security → Microphone.

Because I hold no copy of your data and no account, there is nothing for me
to delete on my side. For data on a relay, contact that relay's operator.

---

## 13. Changes to this policy

If CardReflex starts handling data differently, I'll update this policy and
its "Last updated" date and mention the change in the release notes.

---

## 14. Contact

Questions about this policy or your data: **jayden.t.wang.dev@outlook.com**,
or open an issue at <https://github.com/Jaydewg/cardmirror/issues>.
