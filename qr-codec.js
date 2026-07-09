/* qr-codec.js — V1 QR payload codec for the QR Sub Viewer.
 * Dependency-free. Shared by the app (uses decodeV1) and make-qr.html (uses encodeV1 + parseCDT).
 *
 * V1 grammar (QR alphanumeric-safe: 0-9 A-Z space $ % * + - . / :  — NO lowercase, NO ';', NO '()'):
 *   V1 * S:W:H:D:NAME:ELF:REF * <ROLE>:X:Y:Z:W:H:D * ...
 *   - records joined by '*', fields by ':'
 *   - S = sub header (bounding box, sanitised design name, ELF I|O, element ref)
 *   - member X/Y are relative to the sub origin (drawing starts at 0,0); Z = through-wall offset
 *   - cut length + cross-section are re-derived by the renderer, never stored.
 */
(function (global) {
  'use strict';

  // Role code -> reconstruction label. Labels MUST contain the keywords studType()/parseCDT look for.
  var ROLE_LABEL = {
    K: 'KingStud', E: 'EndStudRight', S: 'Stud', J: 'JackStud',
    JO: 'JackOverOpening', JU: 'JackUnderSill',
    H: 'Header', L: 'Sill', B: 'Block',
    PB: 'BottomPlate', PT: 'TopPlate'
  };
  var VERTICAL = { K: 1, E: 1, S: 1, J: 1, JO: 1, JU: 1 };   // length = H (ST)
  var PLATE = { PB: 'BS', PT: 'TS' };                         // BS/TS tags
  // everything else horizontal (H, L, B) -> STL, length = W

  function roleOf(el) {
    if (el.type === 'plate') return el.subType === 'top' ? 'PT' : 'PB';
    if (el.type === 'header') return 'H';
    if (el.type === 'sill') return 'L';
    var l = (el.label || '').toLowerCase();            // stud family
    if (l.indexOf('block') >= 0) return 'B';
    if (l.indexOf('king') >= 0) return 'K';
    if (l.indexOf('jackov') >= 0) return 'JO';
    if (l.indexOf('jackund') >= 0) return 'JU';
    if (l.indexOf('jack') >= 0) return 'J';
    if (l.indexOf('left') >= 0 || l.indexOf('right') >= 0 || l.indexOf('end') >= 0) return 'E';
    return 'S';
  }

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function sanitizeName(name) {
    if (!name) return '';
    var s = String(name).trim();
    if (UUID_RE.test(s)) return '';                    // suppress UUID design names
    return s.toUpperCase().replace(/[()]/g, '')
      .replace(/[^0-9A-Z $%*+.\/-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  function sanitizeRef(ref) {
    if (!ref) return '';
    return String(ref).toUpperCase().replace(/[^0-9A-Z.\/-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  function R(n) { return Math.round(+n || 0); }

  /* Encode a parsed sub -> V1 string.
   * sub = { x, y, w, h, d, uuid, elements:[{type,subType,x,y,z,w,h,d,label}] }
   * opts = { name, elf:'I'|'O'|'INSIDE'|'OUTSIDE', ref }
   */
  function encodeV1(sub, opts) {
    opts = opts || {};
    var ox = sub.x || 0, oy = sub.y || 0;
    var name = sanitizeName(opts.name != null ? opts.name : sub.uuid);
    var elf = (opts.elf === 'O' || opts.elf === 'OUTSIDE') ? 'O' : 'I';
    var ref = sanitizeRef(opts.ref || '');
    var recs = ['S:' + R(sub.w) + ':' + R(sub.h) + ':' + R(sub.d) + ':' + name + ':' + elf + ':' + ref];
    (sub.elements || []).forEach(function (el) {
      if (el.type === 'sheet') return;
      var role = roleOf(el);
      recs.push(role + ':' + R(el.x - ox) + ':' + R(el.y - oy) + ':' + R(el.z) + ':' + R(el.w) + ':' + R(el.h) + ':' + R(el.d));
    });
    return 'V1*' + recs.join('*');
  }

  /* Decode a V1 string -> { W, H, D, name, elf, ref, cdt }.
   * `cdt` is a minimal .cdt reconstruction that the existing parseCDT() renders unchanged. */
  function decodeV1(str) {
    if (!str) throw new Error('empty code');
    var recs = String(str).trim().split('*');
    if (recs.shift() !== 'V1') throw new Error('not a V1 code');
    var s = (recs.shift() || '').split(':');
    if (s[0] !== 'S') throw new Error('missing sub header');
    var W = +s[1], H = +s[2], D = +s[3], name = s[4] || '', elf = s[5] || 'I', ref = s[6] || '';
    var lines = ['ELM:' + W + ':' + H + ':' + D];
    recs.forEach(function (r) {
      if (!r) return;
      var f = r.split(':'), role = f[0];
      var x = +f[1], y = +f[2], z = +f[3], w = +f[4], h = +f[5], d = +f[6];
      var label = ROLE_LABEL[role] || 'Stud';
      if (PLATE[role]) {
        lines.push(PLATE[role] + ':' + w + ':' + h + ':' + d + ':' + x + ':' + y + ':0:' + label + ':L=' + w + ':WxH=' + h + 'x' + d);
      } else if (VERTICAL[role]) {
        lines.push('ST:' + w + ':' + h + ':' + d + ':' + x + ':' + y + ':' + z + ':' + label + ':L=' + h + ':WxH=' + w + 'x' + d);
      } else { // H, L, B -> horizontal STL
        lines.push('STL:' + w + ':' + h + ':' + d + ':' + x + ':' + y + ':' + z + ':' + label + ':L=' + w + ':WxH=' + d + 'x' + h);
      }
    });
    return { W: W, H: H, D: D, name: name, elf: elf, ref: ref, cdt: lines.join('\n') };
  }

  /* parseCDT — copied verbatim from the app engine so make-qr.html can read .cdt files
   * without duplicating the whole renderer. Keep in sync with index.html's inline copy. */
  function parseCDT(text) {
    var fr = { W: 0, H: 0, D: 0, elements: [], openings: [], labels: [], nails: [], subs: [] };
    var inSub = null, robPts = [], robActive = false;
    function addEl(el) { (inSub ? inSub.elements : fr.elements).push(el); }
    function parseWxH(fields) { for (var i = 7; i < fields.length; i++) { var m = (fields[i] || '').match(/WxH=(\d+)x(\d+)/); if (m) return { cw: +m[1], cd: +m[2] }; } return null; }
    function parseL(fields) { for (var i = 7; i < fields.length; i++) { var m = (fields[i] || '').match(/L=(\d+)/); if (m) return +m[1]; } return null; }
    text.trim().split('\n').forEach(function (raw) {
      var line = raw.trim().replace(/;$/, ''); if (!line) return; var f = line.split(':'), tag = f[0];
      if (tag === 'ELM') { fr.W = +f[1]; fr.H = +f[2]; fr.D = +f[3] || 140; }
      else if (tag === 'BS' || tag === 'TS') { var wxh = parseWxH(f), ll = parseL(f); addEl({ type: 'plate', subType: tag === 'BS' ? 'bottom' : 'top', x: +f[4], y: +f[5], z: 0, w: +f[1], h: +f[2], d: +f[3], label: f[7] || tag, cw: wxh ? wxh.cw : +f[1], cd: wxh ? wxh.cd : +f[3], len: ll || +f[1] }); }
      else if (tag === 'ST') { var wxh2 = parseWxH(f), ll2 = parseL(f); addEl({ type: 'stud', x: +f[4], y: +f[5], z: +f[6] || 0, w: +f[1], h: +f[2], d: +f[3], label: f[7] || 'Stud', cw: wxh2 ? wxh2.cw : +f[1], cd: wxh2 ? wxh2.cd : +f[3], len: ll2 || +f[2] }); }
      else if (tag === 'STL') {
        var lb = f[7] || ''; var lbl = lb.toLowerCase(); var wxh3 = parseWxH(f), ll3 = parseL(f);
        if (lbl.indexOf('block') >= 0) { addEl({ type: 'stud', x: +f[4], y: +f[5], z: +f[6] || 0, w: +f[1], h: +f[2], d: +f[3], label: lb, cw: wxh3 ? wxh3.cw : +f[3], cd: wxh3 ? wxh3.cd : +f[2], len: ll3 || +f[1] }); }
        else { addEl({ type: lbl.indexOf('sill') >= 0 ? 'sill' : 'header', x: +f[4], y: +f[5], z: +f[6] || 0, w: +f[1], h: +f[2], d: +f[3], label: lb, cw: wxh3 ? wxh3.cw : +f[3], cd: wxh3 ? wxh3.cd : +f[2], len: ll3 || +f[1] }); }
      }
      else if (tag.indexOf('BOI') === 0 || tag.indexOf('BOO') === 0) addEl({ type: 'sheet', subType: tag, x: +f[4], y: +f[5], z: 0, w: +f[1], h: +f[2], d: +f[3], label: f[8] || tag, cw: 0, cd: 0, len: 0 });
      else if (tag === 'SUB') inSub = { x: +f[4], y: +f[5], z: 0, w: +f[1], h: +f[2], d: +f[3], elements: [], openings: [], uuid: f[7] };
      else if (tag === 'SUE') { if (inSub) { fr.subs.push(inSub); inSub = null; } }
      else if (tag === 'ROB') { robActive = true; robPts = [{ x: +f[1], y: +f[2] }]; }
      else if (tag === 'RL' && robActive) robPts.push({ x: +f[1], y: +f[2] });
      else if (tag === 'ROE') { if (robPts.length >= 3) (inSub ? inSub.openings : fr.openings).push(robPts.slice()); robPts = []; robActive = false; }
      else if (tag === 'FST') fr.nails.push({ x1: +f[1], y1: +f[2], z1: +f[3], x2: +f[4], y2: +f[5], z2: +f[6] });
      else if (tag === 'INK') fr.labels.push({ x: +f[1], y: +f[2], z: 0, text: f[4] || '' });
    });
    return fr;
  }

  var api = { encodeV1: encodeV1, decodeV1: decodeV1, roleOf: roleOf, parseCDT: parseCDT, ROLE_LABEL: ROLE_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.QRCodec = api;
  if (!global.parseCDT) global.parseCDT = parseCDT;
})(typeof window !== 'undefined' ? window : this);
