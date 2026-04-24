// extract.js
// 自动找 claude 二进制 → 解析 Mach-O 找到 __BUN 段 → 抽 JS bundle。
// 不写死任何偏移，新版 claude 也能用。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const parser = require('@babel/parser');

// 更精确的 bundle 起点 magic（前 84 字节，足够区分 bundle 起点 vs. 元数据里的零散 "// @bun"）
const BUNDLE_HEAD = '// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {';

function findClaudeBinary(explicit, opts = {}) {
    if (explicit) {
        const r = path.resolve(explicit);
        if (!fs.existsSync(r)) throw new Error(`指定路径不存在: ${r}`);
        return r;
    }
    // 1. which claude → 取符号链接的真实文件
    let p;
    try {
        p = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    } catch {
        throw new Error('找不到 claude 命令，请先 npm i -g @anthropic-ai/claude-code');
    }
    let real = fs.realpathSync(p);
    if (!real.endsWith('.exe')) {
        const guess = path.join(path.dirname(real), 'claude.exe');
        if (fs.existsSync(guess)) real = guess;
    }
    // 默认优先用 .en.bak（如果存在），保证拿到干净英文 bundle，而不是已汉化的版本
    if (!opts.preferCurrent) {
        const bak = real + '.en.bak';
        if (fs.existsSync(bak)) {
            console.error(`[extract] 检测到备份，使用 ${path.basename(bak)} (干净英文版)`);
            return bak;
        }
    }
    return real;
}

function getMachoSegments(binPath) {
    const out = execFileSync('otool', ['-l', binPath], { encoding: 'utf8' });
    // otool 的 LC_SEGMENT_64 输出形如:
    //   Load command N
    //         cmd LC_SEGMENT_64
    //     cmdsize ...
    //     segname __BUN
    //      vmaddr ...
    //      vmsize ...
    //     fileoff 72138752
    //    filesize 132546560
    //
    const segments = {};
    const lines = out.split('\n');
    let cur = null;
    for (const line of lines) {
        const m = line.match(/^\s*segname\s+(\S+)/);
        if (m) { cur = { name: m[1] }; continue; }
        if (!cur) continue;
        const off = line.match(/^\s*fileoff\s+(\d+)/);
        if (off) cur.fileoff = parseInt(off[1], 10);
        const sz = line.match(/^\s*filesize\s+(\d+)/);
        if (sz) {
            cur.filesize = parseInt(sz[1], 10);
            // 段定义结束于 filesize 后；记录之
            if (!segments[cur.name]) segments[cur.name] = cur;
            cur = null;
        }
    }
    return segments;
}

// 在 segment 字节里找所有 bundle 副本，返回 [{ start, end, length }, ...]
// start/end 是相对 segment 起点的偏移
function findBundles(segBuf) {
    const text = segBuf.toString('binary'); // 1:1 字节映射
    const positions = [];
    let i = 0;
    while ((i = text.indexOf(BUNDLE_HEAD, i)) >= 0) {
        positions.push(i);
        i++;
    }
    if (positions.length === 0) throw new Error('在 __BUN 段中未找到 bundle 头 magic');

    // 大概长度上界（含尾部 padding/garbage）
    let approxBytes;
    if (positions.length >= 2) {
        const [p1, p2] = positions;
        let L = 1;
        const cap = Math.min(p2 - p1, segBuf.length - p1, segBuf.length - p2);
        while (L < cap && segBuf[p1 + L] === segBuf[p2 + L]) L++;
        approxBytes = L;
    } else {
        approxBytes = Math.min(30 * 1024 * 1024, segBuf.length - positions[0]);
    }

    // UTF-8 解码 + 截断 null 字节（Babel 不接受 \0）
    const candidateBuf = segBuf.slice(positions[0], positions[0] + approxBytes);
    let candidateStr = candidateBuf.toString('utf8');
    const nullIdx = candidateStr.indexOf('\0');
    if (nullIdx >= 0) candidateStr = candidateStr.slice(0, nullIdx);

    const prog = parser.parse(candidateStr, {
        sourceType: 'script', errorRecovery: true,
        allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
    });
    const stmt = prog.program.body.find(b => b.type === 'ExpressionStatement');
    if (!stmt) throw new Error('parse 找不到顶层 IIFE');

    // char 位置 → 字节位置（中文字符是 3 字节但 1 char）
    const bundleSource = candidateStr.slice(0, stmt.end);
    const bundleByteLen = Buffer.byteLength(bundleSource, 'utf8');

    // 以首份 bundle 字节作参照，逐 candidate 验证一致性，过滤误报
    const refBuf = segBuf.slice(positions[0], positions[0] + bundleByteLen);
    const real = [];
    for (const p of positions) {
        if (p + bundleByteLen > segBuf.length) continue;
        const chunk = segBuf.slice(p, p + bundleByteLen);
        if (chunk.equals(refBuf)) {
            real.push({ start: p, end: p + bundleByteLen, length: bundleByteLen });
        }
    }
    return { bundles: real, bundleSource };
}

function extract(explicit) {
    const bin = findClaudeBinary(explicit);
    console.error(`[extract] claude 二进制: ${bin}`);
    const segs = getMachoSegments(bin);
    if (!segs.__BUN) throw new Error('该二进制没有 __BUN 段，可能不是 Bun compile 产物');
    const { fileoff, filesize } = segs.__BUN;
    console.error(`[extract] __BUN 段: fileoff=${fileoff}, filesize=${filesize}`);

    // 只读 __BUN 那段，避免读 197MB
    const fd = fs.openSync(bin, 'r');
    const segBuf = Buffer.alloc(filesize);
    fs.readSync(fd, segBuf, 0, filesize, fileoff);
    fs.closeSync(fd);

    const { bundles, bundleSource } = findBundles(segBuf);
    if (bundles.length === 0) throw new Error('在 __BUN 段中找不到 JS bundle');
    console.error(`[extract] 在段内找到 ${bundles.length} 份 bundle:`);
    for (const b of bundles) {
        console.error(`  seg+${b.start} ~ seg+${b.end}  (${b.length} 字节)  filepos=${fileoff + b.start}`);
    }

    return {
        binPath: bin,
        segment: { fileoff, filesize },
        bundleLength: bundles[0].length,
        bundles: bundles.map(b => ({
            fileStart: fileoff + b.start,
            fileEnd: fileoff + b.end,
            length: b.length,
        })),
        bundleSource,
    };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const explicit = args[0];
    const outPath = args[1] || 'claude_bundle.js';
    const r = extract(explicit);
    fs.writeFileSync(outPath, r.bundleSource);
    console.error(`[extract] bundle 写入 -> ${outPath} (${r.bundleSource.length} 字节)`);
    console.error(`[extract] 二进制中 ${r.bundles.length} 份 bundle 全部一致 ✓`);
    // 输出 metadata 给后续 splice 用
    const meta = {
        binPath: r.binPath,
        segmentFileoff: r.segment.fileoff,
        segmentFilesize: r.segment.filesize,
        bundleLength: r.bundleLength,
        bundleFilePositions: r.bundles.map(b => b.fileStart),
    };
    fs.writeFileSync('extract_meta.json', JSON.stringify(meta, null, 2));
    console.error(`[extract] 元数据 -> extract_meta.json`);
}

module.exports = { findClaudeBinary, getMachoSegments, extract };
