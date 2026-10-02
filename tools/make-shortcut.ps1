# Create the desktop shortcut for the Resume Workbench.
# Pure ASCII on purpose: Chinese names arrive base64-encoded and are decoded at
# runtime, and the project root is derived from $PSScriptRoot (this file lives
# in <project>/tools/), so no Chinese ever crosses a process boundary as an
# argument — cmd/PowerShell codepage quirks cannot corrupt it.
$dec = { param($s) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
$lnkName = & $dec '566A5Y6G5bel5L2c5Y+wLmxuaw=='          # 简历工作台.lnk
$target  = & $dec '5ZCv5Yqo566A5Y6G5bel5L2c5Y+wLmJhdA=='  # 启动简历工作台.bat
$msg     = & $dec '5bey5Zyo5qGM6Z2i5Yib5bu644CM566A5Y6G5bel5L2c5Y+w44CN5b+r5o235pa55byP44CC'

$root = Split-Path -Parent $PSScriptRoot   # <project>/tools -> <project>

$w = New-Object -ComObject WScript.Shell
$d = [Environment]::GetFolderPath('Desktop')
$l = $w.CreateShortcut((Join-Path $d $lnkName))
$l.TargetPath = (Join-Path $root $target)
$l.WorkingDirectory = $root
$l.Save()
Write-Host $msg
