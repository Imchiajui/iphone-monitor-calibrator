# iPhone Monitor Calibrator · 用 iPhone 相機校正電腦螢幕

純網頁、免安裝、**不需要 Apple 開發者帳號**：電腦與 iPhone 各開一個網頁，用手機鏡頭（前或後鏡頭皆可）貼在螢幕上量測，校正螢幕的**色調曲線（Gamma）**與**灰階平衡**，輸出可直接安裝的 **ICC 描述檔（含 vcgt 顯示卡校正曲線）**。

> 手機相機不是色度計。本工具使用「**零位比較法**」：相機只需判斷兩個**同一原色**的畫面哪個比較亮，因此相機的非線性、自動曝光、自動白平衡、光譜響應（同色異譜）與環境光都會在比較中抵消。原理、誤差來源與參考文獻見 **[docs/METHOD.md](docs/METHOD.md)**。

## 能做什麼 / 不能做什麼

| | 相機能量準嗎 | |
|---|---|---|
| 各通道色調響應、有效 Gamma | ✅ | 次整數精度；模擬中誤差 < 1%（中間調約 0.1–0.2%） |
| 灰階平衡（暗部偏藍、亮部偏黃等） | ✅ | 三通道曲線一致後，各灰階色度等於白色色度 |
| 量測品質自我檢查 | ✅ | 格紋一致性（像素串擾/縮放）、暖機漂移、雜訊、交叉驗證 |
| 原色色度、絕對白點（D65） | ❌ | 需要色度計；預設保持原生白點，原色依規格選擇 |
| 絕對亮度 cd/m²、對比 | ❌ | iOS 網頁無法鎖定曝光，相機也未經光度校正 |

## 使用方式

1. 電腦開啟 `https://<你的帳號>.github.io/<repo>/display.html`（電腦端）。
2. 依「量測前準備」清單操作：**暖機 30 分鐘**、關閉 Night Shift/True Tone/HDR/動態對比、系統顯示器描述檔先設為 sRGB、瀏覽器縮放 100%。
3. 用 iPhone 相機掃描電腦上的 QR code → Safari 開啟感測器頁 → 允許相機。
4. 電腦按「開始量測」進入全螢幕，把 iPhone 鏡頭**輕貼**在圓框內中央（畫面要是一片模糊的色塊），用手擋光、不要移動。訊號穩定 3 秒後自動開始。
5. 完成後查看結果、執行**驗證量測**，下載 ICC 描述檔並依頁面說明安裝（macOS ColorSync / Windows 色彩管理）。

沒有手機也可以按「用模擬器示範」看完整流程。

## 技術架構

```
電腦 (display.html)                         iPhone (sensor.html)
 ├─ 全螢幕逐像素繪製格紋/色塊                 ├─ getUserMedia 相機（前/後）
 ├─ 零位搜尋 (js/core/nullsearch.js)  ⇄  WebRTC  ├─ 中央 ROI 平均、穩定性檢查、均勻度 CV
 ├─ 曲線模型、LUT、ΔE (js/core/*.js)   (PeerJS)   └─ 只傳送平均數字，影像不離開手機
 └─ ICC v2.4 + vcgt 產生 (js/core/icc.js)
```

* 無建置步驟、無後端：純靜態檔，直接用 GitHub Pages 托管（相機需要 HTTPS，Pages 提供）。
* 配對使用 PeerJS 公用信令伺服器（`0.peerjs.com`），資料走 WebRTC 點對點加密通道。
* 函式庫：`vendor/peerjs.min.js`（PeerJS 1.5.4, MIT）、`vendor/qrcode.js`（qrcode-generator 1.4.4, MIT）。

## 部署到 GitHub Pages

Repo → Settings → Pages → Source 選 **Deploy from a branch** → Branch `main` / `/ (root)` → Save。約一分鐘後即可在 `https://<帳號>.github.io/<repo>/` 使用。

## 開發與測試

```bash
npm test                         # 單元 + 端對端模擬（Node 20+）
node tests/e2e.cjs               # 瀏覽器端對端測試（Playwright + Chromium）
node tests/make_fixtures.mjs tests/out && python3 -I tests/validate.py tests/out   # 以 LittleCMS / colour-science 交叉驗證
python3 -m http.server 8080      # 本機預覽（手機相機需 HTTPS，請用 Pages 或自備憑證）
```

本機雙分頁測試（不需手機）：開 `display.html?transport=local&room=test` 與 `sensor.html#room=test&transport=local&virtual=1`。

## 隱私

相機影像只在 iPhone 上處理；傳到電腦的只有區域平均 RGB 數值。不收集任何資料。

## 授權

MIT
