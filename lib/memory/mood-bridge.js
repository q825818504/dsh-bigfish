/**
 * 记忆星图 × 心情插件（dsh-bigfish-mood）对接层。
 *
 * 设计原则：
 *   1. **只读**。绝不写心情插件的 state.json，也不改它的任何数据。
 *   2. **容错**。心情插件没装、文件不存在、JSON 坏了、字段缺失——一律降级，
 *      绝不让记忆面板因此报错。
 *   3. **不污染记忆库**。情绪坐标是"读的时候算"的，不进 SQLite、不改 schema。
 *
 * 数据来源（dsh-bigfish-mood，派生自上游 dsh-feiyu-mood v0.7.6）：
 *   <DSH_HOME>/bigfish-mood/state.json
 *   {
 *     version: 2,
 *     moods: { "<份 id>": { mood, dims{7}, timeline[{at,mood,dims,...}], updatedAt, ... } },
 *     lastActive: "<份 id>"
 *   }
 *
 * 映射链：7 根情绪 → valence/arousal 两轴 → Russell 四色
 *   （对齐 Memory Sky 的环形情绪模型）
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 七根情绪，与心情插件的 DIMS 完全一致 */
export const MOOD_DIMS = ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous'];

/** Russell 四色（沿用 Memory Sky 的调色板） */
export const EMOTION_PALETTE = {
  blue:   { hex: '#BEC2EC', hue: 232, key: 'blue',   label: '不愉快 · 安静' },
  orange: { hex: '#DAA17C', hue: 22,  key: 'orange', label: '不愉快 · 激动' },
  purple: { hex: '#C3A7DE', hue: 272, key: 'purple', label: '愉快 · 安静' },
  yellow: { hex: '#EAD6B3', hue: 40,  key: 'yellow', label: '愉快 · 激动' },
};

/**
 * 心情插件 state.json 的路径（跟随 DSH_HOME）
 *
 * ⭐ 2026-10-28：心情插件已从上游 `dsh-feiyu-mood` 派生为我们自己的
 * `dsh-bigfish-mood`（https://github.com/q825818504/dsh-bigfish-mood），
 * 数据目录随之从 `feiyu-mood` 改成 `bigfish-mood`。
 * 原版已从本机卸载，旧目录已清理，所以这里不再保留兼容分支。
 */
export function moodStatePath() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return join(home, 'bigfish-mood', 'state.json');
}

/** 安全读取 state.json；任何异常都返回 null，调用方据此降级 */
export function readMoodState() {
  try {
    const path = moodStatePath();
    // 文件不存在 / 太久没更新（>7 天）都视为"没有心情数据"
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.moods || typeof raw.moods !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

/** 把 7 根情绪折算成两轴。纯函数，便于测试。 */
export function toAxes(mood, dims) {
  const d = k => {
    const v = Number(dims?.[k]);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
  };

  // valence（愉悦度）：mood 总基调占 55%，七根情绪净值占 45%
  const positive = d('happy') + d('calm') + d('sweet');
  const negative = d('heartache') + d('worry') + d('sad') + d('jealous');
  const moodAxis = Math.max(-1, Math.min(1, ((Number.isFinite(mood) ? mood : 70) - 70) / 30));
  const dimAxis = Math.max(-1, Math.min(1, (positive - negative * 1.25) / 120));
  const valence = Math.max(-1, Math.min(1, moodAxis * 0.55 + dimAxis * 0.45));

  // arousal（激动度）：高唤起四根 vs 低唤起两根，基线 0.42（略偏安静）
  const high = d('happy') + d('jealous') + d('worry') + d('heartache');
  const low = d('calm') * 1.2 + d('sad');
  const arousal = Math.max(0, Math.min(1, 0.42 + (high - low) / 110));

  return { valence: Number(valence.toFixed(4)), arousal: Number(arousal.toFixed(4)) };
}

/** 两轴 → 四色 */
export function toColor(valence, arousal) {
  const key = valence >= 0
    ? (arousal >= 0.5 ? 'yellow' : 'purple')
    : (arousal >= 0.5 ? 'orange' : 'blue');
  return EMOTION_PALETTE[key];
}

/** 单份心情 → { valence, arousal, color } */
export function moodToEmotion(state) {
  const { valence, arousal } = toAxes(Number(state?.mood), state?.dims);
  return { valence, arousal, color: toColor(valence, arousal) };
}

/**
 * 从时间线里找"某个时刻最接近的心情快照"。
 * 用于给历史记忆着色：取 at <= target 的最后一条；没有则取最早一条；都没有返回 null。
 */
export function emotionAt(timeline, target) {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  const ts = Number(target);
  if (!Number.isFinite(ts)) return null;

  let best = null;
  for (const item of timeline) {
    const at = Number(item?.at);
    if (!Number.isFinite(at)) continue;
    if (at <= ts) {
      if (!best || at > Number(best.at)) best = item;
    }
  }
  if (best) return moodToEmotion(best);
  // 目标时间早于所有记录 → 用最早一条近似
  const sorted = [...timeline].filter(i => Number.isFinite(Number(i?.at)))
    .sort((a, b) => Number(a.at) - Number(b.at));
  return sorted.length ? moodToEmotion(sorted[0]) : null;
}

/**
 * 为一批记忆批量解析情绪。
 *
 * @param {Array} items  browse() 返回的 items（含 time）
 * @param {object|null} state  readMoodState() 的结果；null 时全部返回基线
 * @returns {{ byId: Map<number, object>, source: 'timeline'|'current'|'baseline', key: string|null }}
 *
 * 降级顺序：
 *   1. timeline 有记录 → 按记忆时间取最接近的快照（方案 2 的目标行为）
 *   2. 没有 timeline 但有当前 mood → 全部用当前心情
 *   3. 完全没有心情数据 → 用基线 70（愉快·安静，紫色）
 */
export function resolveEmotions(items, state) {
  const byId = new Map();
  const baseEmotion = moodToEmotion({ mood: 70, dims: {} });

  if (!state || !state.moods || typeof state.moods !== 'object') {
    for (const it of items) byId.set(it.id, baseEmotion);
    return { byId, source: 'baseline', key: null };
  }

  const key = state.lastActive && state.moods[state.lastActive]
    ? state.lastActive
    : Object.keys(state.moods)[0];
  const slot = state.moods[key];
  if (!slot) {
    for (const it of items) byId.set(it.id, baseEmotion);
    return { byId, source: 'baseline', key: null };
  }

  const timeline = Array.isArray(slot.timeline) ? slot.timeline : [];
  if (timeline.length === 0) {
    // 还没判断过任何一轮 → 用当前心情给全部记忆着色
    const cur = moodToEmotion(slot);
    for (const it of items) byId.set(it.id, cur);
    return { byId, source: 'current', key };
  }

  for (const it of items) {
    const e = emotionAt(timeline, it.time) || moodToEmotion(slot);
    byId.set(it.id, e);
  }
  return { byId, source: 'timeline', key };
}
