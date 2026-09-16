' Launcher im lang: mo ban build (app chinh) — khong hien cua so CMD
' Dat trong scripts\ — WorkingDirectory = project root (thu muc cha)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
folder = fso.GetParentFolderName(scriptDir)
sh.CurrentDirectory = folder

If Not fso.FolderExists(folder & "\node_modules") Then
  rc = sh.Run("cmd /c npm install", 1, True)
  If rc <> 0 Then
    MsgBox "Cai dat dependencies that bai.", vbCritical, "Chrome Manager"
    WScript.Quit 1
  End If
End If

' Dam bao co ban build moi nhat truoc khi mo app chinh
logFile = folder & "\scripts\last-build.log"
rc = sh.Run("cmd /c npm run build > """ & logFile & """ 2>&1", 0, True)
If rc <> 0 Then
  MsgBox "Build that bai. Chi tiet: scripts\last-build.log" & vbCrLf & "Se mo bang che do dev.", vbExclamation, "Chrome Manager"
  sh.Run "cmd /c npm run dev", 0, False
  WScript.Quit 0
End If

' Chay Electron tren out/ (package.json main = ./out/main/index.js)
electronCmd = "cmd /c """ & folder & "\node_modules\.bin\electron.cmd"" ."
sh.Run electronCmd, 0, False
