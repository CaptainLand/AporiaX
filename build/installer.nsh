!include "${BUILD_RESOURCES_DIR}\installer-legacy-update.nsh"

; electron-builder intentionally keeps shortcuts during an update. If the
; registered installation was a different copy, those shortcuts can still point
; at the old directory after /D= selects the running copy. Retarget only links
; that already exist; do not recreate shortcuts the user deliberately removed.
!macro customInstall
  Call AporiaLegacyUpdateCompleted
  SetOutPath "$INSTDIR"
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${if} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${endif}
  !endif
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${ifNot} ${isNoDesktopShortcut}
      ${if} ${FileExists} "$newDesktopLink"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${endif}
    ${endif}
  !endif
!macroend
