/**
 * lib/mood-bridge.js 的隔离测试。
 *
 * 重点验证「降级」：心情插件没装、文件坏了、timeline 为空，
 * 都不能让记忆面板报错。
 *
 * 运行：node mood-bridge.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toAxes, toColor, moodToEmotion, emotionAt, resolveEmotions,
  EMOTION_PALETTE, MOOD_DIMS,
} from '../lib/memory/mood-bridge.js';

test('七根情绪与心情插件 DIMS 一致', () => {
  assert.deepEqual(MOOD_DIMS,
    ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous']);
});

test('四色调色板沿用 Memory Sky 的色值', () => {
  assert.equal(EMOTION_PALETTE.blue.hex, '#BEC2EC');
  assert.equal(EMOTION_PALETTE.orange.hex, '#DAA17C');
  assert.equal(EMOTION_PALETTE.purple.hex, '#C3A7DE');
  assert.equal(EMOTION_PALETTE.yellow.hex, '#EAD6B3');
});

test('基线（mood 70、全 0）落在愉快·安静', () => {
  const e = moodToEmotion({ mood: 70, dims: {} });
  assert.equal(e.color.key, 'purple');
  assert.ok(Math.abs(e.valence) < 0.01);
  assert.ok(e.arousal < 0.5);
});

test('开心 + 高唤起 → 黄色', () => {
  const e = moodToEmotion({ mood: 88, dims: { happy: 40, sweet: 20 } });
  assert.equal(e.color.key, 'yellow');
  assert.ok(e.valence > 0.3);
});

test('心疼 + 担心 → 橙色（不愉快且激动）', () => {
  const e = moodToEmotion({ mood: 38, dims: { heartache: 45, worry: 40 } });
  assert.equal(e.color.key, 'orange');
  assert.ok(e.valence < 0);
});

test('难过低落 → 蓝色（不愉快且安静）', () => {
  const e = moodToEmotion({ mood: 28, dims: { sad: 50 } });
  assert.equal(e.color.key, 'blue');
});

test('平静安心 → 紫色', () => {
  const e = moodToEmotion({ mood: 75, dims: { calm: 50 } });
  assert.equal(e.color.key, 'purple');
});

test('四色都能被取到（不会退化成两色）', () => {
  const keys = new Set();
  for (const c of [
    { mood: 70, dims: {} },
    { mood: 90, dims: { happy: 50 } },
    { mood: 30, dims: { sad: 50 } },
    { mood: 40, dims: { worry: 50 } },
  ]) keys.add(moodToEmotion(c).color.key);
  assert.equal(keys.size, 4);
});

test('数值越界不抛错', () => {
  assert.doesNotThrow(() => toAxes(NaN, {}));
  assert.doesNotThrow(() => toAxes(-999, { happy: 9999 }));
  const e = moodToEmotion({ mood: 999, dims: { happy: 9999 } });
  assert.ok(e.valence <= 1 && e.valence >= -1);
  assert.ok(e.arousal >= 0 && e.arousal <= 1);
});

test('emotionAt：取 target 之前最近的一条', () => {
  const timeline = [
    { at: 1000, mood: 30, dims: { sad: 50 } },
    { at: 2000, mood: 90, dims: { happy: 50 } },
    { at: 3000, mood: 70, dims: {} },
  ];
  assert.equal(emotionAt(timeline, 2500).color.key, 'yellow');
  assert.equal(emotionAt(timeline, 1500).color.key, 'blue');
  assert.equal(emotionAt(timeline, 9999).color.key, 'purple');
});

test('emotionAt：target 早于全部记录时用最早一条', () => {
  const timeline = [{ at: 5000, mood: 30, dims: { sad: 50 } }];
  assert.equal(emotionAt(timeline, 100).color.key, 'blue');
});

test('emotionAt：空 / 非法输入返回 null', () => {
  assert.equal(emotionAt([], 100), null);
  assert.equal(emotionAt(null, 100), null);
  assert.equal(emotionAt([{ at: 'x' }], 100), null);
  assert.equal(emotionAt([{ at: 1000 }], NaN), null);
});

test('resolveEmotions：没有心情数据 → 全部基线，source=baseline', () => {
  const items = [{ id: 1, time: 100 }, { id: 2, time: 200 }];
  const r = resolveEmotions(items, null);
  assert.equal(r.source, 'baseline');
  assert.equal(r.key, null);
  assert.equal(r.byId.size, 2);
  assert.equal(r.byId.get(1).color.key, 'purple');
});

test('resolveEmotions：timeline 为空 → 用当前心情，source=current', () => {
  const items = [{ id: 1, time: 100 }];
  const state = {
    lastActive: 'k',
    moods: { k: { mood: 30, dims: { sad: 60 }, timeline: [] } },
  };
  const r = resolveEmotions(items, state);
  assert.equal(r.source, 'current');
  assert.equal(r.key, 'k');
  assert.equal(r.byId.get(1).color.key, 'blue');
});

test('resolveEmotions：有 timeline → 按记忆时间取快照，source=timeline', () => {
  const items = [{ id: 1, time: 1500 }, { id: 2, time: 2500 }];
  const state = {
    lastActive: 'k',
    moods: {
      k: {
        mood: 70, dims: {}, timeline: [
          { at: 1000, mood: 30, dims: { sad: 50 } },
          { at: 2000, mood: 90, dims: { happy: 50 } },
        ],
      },
    },
  };
  const r = resolveEmotions(items, state);
  assert.equal(r.source, 'timeline');
  assert.equal(r.byId.get(1).color.key, 'blue');
  assert.equal(r.byId.get(2).color.key, 'yellow');
});

test('resolveEmotions：lastActive 指向不存在的份 → 退回第一份', () => {
  const state = {
    lastActive: 'missing',
    moods: { real: { mood: 30, dims: { sad: 60 }, timeline: [] } },
  };
  const r = resolveEmotions([{ id: 1, time: 1 }], state);
  assert.equal(r.key, 'real');
  assert.equal(r.byId.get(1).color.key, 'blue');
});

test('resolveEmotions：moods 为空对象 → 基线降级', () => {
  const r = resolveEmotions([{ id: 1, time: 1 }], { moods: {}, lastActive: 'x' });
  assert.equal(r.source, 'baseline');
  assert.equal(r.byId.get(1).color.key, 'purple');
});
