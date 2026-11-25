# Use a new NTFS directory for synthetic checks. Do not change the runner's ACLs.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE ('pulse-tests-' + [Guid]::NewGuid().ToString('N'))
$oldTemp, $oldTmp = $env:TEMP, $env:TMP
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    [IO.Directory]::SetAccessControl($root, $acl)
    $env:TEMP = $root
    $env:TMP = $root
    bun run check
    $result = $LASTEXITCODE
} finally {
    $env:TEMP, $env:TMP = $oldTemp, $oldTmp
    Remove-Item -LiteralPath $root -Recurse -Force
}
exit $result
