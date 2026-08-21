/**
 * QR encoder — byte mode, ECC level M, versions 1-20.
 *
 * Written from scratch so the app keeps working offline and from file://
 * with no CDN. Verified module-for-module against the `qrcode` reference
 * encoder for every version 1-20 and round-tripped through `jsqr`,
 * including 120 random payloads. See tests/qr.test.mjs.
 */
export interface QrResult {
  size: number;
  version: number;
  modules: number[][];
}

export function makeQR(text: string): QrResult {
    var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
    (function(){ var x=1; for (var i=0;i<255;i++){ EXP[i]=x; LOG[x]=i; x<<=1; if (x & 0x100) x^=0x11d; }
                 for (var i=255;i<512;i++) EXP[i]=EXP[i-255]; })();
    function gmul(a: number, b: number): number { return (a===0||b===0) ? 0 : EXP[LOG[a]+LOG[b]]; }

    // [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] for ECC level M, versions 1..20
    var SPEC = [
        [10,1,16,0,0],[16,1,28,0,0],[26,1,44,0,0],[18,2,32,0,0],[24,2,43,0,0],
        [16,4,27,0,0],[18,4,31,0,0],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44],
        [30,1,50,4,51],[22,6,36,2,37],[22,8,37,1,38],[24,4,40,5,41],[24,5,41,5,42],
        [28,7,45,3,46],[28,10,46,1,47],[26,9,43,4,44],[26,3,44,11,45],[26,3,41,13,42]
    ];
    var ALIGN = [
        [],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],
        [6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],
        [6,30,56,82],[6,30,58,86],[6,34,62,90]
    ];

    // UTF-8 bytes
    var bytes: number[] = [];
    for (var i=0;i<text.length;i++){
        var c = text.charCodeAt(i);
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) bytes.push(0xC0|(c>>6), 0x80|(c&63));
        else if (c >= 0xD800 && c <= 0xDBFF && i+1 < text.length) {
            var c2 = text.charCodeAt(++i);
            var cp = 0x10000 + ((c-0xD800)<<10) + (c2-0xDC00);
            bytes.push(0xF0|(cp>>18), 0x80|((cp>>12)&63), 0x80|((cp>>6)&63), 0x80|(cp&63));
        } else bytes.push(0xE0|(c>>12), 0x80|((c>>6)&63), 0x80|(c&63));
    }

    // pick smallest version that fits
    var ver = -1, spec: number[] | null = null, totalData = 0;
    for (var v=1; v<=20; v++){
        var s = SPEC[v-1];
        var td = s[1]*s[2] + s[3]*s[4];
        var lenBits = v <= 9 ? 8 : 16;
        if (4 + lenBits + bytes.length*8 <= td*8) { ver=v; spec=s; totalData=td; break; }
    }
    if (ver < 0) throw new Error('QR: payload too long (' + bytes.length + ' bytes)');

    // bit stream
    var bits: number[] = [];
    function put(val: number, n: number){ for (var i=n-1;i>=0;i--) bits.push((val>>i)&1); }
    put(4,4);
    put(bytes.length, ver <= 9 ? 8 : 16);
    for (var i=0;i<bytes.length;i++) put(bytes[i],8);
    var cap = totalData*8;
    for (var i=0;i<4 && bits.length<cap;i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    var data: number[] = [];
    for (var i=0;i<bits.length;i+=8){ var b=0; for (var j=0;j<8;j++) b=(b<<1)|bits[i+j]; data.push(b); }
    var pad = [0xEC,0x11], pi=0;
    while (data.length < totalData) data.push(pad[pi++ & 1]);

    // split into blocks, compute EC
    function rsGen(n: number): number[] {
        var poly: number[] = [1];
        for (var i=0;i<n;i++){
            var next: number[] = new Array(poly.length+1).fill(0);
            for (var j=0;j<poly.length;j++){ next[j] ^= poly[j]; next[j+1] ^= gmul(poly[j], EXP[i]); }
            poly = next;
        }
        return poly;
    }
    function rsEnc(block: number[], n: number): number[] {
        var gen = rsGen(n), res: number[] = new Array(block.length+n).fill(0);
        for (var i=0;i<block.length;i++) res[i]=block[i];
        for (var i=0;i<block.length;i++){
            var f = res[i];
            if (f) for (var j=0;j<gen.length;j++) res[i+j] ^= gmul(gen[j], f);
        }
        return res.slice(block.length);
    }
    var ecLen = spec![0], blocks: number[][] = [], ecs: number[][] = [], off = 0;
    for (var b=0;b<spec![1];b++){ var d=data.slice(off,off+spec![2]); off+=spec![2]; blocks.push(d); ecs.push(rsEnc(d,ecLen)); }
    for (var b=0;b<spec![3];b++){ var d=data.slice(off,off+spec![4]); off+=spec![4]; blocks.push(d); ecs.push(rsEnc(d,ecLen)); }

    // interleave
    var final: number[] = [], maxD = Math.max(spec![2], spec![4]);
    for (var i=0;i<maxD;i++) for (var b=0;b<blocks.length;b++) if (i < blocks[b].length) final.push(blocks[b][i]);
    for (var i=0;i<ecLen;i++) for (var b=0;b<ecs.length;b++) final.push(ecs[b][i]);

    // matrix
    var size = ver*4 + 17;
    var m: number[][] = [], reserved: number[][] = [];
    for (var r=0;r<size;r++){ m.push(new Array(size).fill(0)); reserved.push(new Array(size).fill(0)); }
    function setF(r: number, c: number, v: number){ m[r][c]=v; reserved[r][c]=1; }
    function finder(r: number, c: number){
        for (var i=-1;i<=7;i++) for (var j=-1;j<=7;j++){
            var rr=r+i, cc=c+j;
            if (rr<0||cc<0||rr>=size||cc>=size) continue;
            var on = (i>=0&&i<=6&&(j===0||j===6)) || (j>=0&&j<=6&&(i===0||i===6)) || (i>=2&&i<=4&&j>=2&&j<=4);
            setF(rr,cc,on?1:0);
        }
    }
    finder(0,0); finder(0,size-7); finder(size-7,0);
    for (var i=8;i<size-8;i++){ setF(6,i,i%2===0?1:0); setF(i,6,i%2===0?1:0); }
    var ap = ALIGN[ver-1];
    for (var a=0;a<ap.length;a++) for (var bb=0;bb<ap.length;bb++){
        // Only the three finder corners are skipped. A centre lying on the
        // timing row/column is legitimate and must still be drawn.
        var last = ap.length-1;
        if ((a===0&&bb===0) || (a===0&&bb===last) || (a===last&&bb===0)) continue;
        var r=ap[a], c=ap[bb];
        for (var i=-2;i<=2;i++) for (var j=-2;j<=2;j++)
            setF(r+i,c+j,(Math.abs(i)===2||Math.abs(j)===2||(i===0&&j===0))?1:0);
    }
    setF(size-8,8,1);                                  // dark module
    for (var i=0;i<9;i++){ if(!reserved[8][i]) setF(8,i,0); if(!reserved[i][8]) setF(i,8,0); }
    for (var i=0;i<8;i++){ if(!reserved[8][size-1-i]) setF(8,size-1-i,0); if(!reserved[size-1-i][8]) setF(size-1-i,8,0); }
    if (ver >= 7) for (var i=0;i<6;i++) for (var j=0;j<3;j++){ setF(size-11+j,i,0); setF(i,size-11+j,0); }

    // place data with zigzag
    var bitIdx = 0, dirUp = true;
    for (var col = size-1; col > 0; col -= 2) {
        if (col === 6) col--;
        for (var k=0;k<size;k++){
            var row = dirUp ? size-1-k : k;
            for (var t=0;t<2;t++){
                var c = col - t;
                if (reserved[row][c]) continue;
                var bit = 0;
                if (bitIdx < final.length*8) bit = (final[bitIdx>>3] >> (7-(bitIdx&7))) & 1;
                bitIdx++;
                m[row][c] = bit;
            }
        }
        dirUp = !dirUp;
    }

    function maskFn(n: number, r: number, c: number): boolean {
        switch(n){
            case 0: return (r+c)%2===0;
            case 1: return r%2===0;
            case 2: return c%3===0;
            case 3: return (r+c)%3===0;
            case 4: return (Math.floor(r/2)+Math.floor(c/3))%2===0;
            case 5: return ((r*c)%2)+((r*c)%3)===0;
            case 6: return (((r*c)%2)+((r*c)%3))%2===0;
            case 7: return (((r+c)%2)+((r*c)%3))%2===0;
            default: return false;   // masks are only ever 0-7
        }
    }
    function penalty(g: number[][]): number {
        var p=0, n=size;
        for (var r=0;r<n;r++){
            var run=1;
            for (var c=1;c<n;c++){ if (g[r][c]===g[r][c-1]) run++; else { if (run>=5) p+=3+(run-5); run=1; } }
            if (run>=5) p+=3+(run-5);
        }
        for (var c=0;c<n;c++){
            var run=1;
            for (var r=1;r<n;r++){ if (g[r][c]===g[r-1][c]) run++; else { if (run>=5) p+=3+(run-5); run=1; } }
            if (run>=5) p+=3+(run-5);
        }
        for (var r=0;r<n-1;r++) for (var c=0;c<n-1;c++)
            if (g[r][c]===g[r][c+1] && g[r][c]===g[r+1][c] && g[r][c]===g[r+1][c+1]) p+=3;
        var pat1=[1,0,1,1,1,0,1,0,0,0,0], pat2=[0,0,0,0,1,0,1,1,1,0,1];
        function match(arr: number[], pat: number[]): boolean { for (var i=0;i<11;i++) if (arr[i]!==pat[i]) return false; return true; }
        for (var r=0;r<n;r++) for (var c=0;c<=n-11;c++){
            var seg: number[] = []; for (var i=0;i<11;i++) seg.push(g[r][c+i]);
            if (match(seg,pat1)||match(seg,pat2)) p+=40;
        }
        for (var c=0;c<n;c++) for (var r=0;r<=n-11;r++){
            var seg: number[] = []; for (var i=0;i<11;i++) seg.push(g[r+i][c]);
            if (match(seg,pat1)||match(seg,pat2)) p+=40;
        }
        var dark=0; for (var r=0;r<n;r++) for (var c=0;c<n;c++) dark+=g[r][c];
        p += Math.floor(Math.abs(dark*100/(n*n)-50)/5)*10;
        return p;
    }
    function bch(data: number, gen: number, genBits: number): number {
        var d = data << (genBits-1);
        while (d.toString(2).length >= genBits) d ^= gen << (d.toString(2).length - genBits);
        return d;
    }
    function applyFormat(g: number[][], mask: number){
        var fmt = (0x00 << 3) | mask;                          // 00 = ECC level M
        var full = ((fmt << 10) | bch(fmt, 0x537, 11)) ^ 0x5412;
        for (var i=0;i<15;i++){
            var bit = (full >> (14 - i)) & 1;   // format bits are placed MSB first
            // copy 1, wrapping the top-left finder
            if (i < 6)        g[8][i]      = bit;
            else if (i === 6) g[8][7]      = bit;
            else if (i === 7) g[8][8]      = bit;
            else if (i === 8) g[7][8]      = bit;
            else              g[14-i][8]   = bit;
            // copy 2: 7 modules up the lower-left finder, then 8 across the
            // upper-right one. (8, size-8) belongs to this copy, not the
            // vertical run -- that slot is the dark module's neighbour.
            if (i < 7)        g[size-1-i][8]        = bit;
            else              g[8][size-8+(i-7)]    = bit;
        }
        g[size-8][8] = 1;
        if (ver >= 7) {
            var vfull = (ver << 12) | bch(ver, 0x1f25, 13);
            for (var i=0;i<18;i++){
                var bit = (vfull >> i) & 1;
                g[Math.floor(i/3)][size-11+(i%3)] = bit;
                g[size-11+(i%3)][Math.floor(i/3)] = bit;
            }
        }
    }
    var best: number[][] | null = null, bestP = Infinity;
    for (var mask=0; mask<8; mask++){
        var g = m.map(function(row: number[]){ return row.slice(); });
        for (var r=0;r<size;r++) for (var c=0;c<size;c++)
            if (!reserved[r][c] && maskFn(mask,r,c)) g[r][c] ^= 1;
        applyFormat(g, mask);
        var p = penalty(g);
        if (p < bestP){ bestP=p; best=g; }
    }
    return { size: size, version: ver, modules: best! };
}

/** Renders a QR as a standalone SVG string (crisp at any size, no canvas). */
export function qrToSvg(text: string, px: number): string {
  const qr = makeQR(text);
  const quiet = 4;
  const dim = qr.size + quiet * 2;
  let d = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${dim}" height="${dim}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
}
