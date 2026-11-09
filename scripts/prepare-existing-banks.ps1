param(
    [Parameter(Mandatory = $true)][string]$SourceBanks,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $SourceBanks).Path
$project = (Resolve-Path -LiteralPath $ProjectRoot).Path
$destinationRoot = Join-Path $project '.local/banks'
$metadataRoot = Join-Path $project 'metadata'
$active = Get-Content -LiteralPath (Join-Path $sourceRoot 'active.json') -Raw | ConvertFrom-Json
$specs = @(
    @{id='zj-25-erkao'; label='2025 二考'; year=2025; session='second'},
    @{id='zj-26-erkao'; label='2026 二考'; year=2026; session='second'},
    @{id='zj-27-shoukao'; label='2027 首考'; year=2027; session='first'}
)
New-Item -ItemType Directory -Path $destinationRoot,$metadataRoot -Force | Out-Null
$copied = [System.Collections.Generic.List[object]]::new()
$papers = [System.Collections.Generic.List[object]]::new()
$collections = [System.Collections.Generic.List[object]]::new()
$selectedActive = [ordered]@{}
$totalQuestions = 0
[long]$totalBytes = 0
foreach($spec in $specs) {
    $bankId = $spec.id
    $pointer = $active.$bankId
    if(-not $pointer -or $pointer.release_id -notmatch '^rel-[a-f0-9]+$') { throw "Invalid bank pointer: $bankId" }
    $relativeRelease = "$bankId/releases/$($pointer.release_id)"
    $sourceRelease = Join-Path $sourceRoot $relativeRelease
    $destinationRelease = Join-Path $destinationRoot $relativeRelease
    $sumFile = Join-Path $sourceRelease 'SHA256SUMS'
    if((Get-FileHash -LiteralPath $sumFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pointer.release_sums_sha256) {
        throw "Release checksum manifest mismatch: $bankId"
    }
    foreach($line in (Get-Content -LiteralPath $sumFile)) {
        if(-not $line.Trim()) { continue }
        if($line -notmatch '^([a-f0-9]{64})\s+\*?(.+)$') { throw "Invalid checksum row: $bankId" }
        $expected = $Matches[1]; $relative = $Matches[2]
        $file = [IO.Path]::GetFullPath((Join-Path $sourceRelease $relative))
        if(-not $file.StartsWith(([IO.Path]::GetFullPath($sourceRelease).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) { throw 'Checksum path escapes source release' }
        if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw "Source checksum mismatch: $bankId/$relative" }
    }
    $files = @(Get-ChildItem -LiteralPath $sourceRelease -File -Recurse)
    foreach($file in $files) {
        if($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source links are not supported' }
        $relative = $file.FullName.Substring($sourceRelease.Length).TrimStart('\','/')
        $destination = Join-Path $destinationRelease $relative
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if(Test-Path -LiteralPath $destination) {
            if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw "Existing local snapshot differs: $bankId/$relative" }
        } else {
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $destination
        }
        if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw "Copied file differs: $bankId/$relative" }
        $copied.Add([ordered]@{path=($relativeRelease+'/'+$relative.Replace('\','/')); sha256=$hash; bytes=$file.Length})
        $totalBytes += $file.Length
    }
    $selectedActive[$bankId] = $pointer
    $package = Get-Content -LiteralPath (Join-Path $destinationRelease 'question-package/package.json') -Raw | ConvertFrom-Json
    $questions = @(Get-Content -LiteralPath (Join-Path $destinationRelease 'question-package/questions.jsonl') | ForEach-Object {$_ | ConvertFrom-Json})
    $totalQuestions += $questions.Count
    $answers = @(Get-ChildItem -LiteralPath $destinationRelease -Recurse -Filter answers.jsonl -File | ForEach-Object {Get-Content -LiteralPath $_.FullName} | ForEach-Object {$_ | ConvertFrom-Json})
    $release = Get-Content -LiteralPath (Join-Path $destinationRelease 'release.json') -Raw | ConvertFrom-Json
    $collections.Add([ordered]@{
        collection_id=$bankId; label=$spec.label; target_year=$spec.year; target_session=$spec.session
        paper_count=@($package.documents).Count; question_count=$questions.Count
        question_image_count=$release.components.question_package.required_asset_count
        source_answer_count=@($answers | Where-Object {$_.status -eq 'source'}).Count
        explicitly_missing_answer_count=@($answers | Where-Object {$_.status -eq 'missing'}).Count
        answer_not_ingested_count=($questions.Count-$answers.Count)
    })
    foreach($doc in $package.documents) {
        $examYear = $null; $examMonth = $null; $dateBasis = 'unknown'
        if($doc.title -match '^物理卷-(\d{2})(\d{2})') {
            $examYear = 2000 + [int]$Matches[1]; $examMonth = [int]$Matches[2]
            if($examMonth -lt 1 -or $examMonth -gt 12) { throw 'Invalid month in title' }
            $dateBasis = 'source_title_yymm'
        }
        $docQuestions = @($questions | Where-Object {$_.document_id -eq $doc.document_id})
        $docAnswers = @($answers | Where-Object {$_.document_id -eq $doc.document_id})
        $papers.Add([ordered]@{
            paper_id=($bankId+'--'+$doc.document_id); collection_id=$bankId; source_document_id=$doc.document_id
            title=$doc.title; target_year=$spec.year; target_session=$spec.session
            exam_year=$examYear; exam_month=$examMonth; exam_date=$null; date_basis=$dateBasis
            exam_kind='practice'; official_session=$null; original_classification=$spec.label
            question_count=$docQuestions.Count; source_answer_count=@($docAnswers | Where-Object {$_.status -eq 'source'}).Count
            metadata_review_status='classification_preserved_date_inferred'
        })
    }
}
$catalog = [ordered]@{schema_version=1; snapshot_date='2026-11-09'; collections=$collections.ToArray(); papers=$papers.ToArray()}
if($papers.Count -ne 37 -or $totalQuestions -ne 666) { throw 'Expected initial snapshot is 37 papers / 666 questions; inspect source changes before updating baseline' }
$catalog | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $metadataRoot 'paper-catalog.json') -Encoding utf8
$selectedActive | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $destinationRoot 'active.json') -Encoding utf8
$report = [ordered]@{
    generated_at=[DateTimeOffset]::Now.ToString('o'); source_root=$sourceRoot; local_root=$destinationRoot
    method='source release manifest verified; every copied file SHA256 compared; existing mismatches stop'
    file_count=$copied.Count; total_bytes=$totalBytes; releases=$selectedActive; files=$copied.ToArray()
}
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $project '.local/import-report.json') -Encoding utf8
[ordered]@{papers=$papers.Count; questions=$totalQuestions; files=$copied.Count; bytes=$report.total_bytes; catalog='metadata/paper-catalog.json'; snapshots='.local/banks/'} | ConvertTo-Json
