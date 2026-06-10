' CAP Leaflet Editor - Silent Launcher
' Spustí CAP-Json-creator.cmd bez viditeľného okna

Set objShell = CreateObject("WScript.Shell")
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' Spustí .cmd v skrytom okne (0 = hidden, False = wait)
objShell.Run strPath & "\CAP-Json-creator.cmd", 0, False

' Počká a informuje užívateľa
WScript.Sleep 4000
objShell.Popup "Aplikácia sa spúšťa..." & vbCrLf & "Prehliadač by sa mal otvoriť automaticky na http://localhost:3000", 3, "CAP Leaflet Editor", 64
