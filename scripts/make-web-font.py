#!/usr/bin/env python3
"""
미리보기 자막용 웹 글꼴(woff2)을 만든다. 영상 렌더에 쓰는 fonts/NotoSansKR-SemiBold.ttf 에서
화면에 필요한 글자만 남긴 부분집합이다(전체 6MB → 약 0.5MB).

  pip install fonttools brotli
  python3 scripts/make-web-font.py

포함: 한글 완성형 전체(11,172자), 호환 자모, ASCII, 라틴-1, 일반 문장부호, 화살표·도형,
      CJK 문장부호, 전각 ASCII, ㎡ ㎏ 등 단위 기호.
제외: 한자, 이모지. 이런 글자는 미리보기에서 시스템 글꼴로 대체되어 영상(전체 글꼴)과 모양이 다를 수 있다.
"""
from pathlib import Path
from fontTools import subset

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fonts" / "NotoSansKR-SemiBold.ttf"
OUT = ROOT / "web" / "public" / "fonts" / "NotoSansKR-SemiBold.subset.woff2"

RANGES = [
    (0x20, 0x7E), (0xA0, 0xFF),            # ASCII, 라틴-1
    (0x2010, 0x2027), (0x2030, 0x205E),    # 일반 문장부호(— … ‘ ’ “ ” 등)
    (0x2190, 0x21FF), (0x25A0, 0x25FF),    # 화살표, 도형
    (0x2103, 0x2103),                      # ℃
    (0x3000, 0x303F),                      # CJK 문장부호
    (0x3131, 0x318E),                      # 호환 자모
    (0xAC00, 0xD7A3),                      # 한글 완성형
    (0xFF01, 0xFF5E),                      # 전각 ASCII
    (0x338F, 0x338F), (0x3396, 0x3396), (0x33A1, 0x33A1), (0x339D, 0x339E),  # ㎏ ㎖ ㎡ ㎝ ㎞
]

unicodes = [c for lo, hi in RANGES for c in range(lo, hi + 1)]
opt = subset.Options()
opt.flavor = "woff2"
opt.layout_features = ["*"]  # 글자 폭에 영향을 주는 기능(kern, locl, ccmp 등)을 모두 유지한다
opt.name_IDs = ["*"]
opt.notdef_outline = True
font = subset.load_font(str(SRC), opt)
s = subset.Subsetter(opt)
s.populate(unicodes=unicodes)
s.subset(font)
OUT.parent.mkdir(parents=True, exist_ok=True)
subset.save_font(font, str(OUT), opt)
print(f"{OUT.relative_to(ROOT)}  {OUT.stat().st_size // 1024} KB")
