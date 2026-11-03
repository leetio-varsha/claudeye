# Claudeye Desktop icon

- `claudeye-mark.svg` — the original mark (radial "eye-pulse", #857AF0).
- `claudeye-appicon-solid.svg` — the **current** app icon: solid purple squircle fill, white eye with a pulse, 16 short bold rays. The thin rays of the original mark blurred together at dock size, so the mark is simplified and thickened for the icon.
- `claudeye-appicon.svg` — the first version (the mark as is on a dark background), kept for reference.

Regenerate all icon sizes (+ .icns/.ico) from the composition:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --screenshot=/tmp/appicon-1024.png --window-size=1024,1024 \
  --default-background-color=00000000 --hide-scrollbars \
  "file://$(pwd)/design/claudeye-appicon-solid.svg"
npx tauri icon /tmp/appicon-1024.png
```
