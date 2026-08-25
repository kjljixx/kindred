from io import BytesIO

from PIL import Image


def vertical_border_thicknesses(
  driver,
  cell,
  expected_side: str | None = None,
) -> tuple[int, int]:
  image = Image.open(BytesIO(cell.screenshot_as_png)).convert("RGB")
  center_y = image.height // 2
  left_color = image.getpixel((0, center_y))
  right_color = image.getpixel((image.width - 1, center_y))
  expected_color = tuple(
    driver.execute_script(
      """
      const token = (arguments[1] === 'theirs' ||
        (!arguments[1] && arguments[0].classList.contains('kindred-table-side-theirs')))
        ? '--blue-text'
        : '--orange-text';
      const color = getComputedStyle(arguments[0]).getPropertyValue(token);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
      """,
      cell,
      expected_side,
    )
  )
  assert left_color == right_color == expected_color, {
    "left": left_color,
    "right": right_color,
    "expected": expected_color,
  }
  left = next(
    x for x in range(image.width) if image.getpixel((x, center_y)) != left_color
  )
  right = next(
    x for x in range(image.width)
    if image.getpixel((image.width - 1 - x, center_y)) != right_color
  )
  return left, right
