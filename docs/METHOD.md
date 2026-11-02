# 方法說明：如何用手機相機做出「可信」的螢幕校色

本文件說明本工具的量測原理、它**能**與**不能**保證的事、每一種誤差來源的處理方式，以及所依據的專業文獻與標準。原則是：**只宣稱量得準的東西，量不準的就明說。**

---

## 1. 問題：手機相機不是色度計

專業校色使用色度計（colorimeter）或分光輻射計（spectroradiometer），它們的感測器響應是 CIE 1931 配色函數的線性組合，所以讀數可以直接換算成 XYZ。手機相機有三個根本差異：

| 相機的特性 | 對量測的影響 |
|---|---|
| **光譜響應不符合 Luther(-Ives) 條件**（相機 RGB 不是 CIE 配色函數的線性組合） | 兩個光譜不同但人眼看起來一樣的顏色，相機可能判斷不同，反之亦然（感測器同色異譜，sensitivity metamerism）。ISO 17321-1 以 DSC/SMI 指數量化此問題。 |
| **影像處理管線（ISP）**：色調映射、色彩矩陣、銳化、降噪，網頁拿到的是處理過的 8-bit 影像 | 像素值與光量不成比例，而且曲線未知 |
| **自動曝光（AE）、自動白平衡（AWB）會一直變動** | 同一個畫面在不同時刻讀數不同。網頁版 iOS Safari 目前沒有提供手動曝光控制（`getCapabilities()` 未列出 exposure 相關參數），所以**無法鎖定** |
| 未經光度校正 | 量不到絕對亮度 cd/m² |

即使是專業色度計，量測不同種類的螢幕（不同光譜的背光/OLED）都需要針對該螢幕類型做矩陣修正，例如 NIST 的 Ohno & Hardis「四色矩陣法」；而且 Ohno 與 Brown 的後續研究指出，**用一種螢幕建立的修正矩陣套用到另一種螢幕時效果不佳**。手機相機的光譜響應離 CIE 更遠，因此**用相機直接讀出原色與白點的絕對色度是不可靠的**——本工具不這樣做。

## 2. 解法：把相機當成「零位偵測器」(null detector)

計量學中，當感測器本身不準時，常用**零位法 / 比較法**：不去讀絕對數值，而是調整一個已知的參考量，直到感測器分辨不出兩者差異。感測器只需要「單調」（越亮讀數越大），不需要線性，也不需要校正。

本工具在螢幕上交替顯示兩種畫面，讓相機比較：

* **參考（dither 格紋）**：同一原色（例如只有紅色子像素），把比例 *k/n* 的像素開到最大（255），其餘關閉（0）。若像素彼此獨立（加成性），其空間平均亮度**精確地**等於
  `Y(0) + k/n × (Y(255) − Y(0))`。
* **待測（實心色塊）**：同一原色、輸入值 *v* 的實心色塊。

搜尋 *v* 使相機讀到的兩者一樣亮，就得到「輸入值 *v* 的相對亮度 = *k/n*」。對多個 *k/n* 重複，就得到每個通道完整的色調響應曲線（TRC）。

### 為什麼這樣可以避開相機的所有缺點

1. **相機非線性**：比較的是「相等」，任何單調的 ISP 曲線都不會改變「相等」這件事。
2. **同色異譜（metamerism）**：兩個畫面都是**同一個原色**發出的光，光譜形狀相同、只有強度不同。任何光譜響應的相機，看到的都只是同一光譜的不同強度，所以相機判斷的「一樣亮」等於人眼的「一樣亮」。這是本方法最關鍵的一點——我們**從不比較不同光譜的光**。
3. **黑位與環境光**：螢幕黑位漏光、環境光在螢幕上的反射，對兩個畫面是同樣的加成量，在相等點互相抵消。
4. **自動曝光 / 白平衡**：在相等點附近兩個畫面幾乎一樣，AE/AWB 沒有東西可以反應；其餘的緩慢漂移由下一節的 D-S-D 括號法消除。

這與心理物理學中常用的「半色調（halftone）亮度匹配 gamma 校正」是同一原理（例如 To 等人 2013；Li 等人 2018 用 1/9–8/9 八種半色調做 LCD gamma 估計），只是把人眼換成相機；人眼對藍色通道的亮度判斷特別困難（US7312799 專利亦指出），相機則沒有這個問題。

## 3. 量測流程細節

### 3.1 光學平均（為什麼鏡頭要貼近螢幕）
格紋必須在**進入感測器之前**就被光學模糊平均（在線性光的領域平均）。如果相機把格紋拍清楚了，ISP 的非線性曲線會先作用在黑白像素上再平均，`平均(f(x)) ≠ f(平均(x))`，結果就錯了。鏡頭貼近螢幕（0–1 cm，遠小於最近對焦距離）時影像嚴重失焦，等於一個光學積分器。手機端會計算畫面 4×4 區塊的變異係數（CV），格紋若被解析出來會提出警告。

### 3.2 D-S-D 括號法消除漂移
每一個實心色塊讀值（S）前後各讀一次參考格紋（D），以前後平均作為參考。螢幕暖機漂移、AE 緩慢變化等**線性漂移**在一階完全抵消。D 前後讀值的差異同時被當成該點的不確定度，納入加權（非線性的 AE 暫態會自動降權）。

### 3.3 等待自動曝光穩定
每組比較開始前，先重複讀參考直到連續兩次差異 < 0.2%（最多 5 次）；手機端每次讀值也會用滑動視窗確認前後半段差異 < 0.3% 才回傳。模擬測試中，加入此步驟讓中間調誤差從約 1.5% 降到 < 0.25%。

### 3.4 搜尋與內插
先以目前已測點的冪函數估計猜測值，再用割線法找出符號相反的括號，縮到相鄰兩個整數輸入值，重複量測後以加權最小平方直線求零點，得到**次整數精度**（不受 8-bit 限制）與標準誤。

### 3.5 曲線模型
在 log–log 空間（log 相對亮度 vs log 輸入）以 Fritsch–Carlson 單調三次內插連接各點。螢幕響應在 log–log 空間接近直線（Berns 的 GOG 模型、CIE 122-1996），所以稀疏的點也能內插得很準；最暗點以下自然延伸為冪函數。量測點經過 PAV 單調迴歸，保證曲線單調。

### 3.6 量測點
| 模式 | 每通道比例點 |
|---|---|
| 快速 | 1/16, 1/8, 1/4, 1/2, 3/4 |
| 標準 | 1/32, 1/16, 1/8, 1/4, 3/8, 1/2, 5/8, 3/4, 7/8 ＋ 一致性檢查 |
| 精密 | 標準 ＋ 1/64, 3/16, 13/16，並增加重複次數 |

1/8 為單位的比例用**水平線**（以位元反轉順序分散），1/16、1/32、1/64 用 **Bayer 有序點陣**。色塊邊長取 64 裝置像素的整數倍，確保每個圖樣都是整數週期，佔空比精確。

## 4. 誤差來源與對策一覽

| 誤差來源 | 依據 | 本工具的對策 |
|---|---|---|
| **像素非獨立（加成性失效、串擾）**：相鄰像素互相影響，使格紋平均亮度不等於 *k/n* | Pelli 1997 量測 CRT 像素交互作用；Farrell 等 2008 指出 CRT 僅垂直方向可加成；Ghodrati 等 2015 發現現代 LCD 也有區域間亮度互相影響 | **一致性檢查**：在 1/2 比例用 4 種排列（水平線、垂直線、2 倍寬水平線、棋盤格）分別量測，差異 > 2% 即警告，並建議改用較粗的像素區塊。主要曲線用水平線，並用其他排列交叉檢查（文獻未定論哪種排列對所有面板最好，所以用量測來判斷） |
| **畫面被縮放重新取樣**（瀏覽器縮放、Windows 125%、macOS「縮放」解析度） | 在 gamma 編碼空間內插會把黑白格紋變成錯誤的灰 | 以裝置像素繪圖、對齊像素格線、`image-rendering: pixelated`；偵測非整數 devicePixelRatio 並警告；一致性檢查也會反映此問題 |
| **瀏覽器 / 系統色彩管理改動輸出值** | Chrome 會把 sRGB 內容轉到螢幕描述檔 | 量測前把系統描述檔設為 sRGB（轉換為恆等）或使用 `--force-color-profile=srgb`；移除舊的 vcgt |
| **暖機漂移** | SEMI D83（2023）專門規範顯示器光學特性穩定時間，且不同類型螢幕差異很大；ICDM IDMS 要求量測前暖機到工作狀態 | 建議暖機 ≥ 30 分鐘；**首尾重測同一點**計算漂移，> 1% 警告；D-S-D 括號法消除量測中的線性漂移 |
| **視角相依**（LCD 尤其 VA/TN） | Roca-Vila 等 2014：不同視角下以半色調估得的 gamma 有顯著差異；ISO 12646 也規範視角特性 | 鏡頭垂直貼在螢幕中央量測；參考與待測在同一位置、同一角度 |
| **螢幕不均勻** | ISO 12646 對亮度/色度均勻性的要求 | 參考與待測在**同一位置**比較，均勻性誤差自動抵消；結果代表螢幕中央 |
| **動態功能**：動態對比、區域調光（Local Dimming）、OLED 自動亮度限制（ABL） | 亮度隨畫面內容改變 | 清單要求關閉；參考與待測的平均亮度相同（相等點附近），面積固定、背景固定，使 ABL/APL 狀態一致 |
| **PWM 調光、房間燈光閃爍** | 卷簾快門造成條紋、幀間變化 | 多幀平均、ROI 空間平均、穩定性檢查；建議擋光 |
| **時間抖動 FRC（6-bit+FRC 面板）** | 面板以時間抖動模擬 8-bit | 每次讀值平均多幀，時間積分 |
| **環境光、手機螢幕反光** | 在比較中為加成常數 | 理論上抵消；仍建議暗室與遮光以降低雜訊。使用前鏡頭時手機畫面自動變黑 |
| **相機 AE / AWB** | iOS Safari 無法鎖定 | 零位法 + 穩定等待 + D-S-D 括號 + 漂移加權 |
| **相機無法量原色/白點絕對色度** | Luther 條件、ISO 17321、Ohno & Hardis 1997 | **不量**。原色由使用者依規格選擇（或輸入原廠報告/評測的 xy）；白點預設保持原生 |
| **8-bit LUT 量化** | 顯示卡 LUT 輸出位元深度有限 | ΔE 預估以 8-bit 量化計算（保守）；許多 GPU 會自動抖動 |

## 5. 校正與描述檔

* **校正（vcgt）**：對每個通道建立 1D LUT：`LUT_c(x) = f_c⁻¹(T(x) · s_c)`，*T* 為目標曲線（Gamma 2.2、sRGB、BT.1886、2.4、1.8），*s_c* 為白點縮放（原生白點時皆為 1）。三個通道都遵循同一條扣除黑位的相對亮度曲線後，所有灰階的色度都等於白色的色度——這就是**灰階平衡（gray tracking）**。
* **描述檔（ICC v2.4，matrix/TRC）**：`rXYZ/gXYZ/bXYZ` 來自所選原色，以 Bradford 轉換適應到 D50 PCS（並寫入 `chad`）；`wtpt` 為顯示器白點；`rTRC/gTRC/bTRC` 為校正後的目標曲線（含 vcgt 版）或量測曲線（僅描述檔版）；Apple `vcgt` 標籤由 macOS ColorSync 與 Windows「使用 Windows 顯示器校正」載入顯示卡。
* **BT.1886**：以輸入的對比值計算，換算為扣除黑位的相對亮度。

## 6. 驗證（交叉驗證）

量測完成後可執行**獨立驗證**：使用**沒有參與擬合**的比例（3/16、7/16、11/16、14/16）與**不同的排列**（Bayer）重新量測，比較模型預測值，報告亮度誤差與灰階 ΔE2000 估計（Sharma, Wu & Dalal 2005 的實作，已以其測試資料與 colour-science 驗證）。這對應專業流程中「校正後以獨立量測驗證」的步驟。

## 7. 程式本身如何被驗證

* `tests/core.test.mjs`：sRGB 矩陣（IEC 61966-2-1）、Bradford 適應後的 sRGB 原色（對照 ICC sRGB 描述檔）、CIEDE2000（Sharma 等 2005 測試資料）、格紋佔空比、曲線模型。
* **端對端模擬**：虛擬螢幕（GOG 模型、各通道 gamma 不同、漂移）＋**刻意不友善的虛擬相機**（未知非線性 ISP、會一直調整的自動曝光、非比色光譜響應、環境光、雜訊、8-bit 量化）。中間調與亮部曲線誤差 < 1%（實測約 0.1–0.2%），暗部 < 3%。
* `tests/validate.py`：以 LittleCMS（Pillow ImageCms）開啟產生的 ICC 檔並做往返轉換；以 colour-science 比對原色矩陣（誤差 < 2×10⁻⁴）與 500 組隨機 CIEDE2000。
* `tests/e2e.cjs`：Playwright 瀏覽器測試，電腦頁與虛擬手機頁透過實際通訊協定完成整個流程。

模擬能驗證演算法，但**不能**取代真實硬體驗證。若你有色度計，非常歡迎用它檢查本工具的結果並回報。

## 8. 限制（請務必了解）

1. **絕對白點與原色色度量不到**。若你需要 D65 ±0.003 xy、或需要把廣色域螢幕模擬成 sRGB 的精準色彩，請使用色度計（i1Display、Calibrite、Spyder 等）搭配 DisplayCAL/ArgyllCMS。
2. **絕對亮度與對比量不到**。目標亮度（例如 120 cd/m²）需要光度計。
3. 結果代表**螢幕中央**、**正面視角**。
4. 一致性檢查失敗（像素串擾嚴重）的螢幕，比例格紋不再精確代表 *k/n*，結果會有系統誤差。
5. ΔE 數值是根據「所選原色」的**估計**，主要反映灰階平衡與色調曲線的改善，不是絕對色準證書。

## 參考文獻與標準

1. Berns, R. S. (1996). Methods for characterizing CRT displays. *Displays*, 16(4), 173–182.（兩階段模型、GOG 模型）
2. CIE 122-1996. *The relationship between digital and colorimetric data for computer-controlled CRT displays.*
3. Brainard, D. H., Pelli, D. G., & Robson, T. (2002). Display characterization. In *Encyclopedia of Imaging Science and Technology*. Wiley.（加成性、通道獨立性檢查）
4. Pelli, D. G. (1997). Pixel independence: Measuring spatial interactions on a CRT display. *Spatial Vision*, 10, 443–446.
5. Farrell, J., Ng, G., Ding, X., Larson, K., & Wandell, B. (2008). A display simulation toolbox for image quality evaluation. *Journal of Display Technology*, 4(2).（CRT/LCD 空間加成性）
6. Ghodrati, M., Morris, A. P., & Price, N. S. C. (2015). The (un)suitability of modern liquid crystal displays (LCDs) for vision research. *Frontiers in Psychology*, 6, 303.
7. Roca-Vila, J., Karatzas, D., & Wuerger, S. (2014). *Displays*（研究視角對半色調亮度匹配 gamma 估計的影響）.
8. To, L., Woods, R. L., Goldstein, R. B., & Peli, E. (2013). Psychophysical contrast calibration. *Vision Research*, 90, 15–24.
9. Li 等 (2018). An improved method for LCD displays colorimetric characterization. *Proc. SPIE* 10611.（1/9–8/9 半色調匹配）
10. US Patent 7,312,799 B2. Visual determination of gamma for softcopy display.（半色調匹配與灰階平衡；藍色通道亮度判斷困難）
11. Ohno, Y., & Hardis, J. E. (1997). Four-color matrix method for correction of tristimulus colorimeters. *Proc. IS&T 5th Color Imaging Conference*, 301–305；以及 Ohno & Brown (1998) Part 2（修正矩陣不可跨螢幕類型）。
12. ISO 17321-1:2012. Graphic technology and photography — Colour characterisation of digital still cameras (DSCs) — Part 1.（Luther 條件、感測器同色異譜指數）
13. ISO 12646:2015. Graphic technology — Displays for colour proofing — Characteristics.（均勻性、視角、設定）
14. ICDM. *Information Display Measurements Standard (IDMS)* v1.1. Society for Information Display.
15. SEMI D83 (2023). 顯示器光學特性穩定時間（暖機時間）量測方法.
16. Sharma, G., Wu, W., & Dalal, E. N. (2005). The CIEDE2000 color-difference formula: Implementation notes, supplementary test data, and mathematical observations. *Color Research & Application*, 30(1), 21–30.
17. IEC 61966-2-1:1999. sRGB；ITU-R BT.1886 (2011). Reference EOTF for flat panel displays.
18. ICC.1:2001-04 (v2.4) 與 ICC.1:2022 (v4.4) profile 規格；Apple ColorSync `vcgt` 標籤。
19. Fritsch, F. N., & Carlson, R. E. (1980). Monotone piecewise cubic interpolation. *SIAM J. Numer. Anal.*, 17(2), 238–246.
20. Elze, T., & Tanner, T. G. (2012). Temporal properties of liquid crystal displays: Implications for vision science experiments. *PLoS ONE*, 7(9), e44048.（LCD 響應時間、過驅動）
