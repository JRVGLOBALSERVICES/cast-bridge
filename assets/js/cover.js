/* Cast Bridge — the cover for a film that has none.
 *
 * Some pages carry no picture at all. Not a poor one, not a hotlinked one
 * that 403s: none. `/api/scan` finds no og:image and no <video poster>, the
 * stream is cross-origin so no frame of it is ours to read, and the shade
 * falls back to the grey app mark — which says "Cast Bridge" over a film
 * whose name is written on the line directly above it.
 *
 * So this file makes one. It is not decoration: a card that carries the
 * title is the difference between four identical grey squares in a
 * notification history and four films you can tell apart at a glance.
 *
 * Two rules govern everything below.
 *
 *   The card is DERIVED, not random. Its hue is a hash of the title, so a
 *   film looks the same every time you open it, on the phone and on the
 *   television, today and next week. A cover that changed between the
 *   shade and the lock screen would read as two different films.
 *
 *   The card is DRAWN TWICE, from here. The phone needs pixels — a canvas,
 *   because MediaSession takes an address and a data: URL is the only one
 *   this page can produce without a round trip. The Chromecast needs a URL
 *   on our origin, because it fetches artwork itself, from its own network
 *   (see api/cover.js). Those are different outputs of the same layout, and
 *   the layout lives here precisely so they cannot drift apart.
 *
 * The measurements are deliberate and are proven in scripts/test-cover.js:
 *
 *   - Everything that must be READ sits inside a centred square. Android
 *     crops this artwork to a square thumbnail in the shade, so a title set
 *     against the left edge of a 16:9 card is a title with its first two
 *     words cut off. The gradient runs the full frame; the words do not.
 *   - White on the background is at least 7:1 at EVERY hue, and the orange
 *     mark at least 3:1, both measured against the gradient at the exact
 *     point the ink lands rather than against an average. That is what makes
 *     a hue derived from an arbitrary title safe to use at all.
 *   - Line breaking is estimated here, not measured by the browser, because
 *     an SVG cannot measure text and a card that wrapped differently in the
 *     two outputs would not be the same card. The estimate is checked
 *     against real Chrome in the test rather than trusted.
 */
(function (root) {
  'use strict';

  /* The JRV mark, as a single path normalised into a 1000-wide box. Taken
     from the canonical vector, not re-traced: the transforms the original
     carries (a tenth-scale, y-flipped group inside an offset viewBox) are
     baked in here once so that placing it is arithmetic in both outputs. */
  var LOGO = 'M48 32.85 c-4.55 1.17 -9.16 4.55 -10.95 7.99 l-1.93 3.58 l0 44.83 l0 44.83 l2 3.65 c1.72 3.17 2.69 3.99 6.61 5.99 l4.55 2.27 l48 0 c26.38 0 48.35 0.28 48.76 0.55 c0.55 0.34 0.76 15.36 0.62 52.55 l-0.07 52.07 l-1.52 1.93 c-3.44 4.41 0.21 4.13 -55.44 4.48 l-50.9 0.34 l-2.34 2.55 l-2.34 2.62 l0 50.55 c0 29.82 0.28 51.31 0.62 52.27 c1.31 3.44 1.93 3.51 55.85 2.89 c27.48 -0.28 51.65 -0.62 53.72 -0.62 c4.89 -0.14 6.4 -1.24 19.35 -14.53 c21.76 -22.25 90.15 -90.5 91.32 -91.18 c0.76 -0.34 2.13 -2.34 3.17 -4.34 l1.86 -3.72 l-0.28 -102.96 c-0.28 -102.75 -0.28 -102.89 -1.72 -107.51 c-1.58 -5.03 -3.31 -6.89 -8.82 -9.57 l-3.31 -1.65 l-97.8 -0.07 c-53.79 -0.07 -98.35 0 -99.04 0.21 ZM691.46 41.32 c-34.37 0.34 -39.33 0.48 -42.36 1.58 c-5.3 1.79 -7.64 3.51 -10.47 7.78 l-2.62 3.93 l-0.21 30.03 c-0.07 16.53 0.34 57.3 0.9 90.63 c0.62 33.33 1.38 87.88 1.72 121.28 l0.55 60.67 l1.72 3.44 c2.62 5.1 4.82 7.37 9.16 9.5 l3.86 1.86 l84.78 -0.41 c67.08 -0.34 85.81 -0.62 89.33 -1.31 c8.47 -1.79 14.33 -5.99 17.29 -12.47 c1.79 -3.93 2 -92.56 0.28 -97.59 c-0.62 -1.58 -0.83 -3.17 -0.48 -3.51 c0.28 -0.28 13.09 -0.69 28.37 -0.9 c93.87 -1.1 89.19 -0.62 94.7 -9.71 l1.72 -2.89 l-0.62 -41.18 c-0.41 -22.73 -0.9 -64.81 -1.1 -93.6 c-0.28 -28.79 -0.76 -53.51 -1.1 -54.89 c-0.9 -3.51 -4.68 -6.47 -10.54 -8.26 c-4.75 -1.45 -5.23 -1.45 -55.44 -1.03 c-58.61 0.55 -57.78 0.41 -63.22 6.27 l-2.96 3.1 l-0.07 10.54 c0 5.79 -0.07 49.45 -0.14 96.97 l-0.14 86.43 l-9.99 -0.21 c-5.51 -0.14 -20.66 -0.28 -33.75 -0.34 l-23.76 -0.14 l-0.41 -13.43 c-0.28 -7.37 -0.48 -28.03 -0.55 -45.8 c0 -17.84 -0.41 -43.53 -0.76 -57.16 c-0.41 -13.64 -0.96 -36.43 -1.31 -50.62 l-0.55 -25.83 l-1.86 -3.51 c-3.51 -7.02 -10.67 -9.99 -23.07 -9.78 c-4.41 0.14 -25.48 0.34 -46.9 0.55 ZM496.14 44.08 c-103.03 0.34 -98.9 0.21 -100.96 3.1 c-0.28 0.34 -0.55 22.45 -0.55 49.1 c0 53.86 0.14 52.13 -4.34 46.56 c-2.75 -3.37 -86.85 -87.6 -92.56 -92.7 c-6.68 -5.92 -9.71 -5.92 -12.12 -0.14 c-1.38 3.31 -1.45 4.75 -1.72 70.87 l-0.21 67.49 l1.79 4.13 c1.65 3.65 4.96 7.16 31.47 33.47 c16.67 16.6 29.48 29.89 29.34 30.37 c-0.48 1.38 -8.88 1.86 -33.68 1.79 c-24.59 -0.07 -25.55 0.07 -27.48 3.93 c-0.9 1.79 -1.03 8.88 -1.03 52.2 l0 50.21 l2.55 2.34 l2.62 2.34 l50.9 0 l50.9 0 l2.13 -2.41 c1.38 -1.58 2.13 -3.24 2.2 -4.68 c0 -1.24 0 -11.57 -0.07 -22.93 c-0.14 -24.31 0.28 -30.58 2.07 -30.58 c1.31 0 11.16 9.02 19.63 17.98 c3.03 3.17 5.85 5.99 6.34 6.34 c0.41 0.28 5.23 5.03 10.67 10.54 c5.44 5.58 10.4 10.61 11.16 11.23 c0.69 0.62 3.86 3.65 7.02 6.82 l5.79 5.72 l5.72 0.96 c7.23 1.31 139.33 1.52 142.91 0.28 c1.17 -0.41 2.34 -1.31 2.55 -2.07 c1.24 -3.93 0.96 -4.2 -50 -55.17 c-27.27 -27.2 -49.52 -49.93 -49.52 -50.55 c0 -0.55 0.41 -1.17 0.9 -1.31 c0.41 -0.14 22.25 -0.41 48.35 -0.55 c26.17 -0.14 48.07 -0.55 48.76 -0.83 c2.48 -1.03 2.34 8.33 2.07 -134.09 l-0.21 -77.69 l-1.52 -0.96 c-2.34 -1.45 -5.85 -1.45 -111.85 -1.1 Zm7.85 105.92 c1.17 1.58 1.17 101.79 -0.07 102.55 c-0.41 0.21 -1.24 -0.28 -1.79 -1.17 c-0.62 -0.9 -2.13 -2.62 -3.44 -3.72 c-1.86 -1.65 -37.47 -36.71 -40.36 -39.74 c-0.34 -0.41 -9.3 -9.3 -19.83 -19.77 c-10.61 -10.47 -20.66 -20.59 -22.38 -22.38 c-1.79 -1.79 -5.79 -5.92 -8.95 -9.16 c-3.31 -3.44 -5.58 -6.34 -5.37 -6.89 c0.48 -1.24 3.65 -1.31 55.85 -1.1 c41.87 0.21 45.52 0.28 46.35 1.38 Z';

  /* Where the ink actually is inside that box. The path's own extent, not
     the box's — the difference is the padding the original file carries,
     and using the box would sit the mark visibly high and left of where it
     was asked to go. */
  var INK = { x: 33.05, y: 32.57, w: 936.65, h: 339.45 };

  var ORANGE = '#f1592a';   /* the brand mark's own colour, flat, no gradient */
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  /* Advance widths in ems, MEASURED rather than guessed.
   *
   * Read out of a real browser at 700 weight against the exact stack below,
   * and deliberately from the WIDEST face that stack resolves to — the
   * desktop-Linux DejaVu, not the Roboto an Android phone and a Chromecast
   * both use. A table fitted to Roboto breaks a line a character too late
   * on any machine with a wider face, and a title that runs off the edge of
   * its own card is the one outcome this whole file exists to avoid.
   *
   * The cost of erring this way is a title that occasionally wraps one word
   * earlier than it strictly had to. That is a line break. The cost of
   * erring the other way is a title with its end sliced off by the frame.
   *
   * Anything not listed — every CJK character, and these sites carry many —
   * is one full em, which is exactly right for those and generous for the
   * rest. Regenerate with scripts/test-cover.js, which measures the same
   * characters in a real browser and fails if any of them got wider.
   */
  var W = {
    ' ': 0.35, '!': 0.46, '"': 0.53, '#': 0.84, '$': 0.70, '%': 1.01,
    '&': 0.88, '\'': 0.31, '(': 0.46, ')': 0.46, '*': 0.53, '+': 0.84,
    ',': 0.38, '-': 0.42, '.': 0.38, '/': 0.37, '0': 0.70, '1': 0.70,
    '2': 0.70, '3': 0.70, '4': 0.70, '5': 0.70, '6': 0.70, '7': 0.70,
    '8': 0.70, '9': 0.70, ':': 0.40, ';': 0.40, '<': 0.84, '=': 0.84,
    '>': 0.84, '?': 0.59, '@': 1.00, 'A': 0.78, 'B': 0.77, 'C': 0.74,
    'D': 0.84, 'E': 0.69, 'F': 0.69, 'G': 0.83, 'H': 0.84, 'I': 0.38,
    'J': 0.38, 'K': 0.78, 'L': 0.64, 'M': 1.00, 'N': 0.84, 'O': 0.86,
    'P': 0.74, 'Q': 0.86, 'R': 0.78, 'S': 0.73, 'T': 0.69, 'U': 0.82,
    'V': 0.78, 'W': 1.11, 'X': 0.78, 'Y': 0.73, 'Z': 0.73, '[': 0.46,
    '\\': 0.37, ']': 0.46, '^': 0.84, '_': 0.50, '`': 0.50, 'a': 0.68,
    'b': 0.72, 'c': 0.60, 'd': 0.72, 'e': 0.68, 'f': 0.44, 'g': 0.72,
    'h': 0.72, 'i': 0.35, 'j': 0.35, 'k': 0.67, 'l': 0.35, 'm': 1.05,
    'n': 0.72, 'o': 0.69, 'p': 0.72, 'q': 0.72, 'r': 0.50, 's': 0.60,
    't': 0.48, 'u': 0.72, 'v': 0.66, 'w': 0.93, 'x': 0.65, 'y': 0.66,
    'z': 0.59, '{': 0.72, '|': 0.37, '}': 0.72, '~': 0.84
  };

  function advance(ch) {
    if (Object.prototype.hasOwnProperty.call(W, ch)) return W[ch];
    if (ch.charCodeAt(0) < 128) return 0.72;    /* the widest ASCII listed */
    return 1;                                   /* CJK and everything else */
  }

  /* One percent over the measured sum, for the hinting and subpixel
     rounding that make a rendered run a hair wider than the sum of its
     advances. The table above is already the widest face; this covers the
     rendering, not the font. */
  function textWidth(s, size) {
    var t = 0;
    for (var i = 0; i < s.length; i++) t += advance(s.charAt(i));
    return t * size * 1.01;
  }

  /* ---------------------------------------------------------------- *
   * Colour
   * ---------------------------------------------------------------- */

  /* FNV-1a. Any stable hash would do; what matters is that it is stable
     across the two outputs and across releases, because it is the only
     reason the same film keeps the same cover. */
  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  /* Twelve hues rather than all 360.
   *
   * A hash straight onto the colour wheel is the obvious thing and it is
   * wrong twice over. It lands a great many cards in the 60-to-105 band,
   * which at this lightness is not a colour, it is olive drab; and it lands
   * others within a few degrees of the brand orange, where the mark at the
   * bottom stops being a mark and becomes a slightly different shade of the
   * background. Both are avoided by choosing FROM a set rather than
   * anywhere on a circle.
   *
   * Every one of these is proven readable in scripts/test-cover.js — the
   * point of a fixed set is that the proof is exhaustive rather than a
   * sample. The jitter is small on purpose: enough that two films on the
   * same anchor are not the same card, too little to walk into a
   * neighbouring band that was excluded. */
  var HUES = [140, 160, 178, 192, 206, 220, 238, 258, 278, 300, 318, 334];

  function hue(title) {
    var h = hash(String(title || 'Cast Bridge'));
    var anchor = HUES[h % HUES.length];
    var jitter = ((h >>> 8) % 13) - 6;          /* -6 .. +6 */
    return ((anchor + jitter) % 360 + 360) % 360;
  }

  function hex2(n) {
    var v = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return v.length === 1 ? '0' + v : v;
  }

  /* Saturation and lightness are FIXED, and only the hue moves. That is
     what keeps two hundred different films looking like two hundred cards
     from one set rather than a colour wheel — and it is what makes a single
     contrast proof cover every title anyone will ever paste in. */
  function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return '#' + hex2((r + m) * 255) + hex2((g + m) * 255) + hex2((b + m) * 255);
  }

  function palette(title) {
    var h = hue(title);
    return {
      hue: h,
      /* Two stops, 34 degrees apart. Far enough that the card has a
         direction to it, near enough that it stays one colour rather than
         becoming the two-hue mesh every generated placeholder on the
         internet already is. */
      a: hsl(h, 0.38, 0.22),
      b: hsl(h + 34, 0.52, 0.09)
    };
  }

  function rgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function luminance(h) {
    var c = rgb(h).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrast(f, b) {
    var x = luminance(f), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  /* What colour the background actually is under a given point. The
     gradient runs corner to corner, so "the background" is a different
     colour at the title than it is under the mark at the bottom, and a
     contrast figure taken against either end alone is a figure about
     somewhere the ink is not. */
  function bgAt(plan, x, y) {
    var t = (x + y) / (plan.w + plan.h);
    t = Math.max(0, Math.min(1, t));
    var a = rgb(plan.bg.a), b = rgb(plan.bg.b);
    return '#' + hex2(a[0] + (b[0] - a[0]) * t) +
                 hex2(a[1] + (b[1] - a[1]) * t) +
                 hex2(a[2] + (b[2] - a[2]) * t);
  }

  /* ---------------------------------------------------------------- *
   * Layout
   * ---------------------------------------------------------------- */

  var MAX_LINES = 3;

  function wrap(text, size, max) {
    var words = String(text).split(/\s+/).filter(Boolean);
    var lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var next = line ? line + ' ' + words[i] : words[i];
      if (line && textWidth(next, size) > max) { lines.push(line); line = words[i]; }
      else line = next;
      /* A single word longer than the card — one unbroken CJK run, or a
         filename with no spaces in it — is cut by character instead, or it
         would be one line running off both edges. */
      while (textWidth(line, size) > max && line.length > 1) {
        var cut = line.length;
        while (cut > 1 && textWidth(line.slice(0, cut), size) > max) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /* The last line of a title that did not fit. The ellipsis goes on
     UNCONDITIONALLY, not only when the line is too wide: the line that
     survives a truncation usually fits its own width perfectly well, and
     ending it silently turns "Three Lines No Matter" into what looks like
     the whole title of the film. The mark is the only thing saying there
     was more. */
  function ellipsise(line, size, max) {
    var s = line;
    while (s.length > 1 && textWidth(s + '…', size) > max) s = s.slice(0, -1);
    return s.replace(/[\s…]+$/, '') + '…';
  }

  /* Everything the two outputs need, in absolute numbers. Neither of them
     decides anything; they draw this. */
  function plan(opts) {
    opts = opts || {};
    var w = Math.max(160, Math.round(opts.width || 1280));
    var h = Math.max(160, Math.round(opts.height || 720));
    var title = String(opts.title || '').trim() || 'Cast Bridge';
    var from = String(opts.from || '').trim();

    var min = Math.min(w, h);
    var pad = Math.round(min * 0.085);
    /* The centred square, inset. Android crops to this; the television
       shows the whole frame and simply gets a generous margin. */
    var x0 = Math.round((w - min) / 2) + pad;
    var y0 = Math.round((h - min) / 2) + pad;
    var box = min - pad * 2;
    var x1 = x0 + box, y1 = y0 + box;

    var p = palette(title);

    /* The mark, bottom left, with its words to the left of it — the
       sign-off, not a second headline. Sized off the card so it is the same
       physical proportion at 512 as at 1280. */
    var markH = Math.round(min * 0.052);
    var markW = Math.round(markH * (INK.w / INK.h));
    var bySize = Math.round(min * 0.021);
    var byText = 'POWERED BY';
    var byTrack = bySize * 0.14;
    var byW = textWidth(byText, bySize) + byTrack * (byText.length - 1);
    var lockH = Math.max(markH, bySize);
    var lockY = y1 - lockH;

    /* The title fills what is left, shrinking until it fits three lines.
       Three because a fourth is where a card stops being a label and starts
       being a paragraph nobody reads on a lock screen. */
    var size = Math.round(min * 0.115);
    var floor = Math.round(min * 0.068);
    var lines;
    for (;;) {
      lines = wrap(title, size, box);
      if (lines.length <= MAX_LINES || size <= floor) break;
      size = Math.round(size * 0.92);
    }
    if (lines.length > MAX_LINES) {
      lines = lines.slice(0, MAX_LINES);
      lines[MAX_LINES - 1] = ellipsise(lines[MAX_LINES - 1], size, box);
    }

    var lead = Math.round(size * 1.16);
    /* Bottom-anchored, growing upward off the lockup. A title block pinned
       to the top would leave a one-line card with a hole in the middle of
       it and a three-line card with none. */
    var lastBaseline = lockY - Math.round(min * 0.075);
    var text = [];
    for (var i = 0; i < lines.length; i++) {
      text.push({
        text: lines[i],
        x: x0,
        y: lastBaseline - (lines.length - 1 - i) * lead
      });
    }

    /* The source, at the top, under a short bar in the brand colour. One
       brand touch that is a rule rather than an ornament. */
    var barW = Math.round(min * 0.09);
    var barH = Math.max(3, Math.round(min * 0.007));
    var labelSize = Math.round(min * 0.026);
    var label = from ? from.toUpperCase() : '';

    return {
      w: w, h: h,
      title: title,
      hue: p.hue,
      bg: { a: p.a, b: p.b },
      font: FONT,
      orange: ORANGE,
      bar: { x: x0, y: y0, w: barW, h: barH, fill: ORANGE },
      label: label ? {
        text: label,
        x: x0,
        y: y0 + barH + Math.round(labelSize * 1.5),
        size: labelSize,
        track: labelSize * 0.12,
        fill: '#ffffff',
        opacity: 0.66
      } : null,
      lines: text,
      size: size,
      lead: lead,
      box: { x: x0, y: y0, w: box, h: box },
      lockup: {
        by: {
          text: byText,
          x: x0,
          y: lockY + lockH * 0.72,
          size: bySize,
          track: byTrack,
          width: byW,
          fill: '#ffffff',
          opacity: 0.72
        },
        mark: {
          x: x0 + byW + Math.round(min * 0.022),
          y: lockY + (lockH - markH) / 2,
          w: markW,
          h: markH,
          fill: ORANGE,
          /* From the 1000-wide normalised box down to markW, with the
             path's own ink offset taken out first. */
          scale: markH / INK.h,
          path: LOGO,
          ink: INK
        }
      }
    };
  }

  /* ---------------------------------------------------------------- *
   * Output 1 — SVG, for the television
   * ---------------------------------------------------------------- */

  /* This string is served as image/svg+xml from our own origin, so a title
     is untrusted text going into a document. Escaped here rather than at
     the endpoint: the endpoint is not the only caller and this is the only
     place that knows which parts are text. */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function n(v) { return Math.round(v * 10) / 10; }

  function svg(opts) {
    var p = plan(opts);
    var id = 'g' + p.hue;
    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + p.w + '" height="' + p.h +
             '" viewBox="0 0 ' + p.w + ' ' + p.h + '" role="img" aria-label="' +
             esc(p.title) + '">');
    out.push('<title>' + esc(p.title) + '</title>');
    out.push('<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1">' +
             '<stop offset="0" stop-color="' + p.bg.a + '"/>' +
             '<stop offset="1" stop-color="' + p.bg.b + '"/></linearGradient></defs>');
    out.push('<rect width="' + p.w + '" height="' + p.h + '" fill="url(#' + id + ')"/>');
    out.push('<rect x="' + p.bar.x + '" y="' + p.bar.y + '" width="' + p.bar.w +
             '" height="' + p.bar.h + '" fill="' + p.bar.fill + '"/>');

    if (p.label) {
      out.push('<text x="' + p.label.x + '" y="' + p.label.y + '" fill="' + p.label.fill +
               '" fill-opacity="' + p.label.opacity + '" font-family="' + esc(p.font) +
               '" font-size="' + p.label.size + '" font-weight="700" letter-spacing="' +
               n(p.label.track) + '">' + esc(p.label.text) + '</text>');
    }

    for (var i = 0; i < p.lines.length; i++) {
      out.push('<text x="' + p.lines[i].x + '" y="' + n(p.lines[i].y) + '" fill="#ffffff"' +
               ' font-family="' + esc(p.font) + '" font-size="' + p.size +
               '" font-weight="700">' + esc(p.lines[i].text) + '</text>');
    }

    var by = p.lockup.by, mark = p.lockup.mark;
    out.push('<text x="' + by.x + '" y="' + n(by.y) + '" fill="' + by.fill +
             '" fill-opacity="' + by.opacity + '" font-family="' + esc(p.font) +
             '" font-size="' + by.size + '" font-weight="700" letter-spacing="' +
             n(by.track) + '">' + esc(by.text) + '</text>');
    out.push('<g transform="translate(' + n(mark.x) + ' ' + n(mark.y) + ') scale(' +
             n(mark.scale * 1000) / 1000 + ') translate(' + n(-mark.ink.x) + ' ' +
             n(-mark.ink.y) + ')"><path d="' + mark.path + '" fill="' + mark.fill +
             '"/></g>');
    out.push('</svg>');
    return out.join('');
  }

  /* ---------------------------------------------------------------- *
   * Output 2 — a canvas, for this phone
   * ---------------------------------------------------------------- */

  function letters(ctx, text, x, y, track) {
    if (!track) { ctx.fillText(text, x, y); return; }
    var at = x;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      ctx.fillText(ch, at, y);
      at += ctx.measureText(ch).width + track;
    }
  }

  function draw(ctx, opts) {
    var p = plan(opts);
    var g = ctx.createLinearGradient(0, 0, p.w, p.h);
    g.addColorStop(0, p.bg.a);
    g.addColorStop(1, p.bg.b);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, p.w, p.h);

    ctx.fillStyle = p.bar.fill;
    ctx.fillRect(p.bar.x, p.bar.y, p.bar.w, p.bar.h);

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    if (p.label) {
      ctx.font = '700 ' + p.label.size + 'px ' + p.font;
      ctx.globalAlpha = p.label.opacity;
      ctx.fillStyle = p.label.fill;
      letters(ctx, p.label.text, p.label.x, p.label.y, p.label.track);
      ctx.globalAlpha = 1;
    }

    ctx.font = '700 ' + p.size + 'px ' + p.font;
    ctx.fillStyle = '#ffffff';
    for (var i = 0; i < p.lines.length; i++) {
      ctx.fillText(p.lines[i].text, p.lines[i].x, p.lines[i].y);
    }

    var by = p.lockup.by, mark = p.lockup.mark;
    ctx.font = '700 ' + by.size + 'px ' + p.font;
    ctx.globalAlpha = by.opacity;
    ctx.fillStyle = by.fill;
    letters(ctx, by.text, by.x, by.y, by.track);
    ctx.globalAlpha = 1;

    /* Path2D is how the real mark gets drawn, and every browser that can
       run this app has it. A browser that does not gets the letters
       instead — a wordmark in the brand colour is a truthful fallback,
       where a missing bottom-left corner would just look broken. */
    ctx.fillStyle = mark.fill;
    var Ctor = (typeof self !== 'undefined' && self.Path2D) || (typeof Path2D !== 'undefined' && Path2D);
    if (Ctor) {
      try {
        ctx.save();
        ctx.translate(mark.x, mark.y);
        ctx.scale(mark.scale, mark.scale);
        ctx.translate(-mark.ink.x, -mark.ink.y);
        ctx.fill(new Ctor(mark.path));
        ctx.restore();
        return p;
      } catch (e) { ctx.restore(); }
    }
    ctx.font = '700 ' + Math.round(mark.h) + 'px ' + p.font;
    ctx.fillText('JRV', mark.x, mark.y + mark.h * 0.9);
    return p;
  }

  /* A card as a data: URL, or '' if this browser will not give us one.
     Sized square by default: the phone's shade is the only consumer that
     takes pixels, and the shade crops to a square. */
  function dataUrl(env, opts) {
    try {
      var doc = env && env.document;
      if (!doc || !doc.createElement) return '';
      var side = (opts && opts.side) || 640;
      var c = doc.createElement('canvas');
      c.width = side;
      c.height = side;
      var ctx = c.getContext && c.getContext('2d');
      if (!ctx) return '';
      draw(ctx, { width: side, height: side, title: opts && opts.title, from: opts && opts.from });
      /* JPEG, not PNG. A flat gradient with a little type on it is about
         18 KB as a JPEG and around 90 KB as a PNG, and this string is
         handed to the OS on every metadata update. */
      return c.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      return '';
    }
  }

  var api = {
    LOGO: LOGO, INK: INK, ORANGE: ORANGE, FONT: FONT,
    HUES: HUES, hue: hue, palette: palette, plan: plan, svg: svg, draw: draw, dataUrl: dataUrl,
    bgAt: bgAt, contrast: contrast, luminance: luminance, textWidth: textWidth,
    wrap: wrap, escape: esc, MAX_LINES: MAX_LINES
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CBCover = api;
})(typeof self !== 'undefined' ? self : this);
