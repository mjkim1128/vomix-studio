; Vomix Studio installer (Inno Setup 6).  Build:  ISCC.exe packaging\vomix.iss   (after  python packaging\build_stage.py)
#define AppName "Vomix Studio"
#define AppVersion "0.1.0"
#define StageDir "..\dist\VomixStudio"

[Setup]
AppId={{6F3B1D52-8C1E-4B6A-9E57-2A7D4C0F91B3}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
VersionInfoVersion={#AppVersion}
; installs for the current user only: no administrator rights needed, projects live in %LOCALAPPDATA%\VomixStudio
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist\installer
OutputBaseFilename=VomixStudio-Setup-{#AppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\assets\icon.ico
UninstallDisplayName={#AppName}
WizardStyle=modern
WizardImageFile=wizard\left_164.bmp,wizard\left_246.bmp,wizard\left_328.bmp
WizardSmallImageFile=wizard\small_55.bmp,wizard\small_110.bmp
Compression=lzma2/normal
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DiskSpanning=no
ShowLanguageDialog=auto
CloseApplications=no
; the launcher holds this mutex while it runs: Setup and the uninstaller ask to close the program first
AppMutex=VomixStudioRunning

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\launcher.py"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"; Comment: "{#AppName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\launcher.py"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\launcher.py"""; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; python writes __pycache__ files while the program runs; they are not in the install log
Type: filesandordirs; Name: "{app}"

[CustomMessages]
korean.KeepData=내 프로젝트와 분석한 참조곡(%LOCALAPPDATA%\VomixStudio)도 함께 지울까요?%n%n[아니요]를 누르면 나중에 다시 설치해도 작업을 이어서 할 수 있어요.
english.KeepData=Also delete your projects and analysed reference songs (%LOCALAPPDATA%\VomixStudio)?%n%nChoose No to keep them for a later reinstall.

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  dataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    dataDir := ExpandConstant('{localappdata}\VomixStudio');
    if DirExists(dataDir) then
      if MsgBox(CustomMessage('KeepData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(dataDir, True, True, True);
  end;
end;
