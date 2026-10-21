#!/usr/bin/env node
/**
 * 水鱼查分器 b50 取数 / 校验 / 统计
 *
 * 用法：
 *   node fetch-b50.mjs --qq 123456789 --md
 *   node fetch-b50.mjs --username CaptainLan --md
 *   node fetch-b50.mjs --qq 123456789 --json b50.json
 *   node fetch-b50.mjs --qq 123456789 --md --no-table --top 3
 *
 * 端点与字段口径见 SKILL.md、reference.md。Node >= 18（依赖全局 fetch）。
 */

const API = 'https://www.diving-fish.com/api/maimaidxprober/query/player';

/** 达成率 → rating 系数，与接口 ra 逐条核对过 */
const COEF_TABLE = [
  [100.5, 22.4], [100, 21.6], [99.5, 21.1], [99, 20.8], [98, 20.3], [97, 20.0],
  [94, 16.8], [90, 15.2], [80, 13.6], [75, 12.0], [70, 11.1], [60, 9.6],
  [50, 7.2], [40, 5.0], [30, 3.2], [20, 2.0], [10, 1.0],
];
const ACH_CAP = 100.5;
const LEVEL_NAMES = ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'Re:MASTER'];
const FC_LABEL = { app: 'AP+', ap: 'AP', fcp: 'FC+', fc: 'FC' };
const FS_LABEL = { fs: 'FS', fsp: 'FS+', fsd: 'FDX', sync: 'SYNC' };

function coef(ach) {
  for (const [min, c] of COEF_TABLE) if (ach >= min) return c;
  return 0;
}

function calcRa(ds, ach) {
  return Math.floor((ds * coef(ach) * Math.min(ach, ACH_CAP)) / 100);
}

/** 达到 targetRa 所需的最低达成率；无解返回 null */
function minAchForRa(ds, targetRa) {
  let lo = 0;
  let hi = ACH_CAP;
  if (calcRa(ds, hi) < targetRa) return null;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (calcRa(ds, mid) >= targetRa) hi = mid;
    else lo = mid;
  }
  let ach = Math.ceil(hi * 100) / 100;
  while (calcRa(ds, ach) < targetRa) ach = Math.round((ach + 0.01) * 100) / 100;
  return ach;
}

function parseArgs(argv) {
  const out = { md: false, json: null, top: 5, table: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--qq') out.qq = argv[++i];
    else if (a === '--username') out.username = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--top') out.top = Number(argv[++i]);
    else if (a === '--md' || a === '--markdown') out.md = true;
    else if (a === '--no-table') out.table = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  if (!Number.isFinite(out.top) || out.top < 1) out.top = 5;
  out.top = Math.min(Math.floor(out.top), 50);
  return out;
}

function usage() {
  console.log(`水鱼 b50 取数工具
  --qq <QQ号>          按 QQ 查（需对方绑定并公开成绩）
  --username <用户名>  按水鱼用户名查
  --md                 输出 markdown 报告
  --json <文件>        另存规范化 JSON
  --no-table           不打印 50 行明细表
  --top <N>            候选池条数，默认 5`);
}

function normalize(data) {
  const rows = [];
  for (const [group, key] of [['旧曲', 'sd'], ['新曲', 'dx']]) {
    const arr = data?.charts?.[key] ?? [];
    arr.forEach((c, i) => {
      const ds = Number(c.ds);
      const ach = Number(c.achievements);
      rows.push({
        group,
        groupKey: key,
        rank: i + 1,
        title: String(c.title ?? ''),
        label: c.level_label || LEVEL_NAMES[c.level_index] || String(c.level_index),
        levelIndex: c.level_index,
        ds,
        ach,
        fc: FC_LABEL[c.fc] ?? (c.fc ? String(c.fc) : '未标注'),
        fs: FS_LABEL[c.fs] ?? (c.fs ? String(c.fs) : '—'),
        ra: Number(c.ra),
        calcRa: calcRa(ds, ach),
        coef: coef(ach),
        rate: String(c.rate ?? ''),
        dxScore: c.dxScore ?? null,
        songId: c.song_id ?? null,
        type: c.type ?? null,
      });
    });
  }
  return rows;
}

function countBy(rows, fn) {
  const hist = new Map();
  for (const r of rows) {
    const k = fn(r);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  return hist;
}

function avg(rows, fn) {
  if (!rows.length) return 0;
  return rows.reduce((s, r) => s + fn(r), 0) / rows.length;
}

function analyze(data, rows) {
  const sd = rows.filter((r) => r.groupKey === 'sd');
  const dx = rows.filter((r) => r.groupKey === 'dx');
  const raSum = rows.reduce((s, r) => s + r.ra, 0);
  const rating = Number(data.rating);
  const mismatch = rows.filter((r) => r.calcRa !== r.ra);

  const achBucket = countBy(rows, (r) => {
    const v = r.ach;
    if (v >= 101) return '>=101%';
    if (v >= 100.9) return '100.9-101%';
    if (v >= 100.8) return '100.8-100.9%';
    if (v >= 100.7) return '100.7-100.8%';
    if (v >= 100.6) return '100.6-100.7%';
    if (v >= 100.5) return '100.5-100.6%';
    if (v >= 100) return '100-100.5%';
    return '<100%';
  });

  // 跨系数档：只有存在更高系数档且门槛落在 100.5 以内才可能
  const tierJumps = [];
  for (const r of rows) {
    const higher = COEF_TABLE.filter(([, c]) => c > r.coef)
      .map(([min, c]) => ({ min, c }))
      .sort((a, b) => a.c - b.c)[0];
    if (!higher || higher.min > ACH_CAP) continue;
    const target = Math.max(r.ach, higher.min);
    const gain = calcRa(r.ds, target) - r.ra;
    if (gain > 0) tierJumps.push({ ...r, nextCoef: higher.c, threshold: higher.min, gain, needAch: target });
  }
  tierJumps.sort((a, b) => b.gain - a.gain || a.ach - b.ach);

  // 每首再涨 1 ra 需要多少达成率
  const plusOne = [];
  for (const r of rows) {
    const need = minAchForRa(r.ds, r.ra + 1);
    if (need === null) continue;
    const delta = need - r.ach;
    if (delta <= 0) continue;
    const headroom = calcRa(r.ds, ACH_CAP) - r.ra;
    if (headroom <= 0) continue;
    plusOne.push({ ...r, targetAch: need, deltaPct: Math.round(delta * 100) / 100 });
  }
  plusOne.sort((a, b) => a.deltaPct - b.deltaPct || b.ds - a.ds);

  // 到 100.5% 的理论余量
  const headroom = rows
    .map((r) => ({ ...r, maxRa: calcRa(r.ds, ACH_CAP), room: calcRa(r.ds, ACH_CAP) - r.ra }))
    .sort((a, b) => b.room - a.room);

  // 单谱天花板：达成率与系数双重封顶后，每首能拿到的最大 ra
  const ceilingDs = Math.max(...rows.map((r) => r.ds));
  const ceilingRa = calcRa(ceilingDs, ACH_CAP);
  const replacePool = (pool) => [...pool]
    .sort((a, b) => a.ra - b.ra)
    .map((r) => ({ ...r, replaceGain: ceilingRa - r.ra }));

  return {
    ceilingDs,
    ceilingRa,
    replaceSd: replacePool(sd),
    replaceDx: replacePool(dx),
    allAtCeiling: rows.every((r) => r.ra >= calcRa(r.ds, ACH_CAP)),
    sd, dx, raSum, rating, ratingMatch: raSum === rating,
    mismatch, achBucket,
    fcHist: {
      'AP+': rows.filter((r) => r.fc === 'AP+').length,
      AP: rows.filter((r) => r.fc === 'AP').length,
      'FC+': rows.filter((r) => r.fc === 'FC+').length,
      FC: rows.filter((r) => r.fc === 'FC').length,
      '未标注': rows.filter((r) => r.fc === '未标注').length,
    },
    allCapped: rows.every((r) => r.coef === 22.4),
    tierJumps, plusOne, headroom,
    headroomTotal: headroom.reduce((s, r) => s + r.room, 0),
    apList: rows.filter((r) => r.fc === 'AP+' || r.fc === 'AP'),
    blankList: rows.filter((r) => r.fc === '未标注'),
    avgAchSd: avg(sd, (r) => r.ach),
    avgAchDx: avg(dx, (r) => r.ach),
    avgDsSd: avg(sd, (r) => r.ds),
    avgDsDx: avg(dx, (r) => r.ds),
    achievementSpread: rows.length ? Math.max(...rows.map((r) => r.ach)) - Math.min(...rows.map((r) => r.ach)) : 0,
  };
}

function table(rows, withRank = true) {
  const head = withRank
    ? '| # | 曲名 | 难度 | ds | 达成率 | 判定 | SYNC | ra |'
    : '| 曲名 | 难度 | ds | 达成率 | 判定 | ra |';
  const sep = withRank ? '|---|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|';
  const body = rows.map((r) => (withRank
    ? `| ${r.rank} | ${r.title} | ${r.label} | ${r.ds} | ${r.ach.toFixed(4)}% | ${r.fc} | ${r.fs} | ${r.ra} |`
    : `| ${r.title} | ${r.label} | ${r.ds} | ${r.ach.toFixed(4)}% | ${r.fc} | ${r.ra} |`));
  return [head, sep, ...body].join('\n');
}

function render(data, rows, stats, args) {
  const L = [];
  L.push('# 水鱼 b50 报告');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('|---|---|');
  L.push(`| 昵称 | ${data.nickname ?? '—'} |`);
  L.push(`| 用户名 | ${data.username ?? '—'} |`);
  L.push(`| Rating | ${data.rating} |`);
  L.push(`| 段位评价 | ${data.additional_rating ?? 0} |`);
  L.push(`| 段位牌 | ${data.plate || '（空）'} |`);
  L.push('');

  L.push('## 数据校验');
  L.push('');
  L.push(`- 旧曲 ${stats.sd.length} 首 + 新曲 ${stats.dx.length} 首 = ${rows.length} 首`);
  L.push(`- ra 合计 **${stats.raSum}** ${stats.ratingMatch ? '==' : '!='} rating **${stats.rating}** ${stats.ratingMatch ? '✓' : '✗ 数据不完整，禁止补齐，需重取并说明缺口'}`);
  L.push(`- 公式复算一致 ${rows.length - stats.mismatch.length}/${rows.length} ${stats.mismatch.length === 0 ? '✓' : '✗'}`);
  if (stats.mismatch.length) L.push(`- 复算不符：${stats.mismatch.map((r) => `${r.title}(接口 ${r.ra} / 复算 ${r.calcRa})`).join('、')}`);
  L.push(`- 达成率区间 ${Math.min(...rows.map((r) => r.ach)).toFixed(4)}% ~ ${Math.max(...rows.map((r) => r.ach)).toFixed(4)}%，跨度 ${stats.achievementSpread.toFixed(4)} pp`);
  L.push(`- ds 区间 ${Math.min(...rows.map((r) => r.ds))} ~ ${Math.max(...rows.map((r) => r.ds))}`);
  L.push('');

  if (args.table) {
    L.push('## 旧曲 b50（Top 35）');
    L.push('');
    L.push(table(stats.sd));
    L.push('');
    L.push('## 新曲 b50（Top 15）');
    L.push('');
    L.push(table(stats.dx));
    L.push('');
  }

  L.push('## 判定构成');
  L.push('');
  L.push('| 判定 | 旧曲 | 新曲 | 合计 |');
  L.push('|---|---|---|---|');
  for (const key of ['AP+', 'AP', 'FC+', 'FC', '未标注']) {
    const sdN = stats.sd.filter((r) => r.fc === key).length;
    const dxN = stats.dx.filter((r) => r.fc === key).length;
    L.push(`| ${key} | ${sdN} | ${dxN} | ${sdN + dxN} |`);
  }
  L.push('');

  L.push('## 结构统计');
  L.push('');
  L.push(`- 平均达成率：旧曲 ${stats.avgAchSd.toFixed(4)}%｜新曲 ${stats.avgAchDx.toFixed(4)}%`);
  L.push(`- 平均定数：旧曲 ${stats.avgDsSd.toFixed(3)}｜新曲 ${stats.avgDsDx.toFixed(3)}`);
  L.push(`- 系数档位：${stats.allCapped ? '全部 ≥100.5%，已封顶 22.4，无跨档红利' : '仍存在跨档空间'}`);
  L.push(`- 到 100.5% 的理论余量：${stats.headroomTotal} ra${stats.headroomTotal === 0 ? '（每首均已封顶）' : `（单首最大 ${stats.headroom[0]?.room ?? 0}）`}`);
  const BUCKET_ORDER = ['>=101%', '100.9-101%', '100.8-100.9%', '100.7-100.8%', '100.6-100.7%', '100.5-100.6%', '100-100.5%', '<100%'];
  const bucketText = BUCKET_ORDER
    .filter((k) => stats.achBucket.has(k))
    .map((k) => `${k} ${stats.achBucket.get(k)} 首`)
    .join('｜');
  L.push(`- 达成率分档：${bucketText}`);
  L.push(`- 单谱天花板：ds ${stats.ceilingDs} 的谱面最高可得 ra ${stats.ceilingRa}`);
  L.push('');
  if (stats.apList.length) {
    L.push(`- AP/AP+ 清单（${stats.apList.length} 首）：${stats.apList.map((r) => `${r.title}（${r.label} ${r.ds}，${r.ach.toFixed(4)}%）`).join('、')}`);
  } else {
    L.push('- AP/AP+ 清单：无');
  }
  if (stats.blankList.length) {
    L.push(`- 判定未标注（${stats.blankList.length} 首，属数据缺失，不可推断判定）：${stats.blankList.map((r) => `${r.title}（${r.label} ${r.ds}）`).join('、')}`);
  }
  L.push('');

  L.push('## 改进候选');
  L.push('');
  L.push(`### A. 跨系数档（收益最大，共 ${stats.tierJumps.length} 条）`);
  L.push('');
  if (stats.tierJumps.length) {
    L.push('| 曲名 | 难度 | ds | 当前 | 目标档 | 需达成率 | 收益 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const r of stats.tierJumps.slice(0, args.top)) {
      L.push(`| ${r.title} | ${r.label} | ${r.ds} | ${r.ach.toFixed(4)}% / ${r.ra} | ${r.nextCoef} | ${r.threshold}% | +${r.gain} |`);
    }
  } else {
    L.push('无：所有成绩已达最高系数档，只能靠裸达成率加 ra。');
  }
  L.push('');

  L.push(`### B. 每首 +1 ra 的最低成本（Top ${args.top}）`);
  L.push('');
  if (stats.plusOne.length) {
    L.push('| 曲名 | 难度 | ds | 当前达成率 | 当前 ra | 需达成率 | 需提升 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const r of stats.plusOne.slice(0, args.top)) {
      L.push(`| ${r.title} | ${r.label} | ${r.ds} | ${r.ach.toFixed(4)}% | ${r.ra} | ${r.targetAch.toFixed(2)}% | +${r.deltaPct} pp |`);
    }
  } else {
    L.push('无可行项：上榜成绩达成率均已 ≥100.5%，系数与达成率双重封顶，同一首再刷也不会加分。');
  }
  L.push('');

  L.push(`### C. 到 100.5% 的余量（Top ${args.top}）`);
  L.push('');
  if (stats.allAtCeiling) {
    L.push('全部为 0：50 首每一首都已拿到该谱面的理论最高 ra，精度上没有可挖的余量。');
  } else {
    L.push('| 曲名 | 难度 | ds | 当前 ra | 100.5% 可得 | 余量 |');
    L.push('|---|---|---|---|---|---|');
    for (const r of stats.headroom.slice(0, args.top)) {
      L.push(`| ${r.title} | ${r.label} | ${r.ds} | ${r.ra} | ${r.maxRa} | +${r.room} |`);
    }
  }
  L.push('');

  L.push('### D. 定数结构瓶颈（榜尾替换估算，上限）');
  L.push('');
  L.push(`假定把榜尾若干首换成 ds ${stats.ceilingDs}、达成率 100.5% 的成绩（单首 ${stats.ceilingRa} ra），逐首替换的累计收益：`);
  L.push('');
  for (const [name, pool] of [['旧曲', stats.replaceSd], ['新曲', stats.replaceDx]]) {
    const bottom = pool.slice(0, args.top);
    let cum = 0;
    L.push(`**${name}榜尾 ${bottom.length} 首**`);
    L.push('');
    L.push('| 被替换曲目 | 当前 ds | 当前 ra | 替换后 | 累计收益 |');
    L.push('|---|---|---|---|---|');
    for (const r of bottom) {
      cum += r.replaceGain;
      L.push(`| ${r.title}（${r.label}） | ${r.ds} | ${r.ra} | ${stats.ceilingRa} | ${cum > 0 ? `+${cum}` : '0'} |`);
    }
    L.push('');
  }
  L.push('注：这是上限估算，前提是游戏内确实存在对应定数的未上榜谱面；新曲池的 ds 上限通常低于旧曲池。');
  L.push('');

  L.push('---');
  L.push(`数据校验：旧曲 ${stats.sd.length} 首 + 新曲 ${stats.dx.length} 首 = ${rows.length} 首，ra 合计 ${stats.raSum} == rating ${stats.rating}`);
  return L.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    usage();
    process.exit(1);
  }
  if (args.help || (!args.qq && !args.username)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const body = args.qq ? { qq: String(args.qq), b50: true } : { username: String(args.username), b50: true };
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`网络请求失败：${e.message}。不要编造数据，如实向用户报告失败。`);
    process.exit(2);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    console.error('检查端点是否为 /api/maimaidxprober/query/player，而不是 /api/query/player。');
    process.exit(2);
  }

  if (!res.ok) {
    const msg = data?.message ?? JSON.stringify(data).slice(0, 160);
    if (res.status === 400) console.error(`HTTP 400：${msg}。该 QQ 未绑定查分器或用户名不存在，请让用户确认后重试。`);
    else if (res.status === 403) console.error(`HTTP 403：${msg}。账号未公开成绩，需本人开启公开查分，不可绕过。`);
    else console.error(`HTTP ${res.status}：${msg}`);
    process.exit(2);
  }

  const rows = normalize(data);
  if (!rows.length) {
    console.error('接口返回 0 条成绩：可能未上传 b50，或 b50 未公开。');
    process.exit(2);
  }

  const stats = analyze(data, rows);

  if (args.json) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(args.json, JSON.stringify({ account: {
      nickname: data.nickname, username: data.username, rating: data.rating,
      additional_rating: data.additional_rating, plate: data.plate,
    }, rows, stats: { raSum: stats.raSum, ratingMatch: stats.ratingMatch } }, null, 2), 'utf8');
    console.log(`已写入 ${args.json}`);
  }

  if (args.md) console.log(render(data, rows, stats, args));

  if (!stats.ratingMatch) {
    console.error(`\n[警告] ra 合计 ${stats.raSum} 与 rating ${stats.rating} 不一致，接口返回可能不完整。`);
    console.error(`[警告] 实际取得 ${stats.sd.length} 首旧曲 / ${stats.dx.length} 首新曲。禁止补齐条目，需如实说明缺口。`);
    process.exitCode = 3;
  }
  if (stats.mismatch.length) {
    console.error(`\n[警告] ${stats.mismatch.length} 首 ra 与公式复算不符，系数表可能过期，写入结论前需人工核对。`);
    process.exitCode = 3;
  }
}

await main();
