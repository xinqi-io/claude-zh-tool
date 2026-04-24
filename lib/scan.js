// scan.js
// 在 claude_bundle.js 上做 AST 扫描，产出 entries.json：
//   { _meta: {...}, entries: [{ id, kind, ...context, start, end, en, zh:"" }, ...] }
//
// 与旧版的关键差异：
//   1. 记录 AST 节点的 start/end，替换时按位置切片，不靠英文做 key
//   2. 同英文不同位置可有不同译文，避免之前 logout 那种碰撞
//   3. 升级新版 claude 时，按 id（kind:name）匹配老译文，自动迁移
//
// 支持的源节点形态：
//   description: "xxx"          (StringLiteral)
//   description: `xxx ${y}`     (TemplateLiteral，带 isTemplate 标记)
//   get description(){return "xxx"}          (ObjectMethod kind:get + StringLiteral)
//   get description(){return `xxx ${y}`}     (ObjectMethod kind:get + TemplateLiteral)
//
// isUser 覆盖：普通 slash 命令 (type:local-jsx|…/有 load) + skill 对象
// （靠 getPromptForCommand / userInvocable / allowedTools 之一识别）

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const crypto = require('crypto');

function scanBundle(bundlePath, oldEntries = []) {
    const src = fs.readFileSync(bundlePath, 'utf8');
    const ast = parser.parse(src, {
        sourceType: 'script', errorRecovery: true,
        allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
    });

    // 顶层标识符→初始化表达式 映射（用来解析 description: someVar 这类引用）
    const topScopeIdentifiers = {};
    traverse(ast, {
        VariableDeclarator(path) {
            const n = path.node;
            if (n.id.type === 'Identifier' && n.init && !(n.id.name in topScopeIdentifiers)) {
                topScopeIdentifiers[n.id.name] = n.init;
            }
        },
        AssignmentExpression(path) {
            const n = path.node;
            if (n.operator === '=' && n.left.type === 'Identifier' && !(n.left.name in topScopeIdentifiers)) {
                topScopeIdentifiers[n.left.name] = n.right;
            }
        },
    });

    // 递归收集节点下所有可翻译文本范围。
    // 支持：StringLiteral / TemplateLiteral / Identifier(解引用) /
    //   BinaryExpression(+) / ConditionalExpression / IfStatement / ReturnStatement /
    //   BlockStatement / ObjectMethod(getter) / ExpressionStatement
    // 返回数组：[{ isTemplate, start, end, value }, ...]；可能为空。
    function collectTexts(node, visited = new WeakSet(), depth = 0) {
        if (!node || typeof node !== 'object' || depth > 6) return [];
        if (visited.has(node)) return [];
        visited.add(node);
        const out = [];
        switch (node.type) {
            case 'StringLiteral':
                out.push({ isTemplate: false, start: node.start, end: node.end, value: node.value });
                break;
            case 'TemplateLiteral':
                out.push({ isTemplate: true, start: node.start, end: node.end, value: src.slice(node.start, node.end) });
                break;
            case 'Identifier': {
                const init = topScopeIdentifiers[node.name];
                if (init) out.push(...collectTexts(init, visited, depth + 1));
                break;
            }
            case 'BinaryExpression':
                if (node.operator === '+') {
                    out.push(...collectTexts(node.left, visited, depth + 1));
                    out.push(...collectTexts(node.right, visited, depth + 1));
                }
                break;
            case 'ConditionalExpression':
                out.push(...collectTexts(node.consequent, visited, depth + 1));
                out.push(...collectTexts(node.alternate, visited, depth + 1));
                break;
            case 'ReturnStatement':
                if (node.argument) out.push(...collectTexts(node.argument, visited, depth + 1));
                break;
            case 'IfStatement':
                out.push(...collectTexts(node.consequent, visited, depth + 1));
                if (node.alternate) out.push(...collectTexts(node.alternate, visited, depth + 1));
                break;
            case 'BlockStatement':
                for (const stmt of node.body) out.push(...collectTexts(stmt, visited, depth + 1));
                break;
            case 'ExpressionStatement':
                out.push(...collectTexts(node.expression, visited, depth + 1));
                break;
            case 'ObjectMethod':
                if (node.kind === 'get' && node.body) out.push(...collectTexts(node.body, visited, depth + 1));
                break;
        }
        return out;
    }

    // 兼容老调用的单值版本：返回第一个文本，用于只期望单值的字段
    const asText = n => {
        const all = collectTexts(n);
        return all.length ? all[0] : null;
    };

    // 从 ObjectExpression 里取某个 key 对应的值节点（ObjectProperty 返 value；getter 返整个 method）
    const propByKey = (obj, key) => {
        if (!obj || obj.type !== 'ObjectExpression') return null;
        for (const p of obj.properties) {
            const k = p.key; if (!k) continue;
            const kn = k.type === 'Identifier' ? k.name :
                       (k.type === 'StringLiteral' ? k.value : null);
            if (kn !== key) continue;
            if (p.type === 'ObjectProperty' || p.type === 'Property') return p.value;
            if (p.type === 'ObjectMethod' && p.kind === 'get') return p;
        }
        return null;
    };
    const propKeys = obj => {
        if (!obj || obj.type !== 'ObjectExpression') return [];
        return obj.properties
            .filter(p => (p.type === 'ObjectProperty' || p.type === 'Property' || p.type === 'ObjectMethod') && p.key)
            .map(p => p.key.name || p.key.value);
    };

    const out = [];
    const seenPos = new Set();          // 同一位置不重复登记
    const counters = {};                // id 自增

    function pushEntry(e) {
        // 跳过空串/纯空白
        if (!e.en || !e.en.trim()) return;
        const k = `${e.start}:${e.end}`;
        if (seenPos.has(k)) return;
        seenPos.add(k);
        // 拼 id：保证同一 kind 下唯一，缺名字时用 anon-N
        const baseId = `${e.kind}:${e.idKey || 'anon'}`;
        let id = baseId, n = (counters[baseId] || 0) + 1;
        if (counters[baseId] != null) id = `${baseId}#${n}`;
        counters[baseId] = n;
        const entry = {
            id,
            kind: e.kind,
            ...(e.context || {}),
            start: e.start,
            end: e.end,
            en: e.en,
            zh: '',
        };
        if (e.isTemplate) entry.isTemplate = true;
        out.push(entry);
    }

    // ========== 1. 用户可见命令: slash 命令 + skill 对象 ==========
    // slash: {type:"local-jsx|local-command|local|command|builtin|prompt", name, description, ...}
    // skill: {name, description, <任一 skill 标记>, ...}
    //   标记: getPromptForCommand / userInvocable / allowedTools /
    //         pluginCommand / pluginName / getPromptWhileMarketplaceIsPrivate /
    //         progressMessage / whenToUse
    const SKILL_MARKERS = [
        'getPromptForCommand', 'userInvocable', 'allowedTools',
        'pluginCommand', 'pluginName', 'getPromptWhileMarketplaceIsPrivate',
        'progressMessage', 'whenToUse',
    ];
    traverse(ast, {
        ObjectExpression(path) {
            const n = path.node;
            const descs = collectTexts(propByKey(n, 'description'));
            if (!descs.length) return;

            const keys = propKeys(n);
            const typeNode = propByKey(n, 'type');
            const typeText = asText(typeNode);
            const typeVal = typeText && !typeText.isTemplate ? typeText.value : null;
            const hasLoad = keys.includes('load');
            const nameNode = propByKey(n, 'name');
            const nameText = asText(nameNode);
            const nameVal = nameText && !nameText.isTemplate ? nameText.value : null;

            const isSlash = (typeVal && /^(local-jsx|local-command|local|command|builtin|prompt)$/.test(typeVal))
                         || (hasLoad && nameVal);
            const isSkill = nameVal && SKILL_MARKERS.some(m => keys.includes(m));
            if (!isSlash && !isSkill) return;

            const kind = isSlash ? 'slash.description' : 'skill.description';

            for (const d of descs) {
                pushEntry({
                    kind,
                    idKey: nameVal || 'anon',
                    context: { name: nameVal, type: typeVal },
                    start: d.start, end: d.end, en: d.value,
                    isTemplate: d.isTemplate,
                });
            }

            // argumentHint （TUI 提示）仅 slash 有
            if (isSlash) {
                const hints = collectTexts(propByKey(n, 'argumentHint'));
                for (const h of hints) {
                    pushEntry({
                        kind: 'slash.argumentHint',
                        idKey: nameVal || 'anon',
                        context: { name: nameVal },
                        start: h.start, end: h.end, en: h.value,
                        isTemplate: h.isTemplate,
                    });
                }
            }
        },
    });

    // ========== 2. CLI 选项: .option / .requiredOption / new XxxOption("--flag","help") ==========
    // 2a. commander 的 .option("--flag", "help") / .requiredOption(...)
    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee;
            if (callee.type !== 'MemberExpression') return;
            const m = callee.property && callee.property.name;
            if (m !== 'option' && m !== 'requiredOption') return;
            const args = path.node.arguments;
            if (args.length < 2) return;
            const flagText = asText(args[0]);
            const helpTexts = collectTexts(args[1]);
            if (!flagText || flagText.isTemplate || !helpTexts.length) return;
            if (!flagText.value.startsWith('-')) return;
            for (const h of helpTexts) {
                pushEntry({
                    kind: 'option.help',
                    idKey: flagText.value.replace(/[^\w-]/g, '_'),
                    context: { flag: flagText.value },
                    start: h.start, end: h.end, en: h.value,
                    isTemplate: h.isTemplate,
                });
            }
        },
    });

    // 2b. addOption(new XxxOption("--flag", "help"))
    // —— Claude Code bundle 中形如 `addOption(new pK("--output-format <format>", "Output format..."))`
    // 特征：NewExpression，第 1 个参数是以 `-` 开头的 StringLiteral，第 2 个是文本
    traverse(ast, {
        NewExpression(path) {
            const args = path.node.arguments;
            if (args.length < 2) return;
            const flagText = asText(args[0]);
            const helpTexts = collectTexts(args[1]);
            if (!flagText || flagText.isTemplate || !helpTexts.length) return;
            if (!flagText.value.startsWith('-')) return;
            for (const h of helpTexts) {
                pushEntry({
                    kind: 'option.help',
                    idKey: flagText.value.replace(/[^\w-]/g, '_'),
                    context: { flag: flagText.value },
                    start: h.start, end: h.end, en: h.value,
                    isTemplate: h.isTemplate,
                });
            }
        },
    });

    // ========== 3. .command(...).description(...) / .summary(...) / .usage(...) ==========
    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee;
            if (callee.type !== 'MemberExpression') return;
            const m = callee.property && callee.property.name;
            if (!['description', 'summary', 'usage'].includes(m)) return;
            const args = path.node.arguments;
            if (args.length < 1) return;
            const textArg = asText(args[0]);
            if (!textArg) return;

            // 必须能在上游找到 .command('name')
            let cur = callee.object, cmdName = null;
            while (cur && cur.type === 'CallExpression') {
                if (cur.callee.type === 'MemberExpression' &&
                    cur.callee.property.name === 'command' &&
                    cur.arguments.length >= 1 && cur.arguments[0].type === 'StringLiteral') {
                    cmdName = cur.arguments[0].value; break;
                }
                cur = cur.callee.object;
            }
            if (!cmdName) return;
            // 取首词作 idKey（因为 cmdName 可能是 "logout" 或 "add <name>"）
            const idKey = cmdName.split(/\s/)[0];
            pushEntry({
                kind: `subcmd.${m}`,
                idKey,
                context: { command: cmdName },
                start: textArg.start, end: textArg.end, en: textArg.value,
                isTemplate: textArg.isTemplate,
            });
        },
    });

    // ========== 4. 顶层命令的 .description（无 .command 上游，commander 顶层）==========
    // 形如 program.description('Claude Code - starts an interactive session...')
    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee;
            if (callee.type !== 'MemberExpression') return;
            if (callee.property.name !== 'description') return;
            const args = path.node.arguments;
            if (args.length < 1) return;
            const textArg = asText(args[0]);
            if (!textArg) return;
            // 如果上游能找到 .command()，跳过（已在第 3 步处理）
            let cur = callee.object;
            while (cur && cur.type === 'CallExpression') {
                if (cur.callee.type === 'MemberExpression' &&
                    cur.callee.property.name === 'command' &&
                    cur.arguments.length >= 1 && cur.arguments[0].type === 'StringLiteral') return;
                cur = cur.callee.object;
            }
            // 描述长度合理（避免抓到 description 当对象 key 之类的误命中）
            const v = textArg.value;
            if (v.length < 10 || v.length > 600) return;
            pushEntry({
                kind: 'cli.programDescription',
                idKey: 'top',
                context: {},
                start: textArg.start, end: textArg.end, en: v,
                isTemplate: textArg.isTemplate,
            });
        },
    });

    // 旧译文迁移：优先 (kind, tag, en) 精确匹配；否则退化到 (tag, en) 跨 kind；
    // 再退化到 en 全局匹配（慎用，仅在 tag/kind 都不匹配时兜底，会有误配险）
    if (oldEntries.length) {
        const byTriple = new Map();
        const byDouble = new Map();
        const byEn = new Map();
        for (const e of oldEntries) {
            if (!e.zh) continue;
            const tag = e.flag || e.command || e.name || '';
            byTriple.set(`${e.kind}|${tag}|${e.en}`, e.zh);
            byDouble.set(`${tag}|${e.en}`, e.zh);
            byEn.set(e.en, e.zh);
        }
        for (const e of out) {
            const tag = e.flag || e.command || e.name || '';
            e.zh = byTriple.get(`${e.kind}|${tag}|${e.en}`)
                || byDouble.get(`${tag}|${e.en}`)
                || byEn.get(e.en)
                || '';
        }
    }

    // 排序：按 kind 再按 en，输出稳定
    out.sort((a, b) => (a.kind + a.en).localeCompare(b.kind + b.en));

    return {
        meta: {
            bundle_size: src.length,
            bundle_md5: crypto.createHash('md5').update(src).digest('hex'),
            generated_at: new Date().toISOString(),
            entry_count: out.length,
            translated_count: out.filter(e => e.zh).length,
        },
        entries: out,
    };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const bundlePath = args[0] || 'claude_bundle.js';
    const outPath = args[1] || 'entries.json';
    const oldPath = args[2]; // 可选：要迁移的老 entries.json

    let oldEntries = [];
    if (oldPath && fs.existsSync(oldPath)) {
        oldEntries = JSON.parse(fs.readFileSync(oldPath, 'utf8')).entries || [];
        console.error(`[scan] 读入老 entries: ${oldEntries.length} 条`);
    }

    const t0 = Date.now();
    const result = scanBundle(bundlePath, oldEntries);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

    // 按 kind 统计
    const byKind = {};
    for (const e of result.entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    console.error(`[scan] 完成 ${((Date.now()-t0)/1000).toFixed(1)}s`);
    console.error(`  共 ${result.entries.length} 条:`);
    for (const [k, v] of Object.entries(byKind).sort()) {
        console.error(`    ${k.padEnd(28)} ${v}`);
    }
    console.error(`  已翻: ${result.meta.translated_count} 条`);
    console.error(`  写入 -> ${outPath}`);
}

module.exports = { scanBundle };
