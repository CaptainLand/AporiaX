; Formal installers own this workflow, so even pre-fix clients can use it.
; Never execute another copy's uninstaller. Cleanup is opt-in, post-install,
; file-scoped, hash-bound to the confirmed plan, and recoverable.
!ifndef BUILD_UNINSTALLER
Var ApCopiesEnabled
Var ApCopiesVersion
Var ApCopiesRoot
Var ApCopiesTarget
Var ApCopiesHash
Var ApCopiesPlanReady
Var ApCopiesPrepared
Var ApCopiesOldDir
Var ApCopiesOldUninstall
Var ApCopiesHadDir
Var ApCopiesHadUninstall
Var ApCopiesCuPrepared
Var ApCopiesCuDir
Var ApCopiesCuUninstall
Var ApCopiesCuHadDir
Var ApCopiesCuHadUninstall

!macro ApCopiesHeader
Function AporiaCopiesInit
  StrCpy $ApCopiesEnabled 0
  !ifdef VERSION
    !ifdef BUILD_RESOURCES_DIR
      ${StrContains} $0 "-" "${VERSION}"
      ${If} $0 == ""
      ${AndIfNot} ${Silent}
        ${GetParameters} $0
        ClearErrors
        ${GetOptions} $0 "--skip-organize" $1
        ${If} ${Errors}
          StrCpy $ApCopiesEnabled 1
          StrCpy $ApCopiesVersion "${VERSION}"
          InitPluginsDir
          StrCpy $ApCopiesRoot "$PLUGINSDIR\aporiax-install-copies"
          CreateDirectory "$ApCopiesRoot"
          File /oname=$PLUGINSDIR\aporiax-install-copies\helper.ps1 "${BUILD_RESOURCES_DIR}\installer-copies.ps1"
          ; Capture original registrations BEFORE any legacy installer repair.
          FileOpen $0 "$ApCopiesRoot\seeds.txt" w
          ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
          FileWriteUTF16LE $0 "$1$\r$\n"
          ReadRegStr $1 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
          FileWriteUTF16LE $0 "$1$\r$\n"
          ReadRegStr $1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
          FileWriteUTF16LE $0 "$1$\r$\n"
          ReadRegStr $1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
          FileWriteUTF16LE $0 "$1$\r$\n"
          FileClose $0
        ${EndIf}
      ${EndIf}
    !endif
  !endif
FunctionEnd

Function AporiaCopiesNormalizeDirectory
  ; Basename, not substring: D:\AporiaXTools still gets \AporiaX.
  Push $0
  Push $1
  StrCpy $1 "$INSTDIR"
  ${Do}
  StrCpy $0 "$1" 1 -1
  ${If} $0 == "\"
  ${OrIf} $0 == "/"
    StrCpy $1 "$1" -1
  ${Else}
    ${ExitDo}
  ${EndIf}
  ${Loop}
  ${GetFileName} "$1" $0
  ${If} $0 != "AporiaX"
    StrCpy $1 "$1\AporiaX"
  ${EndIf}
  StrCpy $INSTDIR "$1"
  Pop $1
  Pop $0
FunctionEnd

Function AporiaCopiesPage
  ${If} $ApCopiesEnabled != 1
    Abort
  ${EndIf}
  ${If} $ApLegacyUpdate != 1
    Call AporiaCopiesNormalizeDirectory
  ${ElseIf} $ApLegacyTarget != ""
    StrCpy $INSTDIR "$ApLegacyTarget"
  ${EndIf}
  StrCpy $ApCopiesPlanReady 0
  FileOpen $0 "$ApCopiesRoot\target.txt" w
  FileWriteUTF16LE $0 "$INSTDIR"
  FileClose $0
  ClearErrors
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "$ApCopiesRoot\helper.ps1" -Mode Plan -Version "$ApCopiesVersion" -ProductGuid "${APP_GUID}" -InputDirectory "$ApCopiesRoot" -OwnerHwnd $HWNDPARENT' $0
  ${If} ${Errors}
    StrCpy $0 3
  ${EndIf}
  ${If} $0 == 2
    Call AporiaLegacyRestoreRegistry
    Quit
  ${EndIf}
  ${If} $0 != 0
    ReadINIStr $1 "$ApCopiesRoot\result.ini" result message
    MessageBox MB_OK|MB_ICONSTOP "无法准备整理安装副本，尚未清理任何旧程序。$\r$\n$1$\r$\n可退出后以 --skip-organize 启动安装器，使用原有安装流程。"
    Call AporiaLegacyRestoreRegistry
    Quit
  ${EndIf}
  ReadINIStr $ApCopiesTarget "$ApCopiesRoot\result.ini" result target
  ${If} $ApCopiesTarget == ""
    Call AporiaLegacyStop
  ${EndIf}
  ${StdUtils.HashFile} $ApCopiesHash "SHA2-256" "$ApCopiesRoot\plan.json"
  StrLen $0 $ApCopiesHash
  ${If} $0 != 64
    Call AporiaLegacyStop
  ${EndIf}
  StrCpy $INSTDIR "$ApCopiesTarget"
  FileOpen $0 "$ApCopiesRoot\target.txt" w
  FileWriteUTF16LE $0 "$ApCopiesTarget"
  FileClose $0
  StrCpy $ApCopiesPlanReady 1
  ; The confirmation form is the page; proceed to the native install progress.
  Abort
FunctionEnd

Function AporiaCopiesRestoreCu
  ${If} $ApCopiesCuPrepared != 1
    Return
  ${EndIf}
  ${If} $ApCopiesCuHadDir == 1
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$ApCopiesCuDir"
  ${Else}
    DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}
  ${If} $ApCopiesCuHadUninstall == 1
    WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString "$ApCopiesCuUninstall"
  ${Else}
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${EndIf}
  StrCpy $ApCopiesCuPrepared 0
FunctionEnd

Function AporiaCopiesRestore
  Call AporiaCopiesRestoreCu
  ${If} $ApCopiesPrepared != 1
    Return
  ${EndIf}
  ${If} $ApCopiesHadDir == 1
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$ApCopiesOldDir"
  ${Else}
    DeleteRegValue SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}
  ${If} $ApCopiesHadUninstall == 1
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString "$ApCopiesOldUninstall"
  ${Else}
    DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${EndIf}
  StrCpy $ApCopiesPrepared 0
FunctionEnd

Function AporiaCopiesPrepareTarget
  ${If} $ApCopiesPlanReady != 1
    Call AporiaLegacyStop
  ${EndIf}
  ${StdUtils.HashFile} $0 "SHA2-256" "$ApCopiesRoot\plan.json"
  ${If} $0 != $ApCopiesHash
    Call AporiaLegacyStop
  ${EndIf}
  ${If} $ApCopiesPrepared == 1
    Return
  ${EndIf}
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "$ApCopiesRoot\helper.ps1" -Mode Validate -Version "$ApCopiesVersion" -ProductGuid "${APP_GUID}" -InputDirectory "$ApCopiesRoot" -PlanHash "$ApCopiesHash"' $0
  WriteINIStr "$ApCopiesRoot\validation.ini" result code "$0"
  ${If} $0 != 0
    Call AporiaLegacyStop
  ${EndIf}
  ; Keep all old files in place until NEW files are installed and validated.
  ; Temporarily suppress upstream uninstallOldVersion, including its separate
  ; HKCU pass during an all-users install. Failure restores original values.
  ClearErrors
  ReadRegStr $ApCopiesOldDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCpy $ApCopiesHadDir 1
  ${If} ${Errors}
    StrCpy $ApCopiesHadDir 0
  ${EndIf}
  ClearErrors
  ReadRegStr $ApCopiesOldUninstall SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  StrCpy $ApCopiesHadUninstall 1
  ${If} ${Errors}
    StrCpy $ApCopiesHadUninstall 0
  ${EndIf}
  ${If} $installMode == "all"
    ClearErrors
    ReadRegStr $ApCopiesCuDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCpy $ApCopiesCuHadDir 1
    ${If} ${Errors}
      StrCpy $ApCopiesCuHadDir 0
    ${EndIf}
    ClearErrors
    ReadRegStr $ApCopiesCuUninstall HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    StrCpy $ApCopiesCuHadUninstall 1
    ${If} ${Errors}
      StrCpy $ApCopiesCuHadUninstall 0
    ${EndIf}
    StrCpy $ApCopiesCuPrepared 1
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${EndIf}
  StrCpy $ApCopiesPrepared 1
  DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ; Fail closed if a policy prevented suppressing either uninstall call.
  ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $0 != ""
    Call AporiaLegacyStop
  ${EndIf}
  ${If} $installMode == "all"
    ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${If} $0 != ""
      Call AporiaLegacyStop
    ${EndIf}
  ${EndIf}
  StrCpy $INSTDIR "$ApCopiesTarget"
FunctionEnd

Function AporiaCopiesInstalled
  ${If} $ApCopiesPlanReady != 1
    Return
  ${EndIf}
  ; Installation has committed its new registry values. Restore only the
  ; temporarily hidden HKCU entry; cleanup removes it only if that copy moves.
  StrCpy $ApCopiesPrepared 0
  Call AporiaCopiesRestoreCu
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "$ApCopiesRoot\helper.ps1" -Mode Complete -Version "$ApCopiesVersion" -ProductGuid "${APP_GUID}" -InputDirectory "$ApCopiesRoot" -PlanHash "$ApCopiesHash"' $0
  ReadINIStr $1 "$ApCopiesRoot\result.ini" result message
  ${If} $1 == ""
    StrCpy $1 "未完成旧副本整理，新版已安装。没有主动删除用户数据。"
  ${EndIf}
  MessageBox MB_OK|MB_ICONINFORMATION "$1"
FunctionEnd
!macroend
!endif
