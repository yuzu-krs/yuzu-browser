Add-Type -AssemblyName System.Drawing
:TEMP "yuzu_test_art.jpg"
 = [System.Drawing.Graphics]::FromImage(.Clear([System.Drawing.Color]::OrangeRed)
.Dispose()
, [System.Drawing.Imaging.ImageFormat]::Jpeg)
).Length
