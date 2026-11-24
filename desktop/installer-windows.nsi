# A custom script prevents electron-builder from running a generated Windows
# executable under Wine. WriteUninstaller runs only on the installing PC.
!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!define InstallPath "$LOCALAPPDATA\Programs\Job Market Pulse"

# Do not follow junctions, symlinks or other reparse points. A path that
# cannot be inspected is unsafe unless it is optional and does not exist.
!macro ReadAttributes PATH
  System::Call 'kernel32::GetFileAttributesW(w "${PATH}") i .r0 ?e'
  Pop $1
!macroend

!macro CheckPlainDirectory PATH REQUIRED
  !insertmacro ReadAttributes "${PATH}"
  ${If} $0 = -1
    !if ${REQUIRED} == 1
      !insertmacro UnsafeDirectory "${PATH}"
    !else
      ${If} $1 <> 2
      ${AndIf} $1 <> 3
        !insertmacro UnsafeDirectory "${PATH}"
      ${EndIf}
    !endif
  ${Else}
    # FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT
    IntOp $0 $0 & 0x410
    ${If} $0 <> 0x10
      !insertmacro UnsafeDirectory "${PATH}"
    ${EndIf}
  ${EndIf}
!macroend

!macro UnsafeDirectory PATH
  MessageBox MB_ICONSTOP "Cannot safely use the folder: ${PATH}"
  Abort
!macroend

!macro CheckInstallAncestors
  !insertmacro CheckPlainDirectory "$LOCALAPPDATA\Programs" 0
  ${GetRoot} "$LOCALAPPDATA" $3
  StrCpy $2 "$LOCALAPPDATA"
  ${DoWhile} $2 != $3
    ${If} $2 == ""
      !insertmacro UnsafeDirectory "$LOCALAPPDATA"
    ${EndIf}
    !insertmacro CheckPlainDirectory "$2" 1
    ${GetParent} "$2" $2
  ${Loop}
!macroend

!include "${PROJECT_DIR}/local_only/package-windows/output/uninstall-files.nsh"

Name "${PRODUCT_NAME}"
RequestExecutionLevel user
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Job Market Pulse requires 64-bit Windows."
    Abort
  ${EndIf}
  StrCpy $INSTDIR "${InstallPath}"
FunctionEnd

Section "Install"
  SetShellVarContext current
  InitPluginsDir
  !insertmacro CheckInstallAncestors
  CreateDirectory "$LOCALAPPDATA\Programs"
  !insertmacro CheckPlainDirectory "$LOCALAPPDATA\Programs" 1

  # Only one installer can create the final directory. SetOutPath alone
  # would accept a directory created by another installer in the meantime.
  System::Call 'kernel32::CreateDirectoryW(w "$INSTDIR", p 0) i .r0'
  ${If} $0 = 0
    MessageBox MB_ICONSTOP "Cannot create the install folder. If it already exists, uninstall the previous copy first."
    Abort
  ${EndIf}

  ClearErrors
  SetOutPath "$INSTDIR"
  IfErrors install_failed
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  IfErrors install_failed

  # The archive already uses ZIP compression.
  SetCompress off
  File /oname=$PLUGINSDIR\app.zip "${APP_64}"
  SetCompress auto
  nsisunz::Unzip "$PLUGINSDIR\app.zip" "$INSTDIR"
  Pop $0
  StrCmp $0 "success" 0 install_failed

  # Do not register shortcuts or Apps entries outside the owned directory.
  Goto done

  install_failed:
    MessageBox MB_ICONSTOP "Cannot finish installation. If present, run Uninstall.exe in the installation folder before you try again."
    Abort
  done:
SectionEnd

Function un.onInit
  StrCmp $INSTDIR "${InstallPath}" done
    MessageBox MB_ICONSTOP "Run Uninstall.exe from the Job Market Pulse installation folder."
    Abort
  done:
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  SetOutPath "$TEMP"
  !insertmacro CheckInstallAncestors
  !insertmacro CheckPlainDirectory "$INSTDIR" 1
  !insertmacro CheckPayloadDirectories
  !insertmacro RemovePayloadFiles
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Goto done

  uninstall_failed:
    MessageBox MB_ICONSTOP "Cannot remove an installed file. Close Job Market Pulse and Pulse, then try again."
    Abort
  done:
SectionEnd
