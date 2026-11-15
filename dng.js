// DNG (TIFF) reader for Bayer raw files. No dependencies.
// dngCore() is self-contained so the same source can run in a Web Worker (built from
// its own text, which also works when index.html is opened by double click) and in Node.
function dngCore() {
  const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

  function open(buf) {
    const dv = new DataView(buf);
    const bo = dv.getUint16(0);
    if (bo !== 0x4949 && bo !== 0x4d4d) throw new Error('TIFF/DNG dosyası değil');
    const le = bo === 0x4949;
    if (dv.getUint16(2, le) !== 42) throw new Error('TIFF/DNG dosyası değil');

    function readIFD(off) {
      const n = dv.getUint16(off, le), tags = {};
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        const type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
        const size = (TYPE_SIZE[type] || 1) * count;
        tags[dv.getUint16(e, le)] = { type, count, off: size <= 4 ? e + 8 : dv.getUint32(e + 8, le) };
      }
      tags.next = dv.getUint32(off + 2 + n * 12, le);
      return tags;
    }

    // Returns a string (ASCII), a Uint8Array (bytes) or an array of numbers.
    function val(t) {
      if (!t) return undefined;
      const { type, count, off } = t;
      if (off + (TYPE_SIZE[type] || 1) * count > buf.byteLength) throw new Error('eksik veri');
      if (type === 2) {
        let s = '';
        for (let i = 0; i < count; i++) { const c = dv.getUint8(off + i); if (!c) break; s += String.fromCharCode(c); }
        return s.trim();
      }
      if (type === 1 || type === 6 || type === 7) return new Uint8Array(buf, off, count);
      const out = new Array(count);
      for (let i = 0; i < count; i++) {
        switch (type) {
          case 3: out[i] = dv.getUint16(off + i * 2, le); break;
          case 8: out[i] = dv.getInt16(off + i * 2, le); break;
          case 4: case 13: out[i] = dv.getUint32(off + i * 4, le); break;
          case 9: out[i] = dv.getInt32(off + i * 4, le); break;
          case 5: out[i] = dv.getUint32(off + i * 8, le) / (dv.getUint32(off + i * 8 + 4, le) || 1); break;
          case 10: out[i] = dv.getInt32(off + i * 8, le) / (dv.getInt32(off + i * 8 + 4, le) || 1); break;
          case 11: out[i] = dv.getFloat32(off + i * 4, le); break;
          case 12: out[i] = dv.getFloat64(off + i * 8, le); break;
          default: out[i] = 0;
        }
      }
      return out;
    }
    const num = (t, d) => { const v = val(t); return v === undefined || v.length === 0 ? d : v[0]; };

    const ifds = [];
    function walk(off, depth) {
      if (!off || off + 2 > buf.byteLength || depth > 3 || ifds.length > 32) return;
      const ifd = readIFD(off);
      ifds.push(ifd);
      for (const o of val(ifd[330]) || []) walk(o, depth + 1);
      if (depth === 0) walk(ifd.next, 0);
    }
    walk(dv.getUint32(4, le), 0);
    if (!ifds.length) throw new Error('TIFF/DNG dosyası değil');
    return { buf, dv, le, ifds, val, num, readIFD };
  }

  function readMeta(f) {
    const t0 = f.ifds[0], m = {};
    m.make = f.val(t0[271]) || '';
    m.model = f.val(t0[50708]) || f.val(t0[272]) || '';
    if (t0[34665]) {
      const ex = f.readIFD(f.num(t0[34665]));
      m.shutter = f.num(ex[33434]);
      m.aperture = f.num(ex[33437]);
      m.iso = f.num(ex[34855]);
      m.focal = f.num(ex[37386]);
      m.focal35 = f.num(ex[41989]);
      m.date = f.val(ex[36867]) || f.val(t0[306]);
    }
    return m;
  }

  // Largest embedded JPEG preview, as a copy of its bytes.
  function findPreview(f) {
    let best = null, bw = 0;
    for (const t of f.ifds) {
      if (f.num(t[259]) !== 7 || f.num(t[262]) !== 6 || !t[273] || t[273].count !== 1) continue;
      const w = f.num(t[256], 0);
      if (w > bw) { bw = w; best = t; }
    }
    if (!best) return null;
    const off = f.num(best[273]), len = f.num(best[279]);
    if (off + len > f.buf.byteLength) throw new Error('eksik veri');
    return new Uint8Array(f.buf.slice(off, off + len));
  }

  // Lossless JPEG (SOF3) as used inside DNG. Returns samples in stream order.
  function lj92(d) {
    const n = d.length;
    if (d[0] !== 0xff || d[1] !== 0xd8) throw new Error('bozuk sıkıştırılmış veri');
    let p = 2, prec = 0, jh = 0, jw = 0, nc = 0, pred = 1;
    const hl = [], hv = [], sel = [];
    for (;;) {
      if (p + 4 > n || d[p] !== 0xff) throw new Error('bozuk sıkıştırılmış veri');
      const m = d[p + 1]; p += 2;
      const len = (d[p] << 8) | d[p + 1];
      if (m === 0xc4) {
        let q = p + 2;
        const end = p + len;
        while (q < end) {
          const id = d[q++] & 15, counts = d.subarray(q, q + 16); q += 16;
          const L = new Uint8Array(65536), V = new Uint8Array(65536);
          let code = 0;
          for (let l = 1; l <= 16; l++) {
            for (let i = 0; i < counts[l - 1]; i++) {
              const start = code << (16 - l), cnt = 1 << (16 - l);
              L.fill(l, start, start + cnt); V.fill(d[q++], start, start + cnt);
              code++;
            }
            code <<= 1;
          }
          hl[id] = L; hv[id] = V;
        }
      } else if (m === 0xc3) {
        prec = d[p + 2]; jh = (d[p + 3] << 8) | d[p + 4]; jw = (d[p + 5] << 8) | d[p + 6]; nc = d[p + 7];
      } else if (m === 0xdd) {
        if ((d[p + 2] << 8) | d[p + 3]) throw new Error('bu sıkıştırma türü desteklenmiyor (restart)');
      } else if (m === 0xda) {
        const ns = d[p + 2];
        for (let i = 0; i < ns; i++) sel[i] = d[p + 4 + 2 * i] >> 4;
        pred = d[p + 3 + 2 * ns];
        p += len;
        break;
      } else if (m !== 0xc3 && m >= 0xc0 && m <= 0xcf) {
        throw new Error('bu sıkıştırma türü desteklenmiyor');
      }
      p += len;
    }
    if (!jw || !jh || !nc) throw new Error('bozuk sıkıştırılmış veri');
    const row = jw * nc, out = new Uint16Array(row * jh), init = 1 << (prec - 1);
    let bb = 0, bc = 0;
    for (let y = 0; y < jh; y++) {
      for (let x = 0; x < jw; x++) {
        for (let c = 0; c < nc; c++) {
          while (bc <= 24) {
            let b = p < n ? d[p++] : 0;
            if (b === 0xff) { if (d[p] === 0) p++; else { p--; b = 0; } }
            bb = (bb << 8) | b; bc += 8;
          }
          const idx = (bb >>> (bc - 16)) & 0xffff, tl = hl[sel[c]][idx], s = hv[sel[c]][idx];
          if (!tl) throw new Error('bozuk sıkıştırılmış veri');
          bc -= tl;
          let diff = 0;
          if (s === 16) diff = 32768;
          else if (s) {
            while (bc <= 24) {
              let b = p < n ? d[p++] : 0;
              if (b === 0xff) { if (d[p] === 0) p++; else { p--; b = 0; } }
              bb = (bb << 8) | b; bc += 8;
            }
            diff = (bb >>> (bc - s)) & ((1 << s) - 1); bc -= s;
            if (diff < (1 << (s - 1))) diff -= (1 << s) - 1;
          }
          const o = y * row + x * nc + c;
          let pr;
          if (y === 0) pr = x === 0 ? init : out[o - nc];
          else if (x === 0) pr = out[o - row];
          else {
            const a = out[o - nc], b = out[o - row], cc = out[o - row - nc];
            switch (pred) {
              case 1: pr = a; break;
              case 2: pr = b; break;
              case 3: pr = cc; break;
              case 4: pr = a + b - cc; break;
              case 5: pr = a + ((b - cc) >> 1); break;
              case 6: pr = b + ((a - cc) >> 1); break;
              default: pr = (a + b) >> 1;
            }
          }
          out[o] = (pr + diff) & 0xffff;
        }
      }
    }
    return out;
  }

  function decodePixels(f, t) {
    const W = f.num(t[256]), H = f.num(t[257]), bps = f.num(t[258]), comp = f.num(t[259]);
    if (f.num(t[277], 1) !== 1) throw new Error('yalnızca Bayer RAW destekleniyor');
    if (comp !== 1 && comp !== 7) throw new Error('bu RAW sıkıştırması desteklenmiyor (' + comp + ')');
    if (comp === 1 && bps !== 16 && bps !== 8) throw new Error(bps + ' bit sıkıştırmasız RAW desteklenmiyor');
    const out = new Uint16Array(W * H), u8 = new Uint8Array(f.buf);
    const tiled = !!t[322];
    const tw = tiled ? f.num(t[322]) : W, th = tiled ? f.num(t[323]) : f.num(t[278], H);
    const offs = f.val(t[tiled ? 324 : 273]), cnts = f.val(t[tiled ? 325 : 279]);
    const across = Math.ceil(W / tw);
    for (let i = 0; i < offs.length; i++) {
      const tx = (i % across) * tw, ty = Math.floor(i / across) * th;
      if (ty >= H) break;
      if (offs[i] + cnts[i] > f.buf.byteLength) throw new Error('dosya eksik ya da bozuk');
      const rows = Math.min(th, H - ty), cols = Math.min(tw, W - tx);
      let src;
      if (comp === 7) src = lj92(u8.subarray(offs[i], offs[i] + cnts[i]));
      else if (bps === 8) src = u8.subarray(offs[i], offs[i] + cnts[i]);
      else {
        src = new Uint16Array(tw * rows);
        for (let k = 0, o = offs[i]; k < src.length; k++, o += 2) src[k] = f.dv.getUint16(o, f.le);
      }
      if (src.length < tw * rows) throw new Error('dosya eksik ya da bozuk');
      for (let y = 0; y < rows; y++) out.set(src.subarray(y * tw, y * tw + cols), (ty + y) * W + tx);
    }
    const lin = f.val(t[50712]);
    if (lin && lin.length) for (let i = 0; i < out.length; i++) out[i] = lin[Math.min(out[i], lin.length - 1)];
    return { W, H, bps, data: out };
  }

  // ---- color ----
  const mul = (a, b) => {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r;
  };
  const mulV = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  function inv(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
  }
  const ILLUM_K = { 1: 5500, 2: 4150, 3: 2850, 4: 5500, 9: 5500, 10: 6500, 11: 7500, 12: 6430, 13: 5000, 14: 4230, 15: 3450, 17: 2856, 18: 4874, 19: 6774, 20: 5503, 21: 6504, 22: 7504, 23: 5003, 24: 3200 };
  const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  const XYZ_TO_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];
  const D65 = [0.95047, 1, 1.08883];

  // Matrix from white balanced camera RGB to linear sRGB, following the DNG spec
  // (color matrices interpolated by the color temperature of the as shot white).
  function colorSetup(f) {
    const t0 = f.ifds[0];
    let n = f.val(t0[50728]);
    if (!n || n.length !== 3 || n.some(v => !(v > 0))) n = [1, 1, 1];
    const cm1 = f.val(t0[50721]), cm2 = f.val(t0[50722]);
    if (!cm1 && !cm2) throw new Error('renk matrisi yok');
    const k1 = ILLUM_K[f.num(t0[50778], 0)] || 2856, k2 = ILLUM_K[f.num(t0[50779], 0)] || 6504;
    const ab = f.val(t0[50727]);
    let cm = cm2 || cm1, white = D65;
    for (let it = 0; it < 20; it++) {
      const s = white[0] + white[1] + white[2], x = white[0] / s, y = white[1] / s;
      const q = (x - 0.332) / (0.1858 - y), T = 449 * q * q * q + 3525 * q * q + 6823.3 * q + 5520.33;
      if (cm1 && cm2 && cm1.length === 9 && cm2.length === 9) {
        const lo = Math.min(k1, k2), hi = Math.max(k1, k2), tc = Math.min(hi, Math.max(lo, T));
        const g = (1 / tc - 1 / k2) / (1 / k1 - 1 / k2);
        cm = cm1.map((v, i) => g * v + (1 - g) * cm2[i]);
      }
      let m = cm;
      if (ab && ab.length === 3) m = mul([ab[0], 0, 0, 0, ab[1], 0, 0, 0, ab[2]], cm);
      const w = mulV(inv(m), n);
      white = [w[0] / w[1], 1, w[2] / w[1]];
      cm = m;
    }
    const s = mulV(BRADFORD, white), d = mulV(BRADFORD, D65);
    const adapt = mul(inv(BRADFORD), mul([d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]], BRADFORD));
    let M = mul(XYZ_TO_SRGB, mul(adapt, mul(inv(cm), [n[0], 0, 0, 0, n[1], 0, 0, 0, n[2]])));
    // Normalize so a white balanced neutral maps to exactly (1,1,1).
    for (let r = 0; r < 3; r++) { const sum = M[r * 3] + M[r * 3 + 1] + M[r * 3 + 2]; for (let c = 0; c < 3; c++) M[r * 3 + c] /= sum; }
    const mx = Math.max(n[0], n[1], n[2]);
    return { wb: n.map(v => mx / v), camToSrgb: M };
  }

  // ---- DNG opcodes (lens corrections written by the camera) ----
  const GRID = 64;
  function readOpcodes(f, t, isCfa, Aw, Ah, st) {
    const bytes = f.val(t);
    if (!bytes || bytes.length < 4) return;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = dv.getUint32(0);
    let o = 4;
    for (let k = 0; k < count && o + 16 <= bytes.length; k++) {
      const id = dv.getUint32(o), size = dv.getUint32(o + 12), d = o + 16;
      o = d + size;
      if (o > bytes.length) break;
      if (id === 9) {
        const top = dv.getUint32(d), left = dv.getUint32(d + 4), bottom = dv.getUint32(d + 8), right = dv.getUint32(d + 12);
        const plane = dv.getUint32(d + 16), planes = dv.getUint32(d + 20), rp = dv.getUint32(d + 24), cp = dv.getUint32(d + 28);
        const mv = dv.getUint32(d + 32), mh = dv.getUint32(d + 36);
        const sv = dv.getFloat64(d + 40), sh = dv.getFloat64(d + 48), ov = dv.getFloat64(d + 56), oh = dv.getFloat64(d + 64);
        const mp = dv.getUint32(d + 72);
        if (!mv || !mh || !mp || 76 + mv * mh * mp * 4 > size) continue;
        const g = isCfa ? (st.gain2 = st.gain2 || new Float32Array(GRID * GRID * 4).fill(1)) : (st.gain3 = st.gain3 || new Float32Array(GRID * GRID * 4).fill(1));
        for (let ch = 0; ch < (isCfa ? 4 : 3); ch++) {
          let mpi = 0;
          if (isCfa) {
            if (plane !== 0) continue;
            if (rp > 1 && ((ch >> 1) - top) % 2 !== 0) continue;
            if (cp > 1 && ((ch & 1) - left) % 2 !== 0) continue;
          } else {
            if (ch < plane || ch >= plane + planes) continue;
            mpi = Math.min(ch - plane, mp - 1);
          }
          for (let gy = 0; gy < GRID; gy++) {
            const v = (gy + 0.5) / GRID;
            if (v * Ah < top || v * Ah >= bottom) continue;
            const fi = Math.min(mv - 1, Math.max(0, sv > 0 ? (v - ov) / sv : 0)), i0 = Math.min(mv - 2 < 0 ? 0 : mv - 2, Math.floor(fi)), wi = fi - i0, i1 = Math.min(mv - 1, i0 + 1);
            for (let gx = 0; gx < GRID; gx++) {
              const u = (gx + 0.5) / GRID;
              if (u * Aw < left || u * Aw >= right) continue;
              const fj = Math.min(mh - 1, Math.max(0, sh > 0 ? (u - oh) / sh : 0)), j0 = Math.min(mh - 2 < 0 ? 0 : mh - 2, Math.floor(fj)), wj = fj - j0, j1 = Math.min(mh - 1, j0 + 1);
              const at = (i, j) => dv.getFloat32(d + 76 + ((i * mh + j) * mp + mpi) * 4);
              const val = (at(i0, j0) * (1 - wj) + at(i0, j1) * wj) * (1 - wi) + (at(i1, j0) * (1 - wj) + at(i1, j1) * wj) * wi;
              g[(gy * GRID + gx) * 4 + ch] *= val;
            }
          }
        }
      } else if (id === 1 && !isCfa) {
        const N = dv.getUint32(d);
        if ((N !== 1 && N !== 3) || 4 + (6 * N + 2) * 8 > size) continue;
        const k6 = [];
        for (let pl = 0; pl < 3; pl++) for (let i = 0; i < 6; i++) k6.push(dv.getFloat64(d + 4 + (Math.min(pl, N - 1) * 6 + i) * 8));
        st.warp = { k: k6, cx: dv.getFloat64(d + 4 + 6 * N * 8), cy: dv.getFloat64(d + 4 + (6 * N + 1) * 8) };
      } else if (id === 3 && !isCfa && size >= 56) {
        const kk = [];
        for (let i = 0; i < 5; i++) kk.push(dv.getFloat64(d + i * 8));
        st.vig = { k: kk, cx: dv.getFloat64(d + 40), cy: dv.getFloat64(d + 48) };
      }
    }
  }

  function decode(buf) {
    const f = open(buf), t0 = f.ifds[0];
    const meta = readMeta(f);
    let preview = null;
    try { preview = findPreview(f); } catch (e) { /* preview is optional */ }
    const raw = f.ifds.find(t => f.num(t[262]) === 32803 && !(f.num(t[254], 0) & 1)) || f.ifds.find(t => f.num(t[262]) === 32803);
    try {
      if (!raw) throw new Error('bu dosyada Bayer RAW verisi yok');
      const dim = f.val(raw[33421]);
      if (dim && (dim[0] !== 2 || dim[1] !== 2)) throw new Error('bu sensör düzeni desteklenmiyor');
      const px = decodePixels(f, raw);
      const pat = f.val(raw[33422]), pc = f.val(raw[50710]) || [0, 1, 2];
      const cfa = [0, 1, 2, 3].map(i => pc[pat[i]]);
      if (cfa.some(c => !(c >= 0 && c <= 2))) throw new Error('bu sensör düzeni desteklenmiyor');
      const bl = f.val(raw[50714]) || [0];
      const black = bl.length === 4 ? bl.slice() : [bl[0], bl[0], bl[0], bl[0]];
      const white = f.num(raw[50717], (1 << px.bps) - 1);
      const aa = f.val(raw[50829]) || [0, 0, px.H, px.W];
      const Aw = aa[3] - aa[1], Ah = aa[2] - aa[0];
      const co = f.val(raw[50719]) || [0, 0], cs = f.val(raw[50720]) || [Aw, Ah];
      const st = {};
      readOpcodes(f, raw[51009], true, Aw, Ah, st);
      readOpcodes(f, raw[51022], false, Aw, Ah, st);
      const col = colorSetup(f);
      return {
        kind: 'raw', width: px.W, height: px.H, raw: px.data, cfa, black, white,
        active: [aa[1], aa[0], Aw, Ah],
        crop: [Math.round(co[0]), Math.round(co[1]), Math.round(cs[0]), Math.round(cs[1])],
        orientation: f.num(raw[274], f.num(t0[274], 1)),
        wb: col.wb, camToSrgb: col.camToSrgb, baselineExposure: f.num(t0[50730], 0),
        gain2: st.gain2 || null, gain3: st.gain3 || null, gainGrid: GRID, warp: st.warp || null, vig: st.vig || null,
        meta, preview,
      };
    } catch (e) {
      if (!preview) throw e;
      return { kind: 'preview', preview, meta, warning: e.message };
    }
  }

  function previewOnly(buf) {
    const f = open(buf);
    return { preview: findPreview(f), meta: readMeta(f) };
  }

  function installWorker() {
    self.onmessage = async (e) => {
      const { id, cmd, file } = e.data;
      try {
        let res;
        if (cmd === 'preview') {
          try { res = previewOnly(await file.slice(0, 6 << 20).arrayBuffer()); if (!res.preview) throw 0; }
          catch (err) { res = previewOnly(await file.arrayBuffer()); }
        } else res = decode(await file.arrayBuffer());
        const tr = [];
        for (const k of ['raw', 'gain2', 'gain3', 'preview']) if (res[k]) tr.push(res[k].buffer);
        self.postMessage({ id, ok: true, res }, tr);
      } catch (err) {
        self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
      }
    };
  }

  return { decode, previewOnly, installWorker };
}

// Main thread helper: returns run(cmd, file) -> Promise.
function makeDngWorker() {
  const url = URL.createObjectURL(new Blob(['(' + dngCore.toString() + ')().installWorker();'], { type: 'text/javascript' }));
  const w = new Worker(url);
  const pending = new Map();
  let seq = 0;
  w.onmessage = (e) => {
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    if (e.data.ok) p.res(e.data.res); else p.rej(new Error(e.data.error));
  };
  return (cmd, file) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); w.postMessage({ id, cmd, file }); });
}

if (typeof module !== 'undefined') module.exports = dngCore();
