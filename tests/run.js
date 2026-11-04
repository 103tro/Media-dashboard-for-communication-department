// Автоматичні перевірки дашборда.
//
// Запуск:  cd tests && npm install && npm test
//
// Що робить: піднімає локальний сервер із index.html, відкриває його в справжньому браузері
// (Chromium, часовий пояс Europe/Kyiv) і проходить реальні сценарії — збереження, міграцію
// старих даних, захист від зіпсованого сховища, двох вкладок, імпорту, XSS, дат.
// Бібліотеки, які сайт бере з CDN, підміняються локальними копіями з tests/node_modules.
//
// Нічого з цієї папки не потрапляє на сайт і не змінює сам index.html.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const NM = path.join(__dirname, 'node_modules');
const STORAGE_KEY = 'media_dashboard_v1';
const TABS = ['overview','broadcasts','crosstab','contacts','military','enemy','social','shoots','settings'];

// ---------- мінімальний каркас тестів ----------
const results = [];
let currentGroup = '';
async function test(name, fn){
  const full = `${currentGroup} › ${name}`;
  try{ await fn(); results.push({ok:true, name:full}); console.log('  ✓', name); }
  catch(e){ results.push({ok:false, name:full, err:e}); console.log('  ✗', name, '\n     ', (e && e.message || e).toString().split('\n').join('\n      ')); }
}
function group(name){ currentGroup = name; console.log('\n' + name); }
function assert(cond, msg){ if(!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg){
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if(a !== b) throw new Error(`${msg || 'не збігається'}\n  очікувалось: ${b}\n  отримано:    ${a}`);
}

// ---------- сервер і підміна CDN ----------
function startServer(){
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if(req.url.split('?')[0] === '/' || req.url.startsWith('/index.html')){
        res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
        res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
      } else { res.writeHead(404); res.end(); }
    }).listen(0, '127.0.0.1', () => resolve({srv, url:`http://127.0.0.1:${srv.address().port}/`}));
  });
}
const CDN_MAP = [
  [/chart\.umd\.js/,     path.join(NM, 'chart.js/dist/chart.umd.js')],
  [/xlsx.*\.min\.js/,    path.join(NM, 'xlsx/dist/xlsx.full.min.js')],
  [/pptxgen\.bundle\.js/, path.join(NM, 'pptxgenjs/dist/pptxgen.bundle.js')],
];
async function newContext(browser){
  const ctx = await browser.newContext({timezoneId:'Europe/Kyiv', locale:'uk-UA', acceptDownloads:true});
  await ctx.route(u => !/^http:\/\/127\.0\.0\.1/.test(u.toString()), route => {
    const url = route.request().url();
    const hit = CDN_MAP.find(([re]) => re.test(url));
    if(hit) return route.fulfill({status:200, contentType:'application/javascript', body:fs.readFileSync(hit[1])});
    route.abort(); // шрифти й усе інше зовнішнє не потрібні для логіки
  });
  return ctx;
}
// Відкриває сторінку; initialStorage (рядок) кладеться в localStorage до першого запуску коду сайту.
async function openPage(ctx, url, initialStorage){
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if(m.type()==='error' && !/Failed to load resource|net::ERR/.test(m.text())) page.errors.push('console: '+m.text()); });
  page.on('dialog', d => d.accept());
  if(initialStorage !== undefined){
    await page.goto(url);
    await page.evaluate(([k,v]) => { if(v===null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, [STORAGE_KEY, initialStorage]);
    await page.reload();
  } else {
    await page.goto(url);
  }
  await page.waitForFunction(() => typeof DB !== 'undefined' && DB !== null);
  return page;
}
const lsGet = page => page.evaluate(k => localStorage.getItem(k), STORAGE_KEY);

// ---------- тестові дані ----------
const EMPTY_DB = () => ({broadcasts:[], contacts:[]});
const HOSTILE = '"><img src=x onerror=window.__pwned=1><script>window.__pwned=1</script>';
const HOSTILE_LINK = 'javascript:window.__pwned=1';

(async () => {
  const {srv, url} = await startServer();
  const browser = await chromium.launch();
  let ctx;
  try{
    // =====================================================================
    group('1. Запуск і вкладки');
    ctx = await newContext(browser);
    await test('чиста сторінка запускається без помилок JS', async () => {
      const p = await openPage(ctx, url, null);
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('усі 9 вкладок відкриваються на порожніх даних без помилок', async () => {
      const p = await openPage(ctx, url, null);
      for(const t of TABS) await p.evaluate(t => setTab(t), t);
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('усі 9 вкладок відкриваються на заповнених даних без помилок', async () => {
      const db = {
        broadcasts:[
          {id:'b1', date:'2026-03-05', status:'вийшов', type:'ефір', channel:'Канал А', topic:'Тема', guest:'Гість', journalist:'Журналіст', note:'', topicLink:'https://example.com'},
          {id:'b2', date:'2026-03-09', dateEnd:'2026-03-12', status:'запланований', type:'реклама', medium:['Радіо'], channel:'Канал Б', topic:'Кампанія'},
          {id:'b3', date:'2026-04-02', status:'вийшов', type:'подія', channel:'Подія', topic:'Захід'},
        ],
        contacts:[{id:'c1', region:'Львів', media:'Медіа', name:'Ім’я Прізвище', position:'', phone:'', email:'', projects:[{name:'П', link:'https://example.com'}], cooperation:'', note:''}],
        militaryContacts:[{id:'m1', name:'Особа', unit:'Підрозділ', callsign:'', position:'', phone:'', email:'', note:''}],
        enemyMentions:[{id:'e1', date:'2026-03-01', channel:'Канал', message:'Текст', original:''}],
        socialNetworks:['Facebook'], socialMetrics:{Facebook:['Охоплення']},
        socialStats:[
          {id:'s1', network:'Facebook', month:'2026-01', subscribers:1000, extra:{'Охоплення':500}},
          {id:'s2', network:'Facebook', month:'2026-02', subscribers:1100, extra:{'Охоплення':800}},
        ],
        shoots:[{id:'sh1', title:'Сюжет', type:'відео', stage:'Ідея', contactName:null, notes:'', tasks:[], links:[], order:0, createdAt:'2026-03-01'}],
      };
      const p = await openPage(ctx, url, JSON.stringify(db));
      for(const t of TABS) await p.evaluate(t => setTab(t), t);
      eq(p.errors, [], 'помилки на сторінці');
      eq(await p.evaluate(() => DB.broadcasts.length), 3, 'ефіри не загубились');
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('2. Збереження та відновлення даних');
    ctx = await newContext(browser);
    await test('запис, перезавантаження — дані на місці', async () => {
      const p = await openPage(ctx, url, null);
      const ok = await p.evaluate(async () => {
        DB.broadcasts.unshift({id:'x1', date:'2026-05-05', status:'вийшов', type:'ефір', channel:'Тест', topic:'Збереження'});
        return await saveDB(false);
      });
      assert(ok === true, 'saveDB мав повернути true');
      await p.reload();
      await p.waitForFunction(() => DB !== null);
      eq(await p.evaluate(() => DB.broadcasts.map(b => b.topic)), ['Збереження']);
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('3. Міграція старих даних');
    ctx = await newContext(browser);
    await test('старий формат дозбирається до поточної структури, нічого не губиться', async () => {
      const legacy = {
        broadcasts:[{id:'b1', date:'2025-01-10', channel:'Подкаст "Без броні"', topic:'Старий запис'},
                    {id:'b2', date:'2025-01-11', type:'захід', channel:'X', topic:'Старий захід'}],
        contacts:[{id:'c1', media:'Дивись. інфо', name:'Хтось'}],
        socialNetworks:['Facebook','Instagram'],
        socialMetrics:['Охоплення'],                                     // старий формат: плоский список
        socialStats:[{id:'s1', network:'Facebook', month:'2025-01', subscribers:10, views:77, extra:{'Охоплення':5}}],
        shoots:[{id:'sh1', title:'Зйомка', stage:'Ідея', contactId:'m1'}],
        militaryContacts:[{id:'m1', name:'Ім’я для перевірки'}],
      };
      const p = await openPage(ctx, url, JSON.stringify(legacy));
      eq(p.errors, [], 'помилки на сторінці');
      const r = await p.evaluate(() => ({
        types: DB.broadcasts.map(b => b.type),
        channel: DB.broadcasts[0].channel,
        mediaFixed: DB.contacts[0].media,
        metricsShape: Array.isArray(DB.socialMetrics) ? 'array' : typeof DB.socialMetrics,
        fbMetrics: DB.socialMetrics.Facebook,
        hasViewsField: 'views' in DB.socialStats[0],
        viewsInExtra: DB.socialStats[0].extra['Перегляди'],
        shootContactId: 'contactId' in DB.shoots[0],
        shootContactName: DB.shoots[0].contactName,
        shootType: DB.shoots[0].type,
        hiddenTabs: DB.settings.hiddenTabs,
      }));
      eq(r.types, ['ефір','подія'], 'типи записів');
      eq(r.channel, 'Без броні', 'нормалізація назви каналу');
      eq(r.mediaFixed, 'Дивись.інфо', 'нормалізація назви медіа');
      eq(r.metricsShape, 'object', 'socialMetrics → об’єкт по мережах');
      assert(r.fbMetrics.includes('Охоплення') && r.fbMetrics.includes('Перегляди'), 'метрики Facebook: '+JSON.stringify(r.fbMetrics));
      eq(r.hasViewsField, false, 'поле views прибране');
      eq(r.viewsInExtra, 77, 'views перенесено в Перегляди');
      eq(r.shootContactId, false, 'contactId прибрано');
      eq(r.shootContactName, 'Ім’я для перевірки', 'ім’я контакту підтягнуто');
      eq(r.shootType, 'відео', 'тип зйомки за замовчуванням');
      eq(r.hiddenTabs, [], 'hiddenTabs');
      await p.close();
    });
    await test('normalizeGuestField чистить список гостей і нічого не підміняє', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => ({
        a: normalizeGuestField('  Перший  ,, Другий ,'),
        b: normalizeGuestField('Евген Прізвище'),   // раніше "відомі варіанти" виправлялись; тепер текст лишається як ввели
        empty: normalizeGuestField(''), nul: normalizeGuestField(null),
        noAliasTable: typeof GUEST_ALIASES,
      }));
      eq(r.a, 'Перший, Другий'); eq(r.b, 'Евген Прізвище');
      eq([r.empty, r.nul], ['', null]);
      eq(r.noAliasTable, 'undefined', 'таблиця з іменами має бути прибрана з коду');
      await p.close();
    });
    await test('міграція ідемпотентна: повторне завантаження нічого не змінює', async () => {
      const p = await openPage(ctx, url);   // дані вже мігровані й збережені попереднім тестом? — зберігаємо явно
      await p.evaluate(() => saveDB(false));
      const first = await lsGet(p);
      await p.reload(); await p.waitForFunction(() => DB !== null);
      await p.evaluate(() => saveDB(false));
      const second = await lsGet(p);
      eq(second, first, 'після другого завантаження дані відрізняються');
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('4. Зіпсоване сховище не перезаписується');
    ctx = await newContext(browser);
    for(const [label, raw] of [['не-JSON', 'це не json{'], ['чужа структура', JSON.stringify({hello:'world'})]]){
      await test(`${label}: дані лишаються недоторканими, збереження вимкнене`, async () => {
        const p = await openPage(ctx, url, raw);
        assert(await p.evaluate(() => storageLocked) === true, 'storageLocked має бути true');
        eq(await lsGet(p), raw, 'вміст сховища змінено!');
        const saved = await p.evaluate(() => saveDB(false));
        eq(saved, false, 'saveDB не має писати при блокуванні');
        eq(await lsGet(p), raw, 'вміст сховища змінено після спроби збереження!');
        await p.close();
      });
    }
    await ctx.close();

    // =====================================================================
    group('5. Дві вкладки не затирають одна одну');
    ctx = await newContext(browser);
    await test('застаріла вкладка не перезаписує свіжі дані іншої', async () => {
      const a = await openPage(ctx, url, null);
      const b = await openPage(ctx, url);
      await a.evaluate(async () => { DB.broadcasts.unshift({id:'fromA', date:'2026-06-01', status:'вийшов', type:'ефір', channel:'A', topic:'Від вкладки A'}); return saveDB(false); });
      const bSaved = await b.evaluate(async () => { DB.broadcasts.unshift({id:'fromB', date:'2026-06-02', status:'вийшов', type:'ефір', channel:'B', topic:'Від вкладки B'}); return saveDB(false); });
      eq(bSaved, false, 'вкладка B не мала зберегти');
      const stored = JSON.parse(await lsGet(a));
      eq(stored.broadcasts.map(x => x.id), ['fromA'], 'у сховищі мають бути лише дані вкладки A');
      await a.close(); await b.close();
    });
    await ctx.close();

    // =====================================================================
    group('6. Імпорт резервної копії');
    ctx = await newContext(browser);
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'md-tests-'));
    const writeTmp = (name, obj) => { const f = path.join(tmp, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
    await test('імпорт: спершу віддає копію старих даних, потім замінює; вигляд (settings) зберігається', async () => {
      const old = {...EMPTY_DB(), broadcasts:[{id:'old1', date:'2026-01-01', status:'вийшов', type:'ефір', channel:'Старий', topic:'Старі дані'}], settings:{hiddenTabs:['enemy'], accent:'#123456'}};
      const p = await openPage(ctx, url, JSON.stringify(old));
      const incoming = writeTmp('in.json', {...EMPTY_DB(), broadcasts:[{id:'new1', date:'2026-02-02', status:'вийшов', type:'ефір', channel:'Новий', topic:'Нові дані'}], settings:{hiddenTabs:[], accent:'#ffffff'}});
      const dl = p.waitForEvent('download');
      await p.setInputFiles('#importFile', incoming);
      const d = await dl;
      assert(/^before-import-\d{4}-\d{2}-\d{2}\.json$/.test(d.suggestedFilename()), 'ім’я файлу копії: '+d.suggestedFilename());
      const copy = JSON.parse(fs.readFileSync(await d.path(), 'utf8'));
      eq(copy.broadcasts.map(b => b.id), ['old1'], 'копія має містити СТАРІ дані');
      await p.waitForFunction(() => DB.broadcasts.length === 1 && DB.broadcasts[0].id === 'new1');
      eq(await p.evaluate(() => DB.settings.hiddenTabs), ['enemy'], 'налаштування вигляду не мають змінитись');
      eq(JSON.parse(await lsGet(p)).broadcasts.map(b => b.id), ['new1'], 'нові дані мають бути збережені');
      await p.close();
    });
    await test('імпорт: файл неправильної форми відхиляється, дані та сховище не змінюються', async () => {
      const p = await openPage(ctx, url, JSON.stringify({...EMPTY_DB(), broadcasts:[{id:'keep', date:'2026-01-01', type:'ефір', channel:'К', topic:'Лишається'}]}));
      const before = await lsGet(p);
      let downloaded = false; p.on('download', () => downloaded = true);
      await p.setInputFiles('#importFile', writeTmp('bad.json', {broadcasts:'не масив', contacts:[]}));
      await p.waitForTimeout(600);
      eq(await lsGet(p), before, 'сховище змінилось');
      eq(downloaded, false, 'не мало бути завантажень');
      eq(await p.evaluate(() => DB.broadcasts.map(b => b.id)), ['keep']);
      await p.close();
    });
    await test('validateBackupShape: приймає нормальне, відхиляє сміття', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => {
        const t = x => { try{ validateBackupShape(x); return true; }catch(e){ return false; } };
        return {
          ok: t({broadcasts:[], contacts:[]}),
          nul: t(null), arr: t([]), str: t('x'),
          noContacts: t({broadcasts:[]}),
          badRow: t({broadcasts:[1], contacts:[]}),
          badOptional: t({broadcasts:[], contacts:[], shoots:'x'}),
          badObj: t({broadcasts:[], contacts:[], socialMetrics:null}),
        };
      });
      eq(r, {ok:true, nul:false, arr:false, str:false, noContacts:false, badRow:false, badOptional:false, badObj:false});
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('7. Безпека: ворожі дані не виконуються');
    ctx = await newContext(browser);
    await test('шкідливі рядки в усіх типах записів нічого не виконують на жодній вкладці', async () => {
      const db = {
        broadcasts:[{id:'b1', date:'2026-03-05', status:'вийшов', type:'ефір', channel:HOSTILE, topic:HOSTILE, guest:HOSTILE, journalist:HOSTILE, note:HOSTILE,
                     topicLink:HOSTILE_LINK, noteLink:HOSTILE_LINK, fileLink:HOSTILE_LINK, photoLink:HOSTILE_LINK},
                    {id:'b2', date:HOSTILE, status:HOSTILE, type:'ефір', channel:'k', topic:'t'},
                    {id:'b3', date:'2026-03-06', status:'вийшов', type:'інтерв\'ю', channel:HOSTILE, topic:HOSTILE, guest:HOSTILE, note:HOSTILE, topicLink:HOSTILE_LINK},
                    {id:'b4', date:'2026-03-07', status:'вийшов', type:'стаття', channel:HOSTILE, topic:HOSTILE, guest:HOSTILE, note:HOSTILE, topicLink:HOSTILE_LINK},
                    {id:'b5', date:'2026-03-08', status:'вийшов', type:HOSTILE, channel:'k', topic:'t'}],
        contacts:[{id:'c1', region:HOSTILE, media:HOSTILE, name:HOSTILE, position:HOSTILE, phone:HOSTILE, email:HOSTILE, mediaLink:HOSTILE_LINK, nameLink:HOSTILE_LINK,
                   projects:[{name:HOSTILE, link:HOSTILE_LINK}], cooperation:HOSTILE, note:HOSTILE}],
        militaryContacts:[{id:'m1', name:HOSTILE, unit:HOSTILE, subunit:HOSTILE, callsign:HOSTILE, position:HOSTILE, phone:HOSTILE, email:HOSTILE, note:HOSTILE, noteLink:HOSTILE_LINK, nameLink:HOSTILE_LINK, unitLink:HOSTILE_LINK}],
        enemyMentions:[{id:'e1', date:'2026-03-01', channel:HOSTILE, message:HOSTILE, messageLink:HOSTILE_LINK, original:HOSTILE, originalLink:HOSTILE_LINK}],
        socialNetworks:[HOSTILE], socialMetrics:{[HOSTILE]:[HOSTILE]},
        socialStats:[{id:'s1', network:HOSTILE, month:'2026-01', subscribers:5, extra:{[HOSTILE]:3}}],
        shoots:[{id:'sh1', title:HOSTILE, type:'відео', stage:'Ідея', contactName:HOSTILE, notes:HOSTILE, color:'red;background:url(javascript:1)', tasks:[{id:'t1', text:HOSTILE, done:false}], links:[{label:HOSTILE, url:HOSTILE_LINK}], order:0}],
        shootStages:['Ідея', HOSTILE], extraUnits:[HOSTILE], adMediums:[HOSTILE],
        channelGroups:{[HOSTILE]:HOSTILE},
        settings:{hiddenTabs:[], sidebarColor:'red;background:url(javascript:1)'},
      };
      const p = await openPage(ctx, url, JSON.stringify(db));
      for(const t of TABS) { await p.evaluate(t => setTab(t), t); await p.waitForTimeout(40); }
      const r = await p.evaluate(() => ({
        pwned: window.__pwned,
        injectedImg: document.querySelectorAll('img[src="x"]').length,
        jsLinks: document.querySelectorAll('a[href^="javascript:" i]').length,
        injectedScript: Array.from(document.scripts).filter(s => s.textContent.includes('__pwned=1') && !s.textContent.includes('function ')).length,
      }));
      eq(r, {pwned:undefined, injectedImg:0, jsLinks:0, injectedScript:0}, 'на сторінці щось виконалось або вставилось');
      await p.close();
    });
    await test('esc / attr / safeUrl / safeHref / safeColor', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => ({
        esc: esc('<b>"&\'</b>'),
        attr: attr('"x" onmouseover="y"'),
        ok1: safeUrl('https://a.b/c'), ok2: safeUrl('mailto:a@b.c'), ok3: safeUrl('tel:+380'),
        bad1: safeUrl('javascript:alert(1)'), bad2: safeUrl('java\tscript:alert(1)'), bad3: safeUrl('  JaVaScRiPt:alert(1)'),
        bad4: safeUrl('data:text/html,<script>1</script>'), bad5: safeUrl('vbscript:x'), bad6: safeUrl('​javascript:x'),
        href: safeHref('javascript:alert(1)'),
        color: [safeColor('#fff'), safeColor('#a1b2c3'), safeColor('red'), safeColor('#fff;x:y'), safeColor('url(x)'), safeColor(null)],
      }));
      eq(r.esc, '&lt;b&gt;&quot;&amp;&#39;&lt;/b&gt;');
      assert(!r.attr.includes('"x"'), 'attr не екранував лапки: '+r.attr);
      eq([r.ok1, r.ok2, r.ok3], ['https://a.b/c', 'mailto:a@b.c', 'tel:+380']);
      eq([r.bad1, r.bad2, r.bad3, r.bad4, r.bad5, r.bad6], ['','','','','','']);
      eq(r.href, 'about:blank');
      eq(r.color, ['#fff', '#a1b2c3', '', '', '', '']);
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('8. Дати у часовому поясі Києва');
    ctx = await newContext(browser);
    await test('localISO не зсуває день (00:30 за Києвом лишається тим самим днем)', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => ({
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        morning: localISO(new Date(2026, 0, 1, 0, 30)),      // у UTC це ще 31 грудня
        evening: localISO(new Date(2026, 5, 15, 23, 59)),
        utcWouldBe: new Date(2026, 0, 1, 0, 30).toISOString().slice(0,10),
      }));
      assert(/^Europe\/(Kyiv|Kiev)$/.test(r.tz), 'часовий пояс має бути київський, а не '+r.tz);
      eq(r.morning, '2026-01-01');
      eq(r.evening, '2026-06-15');
      assert(r.utcWouldBe !== r.morning, 'тест нічого не доводить: UTC і локальна дата збіглись');
      await p.close();
    });
    await test('parseUaDate / fmtDate', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => ({
        a: parseUaDate('05.03.2026'), leap: parseUaDate('29.02.2028'), notLeap: parseUaDate('29.02.2027'),
        feb31: parseUaDate('31.02.2026'), junk: parseUaDate('abc'), us: parseUaDate('03/05/2026'), empty: parseUaDate(''),
        f1: fmtDate('2026-03-05'), f2: fmtDate(''), f3: fmtDate('<b>x</b>'),
      }));
      eq(r.a, '2026-03-05'); eq(r.leap, '2028-02-29');
      eq([r.notLeap, r.feb31, r.junk, r.us, r.empty], [null, null, null, null, null]);
      eq(r.f1, '05.03.2026'); eq(r.f2, '—');
      assert(!/[<>]/.test(r.f3), 'fmtDate пропустив розмітку: '+r.f3);
      await p.close();
    });
    await test('дати з Excel: серійний номер читається як календарна дата, без зсуву', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => {
        // 46086 = 2026-03-05 (епоха Excel 1899-12-30)
        const ws = XLSX.utils.aoa_to_sheet([['Дата'], [46086]]);
        ws['A2'].t = 'n'; ws['A2'].z = 'dd.mm.yyyy';
        const parsed = XLSX.SSF.parse_date_code(46086);
        return {y:parsed.y, m:parsed.m, d:parsed.d, viaApp: typeof parseImportedDate === 'function' ? parseImportedDate(46086) : null};
      });
      eq([r.y, r.m, r.d], [2026, 3, 5]);
      if(r.viaApp) eq(r.viaApp, '2026-03-05', 'parseImportedDate(46086)');
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('9. Створення запису через форму (наскрізний сценарій)');
    ctx = await newContext(browser);
    await test('додати ворожу згадку через модальне вікно → зберігається і видно в таблиці', async () => {
      const p = await openPage(ctx, url, null);
      await p.evaluate(() => setTab('enemy'));
      const opener = await p.evaluate(() => typeof openEnemyModal === 'function' ? 'openEnemyModal' : null);
      if(!opener){ console.log('     (пропущено: не знайдено функції відкриття форми)'); await p.close(); return; }
      await p.evaluate(() => openEnemyModal());
      await p.fill('#e_channel', 'Тестовий канал');
      await p.fill('#e_message', 'Тестове повідомлення');
      await p.evaluate(() => saveEnemy());
      await p.waitForFunction(() => DB.enemyMentions.length === 1);
      assert((await lsGet(p)).includes('Тестове повідомлення'), 'запис не потрапив у сховище');
      assert((await p.locator('#enemySub').innerText()).startsWith('1 записів'), 'лічильник у заголовку вкладки не оновився');
      await p.locator('#enemyGroups .media-head').first().click();          // місяці за задумом згорнуті
      await p.waitForSelector('#enemyGroups .media-body:not(.hidden)');
      assert((await p.locator('#enemyGroups').innerText()).includes('Тестове повідомлення'), 'запис не видно у вкладці після розгортання місяця');
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('10. Помилки не мовчать: користувач бачить пояснення');
    ctx = await newContext(browser);
    const toastText = p => p.evaluate(() => document.getElementById('toast').textContent);
    const toastShown = p => p.evaluate(() => document.getElementById('toast').classList.contains('show'));
    // сторінка навмисно ламається, тож помилки в консолі тут очікувані — перевіряємо лише поведінку
    await test('guarded(): збій дії → зрозумілий тост, виняток не летить далі', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(async () => {
        const v = await guarded('Не вийшло', async () => { throw new Error('boom'); });
        return {v: v === undefined};
      });
      assert(r.v, 'guarded мав повернути undefined');
      eq(await toastText(p), 'Не вийшло'); assert(await toastShown(p), 'тост не показано');
      await p.close();
    });
    await test('необроблена помилка й відхилений проміс → тост, не частіше за раз на кілька секунд', async () => {
      const p = await openPage(ctx, url, null);
      await p.evaluate(() => { setTimeout(() => { throw new Error('uncaught-1'); }, 0); });
      await p.waitForFunction(() => document.getElementById('toast').textContent.startsWith('Щось пішло не так'));
      await p.evaluate(() => { document.getElementById('toast').textContent = 'порожньо'; Promise.reject(new Error('rejected-2')); });
      await p.waitForTimeout(200);
      eq(await toastText(p), 'порожньо', 'друга помилка одразу після першої не мала знову засипати екран');
      await p.close();
    });
    await test('звіт: збій під час формування → повідомлення, а не вічне «Формую звіт…»', async () => {
      const db = {lastBackupAt:new Date().toISOString(), contacts:[], broadcasts:[{id:'b1', date:'2026-03-05', status:'done', type:'ефір', channel:'К', topic:'Т'}]};
      const p = await openPage(ctx, url, JSON.stringify(db));
      await p.evaluate(() => { generateReport = async () => { showToast('Формую звіт…'); throw new Error('boom'); }; openReportPeriodModal(); });
      await p.evaluate(() => document.getElementById('reportPeriodGenerateBtn').click());
      await p.waitForFunction(() => document.getElementById('toast').textContent.startsWith('Не вдалося сформувати звіт'));
      await p.close();
    });
    await test('звіт: справжній .pptx формується й завантажується', async () => {
      const db = {lastBackupAt:new Date().toISOString(), contacts:[], broadcasts:[
        {id:'b1', date:'2026-03-05', status:'done', type:'ефір', channel:'Канал А', topic:'Тема 1', guest:'Гість'},
        {id:'b2', date:'2026-03-12', status:'done', type:'ефір', channel:'Канал Б', topic:'Тема 2'},
      ]};
      const p = await openPage(ctx, url, JSON.stringify(db));
      await p.evaluate(() => openReportPeriodModal());
      const [dl] = await Promise.all([
        p.waitForEvent('download', {timeout: 60000}),
        p.evaluate(() => document.getElementById('reportPeriodGenerateBtn').click()),
      ]);
      assert(/^zvit-.*\.pptx$/.test(dl.suggestedFilename()), 'ім\'я файлу: ' + dl.suggestedFilename());
      await p.close();
    });
    await test('звіт: якщо виправлення пакета впало — файл усе одно завантажується', async () => {
      const db = {lastBackupAt:new Date().toISOString(), contacts:[], broadcasts:[{id:'b1', date:'2026-03-05', status:'done', type:'ефір', channel:'К', topic:'Т'}]};
      const p = await openPage(ctx, url, JSON.stringify(db));
      await p.evaluate(() => { patchPptxPackage = async () => { throw new Error('zip broke'); }; openReportPeriodModal(); });
      const [dl] = await Promise.all([
        p.waitForEvent('download', {timeout: 60000}),
        p.evaluate(() => document.getElementById('reportPeriodGenerateBtn').click()),
      ]);
      assert(/\.pptx$/.test(dl.suggestedFilename()), 'файл не завантажився');
      await p.close();
    });
    await test('імпорт Excel: пошкоджений файл → зрозуміле повідомлення, нічого не змінюється', async () => {
      const p = await openPage(ctx, url, null);
      const before = await p.evaluate(() => JSON.stringify(DB.contacts));
      await p.evaluate(async () => {
        const broken = new File([new Uint8Array([0x50,0x4b,0x03,0x04,1,2,3,4,5,6,7,8])], 'x.xlsx');
        await handleImportFile('contacts', broken);
      });
      assert(/^(Не вдалося прочитати файл|Файл захищений паролем або пошкоджений)/.test(await toastText(p)), 'повідомлення: ' + await toastText(p));
      eq(await p.evaluate(() => JSON.stringify(DB.contacts)), before, 'дані змінились');
      assert(!(await p.evaluate(() => document.getElementById('importMapModal').classList.contains('open'))), 'вікно зіставлення не мало відкритись');
      await p.close();
    });
    await test('імпорт бекапу: не-JSON і чужа форма дають різні, чесні повідомлення; дані не змінюються', async () => {
      const p = await openPage(ctx, url, JSON.stringify({contacts:[], broadcasts:[{id:'b1', date:'2026-03-05', status:'done', type:'ефір', channel:'К', topic:'Збережене'}]}));
      const before = await lsGet(p);
      const feed = async (content) => {
        await p.setInputFiles('#importFile', {name:'b.json', mimeType:'application/json', buffer:Buffer.from(content)});
        await p.waitForTimeout(250);
      };
      await feed('{ це не json');
      assert((await toastText(p)).includes('пошкоджений'), 'для не-JSON: ' + await toastText(p));
      await feed(JSON.stringify({hello:'world'}));
      assert((await toastText(p)).includes('не схожий на резервну копію'), 'для чужої форми: ' + await toastText(p));
      eq(await lsGet(p), before, 'сховище змінилось');
      await p.close();
    });
    await test('extLink / emptyStateHtml: безпечні адреси — посилання, небезпечні — звичайний текст, усе екранується', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => ({
        ok: extLink('https://a.b/c', '<i>x</i>'),
        js: extLink('javascript:alert(1)', '<i>x</i>'),
        none: extLink('', 'просто'),
        empty: emptyStateHtml('<b>Нічого</b>'),
      }));
      assert(r.ok.startsWith('<a href="https://a.b/c"') && r.ok.includes('rel="noopener"') && r.ok.includes('&lt;i&gt;x&lt;/i&gt;'), r.ok);
      eq(r.js, '&lt;i&gt;x&lt;/i&gt;'); eq(r.none, 'просто');
      assert(r.empty.includes('empty-state') && r.empty.includes('&lt;b&gt;') && !r.empty.includes('<b>'), r.empty);
      await p.close();
    });
    await test('після розбиття wireEvents кнопки працюють: відкрити й закрити вікно запису', async () => {
      const p = await openPage(ctx, url, null);
      await p.evaluate(() => setTab('enemy'));
      await p.click('#addEnemyBtn');
      assert(await p.evaluate(() => document.getElementById('enemyModal').classList.contains('open')), 'вікно не відкрилось');
      await p.click('#enemyModalClose');
      assert(!(await p.evaluate(() => document.getElementById('enemyModal').classList.contains('open'))), 'вікно не закрилось');
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('11. Група каналів прямо у формі запису');
    ctx = await newContext(browser);
    const bc = (id, channel, extra) => ({id, date:'2026-03-05', status:'done', type:'ефір', channel, topic:'Тема '+id, ...(extra||{})});
    const groupDb = () => JSON.stringify({
      contacts:[],
      broadcasts:[bc('b1','Суспільне Львів'), bc('b2','Суспільне Львів'), bc('b3','Радіо Без Групи')],
      channelGroups:{'суспільне львів':'Суспільне', 'суспільне суми':'Суспільне', 'радіо волинь':'Волинь'},
    });
    const hintText = p => p.evaluate(() => document.getElementById('f_channelGroupHint').textContent);
    await test('нове ЗМІ з новою групою: група створюється, зберігається і видна у вікні «Групи каналів»', async () => {
      const p = await openPage(ctx, url, groupDb());
      await p.evaluate(() => openBroadcastModal());
      await p.fill('#f_channel', 'Нове Радіо Захід');
      assert((await hintText(p)).includes('Нове ЗМІ'), 'підказка для нового ЗМІ: ' + await hintText(p));
      await p.fill('#f_channelGroup', 'Закарпаття');
      assert((await hintText(p)).includes('нову групу'), 'підказка про нову групу: ' + await hintText(p));
      await p.evaluate(() => saveBroadcast());
      await p.waitForFunction(() => DB.broadcasts.length === 4);
      eq(await p.evaluate(() => DB.channelGroups['нове радіо захід']), 'Закарпаття');
      eq(await p.evaluate(() => channelGroupOf('Нове Радіо Захід')), 'Закарпаття');
      assert((await lsGet(p)).includes('Закарпаття'), 'група не потрапила у сховище');
      await p.evaluate(() => openChannelGroupsModal());
      assert((await p.locator('#channelGroupsRows').innerText()).includes('Нове Радіо Захід'), 'у вікні груп немає нового ЗМІ');
      eq(await p.locator('#channelGroupsRows .group-input[data-channel="Нове Радіо Захід"]').inputValue(), 'Закарпаття', 'група в рядку цього ЗМІ у вікні груп');
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('відоме ЗМІ: група підставляється сама (будь-який регістр), для ЗМІ без групи поле порожнє', async () => {
      const p = await openPage(ctx, url, groupDb());
      await p.evaluate(() => openBroadcastModal());
      await p.fill('#f_channel', 'суспільне львів');
      eq(await p.inputValue('#f_channelGroup'), 'Суспільне');
      await p.fill('#f_channel', 'Радіо Без Групи');
      eq(await p.inputValue('#f_channelGroup'), '');
      assert((await hintText(p)).includes('без групи'), 'підказка: ' + await hintText(p));
      await p.fill('#f_channel', 'Зовсім Нове');
      eq(await p.inputValue('#f_channelGroup'), '');
      await p.close();
    });
    await test('редагування запису: група каналу вже у полі, збереження без змін нічого не ламає', async () => {
      const p = await openPage(ctx, url, groupDb());
      await p.evaluate(() => openBroadcastModal('b1'));
      eq(await p.inputValue('#f_channelGroup'), 'Суспільне');
      const before = await p.evaluate(() => JSON.stringify(DB.channelGroups));
      await p.evaluate(() => saveBroadcast());
      await p.waitForFunction(() => !document.getElementById('broadcastModal').classList.contains('open'));
      eq(await p.evaluate(() => JSON.stringify(DB.channelGroups)), before, 'групи змінились без причини');
      await p.close();
    });
    await test('група, яка вже існує, береться в її написанні (без дублів «суспільне» / «Суспільне»)', async () => {
      const p = await openPage(ctx, url, groupDb());
      await p.evaluate(() => openBroadcastModal());
      await p.fill('#f_channel', 'Суспільне Ранок');
      await p.fill('#f_channelGroup', '  суспільне ');
      await p.evaluate(() => saveBroadcast());
      await p.waitForFunction(() => DB.broadcasts.length === 4);
      eq(await p.evaluate(() => DB.channelGroups['суспільне ранок']), 'Суспільне');
      await p.close();
    });
    await test('порожня група для нового ЗМІ: запис зберігається, група не призначається', async () => {
      const p = await openPage(ctx, url, groupDb());
      await p.evaluate(() => openBroadcastModal());
      await p.fill('#f_channel', 'Канал Без Групи Новий');
      await p.evaluate(() => saveBroadcast());
      await p.waitForFunction(() => DB.broadcasts.length === 4);
      eq(await p.evaluate(() => 'канал без групи новий' in DB.channelGroups), false);
      await p.close();
    });
    await test('зміна групи відомого ЗМІ попереджає про всі записи каналу; очищення поля прибирає групу', async () => {
      const p = await openPage(ctx, url, groupDb());
      await p.evaluate(() => openBroadcastModal('b1'));
      await p.fill('#f_channelGroup', 'Львівщина');
      const h = await hintText(p);
      assert(h.includes('2') && h.includes('змін'), 'попередження про 2 записи: ' + h);
      await p.evaluate(() => saveBroadcast());
      await p.waitForFunction(() => DB.channelGroups['суспільне львів'] === 'Львівщина');
      await p.evaluate(() => openBroadcastModal('b1'));
      await p.fill('#f_channelGroup', '');
      await p.evaluate(() => saveBroadcast());
      await p.waitForFunction(() => !('суспільне львів' in DB.channelGroups));
      await p.close();
    });
    await test('поле «Група» при фокусі показує наявні групи, клік по підказці вставляє її', async () => {
      const p = await openPage(ctx, url, groupDb());
      await p.evaluate(() => openBroadcastModal());
      await p.click('#f_channelGroup');
      await p.waitForSelector('#f_channelGroupAutocomplete:not(.hidden) .multi-name-option');
      const opts = await p.locator('#f_channelGroupAutocomplete .multi-name-option').allInnerTexts();
      eq(opts.slice().sort(), ['Волинь','Суспільне'], 'список груп (без дублів)');
      await p.locator('#f_channelGroupAutocomplete .multi-name-option', {hasText:'Волинь'}).dispatchEvent('mousedown');
      eq(await p.inputValue('#f_channelGroup'), 'Волинь');
      await p.close();
    });
    await test('вибір каналу з підказки теж підтягує його групу', async () => {
      const p = await openPage(ctx, url, groupDb());
      await p.evaluate(() => openBroadcastModal());
      await p.fill('#f_channel', 'Суспільне Л');
      await p.waitForSelector('#f_channelAutocomplete:not(.hidden) .multi-name-option');
      await p.locator('#f_channelAutocomplete .multi-name-option').first().dispatchEvent('mousedown');
      eq(await p.inputValue('#f_channelGroup'), 'Суспільне');
      await p.close();
    });
    await test('ворожа назва групи: ніде не виконується (форма, підказки, вікно груп)', async () => {
      const db = JSON.stringify({contacts:[], broadcasts:[bc('b1','Канал Х')], channelGroups:{}});
      const p = await openPage(ctx, url, db);
      await p.evaluate(() => openBroadcastModal('b1'));
      await p.fill('#f_channelGroup', HOSTILE);
      await p.evaluate(() => saveBroadcast());
      await p.waitForFunction(() => Object.keys(DB.channelGroups).length === 1);
      await p.evaluate(() => { openBroadcastModal(); });
      await p.fill('#f_channel', 'Інший');
      await p.click('#f_channelGroup');
      await p.evaluate(() => { openChannelGroupsModal(); });
      await p.waitForTimeout(150);
      eq(await p.evaluate(() => window.__pwned), undefined, 'виконався код з назви групи');
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('12. Типи матеріалів: ефір / інтерв\'ю / стаття');
    ctx = await newContext(browser);
    const mk = (id, type, date, extra) => ({id, date:date||'2026-03-05', status:'done', type, channel:'Канал '+id, topic:'Тема '+id, ...(extra||{})});
    const typesDb = () => JSON.stringify({contacts:[], broadcasts:[
      mk('e1','ефір'), mk('e2','ефір','2026-04-03'),
      mk('i1','інтерв\'ю'),
      mk('s1','стаття'), mk('s2','стаття','2026-04-10'), mk('s3','стаття','2026-04-11'),
      mk('p1','подія'),
    ]});
    const cardValue = (p, label) => p.evaluate(l => {
      const c = Array.from(document.querySelectorAll('#statCards .stat-card')).find(el => el.querySelector('.stat-label').textContent.trim() === l);
      return c ? c.querySelector('.stat-value').textContent.trim() : null;
    }, label);
    await test('у формі п\'ять типів у правильному порядку', async () => {
      const p = await openPage(ctx, url, typesDb());
      await p.evaluate(() => openBroadcastModal());
      eq(await p.evaluate(() => Array.from(document.getElementById('f_type').options).map(o => o.value)), ['ефір','інтерв\'ю','стаття','подія','реклама']);
      eq(await p.evaluate(() => document.getElementById('f_type').options[0].textContent), 'Ефір (радіо/ТБ)');
      await p.close();
    });
    await test('інтерв\'ю й стаття зберігаються через форму зі своїм типом і поводяться як звичайний матеріал', async () => {
      const p = await openPage(ctx, url, typesDb());
      for(const [t, name] of [['інтерв\'ю','Нове інтерв\'ю'], ['стаття','Нова стаття']]){
        await p.evaluate(() => openBroadcastModal());
        await p.selectOption('#f_type', t);
        // як у звичайного ефіру: можна прив'язати до події, немає полів реклами та списку пов'язаних
        eq(await p.evaluate(() => [document.getElementById('f_eventLinkWrap').style.display, document.getElementById('f_linkedBroadcastsWrap').style.display, document.getElementById('f_mediumWrap').style.display]), ['', 'none', 'none'], 'видимість полів для ' + t);
        await p.fill('#f_channel', name);
        await p.fill('#f_topic', 'Тема ' + t);
        await p.evaluate(() => saveBroadcast());
        await p.waitForFunction(n => DB.broadcasts.some(b => b.channel === n), name);
      }
      eq(await p.evaluate(() => DB.broadcasts.filter(b => /^Нов/.test(b.channel)).map(b => b.type).sort()), ['стаття','інтерв\'ю']);
      await p.evaluate(() => openBroadcastModal(DB.broadcasts.find(b => b.channel === 'Нова стаття').id));
      eq(await p.inputValue('#f_type'), 'стаття', 'при редагуванні тип підставляється');
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('огляд: картки рахують ефіри, інтерв\'ю й статті окремо', async () => {
      const p = await openPage(ctx, url, typesDb());
      await p.evaluate(() => setTab('overview'));
      eq([await cardValue(p,'Ефірів'), await cardValue(p,'Інтерв\'ю'), await cardValue(p,'Статей'), await cardValue(p,'Подій')], ['2','1','3','1']);
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('огляд: місячний і річний графіки мають серії інтерв\'ю та статей з правильними числами', async () => {
      const p = await openPage(ctx, url, typesDb());
      await p.evaluate(() => setTab('overview'));
      const ds = await p.evaluate(() => ({
        m: monthlyChart.data.datasets.map(d => [d.label, d.data]),
        y: yearlyChart.data.datasets.map(d => [d.label, d.data]),
        sub: document.getElementById('chartMonthlySub').textContent,
      }));
      eq(ds.m, [['Ефіри',[1,1]], ['Інтерв\'ю',[1,0]], ['Статті',[1,2]], ['Події',[1,0]]], 'місячний графік');
      eq(ds.y, [['Ефіри',[2]], ['Інтерв\'ю',[1]], ['Статті',[3]], ['Події',[1]]], 'річний графік');
      assert(/інтерв.ю/i.test(ds.sub) && /статті/i.test(ds.sub), 'підпис під графіком: ' + ds.sub);
      await p.close();
    });
    await test('огляд: коли інтерв\'ю й статей немає — графіки та підпис як раніше', async () => {
      const db = JSON.stringify({contacts:[], broadcasts:[mk('e1','ефір'), mk('p1','подія')]});
      const p = await openPage(ctx, url, db);
      await p.evaluate(() => setTab('overview'));
      eq(await p.evaluate(() => monthlyChart.data.datasets.map(d => d.label)), ['Ефіри','Події']);
      eq(await p.evaluate(() => document.getElementById('chartMonthlySub').textContent.startsWith('Ефіри та події')), true);
      eq([await cardValue(p,'Інтерв\'ю'), await cardValue(p,'Статей')], ['0','0'], 'картки показують 0');
      await p.close();
    });
    await test('старі записи без нових типів лишаються ефірами', async () => {
      const p = await openPage(ctx, url, JSON.stringify({contacts:[], broadcasts:[mk('o1','ефір'), {id:'o2', date:'2026-01-02', status:'done', channel:'К', topic:'Без типу'}]}));
      eq(await p.evaluate(() => DB.broadcasts.map(b => b.type)), ['ефір','ефір']);
      await p.close();
    });
    await test('вкладка «Ефіри»: фільтр за інтерв\'ю та статтею, позначка типу в рядку', async () => {
      const p = await openPage(ctx, url, typesDb());
      await p.evaluate(() => setTab('broadcasts'));
      eq(await p.evaluate(() => Array.from(document.getElementById('filterType').options).map(o => o.value)), ['all','ефір','інтерв\'ю','стаття','подія','реклама']);
      for(const [t, n] of [['інтерв\'ю',1], ['стаття',3], ['ефір',2]]){
        await p.selectOption('#filterType', t);
        eq(await p.locator('#broadcastGroups tr[data-id]').count(), n, 'рядків для ' + t);
      }
      await p.selectOption('#filterType', 'стаття');
      const note = await p.locator('#broadcastGroups tr[data-id]').first().innerText();
      assert(note.includes('стаття'), 'у рядку немає позначки «стаття»: ' + note);
      await p.selectOption('#filterType', 'інтерв\'ю');
      assert((await p.locator('#broadcastGroups tr[data-id]').first().innerText()).includes('інтерв\'ю'), 'у рядку немає позначки «інтерв\'ю»');
      await p.close();
    });
    // без позначки про свіжу резервну копію перед звітом спершу вивантажується нагадувальний бекап
    const withBackupStamp = json => JSON.stringify({...JSON.parse(json), lastBackupAt:new Date().toISOString()});
    const reportText = async (p) => {
      const [dl] = await Promise.all([
        p.waitForEvent('download', {timeout: 60000}),
        p.evaluate(() => generateReport('all', '')),
      ]);
      const file = path.join(require('os').tmpdir(), 'types-report-' + Date.now() + '.pptx');
      await dl.saveAs(file);
      const out = require('child_process').execFileSync('python3', ['-I', '-c',
        'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nsys.stdout.buffer.write("\\n".join(z.read(n).decode("utf-8","ignore") for n in z.namelist() if n.startswith("ppt/charts/chart") and n.endswith(".xml")).encode())', file], {maxBuffer: 64*1024*1024}).toString('utf8');
      fs.unlinkSync(file);
      return out;
    };
    await test('звіт: у графіках є «Інтерв\'ю» та «Статті», коли такі матеріали є', async () => {
      const p = await openPage(ctx, url, withBackupStamp(typesDb()));
      const xml = await reportText(p);
      assert(/Інтерв(&apos;|')ю/.test(xml), 'у графіках звіту немає «Інтерв\'ю»');
      assert(xml.includes('Статті'), 'у графіках звіту немає «Статті»');
      assert(xml.includes('Ефіри') && xml.includes('Події'), 'зникли «Ефіри»/«Події»');
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('звіт: без інтерв\'ю й статей у графіках їх немає', async () => {
      const p = await openPage(ctx, url, withBackupStamp(JSON.stringify({contacts:[], broadcasts:[mk('e1','ефір'), mk('p1','подія')]})));
      const xml = await reportText(p);
      assert(!xml.includes('Статті') && !/Інтерв/.test(xml), 'порожні категорії потрапили у звіт');
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('13. Огляд: кнопки типів над діаграмами та списками');
    ctx = await newContext(browser);
    const chipState = p => p.evaluate(() => Array.from(document.querySelectorAll('#overviewTypeChips .type-chip')).map(b => [b.dataset.type, b.getAttribute('aria-pressed')]));
    const clickChip = (p, type) => p.click(`#overviewTypeChips .type-chip[data-type="${type}"]`);
    const chartLabels = p => p.evaluate(() => ({m: monthlyChart.data.datasets.map(d => d.label), y: yearlyChart.data.datasets.map(d => d.label)}));
    await test('є кнопка для кожного типу, що має дані, і «Усі типи»; усе ввімкнено', async () => {
      const p = await openPage(ctx, url, typesDb());
      await p.evaluate(() => setTab('overview'));
      eq(await chipState(p), [['ефір','true'], ['інтерв\'ю','true'], ['стаття','true'], ['подія','true'], ['__all','true']]);
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('тип без жодного запису (і не «завжди») кнопки не має', async () => {
      const p = await openPage(ctx, url, JSON.stringify({contacts:[], broadcasts:[mk('e1','ефір'), mk('p1','подія')]}));
      await p.evaluate(() => setTab('overview'));
      eq((await chipState(p)).map(x => x[0]), ['ефір','подія','__all']);
      await p.close();
    });
    await test('вимкнення «Статей» прибирає їх з обох діаграм і звужує шкалу', async () => {
      const p = await openPage(ctx, url, typesDb());
      await p.evaluate(() => setTab('overview'));
      const maxBefore = await p.evaluate(() => monthlyChart.options.scales.y.max);
      await clickChip(p, 'стаття');
      eq(await chartLabels(p), {m:['Ефіри','Інтерв\'ю','Події'], y:['Ефіри','Інтерв\'ю','Події']});
      eq((await chipState(p)).find(x => x[0]==='стаття')[1], 'false');
      assert(await p.evaluate(m => monthlyChart.options.scales.y.max < m, maxBefore), 'шкала не звузилась після вимкнення статей');
      assert(!(await p.evaluate(() => document.getElementById('chartMonthlySub').textContent)).includes('татті'), 'підпис досі згадує статті');
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('останній увімкнений тип вимкнути не можна; «Усі типи» вмикає все назад', async () => {
      const p = await openPage(ctx, url, typesDb());
      await p.evaluate(() => setTab('overview'));
      for(const t of ['ефір','інтерв\'ю','стаття']) await clickChip(p, t);
      eq(await chartLabels(p), {m:['Події'], y:['Події']});
      await clickChip(p, 'подія');
      eq(await chartLabels(p), {m:['Події'], y:['Події']}, 'останній тип зник');
      await clickChip(p, '__all');
      eq((await chartLabels(p)).m, ['Ефіри','Інтерв\'ю','Статті','Події']);
      await p.close();
    });
    await test('вибір типів не скидається при зміні року', async () => {
      const p = await openPage(ctx, url, typesDb());
      await p.evaluate(() => setTab('overview'));
      await clickChip(p, 'стаття');
      await p.selectOption('#overviewYearSelect', 'all');
      eq((await chartLabels(p)).m, ['Ефіри','Інтерв\'ю','Події']);
      eq((await chipState(p)).find(x => x[0]==='стаття')[1], 'false');
      await p.close();
    });
    await test('вимкнений тип не заважає лічильникам-карткам', async () => {
      const p = await openPage(ctx, url, typesDb());
      await p.evaluate(() => setTab('overview'));
      await clickChip(p, 'стаття');
      eq(await cardValue(p, 'Статей'), '3', 'картки не залежать від кнопок типів');
      await p.close();
    });
    await test('наведення на стовпчик не показує спливної підказки (числа вже підписані на діаграмі)', async () => {
      const p = await openPage(ctx, url, typesDb());
      await p.evaluate(() => setTab('overview'));
      await p.evaluate(() => document.getElementById('chartMonthly').scrollIntoView({block:'center'}));
      await p.waitForTimeout(1200); // діаграма анімується при появі: позицію стовпчика міряємо, коли вона вляглась
      const pt = await p.evaluate(() => {
        const bar = monthlyChart.getDatasetMeta(0).data[0], r = monthlyChart.canvas.getBoundingClientRect();
        return {x: r.left + bar.x, y: r.top + (bar.y + bar.base) / 2};
      });
      await p.mouse.move(pt.x - 5, pt.y - 5);
      await p.mouse.move(pt.x, pt.y, {steps: 4});
      await p.waitForTimeout(600);
      eq(await p.evaluate(() => [monthlyChart.options.plugins.tooltip.enabled, yearlyChart.options.plugins.tooltip.enabled]), [false, false], 'підказку не вимкнено');
      eq(await p.evaluate(() => monthlyChart.tooltip ? monthlyChart.tooltip.opacity : 0), 0, 'підказка з\'явилась при наведенні');
      await p.close();
    });
    // --- кнопки типів керують і списками «Спікери / Підрозділи / Канали» ---
    const rankDb = () => JSON.stringify({
      contacts: [],
      militaryContacts: [{id:'m1', name:'Спікер Інтерв', unit:'Підрозділ І'}, {id:'m2', name:'Спікер Ефір', unit:'Підрозділ Е'}],
      broadcasts: [
        mk('e1','ефір',  '2026-03-05', {channel:'Канал Е', guest:'Спікер Ефір'}),
        mk('i1','інтерв\'ю','2026-03-06', {channel:'Канал І', guest:'Спікер Інтерв'}),
        mk('i2','інтерв\'ю','2026-04-03', {channel:'Канал І', guest:'Спікер Інтерв'}),
        mk('s1','стаття','2026-04-10', {channel:'Канал С', guest:''}),
      ]});
    const rankRows = (p, id) => p.evaluate(i => Array.from(document.querySelectorAll('#' + i + ' .rank-row')).map(r => [r.querySelector('.rank-name').textContent.trim(), +r.querySelector('.rank-val').textContent]), id);
    const rankSorted = async (p, id) => (await rankRows(p, id)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'uk'));
    const openRank = async () => { const p = await openPage(ctx, url, rankDb()); await p.evaluate(() => setTab('overview')); await p.selectOption('#overviewYearSelect', 'all'); return p; };
    await test('списки спікерів, підрозділів і каналів: з усіма типами рахують усе', async () => {
      const p = await openRank();
      eq(await rankSorted(p, 'topGuests'), [['Спікер Інтерв',2], ['Спікер Ефір',1]]);
      eq(await rankSorted(p, 'topUnits'), [['Підрозділ І',2], ['Підрозділ Е',1]]);
      eq(await rankSorted(p, 'topChannels'), [['Канал І',2], ['Канал Е',1], ['Канал С',1]]);
      eq(await p.evaluate(() => document.getElementById('topGuestsSub').textContent), 'Усі, за кількістю виступів', 'підпис без фільтра як раніше');
      await p.close();
    });
    await test('лише «Інтерв\'ю»: списки рахують тільки інтерв\'ю, підпис каже про тип', async () => {
      const p = await openRank();
      for(const t of ['ефір','стаття','подія']) await clickChip(p, t);
      eq(await rankRows(p, 'topGuests'), [['Спікер Інтерв',2]]);
      eq(await rankRows(p, 'topUnits'), [['Підрозділ І',2]]);
      eq(await rankRows(p, 'topChannels'), [['Канал І',2]]);
      eq(await p.evaluate(() => [document.getElementById('topGuestsSub').textContent, document.getElementById('topChannelsSub').textContent, document.getElementById('topUnitsSub').textContent]),
        ['Інтерв\'ю, усі роки, за кількістю виступів', 'Інтерв\'ю, усі роки, за кількістю матеріалів', 'Інтерв\'ю, усі роки, за кількістю матеріалів']);
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('два типи разом додаються у списках; «Усі типи» повертає все', async () => {
      const p = await openRank();
      for(const t of ['стаття','подія']) await clickChip(p, t);   // лишаються ефір + інтерв'ю
      eq(await rankSorted(p, 'topChannels'), [['Канал І',2], ['Канал Е',1]]);
      eq(await p.evaluate(() => document.getElementById('topGuestsSub').textContent.startsWith('Ефіри та інтерв')), true);
      await clickChip(p, '__all');
      eq(await rankSorted(p, 'topChannels'), [['Канал І',2], ['Канал Е',1], ['Канал С',1]]);
      await p.close();
    });
    await test('картки «Унікальних каналів / Підрозділів» від кнопок типів не залежать', async () => {
      const p = await openRank();
      const before = [await cardValue(p, 'Унікальних каналів'), await cardValue(p, 'Підрозділів')];
      for(const t of ['ефір','стаття','подія']) await clickChip(p, t);
      eq([await cardValue(p, 'Унікальних каналів'), await cardValue(p, 'Підрозділів')], before);
      eq(before, ['3','2']);
      await p.close();
    });
    await ctx.close();
  } finally {
    await browser.close();
    srv.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} з ${results.length} перевірок пройдено`);
  if(failed.length){ console.log('\nПровалені:'); failed.forEach(f => console.log(' -', f.name)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(2); });
