// splice.js
// 把修改过的 bundle 拼回 claude.exe 的所有 bundle 位置（自动检测）。
// 步骤：
//   1. 自动找 claude 二进制路径
//   2. 在二进制里自动定位所有 bundle 副本（重用 extract 的 Mach-O + magic 扫描）
//   3. 备份原文件（.en.bak）
//   4. 把新 bundle 用空格右补齐到原 bundle 字节长度
//   5. splice 到所有副本位置
//   6. macOS: codesign --force --sign - 重新 ad-hoc 签名
//   7. 烟测 claude --version
//
// 安全：写入用临时文件 + os.replace 原子替换；任一步失败立即中止。

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { findClaudeBinary, getMachoSegments, extract } = require('./extract');

function splice(modifiedBundlePath, opts = {}) {
    // 1. 找 claude 二进制（用户实际运行的，非 .en.bak）
    const binPath = opts.binPath || findClaudeBinary(null, { preferCurrent: true });
    console.error(`[splice] 目标二进制: ${binPath}`);

    if (binPath.endsWith('.en.bak')) {
        throw new Error('不能 splice 到 .en.bak 备份本身');
    }

    // 2. 自动定位 bundle 位置：从 .en.bak（如果有）或 binPath 拿
    //    注：extract 默认从 .en.bak 读，避免 bundle 已经是中文版导致定位偏移。
    //    但 splice 操作的是 binPath（可能是已汉化版），所以我们要先确认 binPath 里
    //    的 bundle 位置和 .en.bak 一致（理论必须一致 —— 总文件大小不变）。
    const meta = extract();   // 默认从备份提取，得到段/bundle 位置
    const positions = meta.bundles.map(b => b.fileStart);
    const bundleLen = meta.bundleLength;
    console.error(`[splice] bundle 位置: [${positions.join(', ')}], 长度: ${bundleLen}`);

    // 3. 准备新 bundle，补齐
    const newBundle = fs.readFileSync(modifiedBundlePath);
    if (newBundle.length > bundleLen) {
        throw new Error(`新 bundle (${newBundle.length}) 比原 bundle (${bundleLen}) 长，无法 splice`);
    }
    const padN = bundleLen - newBundle.length;
    const padded = Buffer.concat([newBundle, Buffer.alloc(padN, 0x20)]);  // 空格补齐
    if (padded.length !== bundleLen) throw new Error('补齐后长度异常');
    console.error(`[splice] 新 bundle: ${newBundle.length} 字节，补齐 ${padN} 字节空格 -> ${padded.length}`);

    // 4. 备份（首次创建）
    const backup = binPath + '.en.bak';
    if (!fs.existsSync(backup)) {
        fs.copyFileSync(binPath, backup);
        console.error(`[splice] 已备份 -> ${path.basename(backup)}`);
    } else {
        console.error(`[splice] 备份已存在，跳过`);
    }

    // 5. 读 binPath 字节，校验 bundle 头 magic
    const data = Buffer.from(fs.readFileSync(binPath));
    const origSize = data.length;
    const HEAD = '// @bun ';
    for (const off of positions) {
        const head = data.slice(off, off + HEAD.length).toString('utf8');
        if (head !== HEAD) {
            throw new Error(`offset ${off} 处不像 bundle 起点（实际: ${JSON.stringify(head)}）`);
        }
    }
    console.error(`[splice] ${positions.length} 处 bundle 起点 magic 校验通过`);

    // 6. 写入所有位置
    for (const off of positions) {
        padded.copy(data, off);
    }
    if (data.length !== origSize) throw new Error(`splice 后总长度变了`);

    // 7. 原子替换
    const tmp = binPath + '.tmp';
    fs.writeFileSync(tmp, data);
    try {
        fs.chmodSync(tmp, fs.statSync(binPath).mode);
    } catch {}
    fs.renameSync(tmp, binPath);
    console.error(`[splice] 已写回 ${path.basename(binPath)} (大小 ${data.length})`);

    // 8. 再读一遍验证
    const after = fs.readFileSync(binPath);
    if (after.length !== origSize) throw new Error('写盘后大小不对');
    for (const off of positions) {
        if (!after.slice(off, off + bundleLen).equals(padded)) {
            throw new Error(`offset ${off} 写后不一致`);
        }
    }
    console.error(`[splice] 写盘校验通过`);

    // 9. macOS 重新 ad-hoc 签名
    if (process.platform === 'darwin') {
        const r = spawnSync('codesign', ['--force', '--sign', '-', binPath], { encoding: 'utf8' });
        if (r.status !== 0) {
            throw new Error(`codesign 失败: ${r.stderr}`);
        }
        console.error(`[splice] codesign 重签 OK`);
    }

    // 10. 烟测
    const v = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (v.status !== 0) {
        throw new Error(`烟测失败: 'claude --version' 退出 ${v.status}\n stdout: ${v.stdout}\n stderr: ${v.stderr}`);
    }
    console.error(`[splice] 烟测: ${v.stdout.trim()}`);

    return { binPath, backup, positions, bundleLen };
}

if (require.main === module) {
    const bundlePath = process.argv[2] || 'claude_bundle.zh.js';
    if (!fs.existsSync(bundlePath)) {
        console.error(`找不到 ${bundlePath}`);
        process.exit(1);
    }
    splice(bundlePath);
}

module.exports = { splice };
