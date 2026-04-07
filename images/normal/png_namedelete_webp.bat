@echo off
chcp 65001 > nul

echo [1/3] PNG 파일을 WebP로 변환 중입니다...
magick mogrify -format webp *.png

echo [2/3] 원본 PNG 파일을 삭제 중입니다...
del /q *.png

echo [3/3] 파일 이름 정리 중 (숫자, 언더바 제거 및 소문자 변환)...
powershell -Command "Get-ChildItem -Filter *.webp | Rename-Item -NewName { ($_.BaseName -replace '\d', '' -replace '_', '').ToLower() + $_.Extension }"

echo.
echo 모든 작업이 완료되었습니다!
pause