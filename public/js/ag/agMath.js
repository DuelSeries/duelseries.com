// Client maths for the agar.io redo: single-precision rounding, float trigonometry, float log2
// and the draw-order sort, bit for bit as the reference client computes them (client-render
// spec sections 4.2 and 11). Loads in the browser (DuelAgarLib.agMath) and under node.
//
// Notices for the ported public algorithms:
// - sinf, cosf, their __sindf/__cosdf kernels, __rem_pio2f, __rem_pio2_large, atanf, atan2f:
//   our port of musl libc's float maths (musl is MIT licensed, Copyright (c) 2005-2020 Rich
//   Felker et al.). These descend from FreeBSD/fdlibm: "Copyright (C) 1993 by Sun
//   Microsystems, Inc. All rights reserved. Developed at SunPro, a Sun Microsystems, Inc.
//   business. Permission to use, copy, modify, and distribute this software is freely
//   granted, provided that this notice is preserved." The 2/pi digit table is that library's.
// - log2f and its 16-entry table: our port of musl's log2f, which comes from Arm's optimized
//   routines, "Copyright (c) 2017-2018, Arm Limited. SPDX-License-Identifier: MIT".
// - makeIntroSort: our port of the published libc++ std::sort (the LLVM 14/15 introsort shape
//   with the Floyd heap fallback), libc++ is "Apache-2.0 WITH LLVM-exception".
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  var f32 = Math.fround;
  var P2 = Math.pow;

  // Float word access (IEEE bits of an f32, unsigned).
  var wordView = new DataView(new ArrayBuffer(4));
  function floatBits(x) {
    wordView.setFloat32(0, x);
    return wordView.getUint32(0);
  }
  function bitsFloat(u) {
    wordView.setUint32(0, u >>> 0);
    return wordView.getFloat32(0);
  }

  // ---------------------------------------------------------------------------------------
  // sinf / cosf (musl): double-precision kernels on |x| <= pi/4, rounded once to f32
  // ---------------------------------------------------------------------------------------

  var SIN1 = -0x15555554cbac77 * P2(2, -55);
  var SIN2 = 0x111110896efbb2 * P2(2, -59);
  var SIN3 = -0x1a00f9e2cae774 * P2(2, -65);
  var SIN4 = 0x16cd878c3b46a7 * P2(2, -71);
  var COS0 = -0x1ffffffd0c5e81 * P2(2, -54);
  var COS1 = 0x155553e1053a42 * P2(2, -57);
  var COS2 = -0x16c087e80f1e27 * P2(2, -62);
  var COS3 = 0x199342e0ee5069 * P2(2, -68);

  function kernelSin(x) {
    var z = x * x;
    var w = z * z;
    var r = SIN3 + z * SIN4;
    var s = z * x;
    return f32((x + s * (SIN1 + z * SIN2)) + s * w * r);
  }

  function kernelCos(x) {
    var z = x * x;
    var w = z * z;
    var r = COS2 + z * COS3;
    return f32(((1.0 + z * COS0) + w * COS1) + (w * z) * r);
  }

  var HALF_PI_1 = 1 * Math.PI / 2;
  var HALF_PI_2 = 2 * Math.PI / 2;
  var HALF_PI_3 = 3 * Math.PI / 2;
  var HALF_PI_4 = 4 * Math.PI / 2;

  // Argument reduction: returns n and leaves the reduced double in reduced[0].
  var reduced = [0];
  var TO_INT = 1.5 / P2(2, -52);
  var INV_PIO2 = 6.36619772367581382433e-01;
  var PIO2_1 = 1.57079631090164184570e+00;
  var PIO2_1T = 1.58932547735281966916e-08;
  var PIO4 = 0x1921fb6 * P2(2, -25); // 0x1.921fb6p-1

  function reducePio2f(x) {
    var u = floatBits(x);
    var ix = u & 0x7fffffff;
    var fn, n, y;
    if (ix < 0x4dc90fdb) { // |x| ~< 2^28 * pi/2
      fn = (x * INV_PIO2 + TO_INT) - TO_INT;
      n = fn | 0;
      y = x - fn * PIO2_1 - fn * PIO2_1T;
      if (y < -PIO4) {
        n--; fn--;
        y = x - fn * PIO2_1 - fn * PIO2_1T;
      } else if (y > PIO4) {
        n++; fn++;
        y = x - fn * PIO2_1 - fn * PIO2_1T;
      }
      reduced[0] = y;
      return n;
    }
    if (ix >= 0x7f800000) { reduced[0] = x - x; return 0; }
    var e0 = (ix >>> 23) - (0x7f + 23);
    var tx = bitsFloat(ix - (e0 << 23)); // |x| scaled into [2^23, 2^24)
    n = reduceLarge(tx, e0);
    if (u >>> 31) { reduced[0] = -reduced[0]; return -n; }
    return n;
  }

  // musl __rem_pio2_large for one input word at prec 0 (float); leaves y in reduced[0].
  // Only the first 66 table words can be reached from an f32 exponent.
  var IPIO2 = [
    0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62,
    0x95993C, 0x439041, 0xFE5163, 0xABDEBB, 0xC561B7, 0x246E3A,
    0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129,
    0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41,
    0x3991D6, 0x398353, 0x39F49C, 0x845F8B, 0xBDF928, 0x3B1FF8,
    0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF,
    0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5,
    0xF17B3D, 0x0739F7, 0x8A5292, 0xEA6BFB, 0x5FB11F, 0x8D5D08,
    0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3,
    0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880,
    0x4D7327, 0x310606, 0x1556CA, 0x73A8C9, 0x60E27B, 0xC08C6B
  ];
  var PIO2_PARTS = [
    1.57079625129699707031e+00, 7.54978941586159635335e-08, 5.39030252995776476554e-15,
    3.28200341580791294123e-22, 1.27065575308067607349e-29, 1.22933308981111328932e-36,
    2.73370053816464559624e-44, 2.16741683877804819444e-51
  ];
  var TWO24 = 16777216;
  var INV_TWO24 = 1 / TWO24;

  function reduceLarge(x0, e0) {
    var jk = 3; // init_jk[prec 0]
    var jp = jk;
    var jv = Math.trunc((e0 - 3) / 24);
    if (jv < 0) jv = 0;
    var q0 = e0 - 24 * (jv + 1);
    var f = new Array(20), q = new Array(20), fq = new Array(20), iq = new Array(20);
    var i, j, k, z, fw, n, ih, carry, jz;
    for (i = 0, j = jv; i <= jk; i++, j++) f[i] = j < 0 ? 0.0 : IPIO2[j];
    for (i = 0; i <= jk; i++) q[i] = 0.0 + x0 * f[i];
    jz = jk;
    for (;;) {
      for (i = 0, j = jz, z = q[jz]; j > 0; i++, j--) {
        fw = (INV_TWO24 * z) | 0;
        iq[i] = (z - TWO24 * fw) | 0;
        z = q[j - 1] + fw;
      }
      z = z * P2(2, q0);
      z -= 8.0 * Math.floor(z * 0.125);
      n = z | 0;
      z -= n;
      ih = 0;
      if (q0 > 0) {
        i = iq[jz - 1] >> (24 - q0);
        n += i;
        iq[jz - 1] -= i << (24 - q0);
        ih = iq[jz - 1] >> (23 - q0);
      } else if (q0 === 0) {
        ih = iq[jz - 1] >> 23;
      } else if (z >= 0.5) {
        ih = 2;
      }
      if (ih > 0) {
        n += 1;
        carry = 0;
        for (i = 0; i < jz; i++) {
          j = iq[i];
          if (carry === 0) {
            if (j !== 0) { carry = 1; iq[i] = 0x1000000 - j; }
          } else {
            iq[i] = 0xffffff - j;
          }
        }
        if (q0 === 1) iq[jz - 1] &= 0x7fffff;
        else if (q0 === 2) iq[jz - 1] &= 0x3fffff;
        if (ih === 2) {
          z = 1.0 - z;
          if (carry !== 0) z -= P2(2, q0);
        }
      }
      if (z === 0.0) {
        j = 0;
        for (i = jz - 1; i >= jk; i--) j |= iq[i];
        if (j === 0) {
          for (k = 1; iq[jk - k] === 0; k++);
          for (i = jz + 1; i <= jz + k; i++) {
            f[i] = IPIO2[jv + i];
            q[i] = 0.0 + x0 * f[i];
          }
          jz += k;
          continue;
        }
      }
      break;
    }
    if (z === 0.0) {
      jz -= 1;
      q0 -= 24;
      while (iq[jz] === 0) { jz--; q0 -= 24; }
    } else {
      z = z * P2(2, -q0);
      if (z >= TWO24) {
        fw = (INV_TWO24 * z) | 0;
        iq[jz] = (z - TWO24 * fw) | 0;
        jz += 1;
        q0 += 24;
        iq[jz] = fw;
      } else {
        iq[jz] = z | 0;
      }
    }
    fw = P2(2, q0);
    for (i = jz; i >= 0; i--) {
      q[i] = fw * iq[i];
      fw *= INV_TWO24;
    }
    for (i = jz; i >= 0; i--) {
      for (fw = 0.0, k = 0; k <= jp && k <= jz - i; k++) fw += PIO2_PARTS[k] * q[i + k];
      fq[jz - i] = fw;
    }
    fw = 0.0;
    for (i = jz; i >= 0; i--) fw += fq[i];
    reduced[0] = ih === 0 ? fw : -fw;
    return n;
  }

  function sinf(x) {
    x = f32(x);
    var u = floatBits(x);
    var neg = u >>> 31;
    var ix = u & 0x7fffffff;
    if (ix <= 0x3f490fda) { // |x| ~<= pi/4
      if (ix < 0x39800000) return x; // |x| < 2^-12
      return kernelSin(x);
    }
    if (ix <= 0x407b53d1) { // |x| ~<= 5pi/4
      if (ix <= 0x4016cbe3) return neg ? -kernelCos(x + HALF_PI_1) : kernelCos(x - HALF_PI_1);
      return kernelSin(neg ? -(x + HALF_PI_2) : -(x - HALF_PI_2));
    }
    if (ix <= 0x40e231d5) { // |x| ~<= 9pi/4
      if (ix <= 0x40afeddf) return neg ? kernelCos(x + HALF_PI_3) : -kernelCos(x - HALF_PI_3);
      return kernelSin(neg ? x + HALF_PI_4 : x - HALF_PI_4);
    }
    if (ix >= 0x7f800000) return x - x;
    var n = reducePio2f(x);
    var y = reduced[0];
    switch (n & 3) {
      case 0: return kernelSin(y);
      case 1: return kernelCos(y);
      case 2: return kernelSin(-y);
      default: return -kernelCos(y);
    }
  }

  function cosf(x) {
    x = f32(x);
    var u = floatBits(x);
    var neg = u >>> 31;
    var ix = u & 0x7fffffff;
    if (ix <= 0x3f490fda) {
      if (ix < 0x39800000) return 1.0;
      return kernelCos(x);
    }
    if (ix <= 0x407b53d1) {
      if (ix > 0x4016cbe3) return -kernelCos(neg ? x + HALF_PI_2 : x - HALF_PI_2);
      return neg ? kernelSin(x + HALF_PI_1) : kernelSin(HALF_PI_1 - x);
    }
    if (ix <= 0x40e231d5) {
      if (ix > 0x40afeddf) return kernelCos(neg ? x + HALF_PI_4 : x - HALF_PI_4);
      return neg ? kernelSin(-x - HALF_PI_3) : kernelSin(x - HALF_PI_3);
    }
    if (ix >= 0x7f800000) return x - x;
    var n = reducePio2f(x);
    var y = reduced[0];
    switch (n & 3) {
      case 0: return kernelCos(y);
      case 1: return kernelSin(-y);
      case 2: return -kernelCos(y);
      default: return kernelSin(y);
    }
  }

  // ---------------------------------------------------------------------------------------
  // atanf / atan2f (musl): every operation rounded to f32
  // ---------------------------------------------------------------------------------------

  var ATAN_HI = [f32(4.6364760399e-01), f32(7.8539812565e-01), f32(9.8279368877e-01), f32(1.5707962513e+00)];
  var ATAN_LO = [f32(5.0121582440e-09), f32(3.7748947079e-08), f32(3.4473217170e-08), f32(7.5497894159e-08)];
  var ATAN_T = [f32(3.3333328366e-01), f32(-1.9999158382e-01), f32(1.4253635705e-01),
    f32(-1.0648017377e-01), f32(6.1687607318e-02)];

  function atanf(x) {
    x = f32(x);
    var u = floatBits(x);
    var neg = u >>> 31;
    var ix = u & 0x7fffffff;
    var id;
    if (ix >= 0x4c800000) { // |x| >= 2^26
      if (x !== x) return x;
      var big = f32(ATAN_HI[3] + P2(2, -120));
      return neg ? -big : big;
    }
    if (ix < 0x3ee00000) { // |x| < 0.4375
      if (ix < 0x39800000) return x;
      id = -1;
    } else {
      x = Math.abs(x);
      if (ix < 0x3f980000) { // |x| < 1.1875
        if (ix < 0x3f300000) { id = 0; x = f32(f32(f32(2 * x) - 1) / f32(2 + x)); }
        else { id = 1; x = f32(f32(x - 1) / f32(x + 1)); }
      } else if (ix < 0x401c0000) { // |x| < 2.4375
        id = 2; x = f32(f32(x - 1.5) / f32(1 + f32(1.5 * x)));
      } else {
        id = 3; x = f32(-1 / x);
      }
    }
    var z = f32(x * x);
    var w = f32(z * z);
    var s1 = f32(z * f32(ATAN_T[0] + f32(w * f32(ATAN_T[2] + f32(w * ATAN_T[4])))));
    var s2 = f32(w * f32(ATAN_T[1] + f32(w * ATAN_T[3])));
    if (id < 0) return f32(x - f32(x * f32(s1 + s2)));
    var r = f32(ATAN_HI[id] - f32(f32(f32(x * f32(s1 + s2)) - ATAN_LO[id]) - x));
    return neg ? -r : r;
  }

  var PI_F = f32(3.1415927410e+00);
  var PI_LO_F = f32(-8.7422776573e-08);
  var HALF_PI_F = f32(PI_F / 2);
  var QUARTER_PI_F = f32(PI_F / 4);
  var THREE_QUARTER_PI_F = f32(f32(3 * PI_F) / 4);

  function atan2f(y, x) {
    y = f32(y);
    x = f32(x);
    if (x !== x || y !== y) return f32(x + y);
    var ix = floatBits(x);
    var iy = floatBits(y);
    if (ix === 0x3f800000) return atanf(y); // x == 1
    var m = ((iy >>> 31) & 1) | ((ix >>> 30) & 2); // 2*sign(x) + sign(y)
    ix &= 0x7fffffff;
    iy &= 0x7fffffff;
    if (iy === 0) {
      if (m < 2) return y;
      return m === 2 ? PI_F : -PI_F;
    }
    if (ix === 0) return (m & 1) ? -HALF_PI_F : HALF_PI_F;
    if (ix === 0x7f800000) {
      if (iy === 0x7f800000) {
        switch (m) {
          case 0: return QUARTER_PI_F;
          case 1: return -QUARTER_PI_F;
          case 2: return THREE_QUARTER_PI_F;
          default: return -THREE_QUARTER_PI_F;
        }
      }
      switch (m) {
        case 0: return 0.0;
        case 1: return -0.0;
        case 2: return PI_F;
        default: return -PI_F;
      }
    }
    if (ix + (26 << 23) < iy || iy === 0x7f800000) return (m & 1) ? -HALF_PI_F : HALF_PI_F;
    var z;
    if ((m & 2) && iy + (26 << 23) < ix) z = 0.0;
    else z = atanf(Math.abs(f32(y / x)));
    switch (m) {
      case 0: return z;
      case 1: return -z;
      case 2: return f32(PI_F - f32(z - PI_LO_F));
      default: return f32(f32(z - PI_LO_F) - PI_F);
    }
  }

  // ---------------------------------------------------------------------------------------
  // log2f (musl, table-driven): double evaluation, one rounding to f32 at the end
  // ---------------------------------------------------------------------------------------

  // Each entry: [invc, logc] as exact binary64 values (mantissa hex digits, power of two).
  function hx(mant, exp) { return parseInt(mant, 16) * P2(2, exp); }
  var LOG2_TAB = [
    [hx('1661ec79f8f3be', -52), -hx('1efec65b963019', -54)],
    [hx('1571ed4aaf883d', -52), -hx('1b0b6832d4fca4', -54)],
    [hx('149539f0f010b', -48), -hx('17418b0a1fb77b', -54)],
    [hx('13c995b0b80385', -52), -hx('139de91a6dcf7b', -54)],
    [hx('130d190c8864a5', -52), -hx('101d9bf3f2b631', -54)],
    [hx('125e227b0b8ea', -48), -hx('197c1d1b3b7af', -51)],
    [hx('11bb4a4a1a343f', -52), -hx('12f9e393af3c9f', -55)],
    [hx('112358f08ae5ba', -52), -hx('1960cbbf788d5c', -56)],
    [hx('10953f419900a7', -52), -hx('1a6f9db6475fce', -57)],
    [1, 0],
    [hx('1e608cfd9a47ac', -53), hx('1338ca9f24f53d', -56)],
    [hx('1ca4b31f026aa', -49), hx('1476a9543891ba', -55)],
    [hx('1b2036576afce6', -53), hx('1e840b4ac4e4d2', -55)],
    [hx('19c2d163a1aa2d', -53), hx('140645f0c6651c', -54)],
    [hx('1886e6037841ed', -53), hx('188e9c2c1b9ff8', -54)],
    [hx('1767dcf5534862', -53), hx('1ce0a44eb17bcc', -54)]
  ];
  var LOG2_A0 = -hx('1712b6f70a7e4d', -54);
  var LOG2_A1 = hx('1ecabf496832e', -50);
  var LOG2_A2 = -hx('1715479ffae3de', -53);
  var LOG2_A3 = hx('1715475f35c8b8', -52);
  var LOG2_OFF = 0x3f330000;

  function log2f(x) {
    x = f32(x);
    var ix = floatBits(x);
    if (ix === 0x3f800000) return 0;
    if (ix - 0x00800000 >= 0x7f800000 - 0x00800000 || ix < 0x00800000) {
      // below the smallest normal, negative, infinite or NaN
      if (((ix << 1) >>> 0) === 0) return -Infinity;
      if (ix === 0x7f800000) return x;
      if ((ix & 0x80000000) || ((ix << 1) >>> 0) >= 0xff000000) return NaN;
      ix = (floatBits(f32(x * 8388608)) - (23 << 23)) >>> 0; // subnormal: normalise
    }
    var tmp = (ix - LOG2_OFF) >>> 0;
    var i = (tmp >>> 19) & 15;
    var top = (tmp & 0xff800000) >>> 0;
    var iz = (ix - top) >>> 0;
    var k = tmp >> 23;
    var invc = LOG2_TAB[i][0];
    var logc = LOG2_TAB[i][1];
    var z = bitsFloat(iz);
    var r = z * invc - 1;
    var y0 = logc + k;
    var r2 = r * r;
    var y = LOG2_A1 * r + LOG2_A2;
    y = LOG2_A0 * r2 + y;
    var p = LOG2_A3 * r + y0;
    return f32(y * r2 + p);
  }

  // ---------------------------------------------------------------------------------------
  // Draw-order sort: the libc++ introsort (unstable; ties land exactly where it puts them)
  // ---------------------------------------------------------------------------------------

  // makeIntroSort(less) returns sort(array) that sorts in place and returns the array.
  // Depth limit 2*floor(log2(n)); insertion sort up to 30 elements; median of 3 pivot (of 5
  // from 1000 elements); a swap-free partition tries the bounded insertion sort (8 moves) on
  // both halves; recursion into the smaller part; heap sort with Floyd sift-down at depth 0.
  function makeIntroSort(less) {
    var a;

    function swap(i, j) { var t = a[i]; a[i] = a[j]; a[j] = t; }

    function sort3(x, y, z) {
      if (!less(a[y], a[x])) {
        if (!less(a[z], a[y])) return 0;
        swap(y, z);
        if (less(a[y], a[x])) { swap(x, y); return 2; }
        return 1;
      }
      if (less(a[z], a[y])) { swap(x, z); return 1; }
      swap(x, y);
      if (less(a[z], a[y])) { swap(y, z); return 2; }
      return 1;
    }

    function sort4(x1, x2, x3, x4) {
      var r = sort3(x1, x2, x3);
      if (less(a[x4], a[x3])) {
        swap(x3, x4); r++;
        if (less(a[x3], a[x2])) {
          swap(x2, x3); r++;
          if (less(a[x2], a[x1])) { swap(x1, x2); r++; }
        }
      }
      return r;
    }

    function sort5(x1, x2, x3, x4, x5) {
      var r = sort4(x1, x2, x3, x4);
      if (less(a[x5], a[x4])) {
        swap(x4, x5); r++;
        if (less(a[x4], a[x3])) {
          swap(x3, x4); r++;
          if (less(a[x3], a[x2])) {
            swap(x2, x3); r++;
            if (less(a[x2], a[x1])) { swap(x1, x2); r++; }
          }
        }
      }
      return r;
    }

    // Insertion sort after sorting the first three; with a move limit it stops early and
    // reports whether the range ended up sorted.
    function insertionAfter3(first, last, limit) {
      var j = first + 2;
      sort3(first, first + 1, j);
      var moves = 0;
      for (var i = j + 1; i !== last; i++) {
        if (less(a[i], a[j])) {
          var t = a[i];
          var k = j;
          j = i;
          do { a[j] = a[k]; j = k; } while (j !== first && less(t, a[--k]));
          a[j] = t;
          if (limit && ++moves === limit) return i + 1 === last;
        }
        j = i;
      }
      return true;
    }

    function smallSort(first, last) { // lengths 0..5; returns false for longer ranges
      switch (last - first) {
        case 0: case 1: return true;
        case 2: if (less(a[last - 1], a[first])) swap(first, last - 1); return true;
        case 3: sort3(first, first + 1, last - 1); return true;
        case 4: sort4(first, first + 1, first + 2, last - 1); return true;
        case 5: sort5(first, first + 1, first + 2, first + 3, last - 1); return true;
      }
      return false;
    }

    function insertionIncomplete(first, last) {
      if (smallSort(first, last)) return true;
      return insertionAfter3(first, last, 8);
    }

    function siftDown(first, len, start) {
      var child = start - first;
      if (len < 2 || ((len - 2) >> 1) < child) return;
      child = 2 * child + 1;
      var ci = first + child;
      if (child + 1 < len && less(a[ci], a[ci + 1])) { ci++; child++; }
      if (less(a[ci], a[start])) return;
      var top = a[start];
      do {
        a[start] = a[ci];
        start = ci;
        if (((len - 2) >> 1) < child) break;
        child = 2 * child + 1;
        ci = first + child;
        if (child + 1 < len && less(a[ci], a[ci + 1])) { ci++; child++; }
      } while (!less(a[ci], top));
      a[start] = top;
    }

    function floydSiftDown(first, len) {
      var hole = first;
      var child = 0;
      for (;;) {
        child = 2 * child + 1;
        var ci = first + child;
        if (child + 1 < len && less(a[ci], a[ci + 1])) { ci++; child++; }
        a[hole] = a[ci];
        hole = ci;
        if (child > ((len - 2) >> 1)) return hole;
      }
    }

    function siftUp(first, last, len) {
      if (len > 1) {
        len = (len - 2) >> 1;
        var p = first + len;
        if (less(a[p], a[--last])) {
          var t = a[last];
          do {
            a[last] = a[p];
            last = p;
            if (len === 0) break;
            len = (len - 1) >> 1;
            p = first + len;
          } while (less(a[p], t));
          a[last] = t;
        }
      }
    }

    function popHeap(first, last, len) {
      if (len > 1) {
        var top = a[first];
        var hole = floydSiftDown(first, len);
        last--;
        if (hole === last) {
          a[hole] = top;
        } else {
          a[hole] = a[last];
          hole++;
          a[last] = top;
          siftUp(first, hole, hole - first);
        }
      }
    }

    function heapSort(first, last) {
      var n = last - first;
      if (n > 1) for (var s = (n - 2) >> 1; s >= 0; s--) siftDown(first, n, first + s);
      for (var len = n; len > 1; len--) popHeap(first, first + len, len);
    }

    function introsort(first, last, depth) {
      for (;;) {
        var len = last - first;
        if (smallSort(first, last)) return;
        if (len <= 30) { insertionAfter3(first, last, 0); return; }
        if (depth === 0) { heapSort(first, last); return; }
        depth--;

        var lm1 = last - 1;
        var half = len >> 1;
        var m = first + half;
        var swaps = len >= 1000
          ? sort5(first, first + (half >> 1), m, m + (half >> 1), lm1)
          : sort3(first, m, lm1);

        var i = first;
        var j = lm1;
        if (!less(a[i], a[m])) {
          // The first element equals the pivot: look for a guard below it from the right.
          var restarted = false;
          for (;;) {
            if (i === --j) {
              // Nothing below the pivot: partition into "== first" and "> first" instead.
              ++i;
              j = last;
              if (!less(a[first], a[--j])) {
                for (;;) {
                  if (i === j) return;
                  if (less(a[first], a[i])) { swap(i, j); ++swaps; ++i; break; }
                  ++i;
                }
              }
              if (i === j) return;
              for (;;) {
                while (!less(a[first], a[i])) ++i;
                while (less(a[first], a[--j]));
                if (i >= j) break;
                swap(i, j); ++swaps;
                ++i;
              }
              first = i;
              restarted = true;
              break;
            }
            if (less(a[j], a[m])) { swap(i, j); ++swaps; break; }
          }
          if (restarted) continue;
        }

        ++i;
        if (i < j) {
          for (;;) {
            while (less(a[i], a[m])) ++i;
            while (!less(a[--j], a[m]));
            if (i > j) break;
            swap(i, j); ++swaps;
            if (m === i) m = j;
            ++i;
          }
        }
        if (i !== m && less(a[m], a[i])) { swap(i, m); ++swaps; }

        if (swaps === 0) {
          var leftSorted = insertionIncomplete(first, i);
          if (insertionIncomplete(i + 1, last)) {
            if (leftSorted) return;
            last = i;
            continue;
          } else if (leftSorted) {
            first = ++i;
            continue;
          }
        }

        if (i - first < last - i) {
          introsort(first, i, depth);
          first = ++i;
        } else {
          introsort(i + 1, last, depth);
          last = i;
        }
      }
    }

    return function sort(array) {
      a = array;
      var n = array.length;
      var depth = n > 0 ? 2 * (31 - Math.clz32(n)) : 0;
      try {
        introsort(0, n, depth);
      } finally {
        a = null;
      }
      return array;
    };
  }

  var agMath = {
    f32: f32,
    sinf: sinf,
    cosf: cosf,
    atanf: atanf,
    atan2f: atan2f,
    log2f: log2f,
    makeIntroSort: makeIntroSort
  };
  A.agMath = agMath;
  if (typeof module !== 'undefined' && module.exports) module.exports = agMath;
})(typeof window !== 'undefined' ? window : globalThis);
