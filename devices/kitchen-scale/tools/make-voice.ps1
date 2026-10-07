# Records the scale's spoken clips with Windows' built-in voice (System.Speech: no download, no API).
# Reads the CLIP(ID, "text") lines of lib/speech/src/clips.h and writes tools/voice/<ID>.wav
# (16 kHz, 16-bit, mono). Then run:  py tools/wav2adpcm.py   (packs them into src/voice_data.h)
#
#   powershell -ExecutionPolicy Bypass -File tools/make-voice.ps1 [-Voice "Microsoft Zira Desktop"] [-Rate 0]
param(
  [string]$Voice = "",
  [int]$Rate = 0
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$root = Split-Path -Parent $PSScriptRoot
$clips = Get-Content (Join-Path $root "lib/speech/src/clips.h") -Raw
$items = [regex]::Matches($clips, 'CLIP\((\w+),\s*"([^"]*)"\)')
if ($items.Count -eq 0) { throw "No CLIP lines found in clips.h" }

$out = Join-Path $PSScriptRoot "voice"
New-Item -ItemType Directory -Force $out | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice) { $synth.SelectVoice($Voice) }
else {
  # Prefer a female English voice if one is installed; otherwise Windows' default.
  $pick = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like "en-*" -and $_.VoiceInfo.Gender -eq "Female" } | Select-Object -First 1
  if ($pick) { $synth.SelectVoice($pick.VoiceInfo.Name) }
}
$synth.Rate = $Rate
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

foreach ($m in $items) {
  $id = $m.Groups[1].Value
  $text = $m.Groups[2].Value
  $file = Join-Path $out "$id.wav"
  $synth.SetOutputToWaveFile($file, $fmt)
  $synth.Speak($text)
  $synth.SetOutputToNull()
  Write-Host ("{0,-18} {1}" -f $id, $text)
}
Write-Host "Voice: $($synth.Voice.Name) - $($items.Count) clips in $out"
$synth.Dispose()
