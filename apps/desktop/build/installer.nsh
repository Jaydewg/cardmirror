; ─────────────────────────────────────────────────────────────────────
; Custom NSIS include. electron-builder auto-includes
; ${buildResources}/installer.nsh — i.e. this file — when building the
; NSIS target, and recognizes the customInstall / customUnInstall macros.
;
; THREE jobs live here:
;
; 1. "New > <product> Document" in Explorer's right-click menu via the
;    classic ShellNew mechanism: a registry value under .cmir points
;    Explorer at a template file the installer ships (extraResources →
;    $INSTDIR\resources\new-template.cmir; regenerate with
;    `npm run gen:new-template`). The submenu label is the .cmir
;    association's friendly name ("CardMirror Document").
;
; 2. The .docx association, done RIGHT. electron-builder's
;    fileAssociations mechanism (which .docx used through v1.4.0)
;    overwrites the extension's DEFAULT ProgId — and Explorer only
;    shows a ShellNew ("New > …") entry belonging to the CURRENT
;    default ProgId, so stamping ours removed Word's
;    "New > Microsoft Word Document" from the right-click menu on
;    every install and every update (field report 2026-08-26). Worse,
;    the generated class was literally NAMED "Word Document" (the
;    association's display name), and uninstall deleted the class
;    without restoring the default — leaving .docx pointing at a key
;    that no longer exists. So .docx is now registered by hand:
;      - a properly-namespaced class, CardMirror.docx;
;      - listed under .docx\OpenWithProgids ONLY. The extension's
;        default value is NEVER written: CardMirror appears in
;        "Open with" and the Windows default-apps UI, Word keeps its
;        ProgId, its New-menu entry, and its double-click default.
;      - a HEALING pass for machines the old installers broke: if
;        .docx's default still reads "Word Document" (our old class
;        name — Word's real ProgIds are Word.Document.N), restore it
;        to Word.Document.12 when Word is present, else delete the
;        value so Windows re-resolves cleanly. Runs on every
;        install/update, so shipping this fixes affected machines
;        automatically. The user's own double-click choice lives in
;        UserChoice, which this never touches.
;
; SHCTX resolves to HKLM for a per-machine install and HKCU for a
; per-user install, so every write lands in the hive the old installer
; wrote (and broke) for that install mode.
;
;
; 3. Run-box aliases (App Paths): typing `cardreflex` or `cardmirror` in
;    Win+R launches the app, whatever its shortcut is called. Debaters'
;    muscle memory survives the CardMirror → CardReflex rename without a
;    visible launcher carrying the old name (brand/README.md). Per-user
;    installs write HKCU, per-machine HKLM, both via SHCTX.
;
; User-facing strings use ${PRODUCT_NAME} (the active brand profile's
; name, from electron-builder.config.cjs). The ProgId `CardMirror.docx`
; is an internal identifier and stays fixed across brands.
;
; ⚠ Registry work is verified by inspection + a real Windows install
; test; Explorer caches ShellNew and association data, so menu changes
; may need an Explorer restart or sign-out to appear.
; ─────────────────────────────────────────────────────────────────────

!include "LogicLib.nsh"

!macro customInstall
  ; ── 1. New > <product> Document ──
  WriteRegStr SHCTX "Software\Classes\.cmir\ShellNew" "FileName" "$INSTDIR\resources\new-template.cmir"

  ; ── 2. .docx: Open-With only, never the default ──
  WriteRegStr SHCTX "Software\Classes\CardMirror.docx" "" "Microsoft Word document"
  WriteRegStr SHCTX "Software\Classes\CardMirror.docx\DefaultIcon" "" "$INSTDIR\resources\docx.ico"
  WriteRegStr SHCTX "Software\Classes\CardMirror.docx\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\CardMirror.docx\shell\open" "" "Open with ${PRODUCT_NAME}"
  WriteRegStr SHCTX "Software\Classes\CardMirror.docx\shell\open\command" "" `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"`
  WriteRegNone SHCTX "Software\Classes\.docx\OpenWithProgids" "CardMirror.docx"

  ; Healing: only ever touches OUR old breakage ("Word Document" is the
  ; class name v1.4.0-and-earlier installers stamped; Word's own ProgIds
  ; are Word.Document.N, so a machine we never broke is left alone).
  ReadRegStr $0 SHCTX "Software\Classes\.docx" ""
  ${If} $0 == "Word Document"
    ClearErrors
    ReadRegStr $1 HKCR "Word.Document.12" ""
    ${If} ${Errors}
      ; No Word on this machine — drop the dangling value so Windows
      ; re-resolves the extension instead of chasing a deleted class.
      DeleteRegValue SHCTX "Software\Classes\.docx" ""
    ${Else}
      WriteRegStr SHCTX "Software\Classes\.docx" "" "Word.Document.12"
    ${EndIf}
  ${EndIf}

  ; ── 3. Run-box aliases (standard app only: Lite must not take them) ──
  !if "${APP_ID}" == "com.cardmirror.app"
    WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\cardreflex.exe" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\cardreflex.exe" "Path" "$INSTDIR"
    WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\cardmirror.exe" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\cardmirror.exe" "Path" "$INSTDIR"
  !endif

  ; Tell Explorer associations changed (SHCNE_ASSOCCHANGED, SHCNF_IDLIST).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !if "${APP_ID}" == "com.cardmirror.app"
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\cardreflex.exe"
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\cardmirror.exe"
  !endif

  DeleteRegKey SHCTX "Software\Classes\.cmir\ShellNew"

  DeleteRegValue SHCTX "Software\Classes\.docx\OpenWithProgids" "CardMirror.docx"
  DeleteRegKey SHCTX "Software\Classes\CardMirror.docx"
  ; Same healing as install: never leave .docx pointing at a class of
  ; ours (current or legacy) that this uninstall just removed.
  ReadRegStr $0 SHCTX "Software\Classes\.docx" ""
  ${If} $0 == "Word Document"
  ${OrIf} $0 == "CardMirror.docx"
    ClearErrors
    ReadRegStr $1 HKCR "Word.Document.12" ""
    ${If} ${Errors}
      DeleteRegValue SHCTX "Software\Classes\.docx" ""
    ${Else}
      WriteRegStr SHCTX "Software\Classes\.docx" "" "Word.Document.12"
    ${EndIf}
  ${EndIf}

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
