/* Spoken → Schedule
 * 纯静态：无框架、无构建、无后端。
 * 两条抽取通道：本地规则（默认，离线可用） / 大模型（填 Key 后启用）。
 */
(() => {
  'use strict';

  /* ============ 小工具 ============ */
  const $ = (s, r = document) => r.querySelector(s);
  const pad = (n) => String(n).padStart(2, '0');
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = startOfDay(d); x.setDate(x.getDate() + n); return x; };
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const uid = () => Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // 语音识别结果常见：汉字之间被插入空格，统一收掉
  function tidySpeech(t) {
    let x = String(t || '');
    for (let i = 0; i < 6; i++) {
      const next = x
        .replace(/([\u4e00-\u9fa5])[ ]+(?=[\u4e00-\u9fa5])/g, '$1')
        .replace(/([\u4e00-\u9fa5])[ ]+(?=[0-9])/g, '$1')
        .replace(/([0-9])[ ]+(?=[\u4e00-\u9fa5])/g, '$1');
      if (next === x) break;
      x = next;
    }
    return x.replace(/\s{2,}/g, ' ').replace(/\s+([，。；、！？])/g, '$1').trim();
  }

  // 清掉零宽字符、全角空格，以及中文之间被插入的空格
  const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
  function normalizeInput(t) {
    let x = String(t || '').replace(ZERO_WIDTH, '');
    x = x.replace(/[\uff10-\uff19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    x = x.replace(/[\u00a0\u3000]/g, ' ');
    // 反复去掉「中文 + 空格 + 中文」里的空格（正则会跳过重叠匹配）
    for (let i = 0; i < 5; i++) {
      const next = x.replace(/([\u4e00-\u9fa5])[ ]+(?=[\u4e00-\u9fa5])/g, '$1');
      if (next === x) break;
      x = next;
    }
    return x.replace(/\s+/g, ' ').trim();
  }

  const CAT_RULES = [
    ['interview', /面试|一面|二面|三面|终面|群面|HR面|复盘会/i],
    ['exam', /笔试|机试|测评|考试|做题|在线测试/],
  ];

  function detectCategory(source, title) {
    const s2 = (source || '') + ' ' + (title || '');
    for (const [key, re] of CAT_RULES) if (re.test(s2)) return key;
    return 'other';
  }

  const M_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  function cn2num(s) {
    if (typeof s === 'number') return s;
    s = String(s).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    if (s.includes('十')) {
      const [a, b] = s.split('十');
      if (a && !(a in M_NUM)) return NaN;
      if (b && !(b in M_NUM)) return NaN;
      return (a ? M_NUM[a] : 1) * 10 + (b ? M_NUM[b] : 0);
    }
    return s in M_NUM ? M_NUM[s] : NaN;
  }

  /* ============ 状态 ============ */
  const BUILD = '2026-11-11j';
  const STORE = 's2s.state.v1';
  const DEFAULT_SETTINGS = {
    provider: 'local', key: '', model: '', base: '',
    asrKey: '', asrBase: 'https://api.siliconflow.cn/v1', asrModel: 'FunAudioLLM/SenseVoiceSmall',
  };

  const state = {
    fragments: [],   // {id, text, at}
    events: [],      // 结构化日程
    settings: { ...DEFAULT_SETTINGS },
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return;
      const s = JSON.parse(raw);
      state.fragments = Array.isArray(s.fragments) ? s.fragments : [];
      state.events = Array.isArray(s.events) ? s.events : [];
      state.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    } catch (e) { /* 存储坏了就重来 */ }
  }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        fragments: state.fragments, events: state.events, settings: state.settings,
      }));
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  /* ============ 本地规则抽取 ============ */
  const WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

  function matchDate(text, base) {
    let m;
    if ((m = text.match(/(\d{1,2}|[一两二三四五六七八九十]{1,2})\s*天(?:之)?后/))) {
      return { date: addDays(base, cn2num(m[1])), matched: m[0] };
    }
    if ((m = text.match(/大后天/))) return { date: addDays(base, 3), matched: m[0] };
    if ((m = text.match(/后天/))) return { date: addDays(base, 2), matched: m[0] };
    if ((m = text.match(/明天|明日|明早|明晚/))) return { date: addDays(base, 1), matched: m[0] };
    if ((m = text.match(/今天|今日|今早|今晚/))) return { date: addDays(base, 0), matched: m[0] };

    if ((m = text.match(/周末/))) {
      const delta = (6 - base.getDay() + 7) % 7;
      return { date: addDays(base, delta), matched: m[0] };
    }
    if ((m = text.match(/(下下|下|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/))) {
      const target = WD[m[2]];
      const cur = base.getDay();
      let delta = (target - cur + 7) % 7;
      if (m[1] === '下') delta += 7;
      else if (m[1] === '下下') delta += 14;
      return { date: addDays(base, delta), matched: m[0] };
    }
    if ((m = text.match(/月底|月末/))) {
      const d = new Date(base.getFullYear(), base.getMonth() + 1, 0);
      return { date: startOfDay(d), matched: m[0] };
    }
    if ((m = text.match(/月初/))) {
      return { date: startOfDay(new Date(base.getFullYear(), base.getMonth(), 1)), matched: m[0] };
    }
    if ((m = text.match(/(下|本|这个)?\s*个?\s*月\s*(\d{1,2})\s*[号日]/))) {
      const offset = m[1] === '下' ? 1 : 0;
      const d = new Date(base.getFullYear(), base.getMonth() + offset, +m[2]);
      return { date: startOfDay(d), matched: m[0] };
    }
    if ((m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[号日]?/))) {
      const d = new Date(base.getFullYear(), +m[1] - 1, +m[2]);
      return { date: startOfDay(d), matched: m[0] };
    }
    return null;
  }

  function matchTime(text) {
    let m = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (m) return { h: +m[1], mi: +m[2], matched: m[0] };

    m = text.match(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2}|[一两二三四五六七八九十]{1,3})\s*[点时](?:\s*(半|\d{1,2})\s*分?)?\s*钟?/);
    if (!m) return null;
    let h = cn2num(m[2]);
    let mi = 0;
    if (m[3] === '半') mi = 30;
    else if (m[3]) mi = +m[3];
    if (isNaN(h) || h > 24) return null;
    const p = m[1] || '';
    if (/下午|傍晚|晚上|夜里/.test(p) && h < 12) h += 12;
    if (p === '中午' && h < 11) h += 12;
    if (/凌晨/.test(p) && h === 12) h = 0;
    return { h: h % 24, mi, matched: m[0] };
  }

  function matchRange(text) {
    const m = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2}|[一两二三四五六七八九十]{1,3})\s*[点时](?:\s*(\d{1,2})\s*分)?\s*(?:到|至|~|-|—)\s*(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2}|[一两二三四五六七八九十]{1,3})\s*[点时]\s*钟?/);
    if (!m) return null;
    let h1 = cn2num(m[2]);
    let h2 = cn2num(m[5]);
    if (isNaN(h1) || isNaN(h2)) return null;
    const p1 = m[1] || m[4] || '';
    const p2 = m[4] || m[1] || '';
    if (/下午|傍晚|晚上|夜里/.test(p1) && h1 < 12) h1 += 12;
    if (/下午|傍晚|晚上|夜里/.test(p2) && h2 < 12) h2 += 12;
    if (h2 <= h1) h2 += 12;
    return { h: h1 % 24, mi: m[3] ? +m[3] : 0, minutes: (h2 - h1) * 60, matched: m[0] };
  }

  function matchDuration(text) {
    let m = text.match(/(\d+(?:\.\d+)?|[一两二三四五六七八九十]+|半)\s*个?\s*(?:小时|钟头)/);
    if (m) {
      const v = m[1] === '半' ? 0.5 : cn2num(m[1]);
      if (!isNaN(v)) return { min: Math.round(v * 60), matched: m[0] };
    }
    m = text.match(/(\d{1,3}|[一两二三四五六七八九十]+)\s*分钟/);
    if (m) {
      const v = cn2num(m[1]);
      if (!isNaN(v)) return { min: v, matched: m[0] };
    }
    return null;
  }

  function matchPeople(text) {
    // 句式一：跟 / 和 / 与 / 同 + 人名
    let m = text.match(/(?:跟|和|与|同)\s*([\u4e00-\u9fa5A-Za-z]{2,6}?)(?=在|对|聊|吃|开|碰|见|谈|一起|一下|[，,。；;\s]|$)/);
    if (m) {
      const name = m[1].replace(/^(一下|一个)/, '').trim();
      if (name.length >= 2) return { people: [name], matched: m[0] };
    }
    // 句式二：人名 + 让 / 叫 / 请 / 约 / 喊 / 催 + 我
    m = text.match(/^\s*([\u4e00-\u9fa5]{2,4}?)(?:让我|叫我|请我|约我|喊我|催我)/);
    if (!m) m = text.match(/^\s*([\u4e00-\u9fa5]{2,4})(?:让|叫|请|约|喊|催)/);
    if (m) return { people: [m[1]], matched: m[0] };
    return null;
  }

  function matchPlace(text) {
    let m = text.match(/在\s*([^，,。；;]{2,20}?)(?=对|聊|吃|开|碰|见|谈|一起|一下|，|,|。|；|;|$)/);
    if (m) {
      const place = m[1].trim();
      if (place.length >= 2) return { place, matched: m[0] };
    }
    // 句式二：回 + 地点 / 去 + 地点
    m = text.match(/回(家|老家|公司|学校|宿舍|爸妈家|外公家)/);
    if (m) return { place: m[1], matched: m[0] };
    m = text.match(/去\s*([^，,。；;]{2,10}?)(?=吃|见|开|看|买|办|玩|，|,|。|；|;|$)/);
    if (m) return { place: m[1].trim(), matched: m[0] };
    return null;
  }

  function parseLocal(rawText, base = new Date()) {
    const text = normalizeInput(rawText);
    let rest = text;
    const take = (r) => { if (r && r.matched) rest = rest.replace(r.matched, ' '); };

    const kind = /之前|前要|前把|截止|deadline|最晚|ddl/i.test(text) ? 'deadline' : 'event';

    const d = matchDate(rest, base); take(d);

    let t = null;
    let du = null;
    const rg = matchRange(rest);
    if (rg) {
      t = { h: rg.h, mi: rg.mi };
      du = { min: rg.minutes, matched: rg.matched };
      take(rg);
    } else {
      t = matchTime(rest); take(t);
      du = matchDuration(rest); take(du);
    }
    const pp = matchPeople(rest); take(pp);
    const pl = matchPlace(rest); take(pl);

    const chunks = rest
      .replace(/(截止日期|截止时间|截止期|截止|deadline|ddl)/gi, ' ')
      .replace(/(大概|大约|左右|差不多|可能|应该|顺便)/g, ' ')
      .replace(/[，,。；;、]/g, '|')
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean);

    let title = (chunks[0] || '')
      .replace(/^(?:(?:要|记得|帮我|把|然后|还有|有一个|有个|一个是|另外|对了|麻烦|之前|以前|前|这|本|当|那)\s*)+/g, '')
      .replace(/\s*(一下|吧|呢|啊|哦|之前|以前|是)\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (title.length > 16) title = title.slice(0, 16);
    if (!title) title = kind === 'deadline' ? '待办事项' : '未命名日程';

    let conf = 0.25;
    if (d) conf += 0.35;
    if (t) conf += 0.25;
    if (du) conf += 0.05;
    if (title !== '未命名日程') conf += 0.1;

    return {
      id: uid(),
      title,
      date: d ? ymd(d.date) : null,
      start: t ? `${pad(t.h)}:${pad(t.mi)}` : null,
      duration: du ? du.min : null,
      people: pp ? pp.people : [],
      place: pl ? pl.place : '',
      kind,
      category: detectCategory(text, title),
      seq: 0,
      updatedAt: null,
      confidence: Math.min(0.96, Math.round(conf * 100) / 100),
      source: rawText,
      engine: 'local',
    };
  }

  function splitClauses(text) {
    return normalizeInput(text).split(/[，,。；;]+/).map((x) => x.trim()).filter(Boolean);
  }

  function clauseInfo(clause) {
    const base = new Date();
    return {
      hasDate: !!matchDate(clause, base),
      hasTime: !!(matchRange(clause) || matchTime(clause)),
      deadline: /截止|deadline|ddl|最晚/i.test(clause),
      fresh: /^(还有一个|有个|一个是|另外|还有|然后|其次|对了)/.test(clause),
    };
  }

  // 一段话里可能有好几件事：按标点切句，再把「同一件事的补充说明」并回去
  function parseLocalMany(rawText) {
    const clauses = splitClauses(rawText);
    if (clauses.length <= 1) return [parseLocal(rawText)];

    const groups = [];
    let cur = [];
    let curHasDate = false;
    let curHasTime = false;
    let curDeadline = false;

    const flush = () => {
      if (cur.length) groups.push(cur.join('，'));
    };

    for (const c of clauses) {
      const k = clauseInfo(c);
      const startNew = !cur.length
        || k.fresh
        || (k.deadline && !curDeadline)
        || (k.hasDate && curHasDate)
        || (k.hasTime && curHasTime && !k.deadline);

      if (startNew) {
        flush();
        cur = [c];
        curHasDate = k.hasDate;
        curHasTime = k.hasTime;
        curDeadline = k.deadline;
      } else {
        cur.push(c);
        curHasDate = curHasDate || k.hasDate;
        curHasTime = curHasTime || k.hasTime;
        curDeadline = curDeadline || k.deadline;
      }
    }
    flush();

    return groups.map((g) => parseLocal(g));
  }

  /* ============ 大模型抽取 ============ */
  const EXTRACT_RULE = `今天是 __TODAY__（__WEEKDAY__），时区 Asia/Shanghai。
把用户的一段口语整理成日程，只输出 JSON，不要解释，不要 markdown 代码块。

硬性规则：
1. date 必须是 YYYY-MM-DD。出现「今天/明天/后天/大后天/这周X/下周X/月底/下月N号」时，一律基于今天换算成具体日期，不允许留空。
2. start 必须是 24 小时制 HH:mm。「下午/傍晚/晚上」一律加 12 小时：下午五点 = 17:00，绝不允许写成 05:00。
3. 「X 点到 Y 点」表示时间段：start 取 X，duration_min = (Y - X) * 60。
4. 只有原文完全没提日期时 date 才为空；只有完全没提时刻时 start 才为空。
5. kind：「截止/之前完成/最晚」类为 deadline，其余为 event。
6. title 用动词短语，不超过 12 字，不包含时间、地点、人名。
7. 不编造原文没有的信息。
8. category：提到「面试」为 interview，提到「笔试/机试/测评」为 exam，其余为 other。
9. 如果一段话包含多件互不相关的事，events 数组里返回多个对象，不要合并成一条。

示例：
口语：明天下午五点钟有个会
今天是 __TODAY__，所以明天是 __TOMORROW__，输出：
{"events":[{"title":"开会","date":"__TOMORROW__","start":"17:00","duration_min":60,"people":[],"place":"","kind":"event","confidence":0.95}]}`;

  const GEMINI_SCHEMA = {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            date: { type: 'string' },
            start: { type: 'string' },
            duration_min: { type: 'number' },
            people: { type: 'array', items: { type: 'string' } },
            place: { type: 'string' },
            kind: { type: 'string', enum: ['event', 'deadline'] },
            category: { type: 'string', enum: ['interview', 'exam', 'other'] },
            confidence: { type: 'number' },
          },
          required: ['title', 'date', 'start', 'kind', 'confidence'],
        },
      },
    },
    required: ['events'],
  };

  function promptFor(text) {
    const now = new Date();
    return EXTRACT_RULE
      .replace(/__TODAY__/g, ymd(now))
      .replace('__WEEKDAY__', WEEK[now.getDay()])
      .replace(/__TOMORROW__/g, ymd(addDays(now, 1)))
      + '\n\n口语：' + normalizeInput(text);
  }

  function normalize(raw, source) {
    const e = raw || {};
    const date = /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : null;
    const start = /^\d{1,2}:\d{2}$/.test(e.start || '') ? e.start.padStart(5, '0') : null;
    return {
      id: uid(),
      title: (e.title || '未命名日程').toString().slice(0, 30),
      date,
      start,
      duration: Number(e.duration_min) > 0 ? Number(e.duration_min) : null,
      people: Array.isArray(e.people) ? e.people.filter(Boolean).map(String).slice(0, 3) : [],
      place: e.place || '',
      kind: e.kind === 'deadline' ? 'deadline' : 'event',
      category: ['interview', 'exam'].includes(e.category) ? e.category : detectCategory(source, e.title),
      seq: 0,
      updatedAt: null,
      confidence: Math.max(0, Math.min(1, Number(e.confidence) || 0.6)),
      source,
      engine: 'ai',
    };
  }

  async function parseWithAI(text) {
    const { provider, key, model, base } = state.settings;
    if (!key) throw new Error('NO_KEY');

    if (provider === 'gemini') {
      const m = model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptFor(text) }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_SCHEMA,
          },
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const obj = JSON.parse(txt);
      const list = (obj.events || []).map((e) => normalize(e, text));
      if (!list.length) throw new Error('EMPTY');
      return list;
    }

    // OpenAI 兼容（DeepSeek / Moonshot / 自建网关）
    const root = (base || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const res = await fetch(root + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是一个日程抽取器，只输出 JSON。' },
          { role: 'user', content: promptFor(text) + '\n\n输出格式：{"events":[{"title":"","date":"","start":"","duration_min":0,"people":[],"place":"","kind":"event","confidence":0.9}]}' },
        ],
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const txt = data?.choices?.[0]?.message?.content || '';
    const obj = JSON.parse(txt);
    const list = (obj.events || []).map((e) => normalize(e, text));
    if (!list.length) throw new Error('EMPTY');
    return list;
  }

  async function extractAll(text) {
    if (state.settings.provider === 'local') return parseLocalMany(text);
    try {
      return await parseWithAI(text);
    } catch (e) {
      toast(e.message === 'NO_KEY' ? '还没填 API Key，先用本地规则' : '模型抽取失败，已回退本地规则');
      return parseLocalMany(text);
    }
  }

  function minutesOfStart(ev) {
    if (!ev.start) return null;
    const [h, m] = ev.start.split(':').map(Number);
    return h * 60 + m;
  }

  // 两条事件若时间重叠，生成一条卡间提示
  function conflictNote(a, b) {
    const am = minutesOfStart(a);
    const bm = minutesOfStart(b);
    if (am == null || bm == null) return '';
    const aEnd = am + (a.duration || 60);
    const bEnd = bm + (b.duration || 60);
    const overlap = Math.min(aEnd, bEnd) - Math.max(am, bm);
    if (overlap <= 0) return '';

    const later = am >= bm ? a : b;
    const other = later === a ? b : a;
    return `<div class="conflict-note">
      <span class="ico">⚠</span>
      <span>与 ${esc(other.start)} 的「${esc(other.title)}」重叠 ${overlap} 分钟</span>
    </div>`;
  }

  /* ---- 编辑日程 ---- */
  let editingId = null;
  const editDlg = $('#dlg-edit');

  function openEditDialog(ev) {
    editingId = ev.id;
    $('#edit-title').value = ev.title || '';
    $('#edit-when').value = ev.date ? `${ev.date}T${ev.start || '09:00'}` : '';
    $('#edit-place').value = ev.place || '';
    $('#edit-people').value = (ev.people || []).join('，');
    $('#edit-cat').value = ev.category || 'other';
    $('#edit-kind').value = ev.kind === 'deadline' ? 'deadline' : 'event';
    editDlg.showModal();
    setTimeout(() => $('#edit-title').focus(), 30);
  }

  $('#edit-cancel').addEventListener('click', () => editDlg.close());

  $('#edit-save').addEventListener('click', () => {
    const ev = state.events.find((x) => x.id === editingId);
    if (!ev) { editDlg.close(); return; }

    ev.title = ($('#edit-title').value || '').trim().slice(0, 30) || '未命名日程';
    const when = $('#edit-when').value;
    if (when) {
      const [d, t] = when.split('T');
      ev.date = d;
      ev.start = t ? t.slice(0, 5) : null;
    } else {
      ev.date = null;
      ev.start = null;
    }
    ev.place = ($('#edit-place').value || '').trim();
    ev.seq = (ev.seq || 0) + 1;
    ev.updatedAt = Date.now();
    ev.people = ($('#edit-people').value || '')
      .split(/[，,、\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
    ev.kind = $('#edit-kind').value === 'deadline' ? 'deadline' : 'event';

    const cat = $('#edit-cat').value;
    ev.category = cat === 'auto' ? detectCategory(ev.source, ev.title) : cat;

    save();
    render();
    editDlg.close();
    toast('已保存');
  });

  /* ============ 冲突与重复 ============ */
  function minutesOf(ev) {
    if (!ev.start) return null;
    const [h, m] = ev.start.split(':').map(Number);
    return h * 60 + m;
  }

  function analyze() {
    const flags = new Map(); // id -> {conflict:bool, dup:bool}
    const get = (id) => {
      if (!flags.has(id)) flags.set(id, { conflict: false, dup: false });
      return flags.get(id);
    };
    const withDate = state.events.filter((e) => e.date);

    for (let i = 0; i < withDate.length; i++) {
      for (let j = i + 1; j < withDate.length; j++) {
        const a = withDate[i], b = withDate[j];
        if (a.date !== b.date) continue;

        const am = minutesOf(a), bm = minutesOf(b);
        if (am != null && bm != null) {
          const alen = a.duration || 60, blen = b.duration || 60;
          if (am < bm + blen && bm < am + alen) {
            get(a.id).conflict = true; get(b.id).conflict = true;
          }
        }

        const na = a.title.replace(/\s/g, ''), nb = b.title.replace(/\s/g, '');
        const sameTitle = na === nb || (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na)));
        const sameStart = am != null && bm != null && Math.abs(am - bm) <= 30;
        if (sameTitle && (sameStart || a.people.join() === b.people.join())) {
          get(a.id).dup = true; get(b.id).dup = true;
        }
      }
    }
    return flags;
  }

  /* ============ 渲染 ============ */
  const timelineEl = $('#timeline');
  const chipsEl = $('#chips');
  const statsEl = $('#stats');

  function dayLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const today = startOfDay(new Date());
    const diff = Math.round((d - today) / 86400000);
    const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : '';
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    return { md, wd: WEEK[d.getDay()], rel, diff };
  }

  function durText(min) {
    if (!min) return '';
    if (min % 60 === 0) return `${min / 60} 小时`;
    if (min > 60) return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
    return `${min} 分钟`;
  }

  function eventHTML(ev, flag) {
    const cls = ['event'];
    if (flag && flag.conflict) cls.push('conflict');
    if (flag && flag.dup) cls.push('dup');
    if (ev.kind === 'deadline') cls.push('deadline');
    if (ev.category === 'interview') cls.push('cat-interview');
    if (ev.category === 'exam') cls.push('cat-exam');

    const when = ev.start
      ? `<b>${esc(ev.start)}</b><span>${ev.duration ? durText(ev.duration) : '约 1 小时'}</span>`
      : `<b>${ev.kind === 'deadline' ? '截止' : '全天'}</b><span>${ev.kind === 'deadline' ? '当天前完成' : '未定时刻'}</span>`;

    const meta = [];
    if (ev.people && ev.people.length) meta.push(`<i>👤 ${esc(ev.people.join('、'))}</i>`);
    if (ev.place) meta.push(`<i>📍 ${esc(ev.place)}</i>`);
    if (ev.kind === 'deadline') meta.push('<i class="deadline-tag">⏳ 截止</i>');
    if (ev.confidence != null && ev.confidence < 0.6) meta.push('<i>❓ 待确认</i>');

    const badges = [];
    // 时间冲突不再用角标，改为卡片顶部斜纹 + 卡间提示行
    if (flag && flag.dup) badges.push('<span class="flag yellow">可能重复</span>');

    return `<article class="${cls.join(' ')}" data-id="${ev.id}">
      <div class="when">${when}</div>
      <div class="body">
        <div class="title-row">
          <span class="title" contenteditable="true" spellcheck="false">${esc(ev.title)}</span>
          ${ev.category === 'interview' ? '<span class="cat-tag">面试</span>' : ''}
          ${ev.category === 'exam' ? '<span class="cat-tag">笔试</span>' : ''}
          ${badges.join('')}
        </div>
        ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
        ${ev.source ? `<div class="src">“${esc(ev.source)}”</div>` : ''}
      </div>
      <div class="event-actions">
        <button class="mini" data-act="edit">编辑</button>
        <button class="mini danger" data-act="del">删除</button>
      </div>
    </article>`;
  }

  function render() {
    const flags = analyze();
    const events = state.events.slice();

    // 分组
    const groups = new Map();
    events.forEach((e) => {
      const key = e.date || 'tbd';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    });

    const keys = [...groups.keys()].filter((k) => k !== 'tbd')
      .sort((a, b) => a.localeCompare(b));
    if (groups.has('tbd')) keys.push('tbd');

    if (!events.length) {
      timelineEl.innerHTML = `<div class="empty">
        <strong>还没有日程</strong>
        在左边说一句话，比如「下周三下午三点跟老王对方案，大概一小时」<br>
        它会自己落到右边的轴上。
      </div>`;
      statsEl.textContent = '';
    } else {
      let html = '';
      keys.forEach((key) => {
        const list = groups.get(key).slice().sort((a, b) => {
          const am = minutesOf(a), bm = minutesOf(b);
          if (am == null && bm == null) return 0;
          if (am == null) return -1;
          if (bm == null) return 1;
          return am - bm;
        });

        let head;
        if (key === 'tbd') {
          head = `<div class="day-head"><span class="day-date">待定</span><span class="day-count">${list.length} 条</span></div>`;
        } else {
          const L = dayLabel(key);
          head = `<div class="day-head">
            <span class="day-date">${L.md} · ${L.wd}</span>
            ${L.rel ? `<span class="day-rel">${L.rel}</span>` : ''}
            <span class="day-count">${list.length} 条</span>
          </div>`;
        }

        let cards = '';
        list.forEach((e, i) => {
          cards += eventHTML(e, flags.get(e.id));
          const next = list[i + 1];
          if (next) {
            const note = conflictNote(e, next);
            if (note) cards += note;
          }
        });

        html += `<section class="day">${head}<div class="events">${cards}</div></section>`;
      });
      timelineEl.innerHTML = html;

      const days = new Set(events.filter((e) => e.date).map((e) => e.date)).size;
      const conflicts = [...flags.values()].filter((f) => f.conflict).length / 2;
      statsEl.textContent = `${events.length} 条日程 · ${days} 天${conflicts ? ` · ${Math.round(conflicts)} 处冲突` : ''}`;
    }

    chipsEl.innerHTML = state.fragments.map((f, i) => `
      <div class="chip" data-fid="${f.id}">
        <span class="idx">${i + 1}</span>
        <span class="txt">${esc(f.text)}</span>
        <button class="del" data-act="drop" title="移除">×</button>
      </div>`).join('');

    $('#engine-label').textContent = state.settings.provider === 'local'
      ? '本地规则 · 离线'
      : (state.settings.provider === 'gemini' ? 'Gemini 抽取' : '模型抽取');
    $('#engine-label').className = 'engine' + (state.settings.provider === 'local' ? '' : ' ai');
  }

  /* ============ 交互 ============ */
  function toast(msg) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)',
        background: '#1f1b16', color: '#fbf9f5', padding: '9px 16px', borderRadius: '10px',
        fontSize: '13px', zIndex: 99, boxShadow: '0 10px 30px rgba(0,0,0,.2)',
        transition: 'opacity .25s', opacity: '0',
      });
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }

  async function addFragment(text) {
    text = (text || '').trim();
    if (!text) return;
    state.fragments.push({ id: uid(), text, at: Date.now() });
    const evs = await extractAll(text);
    state.events.push(...evs);
    save();
    render();
  }

  function loadExamples() {
    const samples = [
      '下周三下午三点跟老王在3楼会议室对一下方案，大概一小时',
      '这周五之前把预算表发给财务',
      '明天上午十点站会，15分钟',
      '月底前要提交季度复盘，具体哪天还没定',
      '周四晚上七点跟张老师吃饭',
      '下个月5号交房租',
      '后天下午两点半面试候选人，别忘了提前看简历',
      '周五上午九点笔试监考，两小时',
      '这周末把 demo 的视频录了',
    ];
    state.fragments = samples.map((t) => ({ id: uid(), text: t, at: Date.now() }));
    state.events = samples.map((t) => parseLocal(t));
    save();
    render();
  }

  async function reparseAll() {
    if (!state.fragments.length) return;
    const texts = state.fragments.map((f) => f.text);
    state.events = [];
    for (const t of texts) {
      // eslint-disable-next-line no-await-in-loop
      state.events.push(...(await extractAll(t)));
    }
    save();
    render();
    toast('已用「' + (state.settings.provider === 'local' ? '本地规则' : '模型') + '」重新整理');
  }

  /* ---- 时间轴事件 ---- */
  timelineEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.event');
    const id = card.dataset.id;
    const ev = state.events.find((x) => x.id === id);
    if (!ev) return;

    if (btn.dataset.act === 'del') {
      state.events = state.events.filter((x) => x.id !== id);
      save(); render();
    }
    if (btn.dataset.act === 'edit') {
      openEditDialog(ev);
    }
  });

  timelineEl.addEventListener('blur', (e) => {
    if (!e.target.classList.contains('title')) return;
    const card = e.target.closest('.event');
    const ev = state.events.find((x) => x.id === card.dataset.id);
    if (!ev) return;
    const t = e.target.textContent.replace(/\s+/g, ' ').trim();
    if (t && t !== ev.title) {
      ev.title = t;
      ev.seq = (ev.seq || 0) + 1;
      ev.updatedAt = Date.now();
      save(); render();
    }
  }, true);

  /* ---- 输入区 ---- */
  $('#btn-add').addEventListener('click', async () => {
    const ta = $('#input');
    const v = ta.value;
    ta.value = '';
    await addFragment(v);
  });

  $('#input').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('#btn-add').click();
    }
  });

  chipsEl.addEventListener('click', (e) => {
    if (e.target.dataset.act !== 'drop') return;
    const id = e.target.closest('.chip').dataset.fid;
    const frag = state.fragments.find((f) => f.id === id);
    state.fragments = state.fragments.filter((f) => f.id !== id);
    if (frag) state.events = state.events.filter((ev) => ev.source !== frag.text);
    save(); render();
  });

  $('#btn-examples').addEventListener('click', loadExamples);

  $('#btn-clear').addEventListener('click', () => {
    if (!state.events.length && !state.fragments.length) return;
    state.events = []; state.fragments = [];
    save(); render();
  });

  /* ---- 设置 ---- */
  const dlg = $('#dlg-settings');

  function syncSettingsUI() {
    const s = state.settings;
    $('#set-provider').value = s.provider;
    $('#set-key').value = s.key;
    $('#set-model').value = s.model || (s.provider === 'gemini' ? 'gemini-2.5-flash' : 'deepseek-chat');
    $('#set-base').value = s.base;
    $('#set-asr-key').value = s.asrKey || '';
    $('#set-asr-base').value = s.asrBase || 'https://api.siliconflow.cn/v1';
    $('#set-asr-model').value = s.asrModel || 'FunAudioLLM/SenseVoiceSmall';
    $('#ai-fields').hidden = s.provider === 'local';
    $('#field-base').hidden = s.provider !== 'openai';
    $('#set-model').placeholder = s.provider === 'gemini' ? 'gemini-2.5-flash' : 'deepseek-chat';
  }

  $('#btn-settings').addEventListener('click', () => {
    syncSettingsUI();
    dlg.showModal();
  });
  $('#btn-cancel').addEventListener('click', () => dlg.close());
  $('#set-provider').addEventListener('change', () => {
    const p = $('#set-provider').value;
    $('#ai-fields').hidden = p === 'local';
    $('#field-base').hidden = p !== 'openai';
    $('#set-model').value = p === 'gemini' ? 'gemini-2.5-flash' : (p === 'openai' ? 'deepseek-chat' : '');
  });
  $('#btn-save').addEventListener('click', () => {
    state.settings = {
      provider: $('#set-provider').value,
      key: $('#set-key').value.trim(),
      model: $('#set-model').value.trim(),
      base: $('#set-base').value.trim(),
      asrKey: $('#set-asr-key').value.trim(),
      asrBase: $('#set-asr-base').value.trim() || 'https://api.siliconflow.cn/v1',
      asrModel: $('#set-asr-model').value.trim() || 'FunAudioLLM/SenseVoiceSmall',
    };
    save(); render(); dlg.close();
    toast(state.settings.provider === 'local' ? '已切回本地规则' : '已保存，之后的输入会走模型');
  });

  /* ---- 录音 → 转写（OpenAI 兼容的 /audio/transcriptions） ---- */
  async function micPermissionState() {
    try {
      const st = await navigator.permissions.query({ name: 'microphone' });
      return st.state; // granted | denied | prompt
    } catch (e) {
      return 'unknown';
    }
  }

  function micDeniedHint(e, perm) {
    const name = e && e.name;
    if (!window.isSecureContext) {
      return '当前页面不是 HTTPS，浏览器不允许调用麦克风。请用 https:// 开头的地址（或 localhost）';
    }
    if (perm === 'denied') {
      return '这个站点被设成了「阻止麦克风」：点地址栏左侧的图标 → 网站设置 → 麦克风 → 改成「允许」→ 刷新页面。也可以在 chrome://settings/content/microphone 里把这个站点删掉';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '没检测到麦克风设备';
    }
    if (name === 'NotReadableError') {
      return '麦克风被其他程序占用了（会议软件之类），关掉再试';
    }
    if (perm === 'granted') {
      return '系统已授权，但浏览器仍然打不开麦克风（' + (name || '未知错误') + '）。试试完全退出 Chrome 再打开';
    }
    return '麦克风被拒绝（' + (name || '未知错误') + '）：① macOS 系统设置 → 隐私与安全性 → 麦克风 → 勾选 Google Chrome，改完必须 Cmd+Q 完全退出再打开；② 地址栏左侧图标 → 网站设置 → 麦克风 → 允许';
  }

  let recorder = null;
  let recChunks = [];
  let recStream = null;

  async function startRecording(ta) {
    const s = state.settings;
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const perm = await micPermissionState();
      toast('打不开麦克风');
      setHint(micDeniedHint(e, perm));
      return;
    }

    const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
      ? 'audio/webm;codecs=opus' : '';
    try {
      recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      toast('这台设备不支持录音');
      recStream.getTracks().forEach((t) => t.stop());
      recStream = null;
      return;
    }

    recChunks = [];
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) recChunks.push(ev.data); };
    recorder.onstop = async () => {
      const type = (recorder && recorder.mimeType) || 'audio/webm';
      const blob = new Blob(recChunks, { type });
      recorder = null;
      if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
      micBtn.classList.remove('recording');
      micBtn.textContent = '🎙 点一下说话';
      if (!blob.size) { setHint('没录到声音，再说一次'); return; }
      setHint('正在转写…');
      await transcribe(blob, ta);
    };

    recorder.start();
    micBtn.classList.add('recording');
    micBtn.textContent = '🎙 录音中…点此结束';
    setHint('正在录音，说完点一下停止');
  }

  async function transcribe(blob, ta) {
    const s = state.settings;
    const base = (s.asrBase || '').replace(/\/+$/, '');
    const fd = new FormData();
    fd.append('file', blob, 'speech.webm');
    fd.append('model', s.asrModel || 'FunAudioLLM/SenseVoiceSmall');
    try {
      const res = await fetch(base + '/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + s.asrKey },
        body: fd,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const text = (data.text || '').trim();
      if (!text) { setHint('没听清，再说一次'); toast('没听清'); return; }
      ta.value = tidySpeech((ta.value.trim() ? ta.value.trim().replace(/[，,]\s*$/, '') + '，' : '') + text);
      setHint('已转写到输入框');
      ta.focus();
    } catch (e) {
      setHint('转写失败：' + e.message + '，检查 Key / Base URL');
      toast('转写失败：' + e.message);
    }
  }

  /* ---- 语音 ---- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('#btn-mic');
  const micHint = $('#mic-hint');
  const HINT_DEFAULT = micHint ? micHint.textContent : '';
  let recog = null;
  let listening = false;   // 用户是否希望麦克风持续开着

  const ERR_TEXT = {
    'not-allowed': '麦克风权限被拒绝',
    'service-not-allowed': '浏览器禁用了语音服务',
    'network': '连不上浏览器自带的语音服务（国内网络常见）',
    'no-speech': '没听到声音',
    'audio-capture': '没检测到麦克风',
    'aborted': '',
  };

  const setHint = (t) => { if (micHint) micHint.textContent = t || HINT_DEFAULT; };

  if (!SR) {
    micBtn.disabled = true;
    micBtn.textContent = '🎙 浏览器不支持';
    setHint('当前浏览器没有语音接口：用 Chrome / Edge，或直接用系统听写（Mac 连按两下 Fn，Windows 按 Win+H）');
  } else {
    const resetMicBtn = () => {
      micBtn.classList.remove('recording');
      micBtn.textContent = '🎙 点一下说话';
    };

    // 一次识别会话；浏览器因静音自动结束后，只要用户没点停止就自动续上
    function beginListening() {
      const ta = $('#input');
      const cur = ta.value.trim();
      const baseText = cur ? (/[，,。；;]$/.test(cur) ? cur : cur + '，') : '';

      const r = new SR();
      recog = r;
      r.lang = 'zh-CN';
      r.interimResults = true;
      r.continuous = true;
      r.maxAlternatives = 1;

      let got = false;
      let failed = false;

      r.onresult = (ev) => {
        got = true;
        // 必须从 0 开始拼：resultIndex 只指向本次新增片段，
        // 从它开始拼会把前面说过的话覆盖掉（表现为「已识别的内容被删掉」）
        let txt = '';
        for (let i = 0; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
        ta.value = tidySpeech(baseText + txt);
      };

      r.onerror = (ev) => {
        if (ev.error === 'aborted') return;
        failed = true;
        listening = false;
        const msg = ERR_TEXT[ev.error] ?? ('语音出错：' + ev.error);
        if (msg) {
          toast(msg);
          setHint(msg + '。可以改用系统听写：Mac 连按两下 Fn，Windows 按 Win+H');
        }
      };

      r.onend = () => {
        recog = null;
        if (listening && !failed) {
          setTimeout(() => {
            if (!listening) return;
            try { beginListening(); } catch (e) {
              listening = false;
              resetMicBtn();
              toast('麦克风已断开：' + e.message);
            }
          }, 200);
          return;
        }
        resetMicBtn();
        if (!got) setHint('这次没识别到内容。若提示「连不上语音服务」，用系统听写最稳：Mac 连按两下 Fn，Windows 按 Win+H');
        ta.focus();
      };

      try {
        r.start();
      } catch (e) {
        recog = null;
        listening = false;
        resetMicBtn();
        toast('启动失败：' + e.message);
      }
    }

    micBtn.addEventListener('click', async () => {
      // 录音模式：再点一下结束
      if (recorder) { try { recorder.stop(); } catch (e) { /* noop */ } return; }
      // 识别模式：再点一下结束
      if (listening) {
        listening = false;
        if (recog) { try { recog.stop(); } catch (e) { /* noop */ } }
        return;
      }
      if (recog) { try { recog.stop(); } catch (e) { /* noop */ } return; }

      // 配了转写 Key 就走「录音 → 上传转写」，否则用浏览器自带识别
      if (state.settings.asrKey) {
        startRecording($('#input'));
        return;
      }

      // 先显式要一次麦克风权限，避免直接 start 时静默失败
      micBtn.disabled = true;
      let granted = true;
      let lastMicError = null;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        granted = false;
        lastMicError = e;
      }
      micBtn.disabled = false;

      if (!granted) {
        const perm = await micPermissionState();
        toast('打不开麦克风');
        setHint(micDeniedHint(lastMicError, perm));
        return;
      }

      listening = true;
      micBtn.classList.add('recording');
      micBtn.textContent = '🎙 正在听…点此结束';
      setHint('正在听，说完再点一下结束');
      beginListening();
    });
  }

  /* ---- 导出 .ics ---- */
  function icsEscape(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function icsStamp(d) {
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }
  function icsDateTime(dateStr, timeStr) {
    return dateStr.replace(/-/g, '') + 'T' + (timeStr || '09:00').replace(':', '') + '00';
  }
  function foldLine(line) {
    // RFC 5545：每行不超过 75 字节，按字节折行
    const enc = new TextEncoder();
    if (enc.encode(line).length <= 75) return line;
    let out = '', cur = '', bytes = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > 74) { out += cur + '\r\n '; cur = ch; bytes = b; }
      else { cur += ch; bytes += b; }
    }
    return out + cur;
  }

  function exportICS() {
    const events = state.events.filter((e) => e.date);
    if (!events.length) { toast('还没有带日期的日程'); return; }

    const now = new Date();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Spoken to Schedule//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Spoken to Schedule',
    ];

    events.forEach((ev) => {
      const desc = ev.source ? `来源原话：${ev.source}` : '';
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${ev.id}@spoken-to-schedule`);
      lines.push(`DTSTAMP:${icsStamp(now)}`);
      lines.push(`LAST-MODIFIED:${icsStamp(ev.updatedAt ? new Date(ev.updatedAt) : now)}`);
      lines.push(`SEQUENCE:${ev.seq || 0}`);
      if (ev.start) {
        const end = new Date(`${ev.date}T${ev.start}:00`);
        end.setMinutes(end.getMinutes() + (ev.duration || 60));
        lines.push(`DTSTART:${icsDateTime(ev.date, ev.start)}`);
        lines.push(`DTEND:${icsDateTime(ymd(end), `${pad(end.getHours())}:${pad(end.getMinutes())}`)}`);
      } else {
        lines.push(`DTSTART;VALUE=DATE:${ev.date.replace(/-/g, '')}`);
        lines.push(`DTEND;VALUE=DATE:${ydmNext(ev.date)}`);
      }
      lines.push(foldLine(`SUMMARY:${icsEscape(ev.title)}`));
      if (desc) lines.push(foldLine(`DESCRIPTION:${icsEscape(desc)}`));
      if (ev.place) lines.push(foldLine(`LOCATION:${icsEscape(ev.place)}`));
      if (ev.kind === 'deadline') lines.push('CATEGORIES:DEADLINE');
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');

    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `schedule-${ymd(new Date())}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast(`已导出 ${events.length} 条日程`);
  }
  function ydmNext(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return ymd(d);
  }

  $('#btn-export').addEventListener('click', exportICS);
  $('#btn-import-help').addEventListener('click', () => $('#dlg-import').showModal());

  /* ---- 启动 ---- */
  load();
  render();
  if (new URLSearchParams(location.search).get('demo') === '1') loadExamples();

  const buildEl = document.querySelector('.foot .build');
  if (buildEl) buildEl.textContent = '构建 ' + BUILD;

  // 让 README 里的链接能自动填上当前仓库地址
  const gh = document.getElementById('repo-link');
  if (gh && location.hostname.endsWith('github.io')) {
    const user = location.hostname.split('.')[0];
    const repo = location.pathname.split('/').filter(Boolean)[0];
    gh.href = `https://github.com/${user}/${repo}`;
  }
})();
