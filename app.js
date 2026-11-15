// Renk: small RAW color grading tool. Part 1 is the WebGL2 engine, part 2 is the UI.
'use strict';
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- engine
const canvas = $('gl');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
if (!gl || !gl.getExtension('EXT_color_buffer_float')) {
  $('empty').textContent = 'Bu tarayıcı ya da ekran kartı WebGL2 desteklemiyor. Güncel Chrome veya Edge ile dene.';
  throw new Error('WebGL2 yok');
}
const T2 = gl.TEXTURE_2D, FB = gl.FRAMEBUFFER;
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const HEAD = '#version 300 es\nprecision highp float; precision highp int;\n';
function program(fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, HEAD + 'in vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }'], [gl.FRAGMENT_SHADER, HEAD + fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'p');
  gl.linkProgram(p);
  return p;
}
// Uniform values: number, texture, {i:[ints]}, {m:[9 row major]}, or float array (2..4 = vector, longer = float[]).
function draw(prog, u, fbo, w, h) {
  gl.bindFramebuffer(FB, fbo); gl.viewport(0, 0, w, h); gl.useProgram(prog);
  let unit = 0;
  for (const k in u) {
    const loc = gl.getUniformLocation(prog, k), v = u[k];
    if (loc === null) continue;
    if (v instanceof WebGLTexture) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(T2, v); gl.uniform1i(loc, unit++); }
    else if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (v.i) (v.i.length === 4 ? gl.uniform4iv(loc, v.i) : gl.uniform1iv(loc, v.i));
    else if (v.m) gl.uniformMatrix3fv(loc, true, v.m);
    else if (v.length === 2) gl.uniform2fv(loc, v);
    else if (v.length === 3) gl.uniform3fv(loc, v);
    else if (v.length === 4) gl.uniform4fv(loc, v);
    else gl.uniform1fv(loc, v);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
function tex(w, h, ifmt, fmt, type, data, filter) {
  const t = gl.createTexture();
  gl.bindTexture(T2, t);
  gl.texImage2D(T2, 0, ifmt, w, h, 0, fmt, type, data || null);
  gl.texParameteri(T2, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(T2, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(T2, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(T2, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
const ftex = (w, h, data) => tex(w, h, gl.RGBA16F, gl.RGBA, gl.FLOAT, data, gl.LINEAR);
function target(t) {
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(FB, f);
  gl.framebufferTexture2D(FB, gl.COLOR_ATTACHMENT0, T2, t, 0);
  return f;
}

// Bayer to white balanced camera RGB (Malvar, He, Cutler interpolation).
const P_DEMOSAIC = program(`
uniform highp usampler2D uRaw; uniform sampler2D uGain;
uniform vec2 uSize; uniform vec4 uActive, uBlack; uniform float uWhite; uniform vec3 uWb; uniform ivec4 uCfa;
out vec4 o; vec4 gain;
float px(ivec2 q) {
  ivec2 s = ivec2(uSize);
  if (q.x < 0) q.x = -q.x; if (q.y < 0) q.y = -q.y;
  if (q.x >= s.x) q.x = 2 * (s.x - 1) - q.x; if (q.y >= s.y) q.y = 2 * (s.y - 1) - q.y;
  int k = (q.y & 1) * 2 + (q.x & 1);
  float v = (float(texelFetch(uRaw, q, 0).r) - uBlack[k]) / (uWhite - uBlack[k]);
  return min(v * uWb[uCfa[k]], 1.) * gain[k];
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  gain = texture(uGain, (gl_FragCoord.xy - uActive.xy) / uActive.zw);
  float C = px(q), N = px(q + ivec2(0, -1)), S = px(q + ivec2(0, 1)), E = px(q + ivec2(1, 0)), W = px(q + ivec2(-1, 0));
  float D = px(q + ivec2(1, 1)) + px(q + ivec2(-1, 1)) + px(q + ivec2(1, -1)) + px(q + ivec2(-1, -1));
  float V2 = px(q + ivec2(0, -2)) + px(q + ivec2(0, 2)), H2 = px(q + ivec2(2, 0)) + px(q + ivec2(-2, 0));
  int c = uCfa[(q.y & 1) * 2 + (q.x & 1)];
  vec3 rgb;
  if (c == 1) {
    float h = (5. * C + 4. * (E + W) - D - H2 + .5 * V2) / 8., v = (5. * C + 4. * (N + S) - D - V2 + .5 * H2) / 8.;
    rgb = uCfa[(q.y & 1) * 2 + ((q.x + 1) & 1)] == 0 ? vec3(h, C, v) : vec3(v, C, h);
  } else {
    float g = (4. * C + 2. * (N + S + E + W) - V2 - H2) / 8., x = (6. * C + 2. * D - 1.5 * (V2 + H2)) / 8.;
    rgb = c == 0 ? vec3(C, g, x) : vec3(x, g, C);
  }
  o = vec4(rgb, 1.);
}`);

// Camera RGB to linear sRGB: crop, rotate, lens corrections stored in the DNG, color matrix.
const P_DEVELOP = program(`
uniform sampler2D uCam, uGain3;
uniform vec2 uRawSize, uOut, uWarpC, uVigC; uniform vec4 uActive, uCrop; uniform int uOrient;
uniform float uWarp[18], uVig[5], uM; uniform mat3 uMat;
out vec4 o;
void main() {
  vec2 f = gl_FragCoord.xy, c = f;
  if (uOrient == 3) c = uCrop.zw - f;
  else if (uOrient == 6) c = vec2(f.y, uCrop.w - f.x);
  else if (uOrient == 8) c = vec2(uCrop.z - f.y, f.x);
  vec2 a = c + uCrop.xy, d = (a - uWarpC) / uM;
  float r2 = dot(d, d);
  vec3 cam;
  for (int k = 0; k < 3; k++) {
    float w = uWarp[k * 6] + r2 * (uWarp[k * 6 + 1] + r2 * (uWarp[k * 6 + 2] + r2 * uWarp[k * 6 + 3]));
    float t0 = uWarp[k * 6 + 4], t1 = uWarp[k * 6 + 5];
    vec2 t = vec2(t0 * 2. * d.x * d.y + t1 * (r2 + 2. * d.x * d.x), t1 * 2. * d.x * d.y + t0 * (r2 + 2. * d.y * d.y));
    cam[k] = texture(uCam, (uWarpC + uM * (w * d + t) + uActive.xy) / uRawSize)[k];
  }
  vec2 dv = (a - uVigC) / uM; float v2 = dot(dv, dv);
  cam *= 1. + v2 * (uVig[0] + v2 * (uVig[1] + v2 * (uVig[2] + v2 * (uVig[3] + v2 * uVig[4]))));
  cam *= texture(uGain3, a / uActive.zw).rgb;
  o = vec4(uMat * cam, 1.);
}`);

const P_IMAGE = program(`
uniform sampler2D uImg; uniform vec2 uOut; out vec4 o;
void main() { vec3 c = texture(uImg, gl_FragCoord.xy / uOut).rgb; o = vec4(mix(c / 12.92, pow((c + .055) / 1.055, vec3(2.4)), step(.04045, c)), 1.); }`);

const P_COPY = program(`
uniform sampler2D uImg; uniform vec2 uOut; uniform float uLog; out vec4 o;
void main() { vec4 c = texture(uImg, gl_FragCoord.xy / uOut); o = uLog > 0. ? vec4(log2(max(dot(c.rgb, vec3(.2126, .7152, .0722)), 1e-4))) : c; }`);

const P_BLUR = program(`
uniform sampler2D uImg; uniform vec2 uStep; uniform vec2 uOut; out vec4 o;
void main() { vec4 s = vec4(0.); float n = 0.;
  for (int i = -12; i <= 12; i++) { float w = exp(-float(i * i) / 50.); s += w * texture(uImg, (gl_FragCoord.xy + float(i) * uStep) / uOut); n += w; }
  o = s / n; }`);

// The actual color grade. Everything up to the tone curve works in linear light.
const P_GRADE = program(`
uniform sampler2D uImg, uBlur; uniform vec2 uImgSize; uniform vec4 uMap;
uniform float uExposure, uContrast, uHighlights, uShadows, uSat, uVib, uFade, uSharp;
uniform vec3 uWb, uShTint, uHiTint;
out vec4 o;
float luma(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
void main() {
  vec2 p = vec2(uMap.x * gl_FragCoord.x + uMap.y, uMap.z * gl_FragCoord.y + uMap.w);
  if (p.x < 0. || p.y < 0. || p.x > uImgSize.x || p.y > uImgSize.y) { o = vec4(.067, .067, .067, 1.); return; }
  vec2 uv = p / uImgSize, e = 1. / uImgSize;
  vec3 c = texture(uImg, uv).rgb;
  if (uSharp > 0.) {
    vec3 n = .25 * (texture(uImg, uv + vec2(e.x, 0.)).rgb + texture(uImg, uv - vec2(e.x, 0.)).rgb + texture(uImg, uv + vec2(0., e.y)).rgb + texture(uImg, uv - vec2(0., e.y)).rgb);
    float s = sqrt(max(luma(c), 0.)), s2 = max(s + uSharp * (s - sqrt(max(luma(n), 0.))), 0.);
    c *= clamp(s2 * s2 / max(s * s, 1e-6), .25, 4.);
  }
  c = max(c, 0.) * uWb * exp2(uExposure);
  float l = exp2(mix(texture(uBlur, uv).r + uExposure, log2(max(luma(c), 1e-5)), .3)), t = l / (l + .18);
  c *= exp2(2. * (uShadows * smoothstep(.5, 0., t) + uHighlights * smoothstep(.5, 1., t)));
  c = .18 * pow(c / .18, vec3(uContrast));
  c = mix(c, .6 + .4 * (1. - exp(-(c - .6) / .4)), step(.6, c));
  c = mix(12.92 * c, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c));
  float y = luma(c), mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  c = y + (c - y) * uSat * (1. + uVib * (1. - (mx > 0. ? (mx - mn) / mx : 0.)));
  c += uShTint * (1. - y) * (1. - y) + uHiTint * y * y;
  c = uFade + c * (1. - uFade);
  float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - .5;
  o = vec4(clamp(c + dn / 255., 0., 1.), 1.);
}`);

let img = null; // { tex, w, h, blur }
function develop(d) {
  if (img) { gl.deleteTexture(img.tex); gl.deleteTexture(img.blur); img = null; }
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE), tmp = [];
  let w, h, dev;
  if (d.kind === 'raw') {
    const W = d.width, H = d.height, G = d.gainGrid, one = new Float32Array([1, 1, 1, 1]);
    const swap = d.orientation >= 5;
    w = swap ? d.crop[3] : d.crop[2]; h = swap ? d.crop[2] : d.crop[3];
    if (Math.max(W, H) > max) throw new Error('fotoğraf bu ekran kartı için fazla büyük');
    const rawT = tex(W, H, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, d.raw, gl.NEAREST);
    const g2 = d.gain2 ? ftex(G, G, d.gain2) : ftex(1, 1, one), g3 = d.gain3 ? ftex(G, G, d.gain3) : ftex(1, 1, one);
    const cam = ftex(W, H);
    tmp.push(rawT, g2, g3, cam);
    draw(P_DEMOSAIC, { uRaw: rawT, uGain: g2, uSize: [W, H], uActive: d.active, uBlack: d.black, uWhite: d.white, uWb: d.wb, uCfa: { i: d.cfa } }, target(cam), W, H);
    const A = d.active, wp = d.warp || { k: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], cx: .5, cy: .5 }, vg = d.vig || { k: [0, 0, 0, 0, 0], cx: .5, cy: .5 };
    const cx = wp.cx * A[2], cy = wp.cy * A[3];
    dev = ftex(w, h);
    draw(P_DEVELOP, {
      uCam: cam, uGain3: g3, uRawSize: [W, H], uOut: [w, h], uActive: A, uCrop: d.crop, uOrient: { i: [d.orientation] },
      uWarp: wp.k, uWarpC: [cx, cy], uM: Math.hypot(Math.max(cx, A[2] - cx), Math.max(cy, A[3] - cy)),
      uVig: vg.k, uVigC: [vg.cx * A[2], vg.cy * A[3]], uMat: { m: d.camToSrgb },
    }, target(dev), w, h);
  } else {
    w = d.bitmap.width; h = d.bitmap.height;
    if (Math.max(w, h) > max) throw new Error('fotoğraf bu ekran kartı için fazla büyük');
    const src = gl.createTexture();
    gl.bindTexture(T2, src);
    gl.texImage2D(T2, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, d.bitmap);
    gl.texParameteri(T2, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(T2, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(T2, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    tmp.push(src);
    dev = ftex(w, h);
    draw(P_IMAGE, { uImg: src, uOut: [w, h] }, target(dev), w, h);
  }
  gl.bindTexture(T2, dev);
  gl.generateMipmap(T2);
  gl.texParameteri(T2, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  // Blurred log luminance, used so shadows and highlights move without flattening detail.
  const k = 256 / Math.max(w, h), bw = Math.max(1, Math.round(w * k)), bh = Math.max(1, Math.round(h * k));
  const a = ftex(bw, bh), b = ftex(bw, bh), fa = target(a), fb = target(b);
  draw(P_COPY, { uImg: dev, uOut: [bw, bh], uLog: 1 }, fa, bw, bh);
  draw(P_BLUR, { uImg: a, uOut: [bw, bh], uStep: [1, 0] }, fb, bw, bh);
  draw(P_BLUR, { uImg: b, uOut: [bw, bh], uStep: [0, 1] }, fa, bw, bh);
  tmp.push(b);
  tmp.forEach(t => gl.deleteTexture(t));
  img = { tex: dev, w, h, blur: a };
}

function grade(u, map, fbo, w, h, sharp) {
  draw(P_GRADE, Object.assign({ uImg: img.tex, uBlur: img.blur, uImgSize: [img.w, img.h], uMap: map, uSharp: sharp }, u), fbo, w, h);
}
// Full resolution graded pixels, top row first.
function renderPixels(u) {
  const t = tex(img.w, img.h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.NEAREST), f = target(t);
  grade(u, [1, 0, 1, 0], f, img.w, img.h, SHARP);
  const px = new Uint8ClampedArray(img.w * img.h * 4);
  gl.readPixels(0, 0, img.w, img.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.deleteFramebuffer(f); gl.deleteTexture(t);
  return px;
}
// 64x64 linear samples of the developed photo, for the Otomatik button.
function sample() {
  const t = ftex(64, 64), f = target(t), px = new Float32Array(64 * 64 * 4);
  draw(P_COPY, { uImg: img.tex, uOut: [64, 64], uLog: 0 }, f, 64, 64);
  gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.FLOAT, px);
  gl.deleteFramebuffer(f); gl.deleteTexture(t);
  return px;
}

// ---------------------------------------------------------------- looks and settings
const SHARP = 0.5, BASE_CONTRAST = 1.12, RAW_SAT = 1.15; // RAW files come out flatter than camera JPEGs
// Values are in slider units. sh / hi = [hue in degrees, amount] tint for shadows / highlights.
const LOOKS = {
  none: { name: 'Orijinal' },
  natural: { name: 'Doğal', contrast: .1, vibrance: .15, shadows: .1, highlights: -.1 },
  portrait: { name: 'Sıcak portre', temp: .1, contrast: .05, shadows: .2, highlights: -.2, vibrance: .1, hi: [35, .02] },
  golden: { name: 'Altın saat', temp: .22, vibrance: .2, contrast: .1, highlights: -.15, hi: [40, .04], sh: [25, .015] },
  cinema: { name: 'Sinematik', contrast: .18, saturation: -.08, highlights: -.2, shadows: .05, fade: .15, sh: [195, .05], hi: [35, .04] },
  film: { name: 'Film', fade: .45, contrast: .05, saturation: -.12, temp: .05, highlights: -.25, sh: [170, .025], hi: [45, .035] },
  airy: { name: 'Ferah', exposure: .25, shadows: .35, highlights: -.1, contrast: -.08, temp: -.04, vibrance: .1, fade: .1 },
  vivid: { name: 'Canlı', contrast: .15, vibrance: .45, saturation: .06 },
  cool: { name: 'Serin', temp: -.18, contrast: .08, saturation: -.05, sh: [215, .04] },
  bw: { name: 'Siyah beyaz', saturation: -1, contrast: .2, fade: .1 },
};
const SLIDERS = [
  ['strength', 'Görünüm gücü', 0, 1], ['exposure', 'Pozlama', -3, 3], ['contrast', 'Kontrast', -1, 1],
  ['highlights', 'Parlak alanlar', -1, 1], ['shadows', 'Gölgeler', -1, 1],
  ['temp', 'Sıcaklık', -1, 1], ['tint', 'Ton', -1, 1], ['vibrance', 'Canlılık', -1, 1],
];
const DEFAULTS = { look: 'none', strength: 1, exposure: 0, contrast: 0, highlights: 0, shadows: 0, temp: 0, tint: 0, vibrance: 0 };

function tintVec(t, k) {
  if (!t) return [0, 0, 0];
  const f = (n) => { const x = (n + t[0] / 60) % 6; return 1 - Math.max(0, Math.min(x, 4 - x, 1)); };
  const c = [f(5), f(3), f(1)], y = .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
  return c.map(v => (v - y) * t[1] * k);
}
// Settings + look -> shader uniforms. baseEV is the exposure the camera asks for (DNG BaselineExposure).
function uniforms(s, ph) {
  const baseEV = ph.base, sat0 = ph.raw ? RAW_SAT : 1;
  const L = LOOKS[s.look] || LOOKS.none, k = s.strength;
  const g = (n) => (L[n] || 0) * k + (s[n] || 0);
  const temp = g('temp'), tint = g('tint');
  const wb = [2 ** (.75 * temp + .3 * tint), 2 ** (-.45 * tint), 2 ** (-.75 * temp + .3 * tint)];
  const n = .2126 * wb[0] + .7152 * wb[1] + .0722 * wb[2];
  return {
    uExposure: baseEV + g('exposure'), uContrast: BASE_CONTRAST * 1.6 ** g('contrast'),
    uHighlights: g('highlights'), uShadows: g('shadows'), uWb: wb.map(v => v / n),
    uSat: sat0 * Math.max(0, 1 + g('saturation')), uVib: g('vibrance'), uFade: .12 * (L.fade || 0) * k,
    uShTint: tintVec(L.sh, k), uHiTint: tintVec(L.hi, k),
  };
}

// ---------------------------------------------------------------- UI
const runDng = makeDngWorker();
const photos = []; // { file, raw, key, s, base, thumb }
let cur = -1, loadSeq = 0, split = 0.5, compare = false, hold = false, dirty = false;
const view = { fit: true, s: 1, x: 0, y: 0 };
const saved = JSON.parse(localStorage.getItem('renk') || '{}');
const status = (t) => { $('status').textContent = t || ''; };
const S = () => photos[cur].s;

function paint() {
  dirty = false;
  const dpr = devicePixelRatio || 1, cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  gl.bindFramebuffer(FB, null); gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(.067, .067, .067, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  if (!img || cur < 0) return;
  if (view.fit) { view.s = Math.min(cw / img.w, ch / img.h) * .97; view.x = (cw - img.w * view.s) / 2; view.y = (ch - img.h * view.s) / 2; }
  const map = [1 / view.s, -view.x / view.s, -1 / view.s, (ch - view.y) / view.s];
  const sharp = SHARP * Math.max(0, Math.min(1, view.s * 2 - 1));
  const after = uniforms(S(), photos[cur]), before = uniforms(DEFAULTS, photos[cur]);
  if (hold) grade(before, map, null, cw, ch, sharp);
  else if (compare) {
    const sx = Math.round(split * cw);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, sx, ch); grade(before, map, null, cw, ch, sharp);
    gl.scissor(sx, 0, cw - sx, ch); grade(after, map, null, cw, ch, sharp);
    gl.disable(gl.SCISSOR_TEST);
  } else grade(after, map, null, cw, ch, sharp);
}
function redraw() { if (!dirty) { dirty = true; requestAnimationFrame(paint); } }

function syncPanel() {
  const has = cur >= 0, s = has ? S() : DEFAULTS;
  for (const [id, , , hi] of SLIDERS) {
    $('s_' + id).value = s[id];
    $('v_' + id).textContent = id === 'exposure' ? (s[id] > 0 ? '+' : '') + s[id].toFixed(2) : Math.round(s[id] * 100 / hi);
  }
  for (const b of $('looks').children) b.classList.toggle('on', b.dataset.id === s.look);
  for (const im of $('strip').children) im.classList.toggle('on', +im.dataset.i === cur);
  $('exp').disabled = $('expAll').disabled = !has;
  $('empty').style.display = has ? 'none' : '';
  $('split').style.display = has && compare ? 'block' : 'none';
  $('split').style.left = split * 100 + '%';
  $('cmp').classList.toggle('on', compare);
}
function changed() {
  if (cur < 0) return;
  saved[photos[cur].key] = S();
  localStorage.setItem('renk', JSON.stringify(saved));
  syncPanel(); redraw();
}

for (const id in LOOKS) {
  const b = document.createElement('button');
  b.textContent = LOOKS[id].name; b.dataset.id = id;
  b.onclick = () => { if (cur >= 0) { S().look = id; changed(); } };
  $('looks').append(b);
}
for (const [id, label, lo, hi] of SLIDERS) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<div><label>${label}</label><span id="v_${id}"></span></div><input id="s_${id}" type="range" min="${lo}" max="${hi}" step="0.01" value="${DEFAULTS[id]}">`;
  $('sliders').append(row);
  if (id === 'strength') $('sliders').insertAdjacentHTML('beforeend', '<h3>Ayarlar</h3>');
  row.querySelector('input').oninput = (e) => { if (cur >= 0) { S()[id] = +e.target.value; changed(); } };
  row.querySelector('label').ondblclick = () => { if (cur >= 0) { S()[id] = DEFAULTS[id]; changed(); } };
}

async function addFiles(list) {
  const files = [...list].filter(f => /\.(dng|jpe?g|png|webp)$/i.test(f.name));
  if (!files.length) return;
  const first = photos.length;
  for (const file of files) {
    const key = file.name + '|' + file.size, i = photos.length;
    const ph = { file, raw: /\.dng$/i.test(file.name), key, s: Object.assign({}, DEFAULTS, saved[key]), base: 0 };
    photos.push(ph);
    const im = document.createElement('img');
    im.dataset.i = i; im.title = file.name; im.onclick = () => select(i);
    $('strip').append(im);
    if (!ph.raw) im.src = URL.createObjectURL(file);
    else runDng('preview', file).then(r => { if (r.preview) im.src = URL.createObjectURL(new Blob([r.preview], { type: 'image/jpeg' })); }).catch(() => {});
  }
  await select(first);
}

async function select(i) {
  if (i < 0 || i >= photos.length) return;
  const seq = ++loadSeq, ph = photos[i];
  status(ph.file.name + ' açılıyor…');
  try {
    let d = ph.raw ? await runDng('decode', ph.file) : { kind: 'img' }, note = '';
    if (d.kind === 'preview') { note = ' (RAW okunamadı: ' + d.warning + '. Küçük önizleme gösteriliyor)'; d = { kind: 'img', blob: new Blob([d.preview]), meta: d.meta }; }
    if (d.kind === 'img') d.bitmap = await createImageBitmap(d.blob || ph.file);
    if (seq !== loadSeq) return;
    develop(d);
    ph.base = d.baselineExposure || 0;
    cur = i; view.fit = true;
    const m = d.meta || {};
    status([ph.file.name, img.w + ' × ' + img.h, m.iso && 'ISO ' + m.iso, m.shutter && (m.shutter < 1 ? '1/' + Math.round(1 / m.shutter) : m.shutter) + ' sn', m.aperture && 'f/' + m.aperture].filter(Boolean).join('  ·  ') + note);
  } catch (e) {
    if (seq === loadSeq) status(ph.file.name + ' açılamadı: ' + e.message);
    return;
  }
  syncPanel(); redraw();
}

function auto() {
  if (cur < 0) return;
  const px = sample(), ls = [];
  for (let i = 0; i < px.length; i += 4) ls.push(Math.max(1e-4, .2126 * px[i] + .7152 * px[i + 1] + .0722 * px[i + 2]));
  ls.sort((a, b) => a - b);
  const geo = Math.exp(ls.reduce((a, v) => a + Math.log(v), 0) / ls.length), p99 = ls[Math.floor(ls.length * .99)], p10 = ls[Math.floor(ls.length * .1)];
  const ev = Math.max(-2, Math.min(3.5, Math.min(Math.log2(.2 / geo), Math.log2(1.8 / p99)))), gain = 2 ** ev, s = S();
  s.exposure = Math.max(-3, Math.min(3, Math.round((ev - photos[cur].base) * 20) / 20));
  s.shadows = Math.round(Math.max(0, Math.min(.6, Math.log2(.05 / (p10 * gain)) / 3)) * 100) / 100;
  s.highlights = -Math.round(Math.max(0, Math.min(.6, (p99 * gain - .8) / 1.5 * .6)) * 100) / 100;
  changed();
}

async function exportCurrent() {
  const ph = photos[cur], c = document.createElement('canvas');
  c.width = img.w; c.height = img.h;
  c.getContext('2d').putImageData(new ImageData(renderPixels(uniforms(ph.s, ph)), img.w, img.h), 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .93));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = ph.file.name.replace(/\.[^.]+$/, '') + '_renk.jpg';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function exportAll() {
  for (let i = 0; i < photos.length; i++) {
    await select(i);
    if (cur !== i) continue;
    status((i + 1) + ' / ' + photos.length + ' dışa aktarılıyor…');
    await exportCurrent();
    await new Promise(r => setTimeout(r, 400));
  }
  status(photos.length + ' fotoğraf indirilenler klasörüne kaydedildi');
}

$('open').onclick = $('open2').onclick = () => $('file').click();
$('file').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
$('cmp').onclick = () => { compare = !compare; syncPanel(); redraw(); };
$('auto').onclick = auto;
$('reset').onclick = () => { if (cur >= 0) { photos[cur].s = Object.assign({}, DEFAULTS); changed(); } };
$('all').onclick = () => {
  if (cur < 0) return;
  for (const p of photos) { p.s = Object.assign({}, S()); saved[p.key] = p.s; }
  changed(); status('Ayarlar ' + photos.length + ' fotoğrafa uygulandı');
};
$('exp').onclick = () => exportCurrent().then(() => status('İndirilenler klasörüne kaydedildi'));
$('expAll').onclick = exportAll;

addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
addEventListener('dragleave', () => document.body.classList.remove('drag'));
addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drag'); addFiles(e.dataTransfer.files); });
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); if (!hold) { hold = true; redraw(); } }
  else if (e.key === 'ArrowRight') { e.preventDefault(); select(cur + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); select(cur - 1); }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') { hold = false; redraw(); } });
new ResizeObserver(redraw).observe(canvas);

// Split line drag, pan, zoom.
const dpr = () => devicePixelRatio || 1;
$('split').onpointerdown = (e) => { e.target.setPointerCapture(e.pointerId); $('split').onpointermove = (m) => { const r = canvas.getBoundingClientRect(); split = Math.max(0, Math.min(1, (m.clientX - r.left) / r.width)); syncPanel(); redraw(); }; };
$('split').onpointerup = () => { $('split').onpointermove = null; };
canvas.onpointerdown = (e) => { canvas.setPointerCapture(e.pointerId); canvas.onpointermove = (m) => { view.fit = false; view.x += m.movementX * dpr(); view.y += m.movementY * dpr(); redraw(); }; };
canvas.onpointerup = () => { canvas.onpointermove = null; };
function zoom(e, s) {
  const r = canvas.getBoundingClientRect(), px = (e.clientX - r.left) * dpr(), py = (e.clientY - r.top) * dpr();
  view.x = px - (px - view.x) * s / view.s; view.y = py - (py - view.y) * s / view.s; view.s = s; view.fit = false; redraw();
}
canvas.ondblclick = (e) => { if (view.fit) zoom(e, 1); else { view.fit = true; redraw(); } };
canvas.onwheel = (e) => { e.preventDefault(); if (img) zoom(e, Math.max(.05, Math.min(8, view.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))); };

syncPanel(); redraw();
