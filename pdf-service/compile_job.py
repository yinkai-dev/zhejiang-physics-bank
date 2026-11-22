"""One isolated compiler process. No calls to the existing MCP API/state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

# 需要脱离 \mathrm/\mathbf/\mathit 渲染的大写希腊字母命令与 Unicode 字符
_UPPER_GREEK = re.compile(r'\\(?:Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)\b|[ΓΔΘΛΞΠΣΥΦΨΩ]')
_UNICODE_GREEK_TO_CMD = {
    'Γ': r'\Gamma', 'Δ': r'\Delta', 'Θ': r'\Theta', 'Λ': r'\Lambda',
    'Ξ': r'\Xi', 'Π': r'\Pi', 'Σ': r'\Sigma', 'Υ': r'\Upsilon',
    'Φ': r'\Phi', 'Ψ': r'\Psi', 'Ω': r'\Omega',
}
_CJK_RUN = re.compile(r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+')
_PRIME_SUP = re.compile(r"\^\s*\{\s*(?:'\s*){2,}\}")


def _find_matching_brace(text, open_pos):
    """查找与 open_pos 处左花括号匹配的右花括号下标。"""
    depth = 1
    i = open_pos + 1
    while i < len(text) and depth > 0:
        if text[i] == '\\' and i + 1 < len(text):
            i += 2
            continue
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
        i += 1
    return i - 1 if depth == 0 else -1


def _split_mathfont_greek(text):
    """将 \\mathrm/\\mathbf/\\mathit 中的大写希腊字母移出字体包裹，避免 OpenType 数学字体缺字。"""
    out = []
    i = 0
    while i < len(text):
        match = re.match(r'\\(mathrm|mathbf|mathit)\s*\{', text[i:])
        if match:
            cmd = match.group(1)
            open_pos = i + match.end() - 1
            close_pos = _find_matching_brace(text, open_pos)
            if close_pos > open_pos:
                inner = _split_mathfont_greek(text[open_pos + 1:close_pos])
                parts = []
                cur = 0
                depth = 0
                j = 0
                while j < len(inner):
                    if inner[j] == '\\' and j + 1 < len(inner):
                        if depth == 0:
                            gm = _UPPER_GREEK.match(inner, j)
                            if gm and not inner[gm.end():].lstrip().startswith(('_', '^')):
                                before = inner[cur:j]
                                if before:
                                    parts.append(f'\\{cmd}{{{before}}}')
                                parts.append(gm.group(0))
                                j = gm.end()
                                cur = j
                                continue
                        j += 2
                        continue
                    if depth == 0:
                        gm = _UPPER_GREEK.match(inner, j)
                        if gm and not inner[gm.end():].lstrip().startswith(('_', '^')):
                            before = inner[cur:j]
                            if before:
                                parts.append(f'\\{cmd}{{{before}}}')
                            parts.append(_UNICODE_GREEK_TO_CMD.get(gm.group(0), gm.group(0)))
                            j = gm.end()
                            cur = j
                            continue
                    if inner[j] == '{':
                        depth += 1
                    elif inner[j] == '}':
                        depth -= 1
                    j += 1
                if parts:
                    tail = inner[cur:]
                    if tail:
                        parts.append(f'\\{cmd}{{{tail}}}')
                    out.append(''.join(parts))
                else:
                    out.append(f'\\{cmd}{{{inner}}}')
                i = close_pos + 1
                continue
        out.append(text[i])
        i += 1
    return ''.join(out)


def _wrap_cjk_outside_text(text):
    """为公式中未被 \\text{...} 包裹的连续汉字与全角标点补充 \\text{...}。"""
    out = []
    i = 0
    while i < len(text):
        match = re.match(r'\\text\s*\{', text[i:])
        if match:
            open_pos = i + match.end() - 1
            close_pos = _find_matching_brace(text, open_pos)
            if close_pos > open_pos:
                out.append(text[i:close_pos + 1])
                i = close_pos + 1
                continue
        if text[i] == '\\' and i + 1 < len(text):
            out.append(text[i:i + 2])
            i += 2
            continue
        cjk = _CJK_RUN.match(text, i)
        if cjk:
            wrapped = f'\\text{{{cjk.group(0)}}}'
            if ''.join(out).rstrip().endswith(('_', '^')):
                wrapped = f'{{{wrapped}}}'
            out.append(wrapped)
            i = cjk.end()
            continue
        out.append(text[i])
        i += 1
    return ''.join(out)


def sanitize_math_for_xelatex(value):
    """规范化公式中已知会导致 XeLaTeX 缺字或语法报错的片段，保持幂等与白名单兼容。"""
    value = _PRIME_SUP.sub(lambda m: "'" * m.group(0).count("'"), value)
    value = _split_mathfont_greek(value)
    return _wrap_cjk_outside_text(value)


def _sanitize_blocks(blocks):
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        if block.get('type') == 'math':
            block['value'] = sanitize_math_for_xelatex(block['value'])
        elif block.get('type') == 'table':
            for row in block.get('rows', []):
                for cell in row:
                    _sanitize_blocks(cell)
        elif block.get('type') == 'figure' and isinstance(block.get('caption'), list):
            _sanitize_blocks(block['caption'])


def sanitize_spec_for_xelatex(spec):
    """在传入冻结版渲染器前，就地规范化 ExamSpec 中的公式块。"""
    for question in spec.get('questions', []):
        _sanitize_blocks(question.get('body'))
        for choice in question.get('choices') or []:
            if isinstance(choice, list):
                _sanitize_blocks(choice)
        answer = question.get('answer')
        if isinstance(answer, dict):
            _sanitize_blocks(answer.get('body'))
    return spec


def _patch_renderer(renderer, safety):
    """为冻结 0.1.2 渲染器补充缺字字符映射，并避免带图选项触发图片顺序错位的 sideall 布局。"""
    safety._UNICODE_MATH.setdefault('★', r'\bigstar')
    safety._UNICODE_MATH.setdefault('☆', r'\star')
    safety._UNICODE_MATH.setdefault('∑', r'\sum')
    safety._UNICODE_MATH.setdefault('•', r'\cdot')
    safety._UNICODE_MATH.setdefault('⊂', r'\subset')
    if getattr(renderer._structured_tex, '_zjpdf_patched', False):
        return
    orig_structured = renderer._structured_tex

    def _safe_structured(question, body, heading, asset_files):
        has_choice_figs = any(
            isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'figure' for b in c)
            for c in (question.get('choices') or [])
        )
        if not has_choice_figs:
            return orig_structured(question, body, heading, asset_files)
        assets = question.get('assets') or []
        base = orig_structured({**question, 'choices': []}, body, heading, asset_files)
        choices = renderer._choice_tex(question['choices'], question['id'], assets, asset_files)
        return base + choices

    _safe_structured._zjpdf_patched = True
    renderer._structured_tex = _safe_structured


def _raise_package_capacity(bank_package):
    """在不修改远端冻结 0.1.2 环境源码的前提下，为大题库集合放宽整包容量上限。"""
    bank_package.MAX_PACKAGE_BYTES = max(bank_package.MAX_PACKAGE_BYTES, 256 * 1024 * 1024)
    bank_package.MAX_FILE_BYTES = max(bank_package.MAX_FILE_BYTES, 32 * 1024 * 1024)
    bank_package.MAX_RECORDS = max(bank_package.MAX_RECORDS, 20_000)


def compile_job(directory, banks):
    # The deployment pins the installed upstream renderer, imported read-only.
    from physics_worksheet_mcp import __version__
    from physics_worksheet_mcp.bank import package as bank_package
    from physics_worksheet_mcp.bank.release import BankRegistry
    from physics_worksheet_mcp.catalog.service import Catalog
    from physics_worksheet_mcp.resolve.service import resolve_selection
    from physics_worksheet_mcp.render import renderer, safety
    from physics_worksheet_mcp.render.adapters.compiler import XeLaTeXCompiler
    import pymupdf
    if __version__ != '0.1.2':
        raise ValueError('Renderer version mismatch')
    _raise_package_capacity(bank_package)
    _patch_renderer(renderer, safety)
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
    sanitize_spec_for_xelatex(spec)
    reader = renderer.DirectoryVerifiedAssetReader(out/'source'/'verified-assets.json')
    files = []
    for kind in ['worksheet'] + (['answers'] if proof['answers']['with_source_answer'] else []):
        result = renderer.render_exam(spec, out/kind, compiler=XeLaTeXCompiler(100), asset_reader=reader, answers_only=kind=='answers')
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
