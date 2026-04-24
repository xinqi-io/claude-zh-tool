// apply.js
// 读 entries.json，按位置在 claude_bundle.js 上做精确切片替换。
// 只替换 zh 非空的条目；同时校验 entry 在当前 bundle 里 start..end 处的字符串
// 仍然是 entry.en，否则报错（说明 bundle 变了，需要重跑 scan）。

const fs = require('fs');

function applyTranslations(bundlePath, entriesPath, outPath) {
    const src = fs.readFileSync(bundlePath, 'utf8');
    const data = JSON.parse(fs.readFileSync(entriesPath, 'utf8'));
    const entries = data.entries || [];

    let stats = { applied: 0, skippedEmpty: 0, skippedDrift: 0 };
    const drifted = [];

    // 按 start 倒序排，避免位置漂移
    const sorted = [...entries].sort((a, b) => b.start - a.start);

    let out = src;
    for (const e of sorted) {
        if (!e.zh) { stats.skippedEmpty++; continue; }
        const literal = src.slice(e.start, e.end);

        if (e.isTemplate) {
            // 模板字面量：e.en 就是包括反引号的原始源；e.zh 也必须是合法模板源
            if (literal !== e.en) {
                stats.skippedDrift++;
                drifted.push({ id: e.id, expected: e.en.slice(0,60), got: literal.slice(0,60) });
                continue;
            }
            if (!/^`[\s\S]*`$/.test(e.zh)) {
                stats.skippedDrift++;
                drifted.push({ id: e.id, expected: '`…`', got: e.zh.slice(0,60), reason: 'zh not wrapped in backticks' });
                continue;
            }
            out = out.slice(0, e.start) + e.zh + out.slice(e.end);
            stats.applied++;
            continue;
        }

        // 普通字符串字面量：校验 start..end 处仍然是 e.en（含两侧引号）
        let parsedEn;
        try { parsedEn = JSON.parse(literal.replace(/^'|'$/g, '"')); }
        catch { parsedEn = null; }
        // commander.js 用单引号字面量比较多，eval 解析下
        if (parsedEn === null) {
            try { parsedEn = (new Function(`return ${literal}`))(); } catch {}
        }
        if (parsedEn !== e.en) {
            stats.skippedDrift++;
            drifted.push({ id: e.id, expected: e.en.slice(0,60), got: (parsedEn||literal.slice(0,60)) });
            continue;
        }
        out = out.slice(0, e.start) + JSON.stringify(e.zh) + out.slice(e.end);
        stats.applied++;
    }

    if (outPath) fs.writeFileSync(outPath, out);
    return { stats, drifted, output: out };
}

if (require.main === module) {
    const [bundlePath = 'claude_bundle.js',
           entriesPath = 'entries.json',
           outPath = 'claude_bundle.zh.js'] = process.argv.slice(2);

    const t0 = Date.now();
    const { stats, drifted } = applyTranslations(bundlePath, entriesPath, outPath);
    console.error(`[apply] ${((Date.now()-t0)/1000).toFixed(1)}s`);
    console.error(`  应用替换: ${stats.applied}`);
    console.error(`  无翻译跳过: ${stats.skippedEmpty}`);
    console.error(`  位置漂移跳过: ${stats.skippedDrift}`);
    if (drifted.length) {
        console.error(`\n  ⚠ 漂移条目（bundle 已变，需 rescan）:`);
        for (const d of drifted.slice(0, 5)) {
            console.error(`    [${d.id}] 预期=${JSON.stringify(d.expected)} 实际=${JSON.stringify(d.got)}`);
        }
    }
    console.error(`  输出 -> ${outPath}`);
}

module.exports = { applyTranslations };
