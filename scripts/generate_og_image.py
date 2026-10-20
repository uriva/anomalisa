from PIL import Image, ImageDraw, ImageFilter, ImageFont

WIDTH = 1200
HEIGHT = 630
PADDING = 80

BG = (9, 9, 11)
WHITE = (255, 255, 255)
TEXT = (244, 244, 245)
SECONDARY = (161, 161, 170)
MUTED = (113, 113, 122)
BLUE = (96, 165, 250)
GREEN = (16, 185, 129)
RED = (244, 63, 94)
GRID = (47, 50, 64)

FONT_DIR = "/usr/share/fonts/truetype/dejavu"
SANS = f"{FONT_DIR}/DejaVuSans.ttf"
BOLD = f"{FONT_DIR}/DejaVuSans-Bold.ttf"
MONO = f"{FONT_DIR}/DejaVuSansMono.ttf"

HEADLINE = ["Know when something", "weird happens."]
TAGLINE = "Statistical anomaly detection for your event streams."
TAGLINE2 = "No thresholds, no dashboards. Just email."
SPARK = [
    0.52, 0.55, 0.51, 0.57, 0.54, 0.58, 0.53, 0.56, 0.52, 0.55, 0.57, 0.54,
    0.56, 0.53, 0.55, 0.52, 0.58, 0.55, 0.57, 0.54, 0.56, 0.53, 1.1, 1.36,
    0.62, 0.54, 0.52, 0.57, 0.55, 0.53, 0.56, 0.54, 0.57, 0.52, 0.55, 0.53,
]


def radial_glow():
    mask = Image.new("L", (WIDTH, HEIGHT), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((-260, -520, WIDTH + 260, 240), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(150))
    glow = Image.new("RGB", (WIDTH, HEIGHT), (59, 130, 246))
    return glow, mask.point(lambda value: int(value * 0.30))


def draw_grid(draw):
    for x in range(0, WIDTH, 24):
        for y in range(0, HEIGHT, 24):
            draw.point((x, y), fill=(22, 23, 28))


def fitted_columns(values):
    columns = max(1, len(values) - 1)
    step = (WIDTH - PADDING * 2) / columns
    return [PADDING + index * step for index in range(len(values))]


def draw_sparkline(draw, threshold, bottom):
    dash_width = 10
    gap_width = 8
    for x in range(PADDING, WIDTH - PADDING, dash_width + gap_width):
        draw.line(
            [(x, threshold), (min(x + dash_width, WIDTH - PADDING), threshold)],
            fill=GRID,
            width=2,
        )

    xs = fitted_columns(SPARK)
    points = [
        (x, bottom - value * (bottom - threshold)) for x, value in zip(xs, SPARK)
    ]
    draw.line(points, fill=BLUE, width=4, joint="curve")

    peak_index = SPARK.index(max(SPARK))
    peak = points[peak_index]
    draw.ellipse(
        (peak[0] - 11, peak[1] - 11, peak[0] + 11, peak[1] + 11),
        fill=BG,
        outline=RED,
        width=4,
    )

    font = ImageFont.truetype(MONO, 22)
    draw.text(
        (WIDTH - PADDING, threshold - 16),
        "2\u03c3",
        font=font,
        fill=MUTED,
        anchor="rs",
    )
    draw.text(
        (peak[0] + 20, peak[1] - 10),
        "+4.1\u03c3",
        font=font,
        fill=RED,
        anchor="ls",
    )


def main():
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    glow, mask = radial_glow()
    image.paste(glow, (0, 0), mask)

    draw = ImageDraw.Draw(image)
    draw_grid(draw)

    draw.ellipse((PADDING, 74, PADDING + 16, 90), fill=GREEN)
    draw.text(
        (PADDING + 30, 82),
        "anomalisa",
        font=ImageFont.truetype(BOLD, 34),
        fill=WHITE,
        anchor="lm",
    )

    headline_font = ImageFont.truetype(BOLD, 64)
    for index, line in enumerate(HEADLINE):
        draw.text(
            (PADDING, 172 + index * 78),
            line,
            font=headline_font,
            fill=TEXT,
        )

    tagline_font = ImageFont.truetype(SANS, 27)
    draw.text((PADDING, 344), TAGLINE, font=tagline_font, fill=SECONDARY)
    draw.text((PADDING, 384), TAGLINE2, font=tagline_font, fill=SECONDARY)

    draw_sparkline(draw, threshold=470, bottom=568)

    image.save("web/og.png", optimize=True)


main()
