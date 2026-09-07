/* A QR encoder, because Bilibili's sign-in is a QR and nothing else.
 *
 * The app used to hand out Bilibili's own scan-web address as a link, on the
 * theory that a phone would deep-link it into the Bilibili app. It does not.
 * Opened in a browser it is a page that says nothing and does nothing — the
 * URL is the PAYLOAD of a QR code, not a destination, and Bilibili's app
 * reads it with a camera. So the code has to be drawn here.
 *
 * Byte mode, error correction level L, versions 1 to 10 — 271 bytes, where
 * the address Bilibili issues is about 115. Level L rather than M because
 * a lower correction level is a smaller grid, a smaller grid is fatter
 * modules on a phone screen, and fatter modules are what a camera two feet
 * away actually resolves. There is nothing to be robust against here: the
 * code is on a bright screen for one minute, not printed on a box.
 *
 * encode(text) returns { size, modules } where modules is a flat array of
 * booleans, row-major, true meaning dark. Drawing is the caller's business.
 */
(function (root) {
  'use strict';

  /* Total codewords, and the level-L block layout, per version.
   *   [ totalCodewords, ecPerBlock, blocks1, dataPerBlock1, blocks2, dataPerBlock2 ]
   * A second group exists only where the data does not divide evenly; v10 is
   * the first of those in this range. */
  var VERSIONS = [
    null,
    [26, 7, 1, 19, 0, 0],
    [44, 10, 1, 34, 0, 0],
    [70, 15, 1, 55, 0, 0],
    [100, 20, 1, 80, 0, 0],
    [134, 26, 1, 108, 0, 0],
    [172, 18, 2, 68, 0, 0],
    [196, 20, 2, 78, 0, 0],
    [242, 24, 2, 97, 0, 0],
    [292, 30, 2, 116, 0, 0],
    [346, 18, 2, 68, 2, 69]
  ];

  /* Row and column centres of the alignment patterns. Every pairing is used
     except the three that would sit on a finder. */
  var ALIGN = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  /* Unused bits at the end of the stream, which exist because the module
     count is not always a multiple of eight. Wrong here and everything
     decodes to noise from the tail backwards. */
  var REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

  /* ---------------- GF(256), primitive polynomial 0x11d ---------------- */

  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  }());

  function mul(a, b) {
    if (!a || !b) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* The generator polynomial for `degree` error-correction codewords, built
     up as (x - a^0)(x - a^1)… rather than tabled, because the table would be
     ten rows of numbers nobody could check by eye. */
  function generator(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1).fill(0);
      /* Descending order, leading coefficient first: result[i] takes the
         x term, result[i+1] the constant. The other way round builds the
         same polynomial reversed, which divides to a different remainder
         and produces a code that scans as nothing. */
      for (var i = 0; i < poly.length; i++) {
        next[i] ^= poly[i];
        next[i + 1] ^= mul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  function ecc(data, degree) {
    var gen = generator(degree);
    var rem = new Array(degree).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      /* gen[0] is 1 — the leading term contributes to a position already
         shifted out, so only the tail of the generator is applied. */
      for (var j = 0; j < gen.length - 1; j++) rem[j] ^= mul(gen[j + 1], factor);
    }
    return rem;
  }

  /* ---------------- Bits in ---------------- */

  function utf8(text) {
    var out = [];
    var s = String(text);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) { out.push(c); continue; }
      if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); continue; }
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var lo = s.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
            0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          i++;
          continue;
        }
      }
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function dataCodewords(version) {
    var v = VERSIONS[version];
    return v[2] * v[3] + v[4] * v[5];
  }

  /* Byte mode header is 4 bits of mode plus a length field that widens at
     version 10. Getting that boundary wrong is the classic bug: v9 and v10
     both encode, and only v10 decodes to rubbish. */
  function countBits(version) {
    return version < 10 ? 8 : 16;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      var capacity = dataCodewords(v) - 2 - (countBits(v) > 8 ? 1 : 0);
      if (byteLen <= capacity) return v;
    }
    return 0;
  }

  function bitStream(bytes, version) {
    var bits = [];
    function push(value, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    }
    push(4, 4);                              /* byte mode */
    push(bytes.length, countBits(version));
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);

    var capacityBits = dataCodewords(version) * 8;
    var terminator = Math.min(4, capacityBits - bits.length);
    push(0, terminator);
    while (bits.length % 8) bits.push(0);

    var words = [];
    for (var b = 0; b < bits.length; b += 8) {
      var byteVal = 0;
      for (var k = 0; k < 8; k++) byteVal = (byteVal << 1) | bits[b + k];
      words.push(byteVal);
    }
    /* The two pad bytes the spec names, alternating. Any other filler is
       still decodable but is not what a conformance reader expects. */
    var pad = [0xec, 0x11];
    var p = 0;
    while (words.length < dataCodewords(version)) words.push(pad[p++ % 2]);
    return words;
  }

  /* Split into blocks, compute EC per block, then interleave both halves —
     which is the whole point of the exercise: a scratch across the code
     damages one codeword in each block rather than one whole block. */
  function interleave(words, version) {
    var v = VERSIONS[version];
    var ecLen = v[1];
    var blocks = [];
    var at = 0;
    var g;
    for (g = 0; g < v[2]; g++) { blocks.push(words.slice(at, at + v[3])); at += v[3]; }
    for (g = 0; g < v[4]; g++) { blocks.push(words.slice(at, at + v[5])); at += v[5]; }

    var eccs = blocks.map(function (b) { return ecc(b, ecLen); });
    var longest = Math.max.apply(null, blocks.map(function (b) { return b.length; }));
    var out = [];
    var i, j;
    for (i = 0; i < longest; i++) {
      for (j = 0; j < blocks.length; j++) if (i < blocks[j].length) out.push(blocks[j][i]);
    }
    for (i = 0; i < ecLen; i++) {
      for (j = 0; j < eccs.length; j++) out.push(eccs[j][i]);
    }
    return out;
  }

  /* ---------------- The grid ---------------- */

  function makeGrid(version) {
    var size = version * 4 + 17;
    var modules = new Array(size * size).fill(null);   /* null = still free */
    var i, j;

    function set(r, c, dark) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      modules[r * size + c] = dark;
    }

    /* Finders, with their separators. */
    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (pos) {
      var r0 = pos[0];
      var c0 = pos[1];
      for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
          var inner = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
            (r === 0 || r === 6 || c === 0 || c === 6 ||
              (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          set(r0 + r, c0 + c, inner);
        }
      }
    });

    /* Alignment patterns, minus the three that would land on a finder. */
    var centres = ALIGN[version];
    for (i = 0; i < centres.length; i++) {
      for (j = 0; j < centres.length; j++) {
        var ar = centres[i];
        var ac = centres[j];
        if ((ar <= 8 && ac <= 8) ||
            (ar <= 8 && ac >= size - 9) ||
            (ar >= size - 9 && ac <= 8)) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            set(ar + dr, ac + dc,
              Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      }
    }

    /* Timing. */
    for (i = 8; i < size - 8; i++) {
      var on = i % 2 === 0;
      if (modules[6 * size + i] === null) set(6, i, on);
      if (modules[i * size + 6] === null) set(i, 6, on);
    }

    /* The one module that is always dark, and the format areas, reserved so
       the data placer walks past them. */
    set(size - 8, 8, true);
    for (i = 0; i <= 8; i++) {
      if (modules[8 * size + i] === null) set(8, i, false);
      if (modules[i * size + 8] === null) set(i, 8, false);
    }
    for (i = 0; i < 8; i++) {
      if (modules[8 * size + (size - 1 - i)] === null) set(8, size - 1 - i, false);
      if (modules[(size - 1 - i) * size + 8] === null) set(size - 1 - i, 8, false);
    }

    if (version >= 7) {
      /* BCH(18,6), generator 0x1f25. Two copies, transposed. */
      var vbits = version << 12;
      var rem = vbits;
      for (i = 0; i < 12; i++) {
        if (rem >>> (17 - i) & 1) rem ^= 0x1f25 << (5 - i);
      }
      var info = vbits | (rem & 0xfff);
      for (i = 0; i < 18; i++) {
        var bit = (info >> i) & 1 ? true : false;
        set(Math.floor(i / 3), size - 11 + (i % 3), bit);
        set(size - 11 + (i % 3), Math.floor(i / 3), bit);
      }
    }

    return { size: size, modules: modules };
  }

  /* Up the right edge, down the next, two columns at a time — and column 6
     is the vertical timing line, so it is stepped over rather than counted. */
  function place(grid, words) {
    var size = grid.size;
    var modules = grid.modules;
    var bitIndex = 0;
    var total = words.length * 8;

    function nextBit() {
      if (bitIndex >= total) return false;      /* remainder bits are zero */
      var bit = (words[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
      bitIndex++;
      return bit === 1;
    }

    var up = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (var n = 0; n < size; n++) {
        var row = up ? size - 1 - n : n;
        for (var k = 0; k < 2; k++) {
          var c = col - k;
          if (modules[row * size + c] !== null) continue;
          modules[row * size + c] = nextBit();
        }
      }
      up = !up;
    }
  }

  function maskFn(n) {
    switch (n) {
      case 0: return function (i, j) { return (i + j) % 2 === 0; };
      case 1: return function (i) { return i % 2 === 0; };
      case 2: return function (i, j) { return j % 3 === 0; };
      case 3: return function (i, j) { return (i + j) % 3 === 0; };
      case 4: return function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; };
      case 5: return function (i, j) { return (i * j) % 2 + (i * j) % 3 === 0; };
      case 6: return function (i, j) { return ((i * j) % 2 + (i * j) % 3) % 2 === 0; };
      default: return function (i, j) { return ((i + j) % 2 + (i * j) % 3) % 2 === 0; };
    }
  }

  /* Which modules the mask may touch: the data region, which is everything
     the function patterns did not claim. Recorded before masking, because
     after masking there is no way to tell them apart. */
  function dataMap(version) {
    var blank = makeGrid(version);
    return blank.modules.map(function (m) { return m === null; });
  }

  function applyMask(grid, free, n) {
    var fn = maskFn(n);
    var size = grid.size;
    var out = grid.modules.slice();
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        var i = r * size + c;
        if (free[i] && fn(r, c)) out[i] = !out[i];
      }
    }
    return out;
  }

  function writeFormat(modules, size, mask) {
    /* Level L is 01. Five bits of (level, mask), BCH(15,5) with 0x537, then
       the spec's fixed XOR so an all-zero format is not all-white. */
    var data = (1 << 3) | mask;
    var rem = data << 10;
    for (var i = 0; i < 5; i++) {
      if (rem >>> (14 - i) & 1) rem ^= 0x537 << (4 - i);
    }
    var bits = ((data << 10) | (rem & 0x3ff)) ^ 0x5412;

    function put(r, c, on) { modules[r * size + c] = on; }

    /* Both copies run bit 0 nearest the top-left finder's inner corner and
       bit 14 furthest from it. The mirror of this ordering also produces a
       valid-looking symbol with correct BCH — and decodes as nothing, which
       is exactly how this was first shipped and caught: every code drawn
       scanned as no code at all. Verified the other way now, by decoding
       the output rather than by reading the table. */
    for (var k = 0; k < 15; k++) {
      var on = ((bits >> k) & 1) === 1;

      /* Down the left of the top-right of the top-left finder, then on
         past the timing row into the bottom-left corner. */
      if (k < 6) put(k, 8, on);
      else if (k === 6) put(7, 8, on);
      else if (k === 7) put(8, 8, on);
      else put(size - 15 + k, 8, on);

      /* And along row 8, from the right-hand edge back to column 0. */
      if (k < 8) put(8, size - 1 - k, on);
      else if (k === 8) put(8, 7, on);
      else put(8, 14 - k, on);
    }
    put(size - 8, 8, true);
  }

  /* The four penalty rules. Lower is better; the winner is the mask that
     leaves the fewest patterns a decoder could mistake for a finder. */
  function penalty(modules, size) {
    var score = 0;
    var r, c, i;

    function at(row, col) { return modules[row * size + col] === true; }

    /* Rule 1 — runs of five or more. */
    for (r = 0; r < size; r++) {
      var runH = 1;
      var runV = 1;
      for (c = 1; c < size; c++) {
        if (at(r, c) === at(r, c - 1)) runH++;
        else { if (runH >= 5) score += runH - 2; runH = 1; }
        if (at(c, r) === at(c - 1, r)) runV++;
        else { if (runV >= 5) score += runV - 2; runV = 1; }
      }
      if (runH >= 5) score += runH - 2;
      if (runV >= 5) score += runV - 2;
    }

    /* Rule 2 — 2x2 blocks of one colour. */
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = at(r, c);
        if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
      }
    }

    /* Rule 3 — the finder-lookalike, in both directions, either way round. */
    var A = [true, false, true, true, true, false, true, false, false, false, false];
    var B = [false, false, false, false, true, false, true, true, true, false, true];
    function matches(row, col, dr, dc, pat) {
      for (var k = 0; k < 11; k++) {
        var rr = row + dr * k;
        var cc = col + dc * k;
        if (rr >= size || cc >= size) return false;
        if (at(rr, cc) !== pat[k]) return false;
      }
      return true;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (matches(r, c, 0, 1, A) || matches(r, c, 0, 1, B)) score += 40;
        if (matches(r, c, 1, 0, A) || matches(r, c, 1, 0, B)) score += 40;
      }
    }

    /* Rule 4 — drift away from half dark. */
    var dark = 0;
    for (i = 0; i < modules.length; i++) if (modules[i] === true) dark++;
    var pct = (dark * 100) / modules.length;
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  function encode(text) {
    var bytes = utf8(text);
    var version = pickVersion(bytes.length);
    if (!version) throw new Error('Too long for a version-10 code.');

    var words = interleave(bitStream(bytes, version), version);
    var free = dataMap(version);
    var grid = makeGrid(version);
    place(grid, words);
    void REMAINDER[version];   /* free modules left null are read as light */

    var best = null;
    for (var m = 0; m < 8; m++) {
      var candidate = applyMask(grid, free, m);
      writeFormat(candidate, grid.size, m);
      var s = penalty(candidate, grid.size);
      if (!best || s < best.score) best = { score: s, modules: candidate };
    }

    return {
      size: grid.size,
      version: version,
      modules: best.modules.map(function (v) { return v === true; })
    };
  }

  var api = { encode: encode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CBQR = api;
}(typeof window !== 'undefined' ? window : globalThis));
