# -*- coding: utf-8 -*-
"""스냅샷 배포본을 zip 으로 묶는다 (Netlify Drop / Cloudflare Pages 업로드용).

PowerShell Compress-Archive 는 경로 구분자를 백슬래시로 넣어 호스팅 쪽에서
경로가 깨진다 (AWS EC2 에서 같은 문제로 부팅 스크립트가 죽은 실증 있음).
Python zipfile 은 항상 슬래시·UTF-8 이라 안전하다.
"""
import os
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, "dist-snapshot")
DEST = os.path.join(os.path.dirname(BASE), "대시보드_스냅샷_배포본.zip")


def main() -> None:
    if not os.path.isdir(SRC):
        raise SystemExit("dist-snapshot 이 없습니다 - 스냅샷_배포본_만들기.bat 을 먼저 실행하세요")
    n = 0
    with zipfile.ZipFile(DEST, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(SRC):
            for f in files:
                full = os.path.join(root, f)
                # zip 루트에 index.html 이 바로 오게 한다 (호스팅이 그걸 첫 화면으로 잡는다)
                rel = os.path.relpath(full, SRC).replace(os.sep, "/")
                z.write(full, rel)
                n += 1
    with zipfile.ZipFile(DEST) as z:
        names = z.namelist()
    assert "index.html" in names, "index.html 이 zip 루트에 없습니다"
    assert not any("\\" in x for x in names), "백슬래시 경로 발견 - 업로드 금지"
    print(f"생성 완료: {DEST}")
    print(f"파일 {n}개 / {os.path.getsize(DEST):,} bytes")
    print("검증 통과: index.html 루트 위치 / 구분자 슬래시")


if __name__ == "__main__":
    main()
