# Raises one Windows toast that says the switcher took this tool's traffic.
#
# The launcher shim calls this detached, so it must never block and never fail loudly: a coding
# tool must start even when the notification does not. It reads one argument, the route file of
# the tool. An absent or empty file means the tool is not routed, and then nothing is shown.
#
# No module is installed. WinRT is used through the PowerShell application id, which exists on
# every Windows 10 and 11 machine.
param([Parameter(Mandatory = $true)][string]$RouteFile)

$ErrorActionPreference = 'Stop'
trap { exit 0 }

if (-not (Test-Path -LiteralPath $RouteFile)) { exit 0 }
$line = (Get-Content -LiteralPath $RouteFile -Raw -ErrorAction SilentlyContinue)
if ($null -eq $line) { exit 0 }
$line = $line.Trim()
if ($line.Length -eq 0) { exit 0 }

# The line is data, so it is escaped before it enters the toast XML.
$body = [System.Security.SecurityElement]::Escape($line)

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$xml = @"
<toast activationType="protocol" launch="http://127.0.0.1:3456/ui">
  <visual>
    <binding template="ToastGeneric">
      <text>LLM Switcher is ON</text>
      <text>$body</text>
      <text placement="attribution">This tool does not reach its official endpoint.</text>
    </binding>
  </visual>
</toast>
"@

$doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
$doc.LoadXml($xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
# One tag per tool: a second launch of the same tool replaces its notice instead of stacking.
$toast.Tag = 'llm-switcher-route'
$toast.Group = 'llm-switcher'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
exit 0
