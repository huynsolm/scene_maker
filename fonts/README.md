# 글꼴

영상 자막에 쓰는 한글 글꼴. 서버가 ffmpeg(libass)에 이 폴더를 `fontsdir` 로 넘긴다.

| 파일 | 설명 |
|---|---|
| `NotoSansKR-SemiBold.ttf` | Noto Sans KR 의 굵기 600(SemiBold) 정적 인스턴스. 디자인의 자막 굵기(600)에 맞춘 것 |
| `OFL.txt` | SIL Open Font License 1.1 전문(원본 그대로) |

## 출처와 만든 방법
- 원본: Google Fonts 저장소의 `ofl/notosanskr/NotoSansKR[wght].ttf` (가변 글꼴, 기본 굵기가 100 이라 그대로는 쓰지 않는다)
  - https://github.com/google/fonts/tree/main/ofl/notosanskr
  - 원본 SHA-256: `194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252`
- 변환: `python3 -m fontTools.varLib.instancer "NotoSansKR[wght].ttf" wght=600 --update-name-table -o NotoSansKR-SemiBold.ttf`
  (fonttools 의 instancer 로 굵기 축만 고정. 글자 모양은 수정하지 않음)
- 저작권: Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.
  글꼴 이름은 "Noto Sans KR" 계열을 그대로 쓰며 예약 이름 'Source' 를 새 이름에 쓰지 않았다.

## 라이선스 유의
OFL 1.1 은 글꼴을 다른 소프트웨어와 함께 배포·포함하는 것을 허용하지만, 글꼴 자체를 단독으로 판매할 수 없고
이 라이선스 전문을 함께 배포해야 한다. 그래서 `OFL.txt` 를 글꼴 파일과 같은 폴더에 둔다.

## 웹 미리보기용 부분집합
화면의 자막 미리보기는 영상과 같은 글꼴로 보이도록 이 글꼴의 부분집합을 쓴다.
- 파일: `web/public/fonts/NotoSansKR-SemiBold.subset.woff2` (+ 라이선스 `OFL.txt` 사본)
- 만드는 법: `python3 scripts/make-web-font.py` (fonttools, brotli 필요). 포함/제외 문자 범위는 스크립트 머리말에 있다.
- 한글 완성형 전체를 포함하며 한자·이모지는 제외한다(해당 글자는 미리보기에서 시스템 글꼴로 대체).
- 앱의 일반 UI 글꼴은 그대로 Pretendard 다. 자막(`.subtitle`)만 이 글꼴을 쓴다.
