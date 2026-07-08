# Иконка Claudeye Desktop

- `claudeye-mark.svg` — исходный марк (радиальный «глаз-пульс», #857AF0).
- `claudeye-appicon-solid.svg` — **актуальная** иконка приложения: сплошная фиолетовая squircle-заливка, белый глаз с пульсом, 16 коротких жирных лучей. Тонкие лучи оригинального марка в размере дока сливались в кашу — для иконки марк упрощён и утолщён.
- `claudeye-appicon.svg` — первая версия (марк как есть на тёмной подложке), оставлена для истории.

Перегенерация иконок (все размеры + .icns/.ico) из композиции:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --screenshot=/tmp/appicon-1024.png --window-size=1024,1024 \
  --default-background-color=00000000 --hide-scrollbars \
  "file://$(pwd)/design/claudeye-appicon-solid.svg"
npx tauri icon /tmp/appicon-1024.png
```
