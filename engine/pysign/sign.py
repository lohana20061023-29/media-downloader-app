"""LOHANA DX —— 抖音签名服务（TikTokDownloader 的 a_bogus + WebSign 实现）

协议：stdin 每行一个 JSON {"query": "...", "uifid": "..."}，
stdout 回一行 JSON {"ok": true, "query": "<签名后的完整 query>"}。
"""
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aBogus import ABogus
from websign import sign as web_sign
from websign import normalize_query

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'


def build(query: str, uifid: str) -> str:
    normalized = normalize_query(query)
    a_bogus = ABogus(UA).get_value(normalized)
    signed = normalized + '&a_bogus=' + urllib.parse.quote(a_bogus, safe='')
    if not uifid:
        return signed
    return web_sign(signed, uifid)[0]


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            signed = build(str(req.get('query') or ''), str(req.get('uifid') or ''))
            out = {'ok': True, 'query': signed}
        except Exception as exc:  # noqa: BLE001
            out = {'ok': False, 'error': str(exc)[:200]}
        sys.stdout.write('__SIG__' + json.dumps(out, ensure_ascii=False) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
