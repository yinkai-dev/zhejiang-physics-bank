"""Server-side half of the PDF service deployment, executed over SSH by scripts/publish.mjs.

Scope is deliberately narrow. It only ever writes: a NEW release directory under
<banks_root>/<bank>/releases/, the PDF service's own release directories and `current` symlink,
and its own staging directory; and it restarts the PDF service unit. It never edits active.json,
the MCP service, its state, or any other unit.

Input: the first stdin line is one JSON object with an `action` key. For `install` and `deploy`
the raw bytes of the chunks named in `stream` follow on the same stdin, so a whole deployment
needs only one connection per action. Chunks are kept in the staging directory as they arrive;
an interrupted upload resumes with the chunks that are still missing.
Output is a single line `RESULT <json>`; the exit status is non-zero on failure.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request

BUNDLE_FILES = frozenset({
    'pdf-service/app.py', 'pdf-service/contract.py', 'pdf-service/compile_job.py',
    'pdf-service/test_service.py', 'pdf-service/requirements.txt', 'pdf-service/README.md',
    'pdf-service/zjpdf.service', 'pdf-service/deploy_remote.py',
    'public/data/catalog.json', 'public/data/questions-index.json',
})
NAME = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$')
HEX16 = re.compile(r'^[a-f0-9]{16}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')


class Failure(Exception):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def need(condition, message):
    if not condition:
        raise Failure(message)


def safe_relative(value):
    need(isinstance(value, str) and value and '\\' not in value and ':' not in value
         and not value.startswith('/') and '..' not in value.split('/'), 'unsafe path: %r' % (value,))
    return value


def parse_sums(path):
    rows = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        m = re.fullmatch(r'([a-f0-9]{64})  (.+)', line)
        if m:
            rows[m[2]] = m[1]
    return rows


def release_dir(cfg, bank, release):
    need(NAME.match(bank) and NAME.match(release), 'invalid bank/release id')
    return Path(cfg['banks_root']) / bank / 'releases' / release


def release_present(cfg, bank, release, sums_sha):
    sums = release_dir(cfg, bank, release) / 'SHA256SUMS'
    return sums.is_file() and sha(sums.read_bytes()) == sums_sha


def existing_index(cfg, bank, skip=None):
    """sha256 -> file path, from the checksum manifests of releases already installed for this bank."""
    index = {}
    parent = Path(cfg['banks_root']) / bank / 'releases'
    if not parent.is_dir():
        return index
    for directory in sorted(parent.iterdir()):
        if directory.name.startswith('.') or directory.name == skip or not (directory / 'SHA256SUMS').is_file():
            continue
        for relative, digest in parse_sums(directory / 'SHA256SUMS').items():
            index.setdefault(digest, directory / relative)
    return index


def staging_dir(cfg, blob_id):
    need(HEX16.match(blob_id or ''), 'invalid staging id')
    return Path(cfg['staging']) / blob_id


def receive_stream(cfg, blob_id, stream):
    """Store the chunks that follow the argument line on stdin, verifying each as it completes."""
    directory = staging_dir(cfg, blob_id)
    if stream:
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
    for name, digest, size in stream:
        need(re.fullmatch(r'chunk-[0-9]{4}', name), 'invalid chunk name')
        chunk = bytearray()
        while len(chunk) < size:
            piece = sys.stdin.buffer.read(min(1 << 20, size - len(chunk)))
            need(piece, 'upload interrupted in ' + name)
            chunk.extend(piece)
        need(sha(bytes(chunk)) == digest, 'uploaded chunk corrupt: ' + name)
        temporary = directory / (name + '.part')
        temporary.write_bytes(chunk)
        os.replace(temporary, directory / name)
    return len(stream)


def drop_staging(cfg, blob_id):
    directory = staging_dir(cfg, blob_id)
    if directory.is_dir() and directory.parent == Path(cfg['staging']):
        shutil.rmtree(directory, ignore_errors=True)


def read_blob(cfg, blob):
    """Reassemble uploaded chunks, verifying every chunk and every contained file."""
    directory = staging_dir(cfg, blob['id'])
    data = bytearray()
    for name, digest, size in blob['chunks']:
        need(re.fullmatch(r'chunk-[0-9]{4}', name), 'invalid chunk name')
        chunk = (directory / name).read_bytes()
        need(len(chunk) == size and sha(chunk) == digest, 'chunk mismatch: ' + name)
        data.extend(chunk)
    need(sha(bytes(data))[:16] == blob['id'], 'blob id mismatch')
    files, offset = {}, 0
    for relative, digest, size in blob['entries']:
        content = bytes(data[offset:offset + size])
        offset += size
        need(len(content) == size and sha(content) == digest, 'blob entry mismatch: ' + relative)
        files[safe_relative(relative)] = content
    need(offset == len(data), 'blob has trailing bytes')
    return files


def http_json(url, timeout=3):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def service_state(cfg):
    current = Path(cfg['service_root']) / 'current'
    state = {'current': os.path.basename(os.readlink(current)) if current.is_symlink() else None}
    try:
        state['health'] = http_json(cfg['health'])
    except Exception as exc:
        state['health'] = None
        state['health_error'] = type(exc).__name__
    return state


def action_status(cfg, args):
    result = service_state(cfg)
    releases = Path(cfg['service_root']) / 'releases'
    result['bundles'] = sorted(p.name for p in releases.iterdir()) if releases.is_dir() else []
    active = Path(cfg['banks_root']) / 'active.json'
    pointers = json.loads(active.read_text(encoding='utf-8-sig')) if active.is_file() else {}
    result['banks'] = {}
    for bank in args.get('banks', []):
        need(NAME.match(bank), 'invalid bank id')
        parent = Path(cfg['banks_root']) / bank / 'releases'
        result['banks'][bank] = {'mcp_active_release': pointers.get(bank, {}).get('release_id'),
                                 'installed': sorted(p.name for p in parent.iterdir() if not p.name.startswith('.')) if parent.is_dir() else []}
    if cfg.get('mcp_ready'):
        try:
            result['mcp_ready'] = http_json(cfg['mcp_ready'], 10)
        except Exception as exc:
            result['mcp_ready'] = {'error': type(exc).__name__}
    return result


def action_probe(cfg, args):
    """Read-only: which releases are installed, and which file contents the server still lacks."""
    result = {'releases': {}, 'service': service_state(cfg), 'chunks': {}}
    for bank, wanted in args['releases'].items():
        present = release_present(cfg, bank, wanted['release_id'], wanted['release_sums_sha256'])
        missing = []
        if not present:
            have = existing_index(cfg, bank, skip=wanted['release_id'])
            missing = [relative for relative, digest, _ in wanted['files'] if digest not in have]
        result['releases'][bank] = {'present': present, 'missing': missing,
                                    'target_exists': release_dir(cfg, bank, wanted['release_id']).exists()}
    # Chunks left by an interrupted upload, so the next attempt only sends what is still missing.
    staging = Path(cfg['staging'])
    for directory in (sorted(staging.iterdir()) if staging.is_dir() else []):
        if directory.is_dir() and HEX16.match(directory.name):
            result['chunks'][directory.name] = {p.name: sha(p.read_bytes()) for p in directory.iterdir() if re.fullmatch(r'chunk-[0-9]{4}', p.name)}
    return result


def action_install(cfg, args):
    """Install one bank release next to the existing ones. The MCP pointer file is not touched."""
    from physics_worksheet_mcp import __version__
    from physics_worksheet_mcp.bank.release import verify_release
    need(__version__ == cfg.get('engine_version', '0.1.2'), 'renderer version mismatch: ' + __version__)
    bank, release, sums_sha = args['bank'], args['release_id'], args['release_sums_sha256']
    need(HEX64.match(sums_sha), 'invalid checksum')
    target = release_dir(cfg, bank, release)
    received = receive_stream(cfg, args['blob']['id'], args.get('stream', []))
    if target.exists():
        need(release_present(cfg, bank, release, sums_sha), 'existing release directory differs: %s' % target)
        verified = verify_release(target)
        drop_staging(cfg, args['blob']['id'])
        return {'installed': False, 'already_present': True, 'questions': len(verified.store.questions)}
    need(Path(cfg['banks_root']).is_dir(), 'bank root is not installed')
    blob = read_blob(cfg, args['blob'])
    have = existing_index(cfg, bank, skip=release)
    work = target.parent / ('.incoming-%s-%d' % (release, os.getpid()))
    staged = work / release
    counts = {'from_upload': 0, 'from_existing': 0}
    try:
        staged.mkdir(parents=True)
        declared = set()
        for relative, digest, size in args['files']:
            relative = safe_relative(relative)
            declared.add(relative)
            if relative in blob:
                content = blob[relative]
                counts['from_upload'] += 1
            else:
                need(digest in have, 'content neither uploaded nor installed: ' + relative)
                content = have[digest].read_bytes()
                counts['from_existing'] += 1
            need(len(content) == size and sha(content) == digest, 'content mismatch: ' + relative)
            destination = staged / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        need(sha((staged / 'SHA256SUMS').read_bytes()) == sums_sha, 'checksum manifest mismatch')
        need(set(parse_sums(staged / 'SHA256SUMS')) | {'SHA256SUMS'} == declared, 'file list differs from manifest')
        verified = verify_release(staged)  # full tree, package, tags, answers and counts
        need(verified.sums_sha256 == sums_sha and verified.manifest['bank_id'] == bank, 'release identity mismatch')
        if os.name == 'posix':
            owner = target.parent.stat()
            for path in [staged, *staged.rglob('*')]:
                os.chmod(path, 0o755 if path.is_dir() else 0o644)
                os.chown(path, owner.st_uid, owner.st_gid)
        os.rename(staged, target)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    drop_staging(cfg, args['blob']['id'])
    return {'installed': True, 'questions': len(verified.store.questions), 'documents': len(verified.store.documents),
            'chunks_received': received, **counts}


def switch_current(cfg, directory):
    current = Path(cfg['service_root']) / 'current'
    need(not current.exists() or current.is_symlink(), 'current is not a symlink')
    temporary = current.with_name('current.new')
    if temporary.is_symlink():
        temporary.unlink()
    temporary.symlink_to(directory)
    os.replace(temporary, current)


def restart_and_wait(cfg, expected_version, attempts=60):
    subprocess.check_call(['systemctl', 'restart', cfg['service']])
    health = None
    for _ in range(attempts):
        try:
            health = http_json(cfg['health'], 2)
            if health.get('public_version') == expected_version:
                return health
        except Exception:
            pass
        time.sleep(0.5)
    raise Failure('health check failed: %s' % (json.dumps(health),))


def journal_tail(cfg):
    done = subprocess.run(['journalctl', '-u', cfg['service'], '-n', '30', '--no-pager'], capture_output=True, text=True)
    return done.stdout[-4000:]


def action_deploy(cfg, args):
    """Install a code+catalog bundle, switch the service to it, and roll back if it is unhealthy."""
    bundle, expected = args['bundle_id'], args['expected_public_version']
    need(HEX16.match(bundle) and HEX64.match(expected), 'invalid bundle id/version')
    before = service_state(cfg)
    receive_stream(cfg, args['blob']['id'], args.get('stream', []))
    files = read_blob(cfg, args['blob'])
    need(set(files) <= BUNDLE_FILES and {'pdf-service/app.py', 'public/data/catalog.json', 'public/data/questions-index.json'} <= set(files), 'bundle layout invalid')
    catalog = json.loads(files['public/data/catalog.json'].decode('utf-8'))
    need(catalog['version'] == expected, 'bundle catalog version differs from the expected version')
    for bank, pointer in catalog['source_releases'].items():
        need(release_present(cfg, bank, pointer['release_id'], pointer['release_sums_sha256']),
             'bank release is not installed: %s/%s' % (bank, pointer['release_id']))
    releases = Path(cfg['service_root']) / 'releases'
    directory = releases / bundle
    if directory.exists():
        for relative, content in files.items():
            need((directory / relative).is_file() and (directory / relative).read_bytes() == content, 'existing bundle directory differs: ' + relative)
    else:
        work = releases / ('.incoming-%s-%d' % (bundle, os.getpid()))
        try:
            for relative, content in files.items():
                (work / relative).parent.mkdir(parents=True, exist_ok=True)
                (work / relative).write_bytes(content)
            for path in [work, *work.rglob('*')]:
                os.chown(path, 0, 0)
                os.chmod(path, 0o755 if path.is_dir() else 0o644)
            os.rename(work, directory)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    # The new bundle must import and load its catalog before the running service is touched.
    check = subprocess.run([sys.executable, '-I', '-c',
                            'import sys;sys.path.insert(0,sys.argv[1]);from contract import PublicCatalog;'
                            'c=PublicCatalog(sys.argv[2]);print(c.catalog["version"],len(c.questions))',
                            str(directory / 'pdf-service'), str(directory / 'public' / 'data')], capture_output=True, text=True)
    need(check.returncode == 0 and check.stdout.split()[:1] == [expected], 'bundle preflight failed: ' + (check.stderr or check.stdout)[-800:])
    unit = Path('/etc/systemd/system') / (cfg['service'] + '.service')
    result = {'bundle': bundle, 'previous': before['current'], 'questions': int(check.stdout.split()[1]),
              'unit_in_sync': unit.is_file() and unit.read_bytes() == files.get('pdf-service/zjpdf.service')}
    if before['current'] == bundle and (before['health'] or {}).get('public_version') == expected:
        drop_staging(cfg, args['blob']['id'])
        return {**result, 'switched': False, 'health': before['health']}
    switch_current(cfg, directory)
    try:
        result['health'] = restart_and_wait(cfg, expected)
    except Exception as exc:
        result.update({'switched': False, 'rolled_back': False, 'error': str(exc), 'journal': journal_tail(cfg)})
        if before['current']:
            switch_current(cfg, releases / before['current'])
            subprocess.check_call(['systemctl', 'restart', cfg['service']])
            time.sleep(2)
            result['rolled_back'] = True
            result['after_rollback'] = service_state(cfg)
        raise Failure(json.dumps(result))
    result['switched'] = True
    drop_staging(cfg, args['blob']['id'])
    if cfg.get('mcp_ready'):
        try:
            result['mcp_ready'] = http_json(cfg['mcp_ready'], 10)
        except Exception as exc:
            result['mcp_ready'] = {'error': type(exc).__name__}
    return result


def action_rollback(cfg, args):
    bundle = args['bundle_id']
    need(NAME.match(bundle), 'invalid bundle id')
    directory = Path(cfg['service_root']) / 'releases' / bundle
    need((directory / 'public' / 'data' / 'catalog.json').is_file(), 'bundle is not installed: ' + bundle)
    version = json.loads((directory / 'public' / 'data' / 'catalog.json').read_text(encoding='utf-8'))['version']
    before = service_state(cfg)
    switch_current(cfg, directory)
    return {'bundle': bundle, 'previous': before['current'], 'health': restart_and_wait(cfg, version)}


def action_cleanup(cfg, args):
    removed = []
    for blob_id in args['staging_ids']:
        directory = staging_dir(cfg, blob_id)
        if directory.is_dir() and directory.parent == Path(cfg['staging']):
            shutil.rmtree(directory)
            removed.append(blob_id)
    return {'removed': removed}


ACTIONS = {'status': action_status, 'probe': action_probe, 'install': action_install,
           'deploy': action_deploy, 'rollback': action_rollback, 'cleanup': action_cleanup}


def main(args):
    try:
        cfg = args['remote']
        for key in ('banks_root', 'service_root', 'staging'):
            need(os.path.isabs(cfg[key]), 'configuration path must be absolute: ' + key)
        # Earlier copies of this helper are superseded; keep the staging directory tidy.
        for stale in Path(cfg['staging']).glob('deploy_remote-*.py'):
            if stale.resolve() != Path(__file__).resolve():
                stale.unlink()
        result = {'ok': True, **ACTIONS[args['action']](cfg, args)}
        status = 0
    except Failure as exc:
        result, status = {'ok': False, 'error': str(exc)}, 1
    except Exception as exc:
        result, status = {'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)}, 1
    sys.stdout.write('RESULT ' + json.dumps(result) + '\n')
    return status


if __name__ == '__main__':
    sys.exit(main(json.loads(sys.stdin.buffer.readline().decode('utf-8'))))
