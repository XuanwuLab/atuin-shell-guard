$plan = @'
Remove-Item data-only.pptx
'@

Write-Output $plan
Get-ChildItem docs/*.pptx | ForEach-Object {
  Remove-Item $_.FullName
}
