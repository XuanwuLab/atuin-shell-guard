$paths = @{ Path = @("docs/a.pptx", "docs/b.docx"); Force = $true }
Remove-Item @paths
Set-Content -Path out/report.txt -Value "replacement"
