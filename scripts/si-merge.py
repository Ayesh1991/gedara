"""Merge flat Sinhala translation chunks into apps/web/src/i18n/si.json (same nesting as en.json).

Usage: python scripts/si-merge.py <folder with si_*.json>
Checks every key exists in en.json and every {{placeholder}} matches; reports English keys with no
Sinhala yet (those fall back to English at runtime). Existing si.json values are kept unless a chunk
has the key.
"""
import glob
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
en_path = root / 'apps/web/src/i18n/en.json'
si_path = root / 'apps/web/src/i18n/si.json'
en = json.loads(en_path.read_text(encoding='utf-8'))


def flatten(obj, prefix=''):
    out = {}
    for k, v in obj.items():
        key = f'{prefix}.{k}' if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


flat_en = flatten(en)
flat_si = flatten(json.loads(si_path.read_text(encoding='utf-8'))) if si_path.exists() else {}
for f in sorted(glob.glob(str(Path(sys.argv[1]) / 'si_*.json'))):
    flat_si.update(json.loads(Path(f).read_text(encoding='utf-8')))

ph = re.compile(r'\{\{\s*(\w+)\s*\}\}')
errors = []
for k, v in flat_si.items():
    if k not in flat_en:
        errors.append(f'unknown key {k}')
    elif sorted(ph.findall(v)) != sorted(ph.findall(flat_en[k])):
        errors.append(f'placeholders differ in {k}: {ph.findall(flat_en[k])} vs {ph.findall(v)}')
if errors:
    print('\n'.join(errors))
    sys.exit(1)


def nest(template, prefix=''):
    out = {}
    for k, v in template.items():
        key = f'{prefix}.{k}' if prefix else k
        if isinstance(v, dict):
            child = nest(v, key)
            if child:
                out[k] = child
        elif key in flat_si:
            out[k] = flat_si[key]
    return out


si_path.write_text(json.dumps(nest(en), ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
missing = [k for k in flat_en if k not in flat_si]
print(f'si.json: {len(flat_si)} of {len(flat_en)} strings; missing: {missing[:20]}{" …" if len(missing) > 20 else ""}')
