$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$executable = Join-Path $appRoot 'app\Sir David Blackenfeather.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Programfilen saknas. Behåll hela app-mappen.' }
$desktopDirectory = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopDirectory 'Sir David Blackenfeather.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.TargetPath -and $shortcut.TargetPath -ne $executable) {
    throw 'Det finns redan en genväg med samma namn till ett annat program. Den har inte ändrats.'
}
$shortcut.TargetPath = $executable
$shortcut.WorkingDirectory = Join-Path $appRoot 'app'
$shortcut.Description = 'Sir David Blackenfeather – din privata korp i Admin'
$shortcut.IconLocation = $executable + ',0'
$shortcut.Save()
Write-Output ('Skrivbordsgenväg skapad: ' + $shortcutPath)
