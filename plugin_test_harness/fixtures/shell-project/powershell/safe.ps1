$instructions = @'
Remove-Item docs/presentation.pptx
rm -rf docs
'@

Write-Output $instructions
Remove-Item docs/presentation.pptx -WhatIf
"ready" | Out-File -FilePath tmp/powershell-project-status.txt -NoClobber
