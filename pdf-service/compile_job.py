"""One isolated compiler process. No calls to the existing MCP API/state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time


def compile_job(directory, banks):
    # The deployment pins the installed upstream renderer, imported read-only.
    from physics_worksheet_mcp import __version__
    from physics_worksheet_mcp.bank.release import BankRegistry
    from physics_worksheet_mcp.catalog.service import Catalog
    from physics_worksheet_mcp.resolve.service import resolve_selection
    from physics_worksheet_mcp.render.renderer import render_exam, DirectoryVerifiedAssetReader
    from physics_worksheet_mcp.render.adapters.compiler import XeLaTeXCompiler
    import pymupdf
    if __version__ != '0.1.2':
        raise ValueError('Renderer version mismatch')
    out = Path(directory).resolve()
    request = json.loads((out/'request.json').read_text(encoding='utf8'))
    registry = BankRegistry(Path(banks))
    catalog = Catalog(registry, list(request['releases']), request['releases'])
    rows = []
    for item in request['items']:
        row = catalog.get(item['ref'])[2]
        if row['question_sha256'] != item['fingerprint']:
            raise ValueError('Question fingerprint mismatch')
        rows.append(row)
    selection = {'questions':rows, 'bindings':catalog.bindings(), 'basis':'public_website_selection',
                 'requested_count':len(rows), 'actual_count':len(rows), 'shortfall':0,
                 'candidate_count':len(rows), 'duplicate_count':0, 'complete_scope':True}
    start = time.monotonic()
    spec, proof = resolve_selection(registry, selection, request['title'], request['answers'], out/'source')
    reader = DirectoryVerifiedAssetReader(out/'source'/'verified-assets.json')
    files = []
    for kind in ['worksheet'] + (['answers'] if proof['answers']['with_source_answer'] else []):
        result = render_exam(spec, out/kind, compiler=XeLaTeXCompiler(100), asset_reader=reader, answers_only=kind=='answers')
        if result.status != 'success':
            raise RuntimeError(result.error)
        data = Path(result.pdf_path).read_bytes()
        filename = kind+'.pdf'
        (out/filename).write_bytes(data)
        with pymupdf.open(stream=data, filetype='pdf') as pdf:
            pages = len(pdf)
        files.append({'kind':kind, 'bytes':len(data), 'pages':pages, 'sha256':hashlib.sha256(data).hexdigest()})
    (out/'result.json').write_text(json.dumps({'files':files, 'answers':proof['answers'],
        'question_count':len(rows), 'seconds':round(time.monotonic()-start, 1)}, ensure_ascii=False), encoding='utf8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', required=True)
    parser.add_argument('--banks', required=True)
    args = parser.parse_args()
    if os.name == 'posix':
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64*1024**2, 64*1024**2))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    try:
        compile_job(args.job, args.banks)
    except Exception as exc:
        # The detailed message remains inside the private job directory.
        (Path(args.job)/'failure.txt').write_text(type(exc).__name__+': '+str(exc), encoding='utf8')
        sys.exit(1)
