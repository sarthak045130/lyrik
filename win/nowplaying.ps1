# Lyrik — Windows "now playing" helper.
# Reads the System Media Transport Controls (the same data the Windows volume flyout shows),
# so it works with Spotify, Apple Music for Windows, iTunes, browsers, VLC and more.
#   -Mode watch : prints one JSON line about every 600 ms
#   -Mode cmd   : runs one command (toggle | next | prev) and exits
param([string]$Mode = 'watch', [string]$Cmd = '')

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# helper to await WinRT async operations from PowerShell 5.1
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(-1)
  $task.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgrType   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = Await ($mgrType::RequestAsync()) $mgrType

# prefer a session that is playing, then one that is paused, then whatever Windows considers current
function Pick-Session {
  $paused = $null
  foreach ($s in $mgr.GetSessions()) {
    $st = [string]$s.GetPlaybackInfo().PlaybackStatus
    if ($st -eq 'Playing') { return $s }
    if (-not $paused -and $st -eq 'Paused') { $paused = $s }
  }
  if ($paused) { return $paused }
  return $mgr.GetCurrentSession()
}

if ($Mode -eq 'cmd') {
  $s = Pick-Session
  if ($s) {
    switch ($Cmd) {
      'toggle' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
      'next'   { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
      'prev'   { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
    }
  }
  exit
}

while ($true) {
  try {
    $s = Pick-Session
    if ($s) {
      $p  = Await ($s.TryGetMediaPropertiesAsync()) $propsType
      $tl = $s.GetTimelineProperties()
      $playing = ([string]$s.GetPlaybackInfo().PlaybackStatus -eq 'Playing')
      $pos = $tl.Position.TotalSeconds
      if ($playing) {
        # Position is as of LastUpdatedTime — add the time that has passed since
        $age = ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds
        if ($age -gt 0 -and $age -lt 30) { $pos += $age }
      }
      $o = [ordered]@{
        ok = $true; playing = $playing; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle
        duration = ($tl.EndTime - $tl.StartTime).TotalSeconds; position = $pos; app = $s.SourceAppUserModelId
      }
      [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
    } else {
      [Console]::Out.WriteLine('{"ok":false}')
    }
  } catch {
    [Console]::Out.WriteLine('{"ok":false}')
  }
  Start-Sleep -Milliseconds 600
}
