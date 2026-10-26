"""
把设计稿 media/icon-source.jpg 导出成扩展图标 media/icon.png。

为什么单独有这么一步：
- 设计稿是 1254×1254 的 JPG，四角是画布白底；直接改名当图标用，在深色主题下会看到
  四个白色三角块。
- 所以这里用「圆角矩形有符号距离场」做遮罩：四角精确切掉、边缘带 1px 抗锯齿，
  且遮罩半径取实测圆角的 1.02 倍 —— 宁可切掉一丝浅蓝边缘，也绝不留白边。

依赖 Pillow + numpy（Anaconda 自带）。换 logo 时只要替换 media/icon-source.jpg 再跑一次：
    python scripts/export-icon.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'media' / 'icon-source.jpg'
OUT = ROOT / 'media' / 'icon.png'
SIZE = 256          # 128 是 VSCode 的最低要求，256 在高分屏更清晰
RADIUS_RATIO = 0.255  # 原图圆角实测约占边长 25%，取略大一点避免露白边


def main() -> None:
    image = Image.open(SRC).convert('RGB')
    rgb = np.asarray(image).astype(np.float32)
    height, width = rgb.shape[:2]

    # 1) 用「非白」定位图形本体的外接矩形
    lit = rgb.min(axis=2) <= 243
    ys, xs = np.where(lit)
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    side = min(x1 - x0 + 1, y1 - y0 + 1)

    # 2) 圆角矩形 SDF：sdf<0 在内部，边界处 1px 线性过渡即抗锯齿
    radius = side * RADIUS_RATIO
    center_x, center_y = (x0 + x1) / 2, (y0 + y1) / 2
    half_w, half_h = (x1 - x0 + 1) / 2, (y1 - y0 + 1) / 2

    grid_y, grid_x = np.mgrid[0:height, 0:width].astype(np.float32)
    qx = np.abs(grid_x - center_x) - (half_w - radius)
    qy = np.abs(grid_y - center_y) - (half_h - radius)
    sdf = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - radius
    alpha = np.clip(0.5 - sdf, 0.0, 1.0)

    # 3) 合成 alpha、裁掉遮罩外的空白、缩放到目标尺寸
    rgba = np.dstack([rgb, alpha * 255]).astype(np.uint8)
    icon = Image.fromarray(rgba, 'RGBA')
    icon = icon.crop(icon.getbbox())
    icon = icon.resize((SIZE, SIZE), Image.LANCZOS)
    icon.save(OUT, 'PNG', optimize=True)

    print(f'已生成 {OUT}（{SIZE}×{SIZE}，{OUT.stat().st_size} 字节）')


if __name__ == '__main__':
    main()
