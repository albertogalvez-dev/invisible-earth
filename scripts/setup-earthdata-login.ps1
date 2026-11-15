# Stores your NASA Earthdata Login in %USERPROFILE%\_netrc, the file earthaccess reads.
# It asks for the password in the terminal (hidden) and writes it only to that file, readable by your Windows user.
# Run it yourself; nothing is sent anywhere. Delete the file whenever you like: Remove-Item $env:USERPROFILE\_netrc
param([Parameter(Mandatory = $true)][string]$User) # your Earthdata username

$path = Join-Path $env:USERPROFILE '_netrc'
if (Test-Path -LiteralPath $path) {
    throw 'An existing _netrc was found. Add the Earthdata entry manually to preserve your other credentials.'
}
$secure = Read-Host -Prompt "Earthdata password for '$User'" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $plain) { Write-Host 'Empty password, nothing written.'; exit 1 }

[IO.File]::WriteAllText($path, "machine urs.earthdata.nasa.gov login $User password $plain`n", (New-Object Text.UTF8Encoding($false)))
icacls $path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
$plain = $null
Write-Host "Credentials saved to $path. You can now run the data extraction."
