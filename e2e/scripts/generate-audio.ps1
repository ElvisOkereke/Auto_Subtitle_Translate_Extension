# Generates deterministic speech fixtures with the built-in Windows TTS voice.
# Usage: powershell -ExecutionPolicy Bypass -File e2e/scripts/generate-audio.ps1
Add-Type -AssemblyName System.Speech
$out = Join-Path $PSScriptRoot '..\fixtures\audio'
New-Item -ItemType Directory -Force $out | Out-Null

$fixtures = @{
  'hello.wav'    = 'Hello world. The weather is very nice today.'
  'sentences.wav' = 'Good morning everyone. <break time="1500ms"/> Thank you for coming to the meeting. <break time="1500ms"/> Please open your books to page ten.'
}

foreach ($name in $fixtures.Keys) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile((Join-Path $out $name), $fmt)
  $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><break time="800ms"/>' + $fixtures[$name] + '<break time="2000ms"/></speak>'
  $s.SpeakSsml($ssml)
  $s.Dispose()
  Write-Output "wrote $name"
}
