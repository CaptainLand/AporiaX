; Compatibility belongs in the NEW installer: old clients do not pass /D.
; Never scan drives, guess D:, or execute a different copy's uninstaller.
!ifndef BUILD_UNINSTALLER
!include FileFunc.nsh
!include LogicLib.nsh
!include nsDialogs.nsh
!define MUI_CUSTOMFUNCTION_ABORT AporiaLegacyRestoreRegistry

!macro ApLegacyGetInQuotes VAR VALUE
  Push "${VALUE}"
  Call AporiaLegacyQuotedPath
  Pop "${VAR}"
!macroend

Var ApLegacyUpdate
Var ApLegacyExplicit
Var ApLegacyCount
Var ApLegacyDir1
Var ApLegacyDir2
Var ApLegacyDir3
Var ApLegacyDir4
Var ApLegacyScope1
Var ApLegacyScope2
Var ApLegacyScope3
Var ApLegacyScope4
Var ApLegacyCandidate
Var ApLegacyCandidateScope
Var ApLegacyTarget
Var ApLegacyScope
Var ApLegacyDialog
Var ApLegacyList
Var ApLegacyPrepared
Var ApLegacyOldDir
Var ApLegacyOldUninstall
Var ApLegacyHadDir
Var ApLegacyHadUninstall
Var ApLegacyScopeFound

; electron-builder reads include files before common.nsh defines its product
; constants and variables. Emit functions from customHeader, not at include time.
!macro ApLegacyDeduplicate N
  ${If} $ApLegacyCandidate == $ApLegacyDir${N}
  ${AndIf} $ApLegacyCandidateScope == $ApLegacyScope${N}
    Return
  ${EndIf}
!macroend

!macro ApLegacyStore N
  ${If} $ApLegacyCount == ${N}
    StrCpy $ApLegacyDir${N} $ApLegacyCandidate
    StrCpy $ApLegacyScope${N} $ApLegacyCandidateScope
  ${EndIf}
!macroend

!macro ApLegacyRead ROOT SCOPE
  StrCpy $ApLegacyCandidateScope "${SCOPE}"
  ReadRegStr $ApLegacyCandidate ${ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation
  Call AporiaLegacyAddCandidate
  ReadRegStr $0 ${ROOT} "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ; Only a quoted, product-specific uninstaller is a recovery source.
  !insertmacro ApLegacyGetInQuotes $1 "$0"
  ${GetFileName} "$1" $2
  ${If} $2 == "${UNINSTALL_FILENAME}"
    ${GetParent} "$1" $ApLegacyCandidate
    Call AporiaLegacyAddCandidate
  ${EndIf}
!macroend

!macro ApLegacyAddChoice N
  ${If} $ApLegacyCount >= ${N}
    ${If} $ApLegacyScope${N} == "all"
      ${NSD_CB_AddString} $ApLegacyList "$ApLegacyDir${N}（所有用户）"
    ${Else}
      ${NSD_CB_AddString} $ApLegacyList "$ApLegacyDir${N}（当前用户）"
    ${EndIf}
  ${EndIf}
!macroend

!macro ApLegacySelectChoice N INDEX
  ${If} $0 == ${INDEX}
    StrCpy $ApLegacyTarget $ApLegacyDir${N}
    StrCpy $ApLegacyScope $ApLegacyScope${N}
  ${EndIf}
!macroend

!macro ApLegacyMatchExplicitScope N
  ${If} $ApLegacyScopeFound != 1
  ${AndIf} $ApLegacyTarget == $ApLegacyDir${N}
    StrCpy $ApLegacyScope $ApLegacyScope${N}
    StrCpy $ApLegacyScopeFound 1
  ${EndIf}
!macroend

!macro customHeader
Function AporiaLegacyQuotedPath
  Exch $R0
  Push $R1
  Push $R2
  StrCpy $R1 0
  ${Do}
    StrCpy $R2 $R0 1 $R1
    ${If} $R2 == ""
      StrCpy $R0 ""
      Goto ApQuotedDone
    ${EndIf}
    IntOp $R1 $R1 + 1
  ${LoopUntil} $R2 == '$\"'
  StrCpy $R0 $R0 "" $R1
  StrCpy $R1 0
  ${Do}
    StrCpy $R2 $R0 1 $R1
    ${If} $R2 == ""
      StrCpy $R0 ""
      Goto ApQuotedDone
    ${EndIf}
    ${If} $R2 == '$\"'
      StrCpy $R0 $R0 $R1
      Goto ApQuotedDone
    ${EndIf}
    IntOp $R1 $R1 + 1
  ${Loop}
  ApQuotedDone:
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd
Function AporiaLegacyValidateTarget
  ; Returns the normalized directory, or empty, in ApLegacyCandidate.
  ${If} $ApLegacyCandidate == ""
    Return
  ${EndIf}
  StrCpy $0 $ApLegacyCandidate 2
  StrCpy $1 $ApLegacyCandidate 1 1
  StrCpy $2 $ApLegacyCandidate 1 2
  ${If} $0 != "\\"
    ${If} $1 != ":"
      StrCpy $ApLegacyCandidate ""
      Return
    ${EndIf}
    ${If} $2 != "\"
    ${AndIf} $2 != "/"
      StrCpy $ApLegacyCandidate ""
      Return
    ${EndIf}
  ${EndIf}
  GetFullPathName $ApLegacyCandidate $ApLegacyCandidate
  ${GetRoot} "$ApLegacyCandidate" $0
  ${If} $ApLegacyCandidate == "$0\"
  ${OrIf} $ApLegacyCandidate == "$0"
    StrCpy $ApLegacyCandidate ""
    Return
  ${EndIf}
  StrLen $0 $WINDIR
  StrCpy $1 $ApLegacyCandidate $0
  ${If} $1 == $WINDIR
    StrCpy $ApLegacyCandidate ""
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$ApLegacyCandidate\${APP_EXECUTABLE_FILENAME}"
  ${OrIfNot} ${FileExists} "$ApLegacyCandidate\resources\app.asar"
  ${OrIfNot} ${FileExists} "$ApLegacyCandidate\${UNINSTALL_FILENAME}"
    StrCpy $ApLegacyCandidate ""
  ${EndIf}
FunctionEnd

Function AporiaLegacyAddCandidate
  Call AporiaLegacyValidateTarget
  ${If} $ApLegacyCandidate == ""
    Return
  ${EndIf}

  !insertmacro ApLegacyDeduplicate 1
  !insertmacro ApLegacyDeduplicate 2
  !insertmacro ApLegacyDeduplicate 3
  !insertmacro ApLegacyDeduplicate 4
  IntOp $ApLegacyCount $ApLegacyCount + 1

  !insertmacro ApLegacyStore 1
  !insertmacro ApLegacyStore 2
  !insertmacro ApLegacyStore 3
  !insertmacro ApLegacyStore 4
FunctionEnd

Function AporiaLegacyReadCandidates
  StrCpy $ApLegacyCount 0

  !insertmacro ApLegacyRead HKCU CurrentUser
  !insertmacro ApLegacyRead HKLM all
FunctionEnd

Function AporiaLegacyStop
  Call AporiaLegacyRestoreRegistry
  MessageBox MB_OK|MB_ICONSTOP "无法安全确定 AporiaX 更新目录。请退出安装，使用已下载的安装包确认原安装目录后再更新；本次不会默认安装到 C 盘。" /SD IDOK
  SetErrorLevel 51041
  Quit
FunctionEnd

Function AporiaLegacyPrepareTarget
  ${If} $ApLegacyPrepared == 1
    Return
  ${EndIf}
  StrCpy $ApLegacyCandidate $ApLegacyTarget
  Call AporiaLegacyValidateTarget
  ${If} $ApLegacyCandidate == ""
    Call AporiaLegacyStop
  ${EndIf}
  StrCpy $ApLegacyTarget $ApLegacyCandidate
  ; The upstream all-users installer also uninstalls HKCU. Do not let it
  ; remove a separate user installation as a side effect of this update.
  ${If} $ApLegacyScope == "all"
    ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${If} $0 != ""
      !insertmacro ApLegacyGetInQuotes $1 "$0"
      ${GetParent} "$1" $2
      GetFullPathName $2 "$2"
      ${If} $2 != $ApLegacyTarget
        Call AporiaLegacyStop
      ${EndIf}
      ReadRegStr $2 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $2 != ""
        GetFullPathName $2 "$2"
        ${If} $2 != $ApLegacyTarget
          Call AporiaLegacyStop
        ${EndIf}
      ${EndIf}
    ${EndIf}
    StrCpy $installMode all
    SetShellVarContext all
  ${Else}
    StrCpy $installMode CurrentUser
    SetShellVarContext current
  ${EndIf}
  ClearErrors
  ReadRegStr $ApLegacyOldDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCpy $ApLegacyHadDir 1
  ${If} ${Errors}
    StrCpy $ApLegacyHadDir 0
  ${EndIf}
  ClearErrors
  ReadRegStr $ApLegacyOldUninstall SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  StrCpy $ApLegacyHadUninstall 1
  ${If} ${Errors}
    StrCpy $ApLegacyHadUninstall 0
  ${EndIf}
  ; Align BOTH fields before upstream uninstallOldVersion passes _?=.
  ; Updating only INSTDIR can otherwise uninstall a different directory.
  StrCpy $ApLegacyPrepared 1
  ClearErrors
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$ApLegacyTarget"
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString '$\"$ApLegacyTarget\${UNINSTALL_FILENAME}$\"'
  ${If} ${Errors}
    Call AporiaLegacyRestoreRegistry
    Call AporiaLegacyStop
  ${EndIf}
  StrCpy $INSTDIR $ApLegacyTarget
FunctionEnd

Function AporiaLegacyRestoreRegistry
  ${If} $ApLegacyPrepared != 1
    Return
  ${EndIf}
  ${If} $ApLegacyScope == "all"
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
  ${If} $ApLegacyHadDir == 1
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$ApLegacyOldDir"
  ${Else}
    DeleteRegValue SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}
  ${If} $ApLegacyHadUninstall == 1
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString "$ApLegacyOldUninstall"
  ${Else}
    DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${EndIf}
  StrCpy $ApLegacyPrepared 0
FunctionEnd

Function AporiaLegacyUpdateCompleted
  StrCpy $ApLegacyPrepared 0
FunctionEnd

Function AporiaLegacyElevateIfNeeded
  ${If} $ApLegacyScope == "all"
  ${AndIfNot} ${UAC_IsAdmin}
    StrCpy $2 "--updated /allusers"
    ${If} ${Silent}
      StrCpy $2 "$2 /S"
    ${EndIf}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "--force-run" $1
    ${IfNot} ${Errors}
      StrCpy $2 "$2 --force-run"
    ${EndIf}
    ClearErrors
    ExecShell "runas" "$EXEPATH" '$2 /D=$ApLegacyTarget'
    ${If} ${Errors}
      Call AporiaLegacyStop
    ${EndIf}
    Quit
  ${EndIf}
FunctionEnd
!insertmacro ApLegacyPageFunctions
!macroend

!macro customInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--updated" $1
  ${If} ${Errors}
    StrCpy $ApLegacyUpdate 0
  ${Else}
    StrCpy $ApLegacyUpdate 1
    !insertmacro GetDParameter $ApLegacyExplicit
    ${If} $ApLegacyExplicit != ""
      StrCpy $ApLegacyCandidate $ApLegacyExplicit
      Call AporiaLegacyValidateTarget
      ${If} $ApLegacyCandidate == ""
        Call AporiaLegacyStop
      ${EndIf}
      StrCpy $ApLegacyTarget $ApLegacyCandidate
      StrCpy $ApLegacyScope $installMode
      Call AporiaLegacyReadCandidates
      ; Respect the selected copy's registered scope rather than another
      ; copy's default mode. Prefer HKCU when the same path is registered twice.
      !insertmacro ApLegacyMatchExplicitScope 1
      !insertmacro ApLegacyMatchExplicitScope 2
      !insertmacro ApLegacyMatchExplicitScope 3
      !insertmacro ApLegacyMatchExplicitScope 4
    ${Else}
      Call AporiaLegacyReadCandidates
      ${If} $ApLegacyCount == 1
        StrCpy $ApLegacyTarget $ApLegacyDir1
        StrCpy $ApLegacyScope $ApLegacyScope1
      ${ElseIf} $ApLegacyCount == 0
        Call AporiaLegacyStop
      ${Else}
        ${If} ${Silent}
          ; A legacy silent caller cannot answer the destination question.
          Call AporiaLegacyStop
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} ${Silent}
      Call AporiaLegacyElevateIfNeeded
      Call AporiaLegacyPrepareTarget
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstallMode
  ${If} $ApLegacyUpdate == 1
  ${AndIf} $ApLegacyTarget != ""
    ${If} $ApLegacyScope == "all"
      StrCpy $isForceMachineInstall 1
    ${Else}
      StrCpy $isForceCurrentInstall 1
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom AporiaLegacyDestinationPage AporiaLegacyDestinationLeave
  ; Assisted installers normally append APP_FILENAME to custom directories.
  ; That is appropriate for a fresh install, never for an existing-copy update.
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE AporiaLegacyInstFilesPre
!macroend

!macro ApLegacyPageFunctions
Function AporiaLegacyInstFilesPre
  ${If} $ApLegacyUpdate == 1
    Call AporiaLegacyPrepareTarget
    StrCpy $INSTDIR $ApLegacyTarget
  ${Else}
    !ifdef allowToChangeInstallationDirectory
      Call instFilesPre
    !endif
  ${EndIf}
FunctionEnd

Function AporiaLegacyDestinationPage
  ${If} $ApLegacyUpdate != 1
    Abort
  ${EndIf}
  ${If} $ApLegacyTarget != ""
    Call AporiaLegacyPrepareTarget
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "选择要更新的 AporiaX" "发现多个安装位置，请确认本次要覆盖的那一份。"
  nsDialogs::Create 1018
  Pop $ApLegacyDialog
  ${If} $ApLegacyDialog == error
    Call AporiaLegacyStop
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 32u "不会重新下载安装包。只更新你选择的目录；对话和用户配置不会被主动删除。"
  Pop $0
  ${NSD_CreateDropList} 0 40u 100% 100u ""
  Pop $ApLegacyList

  !insertmacro ApLegacyAddChoice 1
  !insertmacro ApLegacyAddChoice 2
  !insertmacro ApLegacyAddChoice 3
  !insertmacro ApLegacyAddChoice 4
  ; No default selection: do not turn a guess into an overwrite.
  nsDialogs::Show
FunctionEnd

Function AporiaLegacyDestinationLeave
  ${If} $ApLegacyTarget != ""
    Return
  ${EndIf}
  SendMessage $ApLegacyList ${CB_GETCURSEL} 0 0 $0
  ${If} $0 == -1
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先选择你要更新的 AporiaX 目录。"
    Abort
  ${EndIf}

  !insertmacro ApLegacySelectChoice 1 0
  !insertmacro ApLegacySelectChoice 2 1
  !insertmacro ApLegacySelectChoice 3 2
  !insertmacro ApLegacySelectChoice 4 3
  ; Machine selection may require elevation. Restart with an explicit /D so
  ; the elevation hop cannot lose the selected destination.
  Call AporiaLegacyElevateIfNeeded
  Call AporiaLegacyPrepareTarget
FunctionEnd

Function .onInstFailed
  Call AporiaLegacyRestoreRegistry
FunctionEnd

!macroend
!endif
