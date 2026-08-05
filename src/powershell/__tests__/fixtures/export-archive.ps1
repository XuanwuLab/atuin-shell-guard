Compress-Archive -Path src -DestinationPath artifacts/app.zip
Expand-Archive artifacts/app.zip expanded
Export-Clixml state.xml
